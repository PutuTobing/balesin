import {
  EMAIL_MAX_MESSAGE_BYTES,
  type ConnectionTestCode,
  type ImapSecurity,
} from '@balesin/shared';
import { ImapFlow } from 'imapflow';

import { resolveMailHost, type HostLookup, type StrictMailHostRule } from '../mail/host-guard';
import type { Secret } from '../secret';
import { TimeoutError, withTimeout } from '../timeout';

/**
 * Klien IMAP channel Email (Fase 6) di atas `imapflow`.
 *
 * Aturan (SECURITY.md §3 & §6):
 *  - TLS WAJIB: SSL/TLS langsung (993) atau STARTTLS wajib (143, `doSTARTTLS: true` — tidak pernah
 *    turun ke teks polos). Sertifikat diverifikasi (TLS ≥ 1.2, SNI = nama host).
 *  - Port dibatasi daftar izin; host di-resolve SEKALI lewat `resolveMailHost` (link-local/metadata
 *    cloud diblokir) lalu sambungan dibuat ke IP hasilnya.
 *  - Batas waktu per tahap + total; batas ukuran literal/respons (server jahat tidak bisa menghabiskan
 *    memori); email lebih besar dari `EMAIL_MAX_MESSAGE_BYTES` dilewati tanpa diunduh.
 *  - Hasil gagal = KODE (`ConnectionTestCode`); balasan mentah server tidak pernah diteruskan/di-log.
 *    Password hanya dibuka saat klien dibuat.
 *  - Polling (bukan IDLE): satu sambungan pendek per putaran — tidak ada sambungan yang ditahan.
 */

export interface ImapConnectionConfig {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: Secret<string>;
  folder: string;
}

export interface ImapPolicy {
  allowedPorts: readonly number[];
  lookup?: HostLookup;
  timeouts?: Partial<ImapTimeouts>;
  /** HANYA tes: CA tambahan untuk server IMAP tiruan bersertifikat buatan sendiri. */
  testCa?: string;
  /** Fase 9 (akun Email): aturan host ketat — privat hanya lewat allowlist organisasi. */
  strict?: StrictMailHostRule;
}

export interface ImapTimeouts {
  dnsMs: number;
  connectionMs: number;
  greetingMs: number;
  socketMs: number;
  /** Batas satu operasi (tes koneksi / satu putaran ambil email). */
  totalMs: number;
}

export const DEFAULT_IMAP_TIMEOUTS: ImapTimeouts = {
  dnsMs: 5_000,
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 30_000,
  totalMs: 120_000,
};

export type ImapFailureCode = Extract<
  ConnectionTestCode,
  | 'imap_host_not_found'
  | 'imap_host_blocked'
  | 'imap_port_not_allowed'
  | 'imap_connection_refused'
  | 'imap_connection_timeout'
  | 'imap_tls_failed'
  | 'imap_certificate_invalid'
  | 'imap_auth_failed'
  | 'imap_folder_not_found'
  | 'unknown'
>;

/**
 * Fase 9: sebab khusus yang DIKENALI dari teks balasan server (teksnya sendiri tidak disimpan):
 * sandi aplikasi diminta, akses IMAP belum diaktifkan, terlalu banyak sambungan.
 */
export type ImapFailureHint = 'app_password_required' | 'not_enabled' | 'too_many_connections';

export class ImapFailure extends Error {
  override readonly name = 'ImapFailure';
  constructor(
    readonly code: ImapFailureCode,
    /** Kode/nama aman untuk log (tanpa teks balasan server). */
    readonly diagnostic: string | null = null,
    readonly hint: ImapFailureHint | null = null,
  ) {
    super(`IMAP gagal (${code})`);
  }
}

function imapHintOf(text: string, responseCode: string): ImapFailureHint | null {
  if (/application-specific password|app(lication)? password|\b5\.7\.9\b/i.test(text)) {
    return 'app_password_required';
  }
  if (
    /not enabled for imap|imap (access )?(is )?disabled|enable imap|web login required/i.test(text)
  ) {
    return 'not_enabled';
  }
  if (
    responseCode === 'LIMIT' ||
    /too many (simultaneous )?connections|maximum number of connections|connection limit/i.test(
      text,
    )
  ) {
    return 'too_many_connections';
  }
  return null;
}

const CERT_CODES = new Set([
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

/** Galat imapflow/soket → kode. Teks galat hanya DIPINDAI, tidak pernah diteruskan. */
export function classifyImapError(error: unknown): ImapFailure {
  if (error instanceof ImapFailure) return error;
  if (error instanceof TimeoutError)
    return new ImapFailure('imap_connection_timeout', 'TOTAL_TIMEOUT');
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    authenticationFailed?: unknown;
    tlsFailed?: unknown;
    mailboxMissing?: unknown;
    serverResponseCode?: unknown;
    message?: unknown;
    responseText?: unknown;
    response?: unknown;
    _err?: { code?: unknown };
  };
  const code = typeof record.code === 'string' ? record.code : '';
  const inner = typeof record._err?.code === 'string' ? record._err.code : '';
  const message = typeof record.message === 'string' ? record.message.slice(0, 2_000) : '';
  const diagnostic = (code || inner || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || null;
  const scanned = [record.message, record.responseText, record.response]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .slice(0, 2_000);
  const hint = imapHintOf(
    scanned,
    typeof record.serverResponseCode === 'string' ? record.serverResponseCode : '',
  );
  const done = (value: ImapFailureCode) => new ImapFailure(value, diagnostic, hint);

  if (
    CERT_CODES.has(code) ||
    CERT_CODES.has(inner) ||
    /certificate|self[- ]signed/i.test(message)
  ) {
    return done('imap_certificate_invalid');
  }
  if (
    record.authenticationFailed === true ||
    record.serverResponseCode === 'AUTHENTICATIONFAILED'
  ) {
    return done('imap_auth_failed');
  }
  if (record.mailboxMissing === true || record.serverResponseCode === 'NONEXISTENT') {
    return done('imap_folder_not_found');
  }
  if (
    record.tlsFailed === true ||
    code === 'STARTTLS_INJECTION' ||
    code.startsWith('ERR_SSL') ||
    inner.startsWith('ERR_SSL') ||
    code === 'EPROTO' ||
    code === 'UPGRADE_TIMEOUT' ||
    /starttls|wrong version number|ssl routines/i.test(message)
  ) {
    return done('imap_tls_failed');
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME'].includes(code)) {
    return done('imap_host_not_found');
  }
  if (code === 'ECONNREFUSED' || inner === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return done('imap_connection_refused');
  }
  if (
    [
      'ETIMEDOUT',
      'CONNECT_TIMEOUT',
      'GREETING_TIMEOUT',
      'ETIMEOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ].includes(code)
  ) {
    return done('imap_connection_timeout');
  }
  if (
    code === 'NoConnection' ||
    code === 'EConnectionClosed' ||
    code.startsWith('ClosedAfterConnect')
  ) {
    return done('imap_connection_refused');
  }
  return done('unknown');
}

/**
 * Membuka sambungan IMAP terperiksa (port, penjaga host, TLS wajib, batas waktu & ukuran). Fase 9
 * memakainya untuk akun Email (`mail-client`).
 */
export async function openImapClient(
  config: Omit<ImapConnectionConfig, 'folder'>,
  policy: ImapPolicy,
  limits: { maxLiteralBytes?: number } = {},
): Promise<ImapFlow> {
  return openClient({ ...config, folder: 'INBOX' }, policy, limits);
}

async function openClient(
  config: ImapConnectionConfig,
  policy: ImapPolicy,
  limits: { maxLiteralBytes?: number } = {},
): Promise<ImapFlow> {
  const timeouts = { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts };
  if (!policy.allowedPorts.includes(config.port)) throw new ImapFailure('imap_port_not_allowed');
  const resolved = await resolveMailHost(config.host, {
    lookup: policy.lookup,
    timeoutMs: timeouts.dnsMs,
    ...(policy.strict ? { strict: policy.strict } : {}),
  });
  if (!resolved.ok) {
    throw new ImapFailure(
      resolved.code === 'host_blocked'
        ? 'imap_host_blocked'
        : resolved.code === 'connection_timeout'
          ? 'imap_connection_timeout'
          : 'imap_host_not_found',
    );
  }
  const servername = resolved.servername ?? config.host;
  const client = new ImapFlow({
    host: resolved.address,
    port: config.port,
    secure: config.security === 'ssl',
    ...(config.security === 'starttls' ? { doSTARTTLS: true } : {}),
    servername,
    auth: { user: config.username, pass: config.password.reveal() },
    tls: {
      servername,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(policy.testCa ? { ca: policy.testCa } : {}),
    },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    maxLineLength: 1024 * 1024,
    maxLiteralSize: (limits.maxLiteralBytes ?? EMAIL_MAX_MESSAGE_BYTES) + 1024 * 1024,
    maxResponseSize: (limits.maxLiteralBytes ?? EMAIL_MAX_MESSAGE_BYTES) + 2 * 1024 * 1024,
    clientInfo: { name: 'Balesin' },
  });
  // Galat setelah tersambung (soket putus) tidak boleh menjatuhkan proses.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw classifyImapError(error);
  }
  return client;
}

/** Logout rapi (≤ 5 dtk), selain itu tutup paksa. */
export async function closeImapClient(client: ImapFlow): Promise<void> {
  return closeClient(client);
}

async function closeClient(client: ImapFlow): Promise<void> {
  try {
    await withTimeout(client.logout(), 5_000, 'Logout IMAP');
  } catch {
    client.close();
  }
}

/** "Tes koneksi": sambung (TLS), login, buka folder — tanpa membaca email. */
export async function testImapConnection(
  config: ImapConnectionConfig,
  policy: ImapPolicy,
): Promise<{ ok: true } | { ok: false; code: ImapFailureCode; diagnostic: string | null }> {
  const timeouts = { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts };
  try {
    await withTimeout(
      (async () => {
        const client = await openClient(config, policy);
        try {
          await client.mailboxOpen(config.folder, { readOnly: true });
        } catch (error) {
          throw classifyImapError(error);
        } finally {
          await closeClient(client);
        }
      })(),
      Math.min(timeouts.totalMs, 30_000),
      'Tes IMAP',
    );
    return { ok: true };
  } catch (error) {
    const failure = classifyImapError(error);
    return { ok: false, code: failure.code, diagnostic: failure.diagnostic };
  }
}

export interface MailboxPosition {
  uidValidity: number | null;
  lastUid: number;
}

export interface PollOptions {
  /** Email maksimal per putaran (sisanya putaran berikutnya). */
  maxMessages: number;
  markAsRead: boolean;
  /**
   * Dipanggil per email (urut UID). `raw` = sumber RFC 822 utuh; `null` bila dilewati karena terlalu
   * besar (tidak diunduh). Melempar = putaran berhenti; posisi hanya maju sampai email sebelumnya.
   */
  onMessage(input: { uid: number; raw: Buffer | null; sizeBytes: number }): Promise<void>;
}

export interface PollResult {
  position: MailboxPosition;
  /** Email yang diteruskan ke `onMessage` (termasuk yang terlalu besar). */
  processed: number;
  /** Masih ada email baru di server (batas `maxMessages` tercapai). */
  more: boolean;
}

/**
 * Satu putaran ambil email baru (UID > posisi terakhir). Posisi pertama kali / `UIDVALIDITY` berubah
 * = mulai dari email TERBARU yang ada (kotak lama tidak diimpor).
 */
export async function pollImapMailbox(
  config: ImapConnectionConfig,
  policy: ImapPolicy,
  position: MailboxPosition,
  options: PollOptions,
): Promise<PollResult> {
  const timeouts = { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts };
  const run = async (): Promise<PollResult> => {
    const client = await openClient(config, policy);
    try {
      let mailbox;
      try {
        mailbox = await client.mailboxOpen(config.folder, { readOnly: !options.markAsRead });
      } catch (error) {
        throw classifyImapError(error);
      }
      const uidValidity = Number(mailbox.uidValidity);
      const latest = Math.max(0, mailbox.uidNext - 1);
      if (position.uidValidity === null || position.uidValidity !== uidValidity) {
        return { position: { uidValidity, lastUid: latest }, processed: 0, more: false };
      }
      let lastUid = position.lastUid;
      if (mailbox.exists === 0 || latest <= lastUid) {
        return { position: { uidValidity, lastUid }, processed: 0, more: false };
      }
      const listed = await client.fetchAll(
        `${String(lastUid + 1)}:*`,
        { uid: true, size: true },
        { uid: true },
      );
      // `n:*` selalu memuat email terakhir walau UID-nya ≤ n — saring.
      const candidates = listed
        .filter((message) => message.uid > lastUid)
        .sort((left, right) => left.uid - right.uid);
      let processed = 0;
      for (const candidate of candidates.slice(0, options.maxMessages)) {
        const sizeBytes = candidate.size ?? 0;
        let raw: Buffer | null = null;
        if (sizeBytes <= EMAIL_MAX_MESSAGE_BYTES) {
          const fetched = await client.fetchOne(
            String(candidate.uid),
            { source: true },
            { uid: true },
          );
          raw = fetched && fetched.source ? fetched.source : null;
          if (raw && raw.length > EMAIL_MAX_MESSAGE_BYTES) raw = null;
        }
        try {
          await options.onMessage({ uid: candidate.uid, raw, sizeBytes });
        } catch (error) {
          throw new OnMessageError(error);
        }
        if (options.markAsRead) {
          await client
            .messageFlagsAdd(String(candidate.uid), ['\\Seen'], { uid: true })
            .catch(() => undefined);
        }
        lastUid = candidate.uid;
        processed += 1;
      }
      return {
        position: { uidValidity, lastUid },
        processed,
        more: candidates.length > options.maxMessages,
      };
    } finally {
      await closeClient(client);
    }
  };
  try {
    return await withTimeout(run(), timeouts.totalMs, 'Ambil email IMAP');
  } catch (error) {
    if (error instanceof ImapFailure) throw error;
    // Galat dari `onMessage` (database) diteruskan apa adanya; galat IMAP → kode.
    if (error instanceof OnMessageError) throw error;
    const failure = classifyImapError(error);
    if (failure.code === 'unknown' && !isImapLike(error)) throw error;
    throw failure;
  }
}

/** Galat dari `onMessage` (mis. database) — diteruskan, bukan dianggap galat IMAP. */
export class OnMessageError extends Error {
  override readonly name = 'OnMessageError';
  constructor(cause: unknown) {
    super('Pemrosesan email masuk gagal', { cause });
  }
}

function isImapLike(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string';
}
