import { AppError } from '@balesin/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Channel, Database } from '@balesin/db';
import { AUDIT_ACTIONS } from '@balesin/shared';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import { rateLimited, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { recordAudit } from '../audit/audit';
import { findChannelForWebhook } from './webhook-events.repo';

/**
 * Penjaga endpoint publik `/webhooks/whatsapp/:channelId` (rawan banjir, tanpa sesi).
 *
 * Batas laju dirancang supaya lonjakan SAH dari Meta (broadcast → ribuan status per menit) tidak
 * pernah tertahan, sedangkan percobaan palsu cepat dihentikan:
 *
 * | Ember | Kunci | Batas | Dihitung | Lewat batas |
 * |---|---|---|---|---|
 * | `webhook-ip` | IP | 3.000 / menit | setiap permintaan | 429 |
 * | `webhook-tak-dikenal-ip` | IP | 30 / 10 menit | ID channel tidak pernah ada | 429 hanya untuk ID tak dikenal berikutnya dari IP itu |
 * | `webhook-tolak-jabat-tangan-ip` | IP + channel | 20 / 10 menit | jabat tangan GET ditolak | 429 untuk GET channel itu dari IP itu |
 * | `webhook-tolak-ip` | IP + channel | 20 / 10 menit | tanda tangan POST ditolak | 429 untuk POST channel itu dari IP itu |
 * | `webhook-tolak-channel` | channel | — (penghitung) | tanda tangan POST ditolak, semua IP | ≥ 10 → kejadian keamanan |
 * | `webhook-channel` | channel | 12.000 / menit | notifikasi bertanda tangan SAH | 429 (Meta mengirim ulang) |
 *
 * - Ember "ditolak" hanya diisi kegagalan, jadi Meta (tanda tangan benar) tidak pernah terkena,
 *   walaupun satu IP Meta melayani banyak channel. Channel dengan App Secret salah hanya memblokir
 *   dirinya sendiri dari IP itu.
 * - Ember dipisah PER METODE (review webhook S1). Siapa pun yang punya aplikasi Meta bisa membuat
 *   server Meta mengirim jabat tangan GET yang gagal ke URL kita (memasang callback dengan verify
 *   token asal), dari IP yang sama dengan notifikasi sah. Kegagalan GET karena itu hanya menahan GET;
 *   POST hanya ditahan oleh tanda tangan POST yang salah (Meta tidak pernah mengirim POST bertanda
 *   tangan salah: langganan baru aktif setelah jabat tangan lolos).
 * - `webhook-tak-dikenal-ip` hanya diperiksa ketika ID memang tidak ditemukan, jadi tidak pernah
 *   menahan channel yang ADA (pencarian per primary key sudah dibatasi `webhook-ip`; menebak UUIDv7
 *   tidak realistis).
 * - Channel TERHAPUS tidak dihitung sebagai "tidak dikenal": Meta wajar masih mengirim ke URL lama
 *   (webhook belum dicabut di Meta) dan itu tidak boleh menahan channel lain di IP Meta yang sama.
 * - Redis mati = 503 (Meta mengirim ulang sampai 7 hari), bukan diloloskan.
 * - 10 tanda tangan salah dalam 10 menit pada satu channel → audit
 *   `channel.webhook_signature_rejected` (kejadian `webhook_signature_failed` di ringkasan keamanan,
 *   `warning`), paling banyak sekali per jam per channel. Itu tanda App Secret di Balesin tidak sama
 *   dengan aplikasi Meta (webhook tidak masuk sama sekali!), atau ada yang mencoba memalsukan pesan.
 *   Rinciannya memuat jumlah sumber (IP) berbeda dan awalan IP terbanyak (review webhook R1): "banyak
 *   IP Meta" = App Secret salah; "satu IP" = kemungkinan orang dalam yang tahu ID channel.
 */
export const WEBHOOK_IP_RULE: RateLimitRule = {
  name: 'webhook-ip',
  limit: 3_000,
  windowSeconds: 60,
};
export const WEBHOOK_UNKNOWN_CHANNEL_RULE: RateLimitRule = {
  name: 'webhook-tak-dikenal-ip',
  limit: 30,
  windowSeconds: 600,
};
/** Tanda tangan POST ditolak per IP + channel; hanya menahan POST. */
export const WEBHOOK_REJECTED_SOURCE_RULE: RateLimitRule = {
  name: 'webhook-tolak-ip',
  limit: 20,
  windowSeconds: 600,
};
/** Jabat tangan GET ditolak per IP + channel; hanya menahan GET (review webhook S1). */
export const WEBHOOK_REJECTED_HANDSHAKE_RULE: RateLimitRule = {
  name: 'webhook-tolak-jabat-tangan-ip',
  limit: 20,
  windowSeconds: 600,
};
/** Penghitung tanda tangan ditolak per channel (semua IP); `limit` = ambang kejadian keamanan. */
export const WEBHOOK_REJECTED_CHANNEL_RULE: RateLimitRule = {
  name: 'webhook-tolak-channel',
  limit: 10,
  windowSeconds: 600,
};
/**
 * Jumlah tanda tangan gagal per channel dalam ±24 jam (jendela TETAP sejak kegagalan pertama) dan
 * penanda "terakhir gagal" (TTL 24 jam; waktu = sekarang − (24 jam − sisa TTL)) — untuk layar
 * diagnosis webhook (butir 10 sisa). Tidak menahan apa pun.
 */
export const WEBHOOK_SIGNATURE_DAY_RULE: RateLimitRule = {
  name: 'webhook-tanda-tangan-24j',
  limit: 1_000_000_000,
  windowSeconds: 24 * 60 * 60,
};
export const WEBHOOK_SIGNATURE_LAST_FLAG = 'webhook-tanda-tangan-terakhir';

export const WEBHOOK_CHANNEL_RULE: RateLimitRule = {
  name: 'webhook-channel',
  limit: 12_000,
  windowSeconds: 60,
};
/** Sumber (IP) tanda tangan ditolak per channel — untuk rincian kejadian keamanan (R1). */
export const WEBHOOK_REJECTED_SOURCES_TALLY = 'webhook-tolak-sumber';
const WEBHOOK_REJECTED_SOURCES_MAX = 256;
/** Kejadian keamanan paling banyak sekali per jam per channel. */
export const WEBHOOK_ALARM_FLAG = 'webhook-tolak-alarm';
const WEBHOOK_ALARM_TTL_SECONDS = 60 * 60;

/** Pesan penolakan seragam — tanpa alasan (tanpa header / salah / jabat tangan salah). */
export const WEBHOOK_REJECTED_MESSAGE = 'Permintaan webhook ditolak.';
export const WEBHOOK_NOT_FOUND_MESSAGE = 'Alamat webhook tidak dikenal.';
export const WEBHOOK_UNAVAILABLE_MESSAGE =
  'Webhook belum bisa diproses sekarang. Pengiriman akan diulang otomatis.';
const RATE_LIMITED_MESSAGE = 'Terlalu banyak permintaan webhook. Coba lagi nanti.';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const webhookRejected = () =>
  new AppError('FORBIDDEN', { message: WEBHOOK_REJECTED_MESSAGE });
export const webhookNotFound = () =>
  new AppError('NOT_FOUND', { message: WEBHOOK_NOT_FOUND_MESSAGE });
export const webhookUnavailable = (cause?: unknown) =>
  new AppError('SERVICE_UNAVAILABLE', { message: WEBHOOK_UNAVAILABLE_MESSAGE, cause });

/** Alasan penolakan (log/audit saja — tidak pernah ke pemanggil). */
export type WebhookRejectionReason =
  'signature_missing' | 'signature_malformed' | 'signature_mismatch' | 'handshake_invalid';

/** `GET` = jabat tangan verifikasi; `POST` = notifikasi. Ember penolakan dipisah per metode (S1). */
export type WebhookMethod = 'GET' | 'POST';

/**
 * Awalan IP untuk ditampilkan ke Owner (bukan alamat lengkap): IPv4 /24, IPv6 /64 (kunci batas laju
 * sudah berupa /64).
 */
export function sourcePrefixOf(ipKey: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ipKey);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return ipKey.endsWith('::/64') ? ipKey : 'tidak-diketahui';
}

/** Ringkasan sumber penolakan: jumlah berbeda + awalan sumber terbanyak. */
export function summarizeSources(tally: Record<string, number>): {
  distinctSources: number;
  topSource: string | null;
  topSourceFailures: number;
} {
  let top: [string, number] | null = null;
  for (const entry of Object.entries(tally)) {
    if (!top || entry[1] > top[1] || (entry[1] === top[1] && entry[0] < top[0])) top = entry;
  }
  return {
    distinctSources: Object.keys(tally).length,
    topSource: top ? sourcePrefixOf(top[0]) : null,
    topSourceFailures: top ? top[1] : 0,
  };
}

export interface WebhookGuard {
  /**
   * Sebelum body dibaca: batas laju per IP, ID channel, channel ada & tidak terhapus, sumber ini
   * belum terlalu sering ditolak untuk channel ini DENGAN METODE INI. Melempar 404/429/503.
   */
  admit(rawChannelId: string, client: ClientInfo, method: WebhookMethod): Promise<Channel>;
  /** Mencatat penolakan (ember + kejadian keamanan). Tidak pernah melempar. */
  recordRejection(
    channel: Channel,
    client: ClientInfo,
    reason: WebhookRejectionReason,
    log: FastifyBaseLogger,
  ): Promise<void>;
  /** Batas volume notifikasi sah per channel. Melempar 429. */
  consumeChannelVolume(channel: Channel): Promise<void>;
}

const rejectionRuleFor = (method: WebhookMethod): RateLimitRule =>
  method === 'GET' ? WEBHOOK_REJECTED_HANDSHAKE_RULE : WEBHOOK_REJECTED_SOURCE_RULE;

export function createWebhookGuard(deps: { db: Database; limiter: RateLimiter }): WebhookGuard {
  const { db, limiter } = deps;

  async function enforce(rule: RateLimitRule, key: string, consume: boolean) {
    const state = consume ? await limiter.consume(rule, key) : await limiter.peek(rule, key);
    if (!state.allowed) throw rateLimited(state.retryAfterSeconds, RATE_LIMITED_MESSAGE);
  }

  return {
    async admit(rawChannelId, client, method) {
      const ipKey = ipRateLimitKey(client);
      await enforce(WEBHOOK_IP_RULE, ipKey, true);

      const channel = UUID_PATTERN.test(rawChannelId)
        ? await findChannelForWebhook(db, rawChannelId.toLowerCase()).catch((error: unknown) => {
            throw webhookUnavailable(error);
          })
        : undefined;
      if (!channel) {
        // Hanya ID yang memang tak dikenal yang dihitung DAN ditahan (S1 butir 2).
        await enforce(WEBHOOK_UNKNOWN_CHANNEL_RULE, ipKey, true);
        throw webhookNotFound();
      }
      // Terhapus: rahasianya sudah dimusnahkan, tidak ada yang bisa diperiksa (review D.6).
      if (channel.deletedAt !== null) throw webhookNotFound();

      await enforce(rejectionRuleFor(method), `${ipKey}:${channel.id}`, false);
      return channel;
    },

    async recordRejection(channel, client, reason, log) {
      try {
        const ipKey = ipRateLimitKey(client);
        // Jabat tangan yang salah biasanya salah tempel saat memasang webhook — tidak dihitung
        // sebagai percobaan memalsukan pesan, dan hanya menahan GET berikutnya.
        if (reason === 'handshake_invalid') {
          await limiter.consume(rejectionRuleFor('GET'), `${ipKey}:${channel.id}`);
          log.warn({ channelId: channel.id, reason }, 'Jabat tangan webhook ditolak');
          return;
        }
        await limiter.consume(rejectionRuleFor('POST'), `${ipKey}:${channel.id}`);
        await limiter.consume(WEBHOOK_SIGNATURE_DAY_RULE, channel.id);
        await limiter.setFlag(
          WEBHOOK_SIGNATURE_LAST_FLAG,
          channel.id,
          WEBHOOK_SIGNATURE_DAY_RULE.windowSeconds,
        );
        await limiter.tally(WEBHOOK_REJECTED_SOURCES_TALLY, channel.id, ipKey, {
          ttlSeconds: WEBHOOK_REJECTED_CHANNEL_RULE.windowSeconds,
          maxMembers: WEBHOOK_REJECTED_SOURCES_MAX,
        });
        const { count } = await limiter.consume(WEBHOOK_REJECTED_CHANNEL_RULE, channel.id);
        // Log ringkas tanpa payload/header; dibatasi supaya banjir tidak membanjiri log.
        if (count <= 3 || count === WEBHOOK_REJECTED_CHANNEL_RULE.limit) {
          log.warn(
            { channelId: channel.id, reason, failures: count },
            'Webhook ditolak: tanda tangan Meta tidak valid',
          );
        }
        if (count < WEBHOOK_REJECTED_CHANNEL_RULE.limit) return;
        const claimed = await limiter.claimFlag(
          WEBHOOK_ALARM_FLAG,
          channel.id,
          WEBHOOK_ALARM_TTL_SECONDS,
        );
        if (!claimed) return;
        const sources = summarizeSources(
          await limiter.readTally(WEBHOOK_REJECTED_SOURCES_TALLY, channel.id),
        );
        await recordAudit(db, {
          organizationId: channel.organizationId,
          actorUserId: null,
          action: AUDIT_ACTIONS.channelWebhookSignatureRejected,
          targetType: 'channel',
          targetId: channel.id,
          metadata: {
            channelId: channel.id,
            name: channel.name,
            phoneNumberId: channel.waPhoneNumberId,
            failures: count,
            windowMinutes: WEBHOOK_REJECTED_CHANNEL_RULE.windowSeconds / 60,
            reason,
            ...sources,
          },
          client,
        });
      } catch (error) {
        // Pencatatan tidak boleh mengubah jawaban (tetap 403).
        log.error({ err: error, channelId: channel.id }, 'Penolakan webhook gagal dicatat');
      }
    },

    async consumeChannelVolume(channel) {
      await enforce(WEBHOOK_CHANNEL_RULE, channel.id, true);
    },
  };
}
