/**
 * Pemulihan Owner dari server (`balesin reset-owner-password`, Fase 7) di atas Postgres + Redis
 * sungguhan: aturan password sama dengan web, semua sesi dicabut, 2FA tetap berlaku, tercatat di
 * audit log, dan tidak menyentuh Owner lain/organisasi lain.
 */
import { auditLogs, userSessions, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES } from '@balesin/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  OWNER,
  startLogin,
  type IntegrationHarness,
} from '../testing/integration';
import { createPasswordHasher } from '../modules/auth/password-hasher';
import { OwnerRecoveryError, resetOwnerPassword } from './owner-recovery';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();
const NEW_PASSWORD = 'pelita-kemarau-sungai-biru';

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

describe('resetOwnerPassword', () => {
  it('menolak bila setup belum selesai', async () => {
    await expect(
      resetOwnerPassword({ db: harness.db, hasher }, { password: NEW_PASSWORD }),
    ).rejects.toThrow(/Wizard setup belum diselesaikan/);
  });

  it('mengganti password, mencabut semua sesi, mencatat audit, 2FA tetap berlaku', async () => {
    const signed = await completeSetup(harness.app);
    const before = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: signed.cookie,
    });
    expect(before.statusCode).toBe(200);

    const result = await resetOwnerPassword(
      { db: harness.db, hasher, redis: harness.redis, redisPrefix: harness.redisPrefix },
      { password: NEW_PASSWORD },
    );
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(result.twoFactorEnabled).toBe(true);
    expect(result.maskedEmail).toBe('s***@majujaya.test');

    // Sesi lama tidak berlaku lagi.
    const after = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: signed.cookie,
    });
    expect(after.statusCode).toBe(401);
    const live = await harness.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(isNull(userSessions.revokedAt));
    expect(live).toHaveLength(0);

    // Password lama ditolak; password baru diterima dan tetap meminta langkah kedua (2FA).
    const old = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: OWNER.email,
      password: OWNER.password,
    });
    expect(old.statusCode).toBe(401);
    const { body } = await startLogin(harness.app, { email: OWNER.email, password: NEW_PASSWORD });
    expect(body.status).toBe('two_factor_required');
    await login(harness.app, { email: OWNER.email, password: NEW_PASSWORD });

    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, result.auditLogId));
    expect(audit).toMatchObject({
      action: 'auth.password_reset.completed',
      actorUserId: null,
      targetType: 'user',
      targetId: result.userId,
      metadata: { via: 'cli', revokedSessions: result.revokedSessions },
      userAgent: 'balesin-cli reset-owner-password',
    });
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('menolak password lemah atau memuat data pribadi, tanpa mengubah apa pun', async () => {
    await completeSetup(harness.app);
    const [original] = await harness.db.select({ hash: users.passwordHash }).from(users);

    for (const weak of ['pendek', 'password123', 'sari wulandari 2026 maju']) {
      await expect(
        resetOwnerPassword({ db: harness.db, hasher }, { password: weak }),
      ).rejects.toBeInstanceOf(OwnerRecoveryError);
    }
    const [current] = await harness.db.select({ hash: users.passwordHash }).from(users);
    expect(current?.hash).toBe(original?.hash);
  });

  it('hanya untuk Owner: email non-Owner ditolak, banyak Owner wajib menyebut email', async () => {
    await completeSetup(harness.app);
    const [owner] = await harness.db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.role, 'owner'));
    if (!owner) throw new Error('Owner tidak ada');
    await insertUser(harness.db, owner.organizationId, {
      email: 'admin@majujaya.test',
      role: 'admin',
    });

    await expect(
      resetOwnerPassword(
        { db: harness.db, hasher },
        { email: 'admin@majujaya.test', password: NEW_PASSWORD },
      ),
    ).rejects.toThrow(/bukan Owner aktif/);

    await insertUser(harness.db, owner.organizationId, {
      email: 'owner2@majujaya.test',
      role: 'owner',
    });
    await expect(
      resetOwnerPassword({ db: harness.db, hasher }, { password: NEW_PASSWORD }),
    ).rejects.toThrow(/Sebutkan emailnya/);

    const result = await resetOwnerPassword(
      { db: harness.db, hasher },
      { email: ' Owner2@MajuJaya.test ', password: NEW_PASSWORD },
    );
    const [target] = await harness.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, result.userId), eq(users.role, 'owner')));
    expect(target?.email).toBe('owner2@majujaya.test');
  });
});
