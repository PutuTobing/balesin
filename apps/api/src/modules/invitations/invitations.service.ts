import { AppError, sha256Hex } from '@balesin/core';
import {
  PG_ERROR_CODES,
  isPgError,
  newId,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  INVITE_PERMISSIONS,
  buildTokenLink,
  canInviteRole,
  isTwoFactorRequired,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type IdentityConfirmation,
  type EmailDeliveryStatus,
  type InspectInvitationResponse,
  type Invitation,
  type InvitationIssuedResponse,
  type InvitationListResponse,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import {
  enforceRateLimit,
  rateLimited,
  type RateLimitRule,
  type RateLimiter,
} from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import {
  PUBLIC_TOKEN_IP_RULE,
  PUBLIC_TOKEN_RATE_MESSAGE,
  hashLinkToken,
  issueLinkToken,
  type TokenDelivery,
} from '../account-tokens/token-delivery';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PasswordHasher } from '../auth/password-hasher';
import { checkPassword } from '../auth/password-policy';
import { findActiveSession } from '../auth/session.repo';
import type { AuthContext, IssuedSession, SessionService } from '../auth/session.service';
import type { TrustedDevices } from '../auth/trusted-device';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import { enrollmentDueAtValue } from '../two-factor/enrollment-window';
import {
  findInvitationByTokenHash,
  findOpenInvitation,
  findOpenInvitationByEmail,
  insertInvitation,
  isEmailRegistered,
  listOpenInvitations,
  markInvitationAccepted,
  markInvitationUndelivered,
  reissueInvitation,
  revokeInvitation,
  type InvitationByToken,
  type OpenInvitation,
} from './invitations.repo';

/**
 * Undangan pengguna (SECURITY.md §1, PRD §4): satu-satunya jalan membuat akun selain Owner.
 * Alur & error per kasus: docs/KONTRAK-API-AUTH.md bagian "Undangan".
 *
 * - Hanya Owner/Admin (deklarasi rute) — dan per peran: `INVITE_PERMISSIONS` (Admin tidak bisa
 *   mengundang/mengelola undangan Admin; Owner tidak pernah bisa diundang).
 * - Token 256-bit, hanya hash-nya di database, sekali pakai, 72 jam, terikat email; peran dan
 *   email diambil dari baris undangan saat diterima, bukan dari isian penerima.
 * - Email pengirim belum diatur → tautan ditampilkan SEKALI ke pembuat undangan (dicatat audit),
 *   dan email akun TIDAK dianggap terverifikasi saat diterima (tautannya tidak lewat email).
 * - Peran wajib 2FA: menerima undangan memberi sesi TERBATAS (hanya untuk mendaftar 2FA) —
 *   pendaftaran 2FA menyatu dengan penerimaan undangan (review 2FA R5).
 */

export interface InvitationContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  /** Cookie "perangkat dikenal" (ember batas laju konfirmasi identitas). */
  presentedDeviceToken?: string;
}

export interface AcceptContext extends InvitationContext {
  /** Token sesi yang sudah ada di cookie (dicabut: rotasi sesi, sama seperti login). */
  presentedToken?: string;
}

export interface AcceptedInvitation extends IssuedSession {
  /** Cookie perangkat dikenal — hanya bila sesi penuh (bukan sesi terbatas wajib 2FA). */
  deviceToken: string | undefined;
}

export interface InvitationService {
  list(auth: AuthContext): Promise<InvitationListResponse>;
  create(
    auth: AuthContext,
    input: CreateInvitationRequest,
    context: InvitationContext,
  ): Promise<InvitationIssuedResponse>;
  resend(
    auth: AuthContext,
    invitationId: string,
    confirmation: IdentityConfirmation | undefined,
    context: InvitationContext,
  ): Promise<InvitationIssuedResponse>;
  revoke(auth: AuthContext, invitationId: string, context: InvitationContext): Promise<void>;
  inspect(token: string, context: InvitationContext): Promise<InspectInvitationResponse>;
  accept(input: AcceptInvitationRequest, context: AcceptContext): Promise<AcceptedInvitation>;
}

export interface InvitationServiceDeps {
  db: Database;
  appUrl: string;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  sessions: SessionService;
  devices: TrustedDevices;
  delivery: TokenDelivery;
  /** Audit penolakan aturan turunan (Admin + undangan Admin), lihat `forbidByRule`. */
  accessDenied: AccessDeniedRecorder;
  /** Konfirmasi ulang identitas pembuat/pengirim ulang undangan (review akhir Fase 1 T1). */
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
}

/** Undangan dibuat/dikirim ulang per pengundang. */
export const INVITE_ACTOR_RULE: RateLimitRule = {
  name: 'undangan-pengundang',
  limit: 20,
  windowSeconds: 60 * 60,
};
/** Undangan dibuat/dikirim ulang per organisasi (menahan akun Owner/Admin yang dibobol). */
export const INVITE_ORGANIZATION_RULE: RateLimitRule = {
  name: 'undangan-organisasi',
  limit: 50,
  windowSeconds: 60 * 60,
};
/** Email ke satu alamat tujuan (membuat + mengirim ulang) — jangan membanjiri kotak masuk orang. */
export const INVITE_EMAIL_RULE: RateLimitRule = {
  name: 'undangan-email',
  limit: 5,
  windowSeconds: 60 * 60,
};

const NOT_FOUND_MESSAGE = 'Undangan tidak ditemukan, atau sudah diterima atau dibatalkan.';

function invalid(message: string): AppError {
  return new AppError('TOKEN_INVALID', { message });
}

/** Pesan untuk tautan undangan yang tidak bisa dipakai (pemegang token sudah membuktikan email-nya). */
function invalidFor(state: InvitationByToken['state'] | 'unknown'): AppError {
  switch (state) {
    case 'accepted':
      return invalid('Undangan ini sudah dipakai. Masuk dengan email dan password-mu.');
    case 'expired':
      return invalid(
        'Undangan ini sudah kedaluwarsa. Minta Owner atau Admin di tempatmu mengirim ulang undangannya.',
      );
    default:
      // Token tidak dikenal, sudah diganti (dikirim ulang), undangan dibatalkan, atau pengundangnya
      // sudah tidak aktif/tidak berhak lagi: sama.
      return invalid(
        'Tautan undangan ini tidak berlaku. Buka tautan dari email undangan terbaru, atau minta Owner atau Admin di tempatmu mengirim undangan baru.',
      );
  }
}

function fieldError(field: string, message: string, code: 'VALIDATION_ERROR' | 'CONFLICT') {
  return new AppError(code, { message, details: [{ location: 'body', field, message }] });
}

function forbiddenRoleMessage(actor: UserRole): string {
  return INVITE_PERMISSIONS[actor].length === 0
    ? 'Peranmu tidak bisa mengundang pengguna.'
    : 'Admin hanya bisa mengundang dan mengelola undangan Supervisor, CS, dan Teknisi. Undangan Admin hanya bisa dibuat Owner.';
}

export function createInvitationService(deps: InvitationServiceDeps): InvitationService {
  const { db, appUrl, hasher, limiter, notifier, sessions, devices, delivery, accessDenied } = deps;
  const { twoFactor } = deps;

  /**
   * Konfirmasi ulang identitas untuk SEMUA pelaku, Owner juga: undangan memberi akses menetap, jadi
   * cookie sesi curian saja tidak boleh cukup (review akhir Fase 1 T1). Sebelum kuota terpakai.
   */
  async function confirmIssuer(
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    action: 'invitation.create' | 'invitation.resend',
    context: InvitationContext,
  ): Promise<void> {
    await requireIdentityConfirmation(
      twoFactor,
      auth,
      confirmation,
      action,
      context,
      'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengirim undangan.',
    );
  }

  /** Di transaksi tulis: pelaku masih aktif, sesinya hidup, dan masih boleh mengundang peran ini. */
  async function assertStillIssuer(
    tx: DbExecutor,
    auth: AuthContext,
    role: UserRole,
    log: FastifyBaseLogger,
  ) {
    const { role: currentRole } = await assertActorStillAuthorized(tx, auth, 'team.invite', log);
    if (!canInviteRole(currentRole, role))
      throw authorityChanged(forbiddenRoleMessage(currentRole));
  }

  /**
   * Undangan diterima → email ke semua Owner aktif (semua peran; review akhir Fase 1 T1). Setelah
   * commit, tanpa menggagalkan penerimaan: kejadiannya tetap tampil di ringkasan keamanan.
   */
  function notifyOwnersOfNewMember(
    organizationId: string,
    newUserId: string,
    issuerUserId: string,
    auditLogId: string,
    log: FastifyBaseLogger,
  ): void {
    const occurredAt = new Date().toISOString();
    void (async () => {
      const owners = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.role, 'owner'),
            isNull(users.disabledAt),
          ),
        );
      for (const owner of owners) {
        await notifier.securityNoticeAdmin({
          organizationId,
          recipientUserId: owner.id,
          subjectUserId: newUserId,
          event: 'member_joined',
          occurredAt,
          auditLogId,
          actorUserId: issuerUserId,
        });
      }
    })().catch((err: unknown) => {
      log.warn({ err, userId: newUserId }, 'Gagal mengantre email anggota baru ke Owner');
    });
  }

  /** 403 aturan turunan + audit `auth.access.denied` (pola wajib, `access-denied.ts`). */
  function forbidRole(
    auth: AuthContext,
    operation: 'create' | 'replace' | 'resend' | 'revoke',
    targetRole: UserRole,
    client: ClientInfo,
  ): Promise<never> {
    return forbidByRule(accessDenied, {
      auth,
      rule: ACCESS_RULES.invitationRole,
      client,
      details: { operation, targetRole },
      message: forbiddenRoleMessage(auth.user.role),
    });
  }

  function view(row: OpenInvitation, actorRole: UserRole): Invitation {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.expired ? 'expired' : 'pending',
      invitedBy: row.invitedBy,
      createdAt: row.createdAt.toISOString(),
      lastSentAt: row.tokenIssuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      sendCount: row.sendCount,
      deliveryStatus: row.deliveryStatus,
      canManage: canInviteRole(actorRole, row.role),
    };
  }

  /** Mengambil jatah ketiga ember; bila salah satu habis, jatah ember sebelumnya dikembalikan. */
  async function consumeInviteQuota(auth: AuthContext, email: string): Promise<void> {
    const buckets: Array<[RateLimitRule, string]> = [
      [INVITE_ACTOR_RULE, auth.user.id],
      [INVITE_ORGANIZATION_RULE, auth.organizationId],
      [INVITE_EMAIL_RULE, sha256Hex(`undangan|${auth.organizationId}|${email}`).slice(0, 40)],
    ];
    const taken: Array<[RateLimitRule, string]> = [];
    for (const [rule, key] of buckets) {
      const state = await limiter.consume(rule, key);
      if (!state.allowed) {
        for (const [takenRule, takenKey] of taken) await limiter.refund(takenRule, takenKey);
        throw rateLimited(
          state.retryAfterSeconds,
          rule === INVITE_EMAIL_RULE
            ? 'Terlalu sering mengirim undangan ke email ini.'
            : 'Terlalu banyak undangan dikirim dalam satu jam terakhir.',
        );
      }
      taken.push([rule, key]);
    }
  }

  /**
   * Setelah transaksi: antrekan email (tanpa token di payload). Bila gagal mengantre, undangan
   * ditandai `failed` supaya terlihat di daftar dan bisa dikirim ulang.
   */
  async function enqueue(
    organizationId: string,
    invitationId: string,
    sendCount: number,
    log: FastifyBaseLogger,
  ): Promise<EmailDeliveryStatus> {
    try {
      await notifier.invitation({ organizationId, invitationId, sendCount });
      return 'queued';
    } catch (err) {
      log.warn({ err, invitationRef: invitationId }, 'Gagal mengantre email undangan');
      await markInvitationUndelivered(db, organizationId, invitationId, sendCount);
      return 'failed';
    }
  }

  async function publicLookup(token: string, context: InvitationContext) {
    const ipKey = ipRateLimitKey(context.client);
    await enforceRateLimit(limiter, PUBLIC_TOKEN_IP_RULE, ipKey, () => PUBLIC_TOKEN_RATE_MESSAGE);
    const tokenHash = hashLinkToken(token);
    const row = await findInvitationByTokenHash(db, tokenHash);
    if (!row) throw invalidFor('unknown');
    if (row.state !== 'open') {
      await recordAudit(db, {
        organizationId: row.organizationId,
        actorUserId: null,
        action: AUDIT_ACTIONS.invitationRejected,
        targetType: 'invitation',
        targetId: row.id,
        metadata: { reason: row.state },
        client: context.client,
      });
      throw invalidFor(row.state);
    }
    return { row, tokenHash, ipKey };
  }

  return {
    async list(auth) {
      const rows = await listOpenInvitations(db, auth.organizationId);
      return {
        invitations: rows.map((row) => view(row, auth.user.role)),
        invitableRoles: [...INVITE_PERMISSIONS[auth.user.role]],
        emailDelivery: await delivery.emailAvailable(db, auth.organizationId),
      };
    },

    async create(auth, input, context) {
      if (!canInviteRole(auth.user.role, input.role)) {
        await forbidRole(auth, 'create', input.role, context.client);
      }
      const organizationId = auth.organizationId;
      // Undangan terbuka untuk email yang sama yang TIDAK boleh dikelola pemanggil (mis. undangan
      // Admin buatan Owner, dilihat Admin) tidak boleh tergantikan lewat jalur "buat baru" —
      // aturannya sama dengan kirim ulang/batalkan (review undangan R1). Sebelum kuota terpakai.
      const existing = await findOpenInvitationByEmail(db, organizationId, input.email);
      if (existing && !canInviteRole(auth.user.role, existing.role)) {
        await forbidRole(auth, 'replace', existing.role, context.client);
      }
      await confirmIssuer(auth, input.confirmation, 'invitation.create', context);
      await consumeInviteQuota(auth, input.email);

      if (await isEmailRegistered(db, organizationId, input.email)) {
        throw fieldError(
          'email',
          'Email ini sudah terdaftar sebagai pengguna di organisasimu.',
          'CONFLICT',
        );
      }
      if (existing && !existing.expired) {
        throw fieldError(
          'email',
          'Undangan untuk email ini masih berlaku. Kirim ulang dari daftar undangan bila perlu.',
          'CONFLICT',
        );
      }

      const emailAvailable = await delivery.emailAvailable(db, organizationId);
      const { token, tokenHash } = issueLinkToken();
      const invitationId = newId();
      const deliveryStatus: EmailDeliveryStatus = emailAvailable ? 'queued' : 'link';

      try {
        await db.transaction(async (tx) => {
          await assertStillIssuer(tx, auth, input.role, context.log);
          // Undangan lama yang sudah kedaluwarsa untuk email yang sama diganti (dibatalkan).
          if (existing) {
            await revokeInvitation(tx, organizationId, existing.id, auth.user.id);
            await recordAudit(tx, {
              organizationId,
              actorUserId: auth.user.id,
              action: AUDIT_ACTIONS.invitationRevoked,
              targetType: 'invitation',
              targetId: existing.id,
              metadata: { reason: 'replaced_expired', replacedBy: invitationId },
              client: context.client,
            });
          }
          await insertInvitation(tx, {
            id: invitationId,
            organizationId,
            email: input.email,
            role: input.role,
            tokenHash,
            deliveryStatus,
            deliveryTokenEncrypted: emailAvailable
              ? delivery.sealInvitationToken(organizationId, invitationId, 1, token)
              : null,
            actorUserId: auth.user.id,
            sessionRef: auth.sessionRef,
          });
          await recordAudit(tx, {
            organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.invitationCreated,
            targetType: 'invitation',
            targetId: invitationId,
            metadata: { email: input.email, role: input.role, delivery: deliveryStatus },
            client: context.client,
          });
          if (!emailAvailable) {
            await recordAudit(tx, {
              organizationId,
              actorUserId: auth.user.id,
              action: AUDIT_ACTIONS.invitationLinkShown,
              targetType: 'invitation',
              targetId: invitationId,
              metadata: { sendCount: 1, reason: 'email_not_configured' },
              client: context.client,
            });
          }
        });
      } catch (error) {
        // Dua undangan bersamaan untuk email yang sama: indeks unik parsial menolak yang kedua.
        if (
          isPgError(error, PG_ERROR_CODES.uniqueViolation, 'user_invitations_open_email_unique')
        ) {
          throw fieldError(
            'email',
            'Undangan untuk email ini masih berlaku. Kirim ulang dari daftar undangan bila perlu.',
            'CONFLICT',
          );
        }
        throw error;
      }

      if (emailAvailable) await enqueue(organizationId, invitationId, 1, context.log);
      const created = await findOpenInvitation(db, organizationId, invitationId);
      if (!created) throw new Error('Undangan baru tidak ditemukan');
      return {
        invitation: view(created, auth.user.role),
        link: emailAvailable ? null : buildTokenLink(appUrl, 'invitation', token),
      };
    },

    async resend(auth, invitationId, confirmation, context) {
      const organizationId = auth.organizationId;
      const current = await findOpenInvitation(db, organizationId, invitationId);
      if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      if (!canInviteRole(auth.user.role, current.role)) {
        await forbidRole(auth, 'resend', current.role, context.client);
      }
      await confirmIssuer(auth, confirmation, 'invitation.resend', context);
      await consumeInviteQuota(auth, current.email);

      const emailAvailable = await delivery.emailAvailable(db, organizationId);
      const { token, tokenHash } = issueLinkToken();
      const sendCount = current.sendCount + 1;
      const deliveryStatus: EmailDeliveryStatus = emailAvailable ? 'queued' : 'link';

      await db.transaction(async (tx) => {
        await assertStillIssuer(tx, auth, current.role, context.log);
        const updated = await reissueInvitation(tx, {
          organizationId,
          invitationId,
          expectedSendCount: current.sendCount,
          tokenHash,
          deliveryStatus,
          deliveryTokenEncrypted: emailAvailable
            ? delivery.sealInvitationToken(organizationId, invitationId, sendCount, token)
            : null,
          actorUserId: auth.user.id,
          sessionRef: auth.sessionRef,
        });
        if (!updated) {
          throw new AppError('CONFLICT', {
            message: 'Undangan ini baru saja berubah. Muat ulang daftar undangan, lalu coba lagi.',
          });
        }
        await recordAudit(tx, {
          organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.invitationResent,
          targetType: 'invitation',
          targetId: invitationId,
          metadata: { sendCount, delivery: deliveryStatus, wasExpired: current.expired },
          client: context.client,
        });
        if (!emailAvailable) {
          await recordAudit(tx, {
            organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.invitationLinkShown,
            targetType: 'invitation',
            targetId: invitationId,
            metadata: { sendCount, reason: 'email_not_configured' },
            client: context.client,
          });
        }
      });

      if (emailAvailable) await enqueue(organizationId, invitationId, sendCount, context.log);
      const reissued = await findOpenInvitation(db, organizationId, invitationId);
      if (!reissued) throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      return {
        invitation: view(reissued, auth.user.role),
        link: emailAvailable ? null : buildTokenLink(appUrl, 'invitation', token),
      };
    },

    async revoke(auth, invitationId, context) {
      const organizationId = auth.organizationId;
      const current = await findOpenInvitation(db, organizationId, invitationId);
      if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      if (!canInviteRole(auth.user.role, current.role)) {
        await forbidRole(auth, 'revoke', current.role, context.client);
      }
      await db.transaction(async (tx) => {
        if (!(await revokeInvitation(tx, organizationId, invitationId, auth.user.id))) {
          throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
        }
        await recordAudit(tx, {
          organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.invitationRevoked,
          targetType: 'invitation',
          targetId: invitationId,
          metadata: { email: current.email, role: current.role, wasExpired: current.expired },
          client: context.client,
        });
      });
    },

    async inspect(token, context) {
      const { row, ipKey } = await publicLookup(token, context);
      await limiter.refund(PUBLIC_TOKEN_IP_RULE, ipKey);
      return {
        email: row.email,
        role: row.role,
        organizationName: row.organization.name,
        productName: row.organization.productName ?? DEFAULT_PRODUCT_NAME,
        invitedByName: row.inviterName,
        expiresAt: row.expiresAt.toISOString(),
        twoFactorRequired: isTwoFactorRequired(row.role),
      };
    },

    async accept(input, context) {
      const { row, tokenHash, ipKey } = await publicLookup(input.token, context);
      // Token sah: bukan percobaan yang perlu dihitung per IP (isian salah boleh diulang).
      await limiter.refund(PUBLIC_TOKEN_IP_RULE, ipKey);
      const organization = row.organization;

      const verdict = checkPassword(input.password, {
        email: row.email,
        name: input.name,
        organizationName: organization.name,
        productName: organization.productName ?? DEFAULT_PRODUCT_NAME,
      });
      if (!verdict.acceptable) throw fieldError('password', verdict.message, 'VALIDATION_ERROR');
      if (await isEmailRegistered(db, organization.id, row.email)) {
        throw invalid('Email ini sudah punya akun. Masuk dengan email dan password-mu.');
      }

      // Hashing (mahal) di luar transaksi.
      const passwordHash = await hasher.hash(input.password);
      const previous = context.presentedToken
        ? await findActiveSession(db, sha256Hex(context.presentedToken))
        : undefined;
      // Tautan sampai lewat email = email terbukti milik penerima. Tautan yang disalin manual
      // (email pengirim belum diatur) tidak membuktikan apa-apa tentang alamat itu.
      const emailVerified = row.deliveryStatus === 'sent';

      let issued: IssuedSession;
      let acceptedAuditLogId = '';
      try {
        issued = await db.transaction(async (tx) => {
          const [user] = await tx
            .insert(users)
            .values({
              organizationId: organization.id,
              email: row.email,
              name: input.name,
              passwordHash,
              role: row.role,
              emailVerifiedAt: emailVerified ? sql`now()` : null,
              lastLoginAt: sql`now()`,
              // Peran wajib 2FA: 72 jam untuk mendaftarkan 2FA (review undangan R3).
              twoFactorEnrollmentDueAt: enrollmentDueAtValue(row.role, false),
            })
            .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
          if (!user) throw new Error('Pengguna baru tidak tersimpan');
          const marked = await markInvitationAccepted(tx, {
            organizationId: organization.id,
            invitationId: row.id,
            tokenHash,
            userId: user.id,
          });
          // Permintaan lain menerima/membatalkan/mengirim ulang lebih dulu: batalkan semuanya.
          if (!marked) throw invalidFor('unknown');
          if (previous) await sessions.revoke(tx, previous.organizationId, previous.id);

          acceptedAuditLogId = await recordAudit(tx, {
            organizationId: organization.id,
            actorUserId: user.id,
            action: AUDIT_ACTIONS.invitationAccepted,
            targetType: 'invitation',
            targetId: row.id,
            metadata: {
              userRef: user.id,
              role: user.role,
              emailVerified,
              // Kejadian `member_joined` di ringkasan keamanan + email ke semua Owner.
              issuerRef: row.issuer.id,
              issuerRole: row.issuer.role,
            },
            client: context.client,
          });
          const session = await sessions.issue(tx, {
            user,
            organization: {
              id: organization.id,
              name: organization.name,
              timezone: organization.timezone,
            },
            client: context.client,
            // Akun baru belum punya 2FA → peran wajib mendapat sesi TERBATAS (hanya daftar 2FA).
            twoFactorEnabled: false,
            twoFactorVerified: false,
          });
          await recordAudit(tx, {
            organizationId: organization.id,
            actorUserId: user.id,
            action: AUDIT_ACTIONS.loginSucceeded,
            targetType: 'session',
            targetId: session.auth.sessionRef,
            metadata: {
              via: 'invitation',
              replacedPreviousSession: previous !== undefined,
              ...(session.auth.twoFactor.enrollmentRequired
                ? { twoFactorEnrollmentRequired: true }
                : {}),
            },
            client: context.client,
          });
          return session;
        });
      } catch (error) {
        if (
          isPgError(error, PG_ERROR_CODES.uniqueViolation, 'users_organization_id_email_unique')
        ) {
          throw invalid('Email ini sudah punya akun. Masuk dengan email dan password-mu.');
        }
        throw error;
      }

      notifyOwnersOfNewMember(
        organization.id,
        issued.auth.user.id,
        row.issuer.id,
        acceptedAuditLogId,
        context.log,
      );
      return {
        ...issued,
        // Cookie perangkat dikenal hanya setelah SEMUA langkah masuk selesai (peran wajib 2FA:
        // diterbitkan saat 2FA-nya aktif).
        deviceToken: issued.auth.twoFactor.enrollmentRequired
          ? undefined
          : devices.issue(issued.auth.user.id),
      };
    },
  };
}
