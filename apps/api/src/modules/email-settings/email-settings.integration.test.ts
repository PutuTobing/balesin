import { createServer, type AddressInfo, type Server } from 'node:net';

import { Secret } from '@balesin/core';
import { TEST_MAIL, waitForCapturedMail } from '@balesin/core/testing';
import { auditLogs, emailSettings, organizations } from '@balesin/db';
import { insertUser, uniqueSuffix } from '@balesin/db/testing';
import {
  API_ROUTES,
  emailSettingsResponseSchema,
  emailTestResultSchema,
  errorEnvelopeSchema,
  SMTP_ALLOWED_PORTS,
  type EmailSettingsResponse,
  type EmailTestResult,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  mailpitSettings,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';
import { EMAIL_TEST_RULE } from './email-settings.routes';

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

const as = (user: SignedIn) => ({ cookie: user.cookie, csrf: user.csrf });

const view = async (user: SignedIn = owner): Promise<EmailSettingsResponse> =>
  emailSettingsResponseSchema.parse(
    (await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, as(user))).json(),
  );

const save = (body: unknown, user: SignedIn = owner) =>
  call(harness.app, 'PUT', API_ROUTES.settings.email, body, as(user));

const testConnection = async (body: unknown = {}): Promise<EmailTestResult> =>
  emailTestResultSchema.parse(
    (
      await call(harness.app, 'POST', API_ROUTES.settings.testEmailConnection, body, as(owner))
    ).json(),
  );

async function storedRow() {
  const [row] = await harness.db
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, owner.session.organization.id));
  return row;
}

const ENDPOINTS: Array<['GET' | 'PUT' | 'POST', string, unknown]> = [
  ['GET', API_ROUTES.settings.email, undefined],
  ['PUT', API_ROUTES.settings.email, mailpitSettings()],
  ['POST', API_ROUTES.settings.detectEmailHost, { emailAddress: 'cs@gmail.com' }],
  ['POST', API_ROUTES.settings.testEmailConnection, {}],
  ['POST', API_ROUTES.settings.sendTestEmail, { to: 'tujuan@contoh.test' }],
];

describe('otorisasi Pengaturan → Email pengirim', () => {
  it('tanpa sesi: 401 di semua endpoint', async () => {
    for (const [method, url, body] of ENDPOINTS) {
      const response = await call(harness.app, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it.each<UserRole>(['admin', 'supervisor', 'cs', 'teknisi'])(
    'peran %s: 403 di semua endpoint (hanya Owner)',
    async (role) => {
      const password = 'sandi-uji-otorisasi-email-1';
      const user = await insertUser(harness.db, owner.session.organization.id, {
        role,
        email: `${role}@majujaya.test`,
        passwordHash: await hasher.hash(password),
      });
      const signedIn = await login(harness.app, { email: user.email, password });

      for (const [method, url, body] of ENDPOINTS) {
        const response = await call(harness.app, method, url, body, as(signedIn));
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
      expect(await storedRow()).toBeUndefined();
    },
  );

  it('Owner tanpa token CSRF tidak bisa menyimpan maupun menjalankan tes', async () => {
    for (const [method, url, body] of ENDPOINTS.filter(([verb]) => verb !== 'GET')) {
      const response = await call(harness.app, method, url, body, { cookie: owner.cookie });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(response).code).toBe('CSRF_INVALID');
    }
    expect(await storedRow()).toBeUndefined();
  });
});

describe('simpan dan tampilkan', () => {
  it('belum diatur: status "Belum diatur"', async () => {
    expect(await view()).toEqual({
      source: 'none',
      settings: null,
      status: 'not_configured',
      lastTest: null,
      updatedAt: null,
      canStoreSecrets: true,
    });
  });

  it('menyimpan: password terenkripsi, respons hanya petunjuk tersamar, audit tanpa rahasia', async () => {
    const response = await save(
      mailpitSettings({ password: 'app-password-rahasia-9981', fromAddress: ' CS@MajuJaya.Test ' }),
    );

    expect(response.statusCode).toBe(200);
    const saved = emailSettingsResponseSchema.parse(response.json());
    expect(saved).toMatchObject({
      source: 'database',
      status: 'untested',
      settings: {
        fromAddress: 'cs@majujaya.test',
        hasPassword: true,
        passwordHint: '••••9981',
      },
    });
    expect(Object.keys(saved.settings ?? {})).not.toContain('password');

    const row = await storedRow();
    expect(row?.passwordEncrypted).toMatch(/^v1\./);
    expect(row?.updatedByUserId).toBe(owner.session.user.id);

    const audit = (await harness.db.select().from(auditLogs)).filter(
      (entry) => entry.action === 'settings.email.updated',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: owner.session.user.id,
      targetType: 'email_settings',
      metadata: {
        host: TEST_MAIL.host,
        port: TEST_MAIL.smtpPort,
        security: 'none',
        fromAddress: 'cs@majujaya.test',
        loginChanged: true,
        created: true,
      },
    });

    const everywhere = `${response.body}${JSON.stringify(row)}${JSON.stringify(audit)}${harness.logs.text()}`;
    expect(everywhere).not.toContain('app-password-rahasia-9981');
    expect(response.body).not.toContain(row?.passwordEncrypted ?? 'tidak-ada');
  });

  it('password pendek tidak diberi petunjuk; 8–11 karakter hanya 2 karakter terakhir', async () => {
    await save(mailpitSettings({ password: 'pendek7' }));
    expect((await view()).settings).toMatchObject({ hasPassword: true, passwordHint: null });

    await save(mailpitSettings({ password: 'sembilan9' }));
    expect((await view()).settings?.passwordHint).toBe('••••n9');
  });

  it('tanpa mengetik password: password tersimpan dipertahankan selama tujuan sambungan tidak berubah', async () => {
    await save(mailpitSettings());
    const before = await storedRow();

    const { password: _password, ...withoutPassword } = mailpitSettings({
      fromName: 'Nama Pengirim Baru',
      replyTo: 'bantuan@majujaya.test',
    });
    const response = await save(withoutPassword);

    expect(response.statusCode).toBe(200);
    const after = await storedRow();
    expect(after?.fromName).toBe('Nama Pengirim Baru');
    expect(after?.passwordEncrypted).toBe(before?.passwordEncrypted);
    expect((await testConnection()).ok).toBe(true);
  });

  it.each([
    ['host', { host: 'mail.penyerang.test' }],
    ['port', { port: 2525 }],
    ['keamanan', { security: 'starttls' as const }],
    ['username', { username: 'orang-lain' }],
  ])(
    'mengganti %s tanpa mengetik ulang password ditolak (password lama tidak dikirim ke tujuan baru)',
    async (_label, change) => {
      await save(mailpitSettings());
      const before = await storedRow();
      const { password: _password, ...withoutPassword } = mailpitSettings(change);

      const saveResponse = await save(withoutPassword);
      const testResponse = await call(
        harness.app,
        'POST',
        API_ROUTES.settings.testEmailConnection,
        { settings: withoutPassword },
        as(owner),
      );

      expect(saveResponse.statusCode).toBe(400);
      expect(errorOf(saveResponse).details).toEqual([
        {
          location: 'body',
          field: 'password',
          message: expect.stringContaining('Masukkan ulang password') as string,
        },
      ]);
      expect(testResponse.statusCode).toBe(400);
      expect(errorOf(testResponse).details?.[0]?.field).toBe('settings.password');
      expect(await storedRow()).toEqual(before);
    },
  );

  it('server tanpa login: username dan password sama-sama kosong', async () => {
    const { password: _password, ...withoutPassword } = mailpitSettings({ username: null });

    const ok = await save(withoutPassword);
    const mismatch = await save({ ...withoutPassword, password: 'tidak-seharusnya-ada' });

    expect(ok.statusCode).toBe(200);
    expect((await view()).settings).toMatchObject({
      username: null,
      hasPassword: false,
      passwordHint: null,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(errorOf(mismatch).details?.[0]?.field).toBe('password');
  });

  it('isian salah ditolak 400: port di luar daftar, host berbentuk URL, nama berisi baris baru', async () => {
    const badPort = await save(mailpitSettings({ port: 22 }));
    const badHost = await save(mailpitSettings({ host: 'https://mail.contoh.test' }));
    const badName = await save(mailpitSettings({ fromName: 'Balesin\r\nBcc: korban@contoh.test' }));
    const badReplyTo = await save(mailpitSettings({ replyTo: 'bukan-email' }));

    expect(errorOf(badPort).details?.[0]).toMatchObject({ field: 'port' });
    expect(errorOf(badHost).details?.[0]).toMatchObject({ field: 'host' });
    expect(errorOf(badName).details?.[0]).toMatchObject({ field: 'fromName' });
    expect(errorOf(badReplyTo).details?.[0]).toMatchObject({ field: 'replyTo' });
    expect(await storedRow()).toBeUndefined();
  });

  it('tanpa master key: simpan ditolak dengan petunjuk, tidak ada yang tersimpan polos', async () => {
    await harness.rebuild({ config: { masterKey: null } });

    const response = await save(mailpitSettings());

    expect(response.statusCode).toBe(503);
    expect(errorOf(response).message).toContain('BALESIN_MASTER_KEY');
    expect(await storedRow()).toBeUndefined();
    expect((await view()).canStoreSecrets).toBe(false);
    await harness.rebuild();
  });

  it('hanya pengaturan organisasi sendiri yang terbaca', async () => {
    const [other] = await harness.db
      .insert(organizations)
      .values({ name: 'Organisasi Lain' })
      .returning();
    await harness.db.insert(emailSettings).values({
      organizationId: other?.id ?? '',
      fromName: 'Milik Organisasi Lain',
      fromAddress: 'lain@contoh.test',
      host: 'mail.lain.test',
      port: 465,
      security: 'ssl',
    });

    expect(await view()).toMatchObject({ source: 'none', settings: null });
    await save(mailpitSettings());
    expect((await view()).settings?.fromName).toBe('Balesin Maju Jaya');
    const rows = await harness.db.select().from(emailSettings);
    expect(rows.find((row) => row.organizationId === other?.id)?.fromName).toBe(
      'Milik Organisasi Lain',
    );
  });
});

describe('tes koneksi dan email tes', () => {
  it('tes atas pengaturan tersimpan mencatat status "Terhubung" dan waktu tes', async () => {
    await save(mailpitSettings());

    const result = await testConnection();

    expect(result).toMatchObject({ ok: true, code: 'ok' });
    const current = await view();
    expect(current.status).toBe('connected');
    expect(current.lastTest).toMatchObject({ ok: true, code: 'ok' });
    expect(current.lastTest?.testedAt).toBe(result.testedAt);
  });

  it('password tersimpan salah: status "Gagal" dengan pesan yang menjelaskan solusinya', async () => {
    await save(mailpitSettings({ password: 'password-smtp-keliru-01' }));

    const result = await testConnection();

    expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(result.message).toContain('app password');
    expect(await view()).toMatchObject({ status: 'failed', lastTest: { code: 'auth_failed' } });
    expect(harness.logs.text()).not.toContain('password-smtp-keliru-01');
  });

  it('menyimpan ulang dengan sambungan berbeda mengembalikan status ke "Belum dites"', async () => {
    await save(mailpitSettings());
    await testConnection();
    expect((await view()).status).toBe('connected');

    // Hanya nama pengirim berubah: hasil tes tetap berlaku.
    const { password: _password, ...sameConnection } = mailpitSettings({ fromName: 'Nama Lain' });
    await save(sameConnection);
    expect((await view()).status).toBe('connected');

    await save(mailpitSettings({ password: 'password-baru-berbeda-22' }));
    expect(await view()).toMatchObject({ status: 'untested', lastTest: null });
  });

  it('tes atas isi form (belum disimpan) tidak mengubah status tersimpan', async () => {
    await save(mailpitSettings());
    await testConnection();

    const draft = await testConnection({
      settings: mailpitSettings({ password: 'password-draft-salah-33' }),
    });

    expect(draft).toMatchObject({ ok: false, code: 'auth_failed' });
    expect((await view()).status).toBe('connected');
  });

  it('belum diatur: hasil tes menjelaskan bahwa pengaturan harus diisi dulu', async () => {
    const result = await testConnection();

    expect(result).toMatchObject({ ok: false, code: 'not_configured' });
    expect(result.message).toContain('belum diatur');
  });

  it('kirim email tes memakai pengaturan tersimpan dan sampai ke tujuan', async () => {
    await save(mailpitSettings());
    const to = `owner-${uniqueSuffix()}@contoh.test`;

    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.settings.sendTestEmail,
      { to },
      as(owner),
    );

    expect(emailTestResultSchema.parse(response.json())).toMatchObject({ ok: true, code: 'ok' });
    const mail = await waitForCapturedMail(to);
    expect(mail.from.address).toBe('cs@majujaya.test');
    expect((await view()).status).toBe('connected');
  });

  it('setiap tes tercatat di audit log (host, port, hasil) tanpa rahasia', async () => {
    await save(mailpitSettings());
    await testConnection();
    await testConnection({ settings: mailpitSettings({ password: 'password-draft-salah-44' }) });

    const tests = (await harness.db.select().from(auditLogs)).filter(
      (entry) => entry.action === 'settings.email.tested',
    );
    expect(tests.map((entry) => entry.metadata)).toEqual([
      { mode: 'connection', host: TEST_MAIL.host, port: 1025, code: 'ok', draft: false },
      { mode: 'connection', host: TEST_MAIL.host, port: 1025, code: 'auth_failed', draft: true },
    ]);
    expect(JSON.stringify(tests)).not.toContain('password-draft-salah-44');
  });

  it('tes dibatasi lajunya per pengguna', async () => {
    await save(mailpitSettings({ host: '169.254.169.254' }));
    const statuses: number[] = [];
    for (let attempt = 0; attempt < EMAIL_TEST_RULE.limit + 1; attempt += 1) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.settings.testEmailConnection,
        {},
        as(owner),
      );
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, EMAIL_TEST_RULE.limit)).toEqual(
      Array<number>(EMAIL_TEST_RULE.limit).fill(200),
    );
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('tes koneksi sebagai permukaan SSRF', () => {
  let fakeServer: Server | undefined;

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      fakeServer ? fakeServer.close(() => resolve()) : resolve(),
    );
  });

  it.each([
    ['metadata cloud', '169.254.169.254'],
    ['alamat tak-tentu', '0.0.0.0'],
    ['link-local IPv6', 'fe80::1'],
    ['IPv4 terpetakan ke IPv6', '::ffff:169.254.169.254'],
  ])('alamat terblokir (%s) ditolak tanpa membuka sambungan', async (_label, host) => {
    const result = await testConnection({ settings: mailpitSettings({ host }) });

    expect(result).toMatchObject({ ok: false, code: 'host_blocked' });
  });

  it('nama host yang di-resolve ke alamat terblokir ikut ditolak', async () => {
    await harness.rebuild({
      overrides: {
        mailLookup: (host) =>
          Promise.resolve(
            host === 'campuran.contoh.test'
              ? [
                  { address: '203.0.113.10', family: 4 },
                  { address: '169.254.169.254', family: 4 },
                ]
              : [{ address: '169.254.169.254', family: 4 }],
          ),
      },
    });

    const direct = await testConnection({
      settings: mailpitSettings({ host: 'rebind.contoh.test' }),
    });
    const mixed = await testConnection({
      settings: mailpitSettings({ host: 'campuran.contoh.test' }),
    });

    expect(direct.code).toBe('host_blocked');
    expect(mixed.code).toBe('host_blocked');
    await harness.rebuild();
  });

  it('port di luar daftar izin tidak pernah disambungi (tidak bisa dipakai memindai port)', async () => {
    for (const port of [22, 80, 443, 5432, 6379, 8025]) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.settings.testEmailConnection,
        { settings: mailpitSettings({ port }) },
        as(owner),
      );
      expect(response.statusCode, String(port)).toBe(400);
      expect(errorOf(response).details?.[0]?.field).toBe('settings.port');
    }
  });

  it('balasan mentah server tidak pernah sampai ke klien maupun log', async () => {
    // Server palsu yang membocorkan "data internal" di sapaan dan di penolakan login.
    const server = createServer((socket) => {
      socket.write('220 RAHASIA-INTERNAL-BANNER layanan-dalam.lan ESMTP\r\n');
      socket.on('data', (chunk) => {
        const line = chunk.toString('latin1');
        if (/^EHLO|^HELO/i.test(line))
          socket.write('250-layanan-dalam.lan\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line))
          socket.write('535 5.7.8 RAHASIA-INTERNAL-PENOLAKAN token=abc123\r\n');
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      });
      socket.on('error', () => undefined);
    });
    fakeServer = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await harness.rebuild({ config: { smtpAllowedPorts: [...SMTP_ALLOWED_PORTS, port] } });

    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.settings.testEmailConnection,
      {
        settings: mailpitSettings({
          host: '127.0.0.1',
          port,
          password: 'sandi-untuk-server-palsu',
        }),
      },
      as(owner),
    );

    const result = emailTestResultSchema.parse(response.json());
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
    const exposed = `${response.body}${harness.logs.text()}${JSON.stringify(await harness.db.select().from(auditLogs))}`;
    expect(exposed).not.toContain('RAHASIA-INTERNAL');
    expect(exposed).not.toContain('layanan-dalam.lan');
    expect(exposed).not.toContain('abc123');
    expect(exposed).not.toContain('sandi-untuk-server-palsu');
    await harness.rebuild();
  });

  it('server yang diam tidak membuat permintaan menggantung (batas waktu)', async () => {
    const silent = createServer((socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    await harness.rebuild({
      config: { smtpAllowedPorts: [...SMTP_ALLOWED_PORTS, port] },
      overrides: {
        smtpTimeouts: { greetingMs: 300, connectionMs: 300, socketMs: 300, totalMs: 800 },
      },
    });

    const started = Date.now();
    const result = await testConnection({
      settings: mailpitSettings({ host: '127.0.0.1', port }),
    });

    expect(result).toMatchObject({ ok: false, code: 'connection_timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    await harness.rebuild();
  });
});

describe('cadangan SMTP dari .env', () => {
  it('tampil sebagai sumber "env" (hanya-baca, tanpa petunjuk password) sampai diisi lewat UI', async () => {
    await harness.rebuild({
      config: {
        smtpFallback: {
          host: 'mail.cadangan.test',
          port: 465,
          security: 'ssl',
          username: 'cadangan@contoh.test',
          password: new Secret('sandi-cadangan-dari-env'),
          fromName: 'Cadangan',
          fromAddress: 'cadangan@contoh.test',
        },
      },
    });

    const fromEnv = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, as(owner));
    expect(emailSettingsResponseSchema.parse(fromEnv.json())).toMatchObject({
      source: 'env',
      status: 'untested',
      settings: {
        host: 'mail.cadangan.test',
        fromAddress: 'cadangan@contoh.test',
        hasPassword: true,
        passwordHint: null,
      },
    });
    expect(fromEnv.body).not.toContain('sandi-cadangan-dari-env');

    await save(mailpitSettings());
    expect((await view()).source).toBe('database');
    await harness.rebuild();
  });
});
