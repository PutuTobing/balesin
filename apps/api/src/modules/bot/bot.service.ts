import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  channels,
  conversationEvents,
  conversations,
  hasActiveBotReceiver,
  organizations,
  recordOutgoingEvent,
  type Database,
} from '@balesin/db';
import {
  BOT_TIMEOUT_DEFAULT_MINUTES,
  botHoursSchema,
  isWithinBotHours,
  type BotHours,
  type ChannelBotSettings,
  type channelBotSettingsResponseSchema,
} from '@balesin/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import type { NotificationEnqueuer } from '../../queues/notification-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Pengaturan bot per channel (Fase 3, docs/KONTRAK-API-INBOX.md "Bot") — semua jenis channel
 * (WhatsApp, Telegram, Email, Messenger, Instagram; DECISIONS 2026-11-19): saklar bot, jam kerja bot
 * (zona waktu organisasi), batas waktu bot. Izin `integrations.manage` (Owner/Admin — "Kelola
 * webhook, bot, dan integrasi"). Diaudit `channel.bot_updated` (tanpa data pelanggan). Berlaku untuk
 * percakapan BARU; percakapan yang sedang dipegang bot tetap sampai diserahkan/batas waktu.
 */

type BotSettingsView = z.infer<typeof channelBotSettingsResponseSchema>['settings'];

const NOT_FOUND = 'Channel tidak ditemukan.';

export interface BotService {
  channelSettings(organizationId: string, channelId: string): Promise<BotSettingsView>;
  updateChannelSettings(
    auth: AuthContext,
    channelId: string,
    input: ChannelBotSettings,
    client: ClientInfo,
  ): Promise<BotSettingsView>;
}

export function createBotService(deps: {
  db: Database;
  publisher?: InboxEventPublisher;
  notifications?: NotificationEnqueuer;
  now?: () => Date;
}): BotService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(organizationId: string, channelId: string) {
    const [row] = await db
      .select({
        channelType: channels.type,
        enabled: channels.botEnabled,
        hours: channels.botHours,
        timeoutMinutes: channels.botTimeoutMinutes,
        updatedAt: channels.botSettingsUpdatedAt,
        timezone: organizations.timezone,
      })
      .from(channels)
      .innerJoin(organizations, eq(organizations.id, channels.organizationId))
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
    // Isi jsonb rusak → dianggap 24 jam untuk tampilan (worker memperlakukannya di luar jam kerja).
    const parsed = botHoursSchema.safeParse(row.hours);
    const hours: BotHours = parsed.success ? parsed.data : { mode: 'always' };
    const at = now();
    return {
      enabled: row.enabled,
      hours,
      timeoutMinutes: row.timeoutMinutes,
      channelType: row.channelType,
      timezone: row.timezone,
      activeNow: row.enabled && parsed.success && isWithinBotHours(hours, row.timezone, at),
      receiverReady: await hasActiveBotReceiver(db, {
        organizationId,
        channelType: row.channelType,
        at,
      }),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

  return {
    channelSettings: load,

    async updateChannelSettings(auth, channelId, raw, client) {
      // Review bot R1: bot aktif selalu punya batas waktu (bawaan 15 menit).
      const input: ChannelBotSettings = {
        ...raw,
        timeoutMinutes:
          raw.enabled && raw.timeoutMinutes === null
            ? BOT_TIMEOUT_DEFAULT_MINUTES
            : raw.timeoutMinutes,
      };
      const released = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [current] = await tx
          .select({
            type: channels.type,
            enabled: channels.botEnabled,
            timeout: channels.botTimeoutMinutes,
          })
          .from(channels)
          .where(
            and(
              eq(channels.organizationId, auth.organizationId),
              eq(channels.id, channelId),
              isNull(channels.deletedAt),
            ),
          )
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
        await tx
          .update(channels)
          .set({
            botEnabled: input.enabled,
            botHours: input.hours,
            botTimeoutMinutes: input.timeoutMinutes,
            botSettingsUpdatedAt: now(),
          })
          .where(and(eq(channels.organizationId, auth.organizationId), eq(channels.id, channelId)));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelBotUpdated,
          targetType: 'channel',
          targetId: channelId,
          metadata: {
            channelType: current.type,
            enabled: input.enabled,
            previousEnabled: current.enabled,
            hoursMode: input.hours.mode,
            ...(input.hours.mode === 'schedule' ? { windows: input.hours.windows.length } : {}),
            timeoutMinutes: input.timeoutMinutes ?? 'tanpa',
            actorRole: role,
          },
          client,
        });
        if (input.enabled) return [];
        // Review bot R1: bot dimatikan → percakapan yang sedang dipegang bot diserahkan ke antrian
        // tim (kejadian `handoff` oleh pengguna ini + webhook + push) — tidak ada yang terjebak.
        const moved = await tx
          .update(conversations)
          .set({ status: 'unserved', assigneeUserId: null, botAwaitingSince: null })
          .where(
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.channelId, channelId),
              eq(conversations.status, 'bot'),
            ),
          )
          .returning({ id: conversations.id, contactId: conversations.contactId });
        for (const row of moved) {
          await tx.insert(conversationEvents).values({
            organizationId: auth.organizationId,
            conversationId: row.id,
            kind: 'handoff',
            actorUserId: auth.user.id,
          });
          await recordOutgoingEvent(tx, {
            organizationId: auth.organizationId,
            type: 'conversation.handoff',
            conversationId: row.id,
            contactId: row.contactId,
            actorUserId: auth.user.id,
          });
        }
        return moved;
      });
      if (released.length > 0) {
        await deps.publisher?.publish(
          released.map((row) => ({
            type: 'conversation.updated' as const,
            organizationId: auth.organizationId,
            conversationId: row.id,
          })),
        );
        for (const row of released) {
          await deps.notifications?.enqueue({
            organizationId: auth.organizationId,
            kind: 'queued',
            conversationId: row.id,
            actorUserId: auth.user.id,
          });
        }
      }
      return load(auth.organizationId, channelId);
    },
  };
}
