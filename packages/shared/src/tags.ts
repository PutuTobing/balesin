import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';

/**
 * Tag (Fase 2 butir 8 — docs/KONTRAK-API-INBOX.md "Panel detail").
 *
 * Tag menempel ke KONTAK (bukan ke percakapan) — sama dengan API n8n/MobiChat (`/contacts/:id/tags`,
 * `PUT /api/public/tags/whatsapp`) dan pola pemakaian tag segmen pelanggan (mis. `MITRA-SURYA`). Saringan
 * `tagId` di daftar percakapan = percakapan yang kontaknya memakai tag itu (DECISIONS 2026-11-17).
 *
 * Warna = KUNCI palet (web memetakannya ke token desain terang/gelap), bukan hex bebas: tidak ada
 * warna di luar token dan kontras teks dijamin oleh web.
 */
export const TAG_COLORS = [
  'gray',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
  'teal',
] as const;
export const tagColorSchema = z.enum(TAG_COLORS, { error: 'Warna tag tidak dikenal.' });
export type TagColor = z.infer<typeof tagColorSchema>;

export const TAG_COLOR_LABELS: Readonly<Record<TagColor, string>> = {
  gray: 'Abu-abu',
  blue: 'Biru',
  green: 'Hijau',
  yellow: 'Kuning',
  orange: 'Jingga',
  red: 'Merah',
  purple: 'Ungu',
  teal: 'Toska',
};

export const TAG_NAME_MAX = 40;
/** Batas jumlah tag per organisasi (master) dan per kontak. */
export const TAGS_PER_ORGANIZATION_MAX = 300;
export const TAGS_PER_CONTACT_MAX = 20;

/** Nama tag: satu baris, 1–40 karakter. Unik per organisasi TANPA membedakan huruf besar/kecil. */
export const tagNameSchema = z
  .string({ error: 'Nama tag wajib diisi.' })
  .trim()
  .min(1, 'Nama tag wajib diisi.')
  .max(TAG_NAME_MAX, `Nama tag maksimal ${String(TAG_NAME_MAX)} karakter.`)
  .refine((value) => !hasControlCharacters(value), 'Nama tag memuat karakter khusus.');

/** Tag ringkas (di kontak, daftar percakapan, log). */
export const tagRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: tagColorSchema,
});
export type TagRef = z.infer<typeof tagRefSchema>;

export const tagSchema = tagRefSchema.extend({
  /** Jumlah kontak yang memakai tag ini. */
  contactCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Tag = z.infer<typeof tagSchema>;

export const tagListResponseSchema = z.object({ tags: z.array(tagSchema) });
export type TagListResponse = z.infer<typeof tagListResponseSchema>;
export const tagResponseSchema = z.object({ tag: tagSchema });
export type TagResponse = z.infer<typeof tagResponseSchema>;

export const tagIdParamsSchema = z.object({ tagId: z.string() });

/** `POST /tags` (`contacts.manage`). Warna bawaan biru. */
export const createTagRequestSchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema.default('blue'),
});
export type CreateTagRequest = z.input<typeof createTagRequestSchema>;

/** `PATCH /tags/:tagId` (`settings.workspace.manage`): ganti nama dan/atau warna. */
export const updateTagRequestSchema = z
  .object({ name: tagNameSchema.optional(), color: tagColorSchema.optional() })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    error: 'Isi nama atau warna baru.',
  });
export type UpdateTagRequest = z.infer<typeof updateTagRequestSchema>;

/** `POST /contacts/:contactId/tags` (`contacts.manage`). */
export const addContactTagRequestSchema = z.object({
  tagId: z.uuid({ error: 'Tag tidak valid.' }),
});
export type AddContactTagRequest = z.infer<typeof addContactTagRequestSchema>;
export const contactTagParamsSchema = z.object({ contactId: z.string(), tagId: z.string() });
