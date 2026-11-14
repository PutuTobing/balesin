import {
  accountTokens,
  organizations,
  type AccountTokenPurpose,
  type DbExecutor,
} from '@balesin/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';

/**
 * Query token akun (atur ulang password, verifikasi email). Semua query memfilter
 * `organization_id`, kecuali pencarian berdasarkan hash token — memang itu yang sedang dicari;
 * hasilnya membawa `organization_id` untuk query berikutnya. Waktu memakai jam DATABASE.
 */

export interface FoundAccountToken {
  id: string;
  organizationId: string;
  userId: string;
  purpose: AccountTokenPurpose;
  email: string;
  expiresAt: Date;
  failedAttempts: number;
  state: 'usable' | 'used' | 'expired' | 'revoked';
  organization: { id: string; name: string; timezone: string; productName: string | null };
}

export async function findAccountTokenByHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<FoundAccountToken | undefined> {
  const [row] = await db
    .select({
      id: accountTokens.id,
      organizationId: accountTokens.organizationId,
      userId: accountTokens.userId,
      purpose: accountTokens.purpose,
      email: accountTokens.email,
      expiresAt: accountTokens.expiresAt,
      failedAttempts: accountTokens.failedAttempts,
      used: sql<boolean>`${accountTokens.usedAt} is not null`,
      revoked: sql<boolean>`${accountTokens.revokedAt} is not null`,
      expired: sql<boolean>`${accountTokens.expiresAt} <= now()`,
      organizationName: organizations.name,
      organizationTimezone: organizations.timezone,
      productName: organizations.productName,
    })
    .from(accountTokens)
    .innerJoin(organizations, eq(organizations.id, accountTokens.organizationId))
    .where(eq(accountTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    purpose: row.purpose,
    email: row.email,
    expiresAt: row.expiresAt,
    failedAttempts: row.failedAttempts,
    state: row.used ? 'used' : row.revoked ? 'revoked' : row.expired ? 'expired' : 'usable',
    organization: {
      id: row.organizationId,
      name: row.organizationName,
      timezone: row.organizationTimezone,
      productName: row.productName,
    },
  };
}

/** Membatalkan token hidup pengguna untuk satu tujuan (sebelum menerbitkan yang baru). */
export async function revokeLiveAccountTokens(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  purpose: AccountTokenPurpose,
): Promise<number> {
  const rows = await db
    .update(accountTokens)
    .set({ revokedAt: sql`now()`, deliveryTokenEncrypted: null })
    .where(
      and(
        eq(accountTokens.organizationId, organizationId),
        eq(accountTokens.userId, userId),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
      ),
    )
    .returning({ id: accountTokens.id });
  return rows.length;
}

export async function insertAccountToken(
  db: DbExecutor,
  input: {
    id: string;
    organizationId: string;
    userId: string;
    purpose: AccountTokenPurpose;
    tokenHash: string;
    email: string;
    lifetimeMinutes: number;
    deliveryTokenEncrypted: string;
    client: ClientInfo;
  },
): Promise<{ id: string; expiresAt: Date }> {
  // Token basi pengguna ini (lebih dari 7 hari) sekalian dibuang supaya tabelnya tidak membesar.
  await db
    .delete(accountTokens)
    .where(
      and(
        eq(accountTokens.organizationId, input.organizationId),
        eq(accountTokens.userId, input.userId),
        sql`${accountTokens.expiresAt} < now() - interval '7 days'`,
      ),
    );
  const [row] = await db
    .insert(accountTokens)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      email: input.email,
      expiresAt: sql`now() + make_interval(mins => ${input.lifetimeMinutes})`,
      deliveryStatus: 'queued',
      deliveryTokenEncrypted: input.deliveryTokenEncrypted,
      requestedIp: input.client.ip,
      requestedUserAgent: input.client.userAgent,
    })
    .returning({ id: accountTokens.id, expiresAt: accountTokens.expiresAt });
  if (!row) throw new Error('Token akun tidak tersimpan');
  return row;
}

/** Pengantrean email gagal: tandai gagal dan buang salinan token (tidak ada yang akan mengirimnya). */
export async function markAccountTokenUndelivered(
  db: DbExecutor,
  organizationId: string,
  tokenId: string,
): Promise<void> {
  await db
    .update(accountTokens)
    .set({ deliveryStatus: 'failed', deliveryTokenEncrypted: null, revokedAt: sql`now()` })
    .where(and(eq(accountTokens.organizationId, organizationId), eq(accountTokens.id, tokenId)));
}

/**
 * Mengambil satu jatah percobaan kode secara atomik: hanya selama token masih bisa dipakai dan
 * jatahnya belum habis. Mengembalikan jumlah percobaan SETELAH ditambah, atau `undefined`.
 */
export async function claimAccountTokenAttempt(
  db: DbExecutor,
  organizationId: string,
  tokenId: string,
  maxAttempts: number,
): Promise<number | undefined> {
  const [row] = await db
    .update(accountTokens)
    .set({ failedAttempts: sql`${accountTokens.failedAttempts} + 1` })
    .where(
      and(
        eq(accountTokens.organizationId, organizationId),
        eq(accountTokens.id, tokenId),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
        sql`${accountTokens.expiresAt} > now()`,
        lt(accountTokens.failedAttempts, maxAttempts),
      ),
    )
    .returning({ failedAttempts: accountTokens.failedAttempts });
  return row?.failedAttempts;
}

/** Menandai token terpakai — hanya satu permintaan yang bisa. `false` = sudah tidak berlaku. */
export async function consumeAccountToken(
  db: DbExecutor,
  organizationId: string,
  tokenId: string,
): Promise<boolean> {
  const rows = await db
    .update(accountTokens)
    .set({ usedAt: sql`now()`, deliveryTokenEncrypted: null })
    .where(
      and(
        eq(accountTokens.organizationId, organizationId),
        eq(accountTokens.id, tokenId),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
        sql`${accountTokens.expiresAt} > now()`,
      ),
    )
    .returning({ id: accountTokens.id });
  return rows.length > 0;
}

export async function revokeAccountToken(
  db: DbExecutor,
  organizationId: string,
  tokenId: string,
): Promise<void> {
  await db
    .update(accountTokens)
    .set({ revokedAt: sql`now()`, deliveryTokenEncrypted: null })
    .where(
      and(
        eq(accountTokens.organizationId, organizationId),
        eq(accountTokens.id, tokenId),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
      ),
    );
}
