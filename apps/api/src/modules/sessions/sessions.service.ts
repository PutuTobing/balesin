import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import type { ActiveSessionListResponse, IdentityConfirmation } from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { listActiveSessions, revokeSessionOfUser } from '../auth/session.repo';
import { revokeInvitationsFromRevokedSessions } from '../invitations/session-revocation';
import type { AuthContext, SessionService } from '../auth/session.service';
import { deleteChallenges } from '../two-factor/two-factor.repo';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import { requiresConfirmation, toActiveSession } from './session-view';

/**
 * Sesi aktif milik pengguna sendiri (Pengaturan → Keamanan akun → Sesi aktif). Alur & error:
 * docs/KONTRAK-API-AUTH.md bagian "Sesi aktif".
 *
 * - Daftar: sesi yang masih berlaku (perangkat ringkas, IP tersamar, waktu masuk, terakhir aktif,
 *   penanda "sesi ini"). Hanya milik pemanggil — kueri selalu memfilter organisasi + pengguna.
 * - Keluarkan satu sesi lain: cukup sesi + CSRF. Sesi yang sedang dipakai → pakai "Keluar".
 * - Keluarkan semua sesi lain: konfirmasi ulang identitas (password + kode 2FA bila aktif). Ikut
 *   membuang tantangan langkah kedua yang masih berjalan (login yang sedang setengah jalan).
 */

export interface SessionsContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  presentedDeviceToken?: string;
}

export interface OwnSessionsService {
  list(auth: AuthContext): Promise<ActiveSessionListResponse>;
  revoke(
    auth: AuthContext,
    sessionId: string,
    input: IdentityConfirmation | null | undefined,
    context: SessionsContext,
  ): Promise<void>;
  revokeOthers(
    auth: AuthContext,
    input: IdentityConfirmation,
    context: SessionsContext,
  ): Promise<number>;
}

export const SESSION_NOT_FOUND_MESSAGE = 'Sesi tidak ditemukan atau sudah berakhir.';

export function createOwnSessionsService(deps: {
  db: Database;
  sessions: SessionService;
  twoFactor: TwoFactorService;
}): OwnSessionsService {
  const { db, sessions, twoFactor } = deps;

  return {
    async list(auth) {
      const rows = await listActiveSessions(db, auth.organizationId, auth.user.id);
      const current = rows.find((row) => row.id === auth.sessionRef);
      return {
        sessions: rows.map((row) => toActiveSession(row, auth.sessionRef, current?.createdAt)),
      };
    },

    async revoke(auth, sessionId, input, context) {
      if (sessionId === auth.sessionRef) {
        throw new AppError('CONFLICT', {
          message: 'Ini sesi yang sedang kamu pakai. Untuk mengakhirinya, pakai tombol Keluar.',
        });
      }
      const rows = await listActiveSessions(db, auth.organizationId, auth.user.id);
      const target = rows.find((row) => row.id === sessionId);
      if (!target) throw new AppError('NOT_FOUND', { message: SESSION_NOT_FOUND_MESSAGE });
      const current = rows.find((row) => row.id === auth.sessionRef);
      let confirmedWith: string | null = null;
      if (requiresConfirmation(target, auth.sessionRef, current?.createdAt)) {
        // Sesi yang lebih baru dari sesi ini: cookie lama (mungkin curian) tidak boleh mengusir
        // pemiliknya yang baru masuk lagi tanpa password (review butir 6 R4).
        if (!input) {
          const message =
            'Sesi itu lebih baru dari sesi yang sedang kamu pakai. Masukkan password-mu (dan kode verifikasi dua langkah bila aktif) untuk mengeluarkannya.';
          throw new AppError('VALIDATION_ERROR', {
            message,
            details: [{ location: 'body', field: 'password', message }],
          });
        }
        ({ method: confirmedWith } = await twoFactor.confirmIdentity(
          auth,
          { password: input.password, code: input.code },
          'revoke_newer_session',
          context,
        ));
      }
      await db.transaction(async (tx) => {
        if (!(await revokeSessionOfUser(tx, auth.organizationId, auth.user.id, sessionId))) {
          throw new AppError('NOT_FOUND', { message: SESSION_NOT_FOUND_MESSAGE });
        }
        // Sesi lain dikeluarkan pemiliknya (mis. dicurigai dicuri): undangannya ikut batal (T1).
        await revokeInvitationsFromRevokedSessions(tx, auth.organizationId, auth.user.id, [
          sessionId,
        ]);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.sessionRevoked,
          targetType: 'session',
          targetId: sessionId,
          metadata: {
            by: 'self',
            userRef: auth.user.id,
            newer: confirmedWith !== null,
            confirmedWith,
          },
          client: context.client,
        });
      });
    },

    async revokeOthers(auth, input, context) {
      const { method } = await twoFactor.confirmIdentity(
        auth,
        { password: input.password, code: input.code },
        'revoke_other_sessions',
        context,
      );
      const revoked = await db.transaction(async (tx) => {
        // Sesi lain dikeluarkan (mis. cookie dicurigai dicuri): undangan terbitannya ikut batal (T1).
        const count = await sessions.revokeAllForUser(
          tx,
          auth.organizationId,
          auth.user.id,
          auth.sessionRef,
          { cancelIssuedInvitations: true },
        );
        await deleteChallenges(tx, auth.organizationId, auth.user.id);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.sessionsRevokedAll,
          targetType: 'user',
          targetId: auth.user.id,
          metadata: {
            by: 'self',
            revokedSessions: count,
            keptCurrent: true,
            confirmedWith: method,
          },
          client: context.client,
        });
        return count;
      });
      context.log.info({ userId: auth.user.id, revokedSessions: revoked }, 'Sesi lain dikeluarkan');
      return revoked;
    },
  };
}
