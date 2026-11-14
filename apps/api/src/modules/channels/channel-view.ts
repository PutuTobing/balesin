import { maskedSecret } from '@balesin/core';
import type { Channel } from '@balesin/db';
import {
  CHANNEL_TEST_MESSAGES,
  WEBHOOK_HTTPS_WARNING,
  WHATSAPP_WEBHOOK_FIELDS,
  channelTestCodeSchema,
  numberWarnings,
  whatsAppNumberSummarySchema,
  type ChannelLastTest,
  type ChannelStatus,
  type ChannelSummary,
  type WhatsAppChannel,
  type WhatsAppNumberSummary,
} from '@balesin/shared';

/**
 * Bentuk channel untuk dikirim ke web. Kolom rahasia TIDAK PERNAH dibaca di sini selain ekornya
 * (`*_tail`) untuk petunjuk tersamar; verify token hanya keluar lewat `webhook`-nya service.
 */

/**
 * URL webhook per channel (ARCHITECTURE.md §4): `<API_URL>/webhooks/whatsapp/<channelId>`. Path di
 * `API_URL` (mis. `https://x/api`) ikut dipertahankan. Rute penerimanya dibuat di tugas webhook.
 */
export function webhookUrlFor(apiUrl: string, channelId: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL(`webhooks/whatsapp/${encodeURIComponent(channelId)}`, base).toString();
}

/** Meta hanya mau URL https yang terjangkau dari internet. */
export function webhookUrlWarning(apiUrl: string): string | null {
  const url = new URL(apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol !== 'https:' || local ? WEBHOOK_HTTPS_WARNING : null;
}

/** Ringkasan nomor tersimpan; data rusak/lama diabaikan (dianggap belum ada). */
export function storedNumber(row: Channel): WhatsAppNumberSummary | null {
  if (row.waNumberSummary === null) return null;
  const parsed = whatsAppNumberSummarySchema.safeParse(row.waNumberSummary);
  return parsed.success ? parsed.data : null;
}

export function lastTestOf(row: Channel): ChannelLastTest | null {
  if (row.lastTestOk === null || row.lastTestedAt === null) return null;
  const code = channelTestCodeSchema.safeParse(row.lastTestCode);
  if (!code.success) return null;
  return {
    ok: row.lastTestOk,
    code: code.data,
    message: CHANNEL_TEST_MESSAGES[code.data],
    testedAt: row.lastTestedAt.toISOString(),
  };
}

export function statusOf(row: Channel): ChannelStatus {
  if (row.lastTestOk === null) return 'untested';
  return row.lastTestOk ? 'connected' : 'failed';
}

export function toWhatsAppChannel(row: Channel, apiUrl: string): WhatsAppChannel {
  if (row.type !== 'whatsapp' || row.waPhoneNumberId === null || row.waBusinessAccountId === null) {
    throw new Error('Baris channel bukan WhatsApp yang lengkap');
  }
  const number = storedNumber(row);
  return {
    id: row.id,
    type: 'whatsapp',
    name: row.name,
    enabled: row.enabled,
    status: statusOf(row),
    phoneNumberId: row.waPhoneNumberId,
    wabaId: row.waBusinessAccountId,
    accessTokenHint: maskedSecret(row.waAccessTokenTail),
    appSecretHint: maskedSecret(row.waAppSecretTail),
    webhookUrl: webhookUrlFor(apiUrl, row.id),
    lastTest: lastTestOf(row),
    number,
    warnings: row.lastTestOk === true ? numberWarnings(number) : [],
    credentialsUpdatedAt: row.credentialsUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Untuk semua peran yang boleh melihat inbox: nama + nomor tampilan saja. */
export function toChannelSummary(row: Channel): ChannelSummary {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    displayPhoneNumber: storedNumber(row)?.displayPhoneNumber ?? null,
  };
}

export const SUBSCRIBE_FIELDS: string[] = [...WHATSAPP_WEBHOOK_FIELDS];
