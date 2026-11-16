import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Webhook keluar (Fase 3 — docs/KONTRAK-WEBHOOK-KELUAR.md). Dikelola `integrations.manage`
 * (Owner/Admin, PRD §4 "API key & webhook").
 *
 * Body setiap pengiriman: `{ id, event, created_at, data }` (API-N8N §3). Header:
 * `X-Balesin-Event`, `X-Balesin-Delivery`, `X-Balesin-Signature: t=<unix>,v1=<hex>[,v1=<hex lama>]`
 * dengan v1 = HMAC-SHA256(rahasia, `${t}.${body}`).
 */
export const OUTGOING_WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.status',
  'conversation.created',
  'conversation.assigned',
  'conversation.unassigned',
  'conversation.resolved',
  'conversation.reopened',
  'contact.created',
  'contact.updated',
] as const;
export const outgoingWebhookEventSchema = z.enum(OUTGOING_WEBHOOK_EVENTS, {
  error: 'Jenis event webhook tidak dikenal.',
});
export type OutgoingWebhookEvent = z.infer<typeof outgoingWebhookEventSchema>;

/** Event uji dari tombol "Kirim event tes" (tidak bisa dilanggani). */
export const OUTGOING_WEBHOOK_TEST_EVENT = 'webhook.test';

export const OUTGOING_WEBHOOK_EVENT_LABELS: Readonly<Record<OutgoingWebhookEvent, string>> = {
  'message.received': 'Pesan masuk dari pelanggan',
  'message.sent': 'Pesan keluar diterima WhatsApp',
  'message.status': 'Status pesan keluar (terkirim, dibaca, gagal)',
  'conversation.created': 'Percakapan baru',
  'conversation.assigned': 'Percakapan diambil / ditugaskan',
  'conversation.unassigned': 'Percakapan kembali ke antrian',
  'conversation.resolved': 'Percakapan selesai',
  'conversation.reopened': 'Percakapan dibuka lagi',
  'contact.created': 'Kontak baru',
  'contact.updated': 'Kontak diubah (termasuk tag)',
};

/** Port tujuan yang diizinkan (HTTPS 443/8443, HTTP 80/8080, n8n 5678). */
export const OUTGOING_WEBHOOK_PORTS = [80, 443, 5678, 8080, 8443] as const;
export const OUTGOING_WEBHOOKS_PER_ORGANIZATION_MAX = 10;
/** Gagal final beruntun sebelum endpoint dinonaktifkan otomatis. */
export const OUTGOING_WEBHOOK_AUTO_DISABLE_FAILURES = 20;
/** Masa tumpang tindih rahasia lama setelah rotasi (jam). */
export const OUTGOING_WEBHOOK_SECRET_OVERLAP_HOURS = 24;
/** Isi payload & potongan respons riwayat dikosongkan setelah N hari; baris dihapus setelah 30. */
export const OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS = 7;
export const OUTGOING_WEBHOOK_PRIVATE_CIDRS_MAX = 20;

const urlSchema = z
  .string({ error: 'URL webhook wajib diisi.' })
  .trim()
  .min(1, 'URL webhook wajib diisi.')
  .max(2048, 'URL webhook terlalu panjang.')
  .refine((value) => !hasControlCharacters(value), 'URL memuat karakter khusus.');

const eventsSchema = z
  .array(outgoingWebhookEventSchema)
  .min(1, 'Pilih minimal satu event.')
  .refine((items) => new Set(items).size === items.length, 'Event tidak boleh kembar.');

const descriptionSchema = z
  .string()
  .trim()
  .max(120, 'Keterangan maksimal 120 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Keterangan memuat karakter khusus.');

export const createOutgoingWebhookRequestSchema = z.object({
  url: urlSchema,
  events: eventsSchema,
  description: descriptionSchema.optional(),
  confirmation: identityConfirmationSchema.optional(),
});
export type CreateOutgoingWebhookRequest = z.input<typeof createOutgoingWebhookRequestSchema>;

/** Ubah: konfirmasi identitas WAJIB bila `url` berubah (jalur data pelanggan ke luar). */
export const updateOutgoingWebhookRequestSchema = z
  .object({
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .refine(
    (value) =>
      value.url !== undefined ||
      value.events !== undefined ||
      value.description !== undefined ||
      value.enabled !== undefined,
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateOutgoingWebhookRequest = z.input<typeof updateOutgoingWebhookRequestSchema>;

export const rotateOutgoingWebhookSecretRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});

export const outgoingWebhookSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(outgoingWebhookEventSchema),
  enabled: z.boolean(),
  /** `manual` / `auto_failures` (gagal beruntun) / `null`. */
  disabledReason: z.enum(['manual', 'auto_failures']).nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastDeliveryAt: isoDateTimeSchema.nullable(),
  secretRotatedAt: isoDateTimeSchema,
  /** Rahasia lama masih ikut ditandatangani sampai waktu ini (rotasi). */
  previousSecretExpiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type OutgoingWebhook = z.infer<typeof outgoingWebhookSchema>;

export const outgoingWebhookListResponseSchema = z.object({
  webhooks: z.array(outgoingWebhookSchema),
});
export const outgoingWebhookResponseSchema = z.object({ webhook: outgoingWebhookSchema });
/** Buat / rotasi: `secret` (`whsec_…`) ditampilkan SEKALI. */
export const outgoingWebhookSecretResponseSchema = z.object({
  webhook: outgoingWebhookSchema,
  secret: z.string(),
});
export const outgoingWebhookIdParamsSchema = z.object({ webhookId: z.string() });
export const outgoingWebhookDeliveryParamsSchema = z.object({
  webhookId: z.string(),
  deliveryId: z.string(),
});

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export const webhookDeliverySchema = z.object({
  id: z.uuid(),
  event: z.string(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int().nonnegative(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Kode galat singkat (`timeout`, `dns`, `blocked_address`, `redirect`, `http_500`, …). */
  error: z.string().nullable(),
  /** Potongan respons (≤ 500 karakter, dikosongkan setelah retensi). */
  responseSnippet: z.string().nullable(),
  /** Isi payload sudah dikosongkan (retensi) → tidak bisa dikirim ulang. */
  payloadPurged: z.boolean(),
  createdAt: isoDateTimeSchema,
  deliveredAt: isoDateTimeSchema.nullable(),
  nextAttemptAt: isoDateTimeSchema.nullable(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export const webhookDeliveryListResponseSchema = z.object({
  deliveries: z.array(webhookDeliverySchema),
  nextCursor: z.string().nullable(),
});
export const webhookDeliveryResponseSchema = z.object({ delivery: webhookDeliverySchema });
export const webhookDeliveryListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Allowlist IP privat (`integrations.manage`, + konfirmasi identitas): CIDR jaringan privat
 * (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) yang BOLEH dituju webhook keluar (mis. n8n di
 * LAN). Loopback, link-local, metadata cloud, multicast TIDAK PERNAH boleh.
 */
export const privateNetworkSettingsSchema = z.object({
  cidrs: z
    .array(z.string().trim().min(3).max(64))
    .max(
      OUTGOING_WEBHOOK_PRIVATE_CIDRS_MAX,
      `Maksimal ${String(OUTGOING_WEBHOOK_PRIVATE_CIDRS_MAX)} jaringan.`,
    ),
});
export type PrivateNetworkSettings = z.infer<typeof privateNetworkSettingsSchema>;
export const updatePrivateNetworkRequestSchema = privateNetworkSettingsSchema.extend({
  confirmation: identityConfirmationSchema.optional(),
});
export const privateNetworkResponseSchema = z.object({ settings: privateNetworkSettingsSchema });
