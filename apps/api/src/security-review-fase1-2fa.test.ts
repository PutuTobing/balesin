/**
 * Review keamanan Fase 1 butir 3 (2FA TOTP + kode cadangan) — laporan:
 * docs/security-reviews/2026-11-14-fase1-2fa.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka — isi tesnya menyatakan perilaku yang BENAR, jadi
 * tes itu gagal selama celahnya ada. Setelah celah ditutup Vitest melaporkannya gagal: saat itu
 * hapus `.fails`-nya. Setiap `it.fails` di sini sudah dipastikan gagal karena alasan yang dimaksud.
 */
import { generateTotp } from '@balesin/core';
import { auditLogs, organizations, userSessions, users, type User } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
  errorEnvelopeSchema,
  normalizeTwoFactorCode,
  regenerateBackupCodesResponseSchema,
  startTwoFactorEnrollmentResponseSchema,
  twoFactorChallengeResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  deviceCookieOf,
  enrollTwoFactor,
  freshTotpCode,
  login,
  loginResponse,
  OWNER,
  startLogin,
  type CallOptions,
  type IntegrationHarness,
  type SignedInWithTwoFactor,
} from './testing/integration';

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

async function challengeFor(
  credentials: { email: string; password: string },
  options: CallOptions = {},
) {
  const { body } = await startLogin(harness.app, credentials, options);
  if (body.status !== 'two_factor_required') throw new Error(`Bukan tantangan: ${body.status}`);
  return twoFactorChallengeResponseSchema.parse(body);
}

/** Kode 6 digit yang PASTI salah untuk rahasia ini (bukan kode langkah −1, 0, +1). */
function wrongCode(secret: string): string {
  const window = new Set(
    [-1, 0, 1].map((offset) => generateTotp(secret, Date.now() + offset * 30_000)),
  );
  for (let value = 100_000; ; value += 1) {
    const code = String(value);
    if (!window.has(code)) return code;
  }
}

async function auditRows(action?: string) {
  const rows = await harness.db.select().from(auditLogs).orderBy(auditLogs.createdAt);
  return action ? rows.filter((row) => row.action === action) : rows;
}

/**
 * Penyerang yang tahu password (tanpa autentikator) menebak kode sampai ditolak 429.
 * Mengembalikan jumlah tebakan yang BENAR-BENAR diperiksa server (jawaban 400/401 dari kode salah).
 */
async function guessUntilLocked(
  credentials: { email: string; password: string },
  secret: string,
  options: CallOptions,
): Promise<number> {
  let checked = 0;
  for (let round = 0; round < 20; round += 1) {
    const started = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: credentials.email, password: credentials.password },
      options,
    );
    if (started.statusCode === 429) return checked;
    const challenge = twoFactorChallengeResponseSchema.parse(started.json());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await verify(challenge.challengeToken, wrongCode(secret), options);
      if (response.statusCode === 429) return checked;
      checked += 1;
      if (response.statusCode === 401) break;
    }
  }
  throw new Error('Tidak pernah terkunci');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Celah terbuka ───────────────────────────────────────────────────────────

describe('celah yang sudah ditutup (S1, S2, R1)', () => {
  it('S1: cookie perangkat yang terbit SEBELUM 2FA aktif tidak memberi jatah tebakan kode tambahan', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-yang-sudah-bocor-01';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const credentials = { email: cs.email, password };

    // Penyerang tahu password selagi akun CS belum ber-2FA dan masuk dua kali: setiap login
    // menerbitkan cookie perangkat dikenal BARU (beda detik terbit = beda ember).
    const deviceCookies: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) await sleep(1_100);
      const { response } = await startLogin(harness.app, credentials, { ip: '198.51.100.7' });
      deviceCookies.push(deviceCookieOf(response));
    }
    expect(new Set(deviceCookies).size).toBe(2);

    // Pemilik akun lalu mengaktifkan 2FA (password belum diganti).
    const mine = await login(harness.app, credentials, { ip: '203.0.113.10' });
    const enrolled = await enrollTwoFactor(harness.app, mine, { password, ip: '203.0.113.10' });

    // Penyerang menebak kode: tanpa cookie perangkat, lalu dengan tiap cookie lama.
    let checked = 0;
    for (const [index, cookie] of [undefined, ...deviceCookies].entries()) {
      checked += await guessUntilLocked(credentials, enrolled.totpSecret, {
        ip: `198.51.100.${20 + index}`,
        ...(cookie ? { cookie } : {}),
      });
    }

    // Yang benar: cookie dari masa "hanya password" bukan bukti pernah lolos langkah kedua,
    // jadi batas 5 tebakan per akun per 15 menit tetap berlaku. Sekarang tiap ember memberi 5
    // tebakan (4 dijawab 400/401 + tebakan ke-5 yang dijawab 429): penghitung = 4 × 3 = 12,
    // tebakan sungguhan 15 — dan bertambah 5 untuk setiap cookie lama yang dimiliki penyerang.
    expect(checked).toBeLessThanOrEqual(TWO_FACTOR_MAX_FAILED_ATTEMPTS);
  }, 40_000);

  it('S2: sesi CS curian + peran dinaikkan → mendaftarkan autentikator tetap butuh password', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-yang-naik-jadi-spv';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    // Cookie sesi CS biasa (30 hari) yang dicuri penyerang — penyerang TIDAK tahu password.
    const stolen = await login(harness.app, { email: cs.email, password });

    await harness.db.update(users).set({ role: 'supervisor' }).where(eq(users.id, cs.id));

    const start = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      {
        cookie: stolen.cookie,
        csrf: stolen.csrf,
      },
    );
    // Yang benar: hanya sesi terbatas yang BARU dibuat dengan password (login/setup) yang boleh
    // mendaftar tanpa password. Perbaikan S2 memilih lapis yang lebih ketat dari "400 minta
    // password": sesi biasa yang menjadi wajib-daftar dicabut di hook auth (401), jadi pemegang
    // cookie curian harus memasukkan password untuk mendapat sesi pendaftaran. (Asersi semula
    // `400` + field `password` diganti: rute ini kini tidak pernah sampai ke handler.)
    expect(start.statusCode).toBe(401);
    expect(errorOf(start).code).toBe('UNAUTHENTICATED');
    expect(start.headers['set-cookie']).toEqual(
      'balesin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
    const [row] = await harness.db.select().from(users).where(eq(users.id, cs.id));
    expect(row?.totpPendingSecretEncrypted).toBeNull();
    const [session] = await harness.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, cs.id));
    expect(session?.revokedAt).toBeInstanceOf(Date);
  });

  it('R1: login sukses pemilik dari perangkat baru tidak memutihkan hitungan tebakan kode penyerang', async () => {
    const owner = await completeSetup(harness.app);
    const attacker = { ip: '198.51.100.40' };
    const wrong = wrongCode(owner.totpSecret);

    // 4 tebakan salah (3 di tantangan pertama, 1 di tantangan kedua).
    const first = await challengeFor(OWNER, attacker);
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await verify(first.challengeToken, wrong, attacker)).statusCode);
    }
    const second = await challengeFor(OWNER, attacker);
    statuses.push((await verify(second.challengeToken, wrong, attacker)).statusCode);
    expect(statuses).toEqual([400, 400, 401, 400]);

    // Pemilik masuk dari browser baru (tanpa cookie perangkat) di jaringan lain.
    const mine = await loginResponse(harness.app, OWNER, { ip: '203.0.113.50' });
    expect(mine.statusCode).toBe(200);

    // Yang benar (sama dengan aturan login password): tebakan ke-5 dalam 15 menit → kunci.
    const third = await challengeFor(OWNER, attacker);
    const fifth = await verify(third.challengeToken, wrong, attacker);
    expect(fifth.statusCode).toBe(429);
  });
});

// ── Penjaga regresi ─────────────────────────────────────────────────────────

describe('sesi terbatas: bawaan tolak untuk semua metode', () => {
  it('HEAD rute GET lain, rute pelengkap 405, dan PUT → 403 TWO_FACTOR_ENROLLMENT_REQUIRED', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };

    const head = await call(harness.app, 'HEAD', API_ROUTES.settings.email, undefined, as);
    expect(head.statusCode).toBe(403);

    // Alamat yang ADA di daftar izin, tapi metode lain (rute pelengkap 405): tetap ditolak,
    // tanpa membocorkan `Allow`.
    const complement = await call(harness.app, 'DELETE', API_ROUTES.auth.me, undefined, as);
    expect(complement.statusCode).toBe(403);
    expect(errorOf(complement).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
    expect(complement.headers.allow).toBeUndefined();

    const put = await call(harness.app, 'PUT', API_ROUTES.settings.email, {}, as);
    expect(put.statusCode).toBe(403);
    expect(errorOf(put).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });
});

describe('tantangan langkah kedua', () => {
  let owner: SignedInWithTwoFactor;
  beforeEach(async () => {
    owner = await completeSetup(harness.app);
  });

  it('token tantangan bukan sesi: dipakai sebagai cookie sesi → 401', async () => {
    const challenge = await challengeFor(OWNER);
    const response = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: `balesin_session=${challenge.challengeToken}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('10 kode salah serentak pada satu tantangan: paling banyak 3 yang diperiksa', async () => {
    const challenge = await challengeFor(OWNER);
    const wrong = wrongCode(owner.totpSecret);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => verify(challenge.challengeToken, wrong)),
    );
    expect(responses.some((response) => response.statusCode === 200)).toBe(false);
    const checked = (await auditRows('auth.2fa.failed')).filter(
      (row) => (row.metadata as { reason?: string }).reason === 'wrong_code',
    );
    expect(checked.length).toBeLessThanOrEqual(3);
  });

  it('serbuan kode salah serentak lewat banyak tantangan: paling banyak 5 yang diperiksa per akun', async () => {
    const challenges = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        challengeFor(OWNER, { ip: `198.51.100.${60 + index}` }),
      ),
    );
    const wrong = wrongCode(owner.totpSecret);
    const responses = await Promise.all(
      challenges.flatMap((challenge, index) =>
        Array.from({ length: 3 }, () =>
          verify(challenge.challengeToken, wrong, { ip: `198.51.100.${60 + index}` }),
        ),
      ),
    );
    expect(responses.some((response) => response.statusCode === 200)).toBe(false);
    const checked = (await auditRows('auth.2fa.failed')).filter(
      (row) => (row.metadata as { reason?: string }).reason === 'wrong_code',
    );
    expect(checked.length).toBeLessThanOrEqual(TWO_FACTOR_MAX_FAILED_ATTEMPTS);
    expect(responses.some((response) => response.statusCode === 429)).toBe(true);
  });

  it('kode TOTP dan kode cadangan serentak pada satu tantangan: hanya satu sesi', async () => {
    const challenge = await challengeFor(OWNER);
    const before = (await harness.db.select().from(userSessions)).filter((s) => !s.revokedAt);
    const [backup = ''] = owner.backupCodes;
    const responses = await Promise.all([
      verify(challenge.challengeToken, await freshTotpCode(OWNER.email)),
      verify(challenge.challengeToken, backup),
    ]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const after = (await harness.db.select().from(userSessions)).filter((s) => !s.revokedAt);
    expect(after).toHaveLength(before.length + 1);
  });
});

describe('pendaftaran & pengelolaan', () => {
  it('URI otpauth: nama produk berisi & : ? tidak bisa menyisipkan parameter atau label', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    await harness.db
      .update(organizations)
      .set({ productName: 'Jahat&secret=AAAAAAAA&issuer=Palsu:penyerang@jahat.test?x=1#frag' });

    const start = await call(
      harness.app,
      'POST',
      routes.enroll,
      {},
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(start.statusCode).toBe(200);
    const body = startTwoFactorEnrollmentResponseSchema.parse(start.json());
    const uri = new URL(body.otpauthUri);

    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hash).toBe('');
    expect(uri.searchParams.getAll('secret')).toEqual([body.secret]);
    expect(uri.searchParams.getAll('issuer')).toEqual([body.issuer]);
    expect(body.issuer).not.toContain(':');
    expect(uri.host).toBe('totp');
    const label = decodeURIComponent(uri.pathname.slice(1));
    expect(label.split(':')).toEqual([body.issuer, OWNER.email]);
  });

  it('CS ber-2FA yang dinaikkan menjadi Supervisor tidak bisa menonaktifkan 2FA (peran dari DB)', async () => {
    const owner = await completeSetup(harness.app);
    const password = 'sandi-cs-ber2fa-lalu-naik';
    const cs = await addUser(owner.session.organization.id, 'cs', password);
    const signed = await login(harness.app, { email: cs.email, password });
    const enrolled = await enrollTwoFactor(harness.app, signed, { password });

    await harness.db.update(users).set({ role: 'supervisor' }).where(eq(users.id, cs.id));

    const response = await call(
      harness.app,
      'POST',
      routes.disable,
      { password, code: await freshTotpCode(cs.email) },
      { cookie: enrolled.cookie, csrf: enrolled.csrf },
    );
    expect(response.statusCode).toBe(403);
    const [row] = await harness.db.select().from(users).where(eq(users.id, cs.id));
    expect(row?.totpEnabledAt).not.toBeNull();
  });

  it('rahasia TOTP, kode cadangan, dan token tantangan tidak pernah masuk audit, log, atau antrean email', async () => {
    const owner = await completeSetup(harness.app);
    const challenge = await challengeFor(OWNER);
    const [backup = ''] = owner.backupCodes;
    expect((await verify(challenge.challengeToken, backup)).statusCode).toBe(200);

    const regenerated = await call(
      harness.app,
      'POST',
      routes.regenerateBackupCodes,
      { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(regenerated.statusCode).toBe(200);
    const fresh = regenerateBackupCodesResponseSchema.parse(regenerated.json()).codes;

    const haystack = [
      JSON.stringify(await auditRows()),
      harness.logs.lines.join('\n'),
      JSON.stringify(harness.securityNotices),
      JSON.stringify(harness.lockedNotifications),
    ].join('\n');
    const needles = [
      owner.totpSecret,
      challenge.challengeToken,
      ...[...owner.backupCodes, ...fresh].flatMap((code) => [code, normalizeTwoFactorCode(code)]),
    ];
    for (const needle of needles) expect(haystack).not.toContain(needle);
  });
});
