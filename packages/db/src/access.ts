import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { departmentMembers, tickets, users } from './schema';

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
 * Penanggung jawab tiket TERBUKA yang menaut kontak-kontak ini (cakupan "terkait tiketnya"):
 * kontak → daftar ID pengguna. Percakapan ikut kontaknya (tiket yang menaut percakapan selalu
 * menaut kontaknya juga).
 */
export async function openTicketHoldersOf(
  db: DbExecutor,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(contactIds)];
  if (unique.length === 0) return result;
  const rows = await db
    .selectDistinct({ contactId: tickets.contactId, userId: tickets.assigneeUserId })
    .from(tickets)
    .where(
      and(
        eq(tickets.organizationId, organizationId),
        inArray(tickets.contactId, unique),
        isNull(tickets.closedAt),
        sql`${tickets.assigneeUserId} is not null`,
      ),
    );
  for (const row of rows) {
    if (!row.contactId || !row.userId) continue;
    const list = result.get(row.contactId) ?? [];
    list.push(row.userId);
    result.set(row.contactId, list);
  }
  return result;
}
