import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  PG_ERROR_CODES,
  channelAccessDepartments,
  channels,
  conversationEvents,
  conversations,
  departmentMembers,
  departments,
  isPgError,
  ticketBoards,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  DEPARTMENTS_PER_ORGANIZATION_MAX,
  DEPARTMENT_RESTRICTABLE_ROLES,
  permissionScope,
  type CreateDepartmentRequest,
  type DepartmentAccess,
  type DepartmentDetail,
  type DepartmentSummary,
  type IdentityConfirmation,
  type UpdateDepartmentRequest,
} from '@balesin/shared';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { conversationScope } from '../inbox/inbox.repo';
import { publishReleased, releaseInaccessibleAssignments } from '../channel-access/release';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';

/**
 * Departemen (Fase 5, docs/KONTRAK-API-CRM-TIKET.md "Departemen"). Kelola =
 * `settings.workspace.manage` (diaudit); pindah percakapan = `inbox.assign` (cakupan pelaku).
 * MELONGGARKAN akses departemen seseorang (cabut tanda, atau menambah departemen pada pengguna
 * bertanda) = konfirmasi identitas — setara memberi akses data pelanggan lebih luas.
 */

export const DEPARTMENT_NOT_FOUND = 'Departemen tidak ditemukan.';
const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';

export function createDepartmentsService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
}) {
  const { db, publisher, twoFactor } = deps;

  async function details(
    executor: DbExecutor,
    organizationId: string,
    departmentId?: string,
  ): Promise<DepartmentDetail[]> {
    const rows = await executor
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.organizationId, organizationId),
          departmentId === undefined ? undefined : eq(departments.id, departmentId),
        ),
      )
      .orderBy(asc(sql`lower(${departments.name})`));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const members = await executor
      .select({
        departmentId: departmentMembers.departmentId,
        id: users.id,
        name: users.name,
        role: users.role,
        restricted: users.departmentRestricted,
      })
      .from(departmentMembers)
      .innerJoin(
        users,
        and(
          eq(users.organizationId, departmentMembers.organizationId),
          eq(users.id, departmentMembers.userId),
        ),
      )
      .where(
        and(
          eq(departmentMembers.organizationId, organizationId),
          inArray(departmentMembers.departmentId, ids),
          isNull(users.disabledAt),
        ),
      )
      .orderBy(asc(users.name));
    const routed = await executor
      .select({ id: channels.id, departmentId: channels.defaultDepartmentId })
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          inArray(channels.defaultDepartmentId, ids),
          isNull(channels.deletedAt),
        ),
      );
    return rows.map((row) => {
      const own = members.filter((member) => member.departmentId === row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        memberCount: own.length,
        members: own.map(({ id, name, role, restricted }) => ({ id, name, role, restricted })),
        defaultChannelIds: routed
          .filter((channel) => channel.departmentId === row.id)
          .map((channel) => channel.id),
        teamHours: row.teamHours ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async function setDefaultChannels(
    tx: DbExecutor,
    organizationId: string,
    departmentId: string,
    channelIds: readonly string[],
  ) {
    if (channelIds.length > 0) {
      const found = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.organizationId, organizationId),
            inArray(channels.id, [...channelIds]),
            isNull(channels.deletedAt),
          ),
        );
      if (found.length !== new Set(channelIds).size) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Ada channel yang tidak ditemukan.',
          details: [
            { location: 'body', field: 'defaultChannelIds', message: 'Channel tidak ditemukan.' },
          ],
        });
      }
    }
    await tx
      .update(channels)
      .set({ defaultDepartmentId: null })
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.defaultDepartmentId, departmentId),
          channelIds.length === 0 ? undefined : notInArray(channels.id, [...channelIds]),
        ),
      );
    if (channelIds.length > 0) {
      await tx
        .update(channels)
        .set({ defaultDepartmentId: departmentId })
        .where(
          and(eq(channels.organizationId, organizationId), inArray(channels.id, [...channelIds])),
        );
    }
  }

  async function accessOf(organizationId: string, userId: string): Promise<DepartmentAccess> {
    const [user] = await db
      .select({ id: users.id, restricted: users.departmentRestricted })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
    if (!user) throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
    const rows = await db
      .select({ departmentId: departmentMembers.departmentId })
      .from(departmentMembers)
      .where(
        and(
          eq(departmentMembers.organizationId, organizationId),
          eq(departmentMembers.userId, userId),
        ),
      );
    return {
      userId,
      restricted: user.restricted,
      departmentIds: rows.map((row) => row.departmentId),
    };
  }

  const duplicateName = () =>
    new AppError('CONFLICT', {
      message: 'Nama departemen sudah dipakai.',
      details: [{ location: 'body', field: 'name', message: 'Nama departemen sudah dipakai.' }],
    });

  return {
    async summaries(organizationId: string): Promise<DepartmentSummary[]> {
      const rows = await db
        .select({
          id: departments.id,
          name: departments.name,
          description: departments.description,
          // SQL literal: Drizzle tidak mengualifikasi kolom di daftar select satu tabel.
          memberCount: sql<number>`(select count(*)::int from department_members dm join users u on u.organization_id = dm.organization_id and u.id = dm.user_id where dm.department_id = departments.id and u.disabled_at is null)`,
        })
        .from(departments)
        .where(eq(departments.organizationId, organizationId))
        .orderBy(asc(sql`lower(${departments.name})`));
      return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
    },

    details: (organizationId: string) => details(db, organizationId),

    async create(
      auth: AuthContext,
      input: CreateDepartmentRequest,
      client: TwoFactorContext['client'],
    ) {
      try {
        return await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
          const org = auth.organizationId;
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(departments)
            .where(eq(departments.organizationId, org));
          if (Number(count?.total ?? 0) >= DEPARTMENTS_PER_ORGANIZATION_MAX) {
            throw new AppError('CONFLICT', {
              message: `Sudah ada ${String(DEPARTMENTS_PER_ORGANIZATION_MAX)} departemen (batas).`,
            });
          }
          const [row] = await tx
            .insert(departments)
            .values({
              organizationId: org,
              name: input.name,
              description: input.description ?? null,
              teamHours: input.teamHours ?? null,
            })
            .returning();
          if (!row) throw new Error('Departemen tidak tersimpan');
          await setDefaultChannels(tx, org, row.id, input.defaultChannelIds ?? []);
          await recordAudit(tx, {
            organizationId: org,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.departmentCreated,
            targetType: 'department',
            targetId: row.id,
            metadata: { name: row.name, defaultChannels: (input.defaultChannelIds ?? []).length },
            client,
          });
          const [detail] = await details(tx, org, row.id);
          if (!detail) throw new Error('Departemen tidak terbaca');
          return detail;
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR_CODES.uniqueViolation)) throw duplicateName();
        throw error;
      }
    },

    async update(
      auth: AuthContext,
      departmentId: string,
      input: UpdateDepartmentRequest,
      client: TwoFactorContext['client'],
    ) {
      try {
        return await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
          const org = auth.organizationId;
          const [current] = await tx
            .select()
            .from(departments)
            .where(and(eq(departments.organizationId, org), eq(departments.id, departmentId)))
            .for('update');
          if (!current) throw new AppError('NOT_FOUND', { message: DEPARTMENT_NOT_FOUND });
          const changed: string[] = [];
          const patch: Partial<typeof departments.$inferInsert> = {};
          if (input.name !== undefined && input.name !== current.name) {
            patch.name = input.name;
            changed.push('name');
          }
          if (input.description !== undefined && input.description !== current.description) {
            patch.description = input.description;
            changed.push('description');
          }
          if (
            input.teamHours !== undefined &&
            JSON.stringify(input.teamHours) !== JSON.stringify(current.teamHours)
          ) {
            patch.teamHours = input.teamHours;
            changed.push('teamHours');
          }
          if (Object.keys(patch).length > 0) {
            await tx
              .update(departments)
              .set(patch)
              .where(and(eq(departments.organizationId, org), eq(departments.id, departmentId)));
          }
          if (input.defaultChannelIds !== undefined) {
            await setDefaultChannels(tx, org, departmentId, input.defaultChannelIds);
            changed.push('defaultChannelIds');
          }
          if (changed.length > 0) {
            await recordAudit(tx, {
              organizationId: org,
              actorUserId: auth.user.id,
              action: AUDIT_ACTIONS.departmentUpdated,
              targetType: 'department',
              targetId: departmentId,
              metadata: { changedFields: changed },
              client,
            });
          }
          const [detail] = await details(tx, org, departmentId);
          if (!detail) throw new AppError('NOT_FOUND', { message: DEPARTMENT_NOT_FOUND });
          return detail;
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR_CODES.uniqueViolation)) throw duplicateName();
        throw error;
      }
    },

    /** Hapus: percakapan/board/channel dilepas dari departemen ini, keanggotaan ikut terhapus. */
    async remove(auth: AuthContext, departmentId: string, client: TwoFactorContext['client']) {
      const members = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const org = auth.organizationId;
        const [current] = await tx
          .select()
          .from(departments)
          .where(and(eq(departments.organizationId, org), eq(departments.id, departmentId)))
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: DEPARTMENT_NOT_FOUND });
        const memberIds = (
          await tx
            .select({ userId: departmentMembers.userId })
            .from(departmentMembers)
            .where(
              and(
                eq(departmentMembers.organizationId, org),
                eq(departmentMembers.departmentId, departmentId),
              ),
            )
        ).map((row) => row.userId);
        const released = await tx
          .update(conversations)
          .set({ departmentId: null })
          .where(
            and(
              eq(conversations.organizationId, org),
              eq(conversations.departmentId, departmentId),
            ),
          )
          .returning({ id: conversations.id });
        await tx
          .update(ticketBoards)
          .set({ departmentId: null })
          .where(
            and(eq(ticketBoards.organizationId, org), eq(ticketBoards.departmentId, departmentId)),
          );
        await tx
          .update(channels)
          .set({ defaultDepartmentId: null })
          .where(
            and(eq(channels.organizationId, org), eq(channels.defaultDepartmentId, departmentId)),
          );
        await tx
          .delete(departments)
          .where(and(eq(departments.organizationId, org), eq(departments.id, departmentId)));
        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.departmentDeleted,
          targetType: 'department',
          targetId: departmentId,
          metadata: { name: current.name, conversations: released.length },
          client,
        });
        return memberIds;
      });
      // Anggota bertanda kehilangan akses ke percakapan departemen ini → muat ulang (Info 2).
      await publisher.publish(
        members.map((userId) => ({
          type: 'access.changed' as const,
          organizationId: auth.organizationId,
          userId,
        })),
      );
    },

    access: accessOf,

    async setAccess(
      auth: AuthContext,
      userId: string,
      input: { departmentIds: string[]; restricted: boolean },
      confirmation: IdentityConfirmation | undefined,
      context: TwoFactorContext,
    ): Promise<DepartmentAccess> {
      const org = auth.organizationId;
      const before = await accessOf(org, userId);
      const [target] = await db
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.organizationId, org), eq(users.id, userId)));
      if (!target) throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
      if (
        input.restricted &&
        !(DEPARTMENT_RESTRICTABLE_ROLES as readonly string[]).includes(target.role)
      ) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Akses "hanya departemen sendiri" hanya untuk Supervisor dan CS.',
          details: [
            { location: 'body', field: 'restricted', message: 'Hanya untuk Supervisor dan CS.' },
          ],
        });
      }
      const added = input.departmentIds.filter((id) => !before.departmentIds.includes(id));
      // Melonggarkan = pengguna yang SEKARANG bertanda mendapat akses lebih luas (tanda dicabut, atau
      // departemen ditambah). Menandai pengguna yang belum bertanda selalu menyempitkan.
      const loosened = before.restricted && (!input.restricted || added.length > 0);
      if (loosened) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          confirmation,
          'department.access',
          context,
          'Masukkan password (dan kode verifikasi) untuk memperluas akses departemen pengguna ini.',
        );
      }
      const released = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const [locked] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.organizationId, org), eq(users.id, userId)))
          .for('update');
        if (!locked) throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
        if (input.departmentIds.length > 0) {
          const found = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(
              and(
                eq(departments.organizationId, org),
                inArray(departments.id, input.departmentIds),
              ),
            );
          if (found.length !== input.departmentIds.length) {
            throw new AppError('VALIDATION_ERROR', {
              message: DEPARTMENT_NOT_FOUND,
              details: [
                { location: 'body', field: 'departmentIds', message: DEPARTMENT_NOT_FOUND },
              ],
            });
          }
        }
        await tx
          .delete(departmentMembers)
          .where(
            and(eq(departmentMembers.organizationId, org), eq(departmentMembers.userId, userId)),
          );
        if (input.departmentIds.length > 0) {
          await tx.insert(departmentMembers).values(
            input.departmentIds.map((departmentId) => ({
              organizationId: org,
              departmentId,
              userId,
            })),
          );
        }
        await tx
          .update(users)
          .set({ departmentRestricted: input.restricted })
          .where(and(eq(users.organizationId, org), eq(users.id, userId)));
        // Review 9.0 R3: departemen baru bisa membuka channel TERBATAS (akses per channel) — dicatat.
        const gained =
          added.length === 0
            ? []
            : await tx
                .selectDistinct({ id: channels.id, name: channels.name })
                .from(channelAccessDepartments)
                .innerJoin(
                  channels,
                  and(
                    eq(channels.organizationId, channelAccessDepartments.organizationId),
                    eq(channels.id, channelAccessDepartments.channelId),
                  ),
                )
                .where(
                  and(
                    eq(channelAccessDepartments.organizationId, org),
                    inArray(channelAccessDepartments.departmentId, added),
                    eq(channels.accessRestricted, true),
                    isNull(channels.deletedAt),
                  ),
                );
        // Review 9.0 R4: keluar dari departemen yang memberi akses channel → percakapannya ke antrian.
        const releasedRows = await releaseInaccessibleAssignments(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          assigneeUserId: userId,
        });
        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.departmentAccessUpdated,
          targetType: 'user',
          targetId: userId,
          metadata: {
            restricted: input.restricted,
            departments: input.departmentIds.length,
            loosened,
            restrictedChannelsGained: gained.slice(0, 50).map((row) => ({
              id: row.id,
              name: row.name,
            })),
            releasedConversations: releasedRows.length,
          },
          client: context.client,
        });
        return releasedRows;
      });
      await publishReleased({ publisher }, org, auth.user.id, released);
      // Socket pengguna itu memuat ulang daftar (data di luar akses barunya hilang dari layar).
      await publisher.publish([{ type: 'access.changed', organizationId: org, userId }]);
      return accessOf(org, userId);
    },

    /** Pindahkan percakapan ke departemen / lepas (`inbox.assign`, cakupan pelaku). */
    async setConversationDepartment(
      auth: AuthContext,
      conversationId: string,
      departmentId: string | null,
    ): Promise<void> {
      const changed = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'inbox.assign');
        const scope = permissionScope(role, 'inbox.assign');
        if (!scope) throw authorityChanged();
        const grant: PermissionGrant = {
          permission: 'inbox.assign',
          scope,
          userId: auth.user.id,
          organizationId: auth.organizationId,
          principal: 'user',
        };
        const [current] = await tx
          .select({ id: conversations.id, departmentId: conversations.departmentId })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.id, conversationId),
              conversationScope(grant),
            ),
          )
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
        if (current.departmentId === departmentId) return null;
        if (departmentId !== null) {
          const [department] = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(
              and(
                eq(departments.organizationId, auth.organizationId),
                eq(departments.id, departmentId),
              ),
            );
          if (!department) {
            throw new AppError('VALIDATION_ERROR', {
              message: DEPARTMENT_NOT_FOUND,
              details: [{ location: 'body', field: 'departmentId', message: DEPARTMENT_NOT_FOUND }],
            });
          }
        }
        await tx
          .update(conversations)
          .set({ departmentId })
          .where(
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.id, conversationId),
            ),
          );
        await tx.insert(conversationEvents).values({
          organizationId: auth.organizationId,
          conversationId,
          kind: 'department_changed',
          actorUserId: auth.user.id,
          departmentId,
        });
        return { previous: current.departmentId };
      });
      if (changed) {
        // Pengguna bertanda departemen lama yang kehilangan akses menerima `conversation.removed`.
        await publisher.publish([
          {
            type: 'conversation.updated',
            organizationId: auth.organizationId,
            conversationId,
            ...(changed.previous ? { previousDepartmentId: changed.previous } : {}),
          },
        ]);
      }
    },
  };
}

export type DepartmentsService = ReturnType<typeof createDepartmentsService>;
