import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';

/**
 * Template percakapan / quick reply `/` (Fase 2 butir 9 — docs/KONTRAK-API-INBOX.md "Quick reply").
 *
 * - Kelola (buat/ubah/hapus) = `quick_replies.manage` (Owner, Admin, Supervisor — PRD §4).
 * - Dipakai di composer = `inbox.reply`: daftar + cari, lalu `POST /quick-replies/:id/use` dengan
 *   percakapan tujuan → server mengisi variabel dan menaikkan penghitung pemakaian. Teks hasilnya
 *   dimasukkan ke composer dan dikirim seperti pesan biasa (jendela 24 jam, batas kirim, dsb.).
 *
 * Variabel (DECISIONS 2026-11-17) — hanya dua, sengaja sederhana:
 *  - `{nama}` → nama kontak: nama dari tim → nama profil WhatsApp → "Kak";
 *  - `{agen}` → nama agen yang memakai template.
 * Kurung kurawal lain yang berbentuk variabel (`{kata}`) ditolak saat menyimpan, supaya salah ketik
 * tidak terkirim apa adanya ke pelanggan.
 */
export const QUICK_REPLY_VARIABLES = ['nama', 'agen'] as const;
export type QuickReplyVariable = (typeof QUICK_REPLY_VARIABLES)[number];

export const QUICK_REPLY_VARIABLE_LABELS: Readonly<Record<QuickReplyVariable, string>> = {
  nama: 'Nama kontak',
  agen: 'Nama agen',
};

/** Pengganti `{nama}` bila kontak belum punya nama. */
export const QUICK_REPLY_NAME_FALLBACK = 'Kak';

export const QUICK_REPLY_SHORTCUT_MAX = 32;
export const QUICK_REPLY_TITLE_MAX = 80;
/** Isi ≤ 3.500 supaya setelah variabel diisi tetap muat di batas teks WhatsApp (4.096). */
export const QUICK_REPLY_BODY_MAX = 3_500;
export const QUICK_REPLIES_PER_ORGANIZATION_MAX = 500;

/** Pola variabel di isi: `{kata}` (huruf/angka/garis bawah). */
export const QUICK_REPLY_VARIABLE_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Shortcut: diketik setelah `/` di composer. Huruf kecil, angka, `-`, `_`; 1–32 karakter; diawali
 * huruf/angka. `/` di depan dan huruf besar dinormalkan.
 */
export const quickReplyShortcutSchema = z
  .string({ error: 'Shortcut wajib diisi.' })
  .trim()
  .transform((value) => value.replace(/^\/+/, '').toLowerCase())
  .pipe(
    z
      .string()
      .min(1, 'Shortcut wajib diisi.')
      .max(
        QUICK_REPLY_SHORTCUT_MAX,
        `Shortcut maksimal ${String(QUICK_REPLY_SHORTCUT_MAX)} karakter.`,
      )
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        'Shortcut hanya boleh huruf, angka, tanda hubung, dan garis bawah (tanpa spasi).',
      ),
  );

export const quickReplyTitleSchema = z
  .string({ error: 'Judul wajib diisi.' })
  .trim()
  .min(1, 'Judul wajib diisi.')
  .max(QUICK_REPLY_TITLE_MAX, `Judul maksimal ${String(QUICK_REPLY_TITLE_MAX)} karakter.`)
  .refine((value) => !hasControlCharacters(value), 'Judul memuat karakter khusus.');

/** Variabel di isi yang tidak dikenal (urutan pertama muncul, tanpa duplikat). */
export function unknownQuickReplyVariables(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(QUICK_REPLY_VARIABLE_PATTERN)) {
    const name = match[1] ?? '';
    if (!(QUICK_REPLY_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

export const quickReplyBodySchema = z
  .string({ error: 'Isi wajib diisi.' })
  .trim()
  .min(1, 'Isi wajib diisi.')
  .max(
    QUICK_REPLY_BODY_MAX,
    `Isi maksimal ${QUICK_REPLY_BODY_MAX.toLocaleString('id-ID')} karakter.`,
  )
  // Baris baru & tab boleh; karakter kendali/format tak terlihat lain tidak.
  .refine(
    (value) => !hasControlCharacters(value.replace(/\r?\n|\t/g, ' ')),
    'Isi memuat karakter khusus tak terlihat.',
  )
  .superRefine((value, context) => {
    const unknown = unknownQuickReplyVariables(value);
    if (unknown.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `Variabel ${unknown.map((name) => `{${name}}`).join(', ')} tidak dikenal. Yang tersedia: {nama}, {agen}.`,
      });
    }
  });

/**
 * Isi variabel. Hanya `{nama}` dan `{agen}` yang diganti; nilai pengganti TIDAK diproses ulang
 * (nama yang memuat `{agen}` tetap teks apa adanya).
 */
export function renderQuickReply(
  body: string,
  values: Readonly<Record<QuickReplyVariable, string>>,
): string {
  return body.replace(QUICK_REPLY_VARIABLE_PATTERN, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name as QuickReplyVariable] : whole,
  );
}

export const quickReplySchema = z.object({
  id: z.uuid(),
  shortcut: z.string(),
  title: z.string(),
  body: z.string(),
  usageCount: z.number().int().nonnegative(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  /** Terakhir diubah oleh (null = pengguna sudah tidak ada). */
  updatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type QuickReply = z.infer<typeof quickReplySchema>;

/** `GET /quick-replies?q=` — urut paling sering dipakai, lalu shortcut. Maks. 500 (semua). */
export const quickReplyListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(50, 'Kata pencarian terlalu panjang (maks. 50 karakter).')
    .optional(),
});
export type QuickReplyListQuery = z.infer<typeof quickReplyListQuerySchema>;

export const quickReplyListResponseSchema = z.object({ quickReplies: z.array(quickReplySchema) });
export type QuickReplyListResponse = z.infer<typeof quickReplyListResponseSchema>;
export const quickReplyResponseSchema = z.object({ quickReply: quickReplySchema });
export type QuickReplyResponse = z.infer<typeof quickReplyResponseSchema>;

export const quickReplyIdParamsSchema = z.object({ quickReplyId: z.string() });

export const createQuickReplyRequestSchema = z.object({
  shortcut: quickReplyShortcutSchema,
  title: quickReplyTitleSchema,
  body: quickReplyBodySchema,
});
export type CreateQuickReplyRequest = z.input<typeof createQuickReplyRequestSchema>;

export const updateQuickReplyRequestSchema = z
  .object({
    shortcut: quickReplyShortcutSchema.optional(),
    title: quickReplyTitleSchema.optional(),
    body: quickReplyBodySchema.optional(),
  })
  .refine(
    (value) =>
      value.shortcut !== undefined || value.title !== undefined || value.body !== undefined,
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateQuickReplyRequest = z.input<typeof updateQuickReplyRequestSchema>;

/** `POST /quick-replies/:id/use` — isi variabel untuk percakapan ini (`inbox.reply` + cakupan). */
export const useQuickReplyRequestSchema = z.object({
  conversationId: z.uuid({ error: 'Percakapan tidak valid.' }),
});
export type UseQuickReplyRequest = z.infer<typeof useQuickReplyRequestSchema>;
export const useQuickReplyResponseSchema = z.object({
  /** Teks siap dimasukkan ke composer. */
  text: z.string(),
});
export type UseQuickReplyResponse = z.infer<typeof useQuickReplyResponseSchema>;
