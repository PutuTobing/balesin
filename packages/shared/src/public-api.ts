import { z } from 'zod';

import { contactAttributesSchema } from './inbox';
import { sendMessageRequestSchema } from './outbound';
import { tagNameSchema } from './tags';

/**
 * API publik v1 untuk integrasi (n8n, bot, sistem lain) — `Authorization: Bearer blsn_live_…`.
 * Alamat di bawah `/api/v1/public/*` (terpisah dari API web bersesi `/api/v1/*` dan dari lapisan
 * kompatibel MobiChat `/api/public/*`). Kontrak: docs/KONTRAK-API-PUBLIK.md.
 *
 * Bentuk respons memakai skema yang SAMA dengan API web (`Conversation`, `Message`, `Contact`).
 */

const [textOption, mediaOption, locationOption, reactionOption] = sendMessageRequestSchema.options;

/**
 * `POST /public/conversations/:id/messages` — sama dengan API web tanpa `clientMessageId`;
 * idempotensi lewat header `Idempotency-Key` (1–100 karakter, per API key).
 */
export const publicSendMessageRequestSchema = z.discriminatedUnion('type', [
  textOption.omit({ clientMessageId: true }),
  mediaOption.omit({ clientMessageId: true }),
  locationOption.omit({ clientMessageId: true }),
  reactionOption.omit({ clientMessageId: true }),
]);
export type PublicSendMessageRequest = z.infer<typeof publicSendMessageRequestSchema>;

/** Header lain DIBIARKAN (`looseObject`) — validasi header tidak boleh membuang header permintaan. */
export const idempotencyKeyHeaderSchema = z.looseObject({
  'idempotency-key': z
    .string()
    .min(1)
    .max(100, 'Idempotency-Key maksimal 100 karakter.')
    .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key hanya karakter ASCII terlihat.')
    .optional(),
});

/** `GET /public/contacts?q=|phone=` — cari kontak (maks. 50 hasil). */
export const publicContactSearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(100).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{6,14}$/, 'Nomor harus format E.164, mis. +6281234567890.')
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine((value) => value.q !== undefined || value.phone !== undefined, {
    error: 'Isi q (nama/nomor) atau phone.',
  });
export type PublicContactSearchQuery = z.infer<typeof publicContactSearchQuerySchema>;

/** `POST /public/contacts` — kontak WhatsApp baru dari nomor E.164. */
export const publicCreateContactRequestSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{6,14}$/, 'Nomor harus format E.164, mis. +6281234567890.'),
  name: z.string().trim().min(1).max(256).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ error: 'Alamat email tidak valid.' }))
    .optional(),
  attributes: contactAttributesSchema.optional(),
});
export type PublicCreateContactRequest = z.infer<typeof publicCreateContactRequestSchema>;

/**
 * `POST` / `DELETE /public/contacts/:id/tags` — pasang/lepas tag berdasarkan NAMA (seperti
 * MobiChat `tags/whatsapp`). Saat memasang, tag yang belum ada dibuat (warna biru).
 */
export const publicContactTagsRequestSchema = z.object({
  tags: z
    .array(tagNameSchema)
    .min(1, 'Isi minimal satu tag.')
    .max(20, 'Maksimal 20 tag per permintaan.'),
});
export type PublicContactTagsRequest = z.infer<typeof publicContactTagsRequestSchema>;
