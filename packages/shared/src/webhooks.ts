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
