import { z } from 'zod';

import { isoDateTimeSchema } from './fields';

/**
 * Template pesan WhatsApp (Fase 4 — PRD §3.5; docs/KONTRAK-API-TEMPLATE.md). Per WABA (dikelola
 * lewat channel). Bentuk isi = format Balesin (`TemplateContent`) yang dipetakan dua arah ke
 * `components` Cloud API (`toMetaComponents` / `fromMetaComponents`). Aturan validasi lokal mengikuti
 * dokumentasi Meta "Message templates" (dibaca 19 Nov 2026); Meta tetap penentu akhir (tinjauan).
 */

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES, {
  error: 'Kategori harus MARKETING, UTILITY, atau AUTHENTICATION.',
});
export type TemplateCategory = z.infer<typeof templateCategorySchema>;

export const TEMPLATE_CATEGORY_LABELS: Readonly<Record<TemplateCategory, string>> = {
  MARKETING: 'Pemasaran',
  UTILITY: 'Utilitas (tagihan, status pesanan, info layanan)',
  AUTHENTICATION: 'Autentikasi (kode OTP)',
};

/** `DRAFT` = hanya di Balesin (belum diajukan). Sisanya = status Meta. */
export const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
  'DELETED',
  'LIMIT_EXCEEDED',
  'ARCHIVED',
] as const;
export const templateStatusSchema = z.enum(TEMPLATE_STATUSES);
export type TemplateStatus = z.infer<typeof templateStatusSchema>;

export const TEMPLATE_STATUS_LABELS: Readonly<Record<TemplateStatus, string>> = {
  DRAFT: 'Draf',
  PENDING: 'Menunggu tinjauan Meta',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAUSED: 'Dijeda Meta',
  DISABLED: 'Dinonaktifkan Meta',
  IN_APPEAL: 'Sedang banding',
  PENDING_DELETION: 'Sedang dihapus',
  DELETED: 'Dihapus',
  LIMIT_EXCEEDED: 'Melebihi batas',
  ARCHIVED: 'Diarsipkan',
};

export const TEMPLATE_QUALITY_SCORES = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
export type TemplateQualityScore = (typeof TEMPLATE_QUALITY_SCORES)[number];

export const TEMPLATE_LIMITS = {
  name: 512,
  body: 1024,
  headerText: 60,
  footer: 60,
  buttonsMax: 10,
  quickReplyMax: 10,
  urlButtonsMax: 2,
  phoneButtonsMax: 1,
  copyCodeMax: 1,
  buttonText: 25,
  url: 2000,
  example: 1024,
} as const;

export const templateNameSchema = z
  .string({ error: 'Nama template wajib diisi.' })
  .trim()
  .min(1, 'Nama template wajib diisi.')
  .max(TEMPLATE_LIMITS.name, 'Nama template terlalu panjang.')
  .regex(
    /^[a-z0-9_]+$/,
    'Nama template hanya huruf kecil, angka, dan garis bawah (contoh: tagihan_bulanan).',
  );

/** Kode bahasa Meta (`id`, `en`, `en_US`, `pt_BR`, …). */
export const templateLanguageSchema = z
  .string({ error: 'Bahasa wajib diisi.' })
  .trim()
  .regex(/^[a-z]{2,3}(_[A-Z]{2,3})?$/, 'Kode bahasa tidak valid (contoh: id, en_US).');

export const TEMPLATE_PARAMETER_FORMATS = ['positional', 'named'] as const;
export type TemplateParameterFormat = (typeof TEMPLATE_PARAMETER_FORMATS)[number];

const plain = (max: number, label: string) =>
  z
    .string({ error: `${label} wajib diisi.` })
    .max(max, `${label} maksimal ${String(max)} karakter.`)
    .refine((value) => !value.includes('\u0000'), `${label} memuat karakter yang tidak didukung.`);

const buttonText = plain(TEMPLATE_LIMITS.buttonText, 'Teks tombol');

export const templateButtonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: buttonText }),
  z.object({
    type: z.literal('URL'),
    text: buttonText,
    url: plain(TEMPLATE_LIMITS.url, 'URL tombol'),
    /** Contoh nilai `{{1}}` di akhir URL (wajib bila URL memuat variabel). */
    example: plain(TEMPLATE_LIMITS.example, 'Contoh URL').optional(),
  }),
  z.object({
    type: z.literal('PHONE_NUMBER'),
    text: buttonText,
    phoneNumber: z
      .string({ error: 'Nomor telepon wajib diisi.' })
      .trim()
      .regex(
        /^\+[1-9]\d{6,14}$/,
        'Nomor tombol telepon harus format internasional, contoh +628123456789.',
      ),
  }),
  z.object({
    type: z.literal('COPY_CODE'),
    /** Contoh kode (≤ 15 karakter menurut Meta). */
    example: plain(15, 'Contoh kode'),
  }),
]);
export type TemplateButton = z.infer<typeof templateButtonSchema>;

export const templateHeaderSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('TEXT'),
    text: plain(TEMPLATE_LIMITS.headerText, 'Judul'),
    /** Contoh nilai variabel judul (maks. satu variabel). */
    example: plain(TEMPLATE_LIMITS.example, 'Contoh judul').optional(),
  }),
  z.object({ format: z.literal('IMAGE') }),
  z.object({ format: z.literal('VIDEO') }),
  z.object({ format: z.literal('DOCUMENT') }),
]);
export type TemplateHeader = z.infer<typeof templateHeaderSchema>;

/** Isi template (format Balesin). `examples` = contoh nilai per variabel (`"1"` atau nama). */
export const templateContentSchema = z.object({
  parameterFormat: z.enum(TEMPLATE_PARAMETER_FORMATS).default('positional'),
  header: templateHeaderSchema.nullable().default(null),
  body: z.object({
    text: plain(TEMPLATE_LIMITS.body, 'Isi pesan'),
    examples: z.record(z.string().max(64), plain(TEMPLATE_LIMITS.example, 'Contoh')).default({}),
  }),
  footer: z
    .object({ text: plain(TEMPLATE_LIMITS.footer, 'Catatan kaki') })
    .nullable()
    .default(null),
  buttons: z.array(templateButtonSchema).max(TEMPLATE_LIMITS.buttonsMax).default([]),
  /** Hanya kategori AUTHENTICATION (isi body/tombol dibuat Meta). */
  authentication: z
    .object({
      addSecurityRecommendation: z.boolean().default(true),
      codeExpirationMinutes: z.number().int().min(1).max(90).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type TemplateContent = z.infer<typeof templateContentSchema>;
export type TemplateContentInput = z.input<typeof templateContentSchema>;

// ── Variabel ────────────────────────────────────────────────────────────────

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Nama variabel dalam urutan kemunculan (unik). */
export function templateVariables(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[1] ?? '';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Ganti variabel dengan nilainya (tidak ada → biarkan `{{x}}`). */
export function fillTemplateText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(VARIABLE, (whole, name: string) => values[name] ?? whole);
}

/** Variabel URL tombol (hanya `{{1}}` di akhir URL yang diizinkan Meta). */
export function urlButtonHasVariable(url: string): boolean {
  return templateVariables(url).length > 0;
}

export interface TemplateIssue {
  field: string;
  message: string;
}

/**
 * Pemeriksaan lokal sebelum diajukan ke Meta (yang bisa dipastikan tanpa Meta). Kosong = lolos.
 * Dipakai api (wajib) dan web (umpan balik langsung).
 */
export function validateTemplate(
  category: TemplateCategory,
  content: TemplateContent,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  if (category === 'AUTHENTICATION') {
    if (!content.authentication) {
      add('authentication', 'Template autentikasi butuh pengaturan kode OTP.');
    }
    if (content.header || content.footer || content.buttons.length > 0) {
      add(
        'category',
        'Template autentikasi tidak memakai judul, catatan kaki, atau tombol sendiri.',
      );
    }
    return issues;
  }
  if (content.authentication) {
    add('authentication', 'Pengaturan OTP hanya untuk kategori AUTHENTICATION.');
  }

  const body = content.body.text;
  if (body.trim() === '') add('body.text', 'Isi pesan wajib diisi.');
  const variables = templateVariables(body);
  const headerVariables =
    content.header?.format === 'TEXT' ? templateVariables(content.header.text) : [];

  const positional = content.parameterFormat === 'positional';
  for (const name of [...variables, ...headerVariables]) {
    if (positional && !/^[1-9]\d*$/.test(name)) {
      add('body.text', `Variabel {{${name}}} tidak sah: format bernomor memakai {{1}}, {{2}}, ….`);
    }
    if (!positional && !/^[a-z][a-z0-9_]*$/.test(name)) {
      add(
        'body.text',
        `Variabel {{${name}}} tidak sah: nama variabel huruf kecil/angka/garis bawah, diawali huruf.`,
      );
    }
  }
  if (positional) {
    const numbers = variables.map(Number).sort((a, b) => a - b);
    if (numbers.some((value, index) => value !== index + 1)) {
      add('body.text', 'Variabel harus berurutan mulai {{1}} tanpa lompatan.');
    }
  }
  const trimmed = body.trim();
  if (/^\{\{[^}]+\}\}/.test(trimmed) || /\{\{[^}]+\}\}$/.test(trimmed)) {
    add('body.text', 'Isi pesan tidak boleh diawali atau diakhiri variabel.');
  }
  if (/\}\}\s*\{\{/.test(body)) {
    add('body.text', 'Dua variabel tidak boleh berdampingan tanpa teks di antaranya.');
  }
  for (const name of variables) {
    if (!content.body.examples[name]?.trim()) {
      add(`body.examples.${name}`, `Contoh nilai untuk {{${name}}} wajib diisi (diminta Meta).`);
    }
  }

  if (content.header?.format === 'TEXT') {
    if (headerVariables.length > 1) add('header.text', 'Judul maksimal satu variabel.');
    if (headerVariables.length === 1 && !content.header.example?.trim()) {
      add('header.example', 'Contoh nilai variabel judul wajib diisi.');
    }
    if (content.header.text.trim() === '') add('header.text', 'Judul tidak boleh kosong.');
  }
  if (content.footer && templateVariables(content.footer.text).length > 0) {
    add('footer.text', 'Catatan kaki tidak boleh memuat variabel.');
  }

  const count = (type: TemplateButton['type']) =>
    content.buttons.filter((button) => button.type === type).length;
  if (count('URL') > TEMPLATE_LIMITS.urlButtonsMax) add('buttons', 'Maksimal 2 tombol URL.');
  if (count('PHONE_NUMBER') > TEMPLATE_LIMITS.phoneButtonsMax)
    add('buttons', 'Maksimal 1 tombol telepon.');
  if (count('COPY_CODE') > TEMPLATE_LIMITS.copyCodeMax)
    add('buttons', 'Maksimal 1 tombol salin kode.');
  // Meta: tombol balasan cepat harus berkelompok (tidak diselingi tombol lain).
  const kinds = content.buttons.map((button) => (button.type === 'QUICK_REPLY' ? 'q' : 'o'));
  const groups = kinds.join('').replace(/(.)\1+/g, '$1');
  if (groups.length > 2)
    add('buttons', 'Tombol balasan cepat harus berkelompok (tidak diselingi tombol lain).');
  content.buttons.forEach((button, index) => {
    if ('text' in button && button.text.trim() === '')
      add(`buttons.${String(index)}.text`, 'Teks tombol wajib diisi.');
    if (button.type === 'URL') {
      if (!/^https?:\/\/[^\s]+$/i.test(button.url.replace(VARIABLE, 'x'))) {
        add(`buttons.${String(index)}.url`, 'URL tombol harus diawali http:// atau https://.');
      }
      const urlVariables = templateVariables(button.url);
      if (
        urlVariables.length > 1 ||
        (urlVariables.length === 1 && !/\{\{\s*1\s*\}\}$/.test(button.url))
      ) {
        add(
          `buttons.${String(index)}.url`,
          'URL hanya boleh punya satu variabel {{1}} di bagian paling akhir.',
        );
      }
      if (urlVariables.length === 1 && !button.example?.trim()) {
        add(
          `buttons.${String(index)}.example`,
          'Contoh URL lengkap wajib diisi untuk URL bervariabel.',
        );
      }
    }
  });
  return issues;
}

// ── Pemetaan ke/dari komponen Meta ──────────────────────────────────────────

type MetaComponent = Record<string, unknown>;

/** `TemplateContent` → `components` untuk `POST /{waba-id}/message_templates`. */
export function toMetaComponents(
  category: TemplateCategory,
  content: TemplateContent,
): MetaComponent[] {
  if (category === 'AUTHENTICATION') {
    const auth = content.authentication ?? {
      addSecurityRecommendation: true,
      codeExpirationMinutes: null,
    };
    return [
      { type: 'BODY', add_security_recommendation: auth.addSecurityRecommendation },
      ...(auth.codeExpirationMinutes
        ? [{ type: 'FOOTER', code_expiration_minutes: auth.codeExpirationMinutes }]
        : []),
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ];
  }
  const named = content.parameterFormat === 'named';
  const components: MetaComponent[] = [];
  if (content.header?.format === 'TEXT') {
    const variables = templateVariables(content.header.text);
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: content.header.text,
      ...(variables.length === 1 && content.header.example
        ? named
          ? {
              example: {
                header_text_named_params: [
                  { param_name: variables[0], example: content.header.example },
                ],
              },
            }
          : { example: { header_text: [content.header.example] } }
        : {}),
    });
  } else if (content.header) {
    components.push({ type: 'HEADER', format: content.header.format });
  }
  const variables = templateVariables(content.body.text);
  components.push({
    type: 'BODY',
    text: content.body.text,
    ...(variables.length > 0
      ? named
        ? {
            example: {
              body_text_named_params: variables.map((name) => ({
                param_name: name,
                example: content.body.examples[name] ?? '',
              })),
            },
          }
        : { example: { body_text: [variables.map((name) => content.body.examples[name] ?? '')] } }
      : {}),
  });
  if (content.footer) components.push({ type: 'FOOTER', text: content.footer.text });
  if (content.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: content.buttons.map((button) => {
        switch (button.type) {
          case 'QUICK_REPLY':
            return { type: 'QUICK_REPLY', text: button.text };
          case 'URL':
            return {
              type: 'URL',
              text: button.text,
              url: button.url,
              ...(urlButtonHasVariable(button.url) && button.example
                ? { example: [button.example] }
                : {}),
            };
          case 'PHONE_NUMBER':
            return { type: 'PHONE_NUMBER', text: button.text, phone_number: button.phoneNumber };
          case 'COPY_CODE':
            return { type: 'COPY_CODE', example: button.example };
        }
      }),
    });
  }
  return components;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * `components` dari Meta (sinkron) → `TemplateContent` (sebisanya; bagian yang tidak dikenal dibuang,
 * komponen mentah tetap disimpan terpisah). Tidak pernah melempar.
 */
export function fromMetaComponents(components: unknown, parameterFormat?: string): TemplateContent {
  const items = list(components).map(record);
  const find = (type: string) => items.find((item) => str(item.type)?.toUpperCase() === type);
  const named = parameterFormat?.toUpperCase() === 'NAMED';
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = list(find('BUTTONS')?.buttons).map(record);

  const examples: Record<string, string> = {};
  const bodyText = str(body?.text) ?? '';
  const bodyExample = record(body?.example);
  if (named) {
    for (const param of list(bodyExample.body_text_named_params).map(record)) {
      const name = str(param.param_name);
      const value = str(param.example);
      if (name && value !== undefined) examples[name] = value;
    }
  } else {
    const first = list(list(bodyExample.body_text)[0]);
    first.forEach((value, index) => {
      if (typeof value === 'string') examples[String(index + 1)] = value;
    });
  }

  let parsedHeader: TemplateHeader | null = null;
  const format = str(header?.format)?.toUpperCase();
  if (format === 'TEXT') {
    const headerExample = record(header?.example);
    const example = named
      ? str(record(list(headerExample.header_text_named_params)[0]).example)
      : str(list(headerExample.header_text)[0]);
    parsedHeader = {
      format: 'TEXT',
      text: (str(header?.text) ?? '').slice(0, TEMPLATE_LIMITS.headerText),
      ...(example ? { example } : {}),
    };
  } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
    parsedHeader = { format };
  }

  const parsedButtons: TemplateButton[] = [];
  for (const button of buttons) {
    const type = str(button.type)?.toUpperCase();
    const text = (str(button.text) ?? '').slice(0, TEMPLATE_LIMITS.buttonText);
    if (type === 'QUICK_REPLY') parsedButtons.push({ type, text });
    else if (type === 'URL') {
      const example = str(list(button.example)[0]);
      parsedButtons.push({
        type,
        text,
        url: str(button.url) ?? '',
        ...(example ? { example } : {}),
      });
    } else if (type === 'PHONE_NUMBER') {
      parsedButtons.push({ type, text, phoneNumber: str(button.phone_number) ?? '' });
    } else if (type === 'COPY_CODE') {
      parsedButtons.push({
        type,
        example: (str(list(button.example)[0]) ?? str(button.example) ?? '').slice(0, 15),
      });
    }
  }

  const otp = buttons.some((button) => str(button.type)?.toUpperCase() === 'OTP');
  return {
    parameterFormat: named ? 'named' : 'positional',
    header: parsedHeader,
    body: { text: bodyText.slice(0, TEMPLATE_LIMITS.body), examples },
    footer: str(footer?.text)
      ? { text: (str(footer?.text) ?? '').slice(0, TEMPLATE_LIMITS.footer) }
      : null,
    buttons: otp ? [] : parsedButtons.slice(0, TEMPLATE_LIMITS.buttonsMax),
    authentication: otp
      ? {
          addSecurityRecommendation: body?.add_security_recommendation === true,
          codeExpirationMinutes:
            typeof footer?.code_expiration_minutes === 'number'
              ? footer.code_expiration_minutes
              : null,
        }
      : null,
  };
}

// ── API ─────────────────────────────────────────────────────────────────────

export const messageTemplateSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  wabaId: z.string(),
  metaTemplateId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  category: templateCategorySchema,
  status: templateStatusSchema,
  /** Alasan penolakan/penjedaan dari Meta (kode Meta, mis. `INVALID_FORMAT`). */
  rejectedReason: z.string().nullable(),
  qualityScore: z.enum(TEMPLATE_QUALITY_SCORES).nullable(),
  content: templateContentSchema,
  /** `meta` = dibuat di luar Balesin (hasil sinkron), `balesin`, `preset`. */
  source: z.enum(['meta', 'balesin', 'preset']),
  presetKey: z.string().nullable(),
  /** Ada perubahan lokal yang belum diajukan ke Meta. */
  localChanges: z.boolean(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export const templateListQuerySchema = z.object({
  channelId: z.uuid().optional(),
  status: templateStatusSchema.optional(),
  category: templateCategorySchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export const templateListResponseSchema = z.object({ templates: z.array(messageTemplateSchema) });
export const templateResponseSchema = z.object({ template: messageTemplateSchema });
export const templateIdParamsSchema = z.object({ templateId: z.string() });

export const createTemplateRequestSchema = z.object({
  channelId: z.uuid({ error: 'Pilih nomor WhatsApp.' }),
  name: templateNameSchema,
  language: templateLanguageSchema.default('id'),
  category: templateCategorySchema,
  content: templateContentSchema,
});
export type CreateTemplateRequest = z.input<typeof createTemplateRequestSchema>;

/** Nama & bahasa tidak bisa diubah setelah diajukan (aturan Meta); kategori hanya sebelum disetujui. */
export const updateTemplateRequestSchema = z
  .object({
    name: templateNameSchema.optional(),
    language: templateLanguageSchema.optional(),
    category: templateCategorySchema.optional(),
    content: templateContentSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });

export const syncTemplatesRequestSchema = z.object({ channelId: z.uuid().optional() });
export const syncTemplatesResponseSchema = z.object({
  channels: z.array(
    z.object({
      channelId: z.uuid(),
      ok: z.boolean(),
      /** Pesan Indonesia bila gagal. */
      error: z.string().nullable(),
      created: z.number().int(),
      updated: z.number().int(),
      removed: z.number().int(),
    }),
  ),
});

// ── Kirim template ──────────────────────────────────────────────────────────

/**
 * Nilai variabel saat kirim. `body`/`header.text` dikunci nama variabel (`"1"`, `"2"` atau nama);
 * `header.mediaId` = unggahan media (header gambar/video/dokumen); `buttons` dikunci INDEKS tombol
 * (variabel URL / kode salin).
 */
export const templateSendParametersSchema = z.object({
  header: z
    .object({
      text: plain(TEMPLATE_LIMITS.example, 'Nilai judul').optional(),
      mediaId: z.uuid({ error: 'Berkas judul tidak valid.' }).optional(),
    })
    .optional(),
  body: z.record(z.string().max(64), plain(TEMPLATE_LIMITS.example, 'Nilai variabel')).default({}),
  buttons: z
    .record(z.string().regex(/^\d$/), plain(TEMPLATE_LIMITS.example, 'Nilai tombol'))
    .default({}),
});
export type TemplateSendParameters = z.infer<typeof templateSendParametersSchema>;
export type TemplateSendParametersInput = z.input<typeof templateSendParametersSchema>;

/** Mulai percakapan ke nomor (bisa baru) dengan template (`inbox.initiate`). */
export const startConversationRequestSchema = z.object({
  channelId: z.uuid({ error: 'Pilih nomor WhatsApp pengirim.' }),
  phone: z
    .string({ error: 'Nomor tujuan wajib diisi.' })
    .trim()
    .min(6, 'Nomor tujuan terlalu pendek.')
    .max(24, 'Nomor tujuan terlalu panjang.'),
  clientMessageId: z.uuid({ error: 'ID pesan dari aplikasi tidak valid.' }),
  templateId: z.uuid({ error: 'Pilih template.' }),
  parameters: templateSendParametersSchema.default({ body: {}, buttons: {} }),
});

/** API v1 `POST /public/messages/template` (`messages:initiate`). */
export const publicTemplateMessageRequestSchema = z
  .object({
    channelId: z.uuid(),
    /** Nomor tujuan (E.164, atau 62…/0…). */
    phone: z.string().trim().min(6).max(24),
    /** ID template Balesin, ATAU `name` + `language`. */
    templateId: z.uuid().optional(),
    name: templateNameSchema.optional(),
    language: templateLanguageSchema.optional(),
    parameters: templateSendParametersSchema.default({ body: {}, buttons: {} }),
  })
  .refine((value) => value.templateId !== undefined || value.name !== undefined, {
    error: 'Isi templateId atau name (+ language).',
  });

// ── Preset ──────────────────────────────────────────────────────────────────

export const templatePresetSchema = z.object({
  key: z.string(),
  industry: z.string(),
  title: z.string(),
  description: z.string(),
  name: z.string(),
  language: z.string(),
  category: templateCategorySchema,
  content: templateContentSchema,
});
export type TemplatePreset = z.infer<typeof templatePresetSchema>;
export const templatePresetListResponseSchema = z.object({
  presets: z.array(templatePresetSchema),
});
export const templatePresetParamsSchema = z.object({ presetId: z.string().max(64) });
export const createFromPresetRequestSchema = z.object({
  channelId: z.uuid({ error: 'Pilih nomor WhatsApp.' }),
  /** Bawaan: nama preset. */
  name: templateNameSchema.optional(),
  language: templateLanguageSchema.optional(),
});

/**
 * Pesan galat Meta khusus template (subkode Graph yang terdokumentasi) → Indonesia. Galat lain:
 * `TEMPLATE_META_REJECTED` untuk parameter tidak valid, selain itu pesan umum `META_ERROR_MESSAGES`.
 */
export const TEMPLATE_META_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  2388024: 'Template dengan nama dan bahasa ini sudah ada di akun WhatsApp. Pakai nama lain.',
  2388023: 'Nama template ini sedang dihapus di Meta; nama yang sama belum bisa dipakai lagi.',
};
export const TEMPLATE_META_REJECTED =
  'Meta menolak template ini. Periksa format isi, variabel & contohnya, tombol, dan kategori, lalu ajukan lagi.';
