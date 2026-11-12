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
  dropStaleTemporaryDatabases,
  resolveTestDatabaseUrl,
} from './index';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Database sementara yang sudah dimigrasi. */
    testDatabaseUrl: string;
    /** Server Postgres tes — untuk membuat database sementara tambahan. */
    testDatabaseBaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = resolveTestDatabaseUrl();
  await assertTestDatabaseReachable(baseUrl);
  await dropStaleTemporaryDatabases(baseUrl);

  const database = await createTemporaryDatabase(baseUrl);
  project.provide('testDatabaseUrl', database.url);
  project.provide('testDatabaseBaseUrl', baseUrl);

  return async () => {
    await database.drop();
  };
}
