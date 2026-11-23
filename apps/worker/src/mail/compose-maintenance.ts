import type {
  Logger,
  MailBusEventInput,
  MailEventPublisher,
  MediaStore,
  Redis,
} from '@balesin/core';
import {
  mailAccessUsersOf,
  mailAccounts,
  mailDraftAttachments,
  mailDrafts,
  mailOutbox,
  users,
  type Database,
} from '@balesin/db';
import { MAIL_CORRESPONDENTS_PER_ACCOUNT_MAX } from '@balesin/shared';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

/**
 * Pemeliharaan tahap 9B (KONTRAK-API-EMAIL-TULIS §13):
 *  - presence "sedang membalas" (Redis hash `mail:presence:<akun>:<threadKey>`, TTL 45 dtk per
 *    pengguna): anggota kedaluwarsa dibuang → `mail.compose.presence` (tick 15 dtk);
 *  - retensi outbox: isi 30 hari setelah final, `.eml` 7 hari, baris 180 hari;
 *  - `mail_correspondents` > 20.000 per akun dipangkas (yang `last_seen_at` tertua);
 *  - isi `thread_root` email lama (per 5.000 baris);
 *  - draf `pending` yang job salinannya hilang → diantre lagi.
 */

const DAY = 24 * 60 * 60 * 1000;
const BODY_RETENTION_MS = 30 * DAY;
const RAW_RETENTION_MS = 7 * DAY;
const ROW_RETENTION_MS = 180 * DAY;
const BATCH = 500;

export interface ComposeMaintenanceDeps {
  db: Database;
  redis: Redis;
  prefix: string;
  logger: Logger;
  publisher: MailEventPublisher;
  store: MediaStore | null;
  enqueueDraftSync?: (
    payload: { organizationId: string; accountId: string; draftId: string },
    delayMs: number,
  ) => Promise<void>;
  now?: () => Date;
}

export function createComposeMaintenance(deps: ComposeMaintenanceDeps) {
  const { db, redis } = deps;
  const now = deps.now ?? (() => new Date());

  async function presenceTick(): Promise<{ changed: number }> {
    const at = now().getTime();
    const pattern = `${deps.prefix}:mail:presence:*`;
    let cursor = '0';
    let changed = 0;
    const events: MailBusEventInput[] = [];
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const [accountId, threadKey] = key.slice(`${deps.prefix}:mail:presence:`.length).split(':');
        if (!accountId || !threadKey) continue;
        const members = await redis.hgetall(key);
        const expired = Object.entries(members)
          .filter(([, expiry]) => Number(expiry) <= at)
          .map(([userId]) => userId);
        if (expired.length === 0) continue;
        await redis.hdel(key, ...expired);
        const [account] = await db
          .select({ organizationId: mailAccounts.organizationId })
          .from(mailAccounts)
          .where(eq(mailAccounts.id, accountId))
          .limit(1);
        if (!account) {
          await redis.del(key);
          continue;
        }
        const remaining = Object.entries(members)
          .filter(([, expiry]) => Number(expiry) > at)
          .map(([userId]) => userId)
          .slice(0, 20);
        const subjects = remaining.length
          ? await mailAccessUsersOf(db, account.organizationId, remaining)
          : new Map<string, { active: boolean }>();
        const names = remaining.length
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(
                and(eq(users.organizationId, account.organizationId), inArray(users.id, remaining)),
              )
          : [];
        events.push({
          organizationId: account.organizationId,
          accountId,
          event: {
            type: 'mail.compose.presence',
            accountId,
            threadKey,
            users: names
              .filter((user) => subjects.get(user.id)?.active === true)
              .map((user) => ({ id: user.id, name: user.name.slice(0, 100) })),
          },
        });
        changed += 1;
      }
    } while (cursor !== '0');
    await deps.publisher.publish(events);
    return { changed };
  }

  async function maintenance(): Promise<Record<string, number>> {
    const at = now();
    const result = { bodies: 0, raws: 0, rows: 0, correspondents: 0, threadRoots: 0, drafts: 0 };
    // Isi outbox final > 30 hari.
    const bodies = await db
      .update(mailOutbox)
      .set({ html: null, text: null, bodyPurgedAt: at })
      .where(
        sql`${mailOutbox.id} in (select id from mail_outbox where status in ('sent', 'failed', 'canceled') and body_purged_at is null and coalesce(sent_at, failed_at, canceled_at) < ${new Date(at.getTime() - BODY_RETENTION_MS)} limit ${BATCH})`,
      )
      .returning({ id: mailOutbox.id });
    result.bodies = bodies.length;
    // `.eml` > 7 hari (salinan Terkirim yang tak kunjung selesai).
    const raws = await db
      .select({ id: mailOutbox.id, key: mailOutbox.rawStorageKey })
      .from(mailOutbox)
      .where(
        and(
          isNotNull(mailOutbox.rawStorageKey),
          lte(mailOutbox.sentAt, new Date(at.getTime() - RAW_RETENTION_MS)),
        ),
      )
      .limit(BATCH);
    for (const raw of raws) {
      if (raw.key) await deps.store?.remove(raw.key).catch(() => undefined);
      await db
        .update(mailOutbox)
        .set({
          rawStorageKey: null,
          sentCopyState: sql`case when ${mailOutbox.sentCopyState} = 'pending' then 'failed' else ${mailOutbox.sentCopyState} end`,
        })
        .where(eq(mailOutbox.id, raw.id));
    }
    result.raws = raws.length;
    // Baris > 180 hari.
    const rows = await db
      .delete(mailOutbox)
      .where(
        sql`${mailOutbox.id} in (select id from mail_outbox where status in ('sent', 'failed', 'canceled') and created_at < ${new Date(at.getTime() - ROW_RETENTION_MS)} limit ${BATCH})`,
      )
      .returning({ id: mailOutbox.id });
    result.rows = rows.length;
    // Korespondensi > 20.000 per akun.
    const trimmed = await db.execute(sql`
      delete from mail_correspondents c using (
        select id from (
          select id, row_number() over (partition by account_id order by last_seen_at desc) as rank
          from mail_correspondents
        ) ranked where ranked.rank > ${MAIL_CORRESPONDENTS_PER_ACCOUNT_MAX} limit 5000
      ) old where c.id = old.id`);
    result.correspondents = trimmed.rowCount ?? 0;
    // `thread_root` email lama (sebelum 9B).
    const roots = await db.execute(sql`
      update mail_messages m set thread_root = left(coalesce(m.references[1], m.in_reply_to, m.message_id_header, 'id:' || m.id::text), 998)
      where m.id in (select id from mail_messages where thread_root is null limit 5000)`);
    result.threadRoots = roots.rowCount ?? 0;
    // Draf `pending` yang job salinannya hilang (diam > 2 menit).
    const stale = await db
      .select({
        id: mailDrafts.id,
        organizationId: mailDrafts.organizationId,
        accountId: mailDrafts.accountId,
      })
      .from(mailDrafts)
      .where(
        and(
          eq(mailDrafts.serverSyncState, 'pending'),
          eq(mailDrafts.state, 'editing'),
          lte(mailDrafts.updatedAt, new Date(at.getTime() - 2 * 60_000)),
        ),
      )
      .limit(BATCH);
    for (const draft of stale) {
      await deps
        .enqueueDraftSync?.(
          { organizationId: draft.organizationId, accountId: draft.accountId, draftId: draft.id },
          0,
        )
        .catch(() => undefined);
    }
    result.drafts = stale.length;
    return result;
  }

  /** Putuskan akun: berkas draf & `.eml` outbox (baris ikut terhapus kaskade). */
  async function purgeAccountFiles(organizationId: string, accountId: string): Promise<number> {
    const files = await db
      .select({ key: mailDraftAttachments.storageKey })
      .from(mailDraftAttachments)
      .innerJoin(mailDrafts, eq(mailDrafts.id, mailDraftAttachments.draftId))
      .where(
        and(eq(mailDrafts.organizationId, organizationId), eq(mailDrafts.accountId, accountId)),
      );
    const raws = await db
      .select({ key: mailOutbox.rawStorageKey })
      .from(mailOutbox)
      .where(
        and(eq(mailOutbox.organizationId, organizationId), eq(mailOutbox.accountId, accountId)),
      );
    let removed = 0;
    for (const file of [...files, ...raws]) {
      if (!file.key) continue;
      await deps.store?.remove(file.key).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  return { presenceTick, maintenance, purgeAccountFiles };
}

export type ComposeMaintenance = ReturnType<typeof createComposeMaintenance>;
