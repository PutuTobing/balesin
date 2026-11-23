import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';
import {
  mailAccessLevelSchema,
  mailAccountColorSchema,
  mailAccountKindSchema,
  type MailFolderRole,
} from './mail';

/**
 * Modul Email tahap 9B — tulis, balas, teruskan (docs/KONTRAK-API-EMAIL-TULIS.md): identitas &
 * verifikasi, tanda tangan, preferensi, draf (simpan otomatis + konflik versi), lampiran draf,
 * kirim/outbox/batalkan kirim, snippet, saran penerima, presence. Juga fungsi murni bersama api &
 * worker (penerima balasan, awalan subjek, `References`, akar utas).
 *
 * Draf, outbox, preferensi = PRIBADI pembuatnya (404 untuk orang lain, termasuk Owner). Kirim hanya
 * dari identitas `verified` (api DAN worker).
 */

// ── Konstanta ──────────────────────────────────────────────────────────────

export const MAIL_IDENTITY_VERIFICATION_STATES = ['unverified', 'pending', 'verified'] as const;
export const mailIdentityVerificationStateSchema = z.enum(MAIL_IDENTITY_VERIFICATION_STATES);
export type MailIdentityVerificationState = z.infer<typeof mailIdentityVerificationStateSchema>;
export const MAIL_IDENTITY_VERIFIED_METHODS = ['mailbox', 'code'] as const;
export type MailIdentityVerifiedMethod = (typeof MAIL_IDENTITY_VERIFIED_METHODS)[number];

/** Kode berlaku 30 menit; 5 percobaan per kode; cadangan SEARCH maks. 15 menit. */
export const MAIL_VERIFICATION_TTL_MINUTES = 30;
export const MAIL_VERIFICATION_MAX_ATTEMPTS = 5;
export const MAIL_VERIFICATION_AUTO_CHECK_MINUTES = 15;
export const MAIL_VERIFICATION_LIMITS = {
  perIdentity: 3,
  perUser: 10,
  perOrganization: 50,
  windowSeconds: 24 * 60 * 60,
} as const;
export const MAIL_VERIFICATION_UNAVAILABLE_REASONS = [
  'system_sender_missing',
  'system_sender_conflict',
  /** Review 9B S3: identitas akun pribadi berdomain organisasi belum disetujui Owner/Admin. */
  'approval_pending',
  /** Review 9B S3: ditolak Owner/Admin (hapus alias / ganti alamat). */
  'approval_rejected',
] as const;
export type MailVerificationUnavailableReason =
  (typeof MAIL_VERIFICATION_UNAVAILABLE_REASONS)[number];
export const MAIL_VERIFICATION_UNAVAILABLE_MESSAGES: Readonly<
  Record<MailVerificationUnavailableReason, string>
> = {
  system_sender_missing:
    'Atur Email pengirim di Pengaturan dulu supaya email verifikasi bisa dikirim.',
  system_sender_conflict:
    'Kotak surat Email pengirim sistem juga terhubung sebagai akun di menu Email, jadi verifikasi alamat dikunci di seluruh organisasi. Ganti Email pengirim ke kotak surat lain (mis. noreply@) atau putuskan akun itu.',
  approval_pending:
    'Alamat ini memakai domain organisasi, jadi perlu disetujui Owner/Admin dulu sebelum bisa diverifikasi.',
  approval_rejected: 'Owner/Admin menolak alamat ini sebagai alamat pengirim akun pribadi.',
};

/**
 * Review 9B S3: identitas (utama/alias) akun PRIBADI yang domainnya domain organisasi (domain identitas
 * akun Email bersama, Channel Email + alias, Email pengirim sistem) wajib disetujui Owner/Admin sebelum
 * bisa diverifikasi & dipakai mengirim. `not_required` = domain luar / akun bersama.
 */
export const MAIL_IDENTITY_APPROVAL_STATES = [
  'not_required',
  'pending',
  'approved',
  'rejected',
] as const;
export const mailIdentityApprovalStateSchema = z.enum(MAIL_IDENTITY_APPROVAL_STATES);
export type MailIdentityApprovalState = z.infer<typeof mailIdentityApprovalStateSchema>;

export const MAIL_ALIASES_PER_ACCOUNT_MAX = 20;
export const MAIL_SIGNATURES_SHARED_MAX = 20;
export const MAIL_SIGNATURES_PERSONAL_MAX = 10;
export const MAIL_SIGNATURE_HTML_MAX_BYTES = 32 * 1024;
export const MAIL_SIGNATURE_TEXT_MAX_BYTES = 8 * 1024;
export const MAIL_SIGNATURE_LOGO_UPLOAD_MAX_BYTES = 1024 * 1024;
export const MAIL_SIGNATURE_LOGO_STORED_MAX_BYTES = 128 * 1024;
export const MAIL_SIGNATURE_LOGO_MAX_WIDTH = 320;
/** Variabel tanda tangan yang diizinkan (selain ini → 400 `signature_variable_unknown`). */
export const MAIL_SIGNATURE_VARIABLES = [
  'nama_agen',
  'alamat_pengirim',
  'nama_organisasi',
  'logo',
] as const;

export const MAIL_DRAFT_MODES = ['new', 'reply', 'reply_all', 'forward'] as const;
export const mailDraftModeSchema = z.enum(MAIL_DRAFT_MODES);
export type MailDraftMode = z.infer<typeof mailDraftModeSchema>;
export const MAIL_COMPOSE_FORMATS = ['html', 'text'] as const;
export const mailComposeFormatSchema = z.enum(MAIL_COMPOSE_FORMATS);
export type MailComposeFormat = z.infer<typeof mailComposeFormatSchema>;
export const MAIL_DRAFT_STATES = ['editing', 'sending'] as const;
export type MailDraftState = (typeof MAIL_DRAFT_STATES)[number];
export const MAIL_DRAFT_SERVER_SYNC_STATES = ['pending', 'synced', 'error', 'disabled'] as const;
export type MailDraftServerSyncState = (typeof MAIL_DRAFT_SERVER_SYNC_STATES)[number];

export const MAIL_DRAFTS_PER_USER_MAX = 100;
export const MAIL_SUBJECT_MAX = 200;
export const MAIL_DRAFT_BODY_HTML_MAX_BYTES = 256 * 1024;
export const MAIL_DRAFT_BODY_TEXT_MAX_BYTES = 128 * 1024;
export const MAIL_DRAFT_RECIPIENT_FIELD_MAX = 100;
export const MAIL_DRAFT_ATTACHMENTS_MAX = 20;
export const MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const MAIL_DRAFT_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAIL_DRAFT_UPLOAD_QUOTA_BYTES = 500 * 1024 * 1024;
/**
 * Batas lama salinan draf server. Review 9B S6: worker kini memakai batas LAMPIRAN 10 MB (lebih besar →
 * draf tidak disalin, `serverCopy.state: disabled`).
 */
export const MAIL_DRAFT_SERVER_COPY_MAX_BYTES = 30 * 1024 * 1024;
export const MAIL_QUOTE_HTML_MAX_BYTES = 192 * 1024;
export const MAIL_QUOTE_TEXT_MAX_BYTES = 64 * 1024;
export const MAIL_REFERENCES_MAX = 20;

export const MAIL_ATTACHMENT_SOURCES = ['upload', 'original'] as const;
export type MailDraftAttachmentSource = (typeof MAIL_ATTACHMENT_SOURCES)[number];
export const MAIL_DRAFT_ATTACHMENT_STATES = ['ready', 'loading', 'failed'] as const;
export type MailDraftAttachmentState = (typeof MAIL_DRAFT_ATTACHMENT_STATES)[number];

export const MAIL_OUTBOX_STATUSES = [
  'pending',
  'queued',
  'sending',
  'sent',
  'failed',
  'canceled',
  /**
   * Review 9B R4: final, TIDAK diulang — SMTP terputus/basi setelah isi mungkin diterima server
   * (`failureReason: delivery_unknown`). Dihitung sebagai "mungkin terkirim" di batas & rem otomatis.
   */
  'delivery_unknown',
] as const;
export const mailOutboxStatusSchema = z.enum(MAIL_OUTBOX_STATUSES);
export type MailOutboxStatus = z.infer<typeof mailOutboxStatusSchema>;
export const MAIL_OUTBOX_ACTIVE_STATUSES = ['pending', 'queued', 'sending'] as const;
export const MAIL_OUTBOX_HOLD_REASONS = [
  'hourly_limit',
  'throttled',
  'paused',
  'blocked',
  'sending_paused',
  'account_offline',
] as const;
export const mailOutboxHoldReasonSchema = z.enum(MAIL_OUTBOX_HOLD_REASONS);
export type MailOutboxHoldReason = z.infer<typeof mailOutboxHoldReasonSchema>;
export const MAIL_OUTBOX_HOLD_MESSAGES: Readonly<Record<MailOutboxHoldReason, string>> = {
  hourly_limit: 'Tertahan batas kirim per jam akun ini.',
  throttled: 'Server email meminta jeda sebentar. Dikirim otomatis setelahnya.',
  paused: 'Pengiriman dari akun ini sedang dijeda di Pengaturan → Batas kirim.',
  blocked: 'Password SMTP akun ini ditolak — perbarui di Pengaturan → Akun email.',
  sending_paused: 'Rem darurat pengiriman sedang ditarik.',
  account_offline: 'Akun email ini sedang tidak tersambung.',
};
export const MAIL_SENT_COPY_STATES = [
  'pending',
  'done',
  'server_saved',
  'skipped',
  'failed',
] as const;
export const mailSentCopyStateSchema = z.enum(MAIL_SENT_COPY_STATES);
export type MailSentCopyState = z.infer<typeof mailSentCopyStateSchema>;
export const MAIL_SENT_COPY_MODES = ['auto', 'append', 'none'] as const;
export const mailSentCopyModeSchema = z.enum(MAIL_SENT_COPY_MODES, {
  error: 'Pilih cara menyimpan salinan email terkirim.',
});
export type MailSentCopyMode = z.infer<typeof mailSentCopyModeSchema>;

export const MAIL_SEND_FAILURE_REASONS = [
  'recipient_rejected',
  'message_rejected',
  'sender_rejected',
  'sender_unavailable',
  'throttle_expired',
  'sending_paused_expired',
  'delivery_unknown',
  'attachment_unavailable',
  'credentials_unavailable',
  'not_allowed',
  'identity_unverified',
  'account_unavailable',
] as const;
export const mailSendFailureReasonSchema = z.enum(MAIL_SEND_FAILURE_REASONS);
export type MailSendFailureReason = z.infer<typeof mailSendFailureReasonSchema>;
/** Pesan tetap (teks balasan server SMTP tidak pernah diteruskan). */
export const MAIL_SEND_FAILURE_MESSAGES: Readonly<Record<MailSendFailureReason, string>> = {
  recipient_rejected: 'Server email menolak semua alamat penerima.',
  message_rejected: 'Server email menolak isi email ini (ukuran, kebijakan, atau dianggap spam).',
  sender_rejected:
    "Server email menolak alamat Dari ini. Pastikan alamat ini diizinkan sebagai 'kirim sebagai' di penyedia emailmu.",
  sender_unavailable:
    'Password SMTP akun ini ditolak atau akun dijeda lebih dari 24 jam, jadi email tidak dikirim.',
  throttle_expired:
    'Server email terus meminta jeda selama lebih dari 24 jam, jadi email tidak dikirim.',
  sending_paused_expired:
    'Email tertahan rem darurat atau jeda pengirim lebih dari 24 jam, jadi tidak dikirim.',
  delivery_unknown:
    'Status pengiriman tidak pasti — cek folder Terkirim atau tanyakan penerima sebelum mengirim ulang.',
  attachment_unavailable: 'Berkas lampiran tidak tersedia lagi.',
  credentials_unavailable: 'Kredensial SMTP akun ini tidak bisa dibuka.',
  not_allowed: 'Kamu tidak lagi punya hak kirim di akun ini.',
  identity_unverified: 'Alamat pengirim perlu diverifikasi ulang.',
  account_unavailable: 'Akun email ini sedang diputus atau pemiliknya nonaktif.',
};

export const MAIL_UNDO_SEND_SECONDS = { min: 5, max: 30, default: 10 } as const;
export const MAIL_RECIPIENTS_PER_EMAIL = { min: 1, max: 100, default: 50 } as const;
export const MAIL_ATTACHMENT_TOTAL_MB = { min: 1, max: 25, default: 20 } as const;
export const MAIL_BCC_WARNING_THRESHOLD = 10;
/** Jatah alamat baru per pengguna per 24 jam (`mail-alamat-baru`). */
export const MAIL_NEW_ADDRESS_DAILY_LIMIT = 200;
export const MAIL_PRESENCE_TTL_SECONDS = 45;
export const MAIL_PRESENCE_HEARTBEAT_SECONDS = 20;
export const MAIL_CORRESPONDENTS_PER_ACCOUNT_MAX = 20_000;
/** Antrean akun penuh: penerima menunggu > 24 × batas per jam. */
export const MAIL_SENDER_QUEUE_HOURS = 24;

// ── Pesan galat (§15) ───────────────────────────────────────────────────────

export const MAIL_COMPOSE_MESSAGES = {
  identityUnverified: (address: string) =>
    `Alamat ${address} belum diverifikasi. Verifikasi dulu di Pengaturan → Akun email.`,
  draftVersionConflict: 'Draf ini diubah di tab atau perangkat lain.',
  draftLocked: 'Email ini sedang dikirim. Batalkan kirim dulu untuk mengubahnya.',
  draftLimit: 'Maksimal 100 draf. Kirim atau buang draf lama dulu.',
  threadHasNewMessages: (count: number) =>
    `Ada ${String(count)} email baru di utas ini sejak kamu mulai menulis.`,
  attachmentsNotReady: 'Lampiran masih disiapkan. Tunggu sebentar.',
  notCancelable: 'Email sudah terkirim, jadi tidak bisa dibatalkan.',
  accountDeleting: 'Akun ini sedang diputus.',
  addressInUse: 'Alamat ini sudah dipakai di akun email, channel, atau Email pengirim lain.',
  /** Review 9B S4: 409 untuk Owner/Admin menyebut pemegang alamat. */
  addressHeldBy: (holder: string) => `Alamat ini sudah dipakai ${holder}.`,
  /** Review 9B S2. */
  systemSenderMailbox:
    'Kotak surat ini dipakai sebagai Email pengirim sistem (tautan reset password, undangan, kode verifikasi). Hubungkan kotak surat lain, atau ganti Email pengirim dulu di Pengaturan → Email pengirim.',
  systemSenderMailboxTaken:
    'Kotak surat ini sudah terhubung sebagai akun di menu Email, jadi tidak bisa dipakai sebagai Email pengirim sistem (salinan tautan reset password, undangan, dan kode verifikasi akan terbaca pembaca akun itu). Pakai kotak surat lain (mis. noreply@) atau putuskan akunnya dulu.',
  approvalRequired:
    'Alamat ini memakai domain organisasi, jadi perlu disetujui Owner/Admin dulu sebelum bisa diverifikasi.',
  approvalRejected: 'Owner/Admin menolak alamat ini sebagai alamat pengirim akun pribadi.',
  approvalNotPending: 'Alamat ini tidak sedang menunggu persetujuan.',
  alreadyVerified: 'Alamat ini sudah terverifikasi.',
  aliasLimit: 'Maksimal 20 alias per akun email.',
  primaryIdentity: 'Identitas utama tidak bisa dihapus.',
  replyToNotAllowed: 'Alamat balas-ke harus satu domain dengan alamat pengirim.',
  displayNameInvalid: 'Nama tampilan 1–80 karakter, tanpa @, <, >, atau karakter khusus.',
  identityNotInAccount: 'Identitas ini bukan milik akun email draf.',
  signatureVariableUnknown: (name: string) =>
    `Variabel {{${name}}} tidak dikenal. Pakai {{nama_agen}}, {{alamat_pengirim}}, {{nama_organisasi}}, atau {{logo}}.`,
  verificationCodeInvalid: (left: number) => `Kodenya salah. Sisa ${String(left)} percobaan.`,
  verificationExpired: 'Kodenya sudah kedaluwarsa. Kirim kode baru.',
  verificationSendLimit:
    'Batas kirim kode verifikasi tercapai (3 per alamat, 10 per pengguna, 50 per organisasi per 24 jam).',
  subjectInvalid: 'Subjek maksimal 200 karakter, satu baris.',
  bodyTooLarge: 'Isi email terlalu panjang (maks. 256 KB).',
  noRecipients: 'Isi minimal satu penerima (Kepada, Cc, atau Bcc).',
  tooManyRecipients: (max: number) =>
    `Penerima maksimal ${String(max)} alamat (Kepada + Cc + Bcc). Untuk kirim massal, pakai Broadcast.`,
  attachmentTypeBlocked:
    'Jenis berkas ini tidak bisa dilampirkan (hanya PDF, gambar, dokumen Office tanpa makro, CSV/TXT).',
  attachmentTooLarge: (mb: number) =>
    `Total lampiran maksimal ${String(mb)} MB. Untuk berkas besar, bagikan tautan.`,
  attachmentsTooMany: 'Maksimal 20 lampiran per email.',
  dailyLimit: (limit: number) =>
    `Batas kirim harianmu (${String(limit)} penerima per 24 jam) sudah tercapai. Coba lagi besok atau minta Owner/Admin.`,
  newAddressQuota: (limit: number) =>
    `Jatah email ke alamat baru hari ini (${String(limit)}) sudah habis. Coba lagi besok atau minta Owner/Admin.`,
  senderQueueFull:
    'Antrean kirim akun ini sudah penuh. Tunggu sebagian email terkirim dulu, lalu coba lagi.',
  uploadQuota: 'Jatah unggah lampiran hari ini (500 MB) sudah habis. Coba lagi besok.',
} as const;

// ── Fungsi murni (api & worker) ─────────────────────────────────────────────

/** Header satu baris yang aman: tanpa CR/LF, `\p{Cc}`, U+2028/2029, pengubah arah, lebar-nol. */
export function mailHeaderTextSafe(value: string): boolean {
  return !hasControlCharacters(value);
}

/** `display_name` identitas/`fromName` 9.1: 1–80, tanpa kendali/pengubah arah, tanpa `@<>`. */
export function mailDisplayNameValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= 80 &&
    mailHeaderTextSafe(trimmed) &&
    !/[@<>"\\]/.test(trimmed)
  );
}

/** Panjang UTF-8 dalam byte (tanpa `TextEncoder`/`Buffer` — paket ini juga untuk browser). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Domain alamat (huruf kecil), atau `''`. */
export function mailDomainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase();
}

const REPLY_PREFIX = /^\s*(re|aw|bls)\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd|fw|tr)\s*:/i;

/** `Re: ` / `Fwd: ` ditambahkan kecuali sudah ada (tanpa beda huruf); tidak diterjemahkan. */
export function composeSubjectFor(mode: MailDraftMode, original: string | null): string {
  const subject = (original ?? '').replace(/\s+/g, ' ').trim();
  if (mode === 'new') return subject.slice(0, MAIL_SUBJECT_MAX);
  if (mode === 'forward') {
    return (FORWARD_PREFIX.test(subject) ? subject : `Fwd: ${subject}`)
      .trim()
      .slice(0, MAIL_SUBJECT_MAX);
  }
  return (REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`)
    .trim()
    .slice(0, MAIL_SUBJECT_MAX);
}

export interface MailComposeAddress {
  address: string;
  name: string | null;
}

/** Salinan email asli yang disimpan di draf (`source_snapshot`, §2). */
export interface MailSourceSnapshot {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: MailComposeAddress | null;
  to: MailComposeAddress[];
  cc: MailComposeAddress[];
  replyTo: MailComposeAddress[];
  subject: string | null;
  sentAt: string | null;
  folderRole: MailFolderRole | null;
}

/**
 * Penerima awal balasan (§6.1). Balas: `Reply-To` asli bila ada, selain itu `From`; email asli dari
 * folder `sent` (balas email sendiri) → `To` asli. Balas semua: Cc = `To` + `Cc` asli. Dibuang:
 * semua identitas akun ini, alamat yang sudah ada di Kepada, duplikat (tanpa beda huruf). Bcc asli
 * TIDAK PERNAH ikut. Teruskan/baru: kosong.
 */
export function replyRecipientsFor(
  mode: MailDraftMode,
  source: Pick<MailSourceSnapshot, 'from' | 'to' | 'cc' | 'replyTo' | 'folderRole'>,
  ownAddresses: readonly string[],
): { to: MailComposeAddress[]; cc: MailComposeAddress[] } {
  if (mode !== 'reply' && mode !== 'reply_all') return { to: [], cc: [] };
  const own = new Set(ownAddresses.map((address) => address.toLowerCase()));
  const fromSelf = source.folderRole === 'sent';
  const primary: MailComposeAddress[] = fromSelf
    ? source.to
    : source.replyTo.length > 0
      ? source.replyTo
      : source.from
        ? [source.from]
        : [];
  const seen = new Set<string>();
  const take = (items: readonly MailComposeAddress[], dropOwn: boolean) => {
    const result: MailComposeAddress[] = [];
    for (const item of items) {
      const address = item.address.trim().toLowerCase();
      if (address === '' || seen.has(address)) continue;
      if (dropOwn && own.has(address)) continue;
      seen.add(address);
      result.push({ address, name: item.name });
    }
    return result;
  };
  // Balas ke email sendiri: Kepada tetap penerima asli; selain itu identitas sendiri dibuang.
  const to = take(primary, !fromSelf);
  if (mode === 'reply') return { to, cc: [] };
  const cc = take([...(fromSelf ? [] : source.to), ...source.cc], true);
  return { to, cc };
}

/** `Message-ID` (tanpa `<>`) aman dipakai di header: `^[^<>\s\p{Cc}]{1,996}$`. */
const MESSAGE_ID_TOKEN = /^[^<>\s\p{Cc}]{1,996}$/u;
export function mailMessageIdTokenValid(value: string): boolean {
  return MESSAGE_ID_TOKEN.test(value) && !hasControlCharacters(value);
}

/**
 * `References` balasan: `references` asli + `Message-ID` asli, divalidasi ulang (berasal dari email
 * masuk yang tidak tepercaya), maks. 20 — akar (yang pertama) + 19 terakhir (RFC 5322).
 */
export function replyReferencesFor(
  references: readonly string[],
  messageIdHeader: string | null,
): string[] {
  const chain = [...references, ...(messageIdHeader ? [messageIdHeader] : [])].filter(
    mailMessageIdTokenValid,
  );
  const unique: string[] = [];
  for (const id of chain) if (!unique.includes(id)) unique.push(id);
  if (unique.length <= MAIL_REFERENCES_MAX) return unique;
  const [root] = unique;
  return [...(root ? [root] : []), ...unique.slice(-(MAIL_REFERENCES_MAX - 1))];
}

/** Kunci utas 9B (§2): `references[1]` → `in_reply_to` → `message_id_header` → `'id:' || id`. */
export function mailThreadRootOf(message: {
  references: readonly string[];
  inReplyTo: string | null;
  messageIdHeader: string | null;
  id: string;
}): string {
  const root = message.references[0] ?? message.inReplyTo ?? message.messageIdHeader;
  return (root ?? `id:${message.id}`).slice(0, 998);
}

/** Variabel `{{…}}` di tanda tangan yang tidak dikenal (urut, unik). */
export function unknownSignatureVariables(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/\{\{([^{}]{0,60})\}\}/g)) {
    const name = (match[1] ?? '').trim();
    if (!(MAIL_SIGNATURE_VARIABLES as readonly string[]).includes(name) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

// ── Skema bersama ──────────────────────────────────────────────────────────

const idParam = z.string().min(1).max(100);
export const mailIdentityIdParamsSchema = z.object({ identityId: idParam });
export const mailSignatureIdParamsSchema = z.object({ signatureId: idParam });
export const mailDraftIdParamsSchema = z.object({ draftId: idParam });
export const mailOutboxIdParamsSchema = z.object({ outboxId: idParam });
export const mailDraftAttachmentParamsSchema = z.object({
  draftId: z.string().min(1).max(100),
  attachmentId: z.string().min(1).max(100),
});

const nameText = z
  .string()
  .trim()
  .max(80, 'Nama penerima maksimal 80 karakter.')
  .refine(mailHeaderTextSafe, 'Nama tidak boleh memuat baris baru atau karakter khusus.')
  .refine((value) => !/[<>"\\]/.test(value), 'Nama tidak boleh memuat <, >, atau tanda kutip.');

export const mailComposeRecipientSchema = z.object({
  address: z.string().trim().min(1).max(320),
  name: nameText.nullable().optional(),
});
export type MailComposeRecipientInput = z.infer<typeof mailComposeRecipientSchema>;
const recipientList = z.array(mailComposeRecipientSchema).max(MAIL_DRAFT_RECIPIENT_FIELD_MAX, {
  error: 'Maksimal 100 alamat per kolom.',
});

export const mailAddressOutSchema = z.object({ address: z.string(), name: z.string().nullable() });

// ── Identitas (§3) ─────────────────────────────────────────────────────────

export const mailIdentityVerificationSchema = z.object({
  state: mailIdentityVerificationStateSchema,
  verifiedAt: isoDateTimeSchema.nullable(),
  method: z.enum(MAIL_IDENTITY_VERIFIED_METHODS).nullable(),
  pending: z
    .object({
      sentAt: isoDateTimeSchema.nullable(),
      expiresAt: isoDateTimeSchema,
      attemptsLeft: z.number().int().nonnegative(),
      autoCheckUntil: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  available: z.boolean(),
  unavailableReason: z.enum(MAIL_VERIFICATION_UNAVAILABLE_REASONS).nullable(),
});

export const MAIL_CANNOT_SEND_REASONS = [
  'identity_unverified',
  /** Review 9B S3: akun pribadi berdomain organisasi belum disetujui (atau ditolak) Owner/Admin. */
  'identity_not_approved',
  'level_insufficient',
  'account_deleting',
  'account_unavailable',
] as const;
export type MailCannotSendReason = (typeof MAIL_CANNOT_SEND_REASONS)[number];

export const mailIdentitySchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  address: z.string(),
  displayName: z.string(),
  isPrimary: z.boolean(),
  replyTo: z.string().nullable(),
  verification: mailIdentityVerificationSchema,
  /** Review 9B S3. `decidedAt` = waktu disetujui/ditolak (null bila belum/tidak perlu). */
  approval: z.object({
    state: mailIdentityApprovalStateSchema,
    decidedAt: isoDateTimeSchema.nullable(),
  }),
  defaultSignatures: z.object({ new: z.uuid().nullable(), reply: z.uuid().nullable() }),
  canSend: z.boolean(),
  cannotSendReason: z.enum(MAIL_CANNOT_SEND_REASONS).nullable(),
  createdAt: isoDateTimeSchema,
});
export type MailIdentity = z.infer<typeof mailIdentitySchema>;

export const mailIdentityListResponseSchema = z.object({ identities: z.array(mailIdentitySchema) });
export const mailComposeIdentityListResponseSchema = z.object({
  identities: z.array(
    mailIdentitySchema.extend({
      account: z.object({
        id: z.uuid(),
        displayName: z.string(),
        color: mailAccountColorSchema,
        kind: mailAccountKindSchema,
        avatarUrl: z.string().nullable(),
      }),
    }),
  ),
});
export type MailComposeIdentityListResponse = z.infer<typeof mailComposeIdentityListResponseSchema>;
export const mailIdentityResponseSchema = z.object({ identity: mailIdentitySchema });

const displayNameInput = z
  .string({ error: 'Nama tampilan wajib diisi.' })
  .trim()
  .refine(mailDisplayNameValid, MAIL_COMPOSE_MESSAGES.displayNameInvalid);
const addressInput = z
  .string({ error: 'Alamat email wajib diisi.' })
  .trim()
  .min(3, 'Alamat email tidak valid.')
  .max(320, 'Alamat email tidak valid.');

export const createMailIdentityRequestSchema = z
  .object({
    address: addressInput,
    displayName: displayNameInput,
    replyTo: addressInput.nullable().optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type CreateMailIdentityRequest = z.infer<typeof createMailIdentityRequestSchema>;

export const updateMailIdentityRequestSchema = z
  .object({
    displayName: displayNameInput.optional(),
    replyTo: addressInput.nullable().optional(),
    defaultSignatureNewId: z.uuid().nullable().optional(),
    defaultSignatureReplyId: z.uuid().nullable().optional(),
  })
  .strict();
export type UpdateMailIdentityRequest = z.infer<typeof updateMailIdentityRequestSchema>;

/** Review 9B S3 — `POST …/identities/:identityId/approval` (Owner/Admin + konfirmasi identitas). */
export const mailIdentityApprovalRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject'], { error: 'Pilih setujui atau tolak.' }),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type MailIdentityApprovalRequest = z.infer<typeof mailIdentityApprovalRequestSchema>;

/** Review 9B S3 — `GET /mail/identity-approvals`: menunggu persetujuan (terbaru dulu, maks. 200). */
export const mailIdentityApprovalListResponseSchema = z.object({
  approvals: z.array(
    z.object({
      identityId: z.uuid(),
      accountId: z.uuid(),
      address: z.string(),
      displayName: z.string(),
      isPrimary: z.boolean(),
      owner: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      createdAt: isoDateTimeSchema,
    }),
  ),
});
export type MailIdentityApprovalListResponse = z.infer<
  typeof mailIdentityApprovalListResponseSchema
>;

export const mailVerificationResponseSchema = z.object({
  verification: mailIdentityVerificationSchema,
});
export const confirmMailVerificationRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Kode verifikasi 6 angka.'),
  })
  .strict();
export const deleteMailIdentityResponseSchema = z.object({
  deleted: z.literal(true),
  movedDrafts: z.number().int().nonnegative(),
});

// ── Tanda tangan (§4) ──────────────────────────────────────────────────────

export const MAIL_SIGNATURE_SCOPES = ['shared', 'personal'] as const;
export const mailSignatureSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  scope: z.enum(MAIL_SIGNATURE_SCOPES),
  name: z.string(),
  html: z.string(),
  text: z.string(),
  logoUrl: z.string().nullable(),
  editable: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MailSignature = z.infer<typeof mailSignatureSchema>;
export const mailSignatureListResponseSchema = z.object({
  shared: z.array(mailSignatureSchema),
  mine: z.array(mailSignatureSchema),
});
export const mailSignatureResponseSchema = z.object({ signature: mailSignatureSchema });

const signatureName = z
  .string({ error: 'Nama tanda tangan wajib diisi.' })
  .trim()
  .min(1, 'Nama tanda tangan wajib diisi.')
  .max(60, 'Nama tanda tangan maksimal 60 karakter.')
  .refine(mailHeaderTextSafe, 'Nama tidak boleh memuat karakter khusus.');
const signatureHtml = z
  .string()
  .max(MAIL_SIGNATURE_HTML_MAX_BYTES, 'Tanda tangan maksimal 32 KB.')
  .refine(
    (value) => utf8ByteLength(value) <= MAIL_SIGNATURE_HTML_MAX_BYTES,
    'Tanda tangan maksimal 32 KB.',
  );

export const createMailSignatureRequestSchema = z
  .object({ scope: z.enum(MAIL_SIGNATURE_SCOPES), name: signatureName, html: signatureHtml })
  .strict();
export type CreateMailSignatureRequest = z.infer<typeof createMailSignatureRequestSchema>;
export const updateMailSignatureRequestSchema = z
  .object({ name: signatureName.optional(), html: signatureHtml.optional() })
  .strict();
export type UpdateMailSignatureRequest = z.infer<typeof updateMailSignatureRequestSchema>;
export const putMailSignatureLogoRequestSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .max(Math.ceil((MAIL_SIGNATURE_LOGO_UPLOAD_MAX_BYTES * 4) / 3) + 64),
  })
  .strict();
export const mailSignatureLogoResponseSchema = z.object({ logoUrl: z.string().nullable() });
export const mailSignatureLogoQuerySchema = z.object({ v: z.string().max(64).optional() });
export const MAIL_SIGNATURE_PURPOSES = ['new', 'reply'] as const;
export const mailIdentitySignatureQuerySchema = z.object({
  purpose: z.enum(MAIL_SIGNATURE_PURPOSES).default('new'),
});
export const mailIdentitySignatureResponseSchema = z.object({
  signatureId: z.uuid().nullable(),
  html: z.string(),
  text: z.string(),
});

// ── Preferensi (§5) ────────────────────────────────────────────────────────

const signatureChoice = z.union([z.uuid(), z.literal('none'), z.null()]);
export const mailSignatureChoicesSchema = z
  .record(
    z.uuid(),
    z.object({ new: signatureChoice.optional(), reply: signatureChoice.optional() }),
  )
  .refine((value) => Object.keys(value).length <= 100, 'Maksimal 100 identitas.');
export type MailSignatureChoices = z.infer<typeof mailSignatureChoicesSchema>;

export const mailPreferencesSchema = z.object({
  undoSendSeconds: z
    .number({ error: 'Lama batalkan kirim harus angka.' })
    .int()
    .min(MAIL_UNDO_SEND_SECONDS.min, 'Batalkan kirim minimal 5 detik.')
    .max(MAIL_UNDO_SEND_SECONDS.max, 'Batalkan kirim maksimal 30 detik.'),
  composeFormat: mailComposeFormatSchema,
  signatureChoices: mailSignatureChoicesSchema,
});
export type MailPreferences = z.infer<typeof mailPreferencesSchema>;
export const updateMailPreferencesRequestSchema = mailPreferencesSchema.partial().strict();
export type UpdateMailPreferencesRequest = z.infer<typeof updateMailPreferencesRequestSchema>;

// ── Draf (§6) ──────────────────────────────────────────────────────────────

const subjectInput = z.string().max(1000);
const bodyHtmlInput = z.string().max(MAIL_DRAFT_BODY_HTML_MAX_BYTES * 2);
const bodyTextInput = z.string().max(MAIL_DRAFT_BODY_TEXT_MAX_BYTES * 2);

export const createMailDraftRequestSchema = z
  .object({
    mode: mailDraftModeSchema,
    sourceMessageId: z.uuid().nullable().optional(),
    identityId: z.uuid().nullable().optional(),
    to: recipientList.optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    subject: subjectInput.nullable().optional(),
    bodyHtml: bodyHtmlInput.nullable().optional(),
  })
  .strict();
export type CreateMailDraftRequest = z.infer<typeof createMailDraftRequestSchema>;

export const mailDraftAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  inline: z.boolean(),
  contentId: z.string().nullable(),
  state: z.enum(MAIL_DRAFT_ATTACHMENT_STATES),
  source: z.enum(MAIL_ATTACHMENT_SOURCES),
});
export type MailDraftAttachment = z.infer<typeof mailDraftAttachmentSchema>;

export const mailSendErrorSchema = z.object({
  reason: mailSendFailureReasonSchema,
  message: z.string(),
  at: isoDateTimeSchema,
});

export const mailDraftSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  identityId: z.uuid(),
  mode: mailDraftModeSchema,
  sourceMessageId: z.uuid().nullable(),
  threadKey: z.string().nullable(),
  to: z.array(mailAddressOutSchema),
  cc: z.array(mailAddressOutSchema),
  bcc: z.array(mailAddressOutSchema),
  subject: z.string(),
  format: mailComposeFormatSchema,
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  includeQuote: z.boolean(),
  quote: z.object({
    available: z.boolean(),
    messageId: z.uuid().nullable(),
    from: mailAddressOutSchema.nullable(),
    sentAt: isoDateTimeSchema.nullable(),
    hasHtml: z.boolean(),
  }),
  attachments: z.array(mailDraftAttachmentSchema),
  attachmentTotalBytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  state: z.enum(MAIL_DRAFT_STATES),
  lastSendError: mailSendErrorSchema.nullable(),
  serverCopy: z.object({
    state: z.enum(MAIL_DRAFT_SERVER_SYNC_STATES),
    syncedAt: isoDateTimeSchema.nullable(),
  }),
  threadSeenAt: isoDateTimeSchema.nullable(),
  canSend: z.boolean(),
  cannotSendReason: z.enum(MAIL_CANNOT_SEND_REASONS).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MailDraft = z.infer<typeof mailDraftSchema>;

export const MAIL_SKIPPED_ATTACHMENT_REASONS = [
  'blocked',
  'type_not_allowed',
  'too_large',
] as const;
export const mailSkippedAttachmentSchema = z.object({
  filename: z.string(),
  reason: z.enum(MAIL_SKIPPED_ATTACHMENT_REASONS),
});
export const mailDraftResponseSchema = z.object({ draft: mailDraftSchema });
export const createMailDraftResponseSchema = z.object({
  draft: mailDraftSchema,
  skippedAttachments: z.array(mailSkippedAttachmentSchema),
});

export const mailDraftListQuerySchema = z.object({
  accountId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
});
export const mailDraftListItemSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  identityId: z.uuid(),
  mode: mailDraftModeSchema,
  subject: z.string(),
  toPreview: z.array(z.string()),
  updatedAt: isoDateTimeSchema,
  state: z.enum(MAIL_DRAFT_STATES),
  hasAttachments: z.boolean(),
  canSend: z.boolean(),
  lastSendError: mailSendErrorSchema.nullable(),
});
export const mailDraftListResponseSchema = z.object({
  drafts: z.array(mailDraftListItemSchema),
  nextCursor: z.string().nullable(),
});

export const updateMailDraftRequestSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    identityId: z.uuid().optional(),
    to: recipientList.optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    subject: subjectInput.optional(),
    format: mailComposeFormatSchema.optional(),
    bodyHtml: bodyHtmlInput.nullable().optional(),
    bodyText: bodyTextInput.nullable().optional(),
    includeQuote: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type UpdateMailDraftRequest = z.infer<typeof updateMailDraftRequestSchema>;
export const updateMailDraftResponseSchema = z.object({
  draft: z.object({
    id: z.uuid(),
    version: z.number().int().positive(),
    updatedAt: isoDateTimeSchema,
    serverCopy: mailDraftSchema.shape.serverCopy,
  }),
  sanitized: z.boolean().optional(),
  bodyHtml: z.string().optional(),
});
export const deleteMailDraftResponseSchema = z.object({ deleted: z.literal(true) });

export const mailDraftCheckResponseSchema = z.object({
  checks: z.object({
    totalRecipients: z.number().int().nonnegative(),
    maxRecipients: z.number().int().positive(),
    bccCount: z.number().int().nonnegative(),
    bccWarning: z.boolean(),
    recipients: z.array(
      z.object({
        field: z.enum(['to', 'cc', 'bcc']),
        address: z.string(),
        valid: z.boolean(),
        known: z.boolean(),
        external: z.boolean(),
        ownIdentity: z.boolean(),
        contactId: z.uuid().nullable(),
      }),
    ),
    newAddressCount: z.number().int().nonnegative(),
    newAddressQuota: z.object({
      limit: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
    }),
    replyToDiffers: z.string().nullable(),
    identity: z.object({
      verified: z.boolean(),
      reason: z.enum(MAIL_CANNOT_SEND_REASONS).nullable(),
    }),
    attachments: z.object({
      totalBytes: z.number().int().nonnegative(),
      maxBytes: z.number().int().positive(),
      notReady: z.number().int().nonnegative(),
    }),
    threadNewMessages: z.object({
      count: z.number().int().nonnegative(),
      latestReceivedAt: isoDateTimeSchema.nullable(),
    }),
  }),
});
export type MailDraftCheckResponse = z.infer<typeof mailDraftCheckResponseSchema>;

// ── Lampiran draf (§8) ─────────────────────────────────────────────────────

export const mailDraftAttachmentResponseSchema = z.object({
  attachment: mailDraftAttachmentSchema,
  draft: z.object({ version: z.number().int().positive() }),
});
export const mailDraftAttachmentsFromMessageRequestSchema = z
  .object({ attachmentIds: z.array(z.uuid()).min(1).max(MAIL_DRAFT_ATTACHMENTS_MAX) })
  .strict();
export const mailDraftAttachmentsFromMessageResponseSchema = z.object({
  attachments: z.array(mailDraftAttachmentSchema),
  skippedAttachments: z.array(mailSkippedAttachmentSchema),
  draft: z.object({ version: z.number().int().positive() }),
});
export const mailDraftAttachmentQuerySchema = z.object({ preview: z.enum(['1']).optional() });

// ── Kirim & outbox (§9) ────────────────────────────────────────────────────

export const sendMailDraftRequestSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    acknowledgeNewMessagesUntil: isoDateTimeSchema.nullable().optional(),
  })
  .strict();
export type SendMailDraftRequest = z.infer<typeof sendMailDraftRequestSchema>;

export const mailOutboxItemSchema = z.object({
  id: z.uuid(),
  draftId: z.uuid().nullable(),
  accountId: z.uuid(),
  identity: z.object({ id: z.uuid().nullable(), address: z.string(), displayName: z.string() }),
  status: mailOutboxStatusSchema,
  holdReason: mailOutboxHoldReasonSchema.nullable(),
  sendAfter: isoDateTimeSchema,
  nextAttemptAt: isoDateTimeSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  subject: z.string().nullable(),
  recipientCount: z.number().int().positive(),
  toPreview: z.array(z.string()),
  sentAt: isoDateTimeSchema.nullable(),
  failure: z
    .object({
      reason: mailSendFailureReasonSchema,
      message: z.string(),
      smtpCode: z.number().int().nullable(),
    })
    .nullable(),
  rejectedRecipients: z.array(z.string()),
  sentCopy: z.object({ state: mailSentCopyStateSchema }),
  createdAt: isoDateTimeSchema,
});
export type MailOutboxItem = z.infer<typeof mailOutboxItemSchema>;
export const mailOutboxResponseSchema = z.object({
  outbox: mailOutboxItemSchema,
  duplicate: z.boolean().optional(),
});
export const MAIL_OUTBOX_LIST_STATES = ['active', 'failed', 'recent'] as const;
export const mailOutboxListQuerySchema = z.object({
  state: z.enum(MAIL_OUTBOX_LIST_STATES).default('active'),
});
export const mailOutboxListResponseSchema = z.object({ outbox: z.array(mailOutboxItemSchema) });
export const cancelMailOutboxResponseSchema = z.object({
  outbox: mailOutboxItemSchema,
  draftId: z.uuid().nullable(),
});

// ── Snippet, saran penerima, presence (§10–§11) ────────────────────────────

export const mailSnippetsQuerySchema = z.object({ q: z.string().trim().max(60).optional() });
export const mailSnippetsResponseSchema = z.object({
  quickReplies: z.array(z.object({ id: z.uuid(), shortcut: z.string(), title: z.string() })),
  emailTemplates: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      variables: z.array(z.object({ name: z.string(), label: z.string(), required: z.boolean() })),
    }),
  ),
});
export const mailSnippetRequestSchema = z
  .object({
    kind: z.enum(['quick_reply', 'email_template']),
    id: z.uuid(),
    variables: z.record(z.string().max(40), z.string().max(2_000)).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.variables ?? {}).length <= 30, {
    error: 'Maksimal 30 variabel.',
    path: ['variables'],
  });
export type MailSnippetRequest = z.infer<typeof mailSnippetRequestSchema>;
export const mailSnippetResponseSchema = z.object({
  html: z.string(),
  text: z.string(),
  subject: z.string().nullable(),
  missingVariables: z.array(
    z.object({ name: z.string(), label: z.string(), required: z.boolean() }),
  ),
});

export const mailRecipientSuggestQuerySchema = z.object({
  q: z.string().trim().min(2, 'Ketik minimal 2 karakter.').max(100),
  accountId: z.uuid().optional(),
});
export const mailRecipientSuggestResponseSchema = z.object({
  suggestions: z.array(
    z.object({
      address: z.string(),
      name: z.string().nullable(),
      source: z.enum(['contact', 'history']),
      contactId: z.uuid().nullable(),
    }),
  ),
});

export const mailPresenceResponseSchema = z.object({
  threadKey: z.string().nullable(),
  users: z.array(z.object({ id: z.uuid(), name: z.string() })),
});

/** Level akses minimum untuk tiap tindakan tulis (dokumentasi bersama web & api). */
export const MAIL_COMPOSE_MIN_LEVEL = mailAccessLevelSchema.enum.send;
