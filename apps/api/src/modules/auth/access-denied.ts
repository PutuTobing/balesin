import type { Logger } from '@balesin/core';
import type { Database } from '@balesin/db';
import type { Permission } from '@balesin/shared';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimiter } from '../../http/rate-limit';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import type { AuthContext } from './session.service';

/**
 * Jejak audit untuk permintaan yang DITOLAK karena izin (temuan R8 review Fase 1): akun CS yang
 * dibobol dan sedang memetakan endpoint Owner/Admin meninggalkan jejak yang bisa dipantau.
 *
 * - Hanya penolakan izin pada pengguna yang SUDAH masuk (sesi penuh). Tanpa sesi (401), CSRF
 *   salah, dan sesi terbatas 2FA tidak dicatat di sini: pelakunya tidak pasti, atau penyebabnya
 *   biasanya token basi setelah API dijalankan ulang (bukan niat).
 * - Isinya: izin, metode, POLA rute (`/invitations/:invitationId`, bukan URL lengkap — tanpa query,
 *   body, maupun parameter), peran saat itu, ID sesi internal. Tidak ada rahasia.
 * - Pembatas: paling banyak SATU entri per pengguna × izin per `ACCESS_DENIED_AUDIT_WINDOW_SECONDS`
 *   (penanda Redis SET NX), supaya audit tidak bisa dibanjiri.
 * - Tidak pernah mengubah jawaban: bila Redis/DB bermasalah, entri dilewati (dicatat di log) dan
 *   permintaan tetap dijawab 403.
 */

export const ACCESS_DENIED_AUDIT_WINDOW_SECONDS = 60;
export const ACCESS_DENIED_FLAG = 'akses-ditolak';

export interface AccessDeniedEvent {
  auth: AuthContext;
  permission: Permission;
  method: string;
  /** Pola rute Fastify (`request.routeOptions.url`). */
  route: string;
  client: ClientInfo;
}

export interface AccessDeniedRecorder {
  /** `true` bila entri audit ditulis (bukan dilewati karena pembatas atau galat). */
  record(event: AccessDeniedEvent): Promise<boolean>;
}

export function createAccessDeniedRecorder(deps: {
  db: Database;
  limiter: RateLimiter;
  logger: Pick<Logger, 'warn'>;
}): AccessDeniedRecorder {
  const { db, limiter, logger } = deps;
  return {
    async record({ auth, permission, method, route, client }) {
      try {
        const first = await limiter.claimFlag(
          ACCESS_DENIED_FLAG,
          `${auth.user.id}:${permission}`,
          ACCESS_DENIED_AUDIT_WINDOW_SECONDS,
        );
        if (!first) return false;
        await recordAudit(db, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.accessDenied,
          targetType: 'permission',
          targetId: permission,
          metadata: {
            permission,
            method,
            route: route.slice(0, 200),
            role: auth.user.role,
            sessionRef: auth.sessionRef,
          },
          client,
        });
        return true;
      } catch (err) {
        logger.warn(
          { err, userRef: auth.user.id, permission, route },
          'Audit penolakan akses tidak tercatat',
        );
        return false;
      }
    },
  };
}
