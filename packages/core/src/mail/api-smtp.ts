import { createTransport } from 'nodemailer';

import { TimeoutError, withTimeout } from '../timeout';
import { resolveMailHost } from './host-guard';
import {
  DEFAULT_SMTP_TIMEOUTS,
  classifySmtpError,
  sendsPlaintextLogin,
  type SmtpConnectionConfig,
  type SmtpPolicy,
} from './smtp';

/**
 * Pengiriman email lewat API (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §4) — terpisah dari
 * `sendSmtpMail` karena butuh:
 *  - amplop eksplisit (`MAIL FROM` + `RCPT TO` semua penerima): Bcc HANYA di amplop, tidak pernah
 *    di header;
 *  - `Auto-Submitted: auto-generated` (RFC 3834), `Message-ID` buatan pemanggil, header utas;
 *  - hasil terklasifikasi untuk antrean (sementara/pembatasan laju/login ditolak/penerima ditolak/
 *    pesan ditolak/tidak pasti) + kode balasan SMTP (angka saja). Teks balasan server TIDAK PERNAH
 *    dikembalikan — hanya dipindai untuk mengenali pembatasan laju (`4.7.x`).
 * Aturan host/port/TLS sama dengan Fase 6 (`resolveMailHost`, port dari `allowedPorts`). Transport
 * dengan akses berkas & URL dimatikan (isi hanya Buffer).
 */

export interface ApiMailPart {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ApiMailInlinePart extends ApiMailPart {
  cid: string;
}

export interface ApiMailMessage {
  envelopeFrom: string;
  from: { name: string; address: string };
  to: readonly { email: string; name: string | null }[];
  cc: readonly { email: string; name: string | null }[];
  /** Hanya amplop. */
  bcc: readonly string[];
  replyTo: string | null;
  subject: string;
  text: string;
  html: string | null;
  /** Tanpa `<>`. */
  messageId: string;
  inReplyTo: string | null;
  references: readonly string[];
  inline: readonly ApiMailInlinePart[];
  attachments: readonly ApiMailPart[];
}

export type ApiMailFailureKind =
  /** Belum diterima server (sambungan/4xx) — aman dicoba lagi. */
  | 'temporary'
  /** 4xx pembatasan laju (`4.7.x`, terlalu banyak sambungan) — pengirim ikut dijeda. */
  | 'throttled'
  /** Login ditolak. */
  | 'auth'
  /** Pengaturan tidak bisa dipakai (port, TLS/sertifikat, login polos ke internet). */
  | 'config'
  | 'recipients_rejected'
  | 'message_rejected'
  | 'sender_rejected'
  /** Sambungan putus setelah isi mungkin terkirim — JANGAN dicoba ulang. */
  | 'delivery_unknown';

export type ApiMailResult =
  | { ok: true; rejected: string[] }
  | { ok: false; kind: ApiMailFailureKind; smtpCode: number | null; code: string };

/** Email API bisa membawa lampiran 20 MB: batas waktu lebih longgar dari email notifikasi. */
export const API_SMTP_TIMEOUTS = {
  ...DEFAULT_SMTP_TIMEOUTS,
  socketMs: 60_000,
  totalMs: 180_000,
};

interface ErrorLike {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
  response?: unknown;
  rejected?: unknown;
}

const THROTTLE_TEXT =
  /\b4\.7\.\d{1,3}\b|too many (connections|messages|recipients|requests)|rate limit|try again later|throttl/i;

function addressOf(item: unknown): string {
  const value =
    typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null
        ? (item as { address?: unknown }).address
        : null;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Klasifikasi galat nodemailer (teks balasan HANYA dipindai, tidak diteruskan). */
export function classifyApiSmtpError(error: unknown): {
  kind: ApiMailFailureKind;
  smtpCode: number | null;
  code: string;
} {
  if (error instanceof TimeoutError) {
    // Batas waktu total bisa jatuh saat isi sedang dikirim: tidak pasti.
    return { kind: 'delivery_unknown', smtpCode: null, code: 'total_timeout' };
  }
  const record: ErrorLike = typeof error === 'object' && error !== null ? error : {};
  const responseCode = typeof record.responseCode === 'number' ? record.responseCode : null;
  const command = typeof record.command === 'string' ? record.command.toUpperCase() : '';
  const response = typeof record.response === 'string' ? record.response.slice(0, 1_000) : '';
  const errorCode = typeof record.code === 'string' ? record.code : '';
  const base = classifySmtpError(error);
  const done = (kind: ApiMailFailureKind) => ({ kind, smtpCode: responseCode, code: base.code });

  if (base.code === 'auth_failed' || base.code === 'auth_unsupported') return done('auth');
  if (base.code === 'certificate_invalid' || base.code === 'tls_failed') return done('config');

  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    if ((responseCode === 421 || responseCode === 451) && THROTTLE_TEXT.test(response)) {
      return done('throttled');
    }
    return done('temporary');
  }
  if (responseCode !== null && responseCode >= 500) {
    if (command.startsWith('MAIL')) return done('sender_rejected');
    if (command.startsWith('RCPT') || errorCode === 'EENVELOPE') return done('recipients_rejected');
    if (command.startsWith('AUTH')) return done('auth');
    return done('message_rejected');
  }
  // Tanpa kode balasan: sambungan putus. Saat/ setelah DATA = tidak pasti; sebelum = aman diulang.
  if (command.startsWith('DATA') || command === 'MESSAGE' || errorCode === 'EMESSAGE') {
    return done('delivery_unknown');
  }
  if (
    base.code === 'host_not_found' ||
    base.code === 'connection_refused' ||
    base.code === 'connection_timeout'
  ) {
    return done('temporary');
  }
  return done('delivery_unknown');
}

export async function sendApiEmail(
  config: SmtpConnectionConfig,
  policy: SmtpPolicy,
  message: ApiMailMessage,
): Promise<ApiMailResult> {
  const timeouts = { ...API_SMTP_TIMEOUTS, ...policy.timeouts };
  if (!policy.allowedPorts.includes(config.port)) {
    return { ok: false, kind: 'config', smtpCode: null, code: 'port_not_allowed' };
  }
  const resolved = await resolveMailHost(config.host, {
    lookup: policy.lookup,
    timeoutMs: timeouts.dnsMs,
  });
  if (!resolved.ok) {
    // Host tidak ditemukan bisa sementara (DNS); alamat terlarang = pengaturan salah.
    return {
      ok: false,
      kind: resolved.code === 'host_blocked' ? 'config' : 'temporary',
      smtpCode: null,
      code: resolved.code,
    };
  }
  if (
    sendsPlaintextLogin(config) &&
    (policy.plaintextLogin ?? 'private-only') === 'private-only' &&
    resolved.addressClass !== 'private'
  ) {
    return { ok: false, kind: 'config', smtpCode: null, code: 'insecure_login' };
  }

  const transport = createTransport({
    host: resolved.address,
    port: config.port,
    secure: config.security === 'ssl',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth:
      config.username !== null && config.password !== null
        ? { user: config.username, pass: config.password.reveal() }
        : undefined,
    tls: { servername: resolved.servername, minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    dnsTimeout: timeouts.dnsMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });

  const recipients = [
    ...message.to.map((item) => item.email),
    ...message.cc.map((item) => item.email),
    ...message.bcc,
  ];
  try {
    const info: unknown = await withTimeout(
      transport.sendMail({
        // Amplop eksplisit: Bcc hanya di sini, tidak pernah jadi header.
        envelope: { from: message.envelopeFrom, to: recipients },
        from: { name: message.from.name, address: message.from.address },
        to: message.to.map((item) => ({ name: item.name ?? '', address: item.email })),
        ...(message.cc.length > 0
          ? { cc: message.cc.map((item) => ({ name: item.name ?? '', address: item.email })) }
          : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        ...(message.html !== null ? { html: message.html } : {}),
        messageId: `<${message.messageId}>`,
        ...(message.inReplyTo ? { inReplyTo: `<${message.inReplyTo}>` } : {}),
        ...(message.references.length > 0
          ? { references: message.references.map((id) => `<${id}>`) }
          : {}),
        headers: { 'Auto-Submitted': 'auto-generated' },
        attachments: [
          ...message.inline.map((part) => ({
            cid: part.cid,
            filename: part.filename,
            contentType: part.contentType,
            content: part.content,
            contentDisposition: 'inline' as const,
          })),
          ...message.attachments.map((part) => ({
            filename: part.filename,
            contentType: part.contentType,
            content: part.content,
            contentDisposition: 'attachment' as const,
          })),
        ],
      }),
      timeouts.totalMs,
      'Kirim email API',
    );
    const record = typeof info === 'object' && info !== null ? (info as ErrorLike) : {};
    const rejected = Array.isArray(record.rejected)
      ? record.rejected.map(addressOf).filter((value) => value !== '')
      : [];
    return { ok: true, rejected };
  } catch (error) {
    const verdict = classifyApiSmtpError(error);
    return { ok: false, ...verdict };
  } finally {
    transport.close();
  }
}
