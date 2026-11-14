import { AppError } from '@balesin/core';
import {
  isWithinScope,
  permissionScope,
  type Permission,
  type PermissionScope,
  type ScopeTarget,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';

import { clientInfo } from '../../http/client-info';
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
 *   // daftar: filter SQL dari grant.scope —
 *   //   'all'      → hanya organization_id;
 *   //   'assigned' → + (assignee = grant.userId OR ada tiket tertaut dengan assignee = grant.userId);
 *   //   'own'      → + (pemegang = grant.userId).
 *   // satu data: assertWithinScope(grant, { holderUserIds, linkedTicketHolderUserIds }) → 404 bila di luar.
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
