import {
  AUTO_MESSAGE_DEFAULT_TEXTS,
  rolesWithPermission,
  type AllocationMode,
  type TeamHoliday,
  type TeamHours,
  type UserRole,
} from '@balesin/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { agentStates, organizations, users, workspaceSettings } from './schema';

/**
 * Pengaturan kerja tim (Fase 5) — satu sumber aturan untuk api (Pengaturan) dan worker (alokasi
 * round-robin, pesan otomatis). Tanpa baris = bawaan (24 jam, ambil sendiri, pesan otomatis mati).
 */

export interface ResolvedWorkspaceSettings {
  organizationId: string;
  timezone: string;
  teamHours: TeamHours;
  holidays: TeamHoliday[];
  allocationMode: AllocationMode;
  maxOpenPerAgent: number | null;
  autoMessages: Record<'greeting' | 'away' | 'assigned', { enabled: boolean; text: string }>;
  updatedAt: Date | null;
}

export async function loadWorkspaceSettings(
  db: DbExecutor,
  organizationId: string,
): Promise<ResolvedWorkspaceSettings> {
  const [row] = await db
    .select({ settings: workspaceSettings, timezone: organizations.timezone })
    .from(organizations)
    .leftJoin(workspaceSettings, eq(workspaceSettings.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId));
  const settings = row?.settings ?? null;
  return {
    organizationId,
    timezone: row?.timezone ?? 'Asia/Jakarta',
    teamHours: settings?.teamHours ?? { mode: 'always' },
    holidays: Array.isArray(settings?.holidays) ? settings.holidays : [],
    allocationMode: settings?.allocationMode ?? 'manual',
    maxOpenPerAgent: settings?.maxOpenPerAgent ?? null,
    autoMessages: {
      greeting: {
        enabled: settings?.greetingEnabled ?? false,
        text: settings?.greetingText ?? AUTO_MESSAGE_DEFAULT_TEXTS.greeting,
      },
      away: {
        enabled: settings?.awayEnabled ?? false,
        text: settings?.awayText ?? AUTO_MESSAGE_DEFAULT_TEXTS.away,
      },
      assigned: {
        enabled: settings?.assignedEnabled ?? false,
        text: settings?.assignedText ?? AUTO_MESSAGE_DEFAULT_TEXTS.assigned,
      },
    },
    updatedAt: settings?.updatedAt ?? null,
  };
}

/**
 * Peran yang ikut alokasi otomatis: memegang `inbox.reply` dengan cakupan PENUH (Teknisi tidak — ia
 * hanya melihat yang di-assign/terkait tiketnya).
 */
export const ALLOCATION_ROLES: readonly UserRole[] = rolesWithPermission('inbox.reply', {
  fullScopeOnly: true,
});

/** Bawaan pengecualian: Owner/Admin tidak menerima percakapan otomatis kecuali diikutkan. */
export function defaultExcluded(role: UserRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Baris `agent_states` untuk semua agen aktif organisasi yang belum punya (idempoten). */
export async function ensureAgentStates(db: DbExecutor, organizationId: string): Promise<void> {
  await db.execute(sql`
    insert into ${agentStates} (user_id, organization_id, excluded)
    select ${users.id}, ${users.organizationId}, ${users.role} in ('owner', 'admin')
    from ${users}
    where ${users.organizationId} = ${organizationId}
      and ${users.disabledAt} is null
      and ${users.role} in (${sql.join(
        ALLOCATION_ROLES.map((role) => sql`${role}`),
        sql`, `,
      )})
    on conflict (user_id) do nothing`);
}

/** Pengguna aktif berperan alokasi (untuk validasi pengaturan agen). */
export async function allocationUser(db: DbExecutor, organizationId: string, userId: string) {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, userId),
        isNull(users.disabledAt),
        inArray(users.role, [...ALLOCATION_ROLES]),
      ),
    );
  return user ?? null;
}
