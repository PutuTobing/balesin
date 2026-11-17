import { AppError } from '@balesin/core';
import { departmentMembers, users } from '@balesin/db';
import {
  isDepartmentScopedPermission,
  isWithinScope,
  permissionScope,
  type Permission,
  type PermissionScope,
  type ScopeTarget,
} from '@balesin/shared';
import { eq, or, sql, type Column, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { clientInfo } from '../../http/client-info';
import { fetchSiteOf } from './access-denied';
import { requireAuth } from './auth.hook';
import type { AuthContext } from './session.service';

/**
 * Pemeriksaan izin + CAKUPAN di dalam handler/service (SECURITY.md §2).
 *
 * Hook auth sudah memastikan peran memegang izin rute (`requirePermission`) pada cakupan apa pun.
 * Modul yang datanya bercakupan (inbox, kontak, tiket, laporan — `SCOPED_PERMISSIONS`) WAJIB
 * memakai hasil fungsi ini untuk menyaring data:
 *
 *   const grant = await permissionGrant(request, 'inbox.view');
 *   // DAFTAR (dan hitungan/badge, mis. jumlah "Belum dilayani"): repo WAJIB menerima `grant`
 *   // (bukan `organizationId` lepas) dan menyaring di SQL —
 *   //   where(and(eq(t.organizationId, grant.organizationId), scopeCondition(grant, { holder: t.assigneeUserId, linkedTicketHolder })))
 *   // SATU DATA: assertWithinScope(grant, { holderUserIds, linkedTicketHolderUserIds }) → 404 bila di luar.
 *
 * Juga dipakai untuk izin TAMBAHAN di luar izin rute (mis. rute `inbox.reply` yang mengirim
 * template ke banyak penerima juga butuh `broadcast.send`). Penolakan dicatat di audit seperti
 * penolakan di hook.
 */

export interface PermissionGrant {
  permission: Permission;
  scope: PermissionScope;
  userId: string;
  organizationId: string;
}

/** Cakupan izin untuk sesi ini, atau `null`. Sesi terbatas 2FA tidak memegang izin apa pun. */
export function sessionPermissionScope(
  auth: AuthContext,
  permission: Permission,
): PermissionScope | null {
  if (auth.twoFactor.enrollmentRequired) return null;
  return permissionScope(auth.user.role, permission);
}

/** Izin + cakupan pemanggil; 403 `FORBIDDEN` (+ audit) bila perannya tidak memegang izin itu. */
export async function permissionGrant(
  request: FastifyRequest,
  permission: Permission,
): Promise<PermissionGrant> {
  const auth = requireAuth(request);
  const scope = sessionPermissionScope(auth, permission);
  if (scope === null) {
    await request.server.accessDenied.record({
      auth,
      permission,
      method: request.method,
      route: request.routeOptions.url ?? '',
      client: clientInfo(request),
      fetchSite: fetchSiteOf(request),
    });
    throw new AppError('FORBIDDEN');
  }
  return { permission, scope, userId: auth.user.id, organizationId: auth.organizationId };
}

/**
 * Satu data di luar cakupan → 404 `NOT_FOUND` (bukan 403): pemanggil tidak boleh tahu data itu ada.
 * `target` diisi repo dari data organisasi yang sama (query tetap terfilter `organization_id`).
 */
export function assertWithinScope(grant: PermissionGrant, target: ScopeTarget): void {
  if (!isWithinScope(grant.scope, grant.userId, target)) throw new AppError('NOT_FOUND');
}

/** Cara repo menyatakan "pemegang" data untuk filter cakupan. */
export interface ScopeColumns {
  /**
   * Pemegang LANGSUNG: kolom ID pengguna (mis. `conversations.assigneeUserId`), atau kondisi untuk
   * pemegang jamak (mis. `exists (select 1 from peserta where … user_id = ${userId})`).
   */
  holder: Column | ((userId: string) => SQL);
  /**
   * Kondisi "terkait tiket yang dipegang pengguna ini" (mis. `exists (select 1 from tiket …)`).
   * Hanya dipakai cakupan `assigned`. Tanpa ini, `assigned` = pemegang langsung saja.
   */
  linkedTicketHolder?: (userId: string) => SQL;
  /**
   * Departemen data (percakapan: kolomnya; tiket: departemen board-nya) — dipakai cakupan
   * `department` ("akses hanya departemen sendiri", Fase 5). Tanpa ini, pengguna bertanda departemen
   * hanya melihat data yang ia pegang/terkait tiketnya.
   */
  department?: Column | SQL;
}

/** Pengguna bertanda "akses hanya departemen sendiri" (dibaca segar; API key → tidak pernah). */
function departmentRestricted(grant: PermissionGrant): SQL {
  // Hanya Supervisor/CS (`DEPARTMENT_RESTRICTABLE_ROLE_LIST`): Owner/Admin selalu penuh walau tandanya
  // tertinggal setelah naik peran.
  return sql`exists (select 1 from ${users} where ${users.organizationId} = ${grant.organizationId} and ${users.id} = ${grant.userId} and ${users.departmentRestricted} and ${users.role} in ('supervisor', 'cs'))`;
}

/** Cakupan `department`: dipegang langsung, terkait tiket yang dipegang, atau departemen sendiri. */
function departmentNarrowed(grant: PermissionGrant, columns: ScopeColumns, held: SQL): SQL {
  const conditions: SQL[] = [held];
  if (columns.linkedTicketHolder) conditions.push(columns.linkedTicketHolder(grant.userId));
  if (columns.department) {
    conditions.push(
      sql`${columns.department} in (select ${departmentMembers.departmentId} from ${departmentMembers} where ${departmentMembers.organizationId} = ${grant.organizationId} and ${departmentMembers.userId} = ${grant.userId})`,
    );
  }
  return or(...conditions) as SQL;
}

/**
 * Kondisi Drizzle untuk DAFTAR bercakupan — padanan SQL `isWithinScope`. Selalu mengembalikan
 * kondisi (cakupan `all` = `true`), jadi selalu digabung dengan filter `organization_id`:
 *
 *   and(eq(table.organizationId, grant.organizationId), scopeCondition(grant, { holder: table.assigneeUserId }))
 *
 * `switch` lengkap: nilai cakupan baru gagal saat kompilasi di sini. Izin di
 * `DEPARTMENT_SCOPED_PERMISSIONS` dengan cakupan `all` mendapat syarat tambahan "bukan pengguna
 * bertanda departemen, ATAU data departemennya/miliknya" (Fase 5).
 */
export function scopeCondition(grant: PermissionGrant, columns: ScopeColumns): SQL {
  const held = (userId: string): SQL =>
    typeof columns.holder === 'function' ? columns.holder(userId) : eq(columns.holder, userId);
  switch (grant.scope) {
    case 'all':
      // Fase 5: cakupan `all` izin percakapan/tiket DISEMPITKAN untuk pengguna bertanda departemen.
      // Tanda dibaca dari database di query yang sama (tanpa cache sesi → pencabutan langsung berlaku).
      if (!isDepartmentScopedPermission(grant.permission)) return sql`true`;
      return or(
        sql`not ${departmentRestricted(grant)}`,
        departmentNarrowed(grant, columns, held(grant.userId)),
      ) as SQL;
    case 'department':
      return departmentNarrowed(grant, columns, held(grant.userId));
    case 'assigned': {
      const direct = held(grant.userId);
      return columns.linkedTicketHolder
        ? (or(direct, columns.linkedTicketHolder(grant.userId)) as SQL)
        : direct;
    }
    case 'own':
      return held(grant.userId);
    default: {
      const unknownScope: never = grant.scope;
      throw new Error(`Cakupan izin tidak dikenal: ${String(unknownScope)}`);
    }
  }
}
