import { z } from 'zod';

import { identityConfirmationSchema } from './identity';

/**
 * Tahap 9.1 — kirim email lewat API untuk n8n/billing (docs/KONTRAK-API-EMAIL-KIRIM.md). Skema di
 * sini sengaja longgar untuk isian yang butuh `details[].reason` (penerima, metadata, QRIS,
 * lampiran, jadwal): Zod memeriksa BENTUK, aturan maknanya diperiksa server dengan kode alasan stabil.
 */

// ── Pengirim ─────────────────────────────────────────────────────────────────

export const EMAIL_SENDER_KINDS = ['channel', 'account'] as const;
export type EmailSenderKind = (typeof EMAIL_SENDER_KINDS)[number];

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SENDER_ID_PATTERN = new RegExp(`^(chn|acc)_(${UUID_PATTERN})$`);

/** ID pengirim berawalan jenis: `chn_<uuid channel>` (Channel Email) · `acc_<uuid akun>` (9B+). */
export function emailSenderId(kind: EmailSenderKind, id: string): string {
  return `${kind === 'channel' ? 'chn' : 'acc'}_${id}`;
}

export function parseEmailSenderId(value: string): { kind: EmailSenderKind; id: string } | null {
  const match = SENDER_ID_PATTERN.exec(value.trim().toLowerCase());
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] === 'chn' ? 'channel' : 'account', id: match[2] };
}

/**
 * `ok` · `throttled` (server SMTP minta jeda) · `paused` (dijeda Owner/Admin) · `blocked` (login SMTP
 * ditolak / kredensial tidak terbuka) · `disabled` (channel nonaktif).
 */
export const EMAIL_SENDER_STATES = ['ok', 'throttled', 'paused', 'blocked', 'disabled'] as const;
export type EmailSenderState = (typeof EMAIL_SENDER_STATES)[number];

export const EMAIL_SENDER_BLOCKED_REASONS = [
  'smtp_auth_failed',
  'credentials_unavailable',
  'smtp_config_invalid',
] as const;
export type EmailSenderBlockedReason = (typeof EMAIL_SENDER_BLOCKED_REASONS)[number];
export const EMAIL_SENDER_BLOCKED_LABELS: Readonly<Record<EmailSenderBlockedReason, string>> = {
  smtp_auth_failed:
    'Username atau password SMTP ditolak server email. Perbaiki di Pengaturan → Channel.',
  credentials_unavailable:
    'Password SMTP tersimpan tidak bisa dibuka. Simpan ulang kredensial di Pengaturan → Channel.',
  smtp_config_invalid:
    'Pengaturan SMTP channel tidak bisa dipakai (host/port/keamanan). Periksa di Pengaturan → Channel.',
};

export const EMAIL_HOURLY_LIMIT_DEFAULT = 100;
export const EMAIL_HOURLY_LIMIT_MIN = 1;
export const EMAIL_HOURLY_LIMIT_MAX = 5_000;
/** Antrean pengirim dianggap penuh bila menunggu > N × batas per jam. */
export const EMAIL_SENDER_QUEUE_FACTOR = 24;

// ── Batas isi ────────────────────────────────────────────────────────────────

export const EMAIL_RECIPIENTS_MAX = 50;
export const EMAIL_ATTACHMENTS_MAX = 10;
export const EMAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Batas body `POST /public/email/send` (lampiran base64 20 MB + JSON). */
export const EMAIL_SEND_BODY_LIMIT_BYTES = 28 * 1024 * 1024;
export const EMAIL_SCHEDULE_MAX_DAYS = 30;
export const EMAIL_METADATA_MAX_KEYS = 20;
export const EMAIL_METADATA_MAX_BYTES = 2_048;
export const EMAIL_METADATA_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
export const EMAIL_VARIABLE_VALUE_MAX = 1_000;
export const EMAIL_SUBJECT_MAX_LENGTH = 200;
export const EMAIL_FROM_NAME_MAX = 80;
export const EMAIL_CID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Tertahan (rem/jeda/terblokir/throttle) lebih lama dari ini sejak dibuat → gagal final. */
export const EMAIL_HOLD_MAX_HOURS = 24;

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const recipientInputSchema = z.object({
  email: z.string({ error: 'Alamat email wajib diisi.' }).max(400),
  name: z.string().max(200).optional(),
});
export type EmailRecipientInput = z.infer<typeof recipientInputSchema>;

const attachmentInputSchema = z.object({
  filename: z.string({ error: 'Nama berkas lampiran wajib diisi.' }).min(1).max(200),
  contentBase64: z.string().max(EMAIL_SEND_BODY_LIMIT_BYTES).optional(),
  mediaId: z.string().max(80).optional(),
  url: z.string().max(2_048).optional(),
  inline: z.boolean().optional(),
  cid: z.string().max(100).optional(),
});
export type EmailAttachmentInput = z.infer<typeof attachmentInputSchema>;

const qrisInputSchema = z.object({
  payload: z.string({ error: 'Teks QRIS wajib diisi.' }).max(2_000),
  cid: z.string().max(100).optional(),
  attach: z.boolean().optional(),
  filename: z.string().min(1).max(200).optional(),
  sizePx: z.number().int().min(240).max(1_024).optional(),
});
export type EmailQrisInput = z.infer<typeof qrisInputSchema>;

/** Isian isi email yang sama untuk `send` dan `reply`. */
const contentFields = {
  fromAddress: z.string().max(400).optional(),
  fromName: z.string().max(200).optional(),
  cc: z.array(recipientInputSchema).max(200).optional(),
  bcc: z.array(recipientInputSchema).max(200).optional(),
  replyTo: z.string().max(400).optional(),
  templateId: z.string().min(1).max(100).optional(),
  variables: z
    .record(z.string().max(100), scalarSchema)
    .refine((value) => Object.keys(value).length <= 200, 'Variabel terlalu banyak.')
    .optional(),
  subject: z.string().max(2_000).optional(),
  html: z.string().max(1_048_576).optional(),
  text: z.string().max(524_288).optional(),
  layout: z.enum(['brand', 'none']).optional(),
  qris: qrisInputSchema.optional(),
  attachments: z.array(attachmentInputSchema).max(100).optional(),
  metadata: z.record(z.string().max(200), scalarSchema).optional(),
};

/** `POST /public/email/send`. */
export const emailSendRequestSchema = z.object({
  senderId: z.string({ error: 'senderId wajib diisi.' }).min(1).max(100),
  to: z.array(recipientInputSchema).min(1, 'Isi minimal satu penerima di to.').max(200),
  scheduledAt: z.string().max(64).optional(),
  conversation: z.enum(['none', 'create']).optional(),
  ...contentFields,
});
export type EmailSendRequest = z.infer<typeof emailSendRequestSchema>;

/** `POST /public/email/messages/:id/reply` — tanpa `senderId`, `to`, `conversation`, `scheduledAt`. */
export const emailReplyRequestSchema = z.object(contentFields);
export type EmailReplyRequest = z.infer<typeof emailReplyRequestSchema>;

// ── Status ───────────────────────────────────────────────────────────────────

export const EMAIL_OUTBOUND_STATUSES = [
  'scheduled',
  'queued',
  'sending',
  'sent',
  'failed',
  'bounced',
  'canceled',
] as const;
export type EmailOutboundStatus = (typeof EMAIL_OUTBOUND_STATUSES)[number];
export const EMAIL_OUTBOUND_SOURCES = ['api', 'test'] as const;
export type EmailOutboundSource = (typeof EMAIL_OUTBOUND_SOURCES)[number];

export const EMAIL_FAILURE_REASONS = [
  'recipient_rejected',
  'message_rejected',
  'sender_rejected',
  'sender_unavailable',
  'sender_not_allowed',
  'sending_paused_expired',
  'throttle_expired',
  'delivery_unknown',
  'attachment_unavailable',
  'credentials_unavailable',
] as const;
export type EmailFailureReason = (typeof EMAIL_FAILURE_REASONS)[number];

/** Pesan tetap (teks balasan server SMTP tidak pernah diteruskan). */
export const EMAIL_FAILURE_MESSAGES: Readonly<Record<EmailFailureReason, string>> = {
  recipient_rejected: 'Server email menolak semua alamat penerima.',
  message_rejected: 'Server email menolak isi email ini (ukuran, kebijakan, atau dianggap spam).',
  sender_rejected: 'Server email menolak alamat Dari. Periksa alias/alamat pengirim di akun SMTP.',
  sender_unavailable:
    'Pengirim nonaktif, dihapus, atau terblokir lebih dari 24 jam, jadi email tidak dikirim.',
  sender_not_allowed:
    'API key ini sudah dicabut, kedaluwarsa, atau tidak lagi boleh memakai pengirim ini.',
  sending_paused_expired:
    'Email tertahan rem darurat atau jeda pengirim lebih dari 24 jam, jadi tidak dikirim.',
  throttle_expired:
    'Server email terus meminta jeda selama lebih dari 24 jam, jadi email tidak dikirim.',
  delivery_unknown:
    'Sambungan ke server email terputus setelah isi terkirim. Email mungkin sudah sampai, jadi tidak dicoba ulang.',
  attachment_unavailable: 'Berkas lampiran tidak tersedia lagi.',
  credentials_unavailable: 'Kredensial SMTP pengirim tidak bisa dibuka.',
};

const recipientSchema = z.object({ email: z.string(), name: z.string().nullable().optional() });

export const emailSenderRefSchema = z.object({
  id: z.string(),
  kind: z.enum(EMAIL_SENDER_KINDS),
  address: z.string(),
});

export const emailFailureSchema = z.object({
  reason: z.enum(EMAIL_FAILURE_REASONS),
  message: z.string(),
  smtpCode: z.number().int().nullable(),
});

export const emailBounceSchema = z.object({
  recipient: z.string(),
  status: z.string().nullable(),
  action: z.string(),
  receivedAt: z.string(),
});
export type EmailBounce = z.infer<typeof emailBounceSchema>;

/** `GET /public/email/messages/:id` → `{ email }`. */
export const emailStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum(EMAIL_OUTBOUND_STATUSES),
  source: z.enum(EMAIL_OUTBOUND_SOURCES),
  sender: emailSenderRefSchema,
  from: z.string(),
  to: z.array(recipientSchema),
  cc: z.array(recipientSchema),
  bcc: z.array(recipientSchema),
  subject: z.string(),
  template: z
    .object({ id: z.uuid(), slug: z.string(), version: z.number().int().nullable() })
    .nullable(),
  sanitized: z.boolean(),
  idempotencyKey: z.string().nullable(),
  metadata: z.record(z.string(), scalarSchema).nullable(),
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  messageIdHeader: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  repliedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  attempts: z.number().int(),
  failure: emailFailureSchema.nullable(),
  rejectedRecipients: z.array(z.string()),
  bounces: z.array(emailBounceSchema),
});
export type EmailStatus = z.infer<typeof emailStatusSchema>;
export const emailStatusResponseSchema = z.object({ email: emailStatusSchema });

/** Respons 202 (baru) / 200 (ulangan `Idempotency-Key`) `POST /public/email/send`. */
export const emailSendResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(EMAIL_OUTBOUND_STATUSES),
  senderId: z.string(),
  recipientCount: z.number().int(),
  scheduledAt: z.string().nullable(),
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  /** HTML luar dikirim setelah ada bagian yang dibuang sanitasi. */
  sanitized: z.boolean(),
});
export type EmailSendResponse = z.infer<typeof emailSendResponseSchema>;

export const emailReplyResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(EMAIL_OUTBOUND_STATUSES),
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  sanitized: z.boolean(),
});

export const emailIdParamsSchema = z.object({ emailId: z.string() });

// ── Daftar pengirim, template, media (API publik) ────────────────────────────

export const publicEmailSenderSchema = z.object({
  id: z.string(),
  kind: z.enum(EMAIL_SENDER_KINDS),
  name: z.string(),
  address: z.string(),
  fromAddress: z.string(),
  fromName: z.string(),
  aliases: z.array(z.string()),
  replyToFixed: z.boolean(),
  bounceTracking: z.boolean(),
  hourlyLimit: z.number().int(),
  sentLastHour: z.number().int(),
  queued: z.number().int(),
  state: z.enum(EMAIL_SENDER_STATES),
  throttledUntil: z.string().nullable(),
});
export type PublicEmailSender = z.infer<typeof publicEmailSenderSchema>;
export const publicEmailSendersResponseSchema = z.object({
  senders: z.array(publicEmailSenderSchema),
});

export const publicEmailTemplateSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  version: z.number().int(),
  layout: z.enum(['brand', 'none']),
  hasQrisSlot: z.boolean(),
  updatedAt: z.string(),
  variables: z.array(
    z.object({ name: z.string(), label: z.string(), required: z.boolean(), example: z.string() }),
  ),
});
export const publicEmailTemplatesResponseSchema = z.object({
  templates: z.array(publicEmailTemplateSchema),
});

export const emailMediaResponseSchema = z.object({
  media: z.object({
    id: z.uuid(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    expiresAt: z.string(),
  }),
});

// ── Pengaturan: batas & jeda per pengirim (§8.1) ─────────────────────────────

export const emailSenderSettingsSchema = z.object({
  id: z.string(),
  kind: z.enum(EMAIL_SENDER_KINDS),
  name: z.string(),
  address: z.string(),
  smtpMode: z.enum(['system', 'custom']),
  hourlyLimit: z.number().int(),
  sentLastHour: z.number().int(),
  queued: z.number().int(),
  state: z.enum(EMAIL_SENDER_STATES),
  throttledUntil: z.string().nullable(),
  blockedReason: z.enum(EMAIL_SENDER_BLOCKED_REASONS).nullable(),
  pausedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  pausedAt: z.string().nullable(),
});
export type EmailSenderSettings = z.infer<typeof emailSenderSettingsSchema>;
export const emailSenderSettingsListResponseSchema = z.object({
  senders: z.array(emailSenderSettingsSchema),
});
export const emailSenderSettingsResponseSchema = z.object({ sender: emailSenderSettingsSchema });
export const emailSenderIdParamsSchema = z.object({ senderId: z.string() });

export const updateEmailSenderLimitRequestSchema = z.object({
  hourlyLimit: z
    .number({ error: 'Batas per jam wajib diisi.' })
    .int('Batas per jam harus bilangan bulat.')
    .min(EMAIL_HOURLY_LIMIT_MIN, `Batas per jam minimal ${String(EMAIL_HOURLY_LIMIT_MIN)}.`)
    .max(
      EMAIL_HOURLY_LIMIT_MAX,
      `Batas per jam maksimal ${EMAIL_HOURLY_LIMIT_MAX.toLocaleString('id-ID')}.`,
    ),
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateEmailSenderLimitRequest = z.input<typeof updateEmailSenderLimitRequestSchema>;

export const pauseEmailSenderRequestSchema = z.object({
  reason: z.string().trim().max(200, 'Alasan maksimal 200 karakter.').optional(),
});
export const resumeEmailSenderRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});

// ── Pengaturan: riwayat kirim API (§8.3) ─────────────────────────────────────

export const EMAIL_OUTBOUND_PAGE_DEFAULT = 50;
export const EMAIL_OUTBOUND_PAGE_MAX = 100;

export const emailOutboundListQuerySchema = z.object({
  apiKeyId: z.uuid().optional(),
  senderId: z.string().max(100).optional(),
  status: z.enum(EMAIL_OUTBOUND_STATUSES).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(EMAIL_OUTBOUND_PAGE_MAX).optional(),
});
export type EmailOutboundListQuery = z.infer<typeof emailOutboundListQuerySchema>;

export const emailOutboundEntrySchema = z.object({
  id: z.uuid(),
  status: z.enum(EMAIL_OUTBOUND_STATUSES),
  source: z.enum(EMAIL_OUTBOUND_SOURCES),
  apiKey: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  sender: emailSenderRefSchema,
  /** Tersamar: `bu***@co***.example`. Bcc tidak ditampilkan. */
  recipients: z.array(z.string()),
  recipientCount: z.number().int(),
  subject: z.string(),
  template: z
    .object({ id: z.uuid(), slug: z.string(), version: z.number().int().nullable() })
    .nullable(),
  metadata: z.record(z.string(), scalarSchema).nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  failure: emailFailureSchema.nullable(),
});
export type EmailOutboundEntry = z.infer<typeof emailOutboundEntrySchema>;
export const emailOutboundListResponseSchema = z.object({
  emails: z.array(emailOutboundEntrySchema),
  nextCursor: z.string().nullable(),
});

/**
 * Alamat tersamar untuk riwayat/log: 2 huruf pertama bagian lokal + `***` @ 2 huruf pertama label
 * domain pertama + `***` + akhiran (`bu***@co***.example`).
 */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.indexOf('.');
  const label = dot === -1 ? domain : domain.slice(0, dot);
  const suffix = dot === -1 ? '' : domain.slice(dot);
  return `${local.slice(0, 2)}***@${label.slice(0, 2)}***${suffix}`;
}
