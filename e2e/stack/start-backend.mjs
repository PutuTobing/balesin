// @ts-check
/**
 * Menyalakan backend E2E dari keadaan bersih (dipanggil `webServer` Playwright):
 *   1. database `E2E_DATABASE_NAME` dihapus lalu dibuat ulang, dimigrasi dari nol;
 *   2. Redis E2E (database nomor 14) dikosongkan — batas percobaan & penguncian akun hilang;
 *   3. server Meta TIRUAN dijalankan (`fake-meta-server.ts`, 127.0.0.1 port acak), lalu server channel
 *      TIRUAN (`fake-channels-server.ts`: Bot API Telegram + IMAP TLS + IMAP/SMTP modul Email; kendali
 *      di port tetap);
 *   4. API dan worker dijalankan (tsx, tanpa watch) dengan env dari `stack/env.ts` ditambah
 *      `META_GRAPH_BASE_URL` = alamat server tiruan. Tes E2E tidak pernah memanggil Meta sungguhan.
 *
 * Proses ini tetap hidup selama API & worker hidup. Playwright mematikannya (beserta anaknya)
 * setelah tes selesai; kalau salah satu anak mati, proses ini ikut keluar supaya tes gagal jelas.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os, { EOL } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel ${name} belum diisi (lihat e2e/stack/env.ts).`);
  return value;
}

const adminUrl = required('E2E_ADMIN_DATABASE_URL');
const databaseName = required('E2E_DATABASE_NAME');
if (!/^[a-z0-9_]+_e2e$|^balesin_e2e$/.test(databaseName)) {
  // Pengaman: skrip ini MENGHAPUS database. Hanya nama berakhiran _e2e yang diterima.
  throw new Error(`Nama database E2E harus berakhiran "_e2e", diterima: ${databaseName}`);
}

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

async function resetDatabase() {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
  log(`database ${databaseName} dibuat ulang`);
}

/** Sama dengan `assertTestRedisUrl` (env.ts): flushdb hanya untuk Redis lokal, bukan DB 0. */
function assertTestRedisUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const db = Number(parsed.pathname.replace(/^\//, '') || '0');
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || !Number.isInteger(db) || db === 0) {
    throw new Error(
      'Redis E2E harus di mesin ini (localhost) dan bukan DB 0. Periksa E2E_REDIS_URL.',
    );
  }
}

/** Kosongkan folder media E2E (hanya folder khusus E2E di direktori sementara sistem). */
async function resetMediaDir() {
  const dir = process.env.MEDIA_DIR;
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (
    !/^balesin-e2e-media-\d+$/.test(path.basename(resolved)) ||
    !resolved.startsWith(os.tmpdir())
  ) {
    throw new Error(
      'MEDIA_DIR E2E harus folder balesin-e2e-media-<port API> di direktori sementara sistem.',
    );
  }
  await rm(resolved, { recursive: true, force: true });
  log('folder media E2E dikosongkan');
}

async function resetRedis() {
  assertTestRedisUrl(required('REDIS_URL'));
  const redis = new Redis(required('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
  log('redis E2E dikosongkan');
}

function run(name, args, { wait }) {
  // Windows: pnpm adalah berkas .cmd yang hanya bisa dijalankan lewat shell. Argumennya
  // teks tetap dari skrip ini (bukan masukan pengguna), jadi aman digabung.
  const options = {
    cwd: root,
    env: process.env,
    stdio: /** @type {const} */ (['ignore', 'inherit', 'inherit']),
  };
  const child = isWindows
    ? spawn(`pnpm ${args.join(' ')}`, { ...options, shell: true })
    : spawn('pnpm', args, options);
  if (wait) {
    return new Promise((resolve, reject) => {
      child.on('exit', (code) =>
        code === 0 ? resolve(undefined) : reject(new Error(`${name} gagal (kode ${code})`)),
      );
    });
  }
  child.on('exit', (code) => {
    log(`${name} berhenti (kode ${code}); backend E2E dimatikan`);
    shutdown(code ?? 1);
  });
  return child;
}

/**
 * Server tiruan (TypeScript, lewat tsx paket api). Menunggu baris `<prefix>…` di stdout-nya lalu
 * mengembalikan sisa baris itu; keluaran lain diteruskan apa adanya.
 * @param {string} file nama berkas di `e2e/stack`
 * @param {string} prefix awalan baris "siap"
 * @param {string} label nama untuk pesan log
 * @returns {Promise<string>}
 */
function startFakeServer(file, prefix, label) {
  const script = path.join(root, 'e2e', 'stack', file);
  const args = ['--filter', '@balesin/api', 'exec', 'tsx', script];
  const options = {
    cwd: root,
    env: process.env,
    stdio: /** @type {const} */ (['ignore', 'pipe', 'inherit']),
  };
  const child = isWindows
    ? spawn(`pnpm ${args.map((arg) => `"${arg}"`).join(' ')}`, { ...options, shell: true })
    : spawn('pnpm', args, options);
  children.push(child);
  return new Promise((resolve, reject) => {
    let buffer = '';
    let ready = false;
    const timer = setTimeout(() => reject(new Error(`${label} tidak kunjung siap`)), 60_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!ready && line.startsWith(prefix)) {
          ready = true;
          clearTimeout(timer);
          resolve(line.slice(prefix.length));
        } else if (line) {
          process.stdout.write(`${line}${EOL}`);
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`${label} berhenti (kode ${code})`));
      else {
        log(`${label} berhenti (kode ${code}); backend E2E dimatikan`);
        shutdown(code ?? 1);
      }
    });
  });
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  await resetDatabase();
  await resetRedis();
  await resetMediaDir();
  await run('migrasi', ['--filter', '@balesin/db', 'exec', 'tsx', 'src/migrate.ts'], {
    wait: true,
  });
  const fakeMetaUrl = await startFakeServer(
    'fake-meta-server.ts',
    'FAKE_META_URL=',
    'server Meta tiruan',
  );
  process.env.META_GRAPH_BASE_URL = fakeMetaUrl;
  log(`server Meta tiruan di ${fakeMetaUrl}`);
  // Fase 6: Bot API Telegram + IMAP (TLS sertifikat tes) tiruan; SMTP channel Email = Mailpit lokal.
  // Variabel BALESIN_TEST_* hanya diterima api/worker non-produksi (`channelTestOverridesFromEnv`).
  const fakeChannels = JSON.parse(
    await startFakeServer('fake-channels-server.ts', 'FAKE_CHANNELS=', 'server channel tiruan'),
  );
  process.env.BALESIN_TEST_TELEGRAM_BASE_URL = fakeChannels.telegramUrl;
  // Modul Email (Fase 9): IMAP & SMTP tiruan sendiri (port acak), sertifikat tes yang sama.
  process.env.BALESIN_TEST_IMAP_PORTS = `${fakeChannels.imapPort},${fakeChannels.mailImapPort}`;
  process.env.BALESIN_TEST_MAIL_SMTP_PORTS = String(fakeChannels.mailSmtpPort);
  process.env.BALESIN_TEST_IMAP_CA_FILE = fakeChannels.caFile;
  log(
    `server channel tiruan: Telegram ${fakeChannels.telegramUrl}, IMAP localhost:${fakeChannels.imapPort}, Email IMAP ${fakeChannels.mailImapPort} SMTP ${fakeChannels.mailSmtpPort}`,
  );
  children.push(
    run('api', ['--filter', '@balesin/api', 'exec', 'tsx', 'src/index.ts'], { wait: false }),
    run('worker', ['--filter', '@balesin/worker', 'exec', 'tsx', 'src/index.ts'], {
      wait: false,
    }),
  );
  log('api & worker dijalankan');
} catch (error) {
  process.stderr.write(
    `[e2e] gagal menyiapkan backend: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write('[e2e] Pastikan Postgres, Redis, dan Mailpit menyala (`pnpm db:up`).\n');
  shutdown(1);
}
