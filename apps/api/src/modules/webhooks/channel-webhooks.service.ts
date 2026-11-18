import {
  META_SIGNATURE_HEADER,
  constantTimeEqual,
  normalizeTelegramUpdate,
  openChannelConnectionSecret,
  openMetaSocialSecret,
  parseWebhookHandshake,
  parseWebhookJson,
  splitMetaSocialWebhook,
  verifyMetaWebhookSignature,
  type Secret,
  type SecretBox,
  type WebhookEventJobPayload,
} from '@balesin/core';
import type { Channel, Database, NewWebhookEvent } from '@balesin/db';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { WebhookEventEnqueuer } from '../../queues/webhook-queue';
import { insertWebhookEvents } from './webhook-events.repo';
import { webhookRejected, webhookUnavailable, type WebhookGuard } from './webhook-guard';
import { WEBHOOK_MAX_EVENT_AGE_MS, WEBHOOK_MAX_FUTURE_SKEW_MS } from './whatsapp-webhook.service';

/**
 * Penerima webhook channel selain WhatsApp (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md):
 *
 *  - Telegram `POST /webhooks/telegram/:channelId`: keaslian dari header
 *    `X-Telegram-Bot-Api-Secret-Token` (acak per channel, dipasang lewat `setWebhook`) yang
 *    dibandingkan WAKTU-KONSTAN dengan yang tersimpan. Tanpa/salah → 403 (penjaga mencatat & menahan).
 *  - Messenger/Instagram `GET|POST /webhooks/{messenger|instagram}/:channelId`: jabat tangan verify
 *    token + tanda tangan `X-Hub-Signature-256` App Secret atas body MENTAH (pola WhatsApp).
 *
 * Urutan sama dengan WhatsApp: penjaga (batas laju, channel ada) → keaslian → batas volume → JSON →
 * normalisasi (skema toleran) → channel nonaktif dibuang (tetap 200) → simpan `webhook_events`
 * (idempoten) → antre ID → jawab cepat. Isi pesan tidak pernah ditulis ke log.
 */

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
/** Update Telegram kecil (pesan + metadata berkas); 1 MB sudah sangat longgar. */
export const TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface TelegramReceiveResult {
  stored: number;
  /** Untuk tombol inline: dijawab di badan respons (`answerCallbackQuery`, tanpa token). */
  callbackQueryId: string | null;
}

export interface ChannelWebhooksService {
  receiveTelegram(input: {
    channel: Channel;
    rawBody: Buffer;
    headers: Record<string, unknown>;
    client: ClientInfo;
    log: FastifyBaseLogger;
  }): Promise<TelegramReceiveResult>;
  handshakeMetaSocial(
    channel: Channel,
    query: unknown,
    client: ClientInfo,
    log: FastifyBaseLogger,
  ): Promise<string>;
  receiveMetaSocial(input: {
    channel: Channel;
    rawBody: Buffer;
    headers: Record<string, unknown>;
    client: ClientInfo;
    log: FastifyBaseLogger;
  }): Promise<{ stored: number }>;
}

export interface ChannelWebhooksDeps {
  db: Database;
  secretBox: SecretBox | null;
  guard: WebhookGuard;
  queue: WebhookEventEnqueuer;
  now?: () => Date;
}

export function createChannelWebhooksService(deps: ChannelWebhooksDeps): ChannelWebhooksService {
  const { db, secretBox, guard, queue } = deps;
  const now = deps.now ?? (() => new Date());

  function telegramSecret(channel: Channel, log: FastifyBaseLogger): Secret<string> {
    if (secretBox && channel.tgWebhookSecretEncrypted) {
      try {
        return openChannelConnectionSecret(
          secretBox,
          channel,
          'telegramWebhookSecret',
          channel.tgWebhookSecretEncrypted,
        );
      } catch {
        // dilaporkan di bawah
      }
    }
    log.error(
      { channelId: channel.id },
      'Webhook Telegram tidak bisa diperiksa: secret channel tidak bisa dibuka (BALESIN_MASTER_KEY kosong atau berubah)',
    );
    throw webhookUnavailable();
  }

  function metaSecret(
    channel: Channel,
    kind: 'appSecret' | 'verifyToken',
    log: FastifyBaseLogger,
  ): Secret<string> {
    const sealed =
      kind === 'appSecret' ? channel.metaAppSecretEncrypted : channel.metaVerifyTokenEncrypted;
    if (secretBox && sealed) {
      try {
        return openMetaSocialSecret(secretBox, channel, kind, sealed);
      } catch {
        // dilaporkan di bawah
      }
    }
    log.error(
      { channelId: channel.id, secret: kind === 'appSecret' ? 'app_secret' : 'verify_token' },
      'Webhook Meta tidak bisa diperiksa: rahasia channel tidak bisa dibuka',
    );
    throw webhookUnavailable();
  }

  async function store(
    rows: NewWebhookEvent[],
    channel: Channel,
    log: FastifyBaseLogger,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    let result: Awaited<ReturnType<typeof insertWebhookEvents>>;
    try {
      result = await insertWebhookEvents(db, rows);
    } catch (error) {
      throw webhookUnavailable(error);
    }
    if (result.rejectedCodes.length > 0) {
      log.warn(
        { channelId: channel.id, rejected: result.rejectedCodes.length },
        'Sebagian kejadian webhook ditolak database karena datanya — dilewati',
      );
    }
    const jobs: WebhookEventJobPayload[] = [...result.inserted, ...result.pendingDuplicates]
      .filter((event) => event.status === 'pending')
      .map((event) => ({ organizationId: event.organizationId, eventId: event.id }));
    try {
      await queue.enqueue(jobs);
    } catch (error) {
      log.warn(
        { err: error, channelId: channel.id, events: jobs.length },
        'Kejadian webhook tersimpan tetapi belum bisa diantrekan',
      );
      throw webhookUnavailable();
    }
    return result.inserted.length;
  }

  return {
    async receiveTelegram({ channel, rawBody, headers, client, log }) {
      const presented = headers[TELEGRAM_SECRET_HEADER];
      const expected = telegramSecret(channel, log);
      if (typeof presented !== 'string' || presented.length === 0) {
        await guard.recordRejection(channel, client, 'signature_missing', log);
        throw webhookRejected();
      }
      if (!constantTimeEqual(presented, expected.reveal())) {
        await guard.recordRejection(channel, client, 'signature_mismatch', log);
        throw webhookRejected();
      }
      await guard.consumeChannelVolume(channel);

      const body = parseWebhookJson(rawBody);
      const normalized = normalizeTelegramUpdate(body);
      if (!normalized.ok) {
        log.info(
          { channelId: channel.id, reason: normalized.reason, updateId: normalized.updateId },
          'Update Telegram dilewati',
        );
        return { stored: 0, callbackQueryId: null };
      }
      // Channel nonaktif: dibuang, tetap 200 (Telegram berhenti mengirim ulang).
      if (!channel.enabled) return { stored: 0, callbackQueryId: normalized.callbackQueryId };

      const receivedAt = now();
      const message = normalized.message;
      const sentAt = new Date(message.sentAt);
      if (sentAt.getTime() < receivedAt.getTime() - WEBHOOK_MAX_EVENT_AGE_MS) {
        return { stored: 0, callbackQueryId: normalized.callbackQueryId };
      }
      const updateId = (body as { update_id: number }).update_id;
      const stored = await store(
        [
          {
            organizationId: channel.organizationId,
            channelId: channel.id,
            source: 'telegram',
            kind: 'message',
            field: message.rawType === 'callback_query' ? 'callback_query' : 'message',
            dedupKey: `tg:${String(updateId)}`,
            externalId: message.externalId,
            payload: message,
            occurredAt:
              sentAt.getTime() > receivedAt.getTime() + WEBHOOK_MAX_FUTURE_SKEW_MS ? null : sentAt,
            receivedAt,
            status: 'pending',
          },
        ],
        channel,
        log,
      );
      log.info({ channelId: channel.id, stored }, 'Webhook Telegram diterima');
      return { stored, callbackQueryId: normalized.callbackQueryId };
    },

    async handshakeMetaSocial(channel, query, client, log) {
      const handshake = parseWebhookHandshake(query);
      if (!handshake.ok) {
        await guard.recordRejection(channel, client, 'handshake_invalid', log);
        throw webhookRejected();
      }
      const stored = metaSecret(channel, 'verifyToken', log);
      if (!constantTimeEqual(handshake.verifyToken, stored.reveal())) {
        await guard.recordRejection(channel, client, 'handshake_invalid', log);
        throw webhookRejected();
      }
      log.info(
        { channelId: channel.id },
        'Jabat tangan webhook Meta (Messenger/Instagram) berhasil',
      );
      return handshake.challenge;
    },

    async receiveMetaSocial({ channel, rawBody, headers, client, log }) {
      const appSecret = metaSecret(channel, 'appSecret', log);
      const check = verifyMetaWebhookSignature(rawBody, headers[META_SIGNATURE_HEADER], appSecret);
      if (check !== 'valid') {
        await guard.recordRejection(channel, client, `signature_${check}`, log);
        throw webhookRejected();
      }
      await guard.consumeChannelVolume(channel);
      if (channel.type !== 'messenger' && channel.type !== 'instagram') return { stored: 0 };
      const ownerId = channel.type === 'instagram' ? channel.metaIgAccountId : channel.metaPageId;
      const split = splitMetaSocialWebhook(parseWebhookJson(rawBody), channel.type, ownerId ?? '');
      if (!split.recognized) {
        log.warn(
          { channelId: channel.id },
          'Webhook Meta bertanda tangan sah tetapi bukan notifikasi Messenger/Instagram — diabaikan',
        );
        return { stored: 0 };
      }
      if (!channel.enabled) return { stored: 0 };
      const receivedAt = now();
      const oldest = receivedAt.getTime() - WEBHOOK_MAX_EVENT_AGE_MS;
      const newest = receivedAt.getTime() + WEBHOOK_MAX_FUTURE_SKEW_MS;
      const rows: NewWebhookEvent[] = split.items
        .filter((item) => {
          const at = item.occurredAt?.getTime();
          return at === undefined || (at >= oldest && at <= newest);
        })
        .map((item) => ({
          organizationId: channel.organizationId,
          channelId: channel.id,
          source: channel.type,
          kind: item.kind,
          field: 'messages',
          dedupKey: item.dedupKey,
          externalId: item.externalId,
          payload: item.event,
          occurredAt: item.occurredAt,
          receivedAt,
          status: 'pending' as const,
        }));
      const stored = await store(rows, channel, log);
      log.info(
        {
          channelId: channel.id,
          stored,
          misrouted: split.misrouted,
          invalid: split.invalid,
          ignored: split.ignored,
          overLimit: split.overLimit,
        },
        'Webhook Messenger/Instagram diterima',
      );
      return { stored };
    },
  };
}
