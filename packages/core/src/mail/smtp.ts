import { SMTP_ALLOWED_PORTS, type EmailTestCode, type SmtpSecurity } from '@balesin/shared';
import { createTransport } from 'nodemailer';

import type { Secret } from '../secret';
import { TimeoutError, withTimeout } from '../timeout';
import { resolveMailHost, type HostLookup } from './host-guard';

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

export interface MailContent {
  to: string;
  subject: string;
  text: string;
  html?: string;
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

export interface SmtpPolicy {
  /** Port yang boleh dituju. Port lain ditolak sebelum ada sambungan. */
  allowedPorts: readonly number[];
  lookup?: HostLookup;
  timeouts?: Partial<SmtpTimeouts>;
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
}

export type SmtpResult =
  { ok: true } | { ok: false; code: SmtpFailureCode; diagnostic: SmtpDiagnostic };

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
  const diagnostic: SmtpDiagnostic = { stage: 'smtp', errorCode, responseCode, command };
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
  });
  if (!resolved.ok) return { ok: false, code: resolved.code, diagnostic: { stage: 'dns' } };

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
  return withTransport(config, policy, async (transport) => {
    const info: unknown = await transport.sendMail({
      from: { name: sender.fromName, address: sender.fromAddress },
      to: mail.to,
      replyTo: sender.replyTo ?? undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    const rejected = asRecord(info).rejected;
    if (Array.isArray(rejected) && rejected.length > 0) {
      return {
        ok: false,
        code: 'recipient_rejected',
        diagnostic: { stage: 'smtp', command: 'RCPT TO' },
      };
    }
    return { ok: true };
  });
}
