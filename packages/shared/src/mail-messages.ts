import { z } from 'zod';

import { emailAddressSchema, isoDateTimeSchema } from './fields';
import {
  mailAccessLevelSchema,
  mailAccountColorSchema,
  mailFolderRoleSchema,
  type MailAccessLevel,
} from './mail';

/**
 * Modul Email tahap 9A bagian 2 — daftar, baca, aksi dua arah (docs/KONTRAK-API-EMAIL.md §7–§9,
 * penyimpangan §16). Skema Zod API + konstanta + pesan Indonesia tetap. Isi email = data tak
 * tepercaya: web hanya menampilkannya lewat dokumen tampilan ber-token di iframe sandbox.
 */

// ── Batas ──────────────────────────────────────────────────────────────────

export const MAIL_LIST_LIMIT = { min: 1, max: 100, default: 50 } as const;
/** Email > 25 MB: isi lengkap tidak diunduh, hanya bagian teks (≤ 1 MB). */
export const MAIL_BODY_FETCH_MAX_BYTES = 25 * 1024 * 1024;
export const MAIL_TEXT_PART_MAX_BYTES = 1024 * 1024;
export const MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const MAIL_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const MAIL_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAIL_REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAIL_REMOTE_IMAGES_MAX = 200;
export const MAIL_RAW_HEADERS_MAX_BYTES = 64 * 1024;
export const MAIL_VIEW_TOKEN_TTL_SECONDS = 10 * 60;
export const MAIL_ACTION_MAX_IDS = 100;
export const MAIL_REMOTE_IMAGE_SENDERS_MAX = 500;
/**
 * Review 9A-2 S7: kuota cache email (lampiran + gambar inline + isi). Lampiran yang membuat cache lewat
 * kuota DITOLAK (`cache_full`); isi lama yang paling jarang dibuka digusur supaya isi baru muat.
 */
export const MAIL_CACHE_ACCOUNT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MAIL_CACHE_ORGANIZATION_MAX_BYTES = 20 * 1024 * 1024 * 1024;
/** Total berkas cache satu email (lampiran + gambar inline). */
export const MAIL_CACHE_MESSAGE_MAX_BYTES = 200 * 1024 * 1024;
/** Review 9A-2 S5: cache proksi gambar luar — 24 jam, kuota per organisasi. */
export const MAIL_REMOTE_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Review 9A-2 P2-S8: kuota cache gambar luar menghitung SEMUA baris (termasuk yang kedaluwarsa tetapi
 * belum dipangkas), tiap berkas minimal 4 KB (blok disk), dan maksimal 200.000 entri per organisasi.
 * Penuh → gambar tetap disajikan, hanya tidak disimpan.
 */
export const MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES = 200_000;
export const MAIL_REMOTE_IMAGE_CACHE_MIN_FILE_BYTES = 4096;
/**
 * Review 9A-2 R11: hapus permanen per pengguna per 24 jam (rem penyalahgunaan akun dibobol). Aksi
 * pindah/Sampah/Spam massal (≥ `MAIL_BULK_MOVE_AUDIT_MIN` email sekali minta, atau > 60 permintaan pindah
 * per jam) dicatat di audit log.
 */
export const MAIL_DELETE_PERMANENT_DAILY_MAX = 500;
export const MAIL_BULK_MOVE_AUDIT_MIN = 10;
export const MAIL_DELETE_LIMIT_MESSAGE =
  'Batas hapus permanen hari ini sudah tercapai (500 email per 24 jam). Coba lagi besok, atau minta Owner/Admin bila memang perlu.';
export const MAIL_CACHE_FULL_MESSAGE =
  'Ruang cache email penuh, jadi lampiran ini belum bisa diunduh lewat aplikasi. Buka lewat webmail penyedia.';

// ── Daftar (kontrak §7) ────────────────────────────────────────────────────

export const MAIL_LIST_VIEWS = ['inboxes', 'unread', 'starred', 'folder'] as const;
export const mailListViewSchema = z.enum(MAIL_LIST_VIEWS, {
  error: 'Tampilan daftar email tidak dikenal.',
});
export type MailListView = z.infer<typeof mailListViewSchema>;

export const mailMessageListQuerySchema = z
  .object({
    view: mailListViewSchema.default('inboxes'),
    accountId: z.uuid({ error: 'Akun email tidak valid.' }).optional(),
    folderId: z.uuid({ error: 'Folder tidak valid.' }).optional(),
    cursor: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/, 'Kursor tidak valid.')
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(MAIL_LIST_LIMIT.min)
      .max(MAIL_LIST_LIMIT.max)
      .default(MAIL_LIST_LIMIT.default),
  })
  .refine((query) => query.view !== 'folder' || query.folderId !== undefined, {
    message: 'Pilih folder untuk tampilan ini.',
    path: ['folderId'],
  });
export type MailMessageListQuery = z.infer<typeof mailMessageListQuerySchema>;

export const mailAddressSchema = z.object({ address: z.string(), name: z.string().nullable() });
export type MailAddressView = z.infer<typeof mailAddressSchema>;

export const MAIL_SENDER_VERIFICATIONS = ['pass', 'fail', 'unverified'] as const;
export const mailSenderVerificationSchema = z.enum(MAIL_SENDER_VERIFICATIONS);
export type MailSenderVerification = z.infer<typeof mailSenderVerificationSchema>;

export const MAIL_WARNING_TYPES = [
  'lookalike_sender',
  'impersonation',
  'link_mismatch',
  'dangerous_attachment',
] as const;
export const mailWarningTypeSchema = z.enum(MAIL_WARNING_TYPES);
export type MailWarningType = z.infer<typeof mailWarningTypeSchema>;

export const MAIL_WARNING_MESSAGES: Readonly<Record<MailWarningType, string>> = {
  impersonation: 'Nama pengirim mirip orang/organisasi kita, tetapi dikirim dari luar.',
  lookalike_sender: 'Alamat pengirim mirip domain kita.',
  link_mismatch:
    'Ada tautan yang teksnya berbeda dengan alamat tujuannya. Tautan itu akan membuka halaman peringatan dulu.',
  dangerous_attachment: 'Ada lampiran berisiko yang diblokir (program, makro, atau halaman web).',
};

export const MAIL_VERIFICATION_LABELS: Readonly<Record<MailSenderVerification, string>> = {
  pass: 'Terverifikasi',
  unverified: 'Pengirim tidak diverifikasi server email',
  fail: 'Email ini gagal pemeriksaan keaslian pengirim. Hati-hati dengan tautan dan lampirannya.',
};

export const mailMessageSummarySchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  folderId: z.uuid(),
  folderRole: mailFolderRoleSchema.nullable(),
  account: z.object({ id: z.uuid(), displayName: z.string(), color: mailAccountColorSchema }),
  from: mailAddressSchema.nullable(),
  to: z.array(mailAddressSchema),
  toCount: z.number().int().nonnegative(),
  ccCount: z.number().int().nonnegative(),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  receivedAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  isAnswered: z.boolean(),
  hasAttachments: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  deliveredTo: z.string().nullable(),
  deliveredToAlias: z.boolean(),
  senderVerification: mailSenderVerificationSchema,
  warnings: z.array(mailWarningTypeSchema),
  /** Aksi lokal belum tercermin di server email (mis. tandai dibaca saat akun dijeda). */
  pending: z.boolean(),
  /**
   * 9B: salinan draf MILIKKU di folder Draf server → ID draf (web membuka jendela tulis). Draf orang
   * lain tampil sebagai email biasa (tanpa isian ini).
   */
  draftId: z.uuid().optional(),
});
export type MailMessageSummary = z.infer<typeof mailMessageSummarySchema>;

export const mailMessageListResponseSchema = z.object({
  messages: z.array(mailMessageSummarySchema),
  nextCursor: z.string().nullable(),
  olderOnServer: z.boolean(),
});
export type MailMessageListResponse = z.infer<typeof mailMessageListResponseSchema>;

// ── Baca (kontrak §8) ──────────────────────────────────────────────────────

export const mailMessageIdParamsSchema = z.object({ messageId: z.string().min(1).max(100) });
export const mailAttachmentIdParamsSchema = z.object({ attachmentId: z.string().min(1).max(100) });

export const MAIL_BODY_STATES_VIEW = ['none', 'loading', 'ready', 'too_large', 'error'] as const;
export const mailBodyStateSchema = z.enum(MAIL_BODY_STATES_VIEW);
export type MailBodyState = z.infer<typeof mailBodyStateSchema>;

export const MAIL_ATTACHMENT_RISKS = ['ok', 'warn', 'blocked'] as const;
export const mailAttachmentRiskSchema = z.enum(MAIL_ATTACHMENT_RISKS);
export type MailAttachmentRisk = z.infer<typeof mailAttachmentRiskSchema>;

export const MAIL_ATTACHMENT_BLOCKED_MESSAGE =
  'Lampiran ini diblokir karena berisiko (program, makro, atau halaman web). Minta pengirim mengirim dalam bentuk PDF.';
export const MAIL_ATTACHMENT_WARN_MESSAGE =
  'Berkas arsip (ZIP/RAR/7z) bisa berisi program berbahaya. Buka hanya bila kamu mengenal pengirimnya.';
export const MAIL_ATTACHMENT_TOO_LARGE_MESSAGE =
  'Lampiran terlalu besar untuk diunduh lewat aplikasi. Buka lewat webmail penyedia.';
export const MAIL_ACTION_FAILED_MESSAGE = 'Perubahan belum tersimpan di server email. Coba lagi.';

export const mailAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  isInline: z.boolean(),
  risk: mailAttachmentRiskSchema,
  riskMessage: z.string().nullable(),
  /** Gambar raster (PNG/JPEG/GIF/WebP) yang boleh dipratinjau. */
  previewable: z.boolean(),
  /** Sudah ada di cache server (unduh langsung 200, bukan 202). */
  cached: z.boolean(),
});
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

export const mailMessageDetailSchema = mailMessageSummarySchema.extend({
  cc: z.array(mailAddressSchema),
  /** Hanya pesan di Terkirim/Draf. */
  bcc: z.array(mailAddressSchema).nullable(),
  replyTo: z.array(mailAddressSchema),
  messageIdHeader: z.string().nullable(),
  myLevel: mailAccessLevelSchema,
  receivedVia: z.object({
    accountId: z.uuid(),
    displayName: z.string(),
    address: z.string(),
  }),
  verification: z.object({
    result: mailSenderVerificationSchema,
    label: z.string(),
    spf: z.string().nullable(),
    dkim: z.string().nullable(),
    dmarc: z.string().nullable(),
    authServId: z.string().nullable(),
  }),
  warningDetails: z.array(z.object({ type: mailWarningTypeSchema, message: z.string() })),
  body: z.object({
    state: mailBodyStateSchema,
    hasHtml: z.boolean(),
    /** Teks polos (tampilan alternatif); `null` selama belum diambil. */
    text: z.string().nullable(),
    remoteImages: z.object({
      count: z.number().int().nonnegative(),
      senderAllowed: z.boolean(),
      /** Email gagal verifikasi: gambar tidak pernah tampil otomatis. */
      autoBlocked: z.boolean(),
    }),
  }),
  attachments: z.array(mailAttachmentSchema),
  /** 9B: kunci utas opak (HMAC) — dibandingkan dengan `mail.message.created.threadKey`. */
  threadKey: z.string().nullable().optional(),
  /** 9B: rekan yang sedang membalas utas ini (presence; diri sendiri tidak ikut). */
  composing: z.array(z.object({ user: z.object({ id: z.uuid(), name: z.string() }) })).optional(),
});
export type MailMessageDetail = z.infer<typeof mailMessageDetailSchema>;

export const mailMessageDetailResponseSchema = z.object({ message: mailMessageDetailSchema });

export const mailMessageViewRequestSchema = z
  .object({ images: z.enum(['auto', 'show']).default('auto') })
  .strict();
export type MailMessageViewRequest = z.infer<typeof mailMessageViewRequestSchema>;

export const mailMessageViewResponseSchema = z.object({
  /** Path dokumen tampilan (relatif ke origin aplikasi) untuk `<iframe sandbox src>`. */
  url: z.string(),
  expiresAt: isoDateTimeSchema,
  remoteImages: z.object({ count: z.number().int().nonnegative(), shown: z.boolean() }),
});
export type MailMessageViewResponse = z.infer<typeof mailMessageViewResponseSchema>;

export const mailViewTokenParamsSchema = z.object({
  token: z.string().min(1).max(100),
});
export const mailViewImageParamsSchema = mailViewTokenParamsSchema.extend({
  index: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAIL_REMOTE_IMAGES_MAX - 1),
});
export const mailViewCidParamsSchema = mailViewTokenParamsSchema.extend({
  attachmentId: z.string().min(1).max(100),
});

export const mailSourceQuerySchema = z.object({ download: z.enum(['1']).optional() });
export const mailAttachmentQuerySchema = z.object({ confirm: z.enum(['1']).optional() });
export const mailAttachmentLoadingResponseSchema = z.object({ state: z.literal('loading') });

export const mailRemoteImageSenderSchema = z.object({
  address: z.string(),
  createdAt: isoDateTimeSchema,
});
export const mailRemoteImageSendersResponseSchema = z.object({
  senders: z.array(mailRemoteImageSenderSchema),
});
export const mailRemoteImageSenderRequestSchema = z
  .object({ address: emailAddressSchema })
  .strict();

// ── Aksi dua arah (kontrak §9) ─────────────────────────────────────────────

export const MAIL_ACTIONS = [
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'move',
  'archive',
  'trash',
  'spam',
  'not_spam',
  'delete_permanently',
] as const;
export const mailActionSchema = z.enum(MAIL_ACTIONS, { error: 'Aksi email tidak dikenal.' });
export type MailAction = z.infer<typeof mailActionSchema>;

/** Hak minimum per aksi (kontrak §2 tabel, keputusan #4). */
export const MAIL_ACTION_MIN_LEVEL: Readonly<Record<MailAction, MailAccessLevel>> = {
  mark_read: 'read',
  mark_unread: 'read',
  star: 'read',
  unstar: 'read',
  move: 'send',
  archive: 'send',
  trash: 'send',
  spam: 'send',
  not_spam: 'send',
  delete_permanently: 'manage',
};

/** Aksi yang memindah pesan (butuh `mail.send` juga). */
export const MAIL_MOVE_ACTIONS: readonly MailAction[] = [
  'move',
  'archive',
  'trash',
  'spam',
  'not_spam',
  'delete_permanently',
];

export const mailActionRequestSchema = z
  .object({
    messageIds: z
      .array(z.string().min(1).max(100))
      .min(1, 'Pilih minimal satu email.')
      .max(MAIL_ACTION_MAX_IDS, `Maksimal ${String(MAIL_ACTION_MAX_IDS)} email sekali jalan.`),
    action: mailActionSchema,
    targetFolderId: z.uuid({ error: 'Folder tujuan tidak valid.' }).optional(),
  })
  .strict()
  .refine((body) => body.action !== 'move' || body.targetFolderId !== undefined, {
    message: 'Pilih folder tujuan.',
    path: ['targetFolderId'],
  });
export type MailActionRequest = z.infer<typeof mailActionRequestSchema>;

export const mailActionResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const mailActionResponseSchema = z.object({
  results: z.array(mailActionResultSchema),
  applied: z.number().int().nonnegative(),
});
export type MailActionResponse = z.infer<typeof mailActionResponseSchema>;

/** Halaman peringatan web untuk tautan menipu (kontrak §8). */
export const MAIL_LINK_WARNING_PATH = '/email/tautan';
