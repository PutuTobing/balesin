/**
 * `globalSetup` Vitest untuk tes integrasi database: menyiapkan SATU database sementara yang
 * sudah dimigrasi untuk seluruh berkas tes, lalu menghapusnya di akhir.
 *
 * Di dalam tes, ambil URL-nya dengan `inject('testDatabaseUrl')`. Tiap tes membuat
 * organisasinya sendiri, jadi berkas tes yang berjalan paralel tidak saling mengganggu.
 */
import type { TestProject } from 'vitest/node';

import {
  assertTestDatabaseReachable,
  createTemporaryDatabase,
  dropReleasedTemporaryDatabases,
  dropStaleTemporaryDatabases,
  resolveTestDatabaseUrl,
} from './index';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = resolveTestDatabaseUrl();
  await assertTestDatabaseReachable(baseUrl);
  await dropStaleTemporaryDatabases(baseUrl);

  const database = await createTemporaryDatabase(baseUrl);
  // Template terpisah: database di atas disambungi tes, sedangkan sumber `CREATE DATABASE … TEMPLATE`
  // tidak boleh punya koneksi lain.
  const template = await createTemporaryDatabase(baseUrl);
  project.provide('testDatabaseUrl', database.url);
  project.provide('testDatabaseBaseUrl', baseUrl);
  project.provide('testDatabaseTemplate', template.name);

  return async () => {
    await database.drop();
    await template.drop();
    // Database per berkas tes hanya DILEPAS saat `afterAll` (lihat `TemporaryDatabase.release`);
    // dihapus di sini, ketika tidak ada lagi beban tulis paralel.
    await dropReleasedTemporaryDatabases(baseUrl);
  };
}
