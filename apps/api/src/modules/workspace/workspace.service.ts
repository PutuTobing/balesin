import { AppError } from '@balesin/core';
import {
  agentStates,
  allocationUser,
  defaultExcluded,
  ensureAgentStates,
  loadWorkspaceSettings,
  users,
  workspaceSettings,
  ALLOCATION_ROLES,
  type Database,
  type ResolvedWorkspaceSettings,
} from '@balesin/db';
import {
  AUTO_MESSAGE_KINDS,
  isWithinTeamHours,
  type AutoMessageKind,
  type AllocationAgent,
  type AvailabilityResponse,
  type UpdateAllocationAgentRequest,
  type UpdateWorkspaceSettingsRequest,
  type WorkspaceSettings,
} from '@balesin/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { riskyAdditions } from '../quick-replies/quick-replies.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Pengaturan kerja tim (Fase 5, docs/KONTRAK-API-INBOX.md "Jam kerja, pesan otomatis, alokasi"):
 * jam kerja tim + hari libur, pesan otomatis, mode alokasi + kapasitas, dan keadaan agen
 * (tersedia / dikecualikan). Kelola = `settings.workspace.manage` (diaudit); ketersediaan diri sendiri
 * = `inbox.reply` (tidak diaudit — saklar sehari-hari). Penugasan & pesan otomatis dijalankan worker
 * (`workspace-dispatch`).
 */

export function toWorkspaceSettings(
  settings: ResolvedWorkspaceSettings,
  now: Date,
): WorkspaceSettings {
  return {
    timezone: settings.timezone,
    teamHours: settings.teamHours,
    holidays: settings.holidays,
    withinTeamHoursNow: isWithinTeamHours(
      settings.teamHours,
      settings.holidays,
      settings.timezone,
      now,
    ),
    allocation: { mode: settings.allocationMode, maxOpenPerAgent: settings.maxOpenPerAgent },
    autoMessages: settings.autoMessages,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

/** Ada jenis pesan otomatis yang DIAKTIFKAN atau teksnya DIUBAH oleh permintaan ini. */
export function sensitiveAutoMessageChange(
  current: ResolvedWorkspaceSettings,
  input: UpdateWorkspaceSettingsRequest,
): boolean {
  return AUTO_MESSAGE_KINDS.some((kind) => {
    const incoming = input.autoMessages?.[kind];
    if (!incoming) return false;
    const before = current.autoMessages[kind];
    return (incoming.enabled && !before.enabled) || incoming.text !== before.text;
  });
}

/** Teks lama → baru per jenis yang berubah + tautan/angka panjang baru (detektor balasan cepat). */
function autoMessageAudit(
  current: ResolvedWorkspaceSettings,
  next: Record<`${AutoMessageKind}Text`, string>,
): Record<string, unknown> {
  const texts: Record<string, { previous: string; next: string }> = {};
  let links = 0;
  let numbers = 0;
  for (const kind of AUTO_MESSAGE_KINDS) {
    const previous = current.autoMessages[kind].text;
    const updated = next[`${kind}Text`];
    if (previous === updated) continue;
    texts[kind] = { previous: previous.slice(0, 1_000), next: updated.slice(0, 1_000) };
    const added = riskyAdditions(previous, updated);
    links += added.links;
    numbers += added.numbers;
  }
  if (Object.keys(texts).length === 0) return {};
  return {
    autoMessageTexts: texts,
    ...(links > 0 || numbers > 0 ? { risky: true, addedLinks: links, addedNumbers: numbers } : {}),
  };
}

export function createWorkspaceService(deps: {
  db: Database;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  now?: () => Date;
}) {
  const { db, twoFactor } = deps;
  const now = deps.now ?? (() => new Date());

  async function agentsOf(organizationId: string, userId?: string): Promise<AllocationAgent[]> {
    await ensureAgentStates(db, organizationId);
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        role: users.role,
        available: agentStates.available,
        excluded: agentStates.excluded,
        lastAssignedAt: agentStates.lastAssignedAt,
        openConversations: sql<number>`(select count(*)::int from conversations c where c.organization_id = ${users.organizationId} and c.assignee_user_id = ${users.id} and c.status = 'served')`,
      })
      .from(users)
      .innerJoin(agentStates, eq(agentStates.userId, users.id))
      .where(
        and(
          eq(users.organizationId, organizationId),
          isNull(users.disabledAt),
          inArray(users.role, [...ALLOCATION_ROLES]),
          userId === undefined ? undefined : eq(users.id, userId),
        ),
      )
      .orderBy(asc(users.name));
    return rows.map((row) => ({
      ...row,
      openConversations: Number(row.openConversations),
      lastAssignedAt: row.lastAssignedAt?.toISOString() ?? null,
    }));
  }

  /** Ketersediaan milik sendiri (agen non-alokasi, mis. Teknisi: selalu `excluded`). */
  async function availabilityOf(auth: AuthContext): Promise<AvailabilityResponse['availability']> {
    const settings = await loadWorkspaceSettings(db, auth.organizationId);
    const [agent] = await agentsOf(auth.organizationId, auth.user.id);
    return {
      available: agent?.available ?? false,
      excluded: agent?.excluded ?? true,
      mode: settings.allocationMode,
    };
  }

  return {
    async getSettings(organizationId: string): Promise<WorkspaceSettings> {
      return toWorkspaceSettings(await loadWorkspaceSettings(db, organizationId), now());
    },

    async updateSettings(
      auth: AuthContext,
      input: UpdateWorkspaceSettingsRequest,
      context: TwoFactorContext,
    ): Promise<WorkspaceSettings> {
      const { client } = context;
      // Review jam kerja S1: mengaktifkan / mengubah teks pesan otomatis (dikirim ke SEMUA pelanggan
      // baru dari nomor resmi) = konfirmasi identitas. Mematikan tidak perlu (arah aman).
      const confirmed = sensitiveAutoMessageChange(
        await loadWorkspaceSettings(db, auth.organizationId),
        input,
      );
      if (confirmed) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'workspace.auto_messages',
          context,
          'Masukkan password (dan kode verifikasi) untuk mengubah pesan otomatis ke pelanggan.',
        );
      }
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const current = await loadWorkspaceSettings(tx, auth.organizationId);
        if (!confirmed && sensitiveAutoMessageChange(current, input)) {
          // Pengaturan berubah di antara pemeriksaan dan transaksi: minta ulang dengan konfirmasi.
          throw new AppError('CONFLICT', {
            message: 'Pengaturan pesan otomatis baru saja berubah. Muat ulang lalu simpan lagi.',
          });
        }
        const next = {
          teamHours: input.teamHours ?? current.teamHours,
          holidays: input.holidays ?? current.holidays,
          allocationMode: input.allocation?.mode ?? current.allocationMode,
          maxOpenPerAgent:
            input.allocation === undefined
              ? current.maxOpenPerAgent
              : input.allocation.maxOpenPerAgent,
          greetingEnabled:
            input.autoMessages?.greeting?.enabled ?? current.autoMessages.greeting.enabled,
          greetingText: input.autoMessages?.greeting?.text ?? current.autoMessages.greeting.text,
          awayEnabled: input.autoMessages?.away?.enabled ?? current.autoMessages.away.enabled,
          awayText: input.autoMessages?.away?.text ?? current.autoMessages.away.text,
          assignedEnabled:
            input.autoMessages?.assigned?.enabled ?? current.autoMessages.assigned.enabled,
          assignedText: input.autoMessages?.assigned?.text ?? current.autoMessages.assigned.text,
        };
        const before: Record<keyof typeof next, unknown> = {
          teamHours: current.teamHours,
          holidays: current.holidays,
          allocationMode: current.allocationMode,
          maxOpenPerAgent: current.maxOpenPerAgent,
          greetingEnabled: current.autoMessages.greeting.enabled,
          greetingText: current.autoMessages.greeting.text,
          awayEnabled: current.autoMessages.away.enabled,
          awayText: current.autoMessages.away.text,
          assignedEnabled: current.autoMessages.assigned.enabled,
          assignedText: current.autoMessages.assigned.text,
        };
        const changedFields = (Object.keys(next) as (keyof typeof next)[]).filter(
          (field) => JSON.stringify(next[field]) !== JSON.stringify(before[field]),
        );
        if (changedFields.length === 0) return;
        await tx
          .insert(workspaceSettings)
          .values({ organizationId: auth.organizationId, ...next, updatedByUserId: auth.user.id })
          .onConflictDoUpdate({
            target: workspaceSettings.organizationId,
            set: { ...next, updatedByUserId: auth.user.id },
          });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.workspaceSettingsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          // Teks pesan otomatis lama → baru (isi pengaturan organisasi, bukan data pelanggan; maks.
          // 1.000 karakter) + penanda risiko tautan/angka baru → kejadian keamanan
          // `auto_message_risky` (review jam kerja S1).
          metadata: { changedFields, actorRole: role, ...autoMessageAudit(current, next) },
          client,
        });
      });
      return toWorkspaceSettings(await loadWorkspaceSettings(db, auth.organizationId), now());
    },

    agents: (organizationId: string) => agentsOf(organizationId),

    async updateAgent(
      auth: AuthContext,
      userId: string,
      input: UpdateAllocationAgentRequest,
      client: ClientInfo,
    ): Promise<AllocationAgent> {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const target = await allocationUser(tx, auth.organizationId, userId);
        if (!target) {
          throw new AppError('NOT_FOUND', {
            message: 'Agen tidak ditemukan (Teknisi & akun nonaktif tidak ikut alokasi otomatis).',
          });
        }
        await tx
          .insert(agentStates)
          .values({
            userId,
            organizationId: auth.organizationId,
            excluded: input.excluded ?? defaultExcluded(target.role),
            available: input.available ?? true,
          })
          .onConflictDoUpdate({
            target: agentStates.userId,
            set: {
              ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
              ...(input.available === undefined ? {} : { available: input.available }),
            },
          });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.allocationAgentUpdated,
          targetType: 'user',
          targetId: userId,
          metadata: {
            ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
            ...(input.available === undefined ? {} : { available: input.available }),
            self: userId === auth.user.id,
          },
          client,
        });
      });
      const [agent] = await agentsOf(auth.organizationId, userId);
      if (!agent) throw new AppError('NOT_FOUND', { message: 'Agen tidak ditemukan.' });
      return agent;
    },

    availability: availabilityOf,

    async setAvailability(
      auth: AuthContext,
      available: boolean,
    ): Promise<AvailabilityResponse['availability']> {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'inbox.reply');
        const target = await allocationUser(tx, auth.organizationId, auth.user.id);
        if (!target) {
          throw new AppError('CONFLICT', {
            message: 'Peranmu tidak ikut pembagian percakapan otomatis.',
          });
        }
        await tx
          .insert(agentStates)
          .values({
            userId: auth.user.id,
            organizationId: auth.organizationId,
            excluded: defaultExcluded(target.role),
            available,
          })
          .onConflictDoUpdate({ target: agentStates.userId, set: { available } });
      });
      return availabilityOf(auth);
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
