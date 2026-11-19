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

/**
 * Komentar database sementara yang SELESAI dipakai (`release`): tidak ada lagi yang menyambung, boleh
 * dihapus kapan saja oleh `dropReleasedTemporaryDatabases` (teardown global) tanpa menunggu umur.
 */
export const RELEASED_DATABASE_COMMENT =
  'balesin: database sementara untuk tes — selesai dipakai (aman dihapus)';

/** Bagian nama setelah penanda: <waktu dibuat, basis 36>_<8 heksadesimal acak>. */
const TEMPORARY_SUFFIX = /^([0-9a-z]{8,9})_[0-9a-f]{8}$/;

declare module 'vitest' {
  export interface ProvidedContext {
    /** Database sementara yang sudah dimigrasi (dibuat `global-setup.ts`). */
    testDatabaseUrl: string;
    /** Server Postgres tes — untuk membuat database sementara tambahan. */
    testDatabaseBaseUrl: string;
    /**
     * Nama database sementara yang SUDAH dimigrasi dan tidak pernah disambungi siapa pun — dipakai
     * sebagai `TEMPLATE` database per berkas tes (salin, tanpa menjalankan ulang migrasi).
     */
    testDatabaseTemplate: string;
  }
}

export interface TemporaryDatabase {
  name: string;
  url: string;
  /**
   * Mengosongkan SEMUA tabel database sementara ini (struktur dan migrasi tetap). Untuk tes
   * yang butuh keadaan "instalasi baru" berulang kali tanpa membuat database baru.
   */
  reset(): Promise<void>;
  /** Hapus database (memutus koneksi yang masih terbuka). */
  drop(): Promise<void>;
  /**
   * Tandai SELESAI dipakai dan putus koneksi yang tersisa — TANPA `DROP DATABASE`. Penghapusannya
   * diserahkan ke teardown global (`dropReleasedTemporaryDatabases`).
   *
   * Alasan: `DROP DATABASE` memaksa checkpoint Postgres (`CHECKPOINT_FORCE | CHECKPOINT_WAIT`).
   * Saat banyak berkas tes berjalan paralel dan menulis, checkpoint itu antre dan satu `DROP` bisa
   * makan > 30 detik — `afterAll` habis waktu walau tesnya lulus. Di akhir run tidak ada beban tulis,
   * jadi penghapusan berurutan cepat.
   */
  release(): Promise<void>;
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
      if (createdAt === undefined) continue;
      if (comment !== TEMPORARY_DATABASE_COMMENT && comment !== RELEASED_DATABASE_COMMENT) continue;
      // Yang sudah dilepas boleh langsung; yang belum hanya bila sudah tua (sisa run terhenti).
      if (comment !== RELEASED_DATABASE_COMMENT && Date.now() - createdAt < STALE_AFTER_MS)
        continue;
      await client.query(`drop database if exists ${quoteIdentifier(datname)} with (force)`);
    }
  });
}

/**
 * Menghapus database sementara yang sudah DILEPAS (`release`) — dari run ini atau run lain yang
 * sudah selesai memakainya. Database yang masih dipakai (komentar biasa) tidak disentuh, jadi aman
 * walau ada run tes lain yang sedang berjalan di server yang sama.
 */
export async function dropReleasedTemporaryDatabases(baseUrl: string): Promise<number> {
  assertTestDatabaseUrl(baseUrl);
  const prefix = `${databaseNameOf(baseUrl)}${TEMPORARY_MARKER}`;
  return withAdminClient(baseUrl, async (client) => {
    const { rows } = await client.query<{ datname: string; comment: string | null }>(
      `select datname, shobj_description(oid, 'pg_database') as comment
       from pg_database where starts_with(datname, $1)`,
      [prefix],
    );
    let dropped = 0;
    for (const { datname, comment } of rows) {
      if (temporaryDatabaseCreatedAt(datname, prefix) === undefined) continue;
      if (comment !== RELEASED_DATABASE_COMMENT) continue;
      await client.query(`drop database if exists ${quoteIdentifier(datname)} with (force)`);
      dropped += 1;
    }
    return dropped;
  });
}

/**
 * Membuat database sementara di server yang sama dengan `baseUrl`.
 * `migrate: true` (bawaan) langsung menerapkan semua migrasi.
 */
export async function createTemporaryDatabase(
  baseUrl: string,
  options: {
    migrate?: boolean;
    /**
     * Salin dari database sementara yang SUDAH dimigrasi (tanpa koneksi lain ke sana) alih-alih
     * menjalankan semua migrasi lagi — jauh lebih ringan saat banyak berkas tes dibuat bersamaan.
     */
    template?: string;
  } = {},
): Promise<TemporaryDatabase> {
  const baseName = databaseNameOf(assertTestDatabaseUrl(baseUrl));
  const name = `${baseName}${TEMPORARY_MARKER}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const url = withDatabaseName(baseUrl, name);

  await withAdminClient(baseUrl, async (client) => {
    await client.query(
      options.template
        ? `create database ${quoteIdentifier(name)} template ${quoteIdentifier(options.template)}`
        : `create database ${quoteIdentifier(name)}`,
    );
    await client.query(
      `comment on database ${quoteIdentifier(name)} is '${TEMPORARY_DATABASE_COMMENT}'`,
    );
  });

  const drop = async (): Promise<void> => {
    await withAdminClient(baseUrl, async (client) => {
      await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
    });
  };

  // Hanya menyentuh database sementara INI (URL-nya dibuat di atas, tidak berasal dari luar).
  const reset = async (): Promise<void> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      const { rows } = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const tables = rows.map((row) => quoteIdentifier(row.tablename)).join(', ');
      const hasAuditLogs = rows.some((row) => row.tablename === 'audit_logs');
      await client.query('begin');
      // `audit_logs` hanya-tambah (trigger menolak TRUNCATE); dimatikan sebentar khusus di sini.
      if (hasAuditLogs) {
        await client.query('alter table audit_logs disable trigger audit_logs_no_truncate');
      }
      await client.query(`truncate table ${tables} cascade`);
      if (hasAuditLogs) {
        await client.query('alter table audit_logs enable trigger audit_logs_no_truncate');
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };

  if (!options.template && (options.migrate ?? true)) {
    try {
      await runMigrations(url);
    } catch (error) {
      await drop();
      throw error;
    }
  }

  const release = async (): Promise<void> => {
    await withAdminClient(baseUrl, async (client) => {
      await client.query(
        `comment on database ${quoteIdentifier(name)} is '${RELEASED_DATABASE_COMMENT}'`,
      );
      // Koneksi tersisa (mis. klien yang lupa ditutup) diputus supaya DROP nanti tidak tertahan.
      await client.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [name],
      );
    });
  };

  return { name, url, reset, drop, release };
}

export * from './expect-pg-error';
export * from './factories';
