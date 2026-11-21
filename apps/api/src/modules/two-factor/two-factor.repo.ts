import {
  organizations,
  twoFactorChallenges,
  userBackupCodes,
  userSessions,
  users,
  type DbExecutor,
} from '@balesin/db';
import { rolesWithPermission, type UserRole } from '@balesin/shared';
import { and, eq, inArray, isNull, lt, max, ne, or, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';

/**
 * Query verifikasi dua langkah. Semua query memfilter `organization_id`; satu-satunya yang
 * belum tahu organisasinya adalah pencarian tantangan berdasarkan hash token (memang itu yang
 * sedang dicari) — hasilnya membawa `organization_id` untuk query berikutnya.
 * Semua batas waktu memakai jam DATABASE (`now()`).
 */

// ── Keadaan 2FA pengguna ────────────────────────────────────────────────────

export interface TwoFactorUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  disabledAt: Date | null;
  totpSecretEncrypted: string | null;
  totpEnabledAt: Date | null;
  totpLastUsedStep: number | null;
  totpPendingSecretEncrypted: string | null;
  totpPendingCreatedAt: Date | null;
  /** Waktu rahasia pendaftaran yang sekarang PERTAMA kali dibuat (batas mutlak pemakaian ulang). */
  totpPendingIssuedAt: Date | null;
  /** Terakhir password diganti: cookie perangkat dikenal yang lebih tua tidak diakui. */
  passwordChangedAt: Date | null;
}

const twoFactorUserColumns = {
  id: users.id,
  organizationId: users.organizationId,
  email: users.email,
  name: users.name,
  role: users.role,
  passwordHash: users.passwordHash,
  disabledAt: users.disabledAt,
  totpSecretEncrypted: users.totpSecretEncrypted,
  totpEnabledAt: users.totpEnabledAt,
  totpLastUsedStep: users.totpLastUsedStep,
  totpPendingSecretEncrypted: users.totpPendingSecretEncrypted,
  totpPendingCreatedAt: users.totpPendingCreatedAt,
  totpPendingIssuedAt: users.totpPendingIssuedAt,
  passwordChangedAt: users.passwordChangedAt,
};

export async function findTwoFactorUser(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<TwoFactorUser | undefined> {
  const [row] = await db
    .select(twoFactorUserColumns)
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return row;
}

/**
 * Menyimpan rahasia pendaftaran (baru, atau yang sama ditampilkan ulang). `fresh` = rahasia baru:
 * waktu terbit pertamanya (`totp_pending_issued_at`) ikut diatur ulang. Mengembalikan waktu dibuat.
 */
export async function savePendingSecret(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  pendingSecretEncrypted: string,
  fresh: boolean,
): Promise<Date | undefined> {
  const [row] = await db
    .update(users)
    .set({
      totpPendingSecretEncrypted: pendingSecretEncrypted,
      totpPendingCreatedAt: sql`now()`,
      ...(fresh ? { totpPendingIssuedAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, userId),
        isNull(users.totpEnabledAt),
      ),
    )
    .returning({ createdAt: users.totpPendingCreatedAt });
  return row?.createdAt ?? undefined;
}

/**
 * `true` bila rahasia pendaftaran masih berlaku (jam database): ditampilkan terakhir kurang dari
 * `pendingMinutes` lalu, DAN pertama kali dibuat kurang dari `maxMinutes` lalu (batas mutlak —
 * rahasia yang sama tidak bisa dipakai ulang tanpa batas dengan terus menampilkannya ulang).
 */
export async function isPendingSecretFresh(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  pendingMinutes: number,
  maxMinutes: number,
): Promise<boolean> {
  const [row] = await db
    .select({
      fresh: sql<boolean>`${users.totpPendingCreatedAt} > now() - make_interval(mins => ${pendingMinutes}) and ${users.totpPendingIssuedAt} > now() - make_interval(mins => ${maxMinutes})`,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return row?.fresh === true;
}

/**
 * Mengaktifkan 2FA: rahasia pendaftaran yang SAMA dengan yang diperiksa (`expectedPending`)
 * dipindah menjadi rahasia aktif. Bersyarat supaya dua konfirmasi bersamaan, atau konfirmasi
 * setelah pendaftaran dimulai ulang, tidak bisa mengaktifkan rahasia yang salah.
 */
export async function activateTotp(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    expectedPending: string;
    secretEncrypted: string;
    usedStep: number;
  },
): Promise<Date | undefined> {
  const [row] = await db
    .update(users)
    .set({
      totpSecretEncrypted: input.secretEncrypted,
      totpEnabledAt: sql`now()`,
      totpLastUsedStep: input.usedStep,
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
      totpPendingIssuedAt: null,
      // Sudah mendaftar: batas waktu pendaftaran (review undangan R3) tidak berlaku lagi.
      twoFactorEnrollmentDueAt: null,
    })
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        eq(users.id, input.userId),
        isNull(users.totpEnabledAt),
        eq(users.totpPendingSecretEncrypted, input.expectedPending),
      ),
    )
    .returning({ enabledAt: users.totpEnabledAt });
  return row?.enabledAt ?? undefined;
}

/** Mematikan 2FA dan membuang rahasia (aktif maupun pendaftaran). `true` bila tadinya aktif. */
export async function deactivateTotp(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({
      totpSecretEncrypted: null,
      totpEnabledAt: null,
      totpLastUsedStep: null,
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
      totpPendingIssuedAt: null,
    })
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, userId),
        sql`${users.totpEnabledAt} is not null`,
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Mencatat langkah TOTP yang baru dipakai — HANYA bila lebih baru dari yang tersimpan. `false` =
 * langkah itu (atau yang lebih baru) sudah pernah dipakai: kode diputar ulang (replay), termasuk
 * dua permintaan bersamaan dengan kode yang sama.
 */
export async function claimTotpStep(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  step: number,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ totpLastUsedStep: step })
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.id, userId),
        sql`${users.totpEnabledAt} is not null`,
        or(isNull(users.totpLastUsedStep), lt(users.totpLastUsedStep, step)),
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * IP + user agent yang tercatat saat sesi dibuat. Dipakai pendaftaran 2FA: rahasia tertunda hanya
 * dipakai ulang bila permintaan datang dari peramban + jaringan yang sama (review 2FA R7).
 */
export async function findSessionClient(
  db: DbExecutor,
  organizationId: string,
  sessionId: string,
): Promise<ClientInfo | undefined> {
  const [row] = await db
    .select({ ip: userSessions.ipAddress, userAgent: userSessions.userAgent })
    .from(userSessions)
    .where(and(eq(userSessions.organizationId, organizationId), eq(userSessions.id, sessionId)))
    .limit(1);
  return row;
}

/**
 * Pengelola tim aktif LAIN di organisasi (`team.manage`: Owner/Admin) — penerima pemberitahuan
 * 2FA peran wajib.
 */
export async function findOtherAdministrators(
  db: DbExecutor,
  organizationId: string,
  exceptUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        ne(users.id, exceptUserId),
        isNull(users.disabledAt),
        inArray(users.role, rolesWithPermission('team.manage')),
      ),
    );
  return rows.map((row) => row.id);
}

/** Nama yang tampil sebagai penerbit di aplikasi autentikator: nama produk, atau nama organisasi. */
export async function findTotpIssuer(
  db: DbExecutor,
  organizationId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ productName: organizations.productName, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ? (row.productName ?? row.name) : undefined;
}

// ── Kode cadangan ───────────────────────────────────────────────────────────

export interface StoredBackupCode {
  id: string;
  codeHash: string;
}

export async function unusedBackupCodes(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<StoredBackupCode[]> {
  return db
    .select({ id: userBackupCodes.id, codeHash: userBackupCodes.codeHash })
    .from(userBackupCodes)
    .where(
      and(
        eq(userBackupCodes.organizationId, organizationId),
        eq(userBackupCodes.userId, userId),
        isNull(userBackupCodes.usedAt),
      ),
    )
    .orderBy(userBackupCodes.id);
}

/** Menandai satu kode terpakai, bersyarat belum dipakai. `false` = sudah dipakai permintaan lain. */
export async function markBackupCodeUsed(
  db: DbExecutor,
  organizationId: string,
  codeId: string,
): Promise<boolean> {
  const rows = await db
    .update(userBackupCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.organizationId, organizationId),
        eq(userBackupCodes.id, codeId),
        isNull(userBackupCodes.usedAt),
      ),
    )
    .returning({ id: userBackupCodes.id });
  return rows.length > 0;
}

export interface BackupCodeSummary {
  remaining: number;
  generatedAt: Date | null;
}

export async function backupCodeSummary(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<BackupCodeSummary> {
  const [row] = await db
    .select({
      remaining: sql<number>`count(*) filter (where ${userBackupCodes.usedAt} is null)::int`,
      generatedAt: max(userBackupCodes.createdAt),
    })
    .from(userBackupCodes)
    .where(
      and(eq(userBackupCodes.organizationId, organizationId), eq(userBackupCodes.userId, userId)),
    );
  return { remaining: row?.remaining ?? 0, generatedAt: row?.generatedAt ?? null };
}

/** Membuang semua kode lama pengguna lalu menyimpan hash kode baru (dalam transaksi pemanggil). */
export async function replaceBackupCodes(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  hashes: readonly string[],
): Promise<Date> {
  await deleteBackupCodes(db, organizationId, userId);
  const rows = await db
    .insert(userBackupCodes)
    .values(hashes.map((codeHash) => ({ organizationId, userId, codeHash })))
    .returning({ createdAt: userBackupCodes.createdAt });
  const createdAt = rows[0]?.createdAt;
  if (!createdAt) throw new Error('Kode cadangan tidak tersimpan');
  return createdAt;
}

export async function deleteBackupCodes(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(userBackupCodes)
    .where(
      and(eq(userBackupCodes.organizationId, organizationId), eq(userBackupCodes.userId, userId)),
    );
}

// ── Tantangan langkah kedua ─────────────────────────────────────────────────

export async function insertChallenge(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    tokenHash: string;
    bindingHash: string;
    client: ClientInfo;
    lifetimeMinutes: number;
  },
): Promise<{ id: string; expiresAt: Date }> {
  // Tantangan basi pengguna ini sekalian dibersihkan supaya tabelnya tidak terus membesar.
  await db
    .delete(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.organizationId, input.organizationId),
        eq(twoFactorChallenges.userId, input.userId),
        sql`${twoFactorChallenges.expiresAt} < now() - interval '1 day'`,
      ),
    );
  const [row] = await db
    .insert(twoFactorChallenges)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      bindingHash: input.bindingHash,
      ipAddress: input.client.ip,
      expiresAt: sql`now() + make_interval(mins => ${input.lifetimeMinutes})`,
    })
    .returning({ id: twoFactorChallenges.id, expiresAt: twoFactorChallenges.expiresAt });
  if (!row) throw new Error('Tantangan 2FA tidak tersimpan');
  return row;
}

export interface ChallengeWithUser {
  id: string;
  organizationId: string;
  bindingHash: string;
  failedAttempts: number;
  /** Belum dipakai, belum kedaluwarsa (jam database). */
  usable: boolean;
  user: TwoFactorUser;
  organization: { id: string; name: string; timezone: string };
}

/** Tantangan untuk hash token ini beserta pengguna dan organisasinya. */
export async function findChallenge(
  db: DbExecutor,
  tokenHash: string,
): Promise<ChallengeWithUser | undefined> {
  const [row] = await db
    .select({
      id: twoFactorChallenges.id,
      organizationId: twoFactorChallenges.organizationId,
      bindingHash: twoFactorChallenges.bindingHash,
      failedAttempts: twoFactorChallenges.failedAttempts,
      usable: sql<boolean>`${twoFactorChallenges.usedAt} is null and ${twoFactorChallenges.expiresAt} > now()`,
      user: twoFactorUserColumns,
      organizationName: organizations.name,
      organizationTimezone: organizations.timezone,
    })
    .from(twoFactorChallenges)
    .innerJoin(
      users,
      and(
        eq(users.organizationId, twoFactorChallenges.organizationId),
        eq(users.id, twoFactorChallenges.userId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, twoFactorChallenges.organizationId))
    .where(eq(twoFactorChallenges.tokenHash, tokenHash))
    .limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    organizationId: row.organizationId,
    bindingHash: row.bindingHash,
    failedAttempts: row.failedAttempts,
    usable: row.usable,
    user: row.user,
    organization: {
      id: row.organizationId,
      name: row.organizationName,
      timezone: row.organizationTimezone,
    },
  };
}

/**
 * Mengambil satu jatah percobaan dari tantangan secara atomik: hanya berhasil selama tantangan
 * belum dipakai, belum kedaluwarsa, dan jatahnya belum habis. Mengembalikan jumlah percobaan
 * SETELAH ditambah, atau `undefined` bila tantangan sudah tidak bisa dipakai.
 */
export async function claimChallengeAttempt(
  db: DbExecutor,
  organizationId: string,
  challengeId: string,
  maxAttempts: number,
): Promise<number | undefined> {
  const [row] = await db
    .update(twoFactorChallenges)
    .set({ failedAttempts: sql`${twoFactorChallenges.failedAttempts} + 1` })
    .where(
      and(
        eq(twoFactorChallenges.organizationId, organizationId),
        eq(twoFactorChallenges.id, challengeId),
        isNull(twoFactorChallenges.usedAt),
        sql`${twoFactorChallenges.expiresAt} > now()`,
        lt(twoFactorChallenges.failedAttempts, maxAttempts),
      ),
    )
    .returning({ failedAttempts: twoFactorChallenges.failedAttempts });
  return row?.failedAttempts;
}

/** Menandai tantangan selesai/hangus. `false` = sudah dipakai permintaan lain. */
export async function closeChallenge(
  db: DbExecutor,
  organizationId: string,
  challengeId: string,
): Promise<boolean> {
  const rows = await db
    .update(twoFactorChallenges)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(twoFactorChallenges.organizationId, organizationId),
        eq(twoFactorChallenges.id, challengeId),
        isNull(twoFactorChallenges.usedAt),
      ),
    )
    .returning({ id: twoFactorChallenges.id });
  return rows.length > 0;
}

/** Membuang semua tantangan pengguna (mis. saat 2FA dinonaktifkan). */
export async function deleteChallenges(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.organizationId, organizationId),
        eq(twoFactorChallenges.userId, userId),
      ),
    );
}
