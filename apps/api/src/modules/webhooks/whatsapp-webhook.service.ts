import {
  META_SIGNATURE_HEADER,
  constantTimeEqual,
  openChannelSecret,
  parseWebhookHandshake,
  parseWebhookJson,
  splitWhatsAppWebhook,
  verifyMetaWebhookSignature,
  type Secret,
  type SecretBox,
  type WebhookEventJobPayload,
  type WhatsAppWebhookItem,
} from '@balesin/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Channel, Database, NewWebhookEvent } from '@balesin/db';

import type { ClientInfo } from '../../http/client-info';
import type { WebhookEventEnqueuer } from '../../queues/webhook-queue';
import { findLiveChannelsByPhoneNumberIds, insertWebhookEvents } from './webhook-events.repo';
import { webhookRejected, webhookUnavailable, type WebhookGuard } from './webhook-guard';

/**
 * Penerima webhook WhatsApp Cloud API (ARCHITECTURE.md §4, SECURITY.md §4, review Fase 2 D).
 *
 * POST, urutannya:
 *  1. `admit` (sebelum body dibaca): batas laju, channel ada & tidak terhapus → 404/429.
 *  2. Tanda tangan `X-Hub-Signature-256` atas body MENTAH dengan App Secret channel → 403 bila
 *     tidak ada/salah. Body belum ditafsirkan sama sekali sebelum langkah ini lolos.
 *  3. `JSON.parse` (teks dibersihkan untuk jsonb) + pemecahan per kejadian (skema toleran, maks.
 *     `WEBHOOK_MAX_EVENTS_PER_NOTIFICATION` kejadian & `WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION`
 *     nomor) → routing per `phone_number_id` + WABA (channel saudara dimuat dengan SATU query).
 *  4. Kejadian untuk channel nonaktif → DIBUANG (tidak disimpan) tetapi tetap 200: Meta berhenti
 *     mengirim ulang; selama nonaktif channel memang tidak menerima pesan.
 *  5. Simpan `webhook_events` (idempoten) → antre ID → 200. Baris yang DITOLAK database karena
 *     datanya (kelas 22/CHECK) dilewati satu per satu; sisanya tetap tersimpan (review webhook S2).
 *     Penyimpanan (koneksi/sementara) atau antrean gagal → 503 (Meta mengirim ulang; yang sudah
 *     tersimpan tidak tergandakan dan diantre ulang).
 *
 * Cap waktu dari payload (`occurredAt`) hanya dipakai untuk menolak kejadian basi (> 8 hari) dan dari
 * masa depan (> 1 jam, review webhook R4). Jendela 24 jam / SLA di butir berikutnya WAJIB memakai
 * `receivedAt` (jam server), bukan cap waktu payload.
 */

/** Batas body (Meta: payload webhook ≤ 3 MB). */
export const WEBHOOK_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Kejadian lebih tua dari ini dibuang. Meta mengirim ulang paling lama 7 hari; tanda tangan Meta
 * tanpa cap waktu, jadi notifikasi lama yang direkam pihak lain hanya bisa diputar ulang selama baris
 * idempotensinya masih ada (retensi `webhook_events` ≥ 8 hari).
 */
export const WEBHOOK_MAX_EVENT_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** Kejadian bercap waktu lebih dari ini di depan jam server ditolak (`future`, review webhook R4). */
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

export interface ReceiveSummary {
  /** Kejadian baru yang tersimpan. */
  stored: number;
  /** Kiriman ulang yang diabaikan. */
  duplicates: number;
  /** Nomor/WABA bukan milik channel ini (atau saudaranya yang sah). */
  misrouted: number;
  /** Lebih tua dari `WEBHOOK_MAX_EVENT_AGE_MS`. */
  stale: number;
  /** Bagian yang tidak lolos skema. */
  invalid: number;
  /** Melewati batas kejadian / nomor berbeda per notifikasi (dibuang). */
  overLimit: number;
  /** Cap waktu lebih dari `WEBHOOK_MAX_FUTURE_SKEW_MS` di masa depan (dibuang). */
  future: number;
  /** Ditolak database karena datanya (dilewati per baris; tanpa isi di log). */
  rejected: number;
  /** Untuk channel nonaktif: dibuang (tidak disimpan). */
  disabled: number;
}

export interface WhatsAppWebhookService {
  /** Jabat tangan GET. Mengembalikan `hub.challenge` untuk dipantulkan; melempar 403/503. */
  handshake(
    channel: Channel,
    query: unknown,
    client: ClientInfo,
    log: FastifyBaseLogger,
  ): Promise<string>;
  receive(input: {
    channel: Channel;
    rawBody: Buffer;
    headers: Record<string, unknown>;
    client: ClientInfo;
    log: FastifyBaseLogger;
  }): Promise<ReceiveSummary>;
}

export interface WhatsAppWebhookDeps {
  db: Database;
  secretBox: SecretBox | null;
  guard: WebhookGuard;
  queue: WebhookEventEnqueuer;
  now?: () => Date;
}

type SecretKind = 'appSecret' | 'verifyToken';

export function createWhatsAppWebhookService(deps: WhatsAppWebhookDeps): WhatsAppWebhookService {
  const { db, secretBox, guard, queue } = deps;
  const now = deps.now ?? (() => new Date());

  /** Rahasia channel; `null` = tidak bisa dibuka (master key kosong/berubah). */
  function openSecret(channel: Channel, kind: SecretKind): Secret<string> | null {
    const sealed =
      kind === 'appSecret' ? channel.waAppSecretEncrypted : channel.waVerifyTokenEncrypted;
    if (!secretBox || sealed === null) return null;
    try {
      return openChannelSecret(secretBox, channel, kind, sealed);
    } catch {
      return null;
    }
  }

  function requireSecret(
    channel: Channel,
    kind: SecretKind,
    log: FastifyBaseLogger,
  ): Secret<string> {
    const secret = openSecret(channel, kind);
    if (secret) return secret;
    log.error(
      { channelId: channel.id, secret: kind === 'appSecret' ? 'app_secret' : 'verify_token' },
      'Webhook tidak bisa diperiksa: rahasia channel tidak bisa dibuka (BALESIN_MASTER_KEY kosong atau berubah)',
    );
    throw webhookUnavailable();
  }

  return {
    async handshake(channel, query, client, log) {
      const handshake = parseWebhookHandshake(query);
      if (!handshake.ok) {
        await guard.recordRejection(channel, client, 'handshake_invalid', log);
        throw webhookRejected();
      }
      const stored = requireSecret(channel, 'verifyToken', log);
      if (!constantTimeEqual(handshake.verifyToken, stored.reveal())) {
        await guard.recordRejection(channel, client, 'handshake_invalid', log);
        throw webhookRejected();
      }
      log.info({ channelId: channel.id }, 'Jabat tangan webhook Meta berhasil');
      return handshake.challenge;
    },

    async receive({ channel, rawBody, headers, client, log }) {
      const appSecret = requireSecret(channel, 'appSecret', log);
      const check = verifyMetaWebhookSignature(rawBody, headers[META_SIGNATURE_HEADER], appSecret);
      if (check !== 'valid') {
        await guard.recordRejection(channel, client, `signature_${check}`, log);
        throw webhookRejected();
      }
      await guard.consumeChannelVolume(channel);

      const summary: ReceiveSummary = {
        stored: 0,
        duplicates: 0,
        misrouted: 0,
        stale: 0,
        invalid: 0,
        overLimit: 0,
        future: 0,
        rejected: 0,
        disabled: 0,
      };

      const body = parseWebhookJson(rawBody);
      const split = splitWhatsAppWebhook(body);
      summary.invalid = split.invalid;
      summary.overLimit = split.overLimit;
      if (!split.recognized) {
        log.warn(
          { channelId: channel.id, bytes: rawBody.length },
          'Webhook bertanda tangan sah tetapi bukan notifikasi WhatsApp Business Account — diabaikan',
        );
        return summary;
      }
      if (split.overLimit > 0) {
        log.warn(
          { channelId: channel.id, overLimit: split.overLimit, items: split.items.length },
          'Webhook melewati batas kejadian/nomor per notifikasi — kelebihannya dibuang',
        );
      }

      // ── Routing: channel pemilik nomor, bukan sekadar channel di URL (review D.4) ──
      // Meta mengirim notifikasi SEMUA nomor milik satu aplikasi ke satu URL callback. Nomor lain di
      // organisasi yang sama hanya diterima bila channelnya hidup, aktif, WABA-nya sama, dan App
      // Secret-nya SAMA (tanda tangan yang baru saja lolos juga sah untuk channel itu). Semua nomor
      // lain dimuat dengan SATU query (review webhook R2; jumlahnya dibatasi pemecah notifikasi).
      const otherNumbers = new Set<string>();
      for (const item of split.items) {
        if (item.phoneNumberId !== null && item.phoneNumberId !== channel.waPhoneNumberId) {
          otherNumbers.add(item.phoneNumberId);
        }
      }
      const siblings = new Map<string, Channel>();
      if (otherNumbers.size > 0) {
        let candidates: Map<string, Channel>;
        try {
          candidates = await findLiveChannelsByPhoneNumberIds(db, channel.organizationId, [
            ...otherNumbers,
          ]);
        } catch (error) {
          throw webhookUnavailable(error);
        }
        for (const [phoneNumberId, candidate] of candidates) {
          if (candidate.id === channel.id) continue;
          const secret = openSecret(candidate, 'appSecret');
          if (secret && constantTimeEqual(secret.reveal(), appSecret.reveal())) {
            siblings.set(phoneNumberId, candidate);
          }
        }
      }

      function targetFor(item: WhatsAppWebhookItem): Channel | null {
        if (item.kind === 'other') {
          return item.wabaId === channel.waBusinessAccountId ? channel : null;
        }
        if (
          item.phoneNumberId === channel.waPhoneNumberId &&
          item.wabaId === channel.waBusinessAccountId
        ) {
          return channel;
        }
        const sibling = siblings.get(item.phoneNumberId);
        return sibling && sibling.waBusinessAccountId === item.wabaId ? sibling : null;
      }

      const receivedAt = now();
      const oldest = receivedAt.getTime() - WEBHOOK_MAX_EVENT_AGE_MS;
      const newest = receivedAt.getTime() + WEBHOOK_MAX_FUTURE_SKEW_MS;
      const rows: NewWebhookEvent[] = [];
      for (const item of split.items) {
        if (item.occurredAt !== null) {
          const occurredAt = item.occurredAt.getTime();
          if (occurredAt < oldest) {
            summary.stale += 1;
            continue;
          }
          if (occurredAt > newest) {
            summary.future += 1;
            continue;
          }
        }
        const target = targetFor(item);
        if (!target) {
          summary.misrouted += 1;
          continue;
        }
        // Channel nonaktif tidak menerima pesan: dibuang, tetapi tetap dijawab 200 supaya Meta
        // berhenti mengirim ulang (KONTRAK-API-CHANNEL "Nonaktifkan").
        if (!target.enabled) {
          summary.disabled += 1;
          continue;
        }
        const skipped = item.kind === 'other';
        rows.push({
          organizationId: target.organizationId,
          channelId: target.id,
          source: 'whatsapp',
          kind: item.kind,
          field: item.field,
          dedupKey: item.dedupKey,
          externalId: item.externalId,
          payload: item.payload as unknown as Record<string, unknown>,
          occurredAt: item.occurredAt,
          receivedAt,
          // Field selain `messages` belum punya pemroses: disimpan untuk fase berikutnya.
          status: skipped ? 'skipped' : 'pending',
          processedAt: skipped ? receivedAt : null,
        });
      }

      if (summary.misrouted > 0) {
        log.warn(
          { channelId: channel.id, misrouted: summary.misrouted },
          'Webhook memuat nomor/WABA yang bukan milik channel ini — dibuang',
        );
      }
      if (summary.future > 0) {
        log.warn(
          { channelId: channel.id, future: summary.future },
          'Webhook memuat kejadian bercap waktu di masa depan — dibuang',
        );
      }

      if (rows.length > 0) {
        let result: Awaited<ReturnType<typeof insertWebhookEvents>>;
        try {
          result = await insertWebhookEvents(db, rows);
        } catch (error) {
          throw webhookUnavailable(error);
        }
        summary.stored = result.inserted.length;
        summary.duplicates = result.duplicates;
        summary.rejected = result.rejectedCodes.length;
        if (summary.rejected > 0) {
          // Hanya jumlah + kode Postgres: isi pesan tidak pernah masuk log.
          log.warn(
            {
              channelId: channel.id,
              rejected: summary.rejected,
              codes: [...new Set(result.rejectedCodes)].slice(0, 10),
            },
            'Sebagian kejadian webhook ditolak database karena datanya — dilewati',
          );
        }
        const jobs: WebhookEventJobPayload[] = [...result.inserted, ...result.pendingDuplicates]
          .filter((event) => event.status === 'pending')
          .map((event) => ({ organizationId: event.organizationId, eventId: event.id }));
        try {
          await queue.enqueue(jobs);
        } catch (error) {
          // Sudah tersimpan (pending). 503 → Meta mengirim ulang → baris pending diantre ulang.
          log.warn(
            { err: error, channelId: channel.id, events: jobs.length },
            'Kejadian webhook tersimpan tetapi belum bisa diantrekan',
          );
          throw webhookUnavailable();
        }
      }

      log.info(
        { channelId: channel.id, items: split.items.length, ...summary },
        'Webhook WhatsApp diterima',
      );
      return summary;
    },
  };
}
