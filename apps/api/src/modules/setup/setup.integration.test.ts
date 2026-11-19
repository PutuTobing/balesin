import { createSecretBox, Secret, SMTP_PASSWORD_PURPOSE } from '@balesin/core';
import { TEST_MAIL, waitForCapturedMail } from '@balesin/core/testing';
import {
  auditLogs,
  emailSettings,
  installation,
  organizationLogos,
  organizations,
  userSessions,
  users,
} from '@balesin/db';
import { uniqueSuffix } from '@balesin/db/testing';
import {
  API_ROUTES,
  authenticatedSessionSchema,
  meResponseSchema,
  twoFactorEnrollmentSessionSchema,
  brandingResponseSchema,
  detectEmailHostResponseSchema,
  emailSettingsResponseSchema,
  emailTestResultSchema,
  errorEnvelopeSchema,
  passwordCheckResponseSchema,
  setupStatusResponseSchema,
  type ErrorEnvelope,
} from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SETUP_TOKEN_IP_RULE } from './setup.service';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  mailpitSettings,
  OWNER,
  setCookies,
  setupBody,
  TEST_MASTER_KEY,
  TEST_SETUP_TOKEN,
  type IntegrationHarness,
} from '../../testing/integration';

let harness: IntegrationHarness;

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

const post = (url: string, body: unknown, ip?: string) =>
  call(harness.app, 'POST', url, body, ip ? { ip } : {});

/** PNG 1×1 piksel yang sah. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function counts() {
  const [orgs, people, installs, sessions] = await Promise.all([
    harness.db.select().from(organizations),
    harness.db.select().from(users),
    harness.db.select().from(installation),
    harness.db.select().from(userSessions),
  ]);
  return {
    organizations: orgs.length,
    users: people.length,
    installation: installs.length,
    sessions: sessions.length,
  };
}

describe('GET /setup/status', () => {
  it('instalasi baru perlu setup; setelah selesai tidak lagi', async () => {
    const before = await call(harness.app, 'GET', API_ROUTES.setup.status);
    await completeSetup(harness.app);
    const after = await call(harness.app, 'GET', API_ROUTES.setup.status);

    expect(setupStatusResponseSchema.parse(before.json())).toEqual({
      needsSetup: true,
      setupTokenConfigured: true,
      canStoreSecrets: true,
    });
    // Setelah selesai, konfigurasi server tidak lagi dibuka ke publik (temuan I1 review Fase 1).
    expect(setupStatusResponseSchema.parse(after.json())).toEqual({
      needsSetup: false,
      setupTokenConfigured: false,
      canStoreSecrets: false,
    });
  });

  it('melaporkan bila SETUP_TOKEN atau BALESIN_MASTER_KEY belum diisi, dan wizard menolak jalan', async () => {
    await harness.rebuild({ config: { setupToken: null, masterKey: null } });

    const status = await call(harness.app, 'GET', API_ROUTES.setup.status);
    const verify = await post(API_ROUTES.setup.verifyToken, { setupToken: 'apa-saja' });
    const complete = await post(API_ROUTES.setup.complete, setupBody());

    expect(setupStatusResponseSchema.parse(status.json())).toEqual({
      needsSetup: true,
      setupTokenConfigured: false,
      canStoreSecrets: false,
    });
    expect(verify.statusCode).toBe(503);
    expect(errorOf(verify).message).toContain('SETUP_TOKEN');
    expect(complete.statusCode).toBe(503);
    expect(await counts()).toMatchObject({ organizations: 0, users: 0 });

    await harness.rebuild();
  });
});

describe('token setup', () => {
  it('token benar diterima; token salah ditolak 403 dengan petunjuk', async () => {
    const ok = await post(API_ROUTES.setup.verifyToken, { setupToken: TEST_SETUP_TOKEN });
    const wrong = await post(API_ROUTES.setup.verifyToken, {
      setupToken: `${TEST_SETUP_TOKEN}x`,
    });
    const prefix = await post(API_ROUTES.setup.verifyToken, {
      setupToken: TEST_SETUP_TOKEN.slice(0, -1),
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ valid: true });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong)).toMatchObject({ code: 'FORBIDDEN' });
    expect(errorOf(wrong).message).toContain('SETUP_TOKEN');
    expect(prefix.statusCode).toBe(403);
  });

  it('token tidak boleh lewat query string, dan tidak pernah muncul di log', async () => {
    const viaQuery = await call(
      harness.app,
      'POST',
      `${API_ROUTES.setup.verifyToken}?setupToken=${TEST_SETUP_TOKEN}`,
      {},
    );
    await post(API_ROUTES.setup.verifyToken, { setupToken: TEST_SETUP_TOKEN });
    await post(API_ROUTES.setup.verifyToken, { setupToken: 'token-salah-yang-diketik' });

    expect(viaQuery.statusCode).toBe(400);
    expect(harness.logs.text()).not.toContain(TEST_SETUP_TOKEN);
    expect(harness.logs.text()).not.toContain('token-salah-yang-diketik');
  });

  it('percobaan token salah dibatasi per IP (429 + Retry-After); IP lain tidak terdampak', async () => {
    const attacker = '203.0.113.7';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < SETUP_TOKEN_IP_RULE.limit + 2; attempt += 1) {
      const response = await post(
        API_ROUTES.setup.verifyToken,
        { setupToken: `tebakan-${attempt}` },
        attacker,
      );
      statuses.push(response.statusCode);
    }
    const blocked = await post(
      API_ROUTES.setup.verifyToken,
      { setupToken: TEST_SETUP_TOKEN },
      attacker,
    );
    const elsewhere = await post(
      API_ROUTES.setup.verifyToken,
      { setupToken: TEST_SETUP_TOKEN },
      '198.51.100.9',
    );

    expect(statuses.slice(0, SETUP_TOKEN_IP_RULE.limit)).toEqual(
      Array<number>(SETUP_TOKEN_IP_RULE.limit).fill(403),
    );
    expect(statuses.slice(SETUP_TOKEN_IP_RULE.limit)).toEqual([429, 429]);
    // Selama diblokir, token yang BENAR pun tidak diperiksa.
    expect(blocked.statusCode).toBe(429);
    expect(errorOf(blocked).code).toBe('RATE_LIMITED');
    // Tanpa durasi di pesan: web menampilkan hitung mundur dari `Retry-After`.
    expect(errorOf(blocked).message).toBe('Terlalu banyak percobaan token setup.');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(900);
    expect(elsewhere.statusCode).toBe(200);
  });

  it('token benar tidak menghabiskan jatah (wizard memanggilnya berkali-kali)', async () => {
    for (let attempt = 0; attempt < SETUP_TOKEN_IP_RULE.limit * 2; attempt += 1) {
      const response = await post(API_ROUTES.setup.verifyToken, { setupToken: TEST_SETUP_TOKEN });
      expect(response.statusCode).toBe(200);
    }
  });

  it('permintaan dari origin asing ditolak sebelum token diperiksa', async () => {
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.setup.verifyToken,
      { setupToken: TEST_SETUP_TOKEN },
      { origin: 'https://jahat.example' },
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST /setup/complete', () => {
  it('membuat organisasi + Owner, mengunci setup, dan memasukkan Owner dengan sesi wajib-daftar-2FA', async () => {
    const response = await post(
      API_ROUTES.setup.complete,
      setupBody({
        owner: { ...OWNER, email: '  Sari@MajuJaya.Test ' },
        branding: { productName: 'Balesin Maju Jaya', primaryColor: '#1B3557' },
      }),
    );

    expect(response.statusCode).toBe(201);
    const session = twoFactorEnrollmentSessionSchema.parse(response.json());
    // Owner wajib 2FA: sesi TERBATAS, hanya untuk mendaftar 2FA (lihat two-factor.integration).
    expect(session.status).toBe('two_factor_enrollment_required');
    expect(authenticatedSessionSchema.safeParse(response.json()).success).toBe(false);
    expect(session.user).toMatchObject({ name: OWNER.name, email: OWNER.email, role: 'owner' });
    expect(session.organization).toMatchObject({
      name: 'PT Maju Jaya Abadi',
      timezone: 'Asia/Jakarta',
    });
    expect(session.csrfToken.length).toBeGreaterThan(20);

    // Cookie sesi (mode http://localhost: tanpa awalan __Host- dan tanpa Secure). Sesi terbatas
    // berumur 30 menit; cookie perangkat dikenal BELUM dipasang (login belum selesai).
    const cookies = setCookies(response);
    const [cookie] = cookies;
    expect(cookies).toHaveLength(1);
    expect(cookie).toMatch(
      /^balesin_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1800$/,
    );
    const lifetimeMinutes = (Date.parse(session.session.absoluteExpiresAt) - Date.now()) / 60_000;
    expect(lifetimeMinutes).toBeGreaterThan(29.5);
    expect(lifetimeMinutes).toBeLessThanOrEqual(30.05); // jam database vs jam proses
    expect(session.session.idleExpiresAt).toBe(session.session.absoluteExpiresAt);

    const [organization] = await harness.db.select().from(organizations);
    const [owner] = await harness.db.select().from(users);
    expect(organization).toMatchObject({
      name: 'PT Maju Jaya Abadi',
      productName: 'Balesin Maju Jaya',
      brandColor: '#1b3557',
    });
    expect(owner).toMatchObject({ email: OWNER.email, role: 'owner', disabledAt: null });
    expect(owner?.organizationId).toBe(organization?.id);
    expect(owner?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(owner?.lastLoginAt).toBeInstanceOf(Date);
    expect(await counts()).toEqual({ organizations: 1, users: 1, installation: 1, sessions: 1 });

    // Respons, log, dan audit tidak memuat password, hash, maupun token.
    const everything = `${response.body}${harness.logs.text()}`;
    expect(everything).not.toContain(OWNER.password);
    expect(everything).not.toContain(TEST_SETUP_TOKEN);
    expect(response.body).not.toContain('argon2');
    expect(Object.keys(session.user).sort()).toEqual(['email', 'id', 'name', 'role']);

    const audit = await harness.db.select().from(auditLogs);
    expect(audit.map((row) => row.action).sort()).toEqual([
      'auth.login.success',
      'setup.completed',
    ]);
    expect(audit.every((row) => row.actorUserId === owner?.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(OWNER.password);
    expect(JSON.stringify(audit)).not.toContain(TEST_SETUP_TOKEN);

    // Sesi langsung bisa dipakai untuk "siapa saya" (yang memberi tahu langkah berikutnya),
    // tetapi rute aplikasi lain ditolak sampai 2FA aktif.
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: cookie?.split(';')[0],
    });
    expect(me.statusCode).toBe(200);
    expect(meResponseSchema.parse(me.json()).status).toBe('two_factor_enrollment_required');
    const settings = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie: cookie?.split(';')[0],
    });
    expect(settings.statusCode).toBe(403);
    expect(settings.json()).toMatchObject({ error: { code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' } });
  });

  it('setup kedua ditolak 409 walau tokennya benar, dan semua rute setup ikut terkunci', async () => {
    await completeSetup(harness.app);

    const again = await post(
      API_ROUTES.setup.complete,
      setupBody({ owner: { ...OWNER, email: 'penyusup@jahat.test' } }),
    );
    const others = await Promise.all([
      post(API_ROUTES.setup.verifyToken, { setupToken: TEST_SETUP_TOKEN }),
      post(API_ROUTES.setup.verifyToken, { setupToken: 'token-salah' }),
      post(API_ROUTES.setup.checkPassword, { setupToken: TEST_SETUP_TOKEN, password: 'x' }),
      post(API_ROUTES.setup.detectEmailHost, {
        setupToken: TEST_SETUP_TOKEN,
        emailAddress: 'cs@gmail.com',
      }),
      post(API_ROUTES.setup.testEmailConnection, {
        setupToken: TEST_SETUP_TOKEN,
        settings: mailpitSettings(),
      }),
      post(API_ROUTES.setup.sendTestEmail, {
        setupToken: TEST_SETUP_TOKEN,
        to: 'tujuan@contoh.test',
        settings: mailpitSettings(),
      }),
    ]);

    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'CONFLICT' });
    expect(errorOf(again).message).toContain('Setup sudah selesai');
    expect(setCookies(again)).toEqual([]);
    expect(others.map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(await counts()).toMatchObject({ organizations: 1, users: 1, installation: 1 });
    const emails = (await harness.db.select().from(users)).map((user) => user.email);
    expect(emails).toEqual([OWNER.email]);
  });

  it('beberapa setup bersamaan: tepat satu yang berhasil', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        post(
          API_ROUTES.setup.complete,
          setupBody({ owner: { ...OWNER, email: `owner-${index}@majujaya.test` } }),
        ),
      ),
    );

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await counts()).toEqual({ organizations: 1, users: 1, installation: 1, sessions: 1 });
  });

  it('token salah: 403 dan tidak ada yang dibuat', async () => {
    const response = await post(
      API_ROUTES.setup.complete,
      setupBody({ setupToken: 'token-setup-yang-salah-123' }),
    );

    expect(response.statusCode).toBe(403);
    expect(setCookies(response)).toEqual([]);
    expect(await counts()).toEqual({ organizations: 0, users: 0, installation: 0, sessions: 0 });
  });

  it.each([
    ['terlalu pendek', 'pendek123', 'Password minimal 10 karakter.'],
    ['password umum', 'password123', 'terlalu umum'],
    ['kata umum + tahun', 'Indonesia2024!', 'terlalu umum'],
    ['karakter berulang', 'aaaaaaaaaaaa', 'berulang atau berurutan'],
    ['memuat nama pemilik', 'wulandari-keren-99', 'nama, email, atau nama perusahaan'],
    ['memuat nama perusahaan', 'majujaya-selalu-oke', 'nama, email, atau nama perusahaan'],
  ])('password Owner ditolak: %s', async (_label, password, expectedMessage) => {
    const response = await post(
      API_ROUTES.setup.complete,
      setupBody({ owner: { ...OWNER, password } }),
    );

    expect(response.statusCode).toBe(400);
    const error = errorOf(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([
      {
        location: 'body',
        field: 'owner.password',
        message: expect.stringContaining(expectedMessage) as string,
      },
    ]);
    expect(response.body).not.toContain(password);
    expect(await counts()).toMatchObject({ organizations: 0, users: 0 });
  });

  it('isian lain yang salah ditolak 400 dengan nama isiannya', async () => {
    const response = await post(API_ROUTES.setup.complete, {
      setupToken: TEST_SETUP_TOKEN,
      owner: { name: 'S', email: 'bukan-email', password: OWNER.password },
      organization: { name: '', timezone: 'Mars/Olympus' },
      branding: { primaryColor: 'merah', productName: 'x' },
    });

    expect(response.statusCode).toBe(400);
    const fields = (errorOf(response).details ?? []).map((detail) => detail.field).sort();
    expect(fields).toEqual([
      'branding.primaryColor',
      'branding.productName',
      'organization.name',
      'organization.timezone',
      'owner.email',
      'owner.name',
    ]);
    for (const detail of errorOf(response).details ?? []) {
      expect(detail.message, detail.field).not.toMatch(/\bAnda\b/i);
    }
  });
});

describe('branding dan logo', () => {
  it('sebelum setup: nama bawaan tanpa data organisasi; logo 404', async () => {
    const branding = await call(harness.app, 'GET', API_ROUTES.branding.get);
    const logo = await call(harness.app, 'GET', API_ROUTES.branding.logo);

    expect(brandingResponseSchema.parse(branding.json())).toEqual({
      productName: 'Balesin',
      organizationName: null,
      primaryColor: null,
      logoUrl: null,
      mascotName: 'Kak Sky',
      icons: null,
    });
    expect(logo.statusCode).toBe(404);
  });

  it('logo PNG tersimpan dan disajikan publik dengan tipe hasil pemeriksaan isi', async () => {
    await completeSetup(harness.app, {
      branding: {
        productName: 'Balesin Maju Jaya',
        primaryColor: '#0f766e',
        logo: { contentType: 'image/png', dataBase64: PNG_1PX.toString('base64') },
      },
    });

    const branding = brandingResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.branding.get)).json(),
    );
    expect(branding).toMatchObject({
      productName: 'Balesin Maju Jaya',
      organizationName: 'PT Maju Jaya Abadi',
      primaryColor: '#0f766e',
    });
    expect(branding.logoUrl).toMatch(/^\/api\/v1\/branding\/logo\?v=[0-9a-f]{12}$/);

    const logo = await call(harness.app, 'GET', branding.logoUrl ?? '');
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    expect(logo.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(logo.headers['content-disposition']).toBe('inline; filename="logo.png"');
    expect(logo.rawPayload.equals(PNG_1PX)).toBe(true);

    const cached = await call(harness.app, 'GET', API_ROUTES.branding.logo, undefined, {
      headers: { 'if-none-match': String(logo.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(await harness.db.select().from(organizationLogos)).toHaveLength(1);

    // Ikon PWA/favicon dibuat dari logo saat setup (Fase 7 white-label).
    expect(branding.icons?.manifest).toHaveLength(4);
    const icon = await call(harness.app, 'GET', branding.icons?.manifest[0]?.src ?? '');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
  });

  it.each([
    [
      'SVG yang mengaku PNG',
      {
        contentType: 'image/png',
        dataBase64: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ).toString('base64'),
      },
      'PNG, JPG, atau WebP',
    ],
    [
      'isi PNG tetapi mengaku JPEG',
      { contentType: 'image/jpeg', dataBase64: PNG_1PX.toString('base64') },
      'tidak cocok dengan jenisnya',
    ],
    [
      'lebih dari 256 KB',
      {
        contentType: 'image/png',
        dataBase64: Buffer.concat([PNG_1PX, Buffer.alloc(256 * 1024)]).toString('base64'),
      },
      'maksimal 256 KB',
    ],
    ['tipe SVG', { contentType: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }, 'PNG, JPG, atau WebP'],
  ])('logo ditolak: %s', async (_label, logo, expectedMessage) => {
    const response = await post(
      API_ROUTES.setup.complete,
      setupBody({ branding: { logo: logo as never } }),
    );

    expect(response.statusCode).toBe(400);
    const details = errorOf(response).details ?? [];
    expect(details.some((detail) => detail.field.startsWith('branding.logo'))).toBe(true);
    expect(details.map((detail) => detail.message).join(' ')).toContain(expectedMessage);
    expect(await counts()).toMatchObject({ organizations: 0, users: 0 });
  });
});

describe('POST /setup/check-password', () => {
  it('menilai password di server, termasuk daftar password umum dan data pemilik', async () => {
    const check = async (password: string) =>
      passwordCheckResponseSchema.parse(
        (
          await post(API_ROUTES.setup.checkPassword, {
            setupToken: TEST_SETUP_TOKEN,
            password,
            email: OWNER.email,
            name: OWNER.name,
            organizationName: 'PT Maju Jaya Abadi',
          })
        ).json(),
      );

    expect(await check(OWNER.password)).toEqual({ acceptable: true, message: null });
    expect(await check('qwertyuiop')).toMatchObject({ acceptable: false });
    expect((await check('1234567890')).message).toContain('terlalu umum');
    expect((await check('abcdefghijkl')).message).toContain('berulang atau berurutan');
    expect((await check('sari-wulandari-2024')).message).toContain('nama, email');
    expect((await check('pendek')).message).toBe('Password minimal 10 karakter.');
  });

  it('wajib token setup', async () => {
    const response = await post(API_ROUTES.setup.checkPassword, {
      setupToken: 'token-salah',
      password: OWNER.password,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('langkah Email di wizard setup', () => {
  it('pengaturan email tersimpan terenkripsi; ke klien hanya petunjuk tersamar', async () => {
    const owner = await completeSetup(harness.app, {
      email: mailpitSettings({
        password: 'app-password-16-karakter',
        replyTo: 'bantuan@majujaya.test',
      }),
    });

    const [row] = await harness.db.select().from(emailSettings);
    const [organization] = await harness.db.select().from(organizations);
    if (!row?.passwordEncrypted || !organization)
      throw new Error('pengaturan email tidak tersimpan');

    expect(row.passwordEncrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(row)).not.toContain('app-password-16-karakter');
    expect(row.passwordTail).toBe('kter');
    expect(row.updatedByUserId).toBe(owner.session.user.id);
    // Bisa dibuka hanya dengan master key + konteks organisasi yang sama.
    const box = createSecretBox(new Secret(TEST_MASTER_KEY));
    expect(
      box.decrypt(row.passwordEncrypted, {
        organizationId: organization.id,
        purpose: SMTP_PASSWORD_PURPOSE,
      }),
    ).toBe('app-password-16-karakter');

    const view = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie: owner.cookie,
    });
    const settings = emailSettingsResponseSchema.parse(view.json());
    expect(settings).toMatchObject({
      source: 'database',
      status: 'untested',
      lastTest: null,
      canStoreSecrets: true,
      settings: {
        fromName: 'Balesin Maju Jaya',
        fromAddress: 'cs@majujaya.test',
        replyTo: 'bantuan@majujaya.test',
        host: TEST_MAIL.host,
        port: TEST_MAIL.smtpPort,
        security: 'none',
        username: TEST_MAIL.username,
        hasPassword: true,
        passwordHint: '••••kter',
      },
    });
    expect(view.body).not.toContain('app-password-16-karakter');
    expect(view.body).not.toContain(row.passwordEncrypted);
    expect(harness.logs.text()).not.toContain('app-password-16-karakter');
  });

  it('langkah Email boleh dilewati', async () => {
    const owner = await completeSetup(harness.app, { email: null });

    const view = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie: owner.cookie,
    });

    expect(emailSettingsResponseSchema.parse(view.json())).toMatchObject({
      source: 'none',
      settings: null,
      status: 'not_configured',
    });
    expect(await harness.db.select().from(emailSettings)).toEqual([]);
  });

  it('tanpa master key password tidak disimpan — setup dengan email ditolak, tanpa email tetap bisa', async () => {
    await harness.rebuild({ config: { masterKey: null } });

    const withEmail = await post(
      API_ROUTES.setup.complete,
      setupBody({ email: mailpitSettings() }),
    );
    expect(withEmail.statusCode).toBe(503);
    expect(errorOf(withEmail).message).toContain('BALESIN_MASTER_KEY');
    // Transaksinya batal seluruhnya: tidak ada organisasi setengah jadi.
    expect(await counts()).toEqual({ organizations: 0, users: 0, installation: 0, sessions: 0 });

    const withoutEmail = await post(API_ROUTES.setup.complete, setupBody());
    expect(withoutEmail.statusCode).toBe(201);

    await harness.rebuild();
  });

  it('isian email yang salah ditolak 400 dengan nama isian berawalan email.', async () => {
    const badPort = await post(
      API_ROUTES.setup.complete,
      setupBody({ email: mailpitSettings({ port: 8025 }) }),
    );
    const noPassword = await post(
      API_ROUTES.setup.complete,
      setupBody({ email: mailpitSettings({ password: undefined }) }),
    );
    const badHost = await post(
      API_ROUTES.setup.complete,
      setupBody({ email: mailpitSettings({ host: 'http://mail.contoh.test/smtp' }) }),
    );

    expect(errorOf(badPort).details).toEqual([
      { location: 'body', field: 'email.port', message: expect.stringContaining('465') as string },
    ]);
    expect(errorOf(noPassword).details).toEqual([
      { location: 'body', field: 'email.password', message: 'Password wajib diisi.' },
    ]);
    expect(errorOf(badHost).details?.[0]).toMatchObject({ field: 'email.host' });
    expect(await counts()).toMatchObject({ organizations: 0, users: 0 });
  });

  it('tes koneksi: berhasil, password salah, dan host salah — pesan jelas berbahasa Indonesia', async () => {
    const test = async (settings: ReturnType<typeof mailpitSettings>) =>
      emailTestResultSchema.parse(
        (
          await post(API_ROUTES.setup.testEmailConnection, {
            setupToken: TEST_SETUP_TOKEN,
            settings,
          })
        ).json(),
      );

    const ok = await test(mailpitSettings());
    const wrongPassword = await test(mailpitSettings({ password: 'password-smtp-salah' }));
    const wrongHost = await test(mailpitSettings({ host: 'mail.tidak-ada.invalid' }));
    const wrongMode = await test(mailpitSettings({ security: 'ssl' }));

    expect(ok).toMatchObject({ ok: true, code: 'ok' });
    expect(ok.message).toBe('Berhasil terhubung ke server email. Pengaturan ini siap dipakai.');
    expect(wrongPassword).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(wrongPassword.message).toContain('Username atau password ditolak');
    expect(wrongHost).toMatchObject({ ok: false, code: 'host_not_found' });
    expect(wrongMode).toMatchObject({ ok: false, code: 'tls_failed' });
    for (const result of [ok, wrongPassword, wrongHost, wrongMode]) {
      expect(result.message).not.toMatch(/\bAnda\b/i);
      expect(Date.parse(result.testedAt)).not.toBeNaN();
    }
    expect(harness.logs.text()).not.toContain('password-smtp-salah');
    // Belum ada organisasi: tidak ada yang tersimpan.
    expect(await harness.db.select().from(emailSettings)).toEqual([]);
  });

  it('tes koneksi: port salah dijelaskan, port di luar daftar izin ditolak 400 di settings.port', async () => {
    const wrongPort = await post(API_ROUTES.setup.testEmailConnection, {
      setupToken: TEST_SETUP_TOKEN,
      settings: mailpitSettings({ port: 2525 }),
    });
    expect(wrongPort.statusCode).toBe(200);
    expect(emailTestResultSchema.parse(wrongPort.json())).toMatchObject({
      ok: false,
      code: 'connection_refused',
    });

    // Wizard harus bisa menandai isian Port dari jawaban ini (docs/KONTRAK-API-AUTH.md).
    const notAllowed = await post(API_ROUTES.setup.testEmailConnection, {
      setupToken: TEST_SETUP_TOKEN,
      settings: mailpitSettings({ port: 2526 }),
    });
    expect(notAllowed.statusCode).toBe(400);
    expect(errorOf(notAllowed)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(errorOf(notAllowed).details).toEqual([
      expect.objectContaining({
        field: 'settings.port',
        message: expect.stringContaining('Port ini tidak didukung') as string,
      }),
    ]);
  });

  it('kirim email tes sampai ke alamat tujuan', async () => {
    const to = `tujuan-${uniqueSuffix()}@contoh.test`;

    const response = await post(API_ROUTES.setup.sendTestEmail, {
      setupToken: TEST_SETUP_TOKEN,
      to,
      settings: mailpitSettings({ replyTo: 'bantuan@majujaya.test' }),
    });

    const result = emailTestResultSchema.parse(response.json());
    expect(result).toMatchObject({ ok: true, code: 'ok' });
    expect(result.message).toBe(
      `Email tes terkirim ke ${to}. Cek kotak masuk alamat itu, termasuk folder spam.`,
    );
    const mail = await waitForCapturedMail(to);
    expect(mail.subject).toBe('Email tes dari Balesin Maju Jaya');
    expect(mail.from).toEqual({ name: 'Balesin Maju Jaya', address: 'cs@majujaya.test' });
    expect(mail.replyTo).toEqual(['bantuan@majujaya.test']);
    expect(mail.text).toContain('pengaturan email pengirim sudah benar');
  });

  it('hasil tes di wizard ikut tersimpan sebagai status bila isian sambungannya tidak berubah', async () => {
    const tested = mailpitSettings({ password: TEST_MAIL.password });
    const result = emailTestResultSchema.parse(
      (
        await post(API_ROUTES.setup.testEmailConnection, {
          setupToken: TEST_SETUP_TOKEN,
          settings: tested,
        })
      ).json(),
    );
    expect(result.ok).toBe(true);

    // Nama pengirim boleh berubah (bukan bagian sambungan); host/port/login sama persis.
    const owner = await completeSetup(harness.app, {
      email: { ...tested, fromName: 'Tim CS Maju Jaya' },
    });
    const view = emailSettingsResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(view.status).toBe('connected');
    expect(view.lastTest).toMatchObject({ ok: true, code: 'ok', testedAt: result.testedAt });

    // Kunci ingatan di Redis hanya HMAC (tanpa host/login terbaca); nilainya hanya kode + waktu.
    const keys = await harness.redis.keys('*:setup-email-test:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/:setup-email-test:[A-Za-z0-9_-]{43}$/);
      expect(JSON.parse((await harness.redis.get(key)) ?? '{}')).toEqual({
        ok: true,
        code: 'ok',
        testedAt: result.testedAt,
      });
    }
  });

  it('hasil tes di wizard TIDAK dipakai bila password atau host berubah setelah dites', async () => {
    await post(API_ROUTES.setup.testEmailConnection, {
      setupToken: TEST_SETUP_TOKEN,
      settings: mailpitSettings({ password: 'password-smtp-salah' }),
    });

    const owner = await completeSetup(harness.app, { email: mailpitSettings() });
    const view = emailSettingsResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(view).toMatchObject({ status: 'untested', lastTest: null });
  });

  it('tes email wajib token setup dan dibatasi lajunya', async () => {
    const noToken = await post(API_ROUTES.setup.testEmailConnection, {
      setupToken: 'token-salah',
      settings: mailpitSettings(),
    });
    expect(noToken.statusCode).toBe(403);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await post(
        API_ROUTES.setup.testEmailConnection,
        // Port tertutup: cepat gagal, tetap dihitung.
        { setupToken: TEST_SETUP_TOKEN, settings: mailpitSettings({ host: '169.254.169.254' }) },
        '203.0.113.50',
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('deteksi host: penyedia terkenal, catatan MX, dan mail.<domain> — wajib token', async () => {
    await harness.rebuild({
      overrides: {
        mailDns: {
          resolveMx: (domain) =>
            Promise.resolve(
              domain === 'kantor-google.test' ? [{ exchange: 'aspmx.l.google.com.' }] : [],
            ),
          lookup: (host) =>
            host === 'mail.hosting.test'
              ? Promise.resolve([{ address: '203.0.113.20', family: 4 }])
              : host === 'smtp.internal.test'
                ? Promise.resolve([{ address: '169.254.169.254', family: 4 }])
                : Promise.reject(new Error('ENOTFOUND')),
        },
      },
    });
    const detect = async (emailAddress: string) =>
      detectEmailHostResponseSchema.parse(
        (
          await post(API_ROUTES.setup.detectEmailHost, {
            setupToken: TEST_SETUP_TOKEN,
            emailAddress,
          })
        ).json(),
      );

    expect((await detect('Toko@Gmail.com')).suggestions).toEqual([
      expect.objectContaining({
        presetId: 'gmail',
        host: 'smtp.gmail.com',
        port: 587,
        security: 'starttls',
        reason: 'known_provider',
      }),
    ]);
    expect((await detect('cs@kantor-google.test')).suggestions).toEqual([
      expect.objectContaining({ presetId: 'gmail', reason: 'mx_record' }),
    ]);
    expect(await detect('cs@hosting.test')).toEqual({
      domain: 'hosting.test',
      suggestions: [
        expect.objectContaining({
          presetId: 'cpanel',
          host: 'mail.hosting.test',
          port: 465,
          security: 'ssl',
          reason: 'dns_found',
        }),
      ],
    });
    // Nama yang menunjuk alamat terblokir tidak disarankan.
    expect((await detect('cs@internal.test')).suggestions).toEqual([]);
    expect((await detect('cs@tidak-ada.test')).suggestions).toEqual([]);

    const noToken = await post(API_ROUTES.setup.detectEmailHost, {
      setupToken: 'token-salah',
      emailAddress: 'cs@gmail.com',
    });
    expect(noToken.statusCode).toBe(403);

    await harness.rebuild();
  });
});
