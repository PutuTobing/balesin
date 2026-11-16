import { AppError, type Logger } from '@balesin/core';
import { messages, organizations, users, type Database, type DbExecutor } from '@balesin/db';
import type {
  IdentityConfirmation,
  PauseSendingRequest,
  SendingLimits,
  UpdateSendingLimitsRequest,
} from '@balesin/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';

/**
 * Rem pengiriman pesan keluar (SECURITY.md §5, review ruang chat S2; docs/KONTRAK-API-INBOX.md
 * "Batas kirim & rem darurat").
 *
 * `assertCanSend` dipanggil SETIAP kirim/kirim ulang (api) — urutannya: rem darurat → batas harian
 * pengguna (24 jam bergulir, dari tabel `messages`) → batas harian organisasi → batas per
 * percakapan per menit (Redis). Worker memeriksa rem darurat lagi sesaat sebelum memanggil Meta,
 * jadi antrean ikut berhenti seketika.
 *
 * Batas harian tercapai → audit `sending.limit_reached` + email ke semua Owner, paling banyak SEKALI
 * per 24 jam per cakupan (penanda Redis), lalu 429.
 */

export const SENDING_DAY_MS = 24 * 60 * 60 * 1000;
const LIMIT_FLAG = 'batas-kirim-harian';

export interface SendingLimitsServiceDeps {
  db: Database;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  logger: Logger;
  now?: () => Date;
}

export interface SendingLimitsContext extends TwoFactorContext {
  client: ClientInfo;
}

export interface SendingLimitsService {
  get(organizationId: string): Promise<SendingLimits>;
  update(
    auth: AuthContext,
    input: UpdateSendingLimitsRequest,
    context: SendingLimitsContext,
  ): Promise<SendingLimits>;
  pause(
    auth: AuthContext,
    input: PauseSendingRequest,
    context: SendingLimitsContext,
  ): Promise<SendingLimits>;
  resume(
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    context: SendingLimitsContext,
  ): Promise<SendingLimits>;
  /** Lempar 423 `SENDING_PAUSED` / 429 bila pesan baru dari pengguna ini ke percakapan ini ditolak. */
  assertCanSend(input: {
    organizationId: string;
    userId: string;
    conversationId: string;
    client: ClientInfo;
  }): Promise<void>;
}

async function countOutbound(
  db: DbExecutor,
  organizationId: string,
  since: Date,
  senderUserId?: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.direction, 'outbound'),
        gt(messages.createdAt, since),
        senderUserId === undefined ? undefined : eq(messages.senderUserId, senderUserId),
      ),
    );
  return Number(row?.total ?? 0);
}

export function createSendingLimitsService(deps: SendingLimitsServiceDeps): SendingLimitsService {
  const { db, limiter, notifier, twoFactor, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(executor: DbExecutor, organizationId: string): Promise<SendingLimits> {
    const [row] = await executor
      .select({
        dailyPerUser: organizations.sendDailyLimitPerUser,
        dailyPerOrganization: organizations.sendDailyLimitPerOrganization,
        perConversationPerMinute: organizations.sendPerConversationPerMinute,
        pausedAt: organizations.sendingPausedAt,
        pausedBy: organizations.sendingPausedByUserId,
        pauseReason: organizations.sendingPauseReason,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!row) throw new AppError('NOT_FOUND');
    let by: { id: string; name: string } | null = null;
    if (row.pausedBy) {
      const [user] = await executor
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), eq(users.id, row.pausedBy)));
      by = user ?? null;
    }
    return {
      dailyPerUser: row.dailyPerUser,
      dailyPerOrganization: row.dailyPerOrganization,
      perConversationPerMinute: row.perConversationPerMinute,
      paused: row.pausedAt ? { at: row.pausedAt.toISOString(), by, reason: row.pauseReason } : null,
      sentLast24Hours: await countOutbound(
        executor,
        organizationId,
        new Date(now().getTime() - SENDING_DAY_MS),
      ),
    };
  }

  /** Email ke semua Owner aktif (subjek = pengguna terkait kejadian). Gagal antre = log saja. */
  async function notifyOwners(
    organizationId: string,
    event: 'sending_paused' | 'sending_limit_reached',
    subjectUserId: string,
    auditLogId: string,
  ) {
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
    const occurredAt = now().toISOString();
    for (const owner of owners) {
      await notifier
        .securityNoticeAdmin({
          organizationId,
          recipientUserId: owner.id,
          subjectUserId,
          event,
          occurredAt,
          auditLogId,
        })
        .catch((err: unknown) => {
          logger.warn({ err, event }, 'Gagal mengantre email rem pengiriman ke Owner');
        });
    }
  }

  async function limitReached(
    organizationId: string,
    scope: 'user' | 'organization',
    userId: string,
    limit: number,
    sent: number,
    client: ClientInfo,
  ): Promise<never> {
    const key = scope === 'user' ? `${organizationId}:user:${userId}` : `${organizationId}:org`;
    const first = await limiter
      .claimFlag(LIMIT_FLAG, key, SENDING_DAY_MS / 1000)
      .catch(() => false);
    if (first) {
      const auditLogId = await recordAudit(db, {
        organizationId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.sendingLimitReached,
        targetType: 'user',
        targetId: userId,
        metadata: { scope, limit, sent },
        client,
      });
      await notifyOwners(organizationId, 'sending_limit_reached', userId, auditLogId);
    }
    throw new AppError('RATE_LIMITED', {
      message:
        scope === 'user'
          ? `Batas kirim harianmu (${limit.toLocaleString('id-ID')} pesan per 24 jam) sudah tercapai. Hubungi Owner/Admin bila perlu dinaikkan.`
          : `Batas kirim harian organisasi (${limit.toLocaleString('id-ID')} pesan per 24 jam) sudah tercapai. Hubungi Owner/Admin.`,
      retryAfterSeconds: 60 * 60,
    });
  }

  return {
    get: (organizationId) => load(db, organizationId),

    async update(auth, input, context) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        input.confirmation,
        'sending_limits.update',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengubah batas kirim.',
      );
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.limits.manage');
        const before = await load(tx, auth.organizationId);
        await tx
          .update(organizations)
          .set({
            sendDailyLimitPerUser: input.dailyPerUser,
            sendDailyLimitPerOrganization: input.dailyPerOrganization,
            sendPerConversationPerMinute: input.perConversationPerMinute,
          })
          .where(eq(organizations.id, auth.organizationId));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.sendingLimitsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: {
            change: 'limits',
            previous: {
              dailyPerUser: before.dailyPerUser,
              dailyPerOrganization: before.dailyPerOrganization,
              perConversationPerMinute: before.perConversationPerMinute,
            },
            dailyPerUser: input.dailyPerUser,
            dailyPerOrganization: input.dailyPerOrganization,
            perConversationPerMinute: input.perConversationPerMinute,
            actorRole: role,
          },
          client: context.client,
        });
        return load(tx, auth.organizationId);
      });
    },

    async pause(auth, input, context) {
      let auditLogId: string | null = null;
      const result = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.limits.manage');
        const updated = await tx
          .update(organizations)
          .set({
            sendingPausedAt: now(),
            sendingPausedByUserId: auth.user.id,
            sendingPauseReason: input.reason?.trim() || null,
          })
          .where(
            and(eq(organizations.id, auth.organizationId), isNull(organizations.sendingPausedAt)),
          )
          .returning({ id: organizations.id });
        if (updated.length > 0) {
          auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.sendingPaused,
            targetType: 'organization',
            targetId: auth.organizationId,
            metadata: { reason: input.reason?.trim() || null, actorRole: role },
            client: context.client,
          });
        }
        return load(tx, auth.organizationId);
      });
      if (auditLogId) {
        logger.warn(
          { organizationId: auth.organizationId, actorRef: auth.user.id },
          'Rem darurat pengiriman ditarik',
        );
        await notifyOwners(auth.organizationId, 'sending_paused', auth.user.id, auditLogId);
      }
      return result;
    },

    async resume(auth, confirmation, context) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'sending.resume',
        context,
        'Masukkan password (dan kode verifikasi) untuk melanjutkan pengiriman.',
      );
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.resume');
        const updated = await tx
          .update(organizations)
          .set({ sendingPausedAt: null, sendingPausedByUserId: null, sendingPauseReason: null })
          .where(eq(organizations.id, auth.organizationId))
          .returning({ id: organizations.id });
        if (updated.length > 0) {
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.sendingResumed,
            targetType: 'organization',
            targetId: auth.organizationId,
            metadata: { change: 'resumed', actorRole: role },
            client: context.client,
          });
        }
        return load(tx, auth.organizationId);
      });
    },

    async assertCanSend({ organizationId, userId, conversationId, client }) {
      const [org] = await db
        .select({
          pausedAt: organizations.sendingPausedAt,
          perUser: organizations.sendDailyLimitPerUser,
          perOrganization: organizations.sendDailyLimitPerOrganization,
          perConversation: organizations.sendPerConversationPerMinute,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      if (!org) throw new AppError('NOT_FOUND');
      if (org.pausedAt) throw new AppError('SENDING_PAUSED');
      const since = new Date(now().getTime() - SENDING_DAY_MS);
      const mine = await countOutbound(db, organizationId, since, userId);
      if (mine >= org.perUser) {
        await limitReached(organizationId, 'user', userId, org.perUser, mine, client);
      }
      const all = await countOutbound(db, organizationId, since);
      if (all >= org.perOrganization) {
        await limitReached(
          organizationId,
          'organization',
          userId,
          org.perOrganization,
          all,
          client,
        );
      }
      await enforceRateLimit(
        limiter,
        { name: 'kirim-percakapan', limit: org.perConversation, windowSeconds: 60 },
        conversationId,
        (wait) =>
          `Terlalu banyak pesan ke pelanggan ini dalam waktu singkat. Coba lagi dalam ${wait}.`,
      );
    },
  };
}
