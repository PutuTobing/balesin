import type { Logger, MailBusEventInput, MailEventPublisher } from '@balesin/core';
import {
  getPgError,
  mailAccounts,
  mailFolders,
  mailMessages,
  PG_ERROR_CODES,
  type Database,
  type MailFolderRow,
  type MailMessageRow,
} from '@balesin/db';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { MailReadError, type MailReader } from './read';

/**
 * Aksi dua arah modul Email (KONTRAK-API-EMAIL §9, job `mail-action`): api sudah menerapkan
 * perubahan ke database (optimistis) + menandai `pending_action`; job ini mencerminkannya ke server
 * IMAP, BERURUTAN per akun (satu job per akun, sambungan kerja tunggal).
 *
 *  - `flags`: `UID STORE ±FLAGS.SILENT (\Seen|\Flagged)` sesuai keadaan database SEKARANG (idempoten;
 *    beberapa klik beruntun cukup satu perintah).
 *  - `move`: bendera dulu lalu `UID MOVE` / `UID COPY` + `\Deleted` + `UID EXPUNGE`; dengan `COPYUID`
 *    baris dipindah di tempat (isi cache tetap), tanpa itu baris dihapus dan sinkron folder tujuan
 *    mengambilnya lagi.
 *  - `delete`: `\Deleted` + `UID EXPUNGE` (tanpa UIDPLUS hanya ditandai).
 *  - Ditolak server pada percobaan terakhir → dikembalikan (`pending_revert`) + `mail.action.failed`.
 *    Akun dijeda/password ditolak/pemilik nonaktif → menunggu (tick mengantre lagi; > 24 jam →
 *    dikembalikan dengan kode `expired`).
 *  Pembersihan `pending_*` hanya bila `pending_action_at` belum berubah sejak dimuat (aksi baru yang
 *  masuk selama job berjalan tidak tertimpa).
 */

export interface MailActionDeps {
  db: Database;
  logger: Logger;
  publisher: MailEventPublisher;
  reader: MailReader;
  /** Antre sinkron akun (setelah pengembalian: server jadi kebenaran lagi). */
  enqueueSync?: (payload: { organizationId: string; accountId: string }) => Promise<void>;
  now?: () => Date;
}

export const MAIL_ACTION_BATCH = 500;
export const MAIL_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WAITING_STATES = new Set(['paused', 'auth_failed', 'owner_inactive']);
const ROUNDS = 3;

export type MailActionRunResult =
  { status: 'applied'; applied: number; reverted: number } | { status: 'deferred' | 'skipped' };

function actionName(row: Pick<MailMessageRow, 'pendingAction' | 'pendingTargetFolderId'>): string {
  return row.pendingAction === 'flags'
    ? 'flags'
    : row.pendingAction === 'delete'
      ? 'delete_permanently'
      : 'move';
}

/** Kembalikan baris tertunda ke keadaan sebelum aksi (bendera) dan lepaskan penandanya. */
export async function revertPendingMessages(
  db: Database,
  publisher: MailEventPublisher,
  rows: readonly Pick<
    MailMessageRow,
    | 'id'
    | 'organizationId'
    | 'accountId'
    | 'pendingAction'
    | 'pendingActionAt'
    | 'pendingRevert'
    | 'pendingTargetFolderId'
  >[],
  code: string,
): Promise<number> {
  const reverted: (typeof rows)[number][] = [];
  for (const row of rows) {
    if (!row.pendingActionAt) continue;
    const [saved] = await db
      .update(mailMessages)
      .set({
        ...(row.pendingRevert
          ? { isRead: row.pendingRevert.isRead, isStarred: row.pendingRevert.isStarred }
          : {}),
        pendingAction: null,
        pendingActionAt: null,
        pendingTargetFolderId: null,
        pendingRevert: null,
      })
      .where(
        and(
          eq(mailMessages.organizationId, row.organizationId),
          eq(mailMessages.id, row.id),
          eq(mailMessages.pendingActionAt, row.pendingActionAt),
        ),
      )
      .returning({ id: mailMessages.id });
    if (saved) reverted.push(row);
  }
  const events: MailBusEventInput[] = [];
  const groups = new Map<string, typeof reverted>();
  for (const row of reverted) {
    const key = `${row.organizationId}|${row.accountId}|${actionName(row)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
    events.push({
      organizationId: row.organizationId,
      accountId: row.accountId,
      event: {
        type: 'mail.message.updated',
        accountId: row.accountId,
        messageId: row.id,
        fields: row.pendingAction === 'flags' ? ['flags'] : ['flags', 'folder'],
      },
    });
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    for (let index = 0; index < group.length; index += 100) {
      events.push({
        organizationId: first.organizationId,
        accountId: first.accountId,
        event: {
          type: 'mail.action.failed',
          accountId: first.accountId,
          messageIds: group.slice(index, index + 100).map((row) => row.id),
          action: actionName(first),
          code,
        },
      });
    }
  }
  if (events.length > 0) await publisher.publish(events);
  return reverted.length;
}

export function createMailActions(deps: MailActionDeps) {
  const { db, logger, publisher, reader } = deps;
  const now = deps.now ?? (() => new Date());

  async function pendingRows(organizationId: string, accountId: string) {
    return db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.organizationId, organizationId),
          eq(mailMessages.accountId, accountId),
          isNotNull(mailMessages.pendingAction),
        ),
      )
      .orderBy(asc(mailMessages.pendingActionAt))
      .limit(MAIL_ACTION_BATCH);
  }

  async function clearPending(row: MailMessageRow) {
    if (!row.pendingActionAt) return;
    await db
      .update(mailMessages)
      .set({
        pendingAction: null,
        pendingActionAt: null,
        pendingTargetFolderId: null,
        pendingRevert: null,
      })
      .where(
        and(
          eq(mailMessages.organizationId, row.organizationId),
          eq(mailMessages.id, row.id),
          eq(mailMessages.pendingActionAt, row.pendingActionAt),
        ),
      );
  }

  /**
   * Satu putaran job untuk satu akun. `finalAttempt` = percobaan terakhir BullMQ: baris yang ditolak
   * server dikembalikan (bukan dilempar lagi).
   */
  async function run(
    payload: { organizationId: string; accountId: string },
    options: { finalAttempt: boolean },
  ): Promise<MailActionRunResult> {
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.organizationId, payload.organizationId),
          eq(mailAccounts.id, payload.accountId),
        ),
      )
      .limit(1);
    if (!account || account.deletedAt !== null) return { status: 'skipped' };
    if (WAITING_STATES.has(account.syncState)) return { status: 'deferred' };
    let rows = await pendingRows(account.organizationId, account.id);
    if (rows.length === 0) return { status: 'applied', applied: 0, reverted: 0 };

    let session;
    try {
      session = await reader.openSession(account);
    } catch (error) {
      const code = error instanceof MailReadError ? error.code : 'unknown';
      logger.warn({ accountId: account.id, code }, 'Aksi email belum bisa diterapkan (sambungan)');
      if (options.finalAttempt) {
        const reverted = await revertPendingMessages(db, publisher, rows, code);
        await deps.enqueueSync?.(payload).catch(() => undefined);
        return { status: 'applied', applied: 0, reverted };
      }
      throw error;
    }
    let applied = 0;
    let reverted = 0;
    const failed: { row: MailMessageRow; code: string }[] = [];
    const attempted = new Map<string, number>();
    const events: MailBusEventInput[] = [];
    try {
      for (let round = 0; round < ROUNDS && rows.length > 0; round += 1) {
        for (const row of rows) attempted.set(row.id, row.pendingActionAt?.getTime() ?? 0);
        const folderIds = [
          ...new Set(
            rows.flatMap((row) => [
              row.folderId,
              ...(row.pendingTargetFolderId ? [row.pendingTargetFolderId] : []),
            ]),
          ),
        ];
        const folders = new Map<string, MailFolderRow>(
          (
            await db
              .select()
              .from(mailFolders)
              .where(
                and(
                  eq(mailFolders.organizationId, account.organizationId),
                  inArray(mailFolders.id, folderIds),
                ),
              )
          ).map((folder) => [folder.id, folder]),
        );
        const bySource = new Map<string, MailMessageRow[]>();
        for (const row of rows)
          bySource.set(row.folderId, [...(bySource.get(row.folderId) ?? []), row]);

        for (const [folderId, group] of bySource) {
          const folder = folders.get(folderId);
          if (!folder) {
            for (const row of group) failed.push({ row, code: 'folder_missing' });
            continue;
          }
          const selected = await session.openWritable(folder.path);
          const live = group.filter((row) => {
            if (row.uidvalidity === selected.uidValidity) return true;
            failed.push({ row, code: 'uidvalidity_changed' });
            return false;
          });
          // 1. Bendera sesuai database (untuk semua jenis aksi tertunda).
          const flagGroups = {
            seenAdd: [] as number[],
            seenRemove: [] as number[],
            starAdd: [] as number[],
            starRemove: [] as number[],
          };
          for (const row of live) {
            const before = row.pendingRevert;
            if (!before || before.isRead !== row.isRead)
              (row.isRead ? flagGroups.seenAdd : flagGroups.seenRemove).push(row.uid);
            if (!before || before.isStarred !== row.isStarred)
              (row.isStarred ? flagGroups.starAdd : flagGroups.starRemove).push(row.uid);
          }
          const flagOk =
            (await session.storeFlags(flagGroups.seenAdd, ['\\Seen'], [])) &&
            (await session.storeFlags(flagGroups.seenRemove, [], ['\\Seen'])) &&
            (await session.storeFlags(flagGroups.starAdd, ['\\Flagged'], [])) &&
            (await session.storeFlags(flagGroups.starRemove, [], ['\\Flagged']));
          if (!flagOk) {
            for (const row of live) failed.push({ row, code: 'server_rejected' });
            continue;
          }
          for (const row of live.filter((item) => item.pendingAction === 'flags')) {
            await clearPending(row);
            applied += 1;
          }

          // 2. Hapus permanen.
          const deletions = live.filter((row) => row.pendingAction === 'delete');
          if (deletions.length > 0) {
            if (await session.expunge(deletions.map((row) => row.uid))) {
              await db.delete(mailMessages).where(
                and(
                  eq(mailMessages.organizationId, account.organizationId),
                  inArray(
                    mailMessages.id,
                    deletions.map((row) => row.id),
                  ),
                ),
              );
              applied += deletions.length;
              for (const row of deletions) {
                events.push({
                  organizationId: account.organizationId,
                  accountId: account.id,
                  event: {
                    type: 'mail.message.deleted',
                    accountId: account.id,
                    folderId: folder.id,
                    messageId: row.id,
                  },
                });
              }
            } else {
              for (const row of deletions) failed.push({ row, code: 'server_rejected' });
            }
          }

          // 3. Pindah (per folder tujuan).
          const byTarget = new Map<string, MailMessageRow[]>();
          for (const row of live) {
            if (row.pendingAction !== 'move' || !row.pendingTargetFolderId) continue;
            byTarget.set(row.pendingTargetFolderId, [
              ...(byTarget.get(row.pendingTargetFolderId) ?? []),
              row,
            ]);
          }
          for (const [targetId, moving] of byTarget) {
            const target = folders.get(targetId);
            if (!target || target.accountId !== account.id) {
              for (const row of moving) failed.push({ row, code: 'folder_missing' });
              continue;
            }
            // Folder Arsip/Sampah yang dibuat aplikasi (belum ada di server) → CREATE dulu.
            if (target.roleSource === 'created' && target.uidvalidity === null) {
              await session.createFolder(target.path);
            }
            const result = await session.move(
              moving.map((row) => row.uid),
              target.path,
            );
            if (!result) {
              for (const row of moving) failed.push({ row, code: 'server_rejected' });
              continue;
            }
            const targetValidity = result.uidValidity ?? target.uidvalidity;
            for (const row of moving) {
              const newUid = result.uidMap.get(row.uid);
              let movedInPlace = false;
              if (newUid && targetValidity) {
                try {
                  const [saved] = await db
                    .update(mailMessages)
                    .set({
                      folderId: target.id,
                      folderRole: target.role,
                      uid: newUid,
                      uidvalidity: targetValidity,
                      pendingAction: null,
                      pendingActionAt: null,
                      pendingTargetFolderId: null,
                      pendingRevert: null,
                    })
                    .where(
                      and(
                        eq(mailMessages.organizationId, account.organizationId),
                        eq(mailMessages.id, row.id),
                      ),
                    )
                    .returning({ id: mailMessages.id });
                  movedInPlace = saved !== undefined;
                } catch (error) {
                  // Sinkron folder tujuan sudah memuat salinannya → baris lama dihapus saja.
                  if (getPgError(error)?.code !== PG_ERROR_CODES.uniqueViolation) throw error;
                }
              }
              if (!movedInPlace) {
                await db
                  .delete(mailMessages)
                  .where(
                    and(
                      eq(mailMessages.organizationId, account.organizationId),
                      eq(mailMessages.id, row.id),
                    ),
                  );
              }
              applied += 1;
              events.push(
                {
                  organizationId: account.organizationId,
                  accountId: account.id,
                  event: {
                    type: 'mail.message.deleted',
                    accountId: account.id,
                    folderId: folder.id,
                    messageId: row.id,
                  },
                },
                ...(movedInPlace
                  ? [
                      {
                        organizationId: account.organizationId,
                        accountId: account.id,
                        event: {
                          type: 'mail.message.created' as const,
                          accountId: account.id,
                          folderId: target.id,
                          messageId: row.id,
                          receivedAt: row.receivedAt.toISOString(),
                        },
                      },
                    ]
                  : []),
              );
            }
          }
        }
        // Aksi baru yang masuk selama putaran ini (waktu tertunda berubah / baris baru).
        const next = await pendingRows(account.organizationId, account.id);
        const failedIds = new Set(failed.map((item) => item.row.id));
        rows = next.filter(
          (row) =>
            !failedIds.has(row.id) &&
            attempted.get(row.id) !== (row.pendingActionAt?.getTime() ?? 0),
        );
      }
    } catch (error) {
      if (events.length > 0) await publisher.publish(events);
      if (options.finalAttempt) {
        const remaining = await pendingRows(account.organizationId, account.id);
        reverted += await revertPendingMessages(db, publisher, remaining, 'connection_lost');
        await deps.enqueueSync?.(payload).catch(() => undefined);
        return { status: 'applied', applied, reverted };
      }
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
    if (events.length > 0) await publisher.publish(events);
    if (failed.length > 0) {
      if (!options.finalAttempt) {
        logger.warn(
          { accountId: account.id, failed: failed.length },
          'Sebagian aksi email ditolak server; dicoba lagi',
        );
        throw new Error('Sebagian aksi email ditolak server');
      }
      const byCode = new Map<string, MailMessageRow[]>();
      for (const item of failed)
        byCode.set(item.code, [...(byCode.get(item.code) ?? []), item.row]);
      for (const [code, list] of byCode)
        reverted += await revertPendingMessages(db, publisher, list, code);
      await deps.enqueueSync?.(payload).catch(() => undefined);
    }
    logger.info({ accountId: account.id, applied, reverted }, 'Aksi email diterapkan ke server');
    return { status: 'applied', applied, reverted };
  }

  /**
   * Tick: aksi tertunda > 24 jam dikembalikan (`expired`); akun siap yang masih punya aksi
   * tertunda (antrean langsung terlewat) → ID akun untuk diantre lagi.
   */
  async function sweep(): Promise<{
    expired: number;
    accounts: { organizationId: string; accountId: string }[];
  }> {
    const at = now();
    const stale = await db
      .select()
      .from(mailMessages)
      .where(
        and(
          isNotNull(mailMessages.pendingAction),
          lt(mailMessages.pendingActionAt, new Date(at.getTime() - MAIL_PENDING_MAX_AGE_MS)),
        ),
      )
      .limit(MAIL_ACTION_BATCH);
    const expired =
      stale.length > 0 ? await revertPendingMessages(db, publisher, stale, 'expired') : 0;
    const waiting = await db.execute<{ organization_id: string; account_id: string }>(sql`
      select distinct m.organization_id, m.account_id
      from mail_messages m
      join mail_accounts a on a.organization_id = m.organization_id and a.id = m.account_id
      where m.pending_action is not null and m.pending_action_at < ${new Date(at.getTime() - 15_000)}
        and a.deleted_at is null and a.sync_state not in ('paused', 'auth_failed', 'owner_inactive', 'deleting')
      limit 50`);
    return {
      expired,
      accounts: waiting.rows.map((row) => ({
        organizationId: row.organization_id,
        accountId: row.account_id,
      })),
    };
  }

  return { run, sweep };
}

export type MailActions = ReturnType<typeof createMailActions>;
