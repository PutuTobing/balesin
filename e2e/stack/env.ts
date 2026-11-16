/**
 * Lingkungan E2E: API + worker + web dijalankan khusus untuk tes, terpisah dari pengembangan.
 *
 *  - Database Postgres `balesin_e2e` (dibuat ulang dari nol setiap kali dijalankan).
 *  - Redis database nomor 14 (dikosongkan setiap kali dijalankan; 15 dipakai tes integrasi).
 *  - Port API 3100 dan web 5180, supaya tidak bentrok dengan `pnpm dev` (3000/5173).
 *
 * Semua nilai di sini KHUSUS TES (bukan rahasia produksi). Postgres/Redis/Mailpit dari
 * `pnpm db:up` (lokal) atau `.github/actions/infra` (CI).
 */
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 3100);

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_WEB_PORT}`;
export const E2E_API_URL = `http://127.0.0.1:${E2E_API_PORT}`;

/** Postgres tempat database E2E dibuat (database `balesin` hanya dipakai untuk terhubung). */
export const E2E_ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://balesin:balesin@localhost:5432/balesin';
export const E2E_DATABASE_NAME = 'balesin_e2e';
export const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://:balesin@localhost:6379/14';

export const E2E_SETUP_TOKEN = '6oQXFl6twGPArbJ9AQBAo1326SDiDalQaJzLXbAic34';
/** 32 byte bernilai tetap (base64): kunci khusus tes, bukan rahasia. */
export const E2E_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
export const E2E_SESSION_SECRET = 'E2eSesiTes_9fK2xQ7mL4pR8vW1zN6bH3yT5uJ0';

export const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

/** Mailpit lokal: SMTP 1025 tanpa enkripsi, login balesin/balesin (deploy/docker-compose.dev.yml). */
export const MAILPIT_SMTP = {
  host: 'localhost',
  port: '1025',
  username: 'balesin',
  password: 'balesin',
} as const;

/** Owner yang dibuat oleh wizard setup di tes. */
export const E2E_OWNER = {
  name: 'Rina Kartika',
  email: 'rina.e2e@majujaya.test',
  password: 'Kopi-Senja-Tenang-42',
  organization: 'PT Maju Jaya',
} as const;

/** Berkas status sesi Owner untuk proyek tes yang butuh sudah masuk. */
export const OWNER_STATE_PATH = new URL('../.auth/owner.json', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

/** Variabel lingkungan untuk proses API dan worker E2E. */
export function backendEnv(): Record<string, string> {
  const databaseUrl = new URL(E2E_ADMIN_DATABASE_URL);
  databaseUrl.pathname = `/${E2E_DATABASE_NAME}`;
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    APP_URL: E2E_BASE_URL,
    API_URL: E2E_API_URL,
    API_HOST: '127.0.0.1',
    API_PORT: String(E2E_API_PORT),
    TRUST_PROXY: 'false',
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: E2E_REDIS_URL,
    BALESIN_MASTER_KEY: E2E_MASTER_KEY,
    SESSION_SECRET: E2E_SESSION_SECRET,
    SETUP_TOKEN: E2E_SETUP_TOKEN,
    E2E_ADMIN_DATABASE_URL,
    E2E_DATABASE_NAME,
    // Cadangan .env tidak dipakai di E2E.
    SMTP_HOST: '',
  };
}

/**
 * Pengaman skrip yang MENGHAPUS data Redis (`flushdb`, hapus kunci batas laju): hanya Redis di mesin
 * ini (localhost/127.0.0.1/::1) dan bukan DB 0 (DB bawaan yang dipakai pengembangan/produksi).
 * Salah isi `E2E_REDIS_URL` tidak boleh menghapus Redis sungguhan (review web inbox, Info 5).
 */
export function assertTestRedisUrl(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const db = Number(parsed.pathname.replace(/^\//, '') || '0');
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || !Number.isInteger(db) || db === 0) {
    throw new Error(
      'Redis E2E harus di mesin ini (localhost) dan bukan DB 0. Periksa E2E_REDIS_URL.',
    );
  }
}
