import { getPgError, type PgErrorInfo } from '../errors';

/**
 * Menunggu `query` GAGAL lalu mengembalikan info error Postgres-nya (kode SQLSTATE,
 * nama constraint). Melempar error bila query ternyata berhasil.
 */
export async function pgErrorOf(query: PromiseLike<unknown>): Promise<PgErrorInfo> {
  let failure: unknown;
  try {
    await query;
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) throw new Error('Query seharusnya gagal, tetapi berhasil.');

  const info = getPgError(failure);
  if (!info)
    throw new Error('Query gagal, tetapi bukan karena error Postgres.', { cause: failure });
  return info;
}
