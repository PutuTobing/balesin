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
 * | `webhook-tak-dikenal-ip` | IP | 30 / 10 menit | ID channel tidak pernah ada | 429 untuk semua webhook dari IP itu |
 * | `webhook-tolak-ip` | IP + channel | 20 / 10 menit | tanda tangan / jabat tangan ditolak | 429 untuk channel itu dari IP itu |
 * | `webhook-tolak-channel` | channel | — (penghitung) | tanda tangan POST ditolak, semua IP | ≥ 10 → kejadian keamanan |
 * | `webhook-channel` | channel | 12.000 / menit | notifikasi bertanda tangan SAH | 429 (Meta mengirim ulang) |
 *
 * - Ember "ditolak" hanya diisi kegagalan, jadi Meta (tanda tangan benar) tidak pernah terkena,
 *   walaupun satu IP Meta melayani banyak channel. Channel dengan App Secret salah hanya memblokir
 *   dirinya sendiri dari IP itu.
 * - Channel TERHAPUS tidak dihitung sebagai "tidak dikenal": Meta wajar masih mengirim ke URL lama
 *   (webhook belum dicabut di Meta) dan itu tidak boleh menahan channel lain di IP Meta yang sama.
 * - Redis mati = 503 (Meta mengirim ulang sampai 7 hari), bukan diloloskan.
 * - 10 tanda tangan salah dalam 10 menit pada satu channel → audit
 *   `channel.webhook_signature_rejected` (kejadian `webhook_signature_failed` di ringkasan keamanan,
 *   `warning`), paling banyak sekali per jam per channel. Itu tanda App Secret di Balesin tidak sama
 *   dengan aplikasi Meta (webhook tidak masuk sama sekali!), atau ada yang mencoba memalsukan pesan.
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
export const WEBHOOK_REJECTED_SOURCE_RULE: RateLimitRule = {
  name: 'webhook-tolak-ip',
  limit: 20,
  windowSeconds: 600,
};
/** Penghitung tanda tangan ditolak per channel (semua IP); `limit` = ambang kejadian keamanan. */
export const WEBHOOK_REJECTED_CHANNEL_RULE: RateLimitRule = {
  name: 'webhook-tolak-channel',
  limit: 10,
  windowSeconds: 600,
};
export const WEBHOOK_CHANNEL_RULE: RateLimitRule = {
  name: 'webhook-channel',
  limit: 12_000,
  windowSeconds: 60,
};
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

export interface WebhookGuard {
  /**
   * Sebelum body dibaca: batas laju per IP, ID channel, channel ada & tidak terhapus, sumber ini
   * belum terlalu sering ditolak untuk channel ini. Melempar 404/429/503.
   */
  admit(rawChannelId: string, client: ClientInfo): Promise<Channel>;
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

export function createWebhookGuard(deps: { db: Database; limiter: RateLimiter }): WebhookGuard {
  const { db, limiter } = deps;

  async function enforce(rule: RateLimitRule, key: string, consume: boolean) {
    const state = consume ? await limiter.consume(rule, key) : await limiter.peek(rule, key);
    if (!state.allowed) throw rateLimited(state.retryAfterSeconds, RATE_LIMITED_MESSAGE);
  }

  return {
    async admit(rawChannelId, client) {
      const ipKey = ipRateLimitKey(client);
      await enforce(WEBHOOK_IP_RULE, ipKey, true);
      await enforce(WEBHOOK_UNKNOWN_CHANNEL_RULE, ipKey, false);

      const channel = UUID_PATTERN.test(rawChannelId)
        ? await findChannelForWebhook(db, rawChannelId.toLowerCase()).catch((error: unknown) => {
            throw webhookUnavailable(error);
          })
        : undefined;
      if (!channel) {
        await limiter.consume(WEBHOOK_UNKNOWN_CHANNEL_RULE, ipKey);
        throw webhookNotFound();
      }
      // Terhapus: rahasianya sudah dimusnahkan, tidak ada yang bisa diperiksa (review D.6).
      if (channel.deletedAt !== null) throw webhookNotFound();

      await enforce(WEBHOOK_REJECTED_SOURCE_RULE, `${ipKey}:${channel.id}`, false);
      return channel;
    },

    async recordRejection(channel, client, reason, log) {
      try {
        const ipKey = ipRateLimitKey(client);
        await limiter.consume(WEBHOOK_REJECTED_SOURCE_RULE, `${ipKey}:${channel.id}`);
        // Jabat tangan yang salah biasanya salah tempel saat memasang webhook — tidak dihitung
        // sebagai percobaan memalsukan pesan.
        if (reason === 'handshake_invalid') {
          log.warn({ channelId: channel.id, reason }, 'Jabat tangan webhook ditolak');
          return;
        }
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
        await recordAudit(db, {
          organizationId: channel.organizationId,
          actorUserId: null,
          action: AUDIT_ACTIONS.channelWebhookSignatureRejected,
          targetType: 'channel',
          targetId: channel.id,
          metadata: {
            name: channel.name,
            phoneNumberId: channel.waPhoneNumberId,
            failures: count,
            windowMinutes: WEBHOOK_REJECTED_CHANNEL_RULE.windowSeconds / 60,
            reason,
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
