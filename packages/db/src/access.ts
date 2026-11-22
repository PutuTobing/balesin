import { CHANNEL_ACCESS_EXEMPT_ROLES } from '@balesin/shared';
import { and, eq, inArray, isNull, sql, type Column, type SQL } from 'drizzle-orm';

import type { DbExecutor } from './client';
import {
  channelAccessDepartments,
  channelAccessUsers,
  channels,
  departmentMembers,
  tickets,
  users,
} from './schema';

/**
 * Data cakupan Fase 5 untuk pemeriksaan DI MEMORI (hub real-time api, worker kirim & notifikasi) —
 * padanan `scopeCondition` SQL di api. Dibaca SEGAR dari database setiap kali (tidak di-cache di
 * sesi), jadi perubahan departemen/tiket langsung berlaku.
 */

export interface DepartmentAccess {
  /** Tanda "akses hanya departemen sendiri". */
  restricted: boolean;
  departmentIds: string[];
}

/** Akses departemen sekumpulan pengguna (pengguna yang tidak ditemukan tidak ada di peta). */
export async function departmentAccessOf(
  db: DbExecutor,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, DepartmentAccess>> {
  const result = new Map<string, DepartmentAccess>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return result;
  const rows = await db
    .select({ id: users.id, restricted: users.departmentRestricted })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  for (const row of rows) result.set(row.id, { restricted: row.restricted, departmentIds: [] });
  const members = await db
    .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(
      and(
        eq(departmentMembers.organizationId, organizationId),
        inArray(departmentMembers.userId, unique),
      ),
    );
  for (const member of members) result.get(member.userId)?.departmentIds.push(member.departmentId);
  return result;
}

/**
 * Penanggung jawab tiket TERBUKA yang memberi akses "terkait tiketnya" ke percakapan-percakapan ini:
 * percakapan → daftar ID pengguna. Aturan (sama dengan SQL `conversationLinkedByTicket` di api):
 * tiket menaut KONTAK percakapan itu DAN (tiket menaut percakapan itu secara eksplisit, ATAU
 * percakapannya masih terbuka, ATAU percakapannya dibuat setelah tiket) — riwayat lama yang sudah
 * selesai tidak terbuka lewat tiket (review Fase 5 Info 1).
 */
export async function openTicketHoldersOf(
  db: DbExecutor,
  organizationId: string,
  conversations: readonly { id: string; contactId: string; status: string; createdAt: Date }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const contactIds = [...new Set(conversations.map((row) => row.contactId))];
  if (contactIds.length === 0) return result;
  const rows = await db
    .select({
      contactId: tickets.contactId,
      conversationId: tickets.conversationId,
      userId: tickets.assigneeUserId,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.organizationId, organizationId),
        inArray(tickets.contactId, contactIds),
        isNull(tickets.closedAt),
        sql`${tickets.assigneeUserId} is not null`,
      ),
    );
  for (const conversation of conversations) {
    const holders = new Set<string>();
    for (const ticket of rows) {
      if (ticket.contactId !== conversation.contactId || !ticket.userId) continue;
      if (
        ticket.conversationId === conversation.id ||
        conversation.status !== 'resolved' ||
        conversation.createdAt.getTime() >= ticket.createdAt.getTime()
      ) {
        holders.add(ticket.userId);
      }
    }
    if (holders.size > 0) result.set(conversation.id, [...holders]);
  }
  return result;
}

// ── Akses per channel (tahap 9.0) ───────────────────────────────────────────

const exemptRoles = () =>
  sql.join(
    CHANNEL_ACCESS_EXEMPT_ROLES.map((role) => sql`${role}`),
    sql`, `,
  );

/**
 * Siapa yang diperiksa `channelAccessSql`. API key/bot TIDAK dibatasi akses per channel (keputusan
 * tahap 9.0) — dinyatakan eksplisit di TypeScript, bukan ditebak dari ID (review 9.0 R2: gagal
 * tertutup untuk ID pengguna yang tidak ada/terhapus/organisasi lain).
 */
export type ChannelAccessPrincipal =
  { kind: 'apiKey' } | { kind: 'user'; userId: string | SQL | Column };

/**
 * Kondisi SQL "principal boleh melihat channel `channelId`" (tahap 9.0, PRD-EMAIL §4.10).
 * API key → selalu `true`. Pengguna → benar bila pengguna itu ADA di organisasi ini DAN (Owner/Admin,
 * ATAU channel-nya tidak `access_restricted`, ATAU ia terdaftar langsung / anggota departemen yang
 * terdaftar di channel itu). ID yang bukan pengguna organisasi ini = DITOLAK. Peran & keanggotaan
 * dibaca SEGAR di query yang sama (pencabutan langsung berlaku, tanpa cache sesi).
 *
 * Memakai alias tabel sendiri (`acl_*`) supaya aman disisipkan ke query yang juga memakai tabel
 * `channels`/`users`. `channelId`/`userId` boleh kolom/ekspresi (round-robin: `u.id`).
 */
export function channelAccessSql(
  organizationId: string,
  principal: ChannelAccessPrincipal,
  channelId: SQL | Column,
): SQL {
  if (principal.kind === 'apiKey') return sql`true`;
  const { userId } = principal;
  return sql`(exists (select 1 from users acl_x where acl_x.organization_id = ${organizationId} and acl_x.id = ${userId} and acl_x.role in (${exemptRoles()}))
    or (exists (select 1 from users acl_u where acl_u.organization_id = ${organizationId} and acl_u.id = ${userId})
      and ${channelId} in (select acl_c.id from channels acl_c where acl_c.organization_id = ${organizationId} and (not acl_c.access_restricted
        or exists (select 1 from channel_access_users acl_cu where acl_cu.organization_id = ${organizationId} and acl_cu.channel_id = acl_c.id and acl_cu.user_id = ${userId})
        or exists (select 1 from channel_access_departments acl_cd join department_members acl_dm on acl_dm.organization_id = acl_cd.organization_id and acl_dm.department_id = acl_cd.department_id where acl_cd.organization_id = ${organizationId} and acl_cd.channel_id = acl_c.id and acl_dm.user_id = ${userId})))))`;
}

/** Singkatan untuk pengguna bersesi / sasaran pengguna. */
export const userPrincipal = (userId: string | SQL | Column): ChannelAccessPrincipal => ({
  kind: 'user',
  userId,
});

/** Hasil `channelAccessOf`: pemeriksaan di memori untuk sekumpulan pengguna. */
export interface ChannelAccessIndex {
  /**
   * `true` bila pengguna boleh melihat channel itu. Pengguna yang TIDAK ada di daftar `userIds` saat
   * dibuat dianggap tidak berhak atas channel terbatas (gagal tertutup).
   */
  allows(userId: string, channelId: string): boolean;
}

const ALLOW_ALL: ChannelAccessIndex = { allows: () => true };

/**
 * Akses channel sekumpulan pengguna untuk pemeriksaan DI MEMORI (hub real-time, worker kirim &
 * notifikasi) — padanan `channelAccessSql`. Organisasi tanpa channel terbatas = satu query saja.
 */
export async function channelAccessOf(
  db: DbExecutor,
  organizationId: string,
  userIds: readonly string[],
): Promise<ChannelAccessIndex> {
  const restrictedRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organizationId, organizationId), eq(channels.accessRestricted, true)));
  if (restrictedRows.length === 0) return ALLOW_ALL;
  const restricted = new Set(restrictedRows.map((row) => row.id));
  const unique = [...new Set(userIds)];
  const people = unique.length
    ? await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)))
    : [];
  const exempt = new Set(
    people
      .filter((person) => (CHANNEL_ACCESS_EXEMPT_ROLES as readonly string[]).includes(person.role))
      .map((person) => person.id),
  );
  const limited = people.filter((person) => !exempt.has(person.id)).map((person) => person.id);
  const allowed = new Map<string, Set<string>>();
  const grant = (channelId: string, userId: string) => {
    const set = allowed.get(channelId) ?? new Set<string>();
    set.add(userId);
    allowed.set(channelId, set);
  };
  if (limited.length > 0) {
    const channelIds = [...restricted];
    const direct = await db
      .select({ channelId: channelAccessUsers.channelId, userId: channelAccessUsers.userId })
      .from(channelAccessUsers)
      .where(
        and(
          eq(channelAccessUsers.organizationId, organizationId),
          inArray(channelAccessUsers.channelId, channelIds),
          inArray(channelAccessUsers.userId, limited),
        ),
      );
    for (const row of direct) grant(row.channelId, row.userId);
    const viaDepartment = await db
      .select({ channelId: channelAccessDepartments.channelId, userId: departmentMembers.userId })
      .from(channelAccessDepartments)
      .innerJoin(
        departmentMembers,
        and(
          eq(departmentMembers.organizationId, channelAccessDepartments.organizationId),
          eq(departmentMembers.departmentId, channelAccessDepartments.departmentId),
        ),
      )
      .where(
        and(
          eq(channelAccessDepartments.organizationId, organizationId),
          inArray(channelAccessDepartments.channelId, channelIds),
          inArray(departmentMembers.userId, limited),
        ),
      );
    for (const row of viaDepartment) grant(row.channelId, row.userId);
  }
  return {
    allows: (userId, channelId) =>
      !restricted.has(channelId) ||
      exempt.has(userId) ||
      (allowed.get(channelId)?.has(userId) ?? false),
  };
}
