import { z } from 'zod';

import { emailStatusSchema } from './email-send';
import { EMAIL_TEMPLATE_PRESET_KEYS } from './email-template-presets';
import { hasControlCharacters } from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Tahap 9.1 — Pengaturan → Template email (docs/KONTRAK-API-EMAIL-KIRIM.md §7). BEDA dengan
 * `email-templates.ts` (email sistem undangan/reset). Template punya draf (bebas disimpan) dan versi
 * terbit (dipakai API; terbit = konfirmasi identitas). Izin `templates.manage`.
 */

export const EMAIL_TEMPLATE_LAYOUTS = ['brand', 'none'] as const;
export type EmailTemplateLayout = (typeof EMAIL_TEMPLATE_LAYOUTS)[number];
export const EMAIL_TEMPLATE_VERSION_STATES = ['draft', 'published', 'superseded'] as const;
export type EmailTemplateVersionState = (typeof EMAIL_TEMPLATE_VERSION_STATES)[number];

export const EMAIL_TEMPLATES_PER_ORGANIZATION_MAX = 200;
export const EMAIL_TEMPLATE_VARIABLES_MAX = 30;
export const EMAIL_TEMPLATE_VERSIONS_KEPT = 50;
export const EMAIL_TEMPLATE_HTML_MAX_BYTES = 512 * 1024;
export const EMAIL_TEMPLATE_TEXT_MAX_BYTES = 256 * 1024;
export const EMAIL_TEMPLATE_FOOTER_MAX = 500;
export const EMAIL_TEMPLATE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const EMAIL_TEMPLATE_VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** Variabel bawaan (tidak boleh dideklarasikan): nama organisasi & slot gambar QRIS. */
export const EMAIL_TEMPLATE_BUILTIN_VARIABLE_NAMES = ['nama_organisasi', 'qris'] as const;

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const emailTemplateSlugSchema = z
  .string({ error: 'Slug wajib diisi.' })
  .trim()
  .toLowerCase()
  .min(2, 'Slug minimal 2 karakter.')
  .max(64, 'Slug maksimal 64 karakter.')
  .regex(
    EMAIL_TEMPLATE_SLUG_PATTERN,
    'Slug hanya huruf kecil, angka, dan tanda hubung (mis. tagihan-bulanan).',
  )
  .refine((value) => !UUID_LIKE.test(value), 'Slug tidak boleh berbentuk UUID.');

const nameSchema = z
  .string({ error: 'Nama template wajib diisi.' })
  .trim()
  .min(1, 'Nama template wajib diisi.')
  .max(80, 'Nama template maksimal 80 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Nama memuat karakter khusus.');

const descriptionSchema = z
  .string()
  .trim()
  .max(200, 'Deskripsi maksimal 200 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Deskripsi memuat karakter khusus.');

export const emailTemplateVariableSchema = z.object({
  name: z
    .string()
    .regex(
      EMAIL_TEMPLATE_VARIABLE_NAME_PATTERN,
      'Nama variabel: huruf kecil, angka, garis bawah, diawali huruf (maks. 40).',
    ),
  label: z
    .string()
    .trim()
    .min(1, 'Label variabel wajib diisi.')
    .max(60, 'Label variabel maksimal 60 karakter.'),
  required: z.boolean(),
  example: z.string().max(200, 'Contoh nilai maksimal 200 karakter.').default(''),
});
export type EmailTemplateVariable = z.infer<typeof emailTemplateVariableSchema>;

/** Isi draf / versi (`draft` di PATCH). Validasi penuh (variabel cocok, sanitasi) di server. */
export const emailTemplateContentSchema = z.object({
  subject: z.string().max(1_000, 'Subjek terlalu panjang.'),
  html: z.string().max(EMAIL_TEMPLATE_HTML_MAX_BYTES, 'HTML maksimal 512 KB.'),
  text: z.string().max(EMAIL_TEMPLATE_TEXT_MAX_BYTES, 'Versi teks maksimal 256 KB.').nullish(),
  variables: z
    .array(emailTemplateVariableSchema)
    .max(
      EMAIL_TEMPLATE_VARIABLES_MAX,
      `Maksimal ${String(EMAIL_TEMPLATE_VARIABLES_MAX)} variabel.`,
    ),
  layout: z.enum(EMAIL_TEMPLATE_LAYOUTS),
  footerText: z
    .string()
    .max(
      EMAIL_TEMPLATE_FOOTER_MAX,
      `Teks kaki maksimal ${String(EMAIL_TEMPLATE_FOOTER_MAX)} karakter.`,
    )
    .nullish(),
});
export type EmailTemplateContentInput = z.input<typeof emailTemplateContentSchema>;

export const emailTemplateContentViewSchema = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string().nullable(),
  variables: z.array(emailTemplateVariableSchema),
  layout: z.enum(EMAIL_TEMPLATE_LAYOUTS),
  footerText: z.string().nullable(),
});
export type EmailTemplateContent = z.infer<typeof emailTemplateContentViewSchema>;

export const createEmailTemplateRequestSchema = z.object({
  name: nameSchema,
  slug: emailTemplateSlugSchema,
  description: descriptionSchema.optional(),
  draft: emailTemplateContentSchema.optional(),
});
export type CreateEmailTemplateRequest = z.input<typeof createEmailTemplateRequestSchema>;

export const updateEmailTemplateRequestSchema = z
  .object({
    name: nameSchema.optional(),
    slug: emailTemplateSlugSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    draft: emailTemplateContentSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.slug !== undefined ||
      value.description !== undefined ||
      value.draft !== undefined,
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateEmailTemplateRequest = z.input<typeof updateEmailTemplateRequestSchema>;

export const publishEmailTemplateRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});

export const emailTemplateListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  archived: z.enum(['true', 'false']).optional(),
});

const personSchema = z.object({ id: z.uuid(), name: z.string() }).nullable();

export const emailTemplateSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  presetKey: z.string().nullable(),
  archived: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  /** Draf berbeda dari versi terbit terakhir (atau belum pernah terbit). */
  hasUnpublishedChanges: z.boolean(),
  subject: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmailTemplateSummary = z.infer<typeof emailTemplateSummarySchema>;

export const emailTemplateSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  presetKey: z.string().nullable(),
  archived: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  lastUsedAt: z.string().nullable(),
  draft: emailTemplateContentViewSchema.nullable(),
  published: emailTemplateContentViewSchema
    .extend({ version: z.number().int(), publishedAt: z.string(), publishedBy: personSchema })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const emailTemplateListResponseSchema = z.object({
  templates: z.array(emailTemplateSummarySchema),
});
export const emailTemplateResponseSchema = z.object({ template: emailTemplateSchema });
export const emailTemplateIdParamsSchema = z.object({ templateId: z.string() });
export const emailTemplateVersionParamsSchema = z.object({
  templateId: z.string(),
  versionId: z.string(),
});

export const emailTemplateVersionSummarySchema = z.object({
  version: z.number().int(),
  state: z.enum(EMAIL_TEMPLATE_VERSION_STATES),
  subject: z.string(),
  createdBy: personSchema,
  createdAt: z.string(),
  publishedBy: personSchema,
  publishedAt: z.string().nullable(),
});
export const emailTemplateVersionsResponseSchema = z.object({
  versions: z.array(emailTemplateVersionSummarySchema),
});
export const emailTemplateVersionResponseSchema = z.object({
  version: emailTemplateVersionSummarySchema.extend({ content: emailTemplateContentViewSchema }),
});

/** Pratinjau tanpa menyimpan. `variables` kosong → nilai `example`. */
export const emailMessageTemplatePreviewRequestSchema = z.object({
  subject: z.string().max(1_000),
  html: z.string().max(EMAIL_TEMPLATE_HTML_MAX_BYTES),
  text: z.string().max(EMAIL_TEMPLATE_TEXT_MAX_BYTES).nullish(),
  layout: z.enum(EMAIL_TEMPLATE_LAYOUTS),
  footerText: z.string().max(EMAIL_TEMPLATE_FOOTER_MAX).nullish(),
  variables: z.array(emailTemplateVariableSchema).max(EMAIL_TEMPLATE_VARIABLES_MAX).optional(),
  values: z.record(z.string().max(60), z.string().max(1_000)).optional(),
  /** Tampilkan QRIS contoh di slot `{{qris}}`. */
  sampleQris: z.boolean().optional(),
});
export type EmailMessageTemplatePreviewRequest = z.input<
  typeof emailMessageTemplatePreviewRequestSchema
>;
export const emailMessageTemplatePreviewResponseSchema = z.object({
  subject: z.string(),
  /** Dokumen lengkap (logo & QRIS contoh sebagai `data:` URI) untuk `<iframe sandbox srcdoc>`. */
  html: z.string(),
  text: z.string(),
  warnings: z.array(z.string()),
});

export const emailTemplateTestRequestSchema = z.object({
  senderId: z.string().min(1).max(100),
  which: z.enum(['draft', 'published']),
  values: z.record(z.string().max(60), z.string().max(1_000)).optional(),
});
export const emailTemplateTestResponseSchema = z.object({ email: emailStatusSchema });

export const emailTemplatePresetKeySchema = z.enum(EMAIL_TEMPLATE_PRESET_KEYS);
export const emailTemplatePresetParamsSchema = z.object({ presetId: z.string() });
export const emailTemplatePresetsResponseSchema = z.object({
  presets: z.array(
    z.object({
      key: emailTemplatePresetKeySchema,
      name: z.string(),
      description: z.string(),
      subject: z.string(),
      layout: z.enum(EMAIL_TEMPLATE_LAYOUTS),
      variables: z.array(emailTemplateVariableSchema),
    }),
  ),
});
export const createEmailTemplateFromPresetRequestSchema = z.object({
  name: nameSchema.optional(),
  slug: emailTemplateSlugSchema.optional(),
});
