import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';
import { messageDeliveryStatusSchema } from './inbox';
import { tagRefSchema } from './tags';
import {
  TEMPLATE_CATEGORIES,
  fillTemplateText,
  templateCategorySchema,
  templateVariables,
  urlButtonHasVariable,
  type TemplateCategory,
  type TemplateContent,
  type TemplateSendParameters,
} from './templates';

/**
 * Broadcast / kampanye template WhatsApp (Fase 4, docs/KONTRAK-API-BROADCAST.md).
 *
 * Alur: `draft` → (`pending_approval` bila penerima valid > ambang) → `scheduled` → `running` →
 * `completed`; `paused` (manual / rem darurat / rem otomatis) dan `cancelled` bisa terjadi selama
 * belum selesai. Penerima dari unggahan CSV/XLSX, segmen kontak, atau konektor REST; variabel template
 * dipetakan dari kolom data penerima. Worker antrian `broadcast` mengirim bertahap (throttle) lewat
 * jalur kirim pesan yang sama (rem darurat, batas organisasi, laporan per kategori).
 */

export const BROADCAST_STATUSES = [
  'draft',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;
export const broadcastStatusSchema = z.enum(BROADCAST_STATUSES);
export type BroadcastStatus = z.infer<typeof broadcastStatusSchema>;

export const BROADCAST_STATUS_LABELS: Readonly<Record<BroadcastStatus, string>> = {
  draft: 'Draf',
  pending_approval: 'Menunggu persetujuan',
  scheduled: 'Terjadwal',
  running: 'Berjalan',
  paused: 'Dijeda',
  completed: 'Selesai',
  cancelled: 'Dibatalkan',
};

/**
 * Alasan kampanye dijeda. Selain `manual`, semuanya otomatis (rem darurat organisasi / rem otomatis
 * kampanye) dan hanya bisa dilanjutkan pemegang `sending.resume` (Owner/Admin, SECURITY §5).
 */
export const BROADCAST_PAUSE_REASONS = [
  'manual',
  'emergency_brake',
  'failure_spike',
  'meta_blocked',
  'quality_low',
  'template_unavailable',
  'channel_unavailable',
] as const;
export const broadcastPauseReasonSchema = z.enum(BROADCAST_PAUSE_REASONS);
export type BroadcastPauseReason = z.infer<typeof broadcastPauseReasonSchema>;

export const BROADCAST_PAUSE_REASON_LABELS: Readonly<Record<BroadcastPauseReason, string>> = {
  manual: 'Dijeda pengguna',
  emergency_brake: 'Rem darurat pengiriman ditarik',
  failure_spike: 'Rem otomatis: terlalu banyak pesan gagal',
  meta_blocked: 'Rem otomatis: Meta membatasi/memblokir nomor pengirim',
  quality_low: 'Rem otomatis: kualitas nomor pengirim turun (merah/ditandai)',
  template_unavailable: 'Rem otomatis: template tidak lagi disetujui Meta',
  channel_unavailable: 'Rem otomatis: nomor pengirim nonaktif atau kredensial bermasalah',
};

/** Kampanye `running` yang sedang MENUNGGU (bukan dijeda): lanjut sendiri setelah `until`. */
export const BROADCAST_WAIT_REASONS = ['daily_quota', 'meta_tier', 'meta_rate_limit'] as const;
export const broadcastWaitReasonSchema = z.enum(BROADCAST_WAIT_REASONS);
export type BroadcastWaitReason = z.infer<typeof broadcastWaitReasonSchema>;

export const BROADCAST_WAIT_REASON_LABELS: Readonly<Record<BroadcastWaitReason, string>> = {
  daily_quota: 'Menunggu kuota harian: sebagian batas kirim organisasi disisakan untuk balasan CS.',
  meta_tier: 'Menunggu batas pelanggan per 24 jam nomor ini (tier Meta).',
  meta_rate_limit: 'Meta meminta pengiriman diperlambat; dicoba lagi sebentar lagi.',
};

export const BROADCAST_SOURCE_KINDS = ['upload', 'segment', 'connector'] as const;
export const broadcastSourceKindSchema = z.enum(BROADCAST_SOURCE_KINDS);
export type BroadcastSourceKind = z.infer<typeof broadcastSourceKindSchema>;

export const BROADCAST_RECIPIENT_STATUSES = ['pending', 'skipped', 'queued', 'cancelled'] as const;
export const broadcastRecipientStatusSchema = z.enum(BROADCAST_RECIPIENT_STATUSES);
export type BroadcastRecipientStatus = z.infer<typeof broadcastRecipientStatusSchema>;

/** Penerima dilewati saat diajukan/dikirim (tidak ada pesan dibuat). */
export const BROADCAST_SKIP_REASONS = [
  'recently_sent',
  'missing_variable',
  'invalid_variable',
  'contact_unavailable',
] as const;
export const broadcastSkipReasonSchema = z.enum(BROADCAST_SKIP_REASONS);
export type BroadcastSkipReason = z.infer<typeof broadcastSkipReasonSchema>;

export const BROADCAST_SKIP_REASON_LABELS: Readonly<Record<BroadcastSkipReason, string>> = {
  recently_sent: 'Sudah menerima broadcast dalam rentang anti-dobel',
  missing_variable: 'Data untuk variabel template kosong',
  invalid_variable: 'Data variabel memuat baris baru, tab, atau lebih dari 4 spasi berturut-turut',
  contact_unavailable: 'Kontak tidak bisa dipakai (dihapus atau identitas WhatsApp berubah)',
};

/** Baris impor yang tidak menjadi penerima. */
export const BROADCAST_IMPORT_ISSUES = [
  'phone_missing',
  'phone_invalid',
  'phone_scientific',
  'duplicate',
  'value_too_long',
] as const;
export const broadcastImportIssueSchema = z.enum(BROADCAST_IMPORT_ISSUES);
export type BroadcastImportIssue = z.infer<typeof broadcastImportIssueSchema>;

export const BROADCAST_IMPORT_ISSUE_LABELS: Readonly<Record<BroadcastImportIssue, string>> = {
  phone_missing: 'Nomor kosong',
  phone_invalid: 'Nomor tidak valid',
  phone_scientific:
    'Nomor tertulis dalam format ilmiah Excel (mis. 6,28E+12). Ubah kolom nomor menjadi Teks lalu unggah ulang.',
  duplicate: 'Nomor sudah ada di baris sebelumnya (dikirim sekali saja)',
  value_too_long: 'Ada isian lebih dari 500 karakter',
};

export const BROADCAST_LIMITS = {
  /** Penerima per kampanye. */
  maxRecipients: 20_000,
  maxColumns: 30,
  maxColumnNameLength: 64,
  maxValueLength: 500,
  /** Berkas unggahan CSV/XLSX. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Isi XLSX setelah dibuka (cegah zip bomb). */
  maxXlsxUncompressedBytes: 40 * 1024 * 1024,
  /** Jawaban konektor REST. */
  maxConnectorBytes: 5 * 1024 * 1024,
  ratePerSecond: { min: 1, max: 20, default: 5 },
  dedupeHours: { min: 1, max: 720, default: 24 },
  previewMax: 5,
  /** Baris bermasalah yang dilaporkan rinci (sisanya hanya dihitung). */
  issuesReported: 200,
  /** Jendela "dibalas": balasan pelanggan dalam sekian jam setelah broadcast terkirim. */
  replyAttributionHours: 72,
} as const;

// ── Nomor telepon (Indonesia dulu) ──────────────────────────────────────────

export type PhoneNormalization =
  | { ok: true; phone: string }
  | { ok: false; issue: 'phone_missing' | 'phone_invalid' | 'phone_scientific' };

/**
 * Nomor dari berkas/konektor → E.164. Aturan (Indonesia sebagai bawaan):
 *  - spasi, `-`, `.`, `(`, `)` dibuang; `+` di depan dipertahankan; `00` di depan = awalan internasional;
 *  - `0…` → `+62…`; `8…` (9–12 digit, nol depan hilang di Excel) → `+628…`; `62…` → `+62…`;
 *  - nomor Indonesia wajib 8–13 digit setelah `62`; nomor negara lain hanya bila ditulis `+`/`00`;
 *  - format ilmiah Excel (`6,28E+12`) ditolak dengan alasan sendiri (digit sudah hilang).
 */
export function normalizeBroadcastPhone(raw: string | null | undefined): PhoneNormalization {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: false, issue: 'phone_missing' };
  if (/^\d+([.,]\d+)?e\+?\d+$/i.test(text.replace(/\s/g, ''))) {
    return { ok: false, issue: 'phone_scientific' };
  }
  const compact = text.replace(/[\s\-.()\u00a0]/g, '');
  let international = false;
  let digits: string;
  if (compact.startsWith('+')) {
    international = true;
    digits = compact.slice(1);
  } else if (compact.startsWith('00')) {
    international = true;
    digits = compact.slice(2);
  } else {
    digits = compact;
  }
  if (!/^\d+$/.test(digits)) return { ok: false, issue: 'phone_invalid' };
  if (!international) {
    if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
    else if (digits.startsWith('8') && digits.length >= 9 && digits.length <= 12) {
      digits = `62${digits}`;
    } else if (!digits.startsWith('62')) {
      return { ok: false, issue: 'phone_invalid' };
    }
  }
  if (digits.startsWith('62')) {
    const local = digits.slice(2);
    if (local.length < 8 || local.length > 13 || local.startsWith('0')) {
      return { ok: false, issue: 'phone_invalid' };
    }
  }
  return /^[1-9]\d{7,14}$/.test(digits)
    ? { ok: true, phone: `+${digits}` }
    : { ok: false, issue: 'phone_invalid' };
}

// ── Pemetaan variabel ───────────────────────────────────────────────────────

const columnNameSchema = z
  .string()
  .trim()
  .min(1, 'Pilih kolom.')
  .max(BROADCAST_LIMITS.maxColumnNameLength, 'Nama kolom terlalu panjang.');

export const broadcastVariableSourceSchema = z.discriminatedUnion('kind', [
  /** Nilai dari kolom data penerima (unggahan/segmen/konektor). */
  z.object({ kind: z.literal('column'), column: columnNameSchema }),
  /** Teks tetap yang sama untuk semua penerima. */
  z.object({
    kind: z.literal('text'),
    value: z
      .string()
      .trim()
      .min(1, 'Teks tetap wajib diisi.')
      .max(200, 'Teks tetap maksimal 200 karakter.')
      .refine((value) => !hasControlCharacters(value), 'Teks memuat karakter khusus.'),
  }),
]);
export type BroadcastVariableSource = z.infer<typeof broadcastVariableSourceSchema>;

export const broadcastMappingSchema = z.object({
  /** Variabel body: `{{1}}` → `"1"`, `{{nama}}` → `"nama"`. */
  body: z.record(z.string().max(64), broadcastVariableSourceSchema).default({}),
  /** Variabel judul teks (bila template punya). */
  header: broadcastVariableSourceSchema.nullable().default(null),
  /** Tombol URL ber-`{{1}}` / salin kode, per indeks tombol. */
  buttons: z.record(z.string().regex(/^\d$/), broadcastVariableSourceSchema).default({}),
});
export type BroadcastMapping = z.infer<typeof broadcastMappingSchema>;
export const EMPTY_BROADCAST_MAPPING: BroadcastMapping = { body: {}, header: null, buttons: {} };

/** Variabel yang harus dipetakan untuk template ini (body, judul teks, tombol). */
export function broadcastRequiredVariables(content: TemplateContent): {
  body: string[];
  header: boolean;
  buttons: string[];
} {
  const header =
    content.header?.format === 'TEXT' && templateVariables(content.header.text).length > 0;
  const buttons: string[] = [];
  content.buttons.forEach((button, index) => {
    if (
      (button.type === 'URL' && urlButtonHasVariable(button.url)) ||
      button.type === 'COPY_CODE'
    ) {
      buttons.push(String(index));
    }
  });
  return { body: templateVariables(content.body.text), header, buttons };
}

const VALUE_RULE = /[\n\t]| {5,}/;

export interface BroadcastRender {
  parameters: TemplateSendParameters;
  /** Isi body yang sudah diisi (pratinjau). */
  preview: string;
  /** Variabel yang datanya kosong (`body.1`, `header`, `buttons.0`). */
  missing: string[];
  /** Variabel yang datanya melanggar aturan Meta. */
  invalid: string[];
}

/**
 * Nilai parameter template untuk satu penerima dari pemetaan + data barisnya. Murni (dipakai api untuk
 * pratinjau/validasi saat diajukan dan worker saat mengirim). Template AUTHENTICATION tidak didukung
 * broadcast (kode OTP per orang bukan broadcast).
 */
export function renderBroadcastParameters(
  content: TemplateContent,
  mapping: BroadcastMapping,
  data: Readonly<Record<string, string>>,
): BroadcastRender {
  const required = broadcastRequiredVariables(content);
  const missing: string[] = [];
  const invalid: string[] = [];
  const resolve = (source: BroadcastVariableSource | undefined | null, key: string) => {
    if (!source) {
      missing.push(key);
      return '';
    }
    const raw = source.kind === 'text' ? source.value : (data[source.column] ?? '');
    const value = raw.trim();
    if (value === '') missing.push(key);
    else if (VALUE_RULE.test(value)) invalid.push(key);
    return value;
  };
  const body: Record<string, string> = {};
  for (const name of required.body) body[name] = resolve(mapping.body[name], `body.${name}`);
  const buttons: Record<string, string> = {};
  for (const index of required.buttons) {
    buttons[index] = resolve(mapping.buttons[index], `buttons.${index}`);
  }
  const parameters: TemplateSendParameters = { body, buttons };
  if (required.header) parameters.header = { text: resolve(mapping.header, 'header') };
  return { parameters, preview: fillTemplateText(content.body.text, body), missing, invalid };
}

// ── Kampanye ────────────────────────────────────────────────────────────────

const personRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const broadcastNameSchema = z
  .string({ error: 'Nama kampanye wajib diisi.' })
  .trim()
  .min(1, 'Nama kampanye wajib diisi.')
  .max(80, 'Nama kampanye maksimal 80 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Nama memuat karakter khusus.');

export const BROADCAST_DEDUPE_SCOPES = ['template', 'any'] as const;
export const broadcastDedupeSchema = z.object({
  /** `null` = tanpa anti-dobel lintas kampanye (dalam satu kampanye tetap sekali per nomor). */
  hours: z
    .number()
    .int()
    .min(BROADCAST_LIMITS.dedupeHours.min, 'Minimal 1 jam.')
    .max(BROADCAST_LIMITS.dedupeHours.max, 'Maksimal 720 jam (30 hari).')
    .nullable(),
  /** `template` = template yang sama saja; `any` = broadcast apa pun. */
  scope: z.enum(BROADCAST_DEDUPE_SCOPES),
});
export type BroadcastDedupe = z.infer<typeof broadcastDedupeSchema>;

export const broadcastEstimateSchema = z.object({
  currency: z.string(),
  category: templateCategorySchema,
  /** Penerima yang akan dikirimi (belum termasuk yang dilewati saat kirim). */
  recipients: z.number().int().nonnegative(),
  /** Diperkirakan berbayar. */
  billable: z.number().int().nonnegative(),
  /** Template UTILITY ke pelanggan yang jendela layanannya masih terbuka = gratis (aturan Meta). */
  free: z.number().int().nonnegative(),
  /** Nomor negara yang tarifnya belum diatur (biayanya tidak dihitung). */
  unknownRate: z.number().int().nonnegative(),
  /** Perkiraan total (satuan mata uang, dibulatkan). */
  total: z.number().nonnegative(),
  /** Sumber tarif (teks pengaturan). */
  rateSource: z.string(),
  computedAt: isoDateTimeSchema,
});
export type BroadcastEstimate = z.infer<typeof broadcastEstimateSchema>;

export const broadcastCountsSchema = z.object({
  /** Baris sumber (unggahan/segmen/konektor) sebelum disaring. */
  sourceRows: z.number().int().nonnegative(),
  /** Baris yang ditolak saat impor (nomor salah, ganda, isian terlalu panjang). */
  rejectedRows: z.number().int().nonnegative(),
  recipients: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

export const broadcastCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: broadcastStatusSchema,
  channel: z.object({ id: z.uuid(), name: z.string() }),
  template: z
    .object({
      id: z.uuid(),
      name: z.string(),
      language: z.string(),
      category: templateCategorySchema,
      status: z.string(),
    })
    .nullable(),
  source: z
    .object({
      kind: broadcastSourceKindSchema,
      /** Nama berkas / nama konektor / ringkasan segmen. */
      label: z.string(),
      importedAt: isoDateTimeSchema,
    })
    .nullable(),
  /** Kolom data penerima (untuk pemetaan). */
  columns: z.array(z.string()),
  phoneColumn: z.string().nullable(),
  mapping: broadcastMappingSchema,
  scheduledAt: isoDateTimeSchema.nullable(),
  ratePerSecond: z.number().int(),
  dedupe: broadcastDedupeSchema,
  autoTag: tagRefSchema.nullable(),
  counts: broadcastCountsSchema,
  approval: z.object({
    /** Penerima di atas ambang → butuh persetujuan Owner/Admin selain pembuat. */
    required: z.boolean(),
    threshold: z.number().int(),
    requestedAt: isoDateTimeSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decidedBy: personRefSchema.nullable(),
    rejectionReason: z.string().nullable(),
  }),
  estimate: broadcastEstimateSchema.nullable(),
  pause: z
    .object({
      reason: broadcastPauseReasonSchema,
      at: isoDateTimeSchema,
      by: personRefSchema.nullable(),
      /** Butuh `sending.resume` (Owner/Admin) untuk melanjutkan. */
      requiresAdmin: z.boolean(),
    })
    .nullable(),
  waiting: z.object({ reason: broadcastWaitReasonSchema, until: isoDateTimeSchema }).nullable(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
});
export type BroadcastCampaign = z.infer<typeof broadcastCampaignSchema>;

export const broadcastResponseSchema = z.object({ broadcast: broadcastCampaignSchema });
export type BroadcastResponse = z.infer<typeof broadcastResponseSchema>;

export const broadcastListQuerySchema = z.object({
  status: broadcastStatusSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const broadcastListResponseSchema = z.object({
  broadcasts: z.array(broadcastCampaignSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastListResponse = z.infer<typeof broadcastListResponseSchema>;

export const broadcastIdParamsSchema = z.object({ broadcastId: z.string() });

export const createBroadcastRequestSchema = z.object({
  name: broadcastNameSchema,
  channelId: z.uuid({ error: 'Pilih nomor WhatsApp pengirim.' }),
  templateId: z.uuid({ error: 'Pilih template.' }),
});
export type CreateBroadcastRequest = z.infer<typeof createBroadcastRequestSchema>;

export const updateBroadcastRequestSchema = z.object({
  name: broadcastNameSchema.optional(),
  templateId: z.uuid({ error: 'Pilih template.' }).optional(),
  mapping: broadcastMappingSchema.optional(),
  /** `null` = kirim segera setelah disetujui/diajukan. */
  scheduledAt: isoDateTimeSchema.nullable().optional(),
  ratePerSecond: z
    .number()
    .int()
    .min(BROADCAST_LIMITS.ratePerSecond.min, 'Kecepatan minimal 1 pesan/detik.')
    .max(BROADCAST_LIMITS.ratePerSecond.max, 'Kecepatan maksimal 20 pesan/detik.')
    .optional(),
  dedupe: broadcastDedupeSchema.optional(),
  /** Tag kontak yang dipasang otomatis saat penerima MEMBALAS broadcast ini. */
  autoTagId: z.uuid().nullable().optional(),
});
export type UpdateBroadcastRequest = z.infer<typeof updateBroadcastRequestSchema>;

// ── Sumber penerima ─────────────────────────────────────────────────────────

export const broadcastImportReportSchema = z.object({
  sourceRows: z.number().int().nonnegative(),
  recipients: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  /** Baris bermasalah (nomor baris sumber, header = baris 1), maks. `issuesReported`. */
  issues: z.array(
    z.object({ row: z.number().int().positive(), issue: broadcastImportIssueSchema }),
  ),
  /** Jumlah per jenis masalah. */
  issueCounts: z.record(broadcastImportIssueSchema, z.number().int().nonnegative()),
  columns: z.array(z.string()),
  phoneColumn: z.string(),
});
export type BroadcastImportReport = z.infer<typeof broadcastImportReportSchema>;

export const broadcastImportResponseSchema = z.object({
  broadcast: broadcastCampaignSchema,
  report: broadcastImportReportSchema,
});
export type BroadcastImportResponse = z.infer<typeof broadcastImportResponseSchema>;

/** Unggah: query `phoneColumn` (opsional; bawaan deteksi otomatis). */
export const broadcastUploadQuerySchema = z.object({
  phoneColumn: columnNameSchema.optional(),
});

export const broadcastSegmentRequestSchema = z.object({
  tagIds: z.array(z.uuid()).max(10, 'Maksimal 10 tag.').default([]),
  tagMatch: z.enum(['any', 'all']).default('any'),
  attributes: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(64),
        value: z.string().trim().min(1).max(500),
      }),
    )
    .max(5, 'Maksimal 5 atribut.')
    .default([]),
});
export type BroadcastSegmentRequest = z.input<typeof broadcastSegmentRequestSchema>;

export const broadcastConnectorSourceRequestSchema = z.object({
  connectorId: z.uuid({ error: 'Pilih konektor.' }),
});

// ── Pratinjau, estimasi, alur ───────────────────────────────────────────────

export const broadcastPreviewResponseSchema = z.object({
  samples: z.array(
    z.object({
      recipientId: z.uuid(),
      row: z.number().int(),
      phone: z.string(),
      headerText: z.string().nullable(),
      text: z.string(),
      missing: z.array(z.string()),
      invalid: z.array(z.string()),
    }),
  ),
  /** Penerima tertunda yang datanya kurang/salah (akan dilewati saat diajukan). */
  problems: z.object({
    missing: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
});
export type BroadcastPreviewResponse = z.infer<typeof broadcastPreviewResponseSchema>;

export const broadcastEstimateResponseSchema = z.object({ estimate: broadcastEstimateSchema });

export const broadcastConfirmRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});
export const broadcastRejectRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Tulis alasan penolakan.')
    .max(300, 'Alasan maksimal 300 karakter.')
    .refine((value) => !hasControlCharacters(value), 'Alasan memuat karakter khusus.'),
});
export const broadcastPauseRequestSchema = z.object({});

// ── Penerima & laporan ──────────────────────────────────────────────────────

export const broadcastRecipientListQuerySchema = z.object({
  status: z
    .enum(['pending', 'skipped', 'cancelled', 'sent', 'delivered', 'read', 'failed', 'replied'])
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const broadcastRecipientSchema = z.object({
  id: z.uuid(),
  row: z.number().int(),
  phone: z.string(),
  status: broadcastRecipientStatusSchema,
  skipReason: broadcastSkipReasonSchema.nullable(),
  /** Status pesan WhatsApp (bila sudah dibuat). */
  messageStatus: messageDeliveryStatusSchema.nullable(),
  failure: z
    .object({ reason: z.string(), errorCode: z.number().int().nullable(), message: z.string() })
    .nullable(),
  conversationId: z.uuid().nullable(),
  processedAt: isoDateTimeSchema.nullable(),
  repliedAt: isoDateTimeSchema.nullable(),
});
export type BroadcastRecipient = z.infer<typeof broadcastRecipientSchema>;

export const broadcastRecipientListResponseSchema = z.object({
  recipients: z.array(broadcastRecipientSchema),
  nextCursor: z.string().nullable(),
});

export const broadcastReportSchema = z.object({
  broadcastId: z.uuid(),
  status: broadcastStatusSchema,
  recipients: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  skippedByReason: z.record(broadcastSkipReasonSchema, z.number().int().nonnegative()),
  cancelled: z.number().int().nonnegative(),
  /** Pesan dibuat, menunggu jawaban Meta. */
  sending: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(
    z.object({
      reason: z.string(),
      errorCode: z.number().int().nullable(),
      message: z.string(),
      count: z.number().int().positive(),
    }),
  ),
  replied: z.number().int().nonnegative(),
  /** Biaya perkiraan untuk pesan yang sudah terkirim/diterima/dibaca. */
  cost: z.object({ currency: z.string(), billable: z.number().int(), total: z.number() }),
  estimate: broadcastEstimateSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
});
export type BroadcastReport = z.infer<typeof broadcastReportSchema>;
export const broadcastReportResponseSchema = z.object({ report: broadcastReportSchema });

// ── Pengaturan broadcast (Pengaturan → Batas kirim, `sending.limits.manage`) ─

export const broadcastRateSchema = z.object({
  /** Kode negara (ISO-3166 alfa-2) untuk label. */
  country: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, 'Kode negara 2 huruf, mis. ID.'),
  /** Kode panggil tanpa `+`, mis. `62`. */
  callingCode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{0,3}$/, 'Kode panggil tidak valid, mis. 62.'),
  marketing: z.number().min(0).max(100_000),
  utility: z.number().min(0).max(100_000),
  authentication: z.number().min(0).max(100_000),
});
export type BroadcastRate = z.infer<typeof broadcastRateSchema>;

export const broadcastRatesSchema = z.object({
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Mata uang 3 huruf, mis. IDR.'),
  rates: z.array(broadcastRateSchema).max(50),
  /** Catatan sumber tarif (ditampilkan di estimasi). */
  source: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !hasControlCharacters(value), 'Catatan memuat karakter khusus.'),
});
export type BroadcastRates = z.infer<typeof broadcastRatesSchema>;

/**
 * Tarif bawaan = PERKIRAAN tarif per pesan Meta untuk nomor Indonesia (tarif yang tampil di penyedia
 * platform lain per 30 Sep 2026). Wajib dicek terhadap rate card resmi Meta lalu diubah di Pengaturan.
 */
export const DEFAULT_BROADCAST_RATES: BroadcastRates = {
  currency: 'IDR',
  rates: [{ country: 'ID', callingCode: '62', marketing: 593, utility: 363, authentication: 363 }],
  source:
    'Perkiraan bawaan: tarif Meta untuk nomor Indonesia seperti tampil di penyedia lain per 30 Sep 2026. Periksa rate card resmi Meta lalu sesuaikan.',
};

export const BROADCAST_SETTING_BOUNDS = {
  approvalThreshold: { default: 50, min: 1, max: 100_000 },
  maxRatePerSecond: { default: 10, min: 1, max: 20 },
  quotaReservePercent: { default: 20, min: 5, max: 90 },
  failureSpikePercent: { default: 50, min: 10, max: 100 },
  failureSpikeMinSample: { default: 20, min: 5, max: 1_000 },
  spikeMultiplier: { default: 10, min: 2, max: 100 },
  spikeMinPerMinute: { default: 120, min: 10, max: 10_000 },
  spikeAbsolutePerMinute: { default: 400, min: 10, max: 100_000 },
} as const;
type SettingKey = keyof typeof BROADCAST_SETTING_BOUNDS;

const boundedSetting = (key: SettingKey, label: string) =>
  z
    .number({ error: `${label} harus angka.` })
    .int(`${label} harus bilangan bulat.`)
    .min(
      BROADCAST_SETTING_BOUNDS[key].min,
      `${label} minimal ${BROADCAST_SETTING_BOUNDS[key].min}.`,
    )
    .max(
      BROADCAST_SETTING_BOUNDS[key].max,
      `${label} maksimal ${BROADCAST_SETTING_BOUNDS[key].max.toLocaleString('id-ID')}.`,
    );

export const broadcastSettingsValuesSchema = z.object({
  /** Penerima valid DI ATAS angka ini → wajib disetujui Owner/Admin selain pembuat. */
  approvalThreshold: boundedSetting('approvalThreshold', 'Ambang persetujuan'),
  /** Kecepatan maksimal per kampanye (pesan/detik). */
  maxRatePerSecond: boundedSetting('maxRatePerSecond', 'Kecepatan maksimal'),
  /** Persen batas kirim harian organisasi yang TIDAK boleh dipakai broadcast (cadangan balasan CS). */
  quotaReservePercent: boundedSetting('quotaReservePercent', 'Cadangan kuota CS'),
  autoBrake: z.object({
    enabled: z.boolean(),
    /** Kampanye dijeda bila ≥ persen ini dari sampel terakhir gagal. */
    failureSpikePercent: boundedSetting('failureSpikePercent', 'Ambang gagal'),
    failureSpikeMinSample: boundedSetting('failureSpikeMinSample', 'Sampel minimal'),
    /** Rem darurat organisasi: pesan keluar non-broadcast per menit > kelipatan rata-rata 7 hari… */
    spikeMultiplier: boundedSetting('spikeMultiplier', 'Kelipatan lonjakan'),
    /** …dan > angka ini, ATAU > batas mutlak per menit. */
    spikeMinPerMinute: boundedSetting('spikeMinPerMinute', 'Lonjakan minimal per menit'),
    spikeAbsolutePerMinute: boundedSetting('spikeAbsolutePerMinute', 'Batas mutlak per menit'),
  }),
  rates: broadcastRatesSchema,
});
export type BroadcastSettingsValues = z.infer<typeof broadcastSettingsValuesSchema>;

export const DEFAULT_BROADCAST_SETTINGS: BroadcastSettingsValues = {
  approvalThreshold: BROADCAST_SETTING_BOUNDS.approvalThreshold.default,
  maxRatePerSecond: BROADCAST_SETTING_BOUNDS.maxRatePerSecond.default,
  quotaReservePercent: BROADCAST_SETTING_BOUNDS.quotaReservePercent.default,
  autoBrake: {
    enabled: true,
    failureSpikePercent: BROADCAST_SETTING_BOUNDS.failureSpikePercent.default,
    failureSpikeMinSample: BROADCAST_SETTING_BOUNDS.failureSpikeMinSample.default,
    spikeMultiplier: BROADCAST_SETTING_BOUNDS.spikeMultiplier.default,
    spikeMinPerMinute: BROADCAST_SETTING_BOUNDS.spikeMinPerMinute.default,
    spikeAbsolutePerMinute: BROADCAST_SETTING_BOUNDS.spikeAbsolutePerMinute.default,
  },
  rates: DEFAULT_BROADCAST_RATES,
};

export const broadcastSettingsSchema = broadcastSettingsValuesSchema.extend({
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type BroadcastSettings = z.infer<typeof broadcastSettingsSchema>;
export const broadcastSettingsResponseSchema = z.object({ settings: broadcastSettingsSchema });
export const updateBroadcastSettingsRequestSchema = broadcastSettingsValuesSchema.extend({
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateBroadcastSettingsRequest = z.input<typeof updateBroadcastSettingsRequestSchema>;

/** Tarif per kategori untuk nomor ini (kode panggil terpanjang yang cocok), atau `null`. */
export function broadcastRateFor(
  rates: BroadcastRates,
  phone: string,
  category: TemplateCategory,
): number | null {
  const digits = phone.replace(/^\+/, '');
  let best: BroadcastRate | null = null;
  for (const rate of rates.rates) {
    if (digits.startsWith(rate.callingCode)) {
      if (!best || rate.callingCode.length > best.callingCode.length) best = rate;
    }
  }
  if (!best) return null;
  return category === 'MARKETING'
    ? best.marketing
    : category === 'UTILITY'
      ? best.utility
      : best.authentication;
}

export { TEMPLATE_CATEGORIES as BROADCAST_TEMPLATE_CATEGORIES };

// ── Konektor REST (sumber penerima dari aplikasi billing) ───────────────────

const headerNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'Nama header hanya huruf, angka, dan tanda minus.')
  .refine(
    (value) =>
      ![
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'cookie',
        'te',
        'upgrade',
      ].includes(value.toLowerCase()),
    'Header ini tidak boleh diatur.',
  );

const fieldPathSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Jalur data, mis. data.items (kosong = akar).');

export const broadcastConnectorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  /** `null` = tanpa header autentikasi. */
  authHeaderName: z.string().nullable(),
  /** 4 karakter terakhir nilai header (rahasia tidak pernah dikirim balik). */
  authHeaderTail: z.string().nullable(),
  itemsPath: z.string(),
  phoneField: z.string(),
  lastTest: z
    .object({
      ok: z.boolean(),
      code: z.string(),
      message: z.string(),
      items: z.number().int().nullable(),
      at: isoDateTimeSchema,
    })
    .nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type BroadcastConnector = z.infer<typeof broadcastConnectorSchema>;

export const broadcastConnectorListResponseSchema = z.object({
  connectors: z.array(broadcastConnectorSchema),
});
export const broadcastConnectorResponseSchema = z.object({ connector: broadcastConnectorSchema });
/** Daftar ringkas untuk pembuat kampanye (`broadcast.send`): ID + nama saja. */
export const broadcastConnectorOptionsResponseSchema = z.object({
  connectors: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export const broadcastConnectorIdParamsSchema = z.object({ connectorId: z.string() });

const connectorNameSchema = z
  .string()
  .trim()
  .min(1, 'Nama konektor wajib diisi.')
  .max(60, 'Nama konektor maksimal 60 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Nama memuat karakter khusus.');

const headerValueSchema = z
  .string()
  .min(1, 'Nilai header wajib diisi.')
  .max(2_000, 'Nilai header terlalu panjang.')
  .refine((value) => !/[\r\n\0]/.test(value), 'Nilai header tidak boleh memuat baris baru.');

export const createBroadcastConnectorRequestSchema = z.object({
  name: connectorNameSchema,
  url: z.string().trim().min(1, 'URL wajib diisi.').max(2_000, 'URL terlalu panjang.'),
  auth: z.object({ headerName: headerNameSchema, headerValue: headerValueSchema }).nullable(),
  itemsPath: fieldPathSchema.default(''),
  phoneField: z.string().trim().min(1, 'Nama isian nomor wajib diisi.').max(64),
  confirmation: identityConfirmationSchema.optional(),
});
export type CreateBroadcastConnectorRequest = z.input<typeof createBroadcastConnectorRequestSchema>;

export const updateBroadcastConnectorRequestSchema = z.object({
  name: connectorNameSchema.optional(),
  url: z.string().trim().min(1).max(2_000).optional(),
  /** `undefined` = tidak diubah; `null` = hapus header; objek = ganti (konfirmasi identitas). */
  auth: z
    .object({ headerName: headerNameSchema, headerValue: headerValueSchema })
    .nullable()
    .optional(),
  itemsPath: fieldPathSchema.optional(),
  phoneField: z.string().trim().min(1).max(64).optional(),
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateBroadcastConnectorRequest = z.input<typeof updateBroadcastConnectorRequestSchema>;

export const BROADCAST_CONNECTOR_TEST_CODES = [
  'ok',
  'invalid_url',
  'blocked_address',
  'private_not_allowed',
  'https_required',
  'dns',
  'timeout',
  'network',
  'http_error',
  'auth_failed',
  'too_large',
  'not_json',
  'items_not_found',
  'phone_field_missing',
  'too_many_items',
] as const;
export type BroadcastConnectorTestCode = (typeof BROADCAST_CONNECTOR_TEST_CODES)[number];

export const BROADCAST_CONNECTOR_TEST_MESSAGES: Readonly<
  Record<BroadcastConnectorTestCode, string>
> = {
  ok: 'Data berhasil diambil.',
  invalid_url: 'URL tidak valid atau port tidak diizinkan.',
  blocked_address: 'Alamat tujuan tidak diizinkan (loopback, link-local, metadata cloud).',
  private_not_allowed:
    'Alamat ada di jaringan privat yang belum diizinkan. Tambahkan CIDR-nya di Pengaturan → Integrasi → Allowlist IP privat.',
  https_required: 'Alamat publik wajib memakai https://.',
  dns: 'Nama host tidak bisa di-resolve.',
  timeout: 'Server tidak menjawab dalam 20 detik.',
  network: 'Koneksi ke server gagal.',
  http_error: 'Server menjawab dengan galat (bukan 2xx).',
  auth_failed: 'Server menolak autentikasi (401/403). Periksa header & nilainya.',
  too_large: 'Jawaban terlalu besar (maks. 5 MB).',
  not_json: 'Jawaban bukan JSON.',
  items_not_found: 'Daftar data tidak ditemukan di jalur yang diatur.',
  phone_field_missing: 'Isian nomor tidak ditemukan di data.',
  too_many_items: 'Data melebihi 20.000 baris.',
};

export const broadcastConnectorTestResponseSchema = z.object({
  ok: z.boolean(),
  code: z.enum(BROADCAST_CONNECTOR_TEST_CODES),
  message: z.string(),
  items: z.number().int().nullable(),
  columns: z.array(z.string()),
});
export type BroadcastConnectorTestResponse = z.infer<typeof broadcastConnectorTestResponseSchema>;

// ── Alarm Telegram (Pengaturan → Integrasi, `integrations.manage`) ──────────

export const telegramAlarmSettingsSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  /** 4 karakter terakhir token bot. */
  tokenTail: z.string().nullable(),
  /** ID chat/grup tujuan (angka, grup diawali `-`) atau `@kanal`. */
  chatId: z.string().nullable(),
  lastTest: z
    .object({ ok: z.boolean(), code: z.string(), message: z.string(), at: isoDateTimeSchema })
    .nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type TelegramAlarmSettings = z.infer<typeof telegramAlarmSettingsSchema>;
export const telegramAlarmSettingsResponseSchema = z.object({
  telegram: telegramAlarmSettingsSchema,
});

export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(
    /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/,
    'ID chat berupa angka (grup: -100…) atau @kanal.',
  );

export const updateTelegramAlarmRequestSchema = z.object({
  /** Kosong/tidak ada = token lama dipakai (hanya ID chat/saklar yang berubah). */
  botToken: z
    .string()
    .trim()
    .regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'Format token bot Telegram: 123456:ABC…')
    .optional(),
  chatId: telegramChatIdSchema,
  enabled: z.boolean(),
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateTelegramAlarmRequest = z.input<typeof updateTelegramAlarmRequestSchema>;

export const TELEGRAM_TEST_CODES = [
  'ok',
  'not_configured',
  'token_invalid',
  'chat_not_found',
  'forbidden',
  'rate_limited',
  'network',
  'unknown',
] as const;
export type TelegramTestCode = (typeof TELEGRAM_TEST_CODES)[number];
export const TELEGRAM_TEST_MESSAGES: Readonly<Record<TelegramTestCode, string>> = {
  ok: 'Pesan tes terkirim ke Telegram.',
  not_configured: 'Alarm Telegram belum diatur. Isi token bot dan ID chat dulu.',
  token_invalid: 'Token bot ditolak Telegram. Salin ulang dari @BotFather.',
  chat_not_found:
    'Chat tidak ditemukan. Pastikan bot sudah dimasukkan ke grup dan ID chat benar (grup diawali -100).',
  forbidden: 'Bot tidak boleh mengirim ke chat ini (dikeluarkan dari grup atau diblokir).',
  rate_limited: 'Telegram membatasi pengiriman. Coba lagi sebentar lagi.',
  network: 'Server tidak bisa menghubungi Telegram.',
  unknown: 'Telegram menolak pesan. Periksa pengaturan lalu coba lagi.',
};
export const telegramTestResponseSchema = z.object({
  ok: z.boolean(),
  code: z.enum(TELEGRAM_TEST_CODES),
  message: z.string(),
});

/** Jenis alarm sistem (dikirim ke Telegram bila diatur; isi tanpa data pelanggan). */
export const ALARM_KINDS = [
  'emergency_brake',
  'auto_brake',
  'broadcast_auto_paused',
  'broadcast_pending_approval',
  'broadcast_completed',
] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];

const ALARM_TITLES: Readonly<Record<AlarmKind, string>> = {
  emergency_brake: 'Rem darurat pengiriman ditarik',
  auto_brake: 'Rem otomatis: semua pengiriman dihentikan',
  broadcast_auto_paused: 'Broadcast dijeda otomatis',
  broadcast_pending_approval: 'Broadcast menunggu persetujuan',
  broadcast_completed: 'Broadcast selesai',
};

/**
 * Teks alarm Telegram (teks polos, tanpa data pelanggan). `details` dari outbox: nama kampanye,
 * alasan (kode dikenal), jumlah.
 */
export function alarmText(
  productName: string,
  kind: AlarmKind,
  details: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const lines = [`[${productName}] ${ALARM_TITLES[kind]}`];
  const campaign = typeof details.campaign === 'string' ? details.campaign : null;
  if (campaign) lines.push(`Kampanye: ${campaign}`);
  const reason = details.reason;
  if (typeof reason === 'string') {
    const label = (BROADCAST_PAUSE_REASONS as readonly string[]).includes(reason)
      ? BROADCAST_PAUSE_REASON_LABELS[reason as BroadcastPauseReason]
      : reason;
    lines.push(`Alasan: ${label}`);
  }
  for (const [key, label] of [
    ['recipients', 'Penerima'],
    ['sent', 'Terkirim'],
    ['failed', 'Gagal'],
    ['perMinute', 'Pesan per menit'],
    ['metaCode', 'Kode Meta'],
  ] as const) {
    const value = details[key];
    if (typeof value === 'number') lines.push(`${label}: ${value.toLocaleString('id-ID')}`);
  }
  if (kind === 'emergency_brake' || kind === 'auto_brake' || kind === 'broadcast_auto_paused') {
    lines.push('Periksa aplikasi, lalu lanjutkan pengiriman bila sudah aman.');
  }
  return lines.join('\n');
}
