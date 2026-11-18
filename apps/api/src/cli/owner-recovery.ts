import { type Redis } from '@balesin/core';
import { users, type Database } from '@balesin/db';
import { DEFAULT_PRODUCT_NAME, normalizeEmail } from '@balesin/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { createRateLimiter } from '../http/rate-limit';
import { AUDIT_ACTIONS, maskEmail, recordAudit } from '../modules/audit/audit';
import {
  ACCOUNT_LOCK_FLAG,
  LOGIN_ACCOUNT_RULE,
  loginAccountKey,
} from '../modules/auth/login-rules';
import type { PasswordHasher } from '../modules/auth/password-hasher';
import { checkPassword } from '../modules/auth/password-policy';
import { revokeUserSessions } from '../modules/auth/session.repo';
import { findInstallationOrganization } from '../modules/installation/installation.repo';
import { deleteChallenges } from '../modules/two-factor/two-factor.repo';

/**
 * Pemulihan Owner dari server (`balesin reset-owner-password`) — untuk Owner yang lupa password
 * saat email pengirim (SMTP) belum/tidak bisa dipakai, sehingga tautan atur ulang tidak bisa sampai.
 *
 * Siapa pun yang bisa menjalankan perintah ini sudah memegang server (akses root/Docker), jadi ini
 * tidak membuka jalan baru bagi penyerang; tetap saja:
 *  - password baru wajib lolos aturan yang sama dengan web (panjang, bukan password umum, bukan
 *    nama/email/organisasi);
 *  - semua sesi Owner dicabut, tantangan 2FA yang menggantung dibuang, kunci login dilepas;
 *  - 2FA TIDAK dimatikan — Owner tetap memakai aplikasi autentikator atau kode cadangannya;
 *  - tercatat di audit log (`auth.password_reset.completed`, metadata `via: "cli"`).
 */

export class OwnerRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerRecoveryError';
  }
}

export interface OwnerRecoveryInput {
  /** Email Owner. Boleh kosong bila instalasi hanya punya satu Owner aktif. */
  email?: string;
  password: string;
}

export interface OwnerRecoveryResult {
  userId: string;
  /** Email tersamar untuk ditampilkan (mis. `s***@contoh.co.id`). */
  maskedEmail: string;
  revokedSessions: number;
  twoFactorEnabled: boolean;
  auditLogId: string;
}

export interface OwnerRecoveryDeps {
  db: Database;
  hasher: Pick<PasswordHasher, 'hash'>;
  /** Opsional: melepas kunci login per akun di Redis (gagal = hanya diabaikan). */
  redis?: Redis;
  /** Awalan kunci Redis batas laju (sama dengan api, bawaan `balesin`). */
  redisPrefix?: string;
}

/** Owner aktif organisasi milik instalasi, urut dari yang paling lama. */
async function activeOwners(db: Database, organizationId: string) {
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(users.createdAt));
}

export async function resetOwnerPassword(
  deps: OwnerRecoveryDeps,
  input: OwnerRecoveryInput,
): Promise<OwnerRecoveryResult> {
  const { db } = deps;
  const organization = await findInstallationOrganization(db);
  if (!organization) {
    throw new OwnerRecoveryError(
      'Wizard setup belum diselesaikan: belum ada Owner. Buka wizard setup di browser dengan token setup.',
    );
  }

  const owners = await activeOwners(db, organization.id);
  if (owners.length === 0) {
    throw new OwnerRecoveryError('Tidak ada Owner aktif di instalasi ini.');
  }

  let owner: (typeof owners)[number] | undefined;
  if (input.email?.trim()) {
    const wanted = normalizeEmail(input.email);
    owner = owners.find((candidate) => candidate.email === wanted);
    if (!owner) {
      throw new OwnerRecoveryError(
        `Email itu bukan Owner aktif. Owner aktif: ${owners.map((row) => maskEmail(row.email)).join(', ')}.`,
      );
    }
  } else if (owners.length === 1) {
    owner = owners[0];
  } else {
    throw new OwnerRecoveryError(
      `Ada ${String(owners.length)} Owner aktif (${owners.map((row) => maskEmail(row.email)).join(', ')}). Sebutkan emailnya: balesin reset-owner-password <email>.`,
    );
  }
  if (!owner) throw new OwnerRecoveryError('Owner tidak ditemukan.');

  const verdict = checkPassword(input.password, {
    email: owner.email,
    name: owner.name,
    organizationName: organization.name,
    productName: organization.productName ?? DEFAULT_PRODUCT_NAME,
  });
  if (!verdict.acceptable) throw new OwnerRecoveryError(verdict.message);

  const passwordHash = await deps.hasher.hash(input.password);
  const target = owner;
  const { revoked, auditLogId } = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: sql`now()`, lockedUntil: null })
      .where(and(eq(users.organizationId, organization.id), eq(users.id, target.id)));
    const revokedIds = await revokeUserSessions(tx, organization.id, target.id);
    await deleteChallenges(tx, organization.id, target.id);
    const auditId = await recordAudit(tx, {
      organizationId: organization.id,
      // Dijalankan operator server, bukan sesi Owner — pelaku tidak dikenal sebagai pengguna.
      actorUserId: null,
      action: AUDIT_ACTIONS.passwordResetCompleted,
      targetType: 'user',
      targetId: target.id,
      metadata: { via: 'cli', revokedSessions: revokedIds.length },
      client: { ip: null, userAgent: 'balesin-cli reset-owner-password' },
    });
    return { revoked: revokedIds.length, auditLogId: auditId };
  });

  if (deps.redis) {
    // Kunci "per akun" karena tebakan password lama. Kunci per asal (IP) habis sendiri ≤ 15 menit.
    const limiter = createRateLimiter(deps.redis, { prefix: deps.redisPrefix ?? 'balesin' });
    const key = loginAccountKey(owner.email);
    try {
      await limiter.clearFlag(ACCOUNT_LOCK_FLAG, key);
      await limiter.reset(LOGIN_ACCOUNT_RULE, key);
    } catch {
      // Redis bermasalah: paling lama Owner menunggu kunci 15 menit habis.
    }
  }

  return {
    userId: owner.id,
    maskedEmail: maskEmail(owner.email),
    revokedSessions: revoked,
    twoFactorEnabled: owner.totpEnabledAt !== null,
    auditLogId,
  };
}
