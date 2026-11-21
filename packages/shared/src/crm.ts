import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';
import {
  CONTACT_ATTRIBUTE_KEY_MAX,
  CONTACT_ATTRIBUTE_VALUE_MAX,
  contactAttributeKeySchema,
  contactSchema,
  inboxCursorSchema,
} from './inbox';

/**
 * CRM Fase 5 (docs/KONTRAK-API-CRM-TIKET.md): definisi atribut kustom, daftar & cari kontak, ekspor
 * massal, gabung duplikat, dan impor massal. Definisi atribut dipakai KONTAK (per organisasi) dan
 * TIKET (per board) dengan aturan validasi yang sama (`validateAttributeValues`, murni — dipakai web
 * juga).
 */

// ── Definisi atribut kustom ─────────────────────────────────────────────────

export const ATTRIBUTE_TYPES = ['text', 'number', 'date', 'select'] as const;
export const attributeTypeSchema = z.enum(ATTRIBUTE_TYPES, {
  error: 'Jenis atribut tidak dikenal.',
});
export type AttributeType = z.infer<typeof attributeTypeSchema>;

export const ATTRIBUTE_TYPE_LABELS: Readonly<Record<AttributeType, string>> = {
  text: 'Teks',
  number: 'Angka',
  date: 'Tanggal',
  select: 'Pilihan',
};

export const ATTRIBUTE_DEFINITION_LIMITS = {
  /** Definisi atribut kontak per organisasi (= batas atribut per kontak). */
  contactPerOrganization: 30,
  /** Definisi atribut tiket per board. */
  ticketPerBoard: 30,
  labelMax: 60,
  optionsMax: 50,
  optionMax: 100,
} as const;

const attributeLabelSchema = z
  .string({ error: 'Label wajib diisi.' })
  .trim()
  .min(1, 'Label wajib diisi.')
  .max(
    ATTRIBUTE_DEFINITION_LIMITS.labelMax,
    `Label maksimal ${String(ATTRIBUTE_DEFINITION_LIMITS.labelMax)} karakter.`,
  )
  .refine((value) => !hasControlCharacters(value), 'Label memuat karakter khusus.');

const attributeOptionSchema = z
  .string()
  .trim()
  .min(1, 'Pilihan tidak boleh kosong.')
  .max(
    ATTRIBUTE_DEFINITION_LIMITS.optionMax,
    `Pilihan maksimal ${String(ATTRIBUTE_DEFINITION_LIMITS.optionMax)} karakter.`,
  )
  .refine((value) => !hasControlCharacters(value), 'Pilihan memuat karakter khusus.');

const attributeOptionsSchema = z
  .array(attributeOptionSchema)
  .max(
    ATTRIBUTE_DEFINITION_LIMITS.optionsMax,
    `Maksimal ${String(ATTRIBUTE_DEFINITION_LIMITS.optionsMax)} pilihan.`,
  )
  .refine(
    (items) => new Set(items.map((item) => item.toLocaleLowerCase('id-ID'))).size === items.length,
    'Pilihan tidak boleh kembar.',
  );

export const attributeDefinitionSchema = z.object({
  id: z.uuid(),
  /** Kunci yang tersimpan di `attributes[].key` (dibandingkan tanpa beda huruf besar/kecil). */
  key: z.string(),
  label: z.string(),
  type: attributeTypeSchema,
  required: z.boolean(),
  /** Hanya untuk `select` (selain itu kosong). */
  options: z.array(z.string()),
  position: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

export const attributeDefinitionListResponseSchema = z.object({
  attributes: z.array(attributeDefinitionSchema),
});
export type AttributeDefinitionListResponse = z.infer<typeof attributeDefinitionListResponseSchema>;
export const attributeDefinitionResponseSchema = z.object({ attribute: attributeDefinitionSchema });
export type AttributeDefinitionResponse = z.infer<typeof attributeDefinitionResponseSchema>;
export const attributeIdParamsSchema = z.object({ attributeId: z.string() });

/** `POST` definisi atribut. `select` wajib punya ≥ 1 pilihan; jenis lain tanpa pilihan. */
export const createAttributeDefinitionRequestSchema = z
  .object({
    key: contactAttributeKeySchema,
    label: attributeLabelSchema,
    type: attributeTypeSchema,
    required: z.boolean().default(false),
    options: attributeOptionsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'select' && value.options.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Atribut pilihan butuh minimal satu pilihan.',
      });
    }
    if (value.type !== 'select' && value.options.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Pilihan hanya untuk atribut berjenis Pilihan.',
      });
    }
  });
export type CreateAttributeDefinitionRequest = z.input<
  typeof createAttributeDefinitionRequestSchema
>;

/**
 * `PATCH` definisi atribut. Kunci TIDAK bisa diubah (nilai yang tersimpan memakai kunci itu); jenis
 * boleh diubah — nilai lama tidak divalidasi ulang sampai diubah lagi.
 */
export const updateAttributeDefinitionRequestSchema = z
  .object({
    label: attributeLabelSchema.optional(),
    type: attributeTypeSchema.optional(),
    required: z.boolean().optional(),
    options: attributeOptionsSchema.optional(),
    /** Urutan tampil (0 = paling atas). */
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateAttributeDefinitionRequest = z.infer<
  typeof updateAttributeDefinitionRequestSchema
>;

/** Bentuk minimal definisi untuk validasi nilai (dari DB atau respons API). */
export interface AttributeRule {
  key: string;
  label: string;
  type: AttributeType;
  required: boolean;
  options: readonly string[];
}

export interface AttributeValueIssue {
  key: string;
  message: string;
}

const foldKey = (key: string) => key.toLocaleLowerCase('id-ID');

/** Tanggal kalender `YYYY-MM-DD` yang benar-benar ada (mis. bukan 31 Februari). */
function isoDateOf(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Nilai tanggal → `YYYY-MM-DD`. Diterima: `YYYY-MM-DD`, `DD/MM/YYYY` / `DD-MM-YYYY` (kebiasaan
 * Indonesia), dan nomor seri tanggal Excel (sel tanggal XLSX tersimpan sebagai angka).
 */
export function normalizeAttributeDate(raw: string): string | null {
  const text = raw.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return isoDateOf(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) return isoDateOf(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{5})(?:\.0+)?$/.exec(text);
  if (match) {
    const serial = Number(match[1]);
    if (serial < 20_000 || serial > 80_000) return null;
    // Hari 0 Excel = 30 Des 1899 (sudah memperhitungkan bug tahun kabisat 1900).
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return isoDateOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  return null;
}

/** Angka → bentuk baku (titik desimal). Pemisah ribuan tidak diterima (ambigu `1.500`/`1,5`). */
export function normalizeAttributeNumber(raw: string): string | null {
  const text = raw.trim().replace(',', '.');
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole = '0', fraction] = (negative ? text.slice(1) : text).split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction?.replace(/0+$/, '');
  const value = decimals ? `${integer}.${decimals}` : integer;
  return negative && value !== '0' ? `-${value}` : value;
}

/**
 * Validasi + bakukan nilai atribut terhadap definisinya. Kunci tanpa definisi tetap boleh (atribut
 * bebas, seperti sebelum Fase 5) dan tidak diubah. Kunci yang punya definisi ditulis dengan ejaan
 * kunci definisinya. `enforceRequired` = semua atribut wajib harus ada (simpan dari aplikasi /
 * tiket); impor & API kontak tidak memaksanya (bot tidak tahu definisi organisasi).
 */
export function validateAttributeValues(
  rules: readonly AttributeRule[],
  values: readonly { key: string; value: string }[],
  options: { enforceRequired: boolean },
):
  | { ok: true; values: { key: string; value: string }[] }
  | { ok: false; issues: AttributeValueIssue[] } {
  const byKey = new Map(rules.map((rule) => [foldKey(rule.key), rule]));
  const issues: AttributeValueIssue[] = [];
  const result: { key: string; value: string }[] = [];
  const present = new Set<string>();
  for (const item of values) {
    const folded = foldKey(item.key);
    const rule = byKey.get(folded);
    if (!rule) {
      result.push({ key: item.key, value: item.value });
      present.add(folded);
      continue;
    }
    present.add(folded);
    const text = item.value.trim();
    let value: string | null = text;
    switch (rule.type) {
      case 'text':
        value = text.length > 0 ? text : null;
        if (value === null) issues.push({ key: rule.key, message: `${rule.label} wajib diisi.` });
        break;
      case 'number':
        value = normalizeAttributeNumber(text);
        if (value === null) {
          issues.push({
            key: rule.key,
            message: `${rule.label} harus berupa angka (mis. 150000).`,
          });
        }
        break;
      case 'date':
        value = normalizeAttributeDate(text);
        if (value === null) {
          issues.push({
            key: rule.key,
            message: `${rule.label} harus tanggal yang valid (mis. 2026-12-31 atau 31/12/2026).`,
          });
        }
        break;
      case 'select': {
        const option = rule.options.find((candidate) => foldKey(candidate) === foldKey(text));
        value = option ?? null;
        if (value === null) {
          issues.push({
            key: rule.key,
            message: `${rule.label} harus salah satu pilihan: ${rule.options.join(', ')}.`,
          });
        }
        break;
      }
    }
    if (value !== null) result.push({ key: rule.key, value });
  }
  if (options.enforceRequired) {
    for (const rule of rules) {
      if (rule.required && !present.has(foldKey(rule.key))) {
        issues.push({ key: rule.key, message: `${rule.label} wajib diisi.` });
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, values: result };
}

// ── Daftar & cari kontak ────────────────────────────────────────────────────

export const CONTACT_LIST_PAGE_DEFAULT = 50;
export const CONTACT_LIST_PAGE_MAX = 100;

/**
 * Saringan bersama daftar kontak & ekspor massal. `q` = nama/nama profil/username/potongan nomor
 * (2–100). `attributeKey` + `attributeValue` = atribut sama persis (tanpa beda huruf besar/kecil
 * pada kunci). `possibleDuplicate=true` = hanya kontak bertanda "mungkin duplikat".
 */
export const contactFilterFields = {
  q: z
    .string()
    .trim()
    .min(2, 'Kata pencarian minimal 2 karakter.')
    .max(100, 'Kata pencarian terlalu panjang (maks. 100 karakter).')
    .optional(),
  tagId: z.uuid({ error: 'Tag tidak valid.' }).optional(),
  attributeKey: z.string().trim().min(1).max(CONTACT_ATTRIBUTE_KEY_MAX).optional(),
  attributeValue: z.string().trim().min(1).max(CONTACT_ATTRIBUTE_VALUE_MAX).optional(),
  possibleDuplicate: z
    .enum(['true', 'false'], { error: 'Nilai harus true atau false.' })
    .transform((value) => value === 'true')
    .optional(),
};

const contactFilterObject = z.object(contactFilterFields);
const attributePairRefine = (value: { attributeKey?: string; attributeValue?: string }) =>
  (value.attributeKey === undefined) === (value.attributeValue === undefined);
const ATTRIBUTE_PAIR_MESSAGE = 'Isi nama dan nilai atribut bersamaan.';

export const contactFilterSchema = contactFilterObject.refine(attributePairRefine, {
  error: ATTRIBUTE_PAIR_MESSAGE,
});
export type ContactFilter = z.infer<typeof contactFilterSchema>;

/** `GET /contacts` — terbaru dibuat dulu; kursor = halaman berikutnya. */
export const contactListQuerySchema = contactFilterObject
  .extend({
    cursor: inboxCursorSchema.optional(),
    limit: z.coerce
      .number({ error: 'Jumlah per halaman harus angka.' })
      .int()
      .min(1)
      .max(CONTACT_LIST_PAGE_MAX, `Paling banyak ${String(CONTACT_LIST_PAGE_MAX)} per halaman.`)
      .optional(),
  })
  .refine(attributePairRefine, { error: ATTRIBUTE_PAIR_MESSAGE });
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const contactListResponseSchema = z.object({
  contacts: z.array(contactSchema),
  nextCursor: z.string().nullable(),
});
export type ContactListResponse = z.infer<typeof contactListResponseSchema>;

// ── Ekspor massal ───────────────────────────────────────────────────────────

/** Batas baris satu ekspor (lebih → 409, persempit saringan). */
export const CONTACT_BULK_EXPORT_MAX = 50_000;

/**
 * `POST /contacts/export` (`contacts.export`) — CSV kontak (data pribadi, UU PDP). WAJIB konfirmasi
 * identitas; diaudit; sel kebal injeksi rumus. POST (bukan GET) supaya CSRF + body konfirmasi.
 */
export const contactBulkExportRequestSchema = z.object({
  filter: contactFilterSchema.default({}),
  confirmation: identityConfirmationSchema.optional(),
});
export type ContactBulkExportRequest = z.input<typeof contactBulkExportRequestSchema>;

// ── Gabung duplikat ─────────────────────────────────────────────────────────

/**
 * `POST /contacts/:contactId/merge` (`contacts.manage`) — kontak `sourceContactId` DIGABUNG ke
 * `:contactId` (yang dipertahankan) lalu dihapus. Tidak bisa dibatalkan → konfirmasi identitas.
 */
export const mergeContactRequestSchema = z.object({
  sourceContactId: z.uuid({ error: 'Kontak yang digabung tidak valid.' }),
  confirmation: identityConfirmationSchema.optional(),
});
export type MergeContactRequest = z.input<typeof mergeContactRequestSchema>;

export const mergeContactResponseSchema = z.object({
  contact: contactSchema,
  moved: z.object({
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    tickets: z.number().int().nonnegative(),
  }),
});
export type MergeContactResponse = z.infer<typeof mergeContactResponseSchema>;

// ── Impor massal ────────────────────────────────────────────────────────────

export const CONTACT_IMPORT_MODES = ['upsert', 'create_only'] as const;
export const contactImportModeSchema = z.enum(CONTACT_IMPORT_MODES, {
  error: 'Mode impor tidak dikenal.',
});
export type ContactImportMode = z.infer<typeof contactImportModeSchema>;

/** Baris impor yang dilewati. */
export const CONTACT_IMPORT_ISSUES = [
  'phone_missing',
  'phone_invalid',
  'phone_scientific',
  'duplicate',
  'value_too_long',
  'name_invalid',
  'email_invalid',
  'attribute_invalid',
  'attributes_limit',
  'tag_invalid',
  'tags_limit',
  'exists',
] as const;
export type ContactImportIssue = (typeof CONTACT_IMPORT_ISSUES)[number];

export const CONTACT_IMPORT_ISSUE_LABELS: Readonly<Record<ContactImportIssue, string>> = {
  phone_missing: 'Nomor kosong',
  phone_invalid: 'Nomor tidak valid',
  phone_scientific: 'Nomor tertulis sebagai angka ilmiah (ubah sel menjadi teks)',
  duplicate: 'Nomor ganda di berkas (baris pertama dipakai)',
  value_too_long: 'Ada isian lebih dari 500 karakter',
  name_invalid: 'Nama terlalu panjang atau memuat karakter khusus',
  email_invalid: 'Alamat email tidak valid',
  attribute_invalid: 'Nilai atribut tidak sesuai jenisnya',
  attributes_limit: 'Atribut kontak melebihi 30',
  tag_invalid: 'Nama tag tidak valid',
  tags_limit: 'Tag melebihi batas (per kontak atau organisasi)',
  exists: 'Nomor sudah terdaftar (mode hanya kontak baru)',
};

/**
 * Pemetaan kolom berkas → isian kontak. `attributes[].key` = kunci atribut (bebas atau dari
 * definisi). `tagsColumn` = nama tag dipisah koma/titik koma (tag yang belum ada dibuat).
 */
export const contactImportMappingSchema = z.object({
  phoneColumn: z.string().trim().min(1, 'Pilih kolom nomor.').max(64),
  nameColumn: z.string().trim().min(1).max(64).nullable().default(null),
  emailColumn: z.string().trim().min(1).max(64).nullable().default(null),
  notesColumn: z.string().trim().min(1).max(64).nullable().default(null),
  tagsColumn: z.string().trim().min(1).max(64).nullable().default(null),
  attributes: z
    .array(z.object({ column: z.string().trim().min(1).max(64), key: contactAttributeKeySchema }))
    .max(30, 'Maksimal 30 kolom atribut.')
    .default([]),
  /** `upsert` = kontak yang sudah ada diperbarui (isian yang dipetakan saja); `create_only` = dilewati. */
  mode: contactImportModeSchema.default('upsert'),
  /** `true` = hanya periksa (tanpa menyimpan) — untuk pratinjau hasil. */
  dryRun: z.boolean().default(false),
  /**
   * Konfirmasi identitas — WAJIB untuk impor sungguhan mode `upsert` (menimpa data kontak yang ada
   * secara massal; review Fase 5 Info 3). `dryRun` dan `create_only` tidak memerlukannya.
   */
  confirmation: identityConfirmationSchema.optional(),
});
export type ContactImportMapping = z.infer<typeof contactImportMappingSchema>;

export const contactImportResultSchema = z.object({
  dryRun: z.boolean(),
  sourceRows: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  issueCounts: z.record(z.enum(CONTACT_IMPORT_ISSUES), z.number().int().nonnegative()),
  /** Rincian baris bermasalah (maks. 200; sisanya hanya dihitung). Tanpa isi sel. */
  issues: z.array(
    z.object({
      row: z.number().int().positive(),
      issue: z.enum(CONTACT_IMPORT_ISSUES),
      /** Kunci atribut yang ditolak (untuk `attribute_invalid`). */
      key: z.string().optional(),
    }),
  ),
});
export type ContactImportResult = z.infer<typeof contactImportResultSchema>;
