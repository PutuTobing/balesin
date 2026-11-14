/**
 * Review keamanan Fase 1 butir 3 (2FA), putaran 2 — rahasia tertunda dipakai ulang per sesi
 * (commit 3ae444e). Laporan: docs/security-reviews/2026-11-14-fase1-2fa.md bagian "Putaran 2".
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka. Putaran ini tidak menemukan celah yang perlu
 * `it.fails`; semua tes di bawah adalah penjaga regresi.
 */
import { createSecretBox, generateTotp, Secret } from '@balesin/core';
import { userSessions, users, type User } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  errorEnvelopeSchema,
  startTwoFactorEnrollmentResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  login,
  OWNER,
  sessionCookieOf,
  startLogin,
  TEST_MASTER_KEY,
  type CallOptions,
  type IntegrationHarness,
} from './testing/integration';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const PENDING_PURPOSE = 'users.totp_pending_secret';

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

type Response = Awaited<ReturnType<typeof call>>;

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const routes = API_ROUTES.twoFactor;

async function addUser(organizationId: string, role: UserRole, password: string) {
  return insertUser(harness.db, organizationId, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
  } satisfies Partial<User>);
}

const enroll = (body: object, as: CallOptions) =>
  call(harness.app, 'POST', routes.enroll, body, as);
const secretOf = (response: Response) =>
  startTwoFactorEnrollmentResponseSchema.parse(response.json()).secret;

/** Sesi terbatas "wajib mendaftar" untuk peran wajib 2FA lewat login password. */
async function enrollmentSession(email: string, password: string) {
  const { response, body } = await startLogin(harness.app, { email, password });
  if (body.status !== 'two_factor_enrollment_required') throw new Error(body.status);
  return { cookie: sessionCookieOf(response), csrf: body.csrfToken };
}

async function activeSessionRef(userId: string): Promise<string> {
  const [row] = await harness.db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  if (!row) throw new Error('Tidak ada sesi aktif');
  return row.id;
}

/** Jauh dari batas langkah 30 detik supaya kode yang dibuat tes masih berlaku saat diperiksa. */
async function awayFromStepBoundary() {
  const intoStep = (Date.now() / 1000) % 30;
  if (intoStep > 27) await new Promise((resolve) => setTimeout(resolve, (30 - intoStep) * 1000));
}

describe('putaran 2: rahasia tertunda dipakai ulang hanya oleh sesi yang memulainya', () => {
  it('sesi biasa: setiap muat ulang tetap wajib password — pemanjangan rahasia butuh password', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-putaran-dua-01';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const mine = await login(harness.app, { email: cs.email, password });
    const as = { cookie: mine.cookie, csrf: mine.csrf };

    const first = await enroll({ password }, as);
    expect(first.statusCode).toBe(200);
    const pendingSince = async () =>
      (await harness.db.select().from(users).where(eq(users.id, cs.id)))[0]?.totpPendingCreatedAt;
    await harness.db
      .update(users)
      .set({ totpPendingCreatedAt: sql`now() - interval '10 minutes'` })
      .where(eq(users.id, cs.id));
    const before = await pendingSince();

    // Pemegang cookie curian (tanpa password) tidak bisa membaca ulang atau memperpanjang.
    const withoutPassword = await enroll({}, as);
    expect(withoutPassword.statusCode).toBe(400);
    expect((errorOf(withoutPassword).details ?? []).map((detail) => detail.field)).toContain(
      'password',
    );
    expect(withoutPassword.body).not.toContain(secretOf(first));
    const wrongPassword = await enroll({ password: 'bukan-sandinya-sama-sekali' }, as);
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.body).not.toContain(secretOf(first));
    // Percobaan tanpa/dengan password salah tidak menggeser masa berlaku.
    expect(await pendingSince()).toEqual(before);

    const again = await enroll({ password }, as);
    expect(again.statusCode).toBe(200);
    expect(secretOf(again)).toBe(secretOf(first));
  });

  it('batas mutlak = umur sesi pendaftaran (30 menit): sesi kedaluwarsa tidak bisa memperpanjang, sesi baru dapat rahasia baru', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = await enroll({}, as);
    expect(first.statusCode).toBe(200);

    // Sesi pendaftaran melewati batas mutlaknya (dibuat 30 menit lalu).
    await harness.db
      .update(userSessions)
      .set({
        idleExpiresAt: sql`now() - interval '1 second'`,
        absoluteExpiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(userSessions.userId, owner.session.user.id));
    const stale = await enroll({}, as);
    expect(stale.statusCode).toBe(401);

    // Rahasia tertunda masih "segar" di baris pengguna, tetapi sesi baru tidak bisa membukanya.
    const next = await enrollmentSession(owner.session.user.email, OWNER.password);
    const fresh = await enroll({}, next);
    expect(fresh.statusCode).toBe(200);
    expect(secretOf(fresh)).not.toBe(secretOf(first));
    await awayFromStepBoundary();
    const withOld = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(secretOf(first)) },
      next,
    );
    expect(withOld.statusCode).toBe(400);
  });

  it('setelah keluar: sesi berikutnya tidak mewarisi rahasia sesi yang sudah dicabut', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = secretOf(await enroll({}, as));
    const out = await call(harness.app, 'POST', API_ROUTES.auth.logout, {}, as);
    expect(out.statusCode).toBe(200);
    expect((await enroll({}, as)).statusCode).toBe(401);

    const next = await enrollmentSession(owner.session.user.email, OWNER.password);
    expect(secretOf(await enroll({}, next))).not.toBe(first);
  });

  it('AAD mengikat pengguna DAN sesi: teks sandi dengan ID pengguna lain, format lama, atau tujuan lain tidak dipakai ulang', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-admin-putaran-dua-02';
    const admin = await addUser(owner.session.organization.id, 'admin', password);
    const as = await enrollmentSession(admin.email, password);
    const sessionRef = await activeSessionRef(admin.id);
    const organizationId = owner.session.organization.id;
    const planted = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    const plant = async (purpose: string, subjectId: string) => {
      await harness.db
        .update(users)
        .set({
          totpPendingSecretEncrypted: box.encrypt(planted, { organizationId, purpose, subjectId }),
          totpPendingCreatedAt: sql`now()`,
        })
        .where(eq(users.id, admin.id));
      return secretOf(await enroll({}, as));
    };

    // Kontrol positif: konteks yang benar memang dipakai ulang.
    expect(await plant(PENDING_PURPOSE, `${admin.id}|sesi:${sessionRef}`)).toBe(planted);
    // Sesi sama, pengguna lain (Owner) → tidak bisa dibuka.
    expect(await plant(PENDING_PURPOSE, `${owner.session.user.id}|sesi:${sessionRef}`)).not.toBe(
      planted,
    );
    // Format sebelum 3ae444e (tanpa sesi) → tidak bisa dibuka.
    expect(await plant(PENDING_PURPOSE, admin.id)).not.toBe(planted);
    // Rahasia AKTIF yang dipindah ke kolom tertunda (tujuan lain, kunci turunan lain).
    expect(await plant('users.totp_secret', `${admin.id}|sesi:${sessionRef}`)).not.toBe(planted);

    // Konfirmasi dengan rahasia tanaman dari konteks salah: tidak pernah aktif.
    await plant(PENDING_PURPOSE, `${owner.session.user.id}|sesi:${sessionRef}`);
    await awayFromStepBoundary();
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(planted) },
      as,
    );
    expect(confirm.statusCode).toBe(400);
    const [row] = await harness.db.select().from(users).where(eq(users.id, admin.id));
    expect(row?.totpEnabledAt).toBeNull();
  });

  it('mulai/konfirmasi pendaftaran tetap wajib CSRF dan Origin', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const noCsrf = await enroll({}, { cookie: owner.cookie });
    expect(noCsrf.statusCode).toBe(403);
    const foreignOrigin = await enroll(
      {},
      { cookie: owner.cookie, csrf: owner.csrf, origin: 'https://jahat.example' },
    );
    expect(foreignOrigin.statusCode).toBe(403);
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: '123456' },
      { cookie: owner.cookie },
    );
    expect(confirm.statusCode).toBe(403);
    const [row] = await harness.db.select().from(users).where(eq(users.id, owner.session.user.id));
    expect(row?.totpPendingSecretEncrypted).toBeNull();
  });

  it('pesan 429 tanpa durasi tetap membawa Retry-After dan tidak membedakan akun yang ada/tidak', async () => {
    await completeSetup(harness.app);
    const ip = { ip: '198.51.100.90' };
    let last: Response | undefined;
    for (let index = 0; index < 40; index += 1) {
      last = await call(
        harness.app,
        'POST',
        API_ROUTES.auth.login,
        { email: `tidak-ada-${index}@majujaya.test`, password: 'sandi-ngawur-sekali' },
        ip,
      );
      if (last.statusCode === 429) break;
    }
    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
    expect(errorOf(last as Response).message).toBe(
      'Terlalu banyak percobaan masuk dari jaringanmu.',
    );
  });
});
