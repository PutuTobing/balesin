import { hash } from '@node-rs/argon2';
import { sha256Hex } from '@balesin/core';
import { auditLogs, organizations, userSessions, users, type User } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  authenticatedSessionSchema,
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AUTHENTICATED, requirePermission } from '../../http/route-access';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  deviceCookieOf,
  login,
  loginResponse,
  OWNER,
  sessionCookieOf,
  setCookies,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import { LOGIN_ACCOUNT_RULE, LOGIN_IP_RULE } from './login-rules';
import { createPasswordHasher } from './password-hasher';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  harness.logs.lines.length = 0;
});
afterAll(async () => {
  await harness?.close();
});

type Response = Awaited<ReturnType<typeof call>>;

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const tryLogin = (email: string, password: string, ip?: string, cookie?: string) =>
  call(harness.app, 'POST', API_ROUTES.auth.login, { email, password }, { ip, cookie });

const me = (cookie?: string) => call(harness.app, 'GET', API_ROUTES.auth.me, undefined, { cookie });

async function addUser(role: UserRole, password: string, overrides: Partial<User> = {}) {
  return insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
    ...overrides,
  });
}

async function sessionRows() {
  return harness.db.select().from(userSessions).orderBy(userSessions.createdAt);
}

/** Baris sesi milik cookie ini (`nama=token`). */
async function sessionRowOf(cookie: string) {
  const token = cookie.split('=')[1] ?? '';
  const rows = await sessionRows();
  return rows.find((row) => row.tokenHash === sha256Hex(token));
}

/** Pengguna CS (tidak wajib 2FA) untuk menguji langkah password apa adanya. */
const CS_PASSWORD = 'sandi-pengguna-cs-panjang';
const addCs = () => addUser('cs', CS_PASSWORD);

async function auditActions(): Promise<string[]> {
  const rows = await harness.db.select().from(auditLogs).orderBy(auditLogs.createdAt);
  return rows.map((row) => row.action);
}

/** Alasan setiap `auth.login.failed` di audit log, berurutan. */
async function failedLoginReasons(): Promise<unknown[]> {
  const rows = await harness.db.select().from(auditLogs).orderBy(auditLogs.createdAt);
  return rows.filter((row) => row.action === 'auth.login.failed').map((row) => row.metadata.reason);
}

/** Respons tanpa bagian yang memang berbeda di setiap permintaan. */
function comparable(response: Response) {
  const { requestId: _requestId, ...error } = errorOf(response);
  const headers = { ...response.headers };
  delete headers['x-request-id'];
  delete headers.date;
  return { status: response.statusCode, error, headers };
}

describe('POST /auth/login', () => {
  it('email + password benar (akun tanpa 2FA): sesi baru, cookie HttpOnly, dan token CSRF', async () => {
    const cs = await addCs();
    const response = await tryLogin(`  ${cs.email.toUpperCase()}`, CS_PASSWORD, '203.0.113.5');

    expect(response.statusCode).toBe(200);
    const session = authenticatedSessionSchema.parse(response.json());
    expect(session.status).toBe('authenticated');
    expect(session.user).toEqual({ id: cs.id, name: cs.name, email: cs.email, role: 'cs' });
    const [cookie] = setCookies(response);
    expect(cookie).toMatch(
      /^balesin_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );

    // Yang disimpan hanya HASH token; token mentah hanya ada di cookie.
    const token = sessionCookieOf(response).split('=')[1] ?? '';
    const rows = await sessionRows();
    const row = rows.find((candidate) => candidate.tokenHash === sha256Hex(token));
    expect(row).toMatchObject({ ipAddress: '203.0.113.5', revokedAt: null });
    expect(JSON.stringify(rows)).not.toContain(token);

    // Idle 12 jam, mutlak 30 hari (menurut jam database).
    const idleHours = (Date.parse(session.session.idleExpiresAt) - Date.now()) / 3_600_000;
    const absoluteDays = (Date.parse(session.session.absoluteExpiresAt) - Date.now()) / 86_400_000;
    expect(idleHours).toBeGreaterThan(11.9);
    expect(idleHours).toBeLessThan(12.1);
    expect(absoluteDays).toBeGreaterThan(29.9);
    expect(absoluteDays).toBeLessThan(30.1);

    expect(await auditActions()).toContain('auth.login.success');
    expect(response.body).not.toContain('argon2');
    expect(harness.logs.text()).not.toContain(CS_PASSWORD);
    expect(harness.logs.text()).not.toContain(token);
    expect(harness.logs.text()).not.toContain(session.csrfToken);
  });

  it('email tidak terdaftar, password salah, dan akun nonaktif dijawab PERSIS sama', async () => {
    const disabled = await addUser('cs', 'sandi-pengguna-nonaktif-1', { disabledAt: new Date() });

    const wrongPassword = await tryLogin(OWNER.email, 'password-yang-salah-1', '203.0.113.1');
    const unknownEmail = await tryLogin(
      'tidak-ada@majujaya.test',
      'password-yang-salah-1',
      '203.0.113.2',
    );
    const disabledUser = await tryLogin(disabled.email, 'sandi-pengguna-nonaktif-1', '203.0.113.3');

    for (const response of [wrongPassword, unknownEmail, disabledUser]) {
      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('INVALID_CREDENTIALS');
      expect(errorOf(response).message).toBe(
        'Email atau password salah. Periksa lagi lalu coba masuk kembali.',
      );
      expect(setCookies(response)).toEqual([]);
    }
    expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));
    expect(comparable(disabledUser)).toEqual(comparable(wrongPassword));
  });

  it('gagal masuk tercatat di audit log tanpa password dan tanpa email utuh', async () => {
    await tryLogin(OWNER.email, 'password-yang-salah-1', '203.0.113.1');
    await tryLogin('orang.asing@contoh.test', 'password-yang-salah-2', 'bukan-ip');

    const failed = (await harness.db.select().from(auditLogs)).filter(
      (row) => row.action === 'auth.login.failed',
    );
    expect(failed).toHaveLength(2);
    const known = failed.find((row) => row.targetId === owner.session.user.id);
    const unknown = failed.find((row) => row.targetId === null);
    expect(known).toMatchObject({
      actorUserId: null,
      targetType: 'user',
      ipAddress: '203.0.113.1',
      metadata: { reason: 'wrong_password', attempt: 1, email: 's***@majujaya.test' },
    });
    expect(unknown?.metadata).toEqual({
      reason: 'unknown_email',
      attempt: 1,
      email: 'o***@contoh.test',
      trustedDevice: false,
    });
    expect(JSON.stringify(failed)).not.toContain('password-yang-salah');
    expect(JSON.stringify(failed)).not.toContain('orang.asing');
  });

  it('isian kosong atau bukan email ditolak 400 sebelum menyentuh akun', async () => {
    const empty = await call(harness.app, 'POST', API_ROUTES.auth.login, {});
    const notEmail = await tryLogin('bukan-email', 'apa-saja-12345');

    expect(empty.statusCode).toBe(400);
    expect((errorOf(empty).details ?? []).map((detail) => detail.field).sort()).toEqual([
      'email',
      'password',
    ]);
    expect(notEmail.statusCode).toBe(400);
    expect(await auditActions()).not.toContain('auth.login.failed');
  });

  it('rotasi: masuk lagi dari browser yang sama mencabut sesi lamanya', async () => {
    const second = await login(harness.app, OWNER, { cookie: owner.cookie });

    expect(second.cookie).not.toBe(owner.cookie);
    expect(second.csrf).not.toBe(owner.csrf);
    expect((await me(owner.cookie)).statusCode).toBe(401);
    expect((await me(second.cookie)).statusCode).toBe(200);
    const rows = await sessionRows();
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('hash dengan parameter lama diperbarui saat login berhasil', async () => {
    const password = 'sandi-lama-masih-benar-77';
    const weakHash = await hash(password, {
      algorithm: 2,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    const user = await addUser('cs', password, { passwordHash: weakHash });

    await login(harness.app, { email: user.email, password });

    const [updated] = await harness.db.select().from(users).where(eq(users.id, user.id));
    expect(updated?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(login(harness.app, { email: user.email, password })).resolves.toBeDefined();
  });

  it('IP yang bukan alamat sah (lewat proxy tepercaya) tidak membuat login gagal', async () => {
    await harness.rebuild({ config: { trustProxy: true } });

    const cs = await addCs();
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: CS_PASSWORD },
      { headers: { 'x-forwarded-for': 'bukan-alamat-ip' } },
    );
    await harness.rebuild();

    expect(response.statusCode).toBe(200);
    expect((await sessionRowOf(sessionCookieOf(response)))?.ipAddress).toBeNull();
  });
});

describe('cookie sesi lewat HTTPS', () => {
  it('memakai awalan __Host- dan Secure; cookie bernama polos tidak diterima', async () => {
    await harness.rebuild({
      config: { cookieSecure: true, appOrigin: 'https://balesin.contoh.test' },
    });
    const origin = 'https://balesin.contoh.test';
    const cs = await addCs();

    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: CS_PASSWORD },
      { origin },
    );
    const [cookie] = setCookies(response);
    const pair = cookie?.split(';')[0] ?? '';
    const token = pair.split('=')[1] ?? '';

    expect(cookie).toMatch(
      /^__Host-balesin_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/,
    );
    expect(cookie).not.toMatch(/domain=/i);
    expect((await me(pair)).statusCode).toBe(200);
    expect((await me(`balesin_session=${token}`)).statusCode).toBe(401);

    await harness.rebuild();
  });
});

describe('GET /auth/me dan masa berlaku sesi', () => {
  it('mengembalikan pengguna, organisasi, dan token CSRF yang sama dengan saat login', async () => {
    const response = await me(owner.cookie);

    expect(response.statusCode).toBe(200);
    const session = authenticatedSessionSchema.parse(response.json());
    expect(session.user).toEqual(owner.session.user);
    expect(session.organization).toEqual(owner.session.organization);
    expect(session.csrfToken).toBe(owner.csrf);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.json<object>()).sort()).toEqual([
      'csrfToken',
      'organization',
      'permissions',
      'session',
      'status',
      'user',
    ]);
  });

  it('tanpa cookie, cookie ngawur, atau cookie ganda: 401', async () => {
    const token = owner.cookie.split('=')[1] ?? '';

    const responses = [
      await me(),
      await me('balesin_session=bukan-token'),
      await me(`balesin_session=${'A'.repeat(43)}`),
      // Nama yang sama dua kali (cookie sisipan): tidak satu pun dipercaya.
      await me(`balesin_session=${'B'.repeat(43)}; ${owner.cookie}`),
      await me(`${owner.cookie}; balesin_session=${token}`),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(errorOf(response).code).toBe('UNAUTHENTICATED');
    }
    expect(errorOf(responses[0] as Response).message).toBe('Masuk dulu untuk melanjutkan.');
  });

  it.each([
    ['lewat batas idle', { idleExpiresAt: sql`now() - interval '1 second'` }],
    [
      'lewat batas mutlak',
      {
        idleExpiresAt: sql`now() - interval '1 second'`,
        absoluteExpiresAt: sql`now() - interval '1 second'`,
      },
    ],
    ['dicabut', { revokedAt: sql`now()` }],
  ])('sesi %s: 401 dan cookie dihapus', async (_label, change) => {
    await harness.db.update(userSessions).set(change);

    const response = await me(owner.cookie);

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).message).toBe(
      'Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.',
    );
    expect(setCookies(response)).toEqual([
      'balesin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
  });

  it('aktivitas tidak pernah menggeser batas idle melewati batas mutlak', async () => {
    // Sesi yang batas mutlaknya tinggal 1 detik, dan sudah waktunya digeser (terakhir terlihat
    // 10 menit lalu).
    await harness.db.update(userSessions).set({
      idleExpiresAt: sql`now() + interval '1 second'`,
      absoluteExpiresAt: sql`now() + interval '1 second'`,
      lastSeenAt: sql`now() - interval '10 minutes'`,
    });

    expect((await me(owner.cookie)).statusCode).toBe(200);
    const row = await sessionRowOf(owner.cookie);
    expect(row?.idleExpiresAt.getTime()).toBe(row?.absoluteExpiresAt.getTime());

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await me(owner.cookie)).statusCode).toBe(401);
  });

  it('aktivitas menggeser batas idle (paling sering sekali per menit)', async () => {
    await harness.db.update(userSessions).set({
      idleExpiresAt: sql`now() + interval '5 minutes'`,
      lastSeenAt: sql`now() - interval '2 minutes'`,
    });

    const response = await me(owner.cookie);
    const touched = await sessionRowOf(owner.cookie);
    const idleHours = ((touched?.idleExpiresAt.getTime() ?? 0) - Date.now()) / 3_600_000;

    expect(idleHours).toBeGreaterThan(11.9);
    expect(authenticatedSessionSchema.parse(response.json()).session.idleExpiresAt).toBe(
      touched?.idleExpiresAt.toISOString(),
    );

    // Permintaan berikutnya (baru saja terlihat) tidak menulis ulang.
    await me(owner.cookie);
    const again = await sessionRowOf(owner.cookie);
    expect(again?.updatedAt.getTime()).toBe(touched?.updatedAt.getTime());
  });

  it('menonaktifkan akun langsung mematikan sesinya', async () => {
    await harness.db.update(users).set({ disabledAt: new Date() });

    expect((await me(owner.cookie)).statusCode).toBe(401);
  });
});

describe('CSRF dan POST /auth/logout', () => {
  const logout = (options: Parameters<typeof call>[4]) =>
    call(harness.app, 'POST', API_ROUTES.auth.logout, undefined, options);

  it('tanpa token CSRF, token salah, atau token milik sesi lain: 403 dan sesi tetap hidup', async () => {
    const other = await login(harness.app);
    // `login` di atas tidak membawa cookie lama, jadi sesi `owner` tetap aktif.

    const responses = [
      await logout({ cookie: owner.cookie }),
      await logout({ cookie: owner.cookie, csrf: 'token-csrf-ngawur' }),
      await logout({ cookie: owner.cookie, csrf: other.csrf }),
      await logout({ cookie: owner.cookie, csrf: `${owner.csrf}x` }),
      await logout({ cookie: owner.cookie, csrf: 'x'.repeat(5_000) }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('CSRF_INVALID');
    }
    expect(errorOf(responses[0] as Response).message).toContain('Muat ulang halaman');
    expect((await me(owner.cookie)).statusCode).toBe(200);
    expect(await auditActions()).not.toContain('auth.logout');
  });

  it('token CSRF benar tetapi Origin asing atau tidak ada: ditolak', async () => {
    const foreign = await logout({
      cookie: owner.cookie,
      csrf: owner.csrf,
      origin: 'https://jahat.example',
    });
    const sibling = await logout({
      cookie: owner.cookie,
      csrf: owner.csrf,
      origin: `${TEST_APP_ORIGIN}.jahat.example`,
    });
    const missing = await logout({ cookie: owner.cookie, csrf: owner.csrf, origin: null });

    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe('FORBIDDEN');
    expect(sibling.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('CSRF_INVALID');
    expect((await me(owner.cookie)).statusCode).toBe(200);
  });

  it('tanpa sesi: 401 (bukan 403), sehingga web tahu harus ke halaman masuk', async () => {
    const response = await logout({ csrf: owner.csrf });

    expect(response.statusCode).toBe(401);
  });

  it('logout mencabut sesi, menghapus cookie, dan tercatat di audit', async () => {
    const response = await logout({ cookie: owner.cookie, csrf: owner.csrf });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'logged_out' });
    expect(setCookies(response)).toEqual([
      'balesin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
    expect((await me(owner.cookie)).statusCode).toBe(401);
    const row = await sessionRowOf(owner.cookie);
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(await auditActions()).toContain('auth.logout');

    // Token CSRF sesi yang sudah dicabut tidak berguna lagi.
    expect((await logout({ cookie: owner.cookie, csrf: owner.csrf })).statusCode).toBe(401);
  });
});

describe('brute force: kunci per asal, per akun, perangkat dikenal, dan batas per IP', () => {
  const WRONG = 'tebakan-password-salah';
  const LOCKED_MESSAGE =
    'Akun ini dikunci sementara karena terlalu banyak percobaan masuk yang gagal.';

  it('5 kali gagal dari satu IP → email itu dikunci 15 menit DARI IP ITU, termasuk password benar', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await tryLogin(OWNER.email, `${WRONG}-${attempt}`, '203.0.113.9')).statusCode);
    }
    const correct = await tryLogin(OWNER.email, OWNER.password, '203.0.113.9');

    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect(correct.statusCode).toBe(429);
    expect(errorOf(correct).code).toBe('RATE_LIMITED');
    expect(errorOf(correct).message).toBe(LOCKED_MESSAGE);
    expect(Number(correct.headers['retry-after'])).toBeGreaterThan(890);
    expect(Number(correct.headers['retry-after'])).toBeLessThanOrEqual(900);
    expect(setCookies(correct)).toEqual([]);

    // Sesi yang sudah ada tidak ikut mati: kunci hanya menahan percobaan masuk baru.
    expect((await me(owner.cookie)).statusCode).toBe(200);
  });

  it('pemilik akun dari jaringan lain TIDAK ikut terkunci oleh percobaan orang lain (S1)', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tryLogin(OWNER.email, `${WRONG}-${attempt}`, '203.0.113.66');
    }

    const elsewhere = await tryLogin(OWNER.email, OWNER.password, '198.51.100.20');
    expect(elsewhere.statusCode).toBe(200);
    // Kunci per asal tidak ditulis ke users.locked_until (bukan kunci akun).
    const [user] = await harness.db.select().from(users);
    expect(user?.lockedUntil).toBeNull();
  });

  it('kunci tercatat di audit; email pemberitahuan paling banyak sekali per jam, hanya berisi ID', async () => {
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await tryLogin(OWNER.email, `${WRONG}-${attempt}`, ip);
      }
    }
    await expect.poll(() => harness.lockedNotifications.length).toBe(1);

    // Per asal: 5 percobaan diperiksa passwordnya + 1 ditolak karena sudah terkunci.
    const perSource = [...Array<string>(5).fill('wrong_password'), 'locked'];
    expect(await failedLoginReasons()).toEqual([...perSource, ...perSource]);
    const locks = (await harness.db.select().from(auditLogs)).filter(
      (row) => row.action === 'auth.account.locked',
    );
    expect(locks).toHaveLength(2);
    for (const row of locks) {
      expect(row).toMatchObject({
        targetType: 'user',
        targetId: owner.session.user.id,
        metadata: { scope: 'source', failedAttempts: 5 },
      });
    }

    // Kunci kedua dalam jam yang sama tidak mengirim email lagi.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.lockedNotifications).toHaveLength(1);
    const [notification] = harness.lockedNotifications;
    expect(Object.keys(notification ?? {}).sort()).toEqual([
      'lockedUntil',
      'organizationId',
      'scope',
      'userId',
    ]);
    expect(notification).toMatchObject({
      organizationId: owner.session.organization.id,
      userId: owner.session.user.id,
      scope: 'source',
    });
  });

  it('pengantre notifikasi yang gagal tidak menggagalkan jawaban login', async () => {
    await harness.rebuild({
      notifier: {
        accountLocked: () => Promise.reject(new Error('antrian tidak tersedia')),
        securityNotice: () => Promise.reject(new Error('antrian tidak tersedia')),
        securityNoticeAdmin: () => Promise.reject(new Error('antrian tidak tersedia')),
        invitation: () => Promise.reject(new Error('antrian tidak tersedia')),
        accountToken: () => Promise.reject(new Error('antrian tidak tersedia')),
        emailSettingsChanged: () => Promise.reject(new Error('antrian tidak tersedia')),
      },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await tryLogin(OWNER.email, `${WRONG}-${attempt}`)).statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    await expect
      .poll(() =>
        harness.logs.entries().some((entry) => entry.msg === 'Gagal mengantre email kunci akun'),
      )
      .toBe(true);
    await harness.rebuild();
  });

  it('email tidak terdaftar "terkunci" dengan cara yang sama — tidak bisa dibedakan dari akun sungguhan', async () => {
    const run = async (email: string, ip: string) => {
      const results: Array<ReturnType<typeof comparable>> = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        results.push(comparable(await tryLogin(email, `${WRONG}-${attempt}`, ip)));
      }
      return results;
    };

    const real = await run(OWNER.email, '203.0.113.40');
    const ghost = await run('hantu@majujaya.test', '198.51.100.40');

    expect(real.map((result) => result.status)).toEqual([401, 401, 401, 401, 429, 429, 429]);
    // Retry-After bisa berbeda satu detik antar-permintaan; sisanya harus identik.
    const normalize = (results: typeof real) =>
      results.map((result) => ({
        ...result,
        headers: {
          ...result.headers,
          'retry-after': result.headers['retry-after'] ? 'ada' : 'tidak',
        },
      }));
    expect(normalize(ghost)).toEqual(normalize(real));
    expect(harness.lockedNotifications).toHaveLength(1);
    expect(harness.lockedNotifications[0]?.userId).toBe(owner.session.user.id);
    // Kunci email tidak terdaftar juga tercatat (tanpa target, email tersamar).
    const ghostLock = (await harness.db.select().from(auditLogs)).find(
      (row) => row.action === 'auth.account.locked' && row.targetId === null,
    );
    expect(ghostLock?.metadata).toMatchObject({ scope: 'source', email: 'h***@majujaya.test' });
  });

  it('serbuan bersamaan dari satu asal tetap hanya mendapat 5 kali pemeriksaan password', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        tryLogin(OWNER.email, `${WRONG}-${index}`, '203.0.113.55'),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(4);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    // Setiap percobaan tercatat, tetapi paling banyak 5 yang sampai ke pemeriksaan password.
    const reasons = await failedLoginReasons();
    expect(reasons).toHaveLength(12);
    expect(reasons.filter((reason) => reason !== 'locked').length).toBeLessThanOrEqual(5);
  });

  it('tebakan tersebar dari banyak IP: email dikunci untuk perangkat baru, perangkat dikenal tetap bisa masuk', async () => {
    const device = deviceCookieOf(await loginResponse(harness.app));

    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_ACCOUNT_RULE.limit + 3; attempt += 1) {
      const ip = `198.18.${Math.floor(attempt / 200)}.${(attempt % 200) + 1}`;
      statuses.push((await tryLogin(OWNER.email, `${WRONG}-${attempt}`, ip)).statusCode);
    }
    expect(statuses.slice(0, LOGIN_ACCOUNT_RULE.limit - 1).every((status) => status === 401)).toBe(
      true,
    );
    expect(statuses.slice(LOGIN_ACCOUNT_RULE.limit - 1)).toEqual([429, 429, 429, 429]);
    const reasons = await failedLoginReasons();
    expect(reasons.filter((reason) => reason !== 'locked')).toHaveLength(LOGIN_ACCOUNT_RULE.limit);

    // Perangkat baru dari jaringan baru: terkunci. Perangkat dikenal: tetap masuk.
    const newDevice = await tryLogin(OWNER.email, OWNER.password, '192.0.2.10');
    const knownDevice = await tryLogin(OWNER.email, OWNER.password, '192.0.2.11', device);
    expect(newDevice.statusCode).toBe(429);
    expect(knownDevice.statusCode).toBe(200);

    const accountLock = (await harness.db.select().from(auditLogs)).find(
      (row) => row.action === 'auth.account.locked',
    );
    expect(accountLock?.metadata).toMatchObject({
      scope: 'account',
      failedAttempts: LOGIN_ACCOUNT_RULE.limit,
    });
    // Kunci lingkup akun dicatat di users.locked_until (untuk tampilan admin).
    const [user] = await harness.db.select().from(users);
    const lockMinutes = ((user?.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(lockMinutes).toBeGreaterThan(14.5);
    expect(lockMinutes).toBeLessThan(15.5);
  }, 60_000);

  it('perangkat dikenal tidak terkena kunci yang dipicu orang lain di jaringan yang sama', async () => {
    const office = '203.0.113.88';
    const device = deviceCookieOf(await loginResponse(harness.app, OWNER, { ip: office }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tryLogin(OWNER.email, `${WRONG}-${attempt}`, office);
    }
    expect((await tryLogin(OWNER.email, OWNER.password, office)).statusCode).toBe(429);
    expect((await tryLogin(OWNER.email, OWNER.password, office, device)).statusCode).toBe(200);
  });

  it('perangkat dikenal punya kuncinya sendiri: 5 gagal dari perangkat itu → 429 untuk perangkat itu', async () => {
    const device = deviceCookieOf(await loginResponse(harness.app));

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (await tryLogin(OWNER.email, `${WRONG}-${attempt}`, '203.0.113.31', device)).statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
    // Tanpa cookie itu (asal yang sama) belum ada kunci asal.
    expect((await tryLogin(OWNER.email, OWNER.password, '203.0.113.31')).statusCode).toBe(200);
    const deviceLock = (await harness.db.select().from(auditLogs)).find(
      (row) => row.action === 'auth.account.locked',
    );
    expect(deviceLock?.metadata).toMatchObject({ scope: 'device' });
  });

  it('cookie perangkat milik akun lain, palsu, atau rusak tidak dianggap perangkat dikenal', async () => {
    const password = 'sandi-pengguna-cs-panjang';
    const cs = await addUser('cs', password);
    const csDevice = deviceCookieOf(
      await call(harness.app, 'POST', API_ROUTES.auth.login, { email: cs.email, password }),
    );
    const [name = '', value = ''] = csDevice.split('=');
    const forged = `${name}=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tryLogin(OWNER.email, `${WRONG}-${attempt}`, '203.0.113.99');
    }
    for (const cookie of [csDevice, forged, `${name}=v1.rusak`]) {
      expect((await tryLogin(OWNER.email, OWNER.password, '203.0.113.99', cookie)).statusCode).toBe(
        429,
      );
    }
  });

  it('cookie perangkat: HttpOnly, SameSite=Strict, 90 hari, dan tidak dihapus saat logout', async () => {
    const response = await loginResponse(harness.app);
    const cookie = setCookies(response).find((value) => value.startsWith('balesin_device='));
    expect(cookie).toMatch(
      /^balesin_device=v1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/,
    );

    const session = authenticatedSessionSchema.parse(response.json());
    const logout = await call(harness.app, 'POST', API_ROUTES.auth.logout, undefined, {
      cookie: sessionCookieOf(response),
      csrf: session.csrfToken,
    });
    expect(setCookies(logout).some((value) => value.startsWith('balesin_device='))).toBe(false);
  });

  it('login berhasil menghapus hitungan gagal asal itu', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await tryLogin(OWNER.email, WRONG);
    await login(harness.app);
    // Hitungan mulai dari nol lagi: 4 kali gagal berikutnya belum mengunci.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await tryLogin(OWNER.email, WRONG)).statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
    expect((await tryLogin(OWNER.email, WRONG)).statusCode).toBe(429);
  });

  it('users.locked_until hanya catatan: tidak memutuskan login (jawaban tidak membuka akun, R1)', async () => {
    await harness.db.update(users).set({ lockedUntil: sql`now() + interval '10 minutes'` });

    expect((await tryLogin(OWNER.email, WRONG)).statusCode).toBe(401);
    expect((await tryLogin(OWNER.email, OWNER.password)).statusCode).toBe(200);
  });

  it('batas per IP: banyak email dari satu alamat dihentikan; login berhasil tidak dihitung', async () => {
    const ip = '203.0.113.77';
    // Login berhasil berkali-kali dari IP ini tidak mengurangi jatah.
    for (let attempt = 0; attempt < 3; attempt += 1) await login(harness.app, OWNER, { ip });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_IP_RULE.limit + 1; attempt += 1) {
      statuses.push((await tryLogin(`korban-${attempt}@majujaya.test`, WRONG, ip)).statusCode);
    }
    const blocked = await tryLogin(OWNER.email, OWNER.password, ip);
    const elsewhere = await tryLogin(OWNER.email, OWNER.password, '198.51.100.99');

    expect(statuses.slice(0, LOGIN_IP_RULE.limit)).toEqual(
      Array<number>(LOGIN_IP_RULE.limit).fill(401),
    );
    expect(statuses.at(-1)).toBe(429);
    expect(blocked.statusCode).toBe(429);
    expect(errorOf(blocked).message).toMatch(/^Terlalu banyak percobaan masuk dari jaringanmu\.$/);
    expect(elsewhere.statusCode).toBe(200);
  });

  it('alamat IPv6 dalam satu /64 berbagi jatah yang sama', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_IP_RULE.limit + 1; attempt += 1) {
      statuses.push(
        (
          await tryLogin(
            `korban6-${attempt}@majujaya.test`,
            WRONG,
            `2001:db8:abcd:12::${(attempt + 1).toString(16)}`,
          )
        ).statusCode,
      );
    }

    expect(statuses.at(-1)).toBe(429);
    expect((await tryLogin(OWNER.email, OWNER.password, '2001:db8:abcd:13::1')).statusCode).toBe(
      200,
    );
  });
});

describe('hook auth: bawaan tolak, peran, dan rute pelengkap 405', () => {
  it('rute terlindungi tanpa sesi dijawab 401 untuk SEMUA metode (peta rute tidak terbuka)', async () => {
    for (const method of ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'] as const) {
      const response = await call(harness.app, method, API_ROUTES.settings.email);
      expect(response.statusCode, method).toBe(401);
      expect(response.headers.allow, method).toBeUndefined();
    }
    const wrongOnMe = await call(harness.app, 'DELETE', API_ROUTES.auth.me);
    expect(wrongOnMe.statusCode).toBe(401);
  });

  it('dengan sesi, metode salah dijawab 405 + Allow; rute publik tetap 405 tanpa sesi', async () => {
    const authenticated = await call(harness.app, 'DELETE', API_ROUTES.auth.me, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    const publicRoute = await call(harness.app, 'PUT', API_ROUTES.auth.login);
    const missing = await call(harness.app, 'GET', '/api/v1/tidak-ada');

    expect(authenticated.statusCode).toBe(405);
    expect(authenticated.headers.allow).toBe('GET, HEAD');
    expect(publicRoute.statusCode).toBe(405);
    expect(publicRoute.headers.allow).toBe('POST');
    expect(missing.statusCode).toBe(404);
  });

  it('rute ber-izin: peran tanpa izin 403, tanpa sesi 401; identitas datang dari sesi, bukan input', async () => {
    const reply = { 200: z.object({ role: z.string(), organizationId: z.string() }) };
    await harness.rebuild();
    harness.app.get(
      '/__tes/ber-izin',
      // broadcast.send: Owner, Admin, Supervisor (PRD §4) — CS dan Teknisi tidak.
      { config: { access: requirePermission('broadcast.send') }, schema: { response: reply } },
      (request, response) => {
        void response.send({
          role: request.auth?.user.role ?? '',
          organizationId: request.auth?.organizationId ?? '',
        });
      },
    );
    harness.app.get(
      '/__tes/siapa-saja',
      { config: { access: AUTHENTICATED }, schema: { response: reply } },
      (request, response) => {
        void response.send({
          role: request.auth?.user.role ?? '',
          organizationId: request.auth?.organizationId ?? '',
        });
      },
    );
    const password = 'sandi-uji-peran-berbeda-1';
    const signIn = async (role: UserRole) => {
      const user = await addUser(role, password);
      return login(harness.app, { email: user.email, password });
    };
    const admin = await signIn('admin');
    const supervisor = await signIn('supervisor');
    const cs = await signIn('cs');
    const teknisi = await signIn('teknisi');
    const get = (url: string, cookie?: string) =>
      call(harness.app, 'GET', url, undefined, { cookie });

    expect((await get('/__tes/ber-izin')).statusCode).toBe(401);
    expect((await get('/__tes/ber-izin', owner.cookie)).statusCode).toBe(200);
    expect((await get('/__tes/ber-izin', cs.cookie)).statusCode).toBe(403);
    expect((await get('/__tes/ber-izin', teknisi.cookie)).statusCode).toBe(403);
    expect((await get('/__tes/ber-izin', admin.cookie)).json()).toEqual({
      role: 'admin',
      organizationId: owner.session.organization.id,
    });
    expect((await get('/__tes/ber-izin', supervisor.cookie)).statusCode).toBe(200);
    expect((await get('/__tes/siapa-saja', teknisi.cookie)).statusCode).toBe(200);
    expect(errorOf(await get('/__tes/ber-izin', cs.cookie)).message).toBe(
      'Kamu tidak punya izin untuk melakukan tindakan ini.',
    );
  });

  it('sesi tidak bisa dipindah ke organisasi lain (dijaga foreign key komposit)', async () => {
    const [session] = await sessionRows();
    const [other] = await harness.db
      .insert(organizations)
      .values({ name: 'Organisasi Lain' })
      .returning();
    if (!session || !other) throw new Error('data uji tidak lengkap');

    await expect(
      harness.db
        .update(userSessions)
        .set({ organizationId: other.id })
        .where(eq(userSessions.id, session.id)),
    ).rejects.toThrow();
    expect((await me(owner.cookie)).statusCode).toBe(200);
  });
});

describe('Redis mati', () => {
  it('login ditolak 503 (gagal tertutup), bukan diloloskan tanpa batas laju', async () => {
    await harness.rebuild({ redis: false });

    const response = await tryLogin(OWNER.email, OWNER.password);

    expect(response.statusCode).toBe(503);
    expect(errorOf(response).code).toBe('SERVICE_UNAVAILABLE');
    expect(setCookies(response)).toEqual([]);
    await harness.rebuild();
  });
});
