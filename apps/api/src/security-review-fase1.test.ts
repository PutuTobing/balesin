/**
 * Review keamanan Fase 1 (setup Owner, login/logout, sesi, CSRF, batas laju, kunci akun, email
 * pengirim) — laporan: docs/security-reviews/2026-11-13-fase1-setup-login.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka — isi tesnya menyatakan perilaku yang BENAR, jadi
 * tes itu gagal selama celahnya ada. Setelah celah ditutup Vitest melaporkannya gagal: saat itu
 * hapus `.fails`-nya. Setiap `it.fails` di sini sudah dipastikan gagal karena alasan yang dimaksud.
 */
import { EnvValidationError, isBlockedMailAddress, sha256Hex, type EnvSource } from '@balesin/core';
import { auditLogs, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  emailTestResultSchema,
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import { ACCOUNT_LOCK_FLAG, LOGIN_IP_RULE } from './modules/auth/login-rules';
import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  mailpitSettings,
  OWNER,
  setCookies,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const WRONG = 'password-salah-sekali-123';

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

const tryLogin = (email: string, password: string, ip?: string, headers?: Record<string, string>) =>
  call(harness.app, 'POST', API_ROUTES.auth.login, { email, password }, { ip, headers });

async function addUser(role: UserRole, password: string) {
  return insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
  });
}

/** Kunci Redis penanda "akun terkunci" untuk email ini (awalan acak per berkas tes diabaikan). */
async function deleteLockFlag(email: string): Promise<void> {
  const accountKey = sha256Hex(`login|${email}`).slice(0, 40);
  const keys = await harness.redis.keys(`*:rl:flag:${ACCOUNT_LOCK_FLAG}:${accountKey}`);
  if (keys.length > 0) await harness.redis.del(...keys);
}

// ── RBAC: Pengaturan → Email pengirim ───────────────────────────────────────

// Fase 1 butir 5 (RBAC): Admin kini boleh (`settings.email.manage`, PENGATURAN-UI.md "Owner/Admin");
// penjaga ini tetap untuk peran di bawahnya.
describe('RBAC email pengirim: peran selain Owner/Admin ditolak di server (model ancaman: akun CS dibobol)', () => {
  it('Supervisor/CS/Teknisi dengan sesi + CSRF sah: 403 di SEMUA endpoint, tanpa efek samping', async () => {
    const password = 'sandi-uji-peran-lain-fase1';
    const endpoints: Array<['GET' | 'PUT' | 'POST', string, unknown]> = [
      ['GET', API_ROUTES.settings.email, undefined],
      ['PUT', API_ROUTES.settings.email, mailpitSettings()],
      ['POST', API_ROUTES.settings.detectEmailHost, { emailAddress: 'cs@gmail.com' }],
      ['POST', API_ROUTES.settings.testEmailConnection, { settings: mailpitSettings() }],
      [
        'POST',
        API_ROUTES.settings.sendTestEmail,
        { to: 'korban@contoh.test', settings: mailpitSettings() },
      ],
    ];

    for (const role of ['supervisor', 'cs', 'teknisi'] as const) {
      const user = await addUser(role, password);
      const session = await login(harness.app, { email: user.email, password });
      for (const [method, url, body] of endpoints) {
        const response = await call(harness.app, method, url, body, {
          cookie: session.cookie,
          csrf: session.csrf,
        });
        expect(response.statusCode, `${role} ${method} ${url}`).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
    }

    const audit = await harness.db.select().from(auditLogs);
    expect(audit.map((row) => row.action)).not.toContain('settings.email.updated');
    expect(audit.map((row) => row.action)).not.toContain('settings.email.tested');
  });

  it('HEAD (dibuat otomatis dari GET) ikut dijaga: tanpa sesi 401, peran lain 403', async () => {
    const password = 'sandi-uji-head-fase1-x';
    const cs = await addUser('cs', password);
    const csSession = await login(harness.app, { email: cs.email, password });

    const anonymous = await call(harness.app, 'HEAD', API_ROUTES.settings.email);
    const asCs = await call(harness.app, 'HEAD', API_ROUTES.settings.email, undefined, {
      cookie: csSession.cookie,
    });
    const meAnonymous = await call(harness.app, 'HEAD', API_ROUTES.auth.me);

    expect(anonymous.statusCode).toBe(401);
    expect(asCs.statusCode).toBe(403);
    expect(meAnonymous.statusCode).toBe(401);
  });
});

// ── Pencurian password SMTP tersimpan lewat isi form ────────────────────────

describe('password SMTP tersimpan tidak bisa dibelokkan ke host lain', () => {
  beforeEach(async () => {
    const saved = await call(harness.app, 'PUT', API_ROUTES.settings.email, mailpitSettings(), {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(saved.statusCode).toBe(200);
  });

  it.each([
    ['host lain', { host: '127.0.0.2' }],
    ['port lain', { port: 2525 }],
    ['keamanan lain', { security: 'starttls' as const }],
    ['username lain', { username: 'penyerang' }],
  ])(
    'tes koneksi / kirim tes atas isi form (%s) tanpa password: 400, tidak memakai password tersimpan',
    async (_label, change) => {
      const settings = { ...mailpitSettings(change), password: undefined };
      for (const [url, body] of [
        [API_ROUTES.settings.testEmailConnection, { settings }],
        [API_ROUTES.settings.sendTestEmail, { to: 'tujuan@contoh.test', settings }],
      ] as const) {
        const response = await call(harness.app, 'POST', url, body, {
          cookie: owner.cookie,
          csrf: owner.csrf,
        });
        expect(response.statusCode, url).toBe(400);
        expect(errorOf(response).details?.[0]?.field).toBe('settings.password');
      }
    },
  );

  it('isi form yang tujuannya sama persis boleh memakai password tersimpan', async () => {
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.settings.testEmailConnection,
      { settings: { ...mailpitSettings(), password: undefined } },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(emailTestResultSchema.parse(response.json())).toMatchObject({ ok: true, code: 'ok' });
  });
});

// ── Login: CSRF login, variasi email, X-Forwarded-For ──────────────────────

describe('login: bentuk permintaan lintas situs', () => {
  it('form urlencoded / text/plain: 403 dari origin asing, 415 tanpa Origin; tidak ada cookie', async () => {
    const form = `email=${encodeURIComponent(OWNER.email)}&password=${encodeURIComponent(OWNER.password)}`;
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
      const crossSite = await harness.app.inject({
        method: 'POST',
        url: API_ROUTES.auth.login,
        headers: { origin: 'https://jahat.example', 'content-type': contentType },
        payload: form,
      });
      const noOrigin = await harness.app.inject({
        method: 'POST',
        url: API_ROUTES.auth.login,
        headers: { 'content-type': contentType },
        payload: form,
      });
      expect(crossSite.statusCode, contentType).toBe(403);
      expect(noOrigin.statusCode, contentType).toBe(415);
      expect(setCookies(crossSite)).toEqual([]);
      expect(setCookies(noOrigin)).toEqual([]);
    }
  });

  it('JSON dari Origin "null" (iframe sandbox / pengalihan) ditolak 403', async () => {
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: OWNER.email, password: OWNER.password },
      { origin: 'null' },
    );
    expect(response.statusCode).toBe(403);
    expect(setCookies(response)).toEqual([]);
  });

  it('cookie sesi dari login: HttpOnly, SameSite=Lax, Path=/, tanpa Domain', async () => {
    // Pengguna CS (tidak wajib 2FA): cookie sesi langsung dipasang oleh langkah password.
    const password = 'sandi-cs-untuk-cek-cookie';
    const cs = await insertUser(harness.db, owner.session.organization.id, {
      role: 'cs',
      email: 'cs-cookie@majujaya.test',
      passwordHash: await createPasswordHasher().hash(password),
    });
    const response = await tryLogin(cs.email, password);
    const cookie = setCookies(response).find((value) => value.startsWith('balesin_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie?.toLowerCase()).not.toContain('domain=');
  });
});

describe('kunci akun tidak bisa dilewati dengan variasi penulisan email', () => {
  it('huruf besar + spasi tepi dihitung sebagai akun yang sama', async () => {
    const variants = [
      OWNER.email.toUpperCase(),
      ` ${OWNER.email} `,
      OWNER.email.replace('sari', 'SaRi'),
      `\t${OWNER.email.toUpperCase()}`,
      OWNER.email,
    ];
    const statuses: number[] = [];
    for (const email of variants) statuses.push((await tryLogin(email, WRONG)).statusCode);

    const correct = await tryLogin(OWNER.email, OWNER.password);

    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect(correct.statusCode).toBe(429);
  });

  it('alamat ber-unicode tidak lolos validasi (tidak menjadi kunci hitungan baru untuk akun yang sama)', async () => {
    // "ſ" (long s) dan huruf sirilik "а" mirip huruf latin.
    for (const email of ['ſari@majujaya.test', 'sаri@majujaya.test']) {
      const response = await tryLogin(email, OWNER.password);
      expect([400, 401], email).toContain(response.statusCode);
      expect(setCookies(response)).toEqual([]);
    }
  });

  it('X-Forwarded-For diabaikan tanpa TRUST_PROXY: berganti header tidak memberi jatah IP baru', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_IP_RULE.limit + 1; attempt += 1) {
      const response = await tryLogin(`xff-${attempt}@majujaya.test`, WRONG, '203.0.113.50', {
        'x-forwarded-for': `198.51.100.${attempt + 1}`,
        'x-real-ip': `198.51.100.${attempt + 1}`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

// ── Celah yang masih terbuka ────────────────────────────────────────────────

describe('celah terbuka (lihat laporan)', () => {
  /**
   * S1 — Kunci akun bisa dipakai siapa pun yang tahu email korban untuk mengunci korban terus
   * menerus (5 permintaan / 15 menit). Penyerang yang memegang akun CS bisa mengunci Owner/Admin
   * supaya mereka tidak bisa masuk untuk menonaktifkan akun CS yang dibobol.
   */
  it('S1: penyerang dari satu IP memicu kunci → pemilik akun dari jaringan lain tetap bisa masuk', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tryLogin(OWNER.email, WRONG, '203.0.113.66');
    }
    const victim = await tryLogin(OWNER.email, OWNER.password, '198.51.100.20');
    expect(victim.statusCode).toBe(200);
  });

  /**
   * R1 — Bila penanda Redis hilang (Redis dijalankan ulang tanpa persistensi) selama kunci
   * berlaku, hanya akun sungguhan yang masih terkunci (kolom `locked_until`): 429 vs 401
   * membuka email mana yang terdaftar.
   */
  it('R1: tanpa penanda Redis, akun sungguhan dan email tak terdaftar dijawab sama', async () => {
    const password = 'sandi-uji-enumerasi-fase1';
    const real = await addUser('cs', password);
    const unknown = `tidak-ada-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tryLogin(real.email, WRONG, '203.0.113.71');
      await tryLogin(unknown, WRONG, '203.0.113.72');
    }
    await deleteLockFlag(real.email);
    await deleteLockFlag(unknown);

    const realResponse = await tryLogin(real.email, WRONG, '203.0.113.73');
    const unknownResponse = await tryLogin(unknown, WRONG, '203.0.113.74');

    expect(realResponse.statusCode).toBe(unknownResponse.statusCode);
  });

  /** R2 — Bentuk IPv6 yang membawa alamat IPv4 di dalamnya (NAT64, 6to4, SIIT) tidak diblokir. */
  it.each([
    ['NAT64 well-known prefix', '64:ff9b::a9fe:a9fe'],
    ['NAT64 local-use', '64:ff9b:1::a9fe:a9fe'],
    ['6to4', '2002:a9fe:a9fe::1'],
    ['IPv4-translated (SIIT)', '::ffff:0:a9fe:a9fe'],
  ])('R2: %s menuju 169.254.169.254 diblokir', (_label, address) => {
    expect(isBlockedMailAddress(address)).toBe(true);
  });

  /** R3 — SETUP_TOKEN hanya dicek panjangnya; 16 karakter berulang diterima. */
  it('R3: SETUP_TOKEN berentropi rendah ditolak saat start', () => {
    const env: EnvSource = {
      NODE_ENV: 'production',
      APP_URL: 'https://balesin.contoh.co.id',
      API_URL: 'https://balesin.contoh.co.id/api',
      DATABASE_URL: 'postgres://balesin:sandi-db@db:5432/balesin',
      REDIS_URL: 'redis://:sandi-redis@redis:6379',
      BALESIN_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      SESSION_SECRET: 'rahasia-sesi-yang-panjangnya-lebih-dari-32-karakter',
      SETUP_TOKEN: 'aaaaaaaaaaaaaaaa',
    };
    expect(() => loadConfig(env)).toThrow(EnvValidationError);
  });
});

// ── Penjaga regresi lain ────────────────────────────────────────────────────

describe('penjaga regresi', () => {
  it('bentuk IPv4-terpetakan apa pun (heksadesimal, panjang penuh) tetap diblokir', () => {
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::ffff:0.0.0.0',
      '0:0:0:0:0:0:0:0',
    ]) {
      expect(isBlockedMailAddress(address), address).toBe(true);
    }
  });

  it('akun dinonaktifkan di tengah sesi: permintaan berikutnya 401 dan cookie dihapus', async () => {
    const password = 'sandi-uji-nonaktif-fase1';
    const cs = await addUser('cs', password);
    const session = await login(harness.app, { email: cs.email, password });
    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.id));

    const response = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: session.cookie,
    });

    expect(response.statusCode).toBe(401);
    expect(setCookies(response).some((value) => value.includes('Max-Age=0'))).toBe(true);
  });

  it('token CSRF dari sesi yang sudah logout tidak berlaku untuk sesi baru', async () => {
    const first = await login(harness.app);
    await call(harness.app, 'POST', API_ROUTES.auth.logout, undefined, {
      cookie: first.cookie,
      csrf: first.csrf,
    });
    const second = await login(harness.app);

    const response = await call(harness.app, 'POST', API_ROUTES.auth.logout, undefined, {
      cookie: second.cookie,
      csrf: first.csrf,
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('CSRF_INVALID');
  });

  it('logo disajikan dengan CSP, nosniff, dan CORP; polyglot PNG+HTML tetap bertipe image/png', async () => {
    await harness.reset();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const polyglot = Buffer.concat([png, Buffer.from('<html><script>alert(1)</script></html>')]);
    await completeSetup(harness.app, {
      branding: { logo: { contentType: 'image/png', dataBase64: polyglot.toString('base64') } },
    });

    const logo = await call(harness.app, 'GET', API_ROUTES.branding.logo);

    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    expect(String(logo.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(logo.headers['cross-origin-resource-policy']).toBeDefined();
  });

  it('token setup salah tidak tercatat di log maupun audit, juga saat bentuknya mirip token sungguhan', async () => {
    await harness.reset();
    const guess = 'tebakan-token-setup-0123456789-abc';
    const response = await call(harness.app, 'POST', API_ROUTES.setup.verifyToken, {
      setupToken: guess,
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(harness.logs.lines)).not.toContain(guess);
    expect(response.body).not.toContain(guess);
  });
});
