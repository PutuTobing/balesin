import { sql } from 'drizzle-orm';

import type { DbExecutor } from './client';

/**
 * Advisory lock TRANSAKSI (`pg_advisory_xact_lock`, dilepas saat commit/rollback) untuk setiap kunci,
 * berurutan seperti diberikan (pemanggil mengurutkan — mis. `contactIdentityLockKeys` di
 * `@balesin/core`). Kunci teks di-hash 64-bit (`hashtextextended`); tabrakan hanya membuat dua
 * identitas saling menunggu, tidak pernah bertukar data.
 */
export async function lockAdvisoryKeys(tx: DbExecutor, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
