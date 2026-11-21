import type { Logger } from '@balesin/core';
import type { Database } from '@balesin/db';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimiter } from '../../http/rate-limit';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';

/**
 * Audit `auth.csrf.rejected` (review akhir Fase 1 R1): permintaan yang membawa cookie sesi SAH
 * tetapi ditolak karena token CSRF salah atau `Origin` asing — indikator kuat serangan CSRF /
 * pembajakan WebSocket lintas situs terhadap pengguna yang sedang masuk.
 *
 * - Hanya bila sesinya sah (pelaku = pemilik sesi). Tanpa sesi tidak dicatat.
 * - Isi: metode + POLA rute, `fetchSite`, host asal (bukan URL lengkap), alasan, peran, ID sesi
 *   internal. Tanpa token, cookie, atau isi body.
 * - Paling banyak SATU entri per pengguna per `CSRF_REJECTION_AUDIT_WINDOW_SECONDS` (penanda Redis
 *   SET NX) supaya halaman penyerang tidak bisa membanjiri audit.
 * - Tidak pernah mengubah jawaban: galat Redis/DB hanya dicatat di log.
 */

export const CSRF_REJECTION_AUDIT_WINDOW_SECONDS = 60;
const FLAG = 'csrf-ditolak';

export type CsrfRejectionReason = 'origin' | 'token';

export interface CsrfRejectionEvent {
  session: {
    sessionRef: string;
    organizationId: string;
    user: { id: string; role: string };
  };
  reason: CsrfRejectionReason;
  method: string;
  route: string;
  origin: string | undefined;
  fetchSite: string | null;
  client: ClientInfo;
}

export interface CsrfRejectionRecorder {
  record(event: CsrfRejectionEvent): Promise<boolean>;
}

/** Host dari header `Origin` (`null` bila tidak ada / bukan URL / `null`). */
export function originHostOf(origin: string | undefined): string | null {
  if (origin === undefined || origin === 'null') return null;
  try {
    return new URL(origin).host.slice(0, 200) || null;
  } catch {
    return 'tidak-valid';
  }
}

export function createCsrfRejectionRecorder(deps: {
  db: Database;
  limiter: RateLimiter;
  logger: Pick<Logger, 'warn'>;
}): CsrfRejectionRecorder {
  const { db, limiter, logger } = deps;
  return {
    async record(event) {
      const { session } = event;
      try {
        const first = await limiter.claimFlag(
          FLAG,
          session.user.id,
          CSRF_REJECTION_AUDIT_WINDOW_SECONDS,
        );
        if (!first) return false;
        await recordAudit(db, {
          organizationId: session.organizationId,
          actorUserId: session.user.id,
          action: AUDIT_ACTIONS.csrfRejected,
          metadata: {
            reason: event.reason,
            method: event.method,
            route: event.route.slice(0, 200),
            originHost: originHostOf(event.origin),
            fetchSite: event.fetchSite,
            role: session.user.role,
            sessionRef: session.sessionRef,
          },
          client: event.client,
        });
        return true;
      } catch (err) {
        logger.warn({ err, userRef: session.user.id }, 'Audit penolakan CSRF tidak tercatat');
        return false;
      }
    },
  };
}
