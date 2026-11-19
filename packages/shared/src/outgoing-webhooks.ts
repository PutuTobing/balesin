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
  'conversation.handoff',
  'contact.created',
  'contact.updated',
  'ticket.created',
  'ticket.updated',
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
  'conversation.handoff': 'Bot menyerahkan percakapan ke tim',
  'contact.created': 'Kontak baru',
  'contact.updated': 'Kontak diubah (termasuk tag)',
  'ticket.created': 'Tiket baru',
  'ticket.updated': 'Tiket diubah (isian, kolom/status, penanggung jawab, komentar)',
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

/**
 * Bentuk body: `native` (`{ id, event, created_at, data }`) atau `mobichat` (body webhook MobiChat +
 * `mobichat_base_url`/`mobichat_api_key`, docs/KONTRAK-API-MOBICHAT.md). Tidak bisa diubah setelah
 * webhook dibuat.
 */
export const OUTGOING_WEBHOOK_FORMATS = ['native', 'mobichat'] as const;
export const outgoingWebhookFormatSchema = z.enum(OUTGOING_WEBHOOK_FORMATS, {
  error: 'Format webhook tidak dikenal.',
});
export type OutgoingWebhookFormat = z.infer<typeof outgoingWebhookFormatSchema>;

/** Mode MobiChat hanya mengirim pesan masuk pelanggan (seperti bot eksternal MobiChat). */
export const MOBICHAT_WEBHOOK_EVENTS = ['message.received'] as const;

/**
 * Pengaturan mode MobiChat. `apiKey` = API key Balesin UTUH (`blsn_live_…`, dibuat di Pengaturan →
 * API key) yang disisipkan ke setiap body sebagai `mobichat_api_key` supaya node Code n8n bisa
 * memanggil balik. Disimpan terenkripsi, tampil 4 karakter terakhir saja. `baseUrl` = alamat Balesin
 * yang dipakai n8n (`null` = alamat aplikasi, `APP_URL`); http/https tanpa query/kredensial.
 */
const mobichatBaseUrlSchema = z
  .string()
  .trim()
  .min(8, 'Alamat server aplikasi terlalu pendek.')
  .max(2048, 'Alamat server aplikasi terlalu panjang.')
  .refine((value) => !hasControlCharacters(value), 'Alamat memuat karakter khusus.');
const mobichatApiKeySchema = z
  .string({ error: 'API key wajib diisi.' })
  .trim()
  .min(1, 'API key wajib diisi.')
  .max(200, 'API key tidak valid.');

export const outgoingWebhookMobichatInputSchema = z.object({
  baseUrl: mobichatBaseUrlSchema.nullable().optional(),
  apiKey: mobichatApiKeySchema,
});
export const outgoingWebhookMobichatPatchSchema = z
  .object({
    baseUrl: mobichatBaseUrlSchema.nullable().optional(),
    apiKey: mobichatApiKeySchema.optional(),
  })
  .refine((value) => value.baseUrl !== undefined || value.apiKey !== undefined, {
    error: 'Tidak ada pengaturan MobiChat yang diubah.',
  });

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

export const createOutgoingWebhookRequestSchema = z
  .object({
    url: urlSchema,
    events: eventsSchema,
    description: descriptionSchema.optional(),
    /** Bawaan `native`. */
    format: outgoingWebhookFormatSchema.optional(),
    /** Wajib bila `format` = `mobichat`; dilarang untuk `native`. */
    mobichat: outgoingWebhookMobichatInputSchema.optional(),
    /**
     * `true` = `message.received` hanya dikirim saat BOT memegang percakapan (status `bot`) — untuk
     * penerima yang berperan sebagai bot. Bawaan `false` (semua pesan masuk; bot memutuskan sendiri).
     */
    botOnly: z.boolean().optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.format === 'mobichat') {
      if (!value.mobichat) {
        context.addIssue({
          code: 'custom',
          path: ['mobichat', 'apiKey'],
          message: 'Mode MobiChat butuh API key untuk disisipkan ke webhook.',
        });
      }
      if (
        value.events.some(
          (event) => !(MOBICHAT_WEBHOOK_EVENTS as readonly string[]).includes(event),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['events'],
          message: 'Mode MobiChat hanya mengirim event "message.received" (pesan masuk).',
        });
      }
    } else if (value.mobichat) {
      context.addIssue({
        code: 'custom',
        path: ['mobichat'],
        message: 'Pengaturan MobiChat hanya untuk webhook format MobiChat.',
      });
    }
  });
export type CreateOutgoingWebhookRequest = z.input<typeof createOutgoingWebhookRequestSchema>;

/** Ubah: konfirmasi identitas WAJIB bila `url` berubah (jalur data pelanggan ke luar). */
export const updateOutgoingWebhookRequestSchema = z
  .object({
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    /** Hanya webhook format MobiChat. Mengubah `apiKey`/`baseUrl` = wajib konfirmasi identitas. */
    mobichat: outgoingWebhookMobichatPatchSchema.optional(),
    botOnly: z.boolean().optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .refine(
    (value) =>
      value.botOnly !== undefined ||
      value.url !== undefined ||
      value.events !== undefined ||
      value.description !== undefined ||
      value.enabled !== undefined ||
      value.mobichat !== undefined,
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateOutgoingWebhookRequest = z.input<typeof updateOutgoingWebhookRequestSchema>;

export const rotateOutgoingWebhookSecretRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
  /**
   * `true` = rahasia LAMA langsung berhenti ditandatangani (bila bocor). Bawaan: tetap ikut 24 jam
   * supaya penerima sempat berganti tanpa menolak pengiriman.
   */
  revokePrevious: z.boolean().optional(),
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
  /** Server selalu mengisi; opsional di skema supaya data tiruan web lama tetap sah. */
  format: outgoingWebhookFormatSchema.optional(),
  /** `message.received` hanya saat bot memegang percakapan. Server selalu mengisi. */
  botOnly: z.boolean().optional(),
  /**
   * Mode MobiChat (`null` untuk `native`). API key TIDAK PERNAH dikirim — hanya 4 karakter
   * terakhirnya + key yang dipakai (nama, status) supaya admin tahu kapan harus menggantinya.
   */
  mobichat: z
    .object({
      baseUrl: z.string().nullable(),
      apiKeyLast4: z.string(),
      apiKeyId: z.uuid(),
      apiKeyName: z.string().nullable(),
      apiKeyStatus: z.enum(['active', 'expired', 'revoked']),
    })
    .nullable()
    .optional(),
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
