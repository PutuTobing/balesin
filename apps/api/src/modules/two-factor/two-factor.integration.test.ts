/**
 * Verifikasi dua langkah (SECURITY.md §1) di atas Postgres + Redis sungguhan: wajib daftar untuk
 * Owner/Admin/Supervisor, login dua langkah dengan tantangan sekali pakai, kode cadangan,
 * replay, batas percobaan/kunci, dan pengelolaan oleh pengguna sendiri.
 *
 * Tes di sini sengaja TIDAK memakai `freshTotpCode` untuk kasus replay: perilaku "kode yang sama
 * tidak bisa dipakai dua kali" diuji apa adanya.
 */
import { generateTotp, sha256Hex } from '@balesin/core';
import {
  auditLogs,
  twoFactorChallenges,
  userBackupCodes,
  userSessions,
  users,
  type User,
} from '@balesin/db';
import { insertUser, insertUserSession } from '@balesin/db/testing';
import {
  API_ROUTES,
  BACKUP_CODE_COUNT,
  authenticatedSessionSchema,
  confirmTwoFactorEnrollmentResponseSchema,
  errorEnvelopeSchema,
  meResponseSchema,
  regenerateBackupCodesResponseSchema,
  startTwoFactorEnrollmentResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorStatusResponseSchema,
  verifyTwoFactorResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  deviceCookieOf,
  enrollTwoFactor,
  freshTotpCode,
  login,
  OWNER,
  sessionCookieOf,
  setCookies,
  startLogin,
  type CallOptions,
  type IntegrationHarness,
  type SignedInWithTwoFactor,
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

type Response = Awaited<ReturnType<typeof call>>;

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const routes = API_ROUTES.twoFactor;

async function addUser(
  organizationId: string,
  role: UserRole,
  password: string,
  overrides: Partial<User> = {},
) {
  return insertUser(harness.db, organizationId, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
    ...overrides,
  });
}

const verify = (challengeToken: string, code: string, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.verify, { challengeToken, code }, options);

/** Langkah password untuk akun ber-2FA → tantangan. */
async function challengeFor(
  credentials: { email: string; password: string } = OWNER,
  options: CallOptions = {},
) {
  const { response, body } = await startLogin(harness.app, credentials, options);
  if (body.status !== 'two_factor_required') throw new Error(`Bukan tantangan: ${body.status}`);
  return { response, challenge: twoFactorChallengeResponseSchema.parse(body) };
}

async function auditRows(action?: string) {
  const rows = await harness.db.select().from(auditLogs).orderBy(auditLogs.createdAt);
  return action ? rows.filter((row) => row.action === action) : rows;
}

/** Menunggu bila langkah TOTP hampir berganti, supaya kode yang dihitung tes tidak basi di server. */
async function awayFromStepBoundary(): Promise<void> {
  const intoStep = Date.now() % 30_000;
  if (intoStep > 27_000) await new Promise((resolve) => setTimeout(resolve, 30_500 - intoStep));
}

/** Kode TOTP sungguhan untuk langkah berikutnya yang belum dipakai (tanpa membuka jalan replay). */
function codeAtOffset(secret: string, offsetSteps: number): string {
  return generateTotp(secret, Date.now() + offsetSteps * 30_000);
}

// ── Setup → Owner wajib mendaftar 2FA ───────────────────────────────────────

describe('setup → Owner wajib mendaftar 2FA sebelum memakai aplikasi', () => {
  it('sesi hasil setup terbatas: hanya status/daftar 2FA, siapa saya, dan keluar', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };

    expect(owner.session.status).toBe('two_factor_enrollment_required');
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as);
    expect(meResponseSchema.parse(me.json()).status).toBe('two_factor_enrollment_required');

    const status = await call(harness.app, 'GET', routes.status, undefined, as);
    expect(twoFactorStatusResponseSchema.parse(status.json())).toEqual({
      enabled: false,
      required: true,
      enabledAt: null,
      backupCodesRemaining: 0,
      backupCodesGeneratedAt: null,
      enrollmentPending: false,
    });

    // Rute aplikasi (termasuk yang khusus Owner) ditolak di server, apa pun metodenya.
    const blocked: Array<['GET' | 'PUT' | 'POST', string, unknown]> = [
      ['GET', API_ROUTES.settings.email, undefined],
      ['PUT', API_ROUTES.settings.email, {}],
      ['POST', API_ROUTES.settings.detectEmailHost, { emailAddress: 'cs@gmail.com' }],
      ['POST', routes.regenerateBackupCodes, { password: OWNER.password, code: '123456' }],
      ['POST', routes.disable, { password: OWNER.password, code: '123456' }],
    ];
    for (const [method, url, body] of blocked) {
      const response = await call(harness.app, method, url, body, as);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(response).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
    }
    // HEAD (otomatis dari GET) dan metode salah juga tidak membuka apa pun.
    expect(
      (await call(harness.app, 'HEAD', API_ROUTES.settings.email, undefined, as)).statusCode,
    ).toBe(403);

    // Keluar tetap bisa.
    const logout = await call(harness.app, 'POST', API_ROUTES.auth.logout, undefined, as);
    expect(logout.statusCode).toBe(200);
  });

  it('mendaftar: rahasia terenkripsi, URI otpauth berpenerbit organisasi, kode salah ditolak', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app, {
      branding: { productName: 'Balesin Maju Jaya' },
    });
    const as = { cookie: owner.cookie, csrf: owner.csrf };

    const start = await call(harness.app, 'POST', routes.enroll, {}, as);
    expect(start.statusCode).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    const enrollment = startTwoFactorEnrollmentResponseSchema.parse(start.json());
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollment.secretGrouped.replace(/ /g, '')).toBe(enrollment.secret);
    expect(enrollment.issuer).toBe('Balesin Maju Jaya');
    expect(enrollment.accountName).toBe(OWNER.email);
    expect(enrollment.otpauthUri).toBe(
      `otpauth://totp/Balesin%20Maju%20Jaya:sari%40majujaya.test?secret=${enrollment.secret}&issuer=Balesin%20Maju%20Jaya&algorithm=SHA1&digits=6&period=30`,
    );
    expect({ digits: enrollment.digits, period: enrollment.periodSeconds }).toEqual({
      digits: 6,
      period: 30,
    });

    // Disimpan terenkripsi (bukan rahasia polos), belum aktif.
    const [row] = await harness.db.select().from(users);
    expect(row?.totpPendingSecretEncrypted).toMatch(/^v1\./);
    expect(row?.totpPendingSecretEncrypted).not.toContain(enrollment.secret);
    expect(row?.totpEnabledAt).toBeNull();
    const pendingStatus = await call(harness.app, 'GET', routes.status, undefined, as);
    expect(twoFactorStatusResponseSchema.parse(pendingStatus.json()).enrollmentPending).toBe(true);

    const wrong = await call(harness.app, 'POST', routes.confirmEnrollment, { code: '000000' }, as);
    const malformed = await call(harness.app, 'POST', routes.confirmEnrollment, { code: '12' }, as);
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).details?.[0]).toMatchObject({ field: 'code' });
    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed).details?.[0]?.message).toBe(
      'Masukkan 6 digit kode dari aplikasi autentikatormu.',
    );
    expect((await auditRows('auth.2fa.failed'))[0]?.metadata).toMatchObject({
      usage: 'enrollment',
      reason: 'wrong_code',
    });

    // Rahasia tidak pernah masuk log atau audit.
    expect(harness.logs.text()).not.toContain(enrollment.secret);
    expect(JSON.stringify(await auditRows())).not.toContain(enrollment.secret);
  });

  it('aktivasi: sesi BARU penuh (rotasi), cookie perangkat, 10 kode cadangan ter-hash, audit, email', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const start = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, as)).json(),
    );

    await awayFromStepBoundary();
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: ` ${generateTotp(start.secret).replace(/(\d{3})/, '$1 ')} ` },
      as,
    );

    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers['cache-control']).toBe('no-store');
    const body = confirmTwoFactorEnrollmentResponseSchema.parse(confirm.json());
    expect(body.status).toBe('authenticated');
    expect(body.csrfToken).not.toBe(owner.csrf);
    expect(body.backupCodes.codes).toHaveLength(BACKUP_CODE_COUNT);
    for (const code of body.backupCodes.codes) {
      expect(code).toMatch(
        /^[23456789abcdefghjkmnpqrstuvwxyz]{5}-[23456789abcdefghjkmnpqrstuvwxyz]{5}$/,
      );
    }
    expect(new Set(body.backupCodes.codes).size).toBe(BACKUP_CODE_COUNT);

    const newCookie = sessionCookieOf(confirm);
    expect(newCookie).not.toBe(owner.cookie);
    expect(deviceCookieOf(confirm)).toMatch(/^balesin_device=v1\./);
    // Sesi terbatas lama dicabut; sesi baru penuh dan bisa memakai aplikasi.
    expect((await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as)).statusCode).toBe(
      401,
    );
    const settings = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie: newCookie,
    });
    expect(settings.statusCode).toBe(200);

    const [user] = await harness.db.select().from(users);
    expect(user?.totpEnabledAt).toBeInstanceOf(Date);
    expect(user?.totpSecretEncrypted).toMatch(/^v1\./);
    expect(user?.totpSecretEncrypted).not.toContain(start.secret);
    expect(user?.totpPendingSecretEncrypted).toBeNull();
    const stored = await harness.db.select().from(userBackupCodes);
    expect(stored).toHaveLength(BACKUP_CODE_COUNT);
    for (const code of stored) expect(code.codeHash).toMatch(/^\$argon2id\$/);
    const storedText = JSON.stringify(stored);
    for (const code of body.backupCodes.codes) {
      expect(storedText).not.toContain(code.replace('-', ''));
    }

    const sessions = await harness.db.select().from(userSessions);
    const active = sessions.filter((session) => session.revokedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]?.twoFactorVerifiedAt).toBeInstanceOf(Date);

    const [enabled] = await auditRows('auth.2fa.enabled');
    expect(enabled?.metadata).toMatchObject({
      required: true,
      generatedCount: 10,
      revokedSessions: 1,
    });
    expect(harness.securityNotices).toEqual([
      expect.objectContaining({ event: 'two_factor_enabled', userId: user?.id }),
    ]);
    const everything = `${harness.logs.text()}${JSON.stringify(await auditRows())}`;
    expect(everything).not.toContain(start.secret);
    for (const code of body.backupCodes.codes) expect(everything).not.toContain(code);

    // Sudah aktif: pendaftaran ulang ditolak.
    const again = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      {
        cookie: newCookie,
        csrf: body.csrfToken,
      },
    );
    expect(again.statusCode).toBe(409);
  });

  it('layar dimuat ulang di sesi yang sama: rahasia tertunda dipakai ulang (entri yang dipindai tetap berlaku)', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, as)).json(),
    );
    await harness.db
      .update(users)
      .set({ totpPendingCreatedAt: sql`now() - interval '10 minutes'` });
    const reloaded = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, as)).json(),
    );

    expect(reloaded.secret).toBe(first.secret);
    expect(reloaded.otpauthUri).toBe(first.otpauthUri);
    // Masa berlaku dihitung ulang dari saat QR ditampilkan lagi.
    const minutes = (Date.parse(reloaded.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect((await auditRows('auth.2fa.enrollment_started')).map((row) => row.metadata)).toEqual([
      { reusedPending: false },
      { reusedPending: true },
    ]);

    await awayFromStepBoundary();
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(first.secret) },
      as,
    );
    expect(confirm.statusCode).toBe(200);
  });

  it('pendaftaran kedaluwarsa: rahasia baru dibuat, rahasia lama tidak bisa diaktifkan', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, as)).json(),
    );
    await harness.db
      .update(users)
      .set({ totpPendingCreatedAt: sql`now() - interval '16 minutes'` });
    const expired = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(first.secret) },
      as,
    );
    expect(expired.statusCode).toBe(409);
    expect(errorOf(expired).message).toContain('kedaluwarsa');

    const second = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, as)).json(),
    );
    expect(second.secret).not.toBe(first.secret);
    await awayFromStepBoundary();
    const withOld = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(first.secret) },
      as,
    );
    expect(withOld.statusCode).toBe(400);
    expect(errorOf(withOld).message).toContain('hapus entri lamanya');
  });

  it('sesi lain milik pengguna yang sama tidak mendapat rahasia tertunda pemilik dan tidak bisa mengonfirmasinya', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-admin-dua-sesi-daftar';
    const admin = await addUser(owner.session.organization.id, 'admin', password);
    const sessionOf = async () => {
      const { response, body } = await startLogin(harness.app, { email: admin.email, password });
      if (body.status !== 'two_factor_enrollment_required') throw new Error(body.status);
      return { cookie: sessionCookieOf(response), csrf: body.csrfToken };
    };
    const mine = await sessionOf();
    const other = await sessionOf();

    const minePending = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, mine)).json(),
    );
    // Sesi lain mengonfirmasi dengan kode dari rahasia milik sesi pertama: tidak bisa.
    await awayFromStepBoundary();
    const foreign = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(minePending.secret) },
      other,
    );
    expect(foreign.statusCode).toBe(409);
    // Memulai dari sesi lain = rahasia BARU (rahasia sesi pertama tidak pernah terlihat).
    const otherPending = startTwoFactorEnrollmentResponseSchema.parse(
      (await call(harness.app, 'POST', routes.enroll, {}, other)).json(),
    );
    expect(otherPending.secret).not.toBe(minePending.secret);
  });

  it('tanpa BALESIN_MASTER_KEY: pendaftaran 503 dengan petunjuk, sesi tetap terbatas', async () => {
    await harness.rebuild({ config: { masterKey: null } });
    const owner = await completeSetupWithoutTwoFactor(harness.app, { email: null });
    const response = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    await harness.rebuild();

    expect(response.statusCode).toBe(503);
    expect(errorOf(response).message).toContain('BALESIN_MASTER_KEY');
  });
});

// ── Wajib daftar per peran ──────────────────────────────────────────────────

describe('wajib 2FA untuk Owner/Admin/Supervisor; CS dan Teknisi tidak', () => {
  it.each([
    ['admin', true],
    ['supervisor', true],
    ['cs', false],
    ['teknisi', false],
  ] as const)('%s → wajib daftar: %s', async (role, required) => {
    const owner = await completeSetup(harness.app);
    const password = `sandi-${role}-untuk-tes-2fa`;
    const user = await addUser(owner.session.organization.id, role, password);

    const { response, body } = await startLogin(harness.app, { email: user.email, password });

    if (!required) {
      expect(body.status).toBe('authenticated');
      expect(setCookies(response)).toHaveLength(2);
      return;
    }
    expect(body.status).toBe('two_factor_enrollment_required');
    // Sesi terbatas 30 menit; cookie perangkat dikenal belum diterbitkan.
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/Max-Age=1800$/);
    const cookie = sessionCookieOf(response);
    const settings = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie,
    });
    expect(settings.statusCode).toBe(403);
    expect(errorOf(settings).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
    const [audit] = (await auditRows('auth.login.success')).filter(
      (row) => row.actorUserId === user.id,
    );
    expect(audit?.metadata).toMatchObject({ twoFactorEnrollmentRequired: true });
  });

  it('peran dinaikkan ke Admin: sesi biasa lama dicabut (401); login ulang → sesi pendaftaran', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-yang-naik-peran';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const session = await login(harness.app, { email: cs.email, password });
    expect(session.session.status).toBe('authenticated');

    await harness.db.update(users).set({ role: 'admin' }).where(eq(users.id, cs.id));

    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: session.cookie,
    });
    expect(me.statusCode).toBe(401);
    expect(errorOf(me).message).toBe('Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.');

    // Masuk ulang dengan password → sesi berjenis pendaftaran, yang boleh mendaftar tanpa password.
    const { response, body } = await startLogin(harness.app, { email: cs.email, password });
    expect(body.status).toBe('two_factor_enrollment_required');
    const [row] = await harness.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, sha256Hex(sessionCookieOf(response).split('=')[1] ?? '')));
    expect(row?.kind).toBe('two_factor_enrollment');
    const start = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      {
        cookie: sessionCookieOf(response),
        csrf: body.status === 'two_factor_enrollment_required' ? body.csrfToken : '',
      },
    );
    expect(start.statusCode).toBe(200);
  });

  it('peran wajib-2FA diturunkan menjadi CS: sesi pendaftaran yang masih ada dicabut', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-admin-yang-turun-peran';
    const admin = await addUser(owner.session.organization.id, 'admin', password);
    const { response } = await startLogin(harness.app, { email: admin.email, password });

    await harness.db.update(users).set({ role: 'cs' }).where(eq(users.id, admin.id));

    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: sessionCookieOf(response),
    });
    expect(me.statusCode).toBe(401);
  });

  it('sesi "hanya password" milik pengguna ber-2FA aktif ditolak (lapis kedua di query sesi)', async () => {
    const owner = await completeSetup(harness.app);
    const [row] = await harness.db.select().from(users).where(eq(users.id, owner.session.user.id));
    if (!row) throw new Error('owner hilang');
    const token = 'X'.repeat(43);
    await insertUserSession(harness.db, row, { tokenHash: sha256Hex(token) });

    const response = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: `balesin_session=${token}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

// ── Login dua langkah ───────────────────────────────────────────────────────

describe('login dua langkah', () => {
  let owner: SignedInWithTwoFactor;
  beforeEach(async () => {
    owner = await completeSetup(harness.app);
    harness.logs.lines.length = 0;
  });

  it('password benar → tantangan TANPA sesi; kode benar → sesi penuh, rotasi, cookie perangkat', async () => {
    const { response, challenge } = await challengeFor(OWNER, { cookie: owner.cookie });

    expect(setCookies(response)).toEqual([]);
    expect(challenge.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.attemptsRemaining).toBe(3);
    expect(challenge.methods).toEqual(['totp', 'backup_code']);
    const minutes = (Date.parse(challenge.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.5);
    expect(minutes).toBeLessThanOrEqual(5.05); // jam database vs jam proses
    // Yang tersimpan hanya hash token.
    const [stored] = await harness.db.select().from(twoFactorChallenges);
    expect(stored?.tokenHash).toBe(sha256Hex(challenge.challengeToken));
    expect(JSON.stringify(stored)).not.toContain(challenge.challengeToken);
    // Tantangan BUKAN sesi: tidak bisa dipakai sebagai cookie.
    const asCookie = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: `balesin_session=${challenge.challengeToken}`,
    });
    expect(asCookie.statusCode).toBe(401);

    const verified = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email), {
      cookie: owner.cookie,
    });

    expect(verified.statusCode).toBe(200);
    const body = verifyTwoFactorResponseSchema.parse(verified.json());
    expect(body.twoFactor).toEqual({ method: 'totp', backupCodesRemaining: 10 });
    expect(authenticatedSessionSchema.parse(body).user.role).toBe('owner');
    const cookie = sessionCookieOf(verified);
    expect(deviceCookieOf(verified)).toMatch(/^balesin_device=/);
    // Rotasi: sesi lama di browser ini dicabut.
    expect(
      (await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(401);
    expect(
      (await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, { cookie })).statusCode,
    ).toBe(200);

    const [success] = (await auditRows('auth.login.success')).slice(-1);
    expect(success?.metadata).toMatchObject({ twoFactor: 'totp', replacedPreviousSession: true });
    expect(harness.logs.text()).not.toContain(challenge.challengeToken);
    expect(JSON.stringify(await auditRows())).not.toContain(challenge.challengeToken);
  });

  it('tantangan sekali pakai: dipakai ulang setelah berhasil → 401', async () => {
    const { challenge } = await challengeFor();
    expect(
      (await verify(challenge.challengeToken, await freshTotpCode(OWNER.email))).statusCode,
    ).toBe(200);

    const again = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email));
    expect(again.statusCode).toBe(401);
    expect(errorOf(again).code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    expect(errorOf(again).message).toBe(
      'Langkah verifikasi ini sudah tidak berlaku. Masuk lagi dengan email dan password-mu.',
    );
  });

  it('tantangan kedaluwarsa, ngawur, atau dari browser lain → 401', async () => {
    const { challenge } = await challengeFor();
    const otherBrowser = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email), {
      headers: { 'user-agent': 'Browser Lain/1.0' },
    });
    const otherNetwork = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email), {
      ip: '198.51.100.7',
    });
    await harness.db
      .update(twoFactorChallenges)
      .set({ expiresAt: sql`now() - interval '1 second'` });
    const expired = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email));
    const garbage = await verify('x'.repeat(43), '123456');

    for (const response of [otherBrowser, otherNetwork, expired, garbage]) {
      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
      expect(setCookies(response)).toEqual([]);
    }
    const details = (await auditRows('auth.2fa.failed')).map((row) => row.metadata.detail);
    expect(details).toEqual(['different_client', 'different_client', 'expired_or_used']);
  });

  it('tantangan milik pengguna lain: kode pengguna lain tidak berlaku', async () => {
    const password = 'sandi-admin-untuk-tes-2fa';
    const admin = await addUser(owner.session.organization.id, 'admin', password);
    await login(harness.app, { email: admin.email, password });
    const adminCode = await freshTotpCode(admin.email);

    const { challenge } = await challengeFor();
    const response = await verify(challenge.challengeToken, adminCode);

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('code');
  });

  it('replay: kode TOTP yang sama tidak bisa dipakai dua kali dalam jendelanya', async () => {
    await awayFromStepBoundary();
    const code = await freshTotpCode(OWNER.email);
    const first = await challengeFor();
    expect((await verify(first.challenge.challengeToken, code)).statusCode).toBe(200);

    const second = await challengeFor();
    const replayed = await verify(second.challenge.challengeToken, code);

    expect(replayed.statusCode).toBe(400);
    expect(errorOf(replayed).message).toContain('Sisa 2 percobaan');
    const [failure] = await auditRows('auth.2fa.failed');
    expect(failure?.metadata).toMatchObject({ reason: 'replayed', method: 'totp' });
  });

  it('pergeseran jam: kode langkah sebelumnya/berikutnya diterima, dua langkah ditolak', async () => {
    await awayFromStepBoundary();
    await freshTotpCode(OWNER.email);
    const tooOld = await challengeFor();
    expect(
      (await verify(tooOld.challenge.challengeToken, codeAtOffset(owner.totpSecret, -2)))
        .statusCode,
    ).toBe(400);

    const previous = await challengeFor();
    expect(
      (await verify(previous.challenge.challengeToken, codeAtOffset(owner.totpSecret, -1)))
        .statusCode,
    ).toBe(200);
    // Setelah langkah -1 dipakai, langkah +1 masih lebih baru → diterima.
    const next = await challengeFor();
    expect(
      (await verify(next.challenge.challengeToken, codeAtOffset(owner.totpSecret, 1))).statusCode,
    ).toBe(200);
  });

  it('dua permintaan bersamaan dengan tantangan + kode benar yang sama: hanya satu sesi', async () => {
    const { challenge } = await challengeFor();
    const code = await freshTotpCode(OWNER.email);

    const responses = await Promise.all([
      verify(challenge.challengeToken, code),
      verify(challenge.challengeToken, code),
      verify(challenge.challengeToken, code),
    ]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const active = (await harness.db.select().from(userSessions)).filter(
      (session) => session.revokedAt === null,
    );
    expect(active).toHaveLength(2); // sesi `owner` dari setup + satu sesi baru
  });

  it('kode cadangan: sekali pakai, format bebas huruf besar/spasi, audit + email', async () => {
    const [backup = ''] = owner.backupCodes;
    const typed = `  ${backup.toUpperCase().replace('-', ' ')} `;

    const first = await challengeFor();
    const used = await verify(first.challenge.challengeToken, typed);

    expect(used.statusCode).toBe(200);
    expect(verifyTwoFactorResponseSchema.parse(used.json()).twoFactor).toEqual({
      method: 'backup_code',
      backupCodesRemaining: 9,
    });
    const second = await challengeFor();
    const reused = await verify(second.challenge.challengeToken, backup);
    expect(reused.statusCode).toBe(400);

    const [usedAudit] = await auditRows('auth.2fa.backup_code_used');
    expect(usedAudit?.metadata).toEqual({ usage: 'login', remaining: 9 });
    expect(harness.securityNotices.at(-1)).toMatchObject({
      event: 'backup_code_used',
      backupCodesRemaining: 9,
    });
    const [failed] = await auditRows('auth.2fa.failed');
    expect(failed?.metadata).toMatchObject({ method: 'backup_code', reason: 'wrong_code' });
    const rows = await harness.db.select().from(userBackupCodes);
    expect(rows.filter((row) => row.usedAt !== null)).toHaveLength(1);
    expect(JSON.stringify(await auditRows())).not.toContain(backup);
  });

  it('TOTP + kode cadangan serentak: kode cadangan hanya terbakar bila dialah yang menerbitkan sesi (R2)', async () => {
    const [backup = ''] = owner.backupCodes;
    const { challenge } = await challengeFor();
    const responses = await Promise.all([
      verify(challenge.challengeToken, await freshTotpCode(OWNER.email)),
      verify(challenge.challengeToken, backup),
    ]);

    const winners = responses.filter((response) => response.statusCode === 200);
    expect(winners).toHaveLength(1);
    const method = verifyTwoFactorResponseSchema.parse(winners[0]?.json()).twoFactor.method;
    const used = (await harness.db.select().from(userBackupCodes)).filter(
      (row) => row.usedAt !== null,
    );
    expect(used).toHaveLength(method === 'backup_code' ? 1 : 0);
    expect(await auditRows('auth.2fa.backup_code_used')).toHaveLength(used.length);
  });

  it('3 kode salah per tantangan → tantangan hangus (kode benar pun ditolak)', async () => {
    const { challenge } = await challengeFor();
    const statuses: number[] = [];
    const messages: string[] = [];
    for (const code of ['111111', '222222', '333333']) {
      const response = await verify(challenge.challengeToken, code);
      statuses.push(response.statusCode);
      messages.push(errorOf(response).message);
    }
    const correct = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email));

    expect(statuses).toEqual([400, 400, 401]);
    expect(messages[0]).toContain('Sisa 2 percobaan');
    expect(messages[1]).toContain('Sisa 1 percobaan');
    expect(messages[2]).toBe('Kode salah 3 kali. Masuk lagi dengan email dan password-mu.');
    expect(correct.statusCode).toBe(401);
  });

  it('brute force: 5 kode salah per akun → langkah kedua dikunci 15 menit, audit + email', async () => {
    const statuses: number[] = [];
    const first = await challengeFor();
    for (const code of ['111111', '222222']) {
      statuses.push((await verify(first.challenge.challengeToken, code)).statusCode);
    }
    const second = await challengeFor(OWNER, { ip: '198.51.100.30' });
    for (const code of ['333333', '444444', '555555']) {
      statuses.push(
        (await verify(second.challenge.challengeToken, code, { ip: '198.51.100.30' })).statusCode,
      );
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);

    // Password benar dari jaringan mana pun: 429, tanpa tantangan baru dan tanpa cookie.
    const afterLock = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: OWNER.email, password: OWNER.password },
      { ip: '203.0.113.200' },
    );
    expect(afterLock.statusCode).toBe(429);
    expect(errorOf(afterLock).message).toContain('Terlalu banyak kode verifikasi yang salah');
    expect(Number(afterLock.headers['retry-after'])).toBeGreaterThan(890);
    expect(setCookies(afterLock)).toEqual([]);

    // Percobaan masuk selama kunci juga tercatat.
    expect((await auditRows('auth.2fa.failed')).at(-1)?.metadata).toMatchObject({
      usage: 'login',
      reason: 'locked',
    });
    const [lock] = await auditRows('auth.account.locked');
    expect(lock?.metadata).toMatchObject({
      scope: 'two_factor',
      trustedDevice: false,
      failedAttempts: 5,
    });
    await expect.poll(() => harness.lockedNotifications.length).toBe(1);
    expect(harness.lockedNotifications[0]).toMatchObject({
      scope: 'two_factor',
      userId: owner.session.user.id,
    });
    // Sesi yang sudah ada tidak ikut mati.
    expect(
      (await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(200);
  });

  it('perangkat dikenal tidak terkunci oleh penebak kode dari tempat lain', async () => {
    const known = await call(harness.app, 'POST', routes.verify, {
      challengeToken: (await challengeFor()).challenge.challengeToken,
      code: await freshTotpCode(OWNER.email),
    });
    const device = deviceCookieOf(known);

    // Penyerang yang tahu password menebak kode dari jaringan lain sampai terkunci.
    for (let round = 0; round < 2; round += 1) {
      const { challenge } = await challengeFor(OWNER, { ip: '198.51.100.66' });
      for (const code of ['101010', '202020', '303030']) {
        await verify(challenge.challengeToken, code, { ip: '198.51.100.66' });
      }
    }
    const attacker = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: OWNER.email, password: OWNER.password },
      { ip: '198.51.100.66' },
    );
    expect(attacker.statusCode).toBe(429);

    // Pemilik akun di perangkatnya sendiri tetap bisa masuk.
    const mine = await challengeFor(OWNER, { cookie: device });
    const verified = await verify(mine.challenge.challengeToken, await freshTotpCode(OWNER.email), {
      cookie: device,
    });
    expect(verified.statusCode).toBe(200);
  });

  it('batas per IP untuk endpoint verifikasi (token ngawur pun dihitung)', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push(
        (await verify(`ngawur-${attempt}`, '123456', { ip: '203.0.113.150' })).statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('akun dinonaktifkan setelah tantangan dibuat: tantangan tidak berlaku', async () => {
    const { challenge } = await challengeFor();
    await harness.db.update(users).set({ disabledAt: new Date() });

    const response = await verify(challenge.challengeToken, await freshTotpCode(OWNER.email));
    expect(response.statusCode).toBe(401);
  });
});

// ── Pengelolaan oleh pengguna sendiri ───────────────────────────────────────

describe('kelola 2FA sendiri: buat ulang kode cadangan, nonaktifkan', () => {
  let owner: SignedInWithTwoFactor;
  beforeEach(async () => {
    owner = await completeSetup(harness.app);
  });

  const as = () => ({ cookie: owner.cookie, csrf: owner.csrf });

  it('status untuk Owner yang sudah aktif', async () => {
    const response = await call(harness.app, 'GET', routes.status, undefined, as());
    const status = twoFactorStatusResponseSchema.parse(response.json());
    expect(status).toMatchObject({
      enabled: true,
      required: true,
      backupCodesRemaining: 10,
      enrollmentPending: false,
    });
    expect(status.enabledAt).not.toBeNull();
  });

  it('buat ulang kode cadangan: butuh password + kode; yang lama batal', async () => {
    const noCsrf = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      {
        password: OWNER.password,
        code: '123456',
      },
      { cookie: owner.cookie },
    );
    expect(noCsrf.statusCode).toBe(403);

    const wrongPassword = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      { password: 'bukan-password-nya', code: await freshTotpCode(OWNER.email) },
      as(),
    );
    expect(wrongPassword.statusCode).toBe(400);
    expect(errorOf(wrongPassword).details?.[0]?.field).toBe('password');

    const wrongCode = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      { password: OWNER.password, code: '000000' },
      as(),
    );
    expect(wrongCode.statusCode).toBe(400);
    expect(errorOf(wrongCode).details?.[0]?.field).toBe('code');

    const ok = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
      as(),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const fresh = regenerateBackupCodesResponseSchema.parse(ok.json());
    expect(fresh.codes).toHaveLength(10);
    expect(fresh.codes).not.toContain(owner.backupCodes[0]);

    // Kode lama tidak berlaku lagi; kode baru berlaku.
    const old = await challengeFor();
    expect(
      (await verify(old.challenge.challengeToken, owner.backupCodes[0] ?? '')).statusCode,
    ).toBe(400);
    const renewed = await challengeFor();
    expect((await verify(renewed.challenge.challengeToken, fresh.codes[0] ?? '')).statusCode).toBe(
      200,
    );
    expect(await auditRows('auth.2fa.backup_codes_regenerated')).toHaveLength(1);
    // Pemilik akun diberi tahu (R3): kode baru bisa jadi jalur penyerang bertahan di akun.
    expect(harness.securityNotices.map((notice) => notice.event)).toContain(
      'backup_codes_regenerated',
    );
  });

  it('Owner/Admin/Supervisor tidak bisa menonaktifkan 2FA sendiri', async () => {
    const response = await call(
      harness.app,
      'POST',
      routes.disable,
      { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
      as(),
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).message).toContain('wajib memakai verifikasi dua langkah');
    const [user] = await harness.db.select().from(users).where(eq(users.id, owner.session.user.id));
    expect(user?.totpEnabledAt).toBeInstanceOf(Date);
  });

  it('kode salah saat konfirmasi ulang ikut ember kunci langkah kedua (R4): 5 salah → kunci + email', async () => {
    const statuses: number[] = [];
    for (const code of ['111111', '222222', '333333', '444444', '555555']) {
      statuses.push(
        (
          await call(
            harness.app,
            'POST',
            routes.regenerateBackupCodes,
            { password: OWNER.password, code },
            as(),
          )
        ).statusCode,
      );
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);

    const [lock] = await auditRows('auth.account.locked');
    expect(lock?.metadata).toMatchObject({ scope: 'two_factor', failedAttempts: 5 });
    await expect.poll(() => harness.lockedNotifications.length).toBe(1);
    expect(harness.lockedNotifications[0]).toMatchObject({
      scope: 'two_factor',
      trigger: 'reauth',
    });
    // Langkah kedua saat masuk ikut terkunci.
    const login = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: OWNER.email,
      password: OWNER.password,
    });
    expect(login.statusCode).toBe(429);
  });

  it('konfirmasi ulang dibatasi: 5 password salah → 429', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (
          await call(
            harness.app,
            'POST',
            routes.regenerateBackupCodes,
            { password: `salah-${attempt}-xxxx`, code: '123456' },
            as(),
          )
        ).statusCode,
      );
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it('CS boleh mengaktifkan (butuh password) dan menonaktifkan (password + kode)', async () => {
    const password = 'sandi-cs-yang-ingin-aman';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const csSession = await login(harness.app, { email: cs.email, password });
    const otherDevice = await login(harness.app, { email: cs.email, password });
    const csAs = { cookie: csSession.cookie, csrf: csSession.csrf };

    const withoutPassword = await call(harness.app, 'POST', routes.enroll, {}, csAs);
    expect(withoutPassword.statusCode).toBe(400);
    expect(errorOf(withoutPassword).details?.[0]?.field).toBe('password');
    const wrongPassword = await call(
      harness.app,
      'POST',
      routes.enroll,
      { password: 'bukan-password-cs' },
      csAs,
    );
    expect(wrongPassword.statusCode).toBe(400);

    const enrolled = await enrollTwoFactor(harness.app, csSession, { password });
    // Sesi lain (yang dibuat hanya dengan password) dicabut setelah 2FA aktif.
    expect(
      (
        await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
          cookie: otherDevice.cookie,
        })
      ).statusCode,
    ).toBe(401);
    const [enabledAudit] = (await auditRows('auth.2fa.enabled')).filter(
      (row) => row.actorUserId === cs.id,
    );
    expect(enabledAudit?.metadata).toMatchObject({ required: false, revokedSessions: 2 });

    // Login berikutnya butuh langkah kedua.
    expect((await startLogin(harness.app, { email: cs.email, password })).body.status).toBe(
      'two_factor_required',
    );

    const disabled = await call(
      harness.app,
      'POST',
      routes.disable,
      { password, code: await freshTotpCode(cs.email) },
      { cookie: enrolled.cookie, csrf: enrolled.csrf },
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ status: 'disabled' });
    const [row] = await harness.db.select().from(users).where(eq(users.id, cs.id));
    expect(row).toMatchObject({ totpSecretEncrypted: null, totpEnabledAt: null });
    expect(
      (await harness.db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, cs.id)))
        .length,
    ).toBe(0);
    expect((await startLogin(harness.app, { email: cs.email, password })).body.status).toBe(
      'authenticated',
    );
    expect(await auditRows('auth.2fa.disabled')).toHaveLength(1);
    expect(harness.securityNotices.map((notice) => notice.event)).toContain('two_factor_disabled');
  });
});
