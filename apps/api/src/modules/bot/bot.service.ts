import { AppError } from '@balesin/core';
import { channels, organizations, type Database } from '@balesin/db';
import {
  botHoursSchema,
  isWithinBotHours,
  type BotHours,
  type ChannelBotSettings,
  type channelBotSettingsResponseSchema,
} from '@balesin/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Pengaturan bot per channel (Fase 3, docs/KONTRAK-API-INBOX.md "Bot"): saklar bot, jam kerja bot
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

export function createBotService(deps: { db: Database; now?: () => Date }): BotService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(organizationId: string, channelId: string) {
    const [row] = await db
      .select({
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
    return {
      enabled: row.enabled,
      hours,
      timeoutMinutes: row.timeoutMinutes,
      timezone: row.timezone,
      activeNow: row.enabled && parsed.success && isWithinBotHours(hours, row.timezone, now()),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

  return {
    channelSettings: load,

    async updateChannelSettings(auth, channelId, input, client) {
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [current] = await tx
          .select({ enabled: channels.botEnabled, timeout: channels.botTimeoutMinutes })
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
            enabled: input.enabled,
            previousEnabled: current.enabled,
            hoursMode: input.hours.mode,
            ...(input.hours.mode === 'schedule' ? { windows: input.hours.windows.length } : {}),
            timeoutMinutes: input.timeoutMinutes ?? 'tanpa',
            actorRole: role,
          },
          client,
        });
      });
      return load(auth.organizationId, channelId);
    },
  };
}
