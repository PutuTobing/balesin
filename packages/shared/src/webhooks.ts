import { z } from 'zod';

import { isoDateTimeSchema } from './fields';

/**
 * Kejadian webhook masuk (tabel `webhook_events`). Dipakai DB (enum), api (penerima), dan worker
 * (pemroses). Belum ada endpoint web yang menampilkannya — nanti untuk layar diagnosis webhook.
 */

/** Jenis kejadian hasil pemecahan satu notifikasi Meta. */
export const WEBHOOK_EVENT_KINDS = [
  /** Pesan masuk dari pelanggan (`value.messages[]`). Unik per (channel, wamid). */
  'message',
  /** Status pesan keluar (`value.statuses[]`). Unik per (channel, wamid, status). */
  'status',
  /** Error tingkat sistem/aplikasi/akun (`value.errors[]`). */
  'error',
  /** Field langganan lain (status template, pembaruan akun, …): disimpan, belum diproses. */
  'other',
] as const;
export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

/** Status pemrosesan kejadian oleh worker. */
export const WEBHOOK_EVENT_STATUSES = [
  /** Tersimpan, menunggu/sedang diulang worker. */
  'pending',
  /** Selesai dinormalisasi dan diteruskan ke pemroses berikutnya. */
  'processed',
  /** Gagal permanen (percobaan habis, atau payload rusak). `last_error` = kode singkat. */
  'failed',
  /** Sengaja tidak diproses (jenis yang belum ditangani). */
  'skipped',
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

// ── Diagnosis webhook per channel (`GET /settings/channels/:id/webhook-health`) ──

/**
 * Ringkasan kesehatan webhook satu channel (`channels.manage`), TANPA payload/isi pesan:
 *  - `status`: `ok` (ada kejadian 24 jam, tanpa masalah), `idle` (tidak ada kejadian 24 jam — cek
 *    langganan webhook di Meta), `attention` (ada gagal / ditolak / tanda tangan gagal / macet);
 *  - `last24h`: hitungan kejadian sejak 24 jam lalu menurut `received_at` (`rejected` = baris stub
 *    yang ditolak database, review N2; `expiredPending` = macet melewati retensi);
 *  - `signatureFailures`: POST dengan tanda tangan Meta salah/tidak ada (±24 jam, jendela tetap).
 */
export const WEBHOOK_HEALTH_STATUSES = ['ok', 'idle', 'attention'] as const;

export const webhookHealthSchema = z.object({
  status: z.enum(WEBHOOK_HEALTH_STATUSES),
  lastReceivedAt: isoDateTimeSchema.nullable(),
  lastProcessedAt: isoDateTimeSchema.nullable(),
  last24h: z.object({
    received: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    expiredPending: z.number().int().nonnegative(),
    signatureFailures: z.number().int().nonnegative(),
  }),
  /** Kejadian `pending` tertua lebih dari 10 menit (worker macet / mati). */
  stalledPending: z.number().int().nonnegative(),
  lastSignatureFailureAt: isoDateTimeSchema.nullable(),
  checkedAt: isoDateTimeSchema,
});
export type WebhookHealth = z.infer<typeof webhookHealthSchema>;
export const webhookHealthResponseSchema = z.object({ health: webhookHealthSchema });
