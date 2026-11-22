import { EMAIL_SENDER_VERIFICATIONS, MESSAGE_MEDIA_KINDS, MESSAGE_TYPES } from '@balesin/shared';
import { z } from 'zod';

/**
 * Bentuk NETRAL kejadian masuk dari channel selain WhatsApp (Fase 6) — disimpan sebagai
 * `webhook_events.payload` oleh penerima (api: Telegram, Messenger, Instagram) dan pengambil kotak
 * masuk (worker: Email), lalu dibaca ulang worker dengan skema yang SAMA (jsonb = tidak tepercaya).
 *
 * Semua teks di sini SUDAH dibersihkan pembuatnya (nama profil tanpa karakter tak terlihat, nama
 * berkas basename, URL hanya http(s)). Tidak pernah memuat token/rahasia/header mentah.
 */

const shortText = (max: number) => z.string().max(max);
/** Alamat email yang SUDAH dinormalkan pembuat payload (huruf kecil, tanpa spasi/kontrol). */
const emailListItem = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[^\s\p{Cc}<>@]+@[^\s\p{Cc}<>@]+$/u);

export const channelInboundSenderSchema = z.object({
  /** Kunci identitas kontak (`contacts.external_user_id`). */
  externalUserId: z
    .string()
    .min(1)
    .max(320)
    .regex(/^[^\s\p{Cc}]+$/u),
  /** `@username` / alamat email untuk ditampilkan (`contacts.channel_handle`). */
  handle: shortText(320).nullable(),
  /** Nama profil kiriman pelanggan (tidak tepercaya). */
  displayName: shortText(256).nullable(),
});

export const channelInboundMediaSchema = z.object({
  kind: z.enum(MESSAGE_MEDIA_KINDS),
  /** Rujukan media di platform (`file_id` Telegram, URL CDN Meta, `email:<id berkas>`). */
  ref: z.string().min(1).max(2048),
  mimeType: shortText(128).nullable(),
  filename: shortText(255).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  voice: z.boolean(),
  animated: z.boolean(),
  /** Email: berkas SUDAH disimpan pengambil kotak masuk (`media_files.id`). */
  mediaFileId: z.uuid().nullable(),
});

export const channelInboundMessageSchema = z.object({
  kind: z.literal('message'),
  /** ID pesan eksternal unik per channel (`messages.wamid`). */
  externalId: z.string().min(1).max(256),
  /** Cap waktu dari platform (ISO) — dijepit ke ≤ waktu diterima server. */
  sentAt: z.iso.datetime(),
  sender: channelInboundSenderSchema,
  type: z.enum(MESSAGE_TYPES),
  /** Jenis asli platform (`photo`, `voice`, `postback`, …) — `[a-z_]`, maks. 64. */
  rawType: z.string().regex(/^[a-z_]{1,64}$/),
  text: z.string().max(65_536).nullable(),
  media: channelInboundMediaSchema.nullable(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: shortText(256).nullable(),
      address: shortText(512).nullable(),
    })
    .nullable(),
  /** Balas-kutip: ID eksternal pesan yang dibalas (di channel yang sama). */
  replyToExternalId: z.string().min(1).max(256).nullable(),
  /** Tombol yang ditekan (Telegram callback / Messenger postback & quick reply). */
  reply: z
    .object({
      kind: z.enum(['button_reply', 'other']),
      id: shortText(256).nullable(),
      title: shortText(256).nullable(),
    })
    .nullable(),
  /** Email saja. */
  email: z
    .object({
      subject: shortText(998).nullable(),
      inReplyTo: z.string().max(256).nullable(),
      references: z.array(z.string().max(256)).max(20),
      authWarning: z.boolean(),
      /** Review Fase 6 R1. Payload lama tanpa isian ini = `unverified`. */
      senderVerification: z.enum(EMAIL_SENDER_VERIFICATIONS).default('unverified'),
      skippedAttachments: z.number().int().nonnegative(),
      /** HTML tersanitasi (disalin ke `message_email_bodies`). */
      html: z.string().max(524_288).nullable(),
      /** Lampiran yang sudah disimpan — masing-masing menjadi pesan media tersendiri. */
      attachments: z.array(channelInboundMediaSchema).max(20),
      /**
       * Tahap 9.0 (payload lama: kosong). `to`/`cc` = header (huruf kecil); `recipient` = alamat/alias
       * channel yang dituju (`emailDestination`); `replyAll` = To + Cc tanpa alamat sendiri & pengirim.
       */
      to: z.array(emailListItem).max(50).default([]),
      cc: z.array(emailListItem).max(50).default([]),
      recipient: emailListItem.nullable().default(null),
      replyAll: z.array(emailListItem).max(100).default([]),
    })
    .nullable(),
});
export type ChannelInboundMessage = z.infer<typeof channelInboundMessageSchema>;

/** Status pesan KELUAR dari platform (Messenger/Instagram `delivery`/`read`). */
export const channelInboundStatusSchema = z.object({
  kind: z.literal('status'),
  status: z.enum(['delivered', 'read']),
  /** `mid` pesan yang terantar (delivery); kosong untuk `read` (pakai `watermark`). */
  externalIds: z.array(z.string().min(1).max(256)).max(100),
  /** Semua pesan keluar ke pengguna ini sebelum waktu ini dianggap berstatus `status`. */
  watermark: z.iso.datetime().nullable(),
  recipientExternalUserId: z.string().min(1).max(320),
});
export type ChannelInboundStatus = z.infer<typeof channelInboundStatusSchema>;

export const channelInboundEventSchema = z.discriminatedUnion('kind', [
  channelInboundMessageSchema,
  channelInboundStatusSchema,
]);
export type ChannelInboundEvent = z.infer<typeof channelInboundEventSchema>;

/** Ubah ID eksternal panjang (mis. `Message-ID` email > 256) menjadi bentuk tetap yang muat. */
export function fitExternalId(value: string, hash: (value: string) => string): string {
  return value.length <= 256 ? value : `sha256:${hash(value)}`;
}
