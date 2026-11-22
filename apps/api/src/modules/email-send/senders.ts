import {
  apiKeyEmailSenders,
  channels,
  emailOutbound,
  emailSenderSettings,
  emailSettings,
  type DbExecutor,
  type EmailSenderSettingsRow,
} from '@balesin/db';
import {
  EMAIL_HOURLY_LIMIT_DEFAULT,
  emailSenderId,
  parseEmailSenderId,
  type EmailSenderBlockedReason,
  type EmailSenderState,
} from '@balesin/shared';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

/**
 * Pengirim email lewat API (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §1). Di 9.1 HANYA Channel
 * Email Fase 6 (`chn_<uuid>`); akun Email (`acc_…`, 9B) belum bisa dipilih. Akun pribadi tidak
 * pernah bisa menjadi pengirim API.
 *
 *  - SMTP `custom`: From = nama + alamat channel (atau alias SE-DOMAIN), Reply-To = permintaan,
 *    bounce terlacak.
 *  - SMTP `system`: From = alamat Email pengirim sistem, Reply-To SELALU alamat channel (balasan
 *    kembali ke kotak masuk channel), tanpa alias, bounce tidak terlacak.
 */

export interface ChannelSender {
  id: string;
  kind: 'channel';
  channelId: string;
  name: string;
  /** Alamat kotak surat channel (huruf kecil). */
  address: string;
  fromName: string;
  /** Alamat "Dari" bawaan: channel (custom) atau Email pengirim sistem (system). */
  fromAddress: string;
  smtpMode: 'system' | 'custom';
  /** Alias channel yang boleh jadi "Dari": SE-DOMAIN dengan alamat channel, hanya SMTP custom. */
  aliases: string[];
  replyToFixed: boolean;
  bounceTracking: boolean;
  enabled: boolean;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** Saringan alias "Dari" (§3.6/§8.2): hanya alias berdomain sama dengan alamat channel, SMTP custom. */
export function fromAliasesOf(
  address: string,
  aliases: readonly string[],
  smtpMode: string,
): string[] {
  if (smtpMode !== 'custom') return [];
  const domain = domainOf(address);
  return [
    ...new Set(
      aliases
        .map((alias) => alias.trim().toLowerCase())
        .filter((alias) => alias !== address && domainOf(alias) === domain),
    ),
  ];
}

/**
 * Channel Email hidup (belum dihapus) organisasi ini sebagai pengirim. `channelIds` = batasi ke
 * channel itu saja. Channel nonaktif tetap dikembalikan (`enabled: false` → `state: disabled`).
 */
export async function loadChannelSenders(
  db: DbExecutor,
  organizationId: string,
  channelIds?: readonly string[],
): Promise<ChannelSender[]> {
  if (channelIds && channelIds.length === 0) return [];
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      enabled: channels.enabled,
      emailAddress: channels.emailAddress,
      emailFromName: channels.emailFromName,
      emailSmtpMode: channels.emailSmtpMode,
      emailAliases: channels.emailAliases,
    })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'email'),
        isNull(channels.deletedAt),
        channelIds ? inArray(channels.id, [...channelIds]) : undefined,
      ),
    )
    .orderBy(channels.name);
  if (rows.length === 0) return [];
  const [system] = await db
    .select({ fromAddress: emailSettings.fromAddress })
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  return rows.map((row) => {
    const address = (row.emailAddress ?? '').toLowerCase();
    const smtpMode = row.emailSmtpMode === 'system' ? 'system' : 'custom';
    return {
      id: emailSenderId('channel', row.id),
      kind: 'channel' as const,
      channelId: row.id,
      name: row.name,
      address,
      fromName: row.emailFromName ?? row.name,
      fromAddress: smtpMode === 'system' ? (system?.fromAddress ?? address) : address,
      smtpMode,
      aliases: fromAliasesOf(address, row.emailAliases, smtpMode),
      replyToFixed: smtpMode === 'system',
      bounceTracking: smtpMode === 'custom',
      enabled: row.enabled,
    };
  });
}

/** Satu pengirim dari ID ber-awalan, atau `null` (tidak ada / bukan Channel Email / 9B). */
export async function findChannelSender(
  db: DbExecutor,
  organizationId: string,
  senderId: string,
): Promise<ChannelSender | null> {
  const parsed = parseEmailSenderId(senderId);
  if (!parsed || parsed.kind !== 'channel') return null;
  const [sender] = await loadChannelSenders(db, organizationId, [parsed.id]);
  return sender ?? null;
}

/** ID channel pengirim yang boleh dipakai key ini (channel yang dihapus otomatis lepas). */
export async function apiKeyChannelIds(
  db: DbExecutor,
  organizationId: string,
  apiKeyId: string,
): Promise<string[]> {
  const rows = await db
    .select({ channelId: apiKeyEmailSenders.channelId })
    .from(apiKeyEmailSenders)
    .innerJoin(
      channels,
      and(
        eq(channels.organizationId, apiKeyEmailSenders.organizationId),
        eq(channels.id, apiKeyEmailSenders.channelId),
        isNull(channels.deletedAt),
      ),
    )
    .where(
      and(
        eq(apiKeyEmailSenders.organizationId, organizationId),
        eq(apiKeyEmailSenders.apiKeyId, apiKeyId),
      ),
    );
  return rows.map((row) => row.channelId).filter((id): id is string => id !== null);
}

export interface SenderStats {
  settings: EmailSenderSettingsRow | null;
  hourlyLimit: number;
  sentLastHour: number;
  queued: number;
}

/**
 * Batas, jumlah PENERIMA terkirim 60 menit bergulir (`sent`/`sending`/`bounced`), dan penerima yang
 * menunggu di antrean per channel pengirim (review 9.1 S2: per penerima, bukan per email).
 */
export async function senderStats(
  db: DbExecutor,
  organizationId: string,
  channelIds: readonly string[],
  now: Date,
): Promise<Map<string, SenderStats>> {
  const result = new Map<string, SenderStats>();
  if (channelIds.length === 0) return result;
  const ids = [...channelIds];
  const settingsRows = await db
    .select()
    .from(emailSenderSettings)
    .where(
      and(
        eq(emailSenderSettings.organizationId, organizationId),
        inArray(emailSenderSettings.channelId, ids),
      ),
    );
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const sent = await db
    .select({
      channelId: emailOutbound.channelId,
      // Review 9.1 S2: dihitung PER PENERIMA.
      total: sql<number>`coalesce(sum(${emailOutbound.recipientCount}), 0)::int`,
    })
    .from(emailOutbound)
    .where(
      and(
        eq(emailOutbound.organizationId, organizationId),
        inArray(emailOutbound.channelId, ids),
        sql`${emailOutbound.status} in ('sent', 'sending', 'bounced')`,
        gt(sql`coalesce(${emailOutbound.sentAt}, ${emailOutbound.sendingStartedAt})`, hourAgo),
      ),
    )
    .groupBy(emailOutbound.channelId);
  const waiting = await db
    .select({
      channelId: emailOutbound.channelId,
      // Review 9.1 S2: dihitung PER PENERIMA.
      total: sql<number>`coalesce(sum(${emailOutbound.recipientCount}), 0)::int`,
    })
    .from(emailOutbound)
    .where(
      and(
        eq(emailOutbound.organizationId, organizationId),
        inArray(emailOutbound.channelId, ids),
        sql`${emailOutbound.status} in ('queued', 'scheduled')`,
      ),
    )
    .groupBy(emailOutbound.channelId);
  for (const id of ids) {
    const settings = settingsRows.find((row) => row.channelId === id) ?? null;
    result.set(id, {
      settings,
      hourlyLimit: settings?.hourlyLimit ?? EMAIL_HOURLY_LIMIT_DEFAULT,
      sentLastHour: Number(sent.find((row) => row.channelId === id)?.total ?? 0),
      queued: Number(waiting.find((row) => row.channelId === id)?.total ?? 0),
    });
  }
  return result;
}

/** Keadaan tampilan pengirim (§3.1): `disabled` dari channel, sisanya dari baris pengaturan. */
export function senderState(
  sender: Pick<ChannelSender, 'enabled'>,
  settings: EmailSenderSettingsRow | null,
  now: Date,
): { state: EmailSenderState; throttledUntil: string | null } {
  if (!sender.enabled) return { state: 'disabled', throttledUntil: null };
  if (!settings) return { state: 'ok', throttledUntil: null };
  if (settings.state === 'paused' || settings.state === 'blocked') {
    return { state: settings.state, throttledUntil: null };
  }
  if (
    settings.state === 'throttled' &&
    settings.throttledUntil &&
    settings.throttledUntil.getTime() > now.getTime()
  ) {
    return { state: 'throttled', throttledUntil: settings.throttledUntil.toISOString() };
  }
  return { state: 'ok', throttledUntil: null };
}

export function blockedReasonOf(
  settings: EmailSenderSettingsRow | null,
): EmailSenderBlockedReason | null {
  if (settings?.state !== 'blocked') return null;
  const reason = settings.blockedReason;
  return reason === 'smtp_auth_failed' ||
    reason === 'credentials_unavailable' ||
    reason === 'smtp_config_invalid'
    ? reason
    : null;
}
