import { SMTP_ALLOWED_PORTS, type EmailTestCode, type SmtpSecurity } from '@balesin/shared';
import { createTransport } from 'nodemailer';

import type { Secret } from '../secret';
import { TimeoutError, withTimeout } from '../timeout';
import { resolveMailHost, type HostLookup, type StrictMailHostRule } from './host-guard';

/**
 * Klien SMTP terpusat (nodemailer) untuk api (tes koneksi, email tes) dan worker (notifikasi).
 *
 * Aturan (SECURITY.md §3 dan §6):
 *  - port dibatasi daftar izin; host di-resolve dan diperiksa `resolveMailHost`;
 *  - setiap tahap punya batas waktu, ditambah batas waktu total;
 *  - hasil gagal berupa KODE dari daftar tetap — balasan mentah server tidak pernah dikembalikan
 *    (bisa memuat data internal, dan menjadikan tes koneksi alat membaca layanan lain);
 *  - password hanya dibuka (`reveal`) tepat saat transport dibuat dan tidak pernah di-log.
 */

export interface SmtpConnectionConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** `null` = tanpa login. */
  username: string | null;
  password: Secret<string> | null;
}

export interface MailSender {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
}

/** Lampiran gambar inline (logo di template bermerek), dirujuk dari HTML lewat `cid:`. */
export interface MailInlineImage {
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailContent {
  to: string;
  /**
   * Tahap 9.0 (channel Email) — tembusan. `bcc` HANYA masuk amplop SMTP (`RCPT TO`), tidak pernah
   * jadi header (perilaku bawaan nodemailer tanpa `keepBcc`). Alamat SUDAH divalidasi pemanggil.
   */
  cc?: readonly string[];
  bcc?: readonly string[];
  /**
   * Review 9.0 R8: tembusan yang SUDAH menerima email ini di percobaan sebelumnya — tetap tertulis di
   * header Cc, tetapi tidak dikirimi lagi (amplop `RCPT TO` tanpa mereka).
   */
  skipCopies?: readonly string[];
  subject: string;
  text: string;
  html?: string;
  /** Hanya isi dari memori (Buffer) — akses berkas dan URL dimatikan di transport. */
  inlineImages?: MailInlineImage[];
  /**
   * Fase 6 (channel Email) — header utas. `messageId` dibuat pemanggil (tanpa `<>`), `inReplyTo` +
   * `references` = rantai `Message-ID` yang dibalas. Nilai SUDAH divalidasi pemanggil.
   */
  thread?: { messageId: string; inReplyTo: string | null; references: readonly string[] };
  /** Fase 6: `Auto-Submitted: auto-replied` untuk balasan bot/otomatis (cegah loop balas-otomatis). */
  autoSubmitted?: boolean;
  /** Fase 6: lampiran (Buffer dari media store). */
  attachments?: MailAttachment[];
}

/** Lampiran email keluar channel Email. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SmtpTimeouts {
  dnsMs: number;
  connectionMs: number;
  greetingMs: number;
  socketMs: number;
  /** Batas keseluruhan satu operasi (sambung + login + kirim). */
  totalMs: number;
}

export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  dnsMs: 5_000,
  connectionMs: 8_000,
  greetingMs: 8_000,
  socketMs: 10_000,
  totalMs: 20_000,
};

/** Port penangkap email lokal (Mailpit dari `pnpm db:up`) — hanya di development/test. */
export const LOCAL_MAIL_CATCHER_PORT = 1025;

/**
 * Port SMTP yang boleh dituju (permukaan SSRF). Di production hanya port SMTP baku; di luar
 * production ditambah port penangkap email lokal.
 */
export function allowedSmtpPorts(isProduction: boolean): number[] {
  return isProduction ? [...SMTP_ALLOWED_PORTS] : [...SMTP_ALLOWED_PORTS, LOCAL_MAIL_CATCHER_PORT];
}

/**
 * Login lewat sambungan "Tanpa enkripsi" mengirim password polos. `private-only` (dipakai di
 * production) hanya mengizinkannya ke server di jaringan lokal/loopback; `allow` mengizinkan
 * ke mana pun (pengembangan lokal).
 */
export type PlaintextLoginPolicy = 'allow' | 'private-only';

export function plaintextLoginPolicy(isProduction: boolean): PlaintextLoginPolicy {
  return isProduction ? 'private-only' : 'allow';
}

export interface SmtpPolicy {
  /** Port yang boleh dituju. Port lain ditolak sebelum ada sambungan. */
  allowedPorts: readonly number[];
  /** Bawaan `private-only`. */
  plaintextLogin?: PlaintextLoginPolicy;
  lookup?: HostLookup;
  timeouts?: Partial<SmtpTimeouts>;
  /** Fase 9 (akun Email): aturan host ketat — privat hanya lewat allowlist organisasi. */
  strict?: StrictMailHostRule;
  /** HANYA tes: CA tambahan untuk server SMTP tiruan bersertifikat buatan sendiri. */
  testCa?: string;
}

export type SmtpFailureCode = Exclude<
  EmailTestCode,
  'ok' | 'not_configured' | 'secret_unavailable'
>;

/** Rincian AMAN untuk log: kode, angka, dan nama perintah — tanpa teks balasan server. */
export interface SmtpDiagnostic {
  stage: 'policy' | 'dns' | 'smtp';
  errorCode?: string;
  responseCode?: number;
  command?: string;
  /**
   * Fase 9: sebab khusus yang DIKENALI dari teks balasan (teksnya sendiri tidak disimpan):
   * `m365_auth_disabled` (5.7.139), `app_password_required` (534-5.7.9 / "application-specific").
   */
  hint?: 'm365_auth_disabled' | 'app_password_required';
}

export type SmtpResult =
  | {
      ok: true;
      /**
       * Tahap 9.0: alamat Cc/Bcc yang DITOLAK server (email tetap diterima untuk penerima utama &
       * lainnya). Hanya diisi bila ada.
       */
      rejectedCopies?: string[];
    }
  | {
      ok: false;
      code: SmtpFailureCode;
      diagnostic: SmtpDiagnostic;
      /**
       * Review 9.0 R8: penerima utama ditolak, tetapi tembusan ini SUDAH diterima server (jangan
       * dikirimi lagi saat kirim ulang).
       */
      deliveredCopies?: string[];
    };

const CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
]);
const UNREACHABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ESOCKETTIMEDOUT',
]);
const NOT_FOUND_ERROR_CODES = new Set([
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'EAI_NONAME',
]);

interface SmtpErrorLike {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
  message?: unknown;
  cause?: unknown;
  rejected?: unknown;
  accepted?: unknown;
}

function asRecord(value: unknown): SmtpErrorLike {
  return typeof value === 'object' && value !== null ? value : {};
}

/**
 * Menerjemahkan error nodemailer/soket menjadi kode hasil tes. Teks pesan error hanya
 * DIPINDAI untuk mengenali jenis kegagalan; isinya tidak pernah diteruskan.
 */
export function classifySmtpError(error: unknown): {
  code: SmtpFailureCode;
  diagnostic: SmtpDiagnostic;
} {
  if (error instanceof TimeoutError) {
    return {
      code: 'connection_timeout',
      diagnostic: { stage: 'smtp', errorCode: 'TOTAL_TIMEOUT' },
    };
  }

  const record = asRecord(error);
  const cause = asRecord(record.cause);
  const errorCode = typeof record.code === 'string' ? record.code : undefined;
  const causeCode = typeof cause.code === 'string' ? cause.code : undefined;
  const responseCode = typeof record.responseCode === 'number' ? record.responseCode : undefined;
  const command = typeof record.command === 'string' ? record.command.slice(0, 32) : undefined;
  const message = typeof record.message === 'string' ? record.message.slice(0, 2_000) : '';
  const hint: SmtpDiagnostic['hint'] = /5\.7\.139|smtp ?auth(entication)? is disabled/i.test(
    message,
  )
    ? 'm365_auth_disabled'
    : /5\.7\.9\b|application-specific password|app password/i.test(message)
      ? 'app_password_required'
      : undefined;
  const diagnostic: SmtpDiagnostic = {
    stage: 'smtp',
    errorCode,
    responseCode,
    command,
    ...(hint ? { hint } : {}),
  };
  const done = (code: SmtpFailureCode) => ({ code, diagnostic });
  const hasCode = (codes: ReadonlySet<string>) =>
    (errorCode !== undefined && codes.has(errorCode)) ||
    (causeCode !== undefined && codes.has(causeCode));

  if (hasCode(CERTIFICATE_ERROR_CODES) || /certificate|self[- ]signed|altname/i.test(message)) {
    return done('certificate_invalid');
  }
  if (errorCode === 'EAUTH' || errorCode === 'ENOAUTH' || errorCode === 'EOAUTH2') {
    // Tanpa kode balasan = server tidak menawarkan cara login yang bisa dipakai.
    return done(
      responseCode === undefined && errorCode === 'EAUTH' ? 'auth_unsupported' : 'auth_failed',
    );
  }
  if (responseCode === 534 || responseCode === 535) return done('auth_failed');
  if (
    errorCode === 'ETLS' ||
    errorCode === 'EREQUIRETLS' ||
    errorCode === 'EPROTO' ||
    causeCode === 'EPROTO' ||
    errorCode?.startsWith('ERR_SSL') ||
    causeCode?.startsWith('ERR_SSL') ||
    /wrong version number|ssl routines|starttls|tls/i.test(message)
  ) {
    return done('tls_failed');
  }
  if (hasCode(NOT_FOUND_ERROR_CODES)) return done('host_not_found');
  if (
    errorCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNREFUSED' ||
    /ECONNREFUSED/.test(message)
  ) {
    return done('connection_refused');
  }
  if (hasCode(UNREACHABLE_ERROR_CODES) || /timed? ?out|greeting never received/i.test(message)) {
    return done('connection_timeout');
  }

  const stage = command?.toUpperCase() ?? '';
  if (errorCode === 'EENVELOPE' || responseCode !== undefined) {
    if (responseCode === 530) return done(stage.startsWith('MAIL') ? 'auth_failed' : 'tls_failed');
    if (stage.startsWith('MAIL')) return done('sender_rejected');
    if (stage.startsWith('RCPT') || Array.isArray(record.rejected))
      return done('recipient_rejected');
    if (stage.startsWith('AUTH')) return done('auth_failed');
    if (stage.startsWith('DATA') || errorCode === 'EMESSAGE') return done('message_rejected');
  }
  if (errorCode === 'EMESSAGE') return done('message_rejected');
  // Sambungan diputus tanpa penjelasan: paling sering karena port/keamanan tidak cocok.
  if (errorCode === 'ECONNECTION' || errorCode === 'ECONNRESET' || errorCode === 'ESOCKET') {
    return done('connection_refused');
  }
  return done('unknown');
}

/** `true` bila sambungan ini akan mengirim username + password tanpa enkripsi. */
export function sendsPlaintextLogin(
  config: Pick<SmtpConnectionConfig, 'security' | 'username'>,
): boolean {
  return config.security === 'none' && config.username !== null;
}

/**
 * Pemeriksaan saat MENYIMPAN pengaturan: `true` bila kombinasi "Tanpa enkripsi" + login
 * ditolak kebijakan karena host-nya di internet. Host yang belum bisa di-resolve tidak ditolak
 * di sini (pengiriman tetap memeriksa ulang sebelum menyambung).
 */
export async function isPlaintextLoginRejected(
  config: Pick<SmtpConnectionConfig, 'host' | 'security' | 'username'>,
  policy: Pick<SmtpPolicy, 'plaintextLogin' | 'lookup' | 'timeouts'>,
): Promise<boolean> {
  if (!sendsPlaintextLogin(config)) return false;
  if ((policy.plaintextLogin ?? 'private-only') === 'allow') return false;
  const resolved = await resolveMailHost(config.host, {
    lookup: policy.lookup,
    timeoutMs: policy.timeouts?.dnsMs ?? DEFAULT_SMTP_TIMEOUTS.dnsMs,
  });
  return resolved.ok && resolved.addressClass !== 'private';
}

type Transport = ReturnType<typeof createTransport>;

async function withTransport(
  config: SmtpConnectionConfig,
  policy: SmtpPolicy,
  run: (transport: Transport) => Promise<SmtpResult>,
): Promise<SmtpResult> {
  const timeouts = { ...DEFAULT_SMTP_TIMEOUTS, ...policy.timeouts };

  if (!policy.allowedPorts.includes(config.port)) {
    return { ok: false, code: 'port_not_allowed', diagnostic: { stage: 'policy' } };
  }

  const resolved = await resolveMailHost(config.host, {
    lookup: policy.lookup,
    timeoutMs: timeouts.dnsMs,
    ...(policy.strict ? { strict: policy.strict } : {}),
  });
  if (!resolved.ok) return { ok: false, code: resolved.code, diagnostic: { stage: 'dns' } };
  if (
    sendsPlaintextLogin(config) &&
    (policy.plaintextLogin ?? 'private-only') === 'private-only' &&
    resolved.addressClass !== 'private'
  ) {
    return { ok: false, code: 'insecure_login', diagnostic: { stage: 'policy' } };
  }

  const transport = createTransport({
    host: resolved.address,
    port: config.port,
    secure: config.security === 'ssl',
    requireTLS: config.security === 'starttls',
    // "Tanpa enkripsi" berarti persis itu: tidak pernah naik ke TLS.
    ignoreTLS: config.security === 'none',
    auth:
      config.username !== null && config.password !== null
        ? { user: config.username, pass: config.password.reveal() }
        : undefined,
    tls: {
      servername: resolved.servername,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(policy.testCa ? { ca: policy.testCa } : {}),
    },
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    dnsTimeout: timeouts.dnsMs,
    // Isi email kita tidak pernah merujuk berkas atau URL; tutup jalurnya sekalian.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });

  try {
    return await withTimeout(run(transport), timeouts.totalMs, 'Operasi SMTP');
  } catch (error) {
    return { ok: false, ...classifySmtpError(error) };
  } finally {
    transport.close();
  }
}

/** Alamat dari isi `info.rejected`/`info.accepted` nodemailer (string atau `{ address }`), huruf kecil. */
function rejectedAddress(item: unknown): string {
  const value =
    typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null
        ? (item as { address?: unknown }).address
        : null;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** "Tes koneksi": sambung, (STARTTLS), dan login — tanpa mengirim email. */
export function verifySmtpConnection(
  config: SmtpConnectionConfig,
  policy: SmtpPolicy,
): Promise<SmtpResult> {
  return withTransport(config, policy, async (transport) => {
    await transport.verify();
    return { ok: true };
  });
}

/** Mengirim satu email. Dipakai "Kirim email tes" dan pengiriman notifikasi di worker. */
export function sendSmtpMail(
  config: SmtpConnectionConfig,
  sender: MailSender,
  mail: MailContent,
  policy: SmtpPolicy,
): Promise<SmtpResult> {
  const skip = new Set((mail.skipCopies ?? []).map((address) => address.toLowerCase()));
  const copies = [...(mail.cc ?? []), ...(mail.bcc ?? [])].map((a) => a.toLowerCase());
  return withTransport(config, policy, async (transport) => {
    const info: unknown = await transport.sendMail({
      from: { name: sender.fromName, address: sender.fromAddress },
      ...(skip.size > 0
        ? {
            envelope: {
              from: sender.fromAddress,
              to: [mail.to, ...copies.filter((address) => !skip.has(address))],
            },
          }
        : {}),
      to: mail.to,
      ...(mail.cc && mail.cc.length > 0 ? { cc: [...mail.cc] } : {}),
      ...(mail.bcc && mail.bcc.length > 0 ? { bcc: [...mail.bcc] } : {}),
      replyTo: sender.replyTo ?? undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [
        ...(mail.inlineImages ?? []).map((image) => ({
          cid: image.cid,
          filename: image.filename,
          contentType: image.contentType,
          content: image.content,
          contentDisposition: 'inline' as const,
        })),
        ...(mail.attachments ?? []).map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          content: file.content,
          contentDisposition: 'attachment' as const,
        })),
      ],
      ...(mail.thread
        ? {
            messageId: `<${mail.thread.messageId}>`,
            ...(mail.thread.inReplyTo ? { inReplyTo: `<${mail.thread.inReplyTo}>` } : {}),
            ...(mail.thread.references.length > 0
              ? { references: mail.thread.references.map((id) => `<${id}>`) }
              : {}),
          }
        : {}),
      ...(mail.autoSubmitted ? { headers: { 'Auto-Submitted': 'auto-replied' } } : {}),
    });
    const rejected = asRecord(info).rejected;
    if (Array.isArray(rejected) && rejected.length > 0) {
      const addresses = rejected.map((item) => rejectedAddress(item));
      // Penerima utama ditolak = gagal. Hanya tembusan yang ditolak = terkirim ke yang lain (mengulang
      // akan menggandakan email ke penerima yang sudah menerimanya).
      const copySet = new Set(copies);
      if (copySet.size === 0 || addresses.some((address) => !copySet.has(address))) {
        const accepted = asRecord(info).accepted;
        const delivered = Array.isArray(accepted)
          ? accepted.map((item) => rejectedAddress(item)).filter((address) => copySet.has(address))
          : [];
        return {
          ok: false,
          code: 'recipient_rejected',
          diagnostic: { stage: 'smtp', command: 'RCPT TO' },
          ...(delivered.length > 0 ? { deliveredCopies: delivered } : {}),
        };
      }
      return { ok: true, rejectedCopies: addresses };
    }
    return { ok: true };
  });
}
