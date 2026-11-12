import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/** Transaksi Drizzle (argumen callback `db.transaction`). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Dipakai repo yang bisa jalan di dalam maupun di luar transaksi. */
export type DbExecutor = Database | Transaction;

export interface CreateDbOptions {
  /** Nama aplikasi yang terlihat di `pg_stat_activity` (mis. `balesin-api`). */
  applicationName?: string;
  /** Jumlah koneksi maksimal di pool. Bawaan 10. */
  maxConnections?: number;
  /** Batas lama satu query sebelum dibatalkan Postgres. Bawaan 30 detik. */
  statementTimeoutMs?: number;
  /**
   * Dipanggil saat koneksi yang sedang menganggur di pool terputus (mis. Postgres restart).
   * Pool membuang koneksi itu dan membuat yang baru; cukup dicatat ke log.
   */
  onPoolError?: (error: Error) => void;
}

/**
 * Membuat klien database (Drizzle di atas pool `pg`). Koneksi baru dibuka saat query pertama,
 * jadi fungsi ini tidak gagal walau Postgres sedang mati.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Database {
  const pool = new Pool({
    connectionString: url,
    application_name: options.applicationName ?? 'balesin',
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // Tanpa listener ini, error pada koneksi menganggur menjatuhkan seluruh proses.
  pool.on('error', (error) => options.onPoolError?.(error));

  return drizzle(pool, { schema });
}

/** Melempar error bila Postgres tidak bisa menjalankan query sederhana. */
export async function pingDb(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Menutup semua koneksi di pool (menunggu query yang sedang berjalan). */
export async function closeDb(db: Database): Promise<void> {
  await db.$client.end();
}
