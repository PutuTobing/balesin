import {
  DEFAULT_BROADCAST_SETTINGS,
  broadcastRatesSchema,
  type AlarmKind,
  type BroadcastSettingsValues,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { alarmEvents, broadcastSettings, type BroadcastSettingsRow } from './schema';

/**
 * Aturan broadcast yang dipakai api DAN worker (Fase 4): pengaturan organisasi (dengan bawaan) dan
 * outbox alarm. Satu sumber supaya keduanya membaca ambang yang sama.
 */

export function broadcastSettingsFromRow(
  row: BroadcastSettingsRow | undefined,
): BroadcastSettingsValues {
  if (!row) return DEFAULT_BROADCAST_SETTINGS;
  const rates = broadcastRatesSchema.safeParse(row.rates);
  return {
    approvalThreshold: row.approvalThreshold,
    maxRatePerSecond: row.maxRatePerSecond,
    quotaReservePercent: row.quotaReservePercent,
    autoBrake: {
      enabled: row.autoBrakeEnabled,
      failureSpikePercent: row.failureSpikePercent,
      failureSpikeMinSample: row.failureSpikeMinSample,
      spikeMultiplier: row.spikeMultiplier,
      spikeMinPerMinute: row.spikeMinPerMinute,
      spikeAbsolutePerMinute: row.spikeAbsolutePerMinute,
    },
    rates: rates.success ? rates.data : DEFAULT_BROADCAST_SETTINGS.rates,
  };
}

export async function loadBroadcastSettings(
  executor: DbExecutor,
  organizationId: string,
): Promise<BroadcastSettingsValues> {
  const [row] = await executor
    .select()
    .from(broadcastSettings)
    .where(eq(broadcastSettings.organizationId, organizationId))
    .limit(1);
  return broadcastSettingsFromRow(row);
}

/**
 * Antrekan satu alarm (dikirim worker ke Telegram bila diatur). `details` WAJIB tanpa data pelanggan:
 * hanya nama kampanye, jumlah, kode, alasan.
 */
export async function recordAlarm(
  executor: DbExecutor,
  alarm: {
    organizationId: string;
    kind: AlarmKind;
    campaignId?: string | null;
    details: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await executor.insert(alarmEvents).values({
    organizationId: alarm.organizationId,
    kind: alarm.kind,
    campaignId: alarm.campaignId ?? null,
    details: alarm.details,
  });
}

/** Konteks SecretBox token bot Telegram (subjek = organisasi). */
export const TELEGRAM_TOKEN_PURPOSE = 'telegram_alarm_settings.bot_token';
/** Konteks SecretBox nilai header autentikasi konektor REST (subjek = ID konektor). */
export const CONNECTOR_HEADER_PURPOSE = 'broadcast_connectors.auth_header_value';
