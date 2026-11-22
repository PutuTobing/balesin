import { AppError, type Logger } from '@balesin/core';
import {
  apiKeys,
  channels,
  emailOutbound,
  emailSenderSettings,
  emailTemplates,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  EMAIL_HOURLY_LIMIT_DEFAULT,
  EMAIL_OUTBOUND_PAGE_DEFAULT,
  emailSenderId,
  maskEmailAddress,
  parseEmailSenderId,
  type EmailOutboundEntry,
  type EmailOutboundListQuery,
  type EmailOutboundStatus,
  type EmailSenderSettings,
  type IdentityConfirmation,
} from '@balesin/shared';
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { failureOf } from './email-send.service';
import {
  blockedReasonOf,
  loadChannelSenders,
  senderState,
  senderStats,
  type ChannelSender,
} from './senders';

/**
 * Pengaturan → Batas kirim → "Email per pengirim" (tahap 9.1, §8.1) + Pengaturan → API key →
 * "Email terkirim" (§8.3). Lihat/ubah batas/jeda = `sending.limits.manage`; lanjutkan (juga melepas
 * `blocked`/`throttled`) = `sending.resume` + konfirmasi; menaikkan batas = konfirmasi + email Owner
 * bila oleh Admin. Riwayat: penerima TERSAMAR, tanpa isi/lampiran.
 */

export interface EmailSendersService {
  list(organizationId: string): Promise<EmailSenderSettings[]>;
  updateLimit(
    auth: AuthContext,
    senderId: string,
    input: { hourlyLimit: number; confirmation?: IdentityConfirmation },
    context: TwoFactorContext,
  ): Promise<EmailSenderSettings>;
  pause(
    auth: AuthContext,
    senderId: string,
    reason: string | undefined,
    client: ClientInfo,
  ): Promise<EmailSenderSettings>;
  resume(
    auth: AuthContext,
    senderId: string,
    confirmation: IdentityConfirmation | undefined,
    context: TwoFactorContext,
  ): Promise<EmailSenderSettings>;
  history(
    organizationId: string,
    query: EmailOutboundListQuery,
  ): Promise<{ emails: EmailOutboundEntry[]; nextCursor: string | null }>;
}

const SENDER_NOT_FOUND = 'Pengirim email tidak ditemukan.';

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

function decodeCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      return null;
    }
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(parsed[1])) return null;
    return { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
}

export function createEmailSendersService(deps: {
  db: Database;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifier: EmailNotifier;
  logger: Logger;
  now?: () => Date;
}): EmailSendersService {
  const { db, twoFactor, notifier, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function views(executor: DbExecutor, organizationId: string, senders: ChannelSender[]) {
    const at = now();
    const stats = await senderStats(
      executor,
      organizationId,
      senders.map((sender) => sender.channelId),
      at,
    );
    const pausers = [
      ...new Set(
        [...stats.values()]
          .map((stat) => stat.settings?.pausedByUserId ?? null)
          .filter((id): id is string => id !== null),
      ),
    ];
    const people =
      pausers.length === 0
        ? []
        : await executor
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(and(eq(users.organizationId, organizationId), inArray(users.id, pausers)));
    return senders.map((sender): EmailSenderSettings => {
      const stat = stats.get(sender.channelId);
      const settings = stat?.settings ?? null;
      const state = senderState(sender, settings, at);
      const paused = settings?.state === 'paused';
      return {
        id: sender.id,
        kind: 'channel',
        name: sender.name,
        address: sender.address,
        smtpMode: sender.smtpMode,
        hourlyLimit: stat?.hourlyLimit ?? EMAIL_HOURLY_LIMIT_DEFAULT,
        sentLastHour: stat?.sentLastHour ?? 0,
        queued: stat?.queued ?? 0,
        state: state.state,
        throttledUntil: state.throttledUntil,
        blockedReason: blockedReasonOf(settings),
        pausedBy:
          paused && settings.pausedByUserId
            ? (people.find((person) => person.id === settings.pausedByUserId) ?? null)
            : null,
        pausedAt: paused ? (settings.pausedAt?.toISOString() ?? null) : null,
      };
    });
  }

  async function one(executor: DbExecutor, organizationId: string, senderId: string) {
    const parsed = parseEmailSenderId(senderId);
    if (!parsed || parsed.kind !== 'channel') {
      throw new AppError('NOT_FOUND', { message: SENDER_NOT_FOUND });
    }
    const [sender] = await loadChannelSenders(executor, organizationId, [parsed.id]);
    if (!sender) throw new AppError('NOT_FOUND', { message: SENDER_NOT_FOUND });
    return sender;
  }

  async function settingsRow(executor: DbExecutor, organizationId: string, channelId: string) {
    const [row] = await executor
      .select()
      .from(emailSenderSettings)
      .where(
        and(
          eq(emailSenderSettings.organizationId, organizationId),
          eq(emailSenderSettings.channelId, channelId),
        ),
      )
      .for('update')
      .limit(1);
    return row;
  }

  /** Baris pengaturan dibuat malas (tanpa baris = `ok`, 100/jam). */
  async function upsert(
    executor: DbExecutor,
    organizationId: string,
    channelId: string,
    set: Partial<typeof emailSenderSettings.$inferInsert>,
  ) {
    await executor
      .insert(emailSenderSettings)
      .values({ organizationId, senderKind: 'channel', channelId, ...set })
      .onConflictDoUpdate({ target: emailSenderSettings.channelId, set });
  }

  async function notifyOwnersLimitRaised(
    organizationId: string,
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
          event: 'email_sender_limit_raised',
          occurredAt,
          auditLogId,
        })
        .catch((err: unknown) => {
          logger.warn({ err }, 'Gagal mengantre email batas pengirim email ke Owner');
        });
    }
  }

  return {
    async list(organizationId) {
      return views(db, organizationId, await loadChannelSenders(db, organizationId));
    },

    async updateLimit(auth, senderId, input, context) {
      const sender = await one(db, auth.organizationId, senderId);
      const [current] = await db
        .select({ hourlyLimit: emailSenderSettings.hourlyLimit })
        .from(emailSenderSettings)
        .where(
          and(
            eq(emailSenderSettings.organizationId, auth.organizationId),
            eq(emailSenderSettings.channelId, sender.channelId),
          ),
        )
        .limit(1);
      const raising = input.hourlyLimit > (current?.hourlyLimit ?? EMAIL_HOURLY_LIMIT_DEFAULT);
      // Menaikkan = arah berisiko (konfirmasi identitas); menurunkan = arah aman.
      if (raising) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'email_sender_limit.raise',
          context,
          'Masukkan password (dan kode verifikasi) untuk menaikkan batas email per jam.',
        );
      }
      let notify: { auditLogId: string } | null = null;
      const result = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.limits.manage');
        const row = await settingsRow(tx, auth.organizationId, sender.channelId);
        const previous = row?.hourlyLimit ?? EMAIL_HOURLY_LIMIT_DEFAULT;
        if (previous !== input.hourlyLimit) {
          if (input.hourlyLimit > previous && !raising) {
            // Batas naik bersamaan antara baca & tulis: ulangi dengan konfirmasi.
            throw new AppError('CONFLICT', { message: 'Batas baru saja berubah. Muat ulang.' });
          }
          await upsert(tx, auth.organizationId, sender.channelId, {
            hourlyLimit: input.hourlyLimit,
            updatedByUserId: auth.user.id,
          });
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.emailSenderLimitUpdated,
            targetType: 'email_sender',
            targetId: sender.channelId,
            metadata: {
              senderId: sender.id,
              address: sender.address,
              previous,
              next: input.hourlyLimit,
              actorRole: role,
            },
            client: context.client,
          });
          if (input.hourlyLimit > previous && role !== 'owner') notify = { auditLogId };
        }
        const [view] = await views(tx, auth.organizationId, [sender]);
        if (!view) throw new AppError('NOT_FOUND', { message: SENDER_NOT_FOUND });
        return view;
      });
      const pending = notify as { auditLogId: string } | null;
      if (pending)
        await notifyOwnersLimitRaised(auth.organizationId, auth.user.id, pending.auditLogId);
      return result;
    },

    async pause(auth, senderId, reason, client) {
      const sender = await one(db, auth.organizationId, senderId);
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.limits.manage');
        const row = await settingsRow(tx, auth.organizationId, sender.channelId);
        if (row?.state !== 'paused') {
          await upsert(tx, auth.organizationId, sender.channelId, {
            state: 'paused',
            pausedByUserId: auth.user.id,
            pausedAt: now(),
            pauseReason: reason?.trim() || null,
            updatedByUserId: auth.user.id,
          });
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.emailSenderPaused,
            targetType: 'email_sender',
            targetId: sender.channelId,
            metadata: {
              senderId: sender.id,
              address: sender.address,
              reason: reason?.trim() || null,
              actorRole: role,
            },
            client,
          });
        }
        const [view] = await views(tx, auth.organizationId, [sender]);
        if (!view) throw new AppError('NOT_FOUND', { message: SENDER_NOT_FOUND });
        return view;
      });
    },

    async resume(auth, senderId, confirmation, context) {
      const sender = await one(db, auth.organizationId, senderId);
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'email_sender.resume',
        context,
        'Masukkan password (dan kode verifikasi) untuk melanjutkan pengirim email.',
      );
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.resume');
        const row = await settingsRow(tx, auth.organizationId, sender.channelId);
        if (row && row.state !== 'ok') {
          await tx
            .update(emailSenderSettings)
            .set({
              state: 'ok',
              throttledUntil: null,
              throttleStreak: 0,
              blockedReason: null,
              blockedAt: null,
              pausedByUserId: null,
              pausedAt: null,
              pauseReason: null,
              updatedByUserId: auth.user.id,
            })
            .where(eq(emailSenderSettings.id, row.id));
          // Email yang menunggu dicoba lagi sekarang (masih gagal → `blocked` lagi oleh worker).
          await tx
            .update(emailOutbound)
            .set({ nextAttemptAt: now() })
            .where(
              and(
                eq(emailOutbound.organizationId, auth.organizationId),
                eq(emailOutbound.channelId, sender.channelId),
                eq(emailOutbound.status, 'queued'),
              ),
            );
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.emailSenderResumed,
            targetType: 'email_sender',
            targetId: sender.channelId,
            metadata: {
              senderId: sender.id,
              address: sender.address,
              previousState: row.state,
              actorRole: role,
            },
            client: context.client,
          });
        }
        const [view] = await views(tx, auth.organizationId, [sender]);
        if (!view) throw new AppError('NOT_FOUND', { message: SENDER_NOT_FOUND });
        return view;
      });
    },

    async history(organizationId, query) {
      const limit = query.limit ?? EMAIL_OUTBOUND_PAGE_DEFAULT;
      const conditions: SQL[] = [eq(emailOutbound.organizationId, organizationId)];
      if (query.apiKeyId) conditions.push(eq(emailOutbound.apiKeyId, query.apiKeyId));
      if (query.senderId) {
        const parsed = parseEmailSenderId(query.senderId);
        if (!parsed) return { emails: [], nextCursor: null };
        conditions.push(eq(emailOutbound.channelId, parsed.id));
      }
      if (query.status) conditions.push(eq(emailOutbound.status, query.status));
      if (query.from) conditions.push(sql`${emailOutbound.createdAt} >= ${new Date(query.from)}`);
      if (query.to) conditions.push(sql`${emailOutbound.createdAt} < ${new Date(query.to)}`);
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        if (!cursor) {
          throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
        }
        conditions.push(
          or(
            lt(emailOutbound.createdAt, cursor.createdAt),
            and(eq(emailOutbound.createdAt, cursor.createdAt), lt(emailOutbound.id, cursor.id)),
          ) as SQL,
        );
      }
      const rows = await db
        .select({
          email: emailOutbound,
          apiKeyName: apiKeys.name,
          channelAddress: channels.emailAddress,
          templateSlug: emailTemplates.slug,
        })
        .from(emailOutbound)
        .leftJoin(
          apiKeys,
          and(
            eq(apiKeys.organizationId, emailOutbound.organizationId),
            eq(apiKeys.id, emailOutbound.apiKeyId),
          ),
        )
        .leftJoin(
          channels,
          and(
            eq(channels.organizationId, emailOutbound.organizationId),
            eq(channels.id, emailOutbound.channelId),
          ),
        )
        .leftJoin(
          emailTemplates,
          and(
            eq(emailTemplates.organizationId, emailOutbound.organizationId),
            eq(emailTemplates.id, emailOutbound.templateId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(emailOutbound.createdAt), desc(emailOutbound.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        emails: page.map(({ email, apiKeyName, channelAddress, templateSlug }) => ({
          id: email.id,
          status: email.status as EmailOutboundStatus,
          source: email.source as EmailOutboundEntry['source'],
          apiKey: email.apiKeyId && apiKeyName ? { id: email.apiKeyId, name: apiKeyName } : null,
          sender: {
            id: emailSenderId('channel', email.channelId ?? ''),
            kind: 'channel' as const,
            address: channelAddress ?? email.fromAddress,
          },
          // Bcc tidak ditampilkan; Kepada/Cc tersamar.
          recipients: [...email.to, ...email.cc].map((item) => maskEmailAddress(item.email)),
          recipientCount: email.recipientCount,
          subject: email.subject,
          template:
            email.templateId && templateSlug
              ? { id: email.templateId, slug: templateSlug, version: email.templateVersion }
              : null,
          metadata: email.metadata ?? null,
          createdAt: email.createdAt.toISOString(),
          sentAt: email.sentAt?.toISOString() ?? null,
          failure: failureOf(email),
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.email.createdAt, last.email.id) : null,
      };
    },
  };
}
