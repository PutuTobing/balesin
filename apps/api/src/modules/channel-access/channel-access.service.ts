import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  channelAccessDepartments,
  channelAccessUsers,
  channels,
  departments,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  CHANNEL_ACCESS_EXEMPT_ROLES,
  channelAccessLoosens,
  type ChannelAccess,
  type ChannelAccessMode,
  type UpdateChannelAccessRequest,
  type UpdateChannelAccessResponse,
} from '@balesin/shared';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { NotificationEnqueuer } from '../../queues/notification-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { publishReleased, releaseInaccessibleAssignments } from './release';

/**
 * Akses per channel (tahap 9.0, docs/KONTRAK-API-CHANNEL.md "Akses per channel"). Pengelola =
 * `channels.manage` (Owner/Admin). Penegakannya ada di `scopeCondition` (kolom `channel`) +
 * `channelAccessSql`/`channelAccessOf` (packages/db) — modul ini hanya menyimpan aturannya.
 *
 * Simpan = satu transaksi: pelaku diperiksa ulang, baris channel dikunci, departemen/pengguna
 * divalidasi milik organisasi (pengguna: aktif), daftar diganti, audit berisi perubahan (ID + nama
 * departemen/pengguna yang ditambah/dicabut). Setelah commit: `access.changed` ke semua pengguna
 * yang bisa terdampak (Supervisor/CS/Teknisi aktif) → socket inbox mereka memuat ulang.
 *
 * Review 9.0: melonggarkan (`channelAccessLoosens`) wajib konfirmasi identitas (R3) — diperiksa
 * sebelum transaksi atas keadaan terbaca, lalu diulang atas baris terkunci (berubah di antaranya →
 * 409); percakapan `served` yang pemegangnya kini tanpa akses dikembalikan ke antrian (R4).
 */

export const CHANNEL_NOT_FOUND = 'Channel tidak ditemukan.';
/** Entri ditambah/dicabut per jenis yang dicatat namanya di audit (sisanya cukup jumlah). */
const AUDIT_LIST_MAX = 50;
const UUID = z.uuid();

export type ChannelAccessContext = TwoFactorContext;

export interface ChannelAccessService {
  get(organizationId: string, channelId: string): Promise<ChannelAccess>;
  update(
    auth: AuthContext,
    channelId: string,
    input: UpdateChannelAccessRequest,
    context: ChannelAccessContext,
  ): Promise<UpdateChannelAccessResponse>;
}

const notFound = () => new AppError('NOT_FOUND', { message: CHANNEL_NOT_FOUND });

interface Named {
  id: string;
  name: string;
}

function diff(before: readonly Named[], after: readonly Named[]) {
  const beforeIds = new Set(before.map((row) => row.id));
  const afterIds = new Set(after.map((row) => row.id));
  return {
    added: after.filter((row) => !beforeIds.has(row.id)),
    removed: before.filter((row) => !afterIds.has(row.id)),
  };
}

const auditList = (rows: readonly Named[]) =>
  rows.slice(0, AUDIT_LIST_MAX).map((row) => ({ id: row.id, name: row.name }));

const idsOf = (access: ChannelAccess) => ({
  mode: access.mode,
  departmentIds: access.departments.map((row) => row.id),
  userIds: access.users.map((row) => row.id),
});

export function createChannelAccessService(deps: {
  db: Database;
  publisher: Pick<InboxEventPublisher, 'publish'>;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifications?: NotificationEnqueuer;
}): ChannelAccessService {
  const { db, publisher, twoFactor } = deps;

  async function liveChannel(
    executor: DbExecutor,
    organizationId: string,
    channelId: string,
    forUpdate = false,
  ) {
    if (!UUID.safeParse(channelId).success) throw notFound();
    const query = executor
      .select({ id: channels.id, name: channels.name, restricted: channels.accessRestricted })
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  async function read(
    executor: DbExecutor,
    organizationId: string,
    channel: { id: string; restricted: boolean },
  ): Promise<ChannelAccess> {
    const departmentRows = await executor
      .select({
        id: departments.id,
        name: departments.name,
        memberCount: sql<number>`(select count(*)::int from department_members dm join users u on u.organization_id = dm.organization_id and u.id = dm.user_id where dm.organization_id = ${organizationId} and dm.department_id = ${departments.id} and u.disabled_at is null)`,
      })
      .from(channelAccessDepartments)
      .innerJoin(
        departments,
        and(
          eq(departments.organizationId, channelAccessDepartments.organizationId),
          eq(departments.id, channelAccessDepartments.departmentId),
        ),
      )
      .where(
        and(
          eq(channelAccessDepartments.organizationId, organizationId),
          eq(channelAccessDepartments.channelId, channel.id),
        ),
      )
      .orderBy(asc(sql`lower(${departments.name})`), asc(departments.id));
    const userRows = await executor
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        active: sql<boolean>`${users.disabledAt} is null`,
      })
      .from(channelAccessUsers)
      .innerJoin(
        users,
        and(
          eq(users.organizationId, channelAccessUsers.organizationId),
          eq(users.id, channelAccessUsers.userId),
        ),
      )
      .where(
        and(
          eq(channelAccessUsers.organizationId, organizationId),
          eq(channelAccessUsers.channelId, channel.id),
        ),
      )
      .orderBy(asc(sql`lower(${users.name})`), asc(users.id));
    return {
      channelId: channel.id,
      mode: channel.restricted ? 'restricted' : 'all',
      departments: departmentRows.map((row) => ({ ...row, memberCount: Number(row.memberCount) })),
      users: userRows.map((row) => ({ ...row, active: Boolean(row.active) })),
      exemptRoles: [...CHANNEL_ACCESS_EXEMPT_ROLES],
    };
  }

  return {
    async get(organizationId, channelId) {
      const channel = await liveChannel(db, organizationId, channelId);
      return read(db, organizationId, channel);
    },

    async update(auth, channelId, input, context) {
      const org = auth.organizationId;
      const requested = {
        mode: input.mode,
        departmentIds: input.mode === 'restricted' ? input.departmentIds : [],
        userIds: input.mode === 'restricted' ? input.userIds : [],
      };
      const current = await read(db, org, await liveChannel(db, org, channelId));
      const confirmed = channelAccessLoosens(idsOf(current), requested);
      if (confirmed) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'channel.access',
          context,
          'Masukkan password (dan kode verifikasi) untuk memperluas akses channel ini.',
        );
      }
      const outcome = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const channel = await liveChannel(tx, org, channelId, true);
        const before = await read(tx, org, channel);
        if (!confirmed && channelAccessLoosens(idsOf(before), requested)) {
          throw new AppError('CONFLICT', {
            message: 'Akses channel ini baru saja diubah. Muat ulang halaman, lalu coba lagi.',
          });
        }
        const mode: ChannelAccessMode = input.mode;
        // Mode "Semua tim" tidak menyimpan daftar (skema sudah menolak daftar tidak kosong).
        const departmentIds = mode === 'restricted' ? input.departmentIds : [];
        const userIds = mode === 'restricted' ? input.userIds : [];

        if (departmentIds.length > 0) {
          const found = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(
              and(eq(departments.organizationId, org), inArray(departments.id, departmentIds)),
            );
          if (found.length !== departmentIds.length) {
            throw new AppError('VALIDATION_ERROR', {
              message: 'Ada departemen yang tidak ditemukan.',
              details: [
                {
                  location: 'body',
                  field: 'departmentIds',
                  message: 'Departemen tidak ditemukan.',
                },
              ],
            });
          }
        }
        if (userIds.length > 0) {
          const found = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.organizationId, org),
                inArray(users.id, userIds),
                isNull(users.disabledAt),
              ),
            );
          if (found.length !== userIds.length) {
            throw new AppError('VALIDATION_ERROR', {
              message: 'Ada pengguna yang tidak ditemukan atau sudah dinonaktifkan.',
              details: [
                {
                  location: 'body',
                  field: 'userIds',
                  message: 'Pengguna tidak ditemukan atau nonaktif.',
                },
              ],
            });
          }
        }

        await tx
          .delete(channelAccessDepartments)
          .where(
            and(
              eq(channelAccessDepartments.organizationId, org),
              eq(channelAccessDepartments.channelId, channel.id),
              departmentIds.length === 0
                ? undefined
                : notInArray(channelAccessDepartments.departmentId, departmentIds),
            ),
          );
        if (departmentIds.length > 0) {
          await tx
            .insert(channelAccessDepartments)
            .values(
              departmentIds.map((departmentId) => ({
                organizationId: org,
                channelId: channel.id,
                departmentId,
              })),
            )
            .onConflictDoNothing();
        }
        await tx
          .delete(channelAccessUsers)
          .where(
            and(
              eq(channelAccessUsers.organizationId, org),
              eq(channelAccessUsers.channelId, channel.id),
              userIds.length === 0 ? undefined : notInArray(channelAccessUsers.userId, userIds),
            ),
          );
        if (userIds.length > 0) {
          await tx
            .insert(channelAccessUsers)
            .values(
              userIds.map((userId) => ({ organizationId: org, channelId: channel.id, userId })),
            )
            .onConflictDoNothing();
        }
        if (channel.restricted !== (mode === 'restricted')) {
          await tx
            .update(channels)
            .set({ accessRestricted: mode === 'restricted', updatedByUserId: auth.user.id })
            .where(and(eq(channels.organizationId, org), eq(channels.id, channel.id)));
        }

        const after = await read(tx, org, { id: channel.id, restricted: mode === 'restricted' });
        const departmentChanges = diff(before.departments, after.departments);
        const userChanges = diff(before.users, after.users);
        const changed =
          before.mode !== after.mode ||
          departmentChanges.added.length > 0 ||
          departmentChanges.removed.length > 0 ||
          userChanges.added.length > 0 ||
          userChanges.removed.length > 0;
        if (!changed) return { access: after, affected: [] as string[], released: [] };
        // Review 9.0 R4: pemegang yang kini tanpa akses → percakapannya kembali ke antrian.
        const released = await releaseInaccessibleAssignments(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          channelId: channel.id,
        });

        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelAccessUpdated,
          targetType: 'channel',
          targetId: channel.id,
          metadata: {
            name: channel.name,
            previousMode: before.mode,
            mode: after.mode,
            addedDepartments: auditList(departmentChanges.added),
            removedDepartments: auditList(departmentChanges.removed),
            addedUsers: auditList(userChanges.added),
            removedUsers: auditList(userChanges.removed),
            departments: after.departments.length,
            users: after.users.length,
            loosened: confirmed,
            releasedConversations: released.length,
            actorRole: role,
          },
          client: context.client,
        });
        // Semua pengguna yang aksesnya bisa berubah: Supervisor/CS/Teknisi aktif (anggota
        // departemen ikut berubah lewat departemennya, jadi tidak cukup daftar langsung saja).
        const affected = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.organizationId, org),
              isNull(users.disabledAt),
              notInArray(users.role, [...CHANNEL_ACCESS_EXEMPT_ROLES]),
            ),
          );
        return { access: after, affected: affected.map((row) => row.id), released };
      });
      await publishReleased(
        { publisher, ...(deps.notifications ? { notifications: deps.notifications } : {}) },
        org,
        auth.user.id,
        outcome.released,
      );
      if (outcome.affected.length > 0) {
        await publisher.publish(
          outcome.affected.map((userId) => ({
            type: 'access.changed' as const,
            organizationId: org,
            userId,
          })),
        );
      }
      return { access: outcome.access, releasedConversations: outcome.released.length };
    },
  };
}
