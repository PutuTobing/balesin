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
