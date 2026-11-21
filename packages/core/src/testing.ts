import { createLogger, type LogLevel, type Logger } from './logger';
import { closeRedis, createRedis, pingRedis, type Redis, type RedisRole } from './redis';
import { withTimeout } from './timeout';

export * from './channels/testing/fake-imap';
export * from './channels/testing/test-cert';

/**
 * Alat bantu tes: logger sungguhan (dengan seluruh redaksi) yang menulis ke memori.
 * Dipakai tes api/worker untuk memastikan tidak ada rahasia yang ikut ter-log.
 */
export interface LogCapture {
  logger: Logger;
  /** Baris log mentah (JSON), persis seperti yang akan ditulis ke stdout. */
  lines: string[];
  /** Baris log yang sudah di-parse. */
  entries(): Array<Record<string, unknown>>;
  /** Seluruh keluaran sebagai satu teks — untuk memeriksa "tidak mengandung X". */
  text(): string;
}

export function createLogCapture(level: LogLevel = 'trace'): LogCapture {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level,
    destination: { write: (line: string) => void lines.push(line) },
  });
  return {
    logger,
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join(''),
  };
}

// ── Redis untuk tes integrasi ───────────────────────────────────────────────

export const DEFAULT_TEST_REDIS_URL = 'redis://:balesin@localhost:6379/15';

/**
 * Koneksi ke Redis tes (`REDIS_URL_TEST`; bawaan: Redis dari `pnpm db:up`, database nomor 15).
 * Bila Redis tidak bisa dihubungi, GAGAL dengan pesan jelas — tes tidak dilewati diam-diam.
 * Pemanggil wajib memakai awalan kunci acak sendiri dan menutup koneksi dengan `closeRedis`.
 */
export async function connectTestRedis(
  role: RedisRole,
  logger: Logger,
  name = 'balesin-tes',
): Promise<Redis> {
  const redisUrl = process.env.REDIS_URL_TEST?.trim() || DEFAULT_TEST_REDIS_URL;
  const { hostname, port } = new URL(redisUrl);
  const redis = createRedis(redisUrl, { role, name, logger });
  try {
    // Koneksi ber-peran `client` menolak perintah sebelum tersambung, jadi tunggu siap dulu.
    if (redis.status !== 'ready') {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          redis.once('ready', resolve);
          redis.once('end', () => reject(new Error('koneksi ditutup')));
        }),
        3_000,
        'Sambungan Redis',
      );
    }
    await withTimeout(pingRedis(redis), 3_000, 'PING Redis');
  } catch (error) {
    await closeRedis(redis);
    throw new Error(
      `Redis untuk tes tidak bisa dihubungi di ${hostname}:${port || '6379'}. ` +
        'Jalankan `pnpm db:up` lalu ulangi, atau arahkan REDIS_URL_TEST ke Redis yang hidup.',
      { cause: error },
    );
  }
  return redis;
}

/** Menghapus semua kunci berawalan `prefix` (pembersihan di akhir tes). */
export async function deleteRedisKeys(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

// ── Penangkap email (Mailpit) untuk tes integrasi ───────────────────────────

/**
 * Mailpit dari `pnpm db:up` (deploy/docker-compose.dev.yml) dan dari CI
 * (.github/actions/infra): SMTP 1025 dengan login `balesin`/`balesin`, API HTTP 8025.
 * Kredensial ini hanya untuk dev/CI lokal.
 */
export const TEST_MAIL = {
  host: process.env.MAILPIT_HOST_TEST?.trim() || '127.0.0.1',
  smtpPort: 1025,
  username: 'balesin',
  password: 'balesin',
} as const;

const MAILPIT_API_URL = (
  process.env.MAILPIT_API_URL_TEST?.trim() || `http://${TEST_MAIL.host}:8025`
).replace(/\/+$/, '');

export interface CapturedMail {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: string[];
  replyTo: string[];
  /** Isi teks polos. */
  text: string;
  html: string;
}

interface MailpitAddress {
  Name?: string;
  Address?: string;
}

async function mailpitRequest(path: string, method: 'GET' | 'DELETE' = 'GET'): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${MAILPIT_API_URL}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Penangkap email (Mailpit) tidak bisa dihubungi di ${MAILPIT_API_URL}. ` +
        'Jalankan `pnpm db:up` lalu ulangi, atau arahkan MAILPIT_API_URL_TEST ke Mailpit yang hidup.',
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`Mailpit menjawab ${response.status} untuk ${path}`);
  return response;
}

async function mailpitFetch(path: string): Promise<unknown> {
  return (await mailpitRequest(path)).json();
}

/** Memastikan Mailpit hidup; melempar error berpesan jelas bila tidak. */
export async function assertMailCatcherReachable(): Promise<void> {
  // `/readyz`, bukan `/api/v1/info`: yang terakhir bisa ikut mengecek versi terbaru ke internet.
  await (await mailpitRequest('/readyz')).text();
}

/**
 * Email yang tertangkap untuk SATU alamat tujuan. Tes memakai alamat tujuan unik per kasus,
 * jadi berkas tes yang berjalan paralel tidak saling melihat email satu sama lain (kotak
 * masuk Mailpit dipakai bersama dan tidak pernah dikosongkan oleh tes).
 */
export async function capturedMailFor(recipient: string): Promise<CapturedMail[]> {
  const query = encodeURIComponent(`to:"${recipient}"`);
  const list = (await mailpitFetch(`/api/v1/search?query=${query}`)) as {
    messages?: Array<{ ID: string }>;
  };
  const mails: CapturedMail[] = [];
  for (const { ID } of list.messages ?? []) {
    const message = (await mailpitFetch(`/api/v1/message/${ID}`)) as {
      Subject?: string;
      From?: MailpitAddress;
      To?: MailpitAddress[];
      ReplyTo?: MailpitAddress[];
      Text?: string;
      HTML?: string;
    };
    mails.push({
      id: ID,
      subject: message.Subject ?? '',
      from: { name: message.From?.Name ?? '', address: message.From?.Address ?? '' },
      to: (message.To ?? []).map((entry) => entry.Address ?? ''),
      replyTo: (message.ReplyTo ?? []).map((entry) => entry.Address ?? ''),
      text: message.Text ?? '',
      html: message.HTML ?? '',
    });
  }
  return mails;
}

/** Menghapus email tertangkap untuk SATU alamat tujuan (bersih-bersih setelah tes). */
export async function deleteCapturedMailFor(recipient: string): Promise<void> {
  const query = encodeURIComponent(`to:"${recipient}"`);
  await (await mailpitRequest(`/api/v1/search?query=${query}`, 'DELETE')).text();
}

/** Menunggu sampai ada email untuk `recipient` (bawaan paling lama 10 detik). */
export async function waitForCapturedMail(
  recipient: string,
  timeoutMs = 10_000,
): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [mail] = await capturedMailFor(recipient);
    if (mail) return mail;
    if (Date.now() > deadline) {
      throw new Error(`Tidak ada email untuk ${recipient} setelah ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
