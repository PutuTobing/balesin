import { randomToken, sha256Hex } from '@balesin/core';
import type { Database, DbExecutor } from '@balesin/db';
import type { AuthenticatedSession, UserRole } from '@balesin/shared';

import type { ClientInfo } from '../../http/client-info';
import type { CsrfProtection } from './csrf';
import {
  findActiveSession,
  insertSession,
  revokeSession,
  revokeUserSessions,
  touchSession,
} from './session.repo';

/**
 * Identitas permintaan yang sudah lolos pemeriksaan sesi. Dipasang hook auth di `request.auth`;
 * handler dan pemeriksaan peran membaca dari sini — tidak pernah dari input klien.
 */
export interface AuthContext {
  /** `user_sessions.id`. Di log pakai kunci `sessionRef` (kunci `sessionId` selalu disensor). */
  sessionRef: string;
  organizationId: string;
  user: { id: string; name: string; email: string; role: UserRole };
  organization: { id: string; name: string; timezone: string };
  csrfToken: string;
  /** Hash token sesi — untuk memverifikasi token CSRF. Bukan rahasia yang bisa dipakai masuk. */
  sessionTokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface IssuedSession {
  /** Token mentah untuk cookie. HANYA ada di sini — database menyimpan hash-nya. */
  token: string;
  auth: AuthContext;
}

export interface SessionService {
  /** Sesi untuk token dari cookie, atau `undefined` bila tidak berlaku. Ikut menggeser batas idle. */
  resolve(token: string): Promise<AuthContext | undefined>;
  /**
   * Membuat sesi baru dengan token baru (rotasi saat login). Satu-satunya tempat sesi dibuat:
   * login, akhir wizard setup, dan nanti langkah 2FA memanggil fungsi ini.
   */
  issue(
    executor: DbExecutor,
    input: {
      user: AuthContext['user'];
      organization: AuthContext['organization'];
      client: ClientInfo;
    },
  ): Promise<IssuedSession>;
  revoke(executor: DbExecutor, organizationId: string, sessionRef: string): Promise<boolean>;
  revokeAllForUser(
    executor: DbExecutor,
    organizationId: string,
    userId: string,
    exceptSessionRef?: string,
  ): Promise<number>;
}

export function createSessionService(db: Database, csrf: CsrfProtection): SessionService {
  return {
    async resolve(token) {
      const session = await findActiveSession(db, sha256Hex(token));
      if (!session) return undefined;

      let idleExpiresAt = session.idleExpiresAt;
      if (session.needsTouch) {
        idleExpiresAt =
          (await touchSession(db, session.organizationId, session.id)) ?? idleExpiresAt;
      }

      return {
        sessionRef: session.id,
        organizationId: session.organizationId,
        user: session.user,
        organization: session.organization,
        csrfToken: csrf.tokenFor(session.tokenHash),
        sessionTokenHash: session.tokenHash,
        idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      };
    },

    async issue(executor, input) {
      const token = randomToken(32);
      const tokenHash = sha256Hex(token);
      const row = await insertSession(executor, {
        organizationId: input.organization.id,
        userId: input.user.id,
        tokenHash,
        client: input.client,
      });
      return {
        token,
        auth: {
          sessionRef: row.id,
          organizationId: input.organization.id,
          user: input.user,
          organization: input.organization,
          csrfToken: csrf.tokenFor(tokenHash),
          sessionTokenHash: tokenHash,
          idleExpiresAt: row.idleExpiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
        },
      };
    },

    revoke: (executor, organizationId, sessionRef) =>
      revokeSession(executor, organizationId, sessionRef),

    revokeAllForUser: (executor, organizationId, userId, exceptSessionRef) =>
      revokeUserSessions(executor, organizationId, userId, exceptSessionRef),
  };
}

/** Bentuk respons "sesi aktif" (login, setup selesai, `GET /auth/me`). */
export function toAuthenticatedSession(auth: AuthContext): AuthenticatedSession {
  return {
    status: 'authenticated',
    user: auth.user,
    organization: auth.organization,
    csrfToken: auth.csrfToken,
    session: {
      idleExpiresAt: auth.idleExpiresAt.toISOString(),
      absoluteExpiresAt: auth.absoluteExpiresAt.toISOString(),
    },
  };
}
