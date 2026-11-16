import { AppError, type Logger } from '@balesin/core';
import type { Database } from '@balesin/db';
import type { Permission } from '@balesin/shared';
import type { FastifyRequest } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimiter } from '../../http/rate-limit';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import type { AuthContext } from './session.service';

/**
 * Jejak audit untuk permintaan yang DITOLAK (temuan R8 review Fase 1, R1 review RBAC): akun yang
 * dibobol dan sedang memetakan endpoint, atau mencoba menaikkan wewenangnya, meninggalkan jejak
 * yang bisa dipantau Owner. Dua sumber, satu aksi audit `auth.access.denied`:
 *
 *  1. **Izin rute** — peran tidak memegang izin rute (`record`, dipanggil hook auth dan
 *     `permissionGrant`). `targetType = 'permission'`.
 *  2. **Aturan turunan** — izin rutenya dipegang, tetapi aturan rinci modul menolak (mis. Admin
 *     mengundang/mengelola undangan Admin). `targetType = 'rule'`.
 *
 * POLA WAJIB untuk aturan turunan: setiap 403 dari aturan rinci di service DILEMPAR LEWAT
 * `forbidByRule(...)` (bukan `throw new AppError('FORBIDDEN')` langsung), dengan nama aturan yang
 * terdaftar di `ACCESS_RULES`. Dengan begitu tidak ada penolakan wewenang yang lupa diaudit.
 *
 * - Hanya pengguna yang SUDAH masuk (sesi penuh). Tanpa sesi (401), CSRF salah, dan sesi terbatas
 *   2FA tidak dicatat: pelakunya tidak pasti, atau penyebabnya biasanya token basi.
 * - Isi: izin/aturan, metode + POLA rute (tanpa query, body, parameter), peran, ID sesi internal,
 *   `fetchSite` (header `Sec-Fetch-Site` bila ada — membedakan navigasi lintas situs yang membawa
 *   cookie korban dari permintaan aplikasi sendiri). Tidak ada rahasia.
 * - Pembatas: paling banyak SATU entri per pengguna × izin (atau × aturan) per
 *   `ACCESS_DENIED_AUDIT_WINDOW_SECONDS` (penanda Redis SET NX), supaya audit tidak bisa dibanjiri.
 * - Tidak pernah mengubah jawaban: bila Redis/DB bermasalah, entri dilewati (dicatat di log) dan
 *   permintaan tetap ditolak 403.
 */

export const ACCESS_DENIED_AUDIT_WINDOW_SECONDS = 60;
export const ACCESS_DENIED_FLAG = 'akses-ditolak';

/** Aturan turunan yang bisa menolak di service. Tambahkan di sini setiap ada aturan baru. */
export const ACCESS_RULES = {
  /** Peran pemanggil tidak boleh mengundang/mengelola undangan peran itu (`INVITE_PERMISSIONS`). */
  invitationRole: 'team.invite.role',
  /** Peran pemanggil tidak boleh mengelola pengguna ber-peran itu (`MANAGE_PERMISSIONS`). */
  teamManageRole: 'team.manage.role',
  /** Mengelola diri sendiri lewat endpoint tim (ubah peran/nonaktifkan/2FA/sesi diri sendiri). */
  teamManageSelf: 'team.manage.self',
  /** Peran baru di luar yang boleh diberikan pemanggil (`assignableRoles`). */
  teamAssignRole: 'team.manage.assign_role',
  /** Mengembalikan ke antrian percakapan yang dipegang orang lain tanpa izin `inbox.assign`. */
  inboxUnassignOthers: 'inbox.unassign.others',
  /** Mengubah catatan sesi milik orang lain (isi catatan hanya bisa diubah penulisnya). */
  noteEditOthers: 'inbox.note.edit_others',
  /** Menghapus catatan sesi milik orang lain tanpa izin `inbox.notes.moderate`. */
  noteDeleteOthers: 'inbox.note.delete_others',
} as const;
export type AccessRule = (typeof ACCESS_RULES)[keyof typeof ACCESS_RULES];

/** Nilai `Sec-Fetch-Site` yang dikenal; lainnya dicatat `lainnya`, tidak ada = `null`. */
const FETCH_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

export function fetchSiteOf(request: Pick<FastifyRequest, 'headers'>): string | null {
  const value = request.headers['sec-fetch-site'];
  if (typeof value !== 'string') return null;
  return FETCH_SITES.has(value) ? value : 'lainnya';
}

export interface AccessDeniedEvent {
  auth: AuthContext;
  permission: Permission;
  method: string;
  /** Pola rute Fastify (`request.routeOptions.url`). */
  route: string;
  client: ClientInfo;
  fetchSite?: string | null;
}

export interface RuleDeniedEvent {
  auth: AuthContext;
  rule: AccessRule;
  client: ClientInfo;
  /** Keterangan singkat TANPA rahasia/data pribadi (mis. `{ operation: 'create', targetRole: 'admin' }`). */
  details?: Readonly<Record<string, string>>;
}

export interface AccessDeniedRecorder {
  /** Penolakan izin rute. `true` bila entri audit ditulis (bukan dilewati pembatas/galat). */
  record(event: AccessDeniedEvent): Promise<boolean>;
  /** Penolakan aturan turunan di service. Pakai lewat `forbidByRule`. */
  recordRule(event: RuleDeniedEvent): Promise<boolean>;
}

export function createAccessDeniedRecorder(deps: {
  db: Database;
  limiter: RateLimiter;
  logger: Pick<Logger, 'warn'>;
}): AccessDeniedRecorder {
  const { db, limiter, logger } = deps;

  async function write(
    auth: AuthContext,
    flagKey: string,
    target: { type: 'permission' | 'rule'; id: string },
    metadata: Record<string, unknown>,
    client: ClientInfo,
  ): Promise<boolean> {
    try {
      const first = await limiter.claimFlag(
        ACCESS_DENIED_FLAG,
        `${auth.user.id}:${flagKey}`,
        ACCESS_DENIED_AUDIT_WINDOW_SECONDS,
      );
      if (!first) return false;
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.accessDenied,
        targetType: target.type,
        targetId: target.id,
        metadata: { ...metadata, role: auth.user.role, sessionRef: auth.sessionRef },
        client,
      });
      return true;
    } catch (err) {
      logger.warn(
        { err, userRef: auth.user.id, [target.type]: target.id },
        'Audit penolakan akses tidak tercatat',
      );
      return false;
    }
  }

  return {
    record: ({ auth, permission, method, route, client, fetchSite }) =>
      write(
        auth,
        permission,
        { type: 'permission', id: permission },
        { permission, method, route: route.slice(0, 200), fetchSite: fetchSite ?? null },
        client,
      ),

    recordRule: ({ auth, rule, client, details }) =>
      write(
        auth,
        `rule:${rule}`,
        { type: 'rule', id: rule },
        {
          rule,
          ...Object.fromEntries(
            Object.entries(details ?? {}).map(([k, v]) => [k, v.slice(0, 100)]),
          ),
        },
        client,
      ),
  };
}

/**
 * Menolak dengan 403 `FORBIDDEN` karena aturan turunan, SETELAH mencatat audit (dibatasi). Satu-
 * satunya cara yang benar untuk 403 aturan rinci di service — lihat komentar berkas.
 *
 *   if (!canInviteRole(auth.user.role, input.role)) {
 *     await forbidByRule(accessDenied, { auth, rule: ACCESS_RULES.invitationRole, client, message });
 *   }
 */
export async function forbidByRule(
  recorder: AccessDeniedRecorder,
  event: RuleDeniedEvent & { message: string },
): Promise<never> {
  const { message, ...rest } = event;
  await recorder.recordRule(rest);
  throw new AppError('FORBIDDEN', { message });
}
