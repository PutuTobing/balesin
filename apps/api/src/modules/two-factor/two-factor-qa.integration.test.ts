/**
 * Tambahan QA untuk 2FA (ROADMAP Fase 1 butir 3): perilaku kontrak `docs/KONTRAK-API-AUTH.md`
 * bagian 2FA yang belum dijaga `two-factor.integration.test.ts` — 409 saat keadaan 2FA tidak
 * sesuai, kode berformat salah tidak mengurangi percobaan, kode cadangan habis, batas mulai/
 * konfirmasi pendaftaran, dan sesi terbatas yang kedaluwarsa.
 */
import { generateTotp } from '@balesin/core';
import { userBackupCodes, userSessions, users, type User } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  errorEnvelopeSchema,
  twoFactorChallengeResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  enrollTwoFactor,
  login,
  OWNER,
  sessionCookieOf,
  startLogin,
  type IntegrationHarness,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

const routes = API_ROUTES.twoFactor;
type Response = Awaited<ReturnType<typeof call>>;

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

async function addUser(
  organizationId: string,
  role: UserRole,
  password: string,
  overrides: Partial<User> = {},
) {
  return insertUser(harness.db, organizationId, {
    role,
    email: `${role}-qa-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
    ...overrides,
  });
}

/** Kode 6 digit yang pasti salah sekarang (bukan kode langkah −1, 0, +1). */
function wrongCode(secret: string): string {
  const valid = new Set(
    [-1, 0, 1].map((drift) => generateTotp(secret, Date.now() + drift * 30_000)),
  );
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

async function challengeFor(credentials: { email: string; password: string } = OWNER) {
  const { body } = await startLogin(harness.app, credentials);
  if (body.status !== 'two_factor_required') throw new Error(`Bukan tantangan: ${body.status}`);
  return twoFactorChallengeResponseSchema.parse(body);
}

describe('keadaan 2FA tidak sesuai → 409', () => {
  it('CS tanpa 2FA: buat ulang kode cadangan dan nonaktifkan → 409', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-tanpa-2fa-qa';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const session = await login(harness.app, { email: cs.email, password });
    const as = { cookie: session.cookie, csrf: session.csrf };

    const regenerate = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      { password, code: '123456' },
      as,
    );
    expect(regenerate.statusCode).toBe(409);
    const disable = await call(
      harness.app,
      'POST',
      routes.disable,
      { password, code: '123456' },
      as,
    );
    expect(disable.statusCode).toBe(409);
  });

  it('mulai mendaftar saat 2FA sudah aktif → 409; konfirmasi tanpa pendaftaran berjalan → 409', async () => {
    const owner = await completeSetup(harness.app);
    const again = await call(
      harness.app,
      'POST',
      routes.enroll,
      { password: OWNER.password },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(again.statusCode).toBe(409);

    const password = 'sandi-teknisi-qa-2fa';
    const teknisi = await addUser(owner.session.organization.id, 'teknisi', password);
    const session = await login(harness.app, { email: teknisi.email, password });
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: '123456' },
      { cookie: session.cookie, csrf: session.csrf },
    );
    expect(confirm.statusCode).toBe(409);
    expect(errorOf(confirm).message).toMatch(/Mulai lagi/);
  });
});

describe('langkah kedua saat masuk', () => {
  it('kode berformat salah → 400 tanpa mengurangi sisa percobaan tantangan', async () => {
    const owner = await completeSetup(harness.app);
    const challenge = await challengeFor();

    for (const code of ['abc', '12345', '1234567', 'kode-cadangan-yang-kepanjangan']) {
      const response = await call(harness.app, 'POST', routes.verify, {
        challengeToken: challenge.challengeToken,
        code,
      });
      expect(response.statusCode, code).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }

    // Kode 6 digit yang salah: masih "Sisa 2 percobaan" (format salah tadi tidak dihitung).
    const wrong = await call(harness.app, 'POST', routes.verify, {
      challengeToken: challenge.challengeToken,
      code: wrongCode(owner.totpSecret),
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).message).toContain('Sisa 2 percobaan.');
  });

  it('kode cadangan habis → tantangan hanya menawarkan TOTP; kode cadangan lama ditolak', async () => {
    const owner = await completeSetup(harness.app);
    await harness.db
      .update(userBackupCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(userBackupCodes.userId, owner.session.user.id));

    const challenge = await challengeFor();
    expect(challenge.methods).toEqual(['totp']);
    const response = await call(harness.app, 'POST', routes.verify, {
      challengeToken: challenge.challengeToken,
      code: owner.backupCodes[0] ?? '',
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('code');
  });
});

describe('pendaftaran', () => {
  it('mulai/konfirmasi pendaftaran dibatasi 10× per 15 menit per pengguna → 429 + Retry-After', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-admin-qa-batas';
    const admin = await addUser(owner.session.organization.id, 'admin', password);
    const { response, body } = await startLogin(harness.app, { email: admin.email, password });
    expect(body.status).toBe('two_factor_enrollment_required');
    if (body.status !== 'two_factor_enrollment_required') return;
    const as = { cookie: sessionCookieOf(response), csrf: body.csrfToken };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await call(harness.app, 'POST', routes.enroll, {}, as)).statusCode);
      statuses.push(
        (await call(harness.app, 'POST', routes.confirmEnrollment, { code: '000000' }, as))
          .statusCode,
      );
    }
    // Kode salah saat mendaftar → 400 (bisa saja '000000' kebetulan benar: sangat kecil).
    expect(statuses).toEqual([200, 400, 200, 400, 200, 400, 200, 400, 200, 400]);

    const blocked = await call(harness.app, 'POST', routes.enroll, {}, as);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Kode salah saat mendaftar tidak mengunci langkah kedua akun (bukan ember yang sama).
    const [row] = await harness.db.select().from(users).where(eq(users.id, admin.id));
    expect(row?.totpEnabledAt).toBeNull();
  });

  it('sesi terbatas yang sudah lewat 30 menit → 401, tidak bisa mendaftar', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-supervisor-qa-30';
    const supervisor = await addUser(owner.session.organization.id, 'supervisor', password);
    const { response, body } = await startLogin(harness.app, {
      email: supervisor.email,
      password,
    });
    if (body.status !== 'two_factor_enrollment_required') throw new Error(body.status);
    await harness.db
      .update(userSessions)
      .set({
        idleExpiresAt: sql`now() - interval '1 second'`,
        absoluteExpiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(userSessions.userId, supervisor.id));

    const start = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      { cookie: sessionCookieOf(response), csrf: body.csrfToken },
    );
    expect(start.statusCode).toBe(401);
    expect(errorOf(start).code).toBe('UNAUTHENTICATED');
  });

  it('CS mendaftar dari sesi penuh lalu login berikutnya butuh langkah kedua (sesi lama dicabut)', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-qa-aktif';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const session = await login(harness.app, { email: cs.email, password });
    const enrolled = await enrollTwoFactor(harness.app, session, { password });
    expect(enrolled.backupCodes).toHaveLength(10);
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: session.cookie,
    });
    expect(me.statusCode).toBe(401);
    const challenge = await challengeFor({ email: cs.email, password });
    expect(challenge.methods).toEqual(['totp', 'backup_code']);
  });
});
