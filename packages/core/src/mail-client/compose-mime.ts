import { hasControlCharacters, mailMessageIdTokenValid } from '@balesin/shared';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';

import { classifyApiSmtpError, type ApiMailResult } from '../mail/api-smtp';
import { resolveMailHost } from '../mail/host-guard';
import { DEFAULT_SMTP_TIMEOUTS, type SmtpPolicy } from '../mail/smtp';
import type { Secret } from '../secret';
import { withTimeout } from '../timeout';

/**
 * MIME & SMTP jendela tulis menu Email (tahap 9B, KONTRAK-API-EMAIL-TULIS §9.4):
 *
 *  - Header dibangun OBJEK nodemailer (alamat `{ name, address }`, subjek RFC 2047) — tidak pernah
 *    gabungan string. Pertahanan berlapis: teks header ber-CR/LF/kendali/pengubah arah → melempar.
 *  - SATU bangunan MIME (Message-ID, Date, batas MIME sama) dengan `Bcc:` untuk salinan Terkirim;
 *    versi kirim = bangunan yang sama dengan baris `Bcc:` dibuang dari blok header. Bcc hanya di
 *    amplop `RCPT TO`.
 *  - Tanpa `Auto-Submitted` (email manusia), tanpa `X-Mailer`/`User-Agent`, tanpa tanda terima baca.
 *  - Isi HANYA Buffer dari memori (akses berkas & URL dimatikan).
 *  - SMTP akun lewat penjaga host KETAT 9A (privat hanya allowlist organisasi), port daftar izin,
 *    TLS wajib + sertifikat diverifikasi. Amplop `MAIL FROM` = alamat akun (kotak surat yang login).
 */

export interface ComposeAddress {
  address: string;
  name: string | null;
}

export interface ComposePart {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ComposeInlinePart extends ComposePart {
  cid: string;
}

export interface ComposedMailInput {
  from: ComposeAddress & { name: string };
  replyTo: string | null;
  to: readonly ComposeAddress[];
  cc: readonly ComposeAddress[];
  bcc: readonly ComposeAddress[];
  subject: string;
  html: string;
  text: string;
  /** Tanpa `<>`. */
  messageId: string;
  date: Date;
  inReplyTo: string | null;
  references: readonly string[];
  inline: readonly ComposeInlinePart[];
  attachments: readonly ComposePart[];
}

export class ComposeHeaderError extends Error {
  override readonly name = 'ComposeHeaderError';
}

function assertHeaderText(value: string | null, label: string): void {
  if (value !== null && hasControlCharacters(value)) {
    throw new ComposeHeaderError(`Header ${label} memuat karakter kendali`);
  }
}

const ADDRESS_SAFE = /^[^\s<>"(),;:\\[\]]{1,64}@[a-z0-9.-]{1,253}$/i;

function assertAddress(value: string, label: string): void {
  if (!ADDRESS_SAFE.test(value)) throw new ComposeHeaderError(`Alamat ${label} tidak sah`);
}

const toObject = (item: ComposeAddress) => ({ name: item.name ?? '', address: item.address });

/** Buang header `Bcc:` (beserta baris lanjutannya) dari blok header MIME. */
export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return raw;
  const lines = text.slice(0, end).split('\r\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(`${kept.join('\r\n')}${text.slice(end)}`, 'latin1');
}

export interface ComposedMime {
  /** MIME dengan `Bcc:` — salinan Terkirim / folder Draf. */
  withBcc: Buffer;
  /** MIME yang dikirim lewat SMTP (tanpa header `Bcc:`). */
  forSending: Buffer;
}

/** Satu bangunan MIME (lihat keterangan berkas). */
export async function buildComposedMime(input: ComposedMailInput): Promise<ComposedMime> {
  assertHeaderText(input.subject, 'Subject');
  assertHeaderText(input.from.name, 'From');
  assertAddress(input.from.address, 'From');
  if (input.replyTo) assertAddress(input.replyTo, 'Reply-To');
  for (const item of [...input.to, ...input.cc, ...input.bcc]) {
    assertAddress(item.address, 'penerima');
    assertHeaderText(item.name, 'nama penerima');
  }
  if (!mailMessageIdTokenValid(input.messageId))
    throw new ComposeHeaderError('Message-ID tidak sah');
  const inReplyTo =
    input.inReplyTo && mailMessageIdTokenValid(input.inReplyTo) ? input.inReplyTo : null;
  const references = input.references.filter(mailMessageIdTokenValid);
  const composer = new MailComposer({
    from: toObject(input.from),
    to: input.to.map(toObject),
    ...(input.cc.length > 0 ? { cc: input.cc.map(toObject) } : {}),
    ...(input.bcc.length > 0 ? { bcc: input.bcc.map(toObject) } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    text: input.text,
    html: input.html,
    date: input.date,
    messageId: `<${input.messageId}>`,
    ...(inReplyTo ? { inReplyTo: `<${inReplyTo}>` } : {}),
    ...(references.length > 0 ? { references: references.map((id) => `<${id}>`) } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: [
      ...input.inline.map((part) => ({
        cid: part.cid,
        filename: part.filename,
        contentType: part.contentType,
        content: part.content,
        contentDisposition: 'inline' as const,
      })),
      ...input.attachments.map((part) => ({
        filename: part.filename,
        contentType: part.contentType,
        content: part.content,
        contentDisposition: 'attachment' as const,
      })),
    ],
  });
  const node = composer.compile();
  node.keepBcc = true;
  const withBcc = await node.build();
  return { withBcc, forSending: stripBccHeader(withBcc) };
}

// ── SMTP akun ───────────────────────────────────────────────────────────────

export interface AccountSmtpConfig {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
  username: string;
  password: Secret<string>;
}

export interface AccountMailEnvelope {
  /** Alamat akun (kotak surat yang login). */
  from: string;
  /** Kepada + Cc + Bcc. */
  to: readonly string[];
}

/** Batas waktu lebih longgar (lampiran sampai 25 MB). */
export const ACCOUNT_SMTP_TIMEOUTS = {
  ...DEFAULT_SMTP_TIMEOUTS,
  socketMs: 60_000,
  totalMs: 180_000,
};

export type AccountMailSender = (
  config: AccountSmtpConfig,
  policy: SmtpPolicy,
  envelope: AccountMailEnvelope,
  raw: Buffer,
) => Promise<ApiMailResult>;

/** Kirim MIME jadi lewat SMTP akun (penjaga host KETAT wajib: `policy.strict`). */
export const sendAccountMail: AccountMailSender = async (config, policy, envelope, raw) => {
  const timeouts = { ...ACCOUNT_SMTP_TIMEOUTS, ...policy.timeouts };
  if (!policy.strict) {
    return { ok: false, kind: 'config', smtpCode: null, code: 'strict_guard_required' };
  }
  if (!policy.allowedPorts.includes(config.port)) {
    return { ok: false, kind: 'config', smtpCode: null, code: 'port_not_allowed' };
  }
  const resolved = await resolveMailHost(config.host, {
    lookup: policy.lookup,
    timeoutMs: timeouts.dnsMs,
    strict: policy.strict,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      kind: resolved.code === 'host_blocked' ? 'config' : 'temporary',
      smtpCode: null,
      code: resolved.code,
    };
  }
  const transport = createTransport({
    host: resolved.address,
    port: config.port,
    secure: config.security === 'ssl',
    requireTLS: config.security === 'starttls',
    auth: { user: config.username, pass: config.password.reveal() },
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
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });
  try {
    const info: unknown = await withTimeout(
      transport.sendMail({ envelope: { from: envelope.from, to: [...envelope.to] }, raw }),
      timeouts.totalMs,
      'Kirim email akun',
    );
    const record =
      typeof info === 'object' && info !== null ? (info as { rejected?: unknown }) : {};
    const rejected = Array.isArray(record.rejected)
      ? record.rejected
          .map((item: unknown) =>
            typeof item === 'string'
              ? item
              : typeof item === 'object' && item !== null
                ? (() => {
                    const address = (item as { address?: unknown }).address;
                    return typeof address === 'string' ? address : '';
                  })()
                : '',
          )
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value !== '')
      : [];
    return { ok: true, rejected };
  } catch (error) {
    return { ok: false, ...classifyApiSmtpError(error) };
  } finally {
    transport.close();
  }
};
