/**
 * Tes keamanan dari review Fase 0 (docs/security-reviews/2026-11-13-fase0-fondasi.md), temuan R8:
 * alat bantu tes yang MENGHAPUS database tidak boleh bisa mengenai database non-tes.
 *
 * Cara membaca berkas ini:
 *  - `it(...)` biasa = penjaga regresi: perilaku ini SUDAH aman dan harus tetap begitu.
 *  - `it(...)` = CELAH YANG MASIH TERBUKA. Isi tesnya menyatakan perilaku yang BENAR dan
 *    saat ini memang gagal. Setelah celahnya diperbaiki, hapus `.fails`-nya.
 *
 * Semua tes hanya menyentuh server Postgres tes lokal (`DATABASE_URL_TEST`) atau alamat yang
 * sengaja tidak bisa dihubungi (127.0.0.1:1).
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, inject, it } from 'vitest';

import {
  assertTestDatabaseReachable,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
} from './index';

/** Tidak ada yang mendengarkan di port 1: koneksi pasti gagal, tidak ada database yang tersentuh. */
const UNREACHABLE_NON_TEST_URL = 'postgres://balesin:sandi-rahasia@127.0.0.1:1/produksi';

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(baseUrl: string, name: string): Promise<boolean> {
  return withClient(baseUrl, async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    return rowCount === 1;
  });
}

describe('R8 — pengaman nama "_test" di setiap fungsi yang membuat/menghapus database', () => {
  it('createTemporaryDatabase menolak database non-tes SEBELUM mencoba tersambung', async () => {
    await expect(createTemporaryDatabase(UNREACHABLE_NON_TEST_URL)).rejects.toThrow(
      /berakhiran "_test"/,
    );
  });

  it('dropStaleTemporaryDatabases menolak database non-tes SEBELUM tersambung', async () => {
    // Sekarang fungsi ini langsung tersambung ke server mana pun yang diberikan dan menghapus
    // database berawalan `<nama>_tmp_`; pengamannya hanya ada di pemanggilnya (global-setup).
    await expect(dropStaleTemporaryDatabases(UNREACHABLE_NON_TEST_URL)).rejects.toThrow(
      /berakhiran "_test"/,
    );
  });

  it('assertTestDatabaseReachable menolak database non-tes SEBELUM tersambung', async () => {
    await expect(assertTestDatabaseReachable(UNREACHABLE_NON_TEST_URL)).rejects.toThrow(
      /berakhiran "_test"/,
    );
  });
});

describe('R8 — pembersihan sisa tes hanya mengenai database buatan alat ini', () => {
  it('database berawalan sama tetapi BUKAN buatan alat ini tidak ikut terhapus', async () => {
    const baseUrl = inject('testDatabaseBaseUrl');
    const baseName = new URL(baseUrl).pathname.slice(1);
    // Nama yang mungkin dibuat orang secara manual. Potongan "arsip" terbaca sebagai angka
    // basis-36 yang sah, jadi dianggap "dibuat tahun 1970" lalu dihapus paksa.
    const name = `${baseName}_tmp_arsip_${randomBytes(4).toString('hex')}`;

    await withClient(baseUrl, (client) => client.query(`create database "${name}"`));
    try {
      await dropStaleTemporaryDatabases(baseUrl);

      expect(await databaseExists(baseUrl, name)).toBe(true);
    } finally {
      await withClient(baseUrl, (client) =>
        client.query(`drop database if exists "${name}" with (force)`),
      );
    }
  });

  it('database sementara yang masih baru tidak dihapus oleh pembersihan', async () => {
    const baseUrl = inject('testDatabaseBaseUrl');
    const database = await createTemporaryDatabase(baseUrl, { migrate: false });
    try {
      await dropStaleTemporaryDatabases(baseUrl);

      expect(await databaseExists(baseUrl, database.name)).toBe(true);
    } finally {
      await database.drop();
    }
    expect(await databaseExists(baseUrl, database.name)).toBe(false);
  });
});
