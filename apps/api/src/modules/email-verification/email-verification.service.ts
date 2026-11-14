import { AppError } from '@balesin/core';
import { newId, users, type Database } from '@balesin/db';
import {
  EMAIL_VERIFICATION_VALID_HOURS,
  type EmailVerificationStatusResponse,
  type SendEmailVerificationResponse,
  type VerifyEmailResponse,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import {
  consumeAccountToken,
  findAccountTokenByHash,
  insertAccountToken,
  lockAccountTokens,
  markAccountTokenUndelivered,
  revokeLiveAccountTokens,
} from '../account-tokens/account-tokens.repo';
import {
  PUBLIC_TOKEN_IP_RULE,
  PUBLIC_TOKEN_RATE_MESSAGE,
  hashLinkToken,
  issueLinkToken,
  type TokenDelivery,
} from '../account-tokens/token-delivery';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import type { AuthContext } from '../auth/session.service';

/**
 * Verifikasi alamat email (docs/KONTRAK-API-AUTH.md bagian "Verifikasi email").
 *
 * Lingkup sekarang: pengguna memverifikasi email AKUNNYA SENDIRI (Owner hasil wizard setup, atau
 * akun dari undangan yang tautannya disalin manual). Tokennya mekanisme umum `account_tokens`
 * dengan kolom `email` = alamat yang diverifikasi, jadi ubah email di profil (nanti) tinggal
 * menerbitkan token `email_verification` untuk alamat BARU (dikirim ke alamat baru itu) dan
 * menambah langkah "pakai alamat baru + beri tahu alamat lama" di `verify`. Sampai itu dibangun,
 * token yang alamatnya berbeda dari email akun ditolak.
 */

export interface EmailVerificationContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
}

export interface EmailVerificationService {
  status(auth: AuthContext): Promise<EmailVerificationStatusResponse>;
  send(
    auth: AuthContext,
    context: EmailVerificationContext,
  ): Promise<SendEmailVerificationResponse>;
  verify(token: string, context: EmailVerificationContext): Promise<VerifyEmailResponse>;
}

export interface EmailVerificationServiceDeps {
  db: Database;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  delivery: TokenDelivery;
}

/** Tautan verifikasi per pengguna. */
export const EMAIL_VERIFICATION_SEND_RULE: RateLimitRule = {
  name: 'verifikasi-email',
  limit: 3,
  windowSeconds: 60 * 60,
};

function invalid(message: string): AppError {
  return new AppError('TOKEN_INVALID', { message });
}

const GENERIC_INVALID =
  'Tautan verifikasi ini tidak berlaku. Masuk ke aplikasi lalu kirim ulang email verifikasi dari halaman akun.';

export function createEmailVerificationService(
  deps: EmailVerificationServiceDeps,
): EmailVerificationService {
  const { db, limiter, notifier, delivery } = deps;

  async function loadUser(auth: AuthContext) {
    const [user] = await db
      .select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.organizationId, auth.organizationId), eq(users.id, auth.user.id)))
      .limit(1);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return user;
  }

  return {
    async status(auth) {
      const user = await loadUser(auth);
      return {
        email: user.email,
        verified: user.emailVerifiedAt !== null,
        verifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
        canSend: await delivery.emailAvailable(db, auth.organizationId),
      };
    },

    async send(auth, context) {
      const user = await loadUser(auth);
      if (user.emailVerifiedAt !== null) {
        throw new AppError('CONFLICT', { message: 'Email akunmu sudah terverifikasi.' });
      }
      if (!(await delivery.emailAvailable(db, auth.organizationId))) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message:
            'Email verifikasi belum bisa dikirim karena email pengirim belum diatur. Minta Owner mengaturnya di Pengaturan → Email pengirim.',
        });
      }
      await enforceRateLimit(
        limiter,
        EMAIL_VERIFICATION_SEND_RULE,
        user.id,
        (wait) => `Email verifikasi sudah dikirim beberapa kali. Coba lagi dalam ${wait}.`,
      );

      const { token, tokenHash } = issueLinkToken();
      const tokenId = newId();
      const organizationId = auth.organizationId;
      const issued = await db.transaction(async (tx) => {
        await lockAccountTokens(tx, organizationId, user.id, 'email_verification');
        await revokeLiveAccountTokens(tx, organizationId, user.id, 'email_verification');
        const row = await insertAccountToken(tx, {
          id: tokenId,
          organizationId,
          userId: user.id,
          purpose: 'email_verification',
          tokenHash,
          email: user.email,
          lifetimeMinutes: EMAIL_VERIFICATION_VALID_HOURS * 60,
          deliveryTokenEncrypted: delivery.sealAccountToken(organizationId, tokenId, token),
          client: context.client,
        });
        await recordAudit(tx, {
          organizationId,
          actorUserId: user.id,
          action: AUDIT_ACTIONS.emailVerificationSent,
          targetType: 'user',
          targetId: user.id,
          metadata: { tokenRef: tokenId },
          client: context.client,
        });
        return row;
      });
      try {
        await notifier.accountToken({ organizationId, tokenId });
      } catch (err) {
        context.log.warn({ err, tokenRef: tokenId }, 'Gagal mengantre email verifikasi');
        await markAccountTokenUndelivered(db, organizationId, tokenId);
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: 'Email verifikasi belum bisa dikirim sekarang. Coba lagi beberapa saat lagi.',
        });
      }
      return { status: 'queued', expiresAt: issued.expiresAt.toISOString() };
    },

    async verify(token, context) {
      const ipKey = ipRateLimitKey(context.client);
      await enforceRateLimit(limiter, PUBLIC_TOKEN_IP_RULE, ipKey, () => PUBLIC_TOKEN_RATE_MESSAGE);
      const row = await findAccountTokenByHash(db, hashLinkToken(token));
      if (!row || row.purpose !== 'email_verification') throw invalid(GENERIC_INVALID);

      const [user] = await db
        .select({ email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, row.organizationId), eq(users.id, row.userId)))
        .limit(1);
      const reason =
        row.state !== 'usable'
          ? row.state
          : !user || user.disabledAt !== null
            ? 'user_unavailable'
            : user.email !== row.email
              ? 'email_changed'
              : undefined;
      const fail = async (detail: string, message: string): Promise<never> => {
        await recordAudit(db, {
          organizationId: row.organizationId,
          actorUserId: null,
          action: AUDIT_ACTIONS.emailVerificationFailed,
          targetType: 'user',
          targetId: row.userId,
          metadata: { reason: detail, tokenRef: row.id },
          client: context.client,
        });
        throw invalid(message);
      };
      if (reason === 'used') {
        await fail(reason, 'Tautan ini sudah dipakai. Email akunmu sudah terverifikasi.');
      }
      if (reason === 'expired') {
        await fail(
          reason,
          'Tautan verifikasi sudah kedaluwarsa. Masuk ke aplikasi lalu kirim ulang email verifikasi.',
        );
      }
      if (reason === 'email_changed') {
        await fail(
          reason,
          'Alamat email akunmu sudah berubah sejak tautan ini dibuat. Kirim ulang email verifikasi.',
        );
      }
      if (reason) await fail(reason, GENERIC_INVALID);
      await limiter.refund(PUBLIC_TOKEN_IP_RULE, ipKey);

      await db.transaction(async (tx) => {
        if (!(await consumeAccountToken(tx, row.organizationId, row.id))) {
          throw invalid(GENERIC_INVALID);
        }
        await tx
          .update(users)
          .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
          .where(
            and(
              eq(users.organizationId, row.organizationId),
              eq(users.id, row.userId),
              eq(users.email, row.email),
            ),
          );
        await recordAudit(tx, {
          organizationId: row.organizationId,
          actorUserId: row.userId,
          action: AUDIT_ACTIONS.emailVerified,
          targetType: 'user',
          targetId: row.userId,
          metadata: { tokenRef: row.id },
          client: context.client,
        });
      });
      return { status: 'verified', email: row.email };
    },
  };
}
