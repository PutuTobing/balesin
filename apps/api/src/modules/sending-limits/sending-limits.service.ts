import {
  AppError,
  NOOP_INBOX_EVENT_PUBLISHER,
  type InboxEventPublisher,
  type Logger,
} from '@balesin/core';
import {
  apiKeys,
  emailOutbound,
  mailOutbox,
  messages,
  organizations,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import type {
  IdentityConfirmation,
  PauseSendingRequest,
  SendingLimits,
  UpdateSendingLimitsRequest,
} from '@balesin/shared';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

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
  /** Event `sending.changed` saat rem ditarik/dilepas (banner inbox semua agen, butir 10). */
  publisher?: InboxEventPublisher;
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
  /** Rem darurat sedang ditarik (untuk banner semua agen, tanpa rincian). */
  paused(organizationId: string): Promise<boolean>;
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
    /** Agen pengirim; `null` = pesan lewat API key (lihat `apiKey`). */
    userId: string | null;
    /** Pesan lewat API publik: batas harian PER KEY menggantikan batas per pengguna (Fase 3). */
    apiKey?: { id: string; dailySendLimit: number };
    /**
     * Percakapan tujuan. `null` = pemeriksaan AWAL sebelum percakapan ada (mulai percakapan, review
     * template R1): rem darurat + batas harian saja, batas per percakapan tidak dihitung.
     */
    conversationId: string | null;
    client: ClientInfo;
    /**
     * Review 9.0 S1: jumlah penerima pesan BARU ini (1 + Cc + Bcc email; bawaan 1). Batas harian
     * pengguna/organisasi/key ditolak bila hitungan + penerima melewati batas.
     */
    recipients?: number;
  }): Promise<void>;
  /**
   * Tahap 9.1 — email lewat API: rem darurat (423) + batas harian KEY (pesan + email lewat key yang
   * sama dijumlah, 1 email = 1). Batas harian organisasi (WhatsApp) & per percakapan tidak berlaku.
   */
  assertCanSendEmail(input: {
    organizationId: string;
    apiKey: { id: string; dailySendLimit: number };
    client: ClientInfo;
    /**
     * Review 9.1 S2: jumlah penerima email baru (Kepada + Cc + Bcc setelah digabung). Ditolak bila
     * hitungan 24 jam + penerima baru > batas harian key.
     */
    recipients: number;
  }): Promise<void>;
  /**
   * Tahap 9B — email menu Email: rem darurat (423) + SATU batas harian pengguna (pesan Inbox +
   * penerima email menu Email, 24 jam bergulir). Batas harian organisasi tidak menghitung email.
   */
  assertCanSendMail(input: {
    organizationId: string;
    userId: string;
    client: ClientInfo;
    /** Kepada + Cc + Bcc setelah digabung. */
    recipients: number;
    /**
     * Review 9B R2: transaksi penyisip outbox. Bila diisi, kunci advisory per pengguna
     * (`mail-daily:<org>:<user>`) diambil di transaksi itu SEBELUM menghitung, sehingga kirim paralel
     * dihitung berurutan (hitungan melihat outbox yang sudah di-commit pengirim sebelumnya).
     */
    executor?: DbExecutor;
  }): Promise<void>;
}

/**
 * Pesan Inbox yang hanya CATATAN email lewat API (`conversation: "create"`/balasan API) tidak
 * dihitung sebagai pesan keluar WhatsApp/channel: emailnya sendiri yang dihitung (batas key), dan
 * batas harian organisasi tidak menghitung email (DECISIONS 9.1 #4).
 */
const NOT_EMAIL_API_RECORD = sql`not exists (select 1 from ${emailOutbound} where ${emailOutbound.messageId} = ${messages.id})`;

/** Jumlah penerima satu pesan keluar: 1 + tembusan email (`extras.email.cc`/`bcc`). */
const OUTBOUND_RECIPIENTS = sql`(1
  + case when jsonb_typeof(${messages.extras} -> 'email' -> 'cc') = 'array'
      then jsonb_array_length(${messages.extras} -> 'email' -> 'cc') else 0 end
  + case when jsonb_typeof(${messages.extras} -> 'email' -> 'bcc') = 'array'
      then jsonb_array_length(${messages.extras} -> 'email' -> 'bcc') else 0 end)`;

async function countOutbound(
  db: DbExecutor,
  organizationId: string,
  since: Date,
  senderUserId?: string,
  apiKeyId?: string,
): Promise<number> {
  // Review 9.0 S1: email ber-Cc/Bcc dihitung per PENERIMA (1 + Cc + Bcc), bukan per baris pesan.
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${OUTBOUND_RECIPIENTS}), 0)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.direction, 'outbound'),
        gt(messages.createdAt, since),
        senderUserId === undefined ? undefined : eq(messages.senderUserId, senderUserId),
        apiKeyId === undefined ? undefined : eq(messages.apiKeyId, apiKeyId),
        senderUserId === undefined ? NOT_EMAIL_API_RECORD : undefined,
      ),
    );
  const messageCount = Number(row?.total ?? 0);
  if (senderUserId !== undefined && apiKeyId === undefined) {
    // 9B: email menu Email milik pengguna ini (per penerima) ikut batas harian pengguna.
    const [mail] = await db
      .select({ total: sql<number>`coalesce(sum(${mailOutbox.recipientCount}), 0)::int` })
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.organizationId, organizationId),
          eq(mailOutbox.createdByUserId, senderUserId),
          sql`${mailOutbox.status} in ('pending', 'queued', 'sending', 'sent', 'delivery_unknown')`,
          gt(mailOutbox.createdAt, since),
        ),
      );
    return messageCount + Number(mail?.total ?? 0);
  }
  if (apiKeyId === undefined) return messageCount;
  // Batas harian per key = penerima pesan + penerima email lewat key yang sama (tahap 9.1,
  // review 9.1 S2: email dihitung PER PENERIMA, bukan per email).
  const [emails] = await db
    .select({ total: sql<number>`coalesce(sum(${emailOutbound.recipientCount}), 0)::int` })
    .from(emailOutbound)
    .where(
      and(
        eq(emailOutbound.organizationId, organizationId),
        eq(emailOutbound.apiKeyId, apiKeyId),
        eq(emailOutbound.source, 'api'),
        gt(emailOutbound.createdAt, since),
      ),
    );
  return messageCount + Number(emails?.total ?? 0);
}

export function createSendingLimitsService(deps: SendingLimitsServiceDeps): SendingLimitsService {
  const { db, limiter, notifier, twoFactor, logger } = deps;
  const publisher = deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER;
  const sendingChanged = (organizationId: string) =>
    publisher.publish([{ type: 'sending.changed', organizationId }]);
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
    scope: 'user' | 'organization' | 'api_key',
    sender: { userId: string | null; apiKeyId: string | null },
    limit: number,
    sent: number,
    client: ClientInfo,
  ): Promise<never> {
    const key =
      scope === 'user'
        ? `${organizationId}:user:${sender.userId ?? ''}`
        : scope === 'api_key'
          ? `${organizationId}:key:${sender.apiKeyId ?? ''}`
          : `${organizationId}:org`;
    const first = await limiter
      .claimFlag(LIMIT_FLAG, key, SENDING_DAY_MS / 1000)
      .catch(() => false);
    if (first) {
      // Batas per API key: Owner diberi tahu atas nama PEMBUAT key + nama key (review API publik R2).
      const [key] = sender.apiKeyId
        ? await db
            .select({ name: apiKeys.name, createdByUserId: apiKeys.createdByUserId })
            .from(apiKeys)
            .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, sender.apiKeyId)))
        : [];
      const auditLogId = await recordAudit(db, {
        organizationId,
        // Pesan lewat API key: pelaku = key (bukan pengguna), lihat `apiKeyId`.
        actorUserId: sender.userId,
        action: AUDIT_ACTIONS.sendingLimitReached,
        ...(sender.apiKeyId && !sender.userId
          ? { targetType: 'api_key' as const, targetId: sender.apiKeyId }
          : sender.userId
            ? { targetType: 'user' as const, targetId: sender.userId }
            : {}),
        metadata: {
          scope,
          limit,
          sent,
          ...(sender.apiKeyId ? { apiKeyId: sender.apiKeyId } : {}),
          ...(key ? { apiKeyName: key.name } : {}),
        },
        client,
      });
      const subjectUserId = sender.userId ?? key?.createdByUserId ?? null;
      if (subjectUserId) {
        await notifyOwners(organizationId, 'sending_limit_reached', subjectUserId, auditLogId);
      }
    }
    throw new AppError('RATE_LIMITED', {
      message:
        scope === 'user'
          ? `Batas kirim harianmu (${limit.toLocaleString('id-ID')} pesan per 24 jam) sudah tercapai. Hubungi Owner/Admin bila perlu dinaikkan.`
          : scope === 'api_key'
            ? `Batas kirim harian API key ini (${limit.toLocaleString('id-ID')} pesan per 24 jam) sudah tercapai.`
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
        await sendingChanged(auth.organizationId);
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
      let resumed = false;
      const result = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.resume');
        const updated = await tx
          .update(organizations)
          .set({ sendingPausedAt: null, sendingPausedByUserId: null, sendingPauseReason: null })
          .where(
            and(
              eq(organizations.id, auth.organizationId),
              isNotNull(organizations.sendingPausedAt),
            ),
          )
          .returning({ id: organizations.id });
        if (updated.length > 0) {
          resumed = true;
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
      if (resumed) await sendingChanged(auth.organizationId);
      return result;
    },

    async paused(organizationId) {
      const [org] = await db
        .select({ pausedAt: organizations.sendingPausedAt })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      return Boolean(org?.pausedAt);
    },

    async assertCanSendEmail({ organizationId, apiKey, client, recipients }) {
      const [org] = await db
        .select({ pausedAt: organizations.sendingPausedAt })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      if (!org) throw new AppError('NOT_FOUND');
      if (org.pausedAt) throw new AppError('SENDING_PAUSED');
      const since = new Date(now().getTime() - SENDING_DAY_MS);
      const viaKey = await countOutbound(db, organizationId, since, undefined, apiKey.id);
      if (viaKey + Math.max(1, recipients) > apiKey.dailySendLimit) {
        await limitReached(
          organizationId,
          'api_key',
          { userId: null, apiKeyId: apiKey.id },
          apiKey.dailySendLimit,
          viaKey,
          client,
        );
      }
    },

    async assertCanSendMail({ organizationId, userId, client, recipients, executor }) {
      if (executor) {
        await executor.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`mail-daily:${organizationId}:${userId}`}, 0))`,
        );
      }
      const reader = executor ?? db;
      const [org] = await reader
        .select({
          pausedAt: organizations.sendingPausedAt,
          perUser: organizations.sendDailyLimitPerUser,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      if (!org) throw new AppError('NOT_FOUND');
      if (org.pausedAt) throw new AppError('SENDING_PAUSED');
      const since = new Date(now().getTime() - SENDING_DAY_MS);
      const mine = await countOutbound(reader, organizationId, since, userId);
      if (mine + Math.max(1, recipients) > org.perUser) {
        await limitReached(
          organizationId,
          'user',
          { userId, apiKeyId: null },
          org.perUser,
          mine,
          client,
        );
      }
    },

    async assertCanSend({
      organizationId,
      userId,
      apiKey,
      conversationId,
      client,
      recipients = 1,
    }) {
      // `hitungan + penerima > batas` ⇔ `hitungan + (penerima - 1) >= batas` (penerima 1 = perilaku lama).
      const extra = Math.max(0, recipients - 1);
      const sender = { userId, apiKeyId: apiKey?.id ?? null };
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
      if (apiKey) {
        const viaKey = await countOutbound(db, organizationId, since, undefined, apiKey.id);
        if (viaKey + extra >= apiKey.dailySendLimit) {
          await limitReached(
            organizationId,
            'api_key',
            sender,
            apiKey.dailySendLimit,
            viaKey,
            client,
          );
        }
      } else if (userId) {
        const mine = await countOutbound(db, organizationId, since, userId);
        if (mine + extra >= org.perUser) {
          await limitReached(organizationId, 'user', sender, org.perUser, mine, client);
        }
      }
      const all = await countOutbound(db, organizationId, since);
      if (all + extra >= org.perOrganization) {
        await limitReached(
          organizationId,
          'organization',
          sender,
          org.perOrganization,
          all,
          client,
        );
      }
      if (conversationId === null) return;
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
