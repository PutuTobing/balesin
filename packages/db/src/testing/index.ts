/**
 * Alat bantu tes integrasi terhadap Postgres sungguhan.
 *
 * Cara kerja:
 *  - Server Postgres diambil dari `DATABASE_URL_TEST` (bawaan: Postgres dari `pnpm db:up`).
 *  - Tes TIDAK memakai database itu langsung. Setiap kali jalan, dibuat database sementara
 *    baru (`<nama>_tmp_<waktu>_<acak>`), dimigrasi dari nol, lalu dihapus setelah selesai.
 *    Jadi tes bisa diulang berkali-kali, aman dijalankan paralel, dan tidak pernah menyentuh
 *    database pengembangan.
 *  - Bila Postgres tidak bisa dihubungi, tes GAGAL dengan pesan jelas (tidak dilewati diam-diam).
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { describeDatabaseUrl, runMigrations } from '../migrator';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://balesin:balesin@localhost:5432/balesin_test';

/** Database sementara yang lebih tua dari ini dianggap sisa tes yang terhenti, lalu dibersihkan. */
const STALE_AFTER_MS = 60 * 60 * 1000;

const TEMPORARY_MARKER = '_tmp_';

/** Komentar yang ditempelkan pada setiap database sementara: bukti bahwa alat ini yang membuatnya. */
export const TEMPORARY_DATABASE_COMMENT = 'balesin: database sementara untuk tes (aman dihapus)';

/** Bagian nama setelah penanda: <waktu dibuat, basis 36>_<8 heksadesimal acak>. */
const TEMPORARY_SUFFIX = /^([0-9a-z]{8,9})_[0-9a-f]{8}$/;

export interface TemporaryDatabase {
  name: string;
  url: string;
  /** Hapus database (memutus koneksi yang masih terbuka). */
  drop(): Promise<void>;
}

function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function withDatabaseName(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * URL database tes. Nama databasenya WAJIB berakhiran `_test` — pengaman supaya salah isi
 * `DATABASE_URL_TEST` (mis. menunjuk database pengembangan/produksi) langsung ditolak.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return assertTestDatabaseUrl(env.DATABASE_URL_TEST?.trim() || DEFAULT_TEST_DATABASE_URL);
}

/**
 * Melempar error bila `databaseUrl` tidak menunjuk database tes. Dipanggil oleh SETIAP fungsi
 * di berkas ini sebelum membuka koneksi — bukan hanya oleh pemanggilnya — karena beberapa di
 * antaranya membuat dan menghapus database.
 */
export function assertTestDatabaseUrl(databaseUrl: string): string {
  let name: string;
  try {
    name = databaseNameOf(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL_TEST bukan URL Postgres yang valid.');
  }
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(
      'Nama database di DATABASE_URL_TEST harus berakhiran "_test" (huruf kecil, angka, garis bawah), ' +
        'contoh: balesin_test. Ini mencegah tes berjalan di database pengembangan atau produksi.',
    );
  }
  return databaseUrl;
}

async function withAdminClient<T>(
  baseUrl: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  assertTestDatabaseUrl(baseUrl);
  const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'galat tidak dikenal';
    throw new Error(
      `Postgres untuk tes tidak bisa dihubungi di ${describeDatabaseUrl(baseUrl)} (${reason}). ` +
        'Jalankan `pnpm db:up` lalu ulangi, atau arahkan DATABASE_URL_TEST ke Postgres yang hidup.',
      { cause: error },
    );
  }
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Memastikan Postgres tes bisa dihubungi; melempar error berpesan jelas bila tidak. */
export async function assertTestDatabaseReachable(baseUrl: string): Promise<void> {
  await withAdminClient(baseUrl, async (client) => {
    await client.query('select 1');
  });
}

/**
 * Waktu pembuatan database sementara, atau `undefined` bila namanya bukan buatan alat ini.
 * Sengaja ketat: nama harus persis `<nama>_tmp_<waktu basis 36>_<8 heksadesimal>`. Sekadar
 * berawalan `<nama>_tmp_` tidak cukup — database buatan orang (mis. `…_tmp_arsip_…`) tidak
 * boleh ikut terhapus.
 */
function temporaryDatabaseCreatedAt(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const timestamp = TEMPORARY_SUFFIX.exec(name.slice(prefix.length))?.[1];
  return timestamp === undefined ? undefined : Number.parseInt(timestamp, 36);
}

/**
 * Menghapus database sementara sisa tes yang terhenti di tengah jalan. Sebuah database hanya
 * dihapus bila KETIGA syarat terpenuhi: namanya berpola buatan alat ini, membawa komentar
 * penanda yang ditempel saat dibuat, dan umurnya sudah lewat batas.
 */
export async function dropStaleTemporaryDatabases(baseUrl: string): Promise<void> {
  assertTestDatabaseUrl(baseUrl);
  const prefix = `${databaseNameOf(baseUrl)}${TEMPORARY_MARKER}`;
  await withAdminClient(baseUrl, async (client) => {
    const { rows } = await client.query<{ datname: string; comment: string | null }>(
      `select datname, shobj_description(oid, 'pg_database') as comment
       from pg_database where starts_with(datname, $1)`,
      [prefix],
    );
    for (const { datname, comment } of rows) {
      const createdAt = temporaryDatabaseCreatedAt(datname, prefix);
      if (createdAt === undefined || comment !== TEMPORARY_DATABASE_COMMENT) continue;
      if (Date.now() - createdAt < STALE_AFTER_MS) continue;
      await client.query(`drop database if exists ${quoteIdentifier(datname)} with (force)`);
    }
  });
}

/**
 * Membuat database sementara di server yang sama dengan `baseUrl`.
 * `migrate: true` (bawaan) langsung menerapkan semua migrasi.
 */
export async function createTemporaryDatabase(
  baseUrl: string,
  options: { migrate?: boolean } = {},
): Promise<TemporaryDatabase> {
  const baseName = databaseNameOf(assertTestDatabaseUrl(baseUrl));
  const name = `${baseName}${TEMPORARY_MARKER}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const url = withDatabaseName(baseUrl, name);

  await withAdminClient(baseUrl, async (client) => {
    await client.query(`create database ${quoteIdentifier(name)}`);
    await client.query(
      `comment on database ${quoteIdentifier(name)} is '${TEMPORARY_DATABASE_COMMENT}'`,
    );
  });

  const drop = async (): Promise<void> => {
    await withAdminClient(baseUrl, async (client) => {
      await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
    });
  };

  if (options.migrate ?? true) {
    try {
      await runMigrations(url);
    } catch (error) {
      await drop();
      throw error;
    }
  }

  return { name, url, drop };
}

export * from './expect-pg-error';
export * from './factories';
