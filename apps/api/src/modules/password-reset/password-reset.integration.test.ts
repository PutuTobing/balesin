/**
 * Atur ulang password (ROADMAP Fase 1 butir 4) di atas Postgres + Redis sungguhan: jawaban sama
 * untuk email terdaftar/tidak, token (hash, sekali pakai, 30 menit, terikat email), wajib kode 2FA
 * untuk akun ber-2FA (tidak bisa memotong 2FA), semua sesi dicabut, cookie perangkat lama batal,
 * kunci login dilepas, tanpa email pengirim = tidak tersedia.
 */
import {
  accountTokenDeliveryContext,
  createSecretBox,
  generateTotp,
  Secret,
  sha256Hex,
} from '@balesin/core';
import { accountTokens, auditLogs, userSessions, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  errorEnvelopeSchema,
  inspectPasswordResetResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  loginResponse,
  deviceCookieOf,
  mailpitSettings,
  OWNER,
  startLogin,
  TEST_MASTER_KEY,
  type CallOptions,
  type IntegrationHarness,
  type SignedIn,
  type SignedInWithTwoFactor,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

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
const routes = API_ROUTES.passwordReset;
const NEW_PASSWORD = 'layang-layang-senja-merah';

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

async function configureEmail(owner: SignedIn) {
  const saved = await call(
    harness.app,
    'PUT',
    API_ROUTES.settings.email,
    mailpitSettings(),
    as(owner),
  );
  if (saved.statusCode !== 200) throw new Error(`Simpan email gagal: ${saved.body}`);
}

const requestReset = (email: string, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.request, { email }, options);
const inspect = (token: string, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.inspect, { token }, options);
const complete = (body: Record<string, unknown>, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.complete, body, options);

/** Minta tautan lalu ambil tokennya dari salinan untuk worker (seperti isi email). */
async function resetToken(email: string, options: CallOptions = {}): Promise<string> {
  const response = await requestReset(email, options);
  if (response.statusCode !== 202) throw new Error(`Minta reset gagal: ${response.body}`);
  await harness.app.backgroundTasks.drain();
  const [row] = await harness.db
    .select()
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.email, email),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
      ),
    );
  if (!row?.deliveryTokenEncrypted) throw new Error('Tidak ada token');
  return box.decrypt(
    row.deliveryTokenEncrypted,
    accountTokenDeliveryContext(row.organizationId, row.id),
  );
}

async function addUser(owner: SignedIn, role: UserRole, password: string) {
  return insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
  });
}

/** Kode 6 digit yang pasti salah sekarang. */
function wrongCode(secret: string): string {
  const valid = new Set(
    [-1, 0, 1].map((drift) => generateTotp(secret, Date.now() + drift * 30_000)),
  );
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe('tanpa email pengirim', () => {
  it('tidak tersedia: status false, permintaan 503 — sama untuk email terdaftar maupun tidak', async () => {
    await completeSetup(harness.app);
    const status = await call(harness.app, 'GET', routes.status);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ available: false });

    const registered = await requestReset(OWNER.email);
    const unknown = await requestReset('tidak.ada@majujaya.test');
    expect(registered.statusCode).toBe(503);
    expect(unknown.statusCode).toBe(503);
    expect(errorOf(registered).message).toBe(errorOf(unknown).message);
    expect(errorOf(registered).message).toContain('email pengirim belum diatur');
    await harness.app.backgroundTasks.drain();
    expect(await harness.db.select().from(accountTokens)).toEqual([]);
  });

  it('sebelum setup: tidak tersedia', async () => {
    expect((await call(harness.app, 'GET', routes.status)).json()).toEqual({ available: false });
  });
});

describe('minta tautan', () => {
  it('jawaban sama untuk email terdaftar dan tidak; token hanya untuk akun aktif, payload ID saja', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    expect((await call(harness.app, 'GET', routes.status)).json()).toEqual({ available: true });

    const registered = await requestReset(OWNER.email);
    const unknown = await requestReset('tidak.ada@majujaya.test');
    for (const response of [registered, unknown]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'accepted', validMinutes: 30 });
    }
    expect(Object.keys(registered.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    await harness.app.backgroundTasks.drain();

    const tokens = await harness.db.select().from(accountTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      purpose: 'password_reset',
      email: OWNER.email,
      userId: owner.session.user.id,
      deliveryStatus: 'queued',
    });
    const minutes =
      ((tokens[0]?.expiresAt.getTime() ?? 0) - (tokens[0]?.createdAt.getTime() ?? 0)) / 60_000;
    expect(minutes).toBeCloseTo(30, 3);
    expect(harness.accountTokenJobs).toEqual([
      { organizationId: owner.session.organization.id, tokenId: tokens[0]?.id },
    ]);

    const requested = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.password_reset.requested'));
    expect(requested.map((row) => row.metadata.matched).sort()).toEqual([false, true]);
    expect(JSON.stringify(requested)).not.toContain('tidak.ada@majujaya.test');
  });

  it('jawaban tidak menunggu pencarian akun + pengantrean email (dikerjakan setelah menjawab)', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await harness.rebuild({
      notifier: {
        accountLocked: () => Promise.resolve(),
        securityNotice: () => Promise.resolve(),
        securityNoticeAdmin: () => Promise.resolve(),
        invitation: () => Promise.resolve(),
        accountToken: () => blocked,
      },
    });
    const started = Date.now();
    const response = await requestReset(OWNER.email);
    expect(response.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await harness.app.backgroundTasks.drain();
    await harness.rebuild();
  });

  it('meminta lagi membatalkan tautan sebelumnya', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const first = await resetToken(OWNER.email);
    const second = await resetToken(OWNER.email);
    expect(second).not.toBe(first);
    const old = await inspect(first);
    expect(old.statusCode).toBe(410);
    expect((await inspect(second)).statusCode).toBe(200);
  });

  it('batas laju per email (terdaftar atau tidak, sama) dan per IP', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const run = async (email: string, ip: string) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        statuses.push((await requestReset(email, { ip })).statusCode);
      }
      return statuses;
    };
    expect(await run(OWNER.email, '198.51.100.1')).toEqual([202, 202, 202, 429]);
    expect(await run('tidak.ada@majujaya.test', '198.51.100.2')).toEqual([202, 202, 202, 429]);

    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      statuses.push(
        (await requestReset(`ip-${index}@majujaya.test`, { ip: '198.51.100.3' })).statusCode,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
    await harness.app.backgroundTasks.drain();
  });

  it('akun nonaktif: tidak ada token, jawaban tetap sama', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const cs = await addUser(owner, 'cs', 'sandi-cs-nonaktif-01');
    await harness.db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, cs.id));
    expect((await requestReset(cs.email)).statusCode).toBe(202);
    await harness.app.backgroundTasks.drain();
    expect(await harness.db.select().from(accountTokens)).toEqual([]);
  });
});

describe('menyelesaikan atur ulang password', () => {
  it('akun tanpa 2FA: password baru berlaku, semua sesi dicabut, sekali pakai, email pemberitahuan', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const password = 'sandi-cs-lama-sekali-01';
    const cs = await addUser(owner, 'cs', password);
    const first = await login(harness.app, { email: cs.email, password });
    const second = await login(harness.app, { email: cs.email, password });

    const token = await resetToken(cs.email, { ip: '203.0.113.9' });
    const opened = await inspect(token);
    expect(opened.statusCode).toBe(200);
    expect(inspectPasswordResetResponseSchema.parse(opened.json())).toMatchObject({
      email: cs.email,
      twoFactorRequired: false,
      methods: [],
    });

    const done = await complete({ token, password: NEW_PASSWORD }, { ip: '203.0.113.9' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: 'password_reset' });
    expect(done.headers['set-cookie']).toBeUndefined();

    for (const signed of [first, second]) {
      const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
        cookie: signed.cookie,
      });
      expect(me.statusCode).toBe(401);
    }
    const active = await harness.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, cs.id), isNull(userSessions.revokedAt)));
    expect(active).toEqual([]);

    const oldLogin = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: cs.email,
      password,
    });
    expect(oldLogin.statusCode).toBe(401);
    expect(
      (await login(harness.app, { email: cs.email, password: NEW_PASSWORD })).session.user.id,
    ).toBe(cs.id);

    const reused = await complete({ token, password: 'password-lain-yang-kuat-sekali' });
    expect(reused.statusCode).toBe(410);
    expect(errorOf(reused).message).toContain('sudah dipakai');

    const [user] = await harness.db.select().from(users).where(eq(users.id, cs.id));
    expect(user?.passwordChangedAt).toBeInstanceOf(Date);
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    const [completedAudit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.password_reset.completed'));
    expect(completedAudit?.metadata).toMatchObject({ twoFactor: null, revokedSessions: 2 });
    expect(completedAudit?.ipAddress).toBe('203.0.113.9');
    expect(harness.securityNotices.at(-1)).toMatchObject({
      event: 'password_changed',
      userId: cs.id,
      auditLogId: completedAudit?.id,
    });
    const everything = `${harness.logs.text()}${JSON.stringify(await harness.db.select().from(auditLogs))}${JSON.stringify(harness.accountTokenJobs)}`;
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(NEW_PASSWORD);
  });

  it('akun ber-2FA: tanpa kode atau kode salah ditolak — atur ulang password tidak memotong 2FA', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const token = await resetToken(OWNER.email);
    const opened = inspectPasswordResetResponseSchema.parse((await inspect(token)).json());
    expect(opened).toMatchObject({ twoFactorRequired: true, methods: ['totp', 'backup_code'] });

    const missing = await complete({ token, password: NEW_PASSWORD });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).details?.[0]?.field).toBe('code');

    const wrong = wrongCode(owner.totpSecret);
    const first = await complete({ token, password: NEW_PASSWORD, code: wrong });
    expect(first.statusCode).toBe(400);
    expect(errorOf(first).message).toContain('Sisa 2 percobaan');
    expect((await complete({ token, password: NEW_PASSWORD, code: wrong })).statusCode).toBe(400);
    const third = await complete({ token, password: NEW_PASSWORD, code: wrong });
    expect(third.statusCode).toBe(410);
    expect(errorOf(third).message).toContain('Kode salah 3 kali');
    // Tautan hangus walaupun kode benar sesudahnya.
    const late = await complete({
      token,
      password: NEW_PASSWORD,
      code: await freshTotpCode(OWNER.email),
    });
    expect(late.statusCode).toBe(410);

    // Password lama tetap berlaku.
    expect((await startLogin(harness.app, OWNER)).body.status).toBe('two_factor_required');
    const failed = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.2fa.failed'));
    expect(failed.filter((row) => row.metadata.usage === 'password_reset')).toHaveLength(3);
  });

  it('akun ber-2FA: kode autentikator benar → berhasil; kode yang sama tidak bisa dipakai lagi', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const token = await resetToken(OWNER.email);
    const code = await freshTotpCode(OWNER.email);
    const done = await complete({ token, password: NEW_PASSWORD, code });
    expect(done.statusCode).toBe(200);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.password_reset.completed'));
    expect(audit?.metadata).toMatchObject({ twoFactor: 'totp' });
    expect(
      (await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(401);

    // Kode yang sama (replay) ditolak di langkah kedua saat masuk.
    const { body } = await startLogin(harness.app, { email: OWNER.email, password: NEW_PASSWORD });
    if (body.status !== 'two_factor_required') throw new Error(body.status);
    const replay = await call(harness.app, 'POST', API_ROUTES.twoFactor.verify, {
      challengeToken: body.challengeToken,
      code,
    });
    expect(replay.statusCode).toBe(400);
  });

  it('akun ber-2FA: kode cadangan → berhasil, kode itu terpakai, email pemberitahuan', async () => {
    const owner = (await completeSetup(harness.app)) satisfies SignedInWithTwoFactor;
    await configureEmail(owner);
    const token = await resetToken(OWNER.email);
    const backup = owner.backupCodes[0] ?? '';
    const done = await complete({ token, password: NEW_PASSWORD, code: backup });
    expect(done.statusCode).toBe(200);
    const events = harness.securityNotices.map((notice) => notice.event);
    expect(events).toContain('password_changed');
    expect(events).toContain('backup_code_used');
    const [used] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.2fa.backup_code_used'));
    expect(used?.metadata).toEqual({ usage: 'password_reset', remaining: 9 });
  });

  it('kode salah dihitung di ember 2FA akun: ke-5 (gabungan) mengunci langkah kedua + login', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const wrong = wrongCode(owner.totpSecret);
    const statuses: number[] = [];
    // 2 tautan × 2 kode salah + 1 = 5 kode salah dari atur ulang password.
    for (let round = 0; round < 3; round += 1) {
      const token = await resetToken(OWNER.email, { ip: `198.51.100.${10 + round}` });
      for (let attempt = 0; attempt < (round < 2 ? 2 : 1); attempt += 1) {
        statuses.push((await complete({ token, password: NEW_PASSWORD, code: wrong })).statusCode);
      }
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    const login429 = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: OWNER.email,
      password: OWNER.password,
    });
    expect(login429.statusCode).toBe(429);
    expect(harness.lockedNotifications.at(-1)).toMatchObject({
      scope: 'two_factor',
      trigger: 'password_reset',
    });
  });

  it('kebijakan password berlaku; password ditolak tidak membakar token maupun kode', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const token = await resetToken(OWNER.email);
    const code = await freshTotpCode(OWNER.email);
    const weak = await complete({ token, password: 'password123', code });
    expect(weak.statusCode).toBe(400);
    expect(errorOf(weak).details?.[0]?.field).toBe('password');
    const personal = await complete({ token, password: 'sari-wulandari-kuat', code });
    expect(personal.statusCode).toBe(400);
    expect((await complete({ token, password: NEW_PASSWORD, code })).statusCode).toBe(200);
  });

  it('token kedaluwarsa, salah tujuan (verifikasi email), atau email akun sudah berubah → 410', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const password = 'sandi-cs-kedaluwarsa-01';
    const cs = await addUser(owner, 'cs', password);

    const expired = await resetToken(cs.email);
    await harness.db
      .update(accountTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(accountTokens.tokenHash, sha256Hex(expired)));
    const expiredResponse = await complete({ token: expired, password: NEW_PASSWORD });
    expect(expiredResponse.statusCode).toBe(410);
    expect(errorOf(expiredResponse).message).toContain('kedaluwarsa');

    const changed = await resetToken(cs.email);
    await harness.db.update(users).set({ email: 'baru@majujaya.test' }).where(eq(users.id, cs.id));
    expect((await inspect(changed)).statusCode).toBe(410);

    const cs2 = await addUser(owner, 'cs', password);
    const signed = await login(harness.app, { email: cs2.email, password });
    expect(
      (await call(harness.app, 'POST', API_ROUTES.emailVerification.status, {}, as(signed)))
        .statusCode,
    ).toBe(202);
    const [verification] = await harness.db
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.purpose, 'email_verification'));
    if (!verification?.deliveryTokenEncrypted) throw new Error('tidak ada token verifikasi');
    const verificationToken = box.decrypt(
      verification.deliveryTokenEncrypted,
      accountTokenDeliveryContext(verification.organizationId, verification.id),
    );
    expect((await complete({ token: verificationToken, password: NEW_PASSWORD })).statusCode).toBe(
      410,
    );
  });

  it('kunci login karena tebakan password dilepas setelah atur ulang (asal yang sama)', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const password = 'sandi-cs-terkunci-01';
    const cs = await addUser(owner, 'cs', password);
    const ip = { ip: '198.51.100.200' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(
        harness.app,
        'POST',
        API_ROUTES.auth.login,
        { email: cs.email, password: `salah-${attempt}` },
        ip,
      );
    }
    const locked = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password },
      ip,
    );
    expect(locked.statusCode).toBe(429);

    const token = await resetToken(cs.email, ip);
    expect((await complete({ token, password: NEW_PASSWORD }, ip)).statusCode).toBe(200);
    const after = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: NEW_PASSWORD },
      ip,
    );
    expect(after.statusCode).toBe(200);
  });

  it('cookie perangkat dikenal dari sebelum atur ulang tidak diakui lagi', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const password = 'sandi-cs-perangkat-01';
    const cs = await addUser(owner, 'cs', password);
    const device = deviceCookieOf(await loginResponse(harness.app, { email: cs.email, password }));
    const wrongWithDevice = () =>
      call(
        harness.app,
        'POST',
        API_ROUTES.auth.login,
        { email: cs.email, password: 'salah-sekali-ini' },
        { cookie: device },
      );
    const lastFailure = async () => {
      const rows = await harness.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'auth.login.failed'));
      return rows.at(-1)?.metadata;
    };

    expect((await wrongWithDevice()).statusCode).toBe(401);
    expect(await lastFailure()).toMatchObject({ trustedDevice: true });

    const token = await resetToken(cs.email);
    expect((await complete({ token, password: NEW_PASSWORD })).statusCode).toBe(200);

    expect((await wrongWithDevice()).statusCode).toBe(401);
    expect(await lastFailure()).toMatchObject({ trustedDevice: false });
    // Cookie baru dari login sesudah atur ulang diakui lagi.
    const fresh = deviceCookieOf(
      await loginResponse(harness.app, { email: cs.email, password: NEW_PASSWORD }),
    );
    await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: 'salah-lagi' },
      { cookie: fresh },
    );
    expect(await lastFailure()).toMatchObject({ trustedDevice: true });
  });

  it('token acak tidak dikenal: 410 dengan pesan umum; batas per IP', async () => {
    await completeSetup(harness.app);
    const ip = { ip: '198.51.100.250' };
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push(
        (await inspect(`${'C'.repeat(40)}${String(attempt).padStart(3, '0')}`, ip)).statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 410)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
