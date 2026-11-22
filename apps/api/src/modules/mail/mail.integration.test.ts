/**
 * Modul Email — fondasi akun (Fase 9 tahap 9A bagian 1, docs/KONTRAK-API-EMAIL.md §1–§6), Postgres +
 * Redis sungguhan, server IMAP TIRUAN (TLS sertifikat tes), SMTP diganti verifier tiruan.
 *
 * Fokus keamanan: hak per akun (`resolveMailAccess`), akun pribadi orang lain = 404 untuk Owner,
 * konfirmasi identitas, kredensial terenkripsi & tidak pernah keluar, penjaga host ketat (privat
 * hanya allowlist), larangan alamat ganda dua arah dengan Channel Email, "Kelola" tidak bisa
 * menambah akses, deteksi otomatis tanpa alamat privat.
 */
import { randomBytes } from 'node:crypto';

import {
  createLogCapture,
  startFakeMailImap,
  TEST_IMAP_CERT,
  type FakeMailImapServer,
} from '@balesin/core/testing';
import type { RemoteFileRequest, SmtpResult } from '@balesin/core';
import { auditLogs, mailAccessUsersOf, mailAccounts, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  mailSettingsAccountListResponseSchema,
  meResponseSchema,
  teamMailAccessResponseSchema,
  testMailAccountResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const IMAP_PASSWORD = 'rahasia-imap-panjang-sekali';
const SMTP_OK_PASSWORD = IMAP_PASSWORD;
const PASSWORD = 'sandi-uji-modul-email-01';

let harness: IntegrationHarness;
let imap: FakeMailImapServer;
let owner: SignedIn;
const fetchCalls: RemoteFileRequest[] = [];
const smtpCalls: { host: string; password: string }[] = [];

const lookup = (host: string) =>
  Promise.resolve(
    host.endsWith('.lan.test')
      ? [{ address: '192.168.10.5', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
  );

function server(overrides: { password?: string; host?: string; port?: number } = {}) {
  return {
    imap: {
      host: overrides.host ?? 'imap.contoh.test',
      port: overrides.port ?? imap.port,
      security: 'ssl' as const,
      username: 'cs@contoh.test',
      password: overrides.password ?? IMAP_PASSWORD,
    },
    smtp: {
      host: overrides.host ?? 'imap.contoh.test',
      port: 465,
      security: 'ssl' as const,
      sameCredentials: true,
    },
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: `cs-${randomBytes(4).toString('hex')}@contoh.test`,
    fromName: 'Tim CS',
    color: 'tagBlue',
    ...server(),
    ...overrides,
  };
}

async function signIn(role: UserRole, name = `Pengguna ${role}`) {
  const hasher = createPasswordHasher();
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    name,
    email: `${role}-${randomBytes(4).toString('hex')}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { user, signed: await login(harness.app, { email: user.email, password: PASSWORD }) };
}

async function create(signed: SignedIn, payload: Record<string, unknown>) {
  return call(harness.app, 'POST', API_ROUTES.mail.accounts, payload, signed);
}

const accountPath = (template: string, accountId: string) => apiPath(template, { accountId });

beforeAll(async () => {
  imap = await startFakeMailImap({ password: IMAP_PASSWORD });
  harness = await createIntegrationHarness({
    overrides: {
      mailLookup: lookup,
      mail: {
        imapPorts: [imap.port],
        testCa: TEST_IMAP_CERT,
        allowLoopback: true,
        imapTimeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
        smtpVerifier: (config) => {
          smtpCalls.push({ host: config.host, password: config.password.reveal() });
          const result: SmtpResult =
            config.password.reveal() === SMTP_OK_PASSWORD
              ? { ok: true }
              : {
                  ok: false,
                  code: 'auth_failed',
                  diagnostic: { stage: 'smtp', responseCode: 535 },
                };
          return Promise.resolve(result);
        },
        detectionDns: {
          resolveMx: () => Promise.resolve([{ exchange: 'mail.perusahaan.test' }]),
          resolveSrv: () => Promise.reject(new Error('tidak ada')),
          lookup: (host) =>
            Promise.resolve(
              host === 'mail.lan.test'
                ? [{ address: '192.168.10.5', family: 4 }]
                : [{ address: '203.0.113.10', family: 4 }],
            ),
        },
        fetchRemote: (request) => {
          fetchCalls.push(request);
          return Promise.resolve({ ok: false, error: 'dns', httpStatus: null });
        },
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  fetchCalls.length = 0;
  smtpCalls.length = 0;
});

afterAll(async () => {
  await harness?.close();
  await imap?.close();
});

describe('buat akun bersama', () => {
  it('Owner + konfirmasi → 201; password tidak keluar, tersimpan terenkripsi, audit tanpa password', async () => {
    const response = await create(owner, {
      ...body({ emailAddress: 'cs@contoh.test' }),
      confirmation: await confirmationOf(owner),
    });
    expect(response.statusCode, response.body).toBe(201);
    const { account } = mailAccountResponseSchema.parse(response.json());
    expect(account).toMatchObject({ kind: 'shared', myLevel: 'manage', redacted: false });
    expect(account.sync.state).toBe('initial_sync');
    expect(account.imap?.password).toMatch(/^••••/);
    expect(response.body).not.toContain(IMAP_PASSWORD);

    const [row] = await harness.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, account.id));
    expect(row?.imapPasswordEncrypted).toMatch(/^v1\./);
    expect(row?.imapPasswordEncrypted).not.toContain(IMAP_PASSWORD);
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'mail.account.created'), eq(auditLogs.targetId, account.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(IMAP_PASSWORD);
    expect(harness.logs.text()).not.toContain(IMAP_PASSWORD);
  });

  it('tanpa konfirmasi identitas → 400; tes Masuk gagal → 502 reason imap_auth_failed, tidak tersimpan', async () => {
    const noConfirm = await create(owner, body());
    expect(noConfirm.statusCode).toBe(400);
    const wrong = await create(owner, {
      ...body(server({ password: 'password-salah-sekali-x' })),
      confirmation: await confirmationOf(owner),
    });
    expect(wrong.statusCode).toBe(502);
    const error = errorEnvelopeSchema.parse(wrong.json()).error;
    expect(error.details?.map((detail) => detail.reason)).toContain('imap_auth_failed');
    expect(await harness.db.select().from(mailAccounts)).toHaveLength(0);
  });

  it('port/keamanan di luar 993-ssl/143-starttls ditolak 400; host LAN tanpa allowlist → 502 imap_host_blocked', async () => {
    const badPort = await create(owner, {
      ...body({
        smtp: { host: 'imap.contoh.test', port: 25, security: 'starttls', sameCredentials: true },
      }),
      confirmation: await confirmationOf(owner),
    });
    expect(badPort.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badPort.json()).error.details?.[0]?.reason).toBe(
      'port_not_allowed',
    );
    const lan = await create(owner, {
      ...body(server({ host: 'mail.lan.test' })),
      confirmation: await confirmationOf(owner),
    });
    expect(lan.statusCode).toBe(502);
    expect(errorEnvelopeSchema.parse(lan.json()).error.details?.map((d) => d.reason)).toContain(
      'imap_host_blocked',
    );
  });

  it('CS tidak bisa membuat akun bersama; Teknisi tidak bisa membuat akun pribadi', async () => {
    const { signed: cs } = await signIn('cs');
    expect((await create(cs, body())).statusCode).toBe(403);
    const { signed: teknisi } = await signIn('teknisi');
    expect((await create(teknisi, body({ kind: 'personal' }))).statusCode).toBe(403);
  });

  it('alamat ganda → 409 address_already_connected; akun pribadi dengan akses → 400', async () => {
    const address = 'billing@contoh.test';
    expect(
      (
        await create(owner, {
          ...body({ emailAddress: address }),
          confirmation: await confirmationOf(owner),
        })
      ).statusCode,
    ).toBe(201);
    const again = await create(owner, {
      ...body({ emailAddress: address }),
      confirmation: await confirmationOf(owner),
    });
    expect(again.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(again.json()).error.details?.[0]?.reason).toBe(
      'address_already_connected',
    );
    const { signed: cs, user } = await signIn('cs');
    const shared = await create(cs, {
      ...body({ kind: 'personal' }),
      access: [{ principalType: 'user', userId: user.id, level: 'read' }],
    });
    expect(shared.statusCode).toBe(400);
  });
});

describe('larangan alamat ganda dua arah dengan Channel Email', () => {
  const channelBody = (address: string) => ({
    type: 'email',
    name: 'Email CS',
    emailAddress: address,
    fromName: 'CS',
    imap: { host: 'imap.contoh.test', port: 993, security: 'ssl', username: 'x', password: 'y' },
    smtp: { mode: 'system' },
  });

  it('akun Email → Channel Email dengan alamat sama ditolak 409 address_is_mail_account', async () => {
    await create(owner, {
      ...body({ emailAddress: 'dua@contoh.test' }),
      confirmation: await confirmationOf(owner),
    });
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.channelConnections.list,
      { ...channelBody('dua@contoh.test'), confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason).toBe(
      'address_is_mail_account',
    );
  });

  it('Channel Email → akun Email dengan alamat sama ditolak 409 address_is_inbox_channel', async () => {
    const channel = await call(
      harness.app,
      'POST',
      API_ROUTES.channelConnections.list,
      { ...channelBody('inbox@contoh.test'), confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(channel.statusCode, channel.body).toBe(201);
    const response = await create(owner, {
      ...body({ emailAddress: 'inbox@contoh.test' }),
      confirmation: await confirmationOf(owner),
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason).toBe(
      'address_is_inbox_channel',
    );
  });
});

describe('akun pribadi terisolasi (termasuk dari Owner)', () => {
  it('CS membuat akun pribadi tanpa konfirmasi; Owner hanya melihat metadata redacted, semua rute isi 404', async () => {
    const { signed: cs } = await signIn('cs');
    const created = await create(cs, body({ kind: 'personal' }));
    expect(created.statusCode, created.body).toBe(201);
    const { account } = mailAccountResponseSchema.parse(created.json());
    expect(account.owner?.id).toBe(cs.session.user.id);

    for (const template of [
      API_ROUTES.mail.account,
      API_ROUTES.mail.accountFolders,
      API_ROUTES.mail.accountAvatar,
    ]) {
      const response = await call(
        harness.app,
        'GET',
        accountPath(template, account.id),
        undefined,
        owner,
      );
      expect(response.statusCode, template).toBe(404);
    }
    for (const template of [
      API_ROUTES.mail.accountSync,
      API_ROUTES.mail.accountPause,
      API_ROUTES.mail.accountTest,
    ]) {
      const response = await call(
        harness.app,
        'POST',
        accountPath(template, account.id),
        {},
        owner,
      );
      expect(response.statusCode, template).toBe(404);
    }
    const patch = await call(
      harness.app,
      'PATCH',
      accountPath(API_ROUTES.mail.account, account.id),
      { displayName: 'Diambil' },
      owner,
    );
    expect(patch.statusCode).toBe(404);
    const access = await call(
      harness.app,
      'PUT',
      accountPath(API_ROUTES.mail.accountAccess, account.id),
      { grants: [] },
      owner,
    );
    expect(access.statusCode).toBe(404);

    const ownList = mailAccountListResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.mail.accounts, undefined, owner)).json(),
    );
    expect(ownList.accounts.map((item) => item.id)).not.toContain(account.id);
    const settings = mailSettingsAccountListResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.mail.settingsAccounts, undefined, owner)).json(),
    );
    const meta = settings.accounts.find((item) => item.id === account.id);
    expect(meta?.redacted).toBe(true);
    expect(JSON.stringify(meta)).not.toContain('imap.contoh.test');

    // Owner tidak bisa memutus akun pribadi milik pengguna AKTIF.
    const remove = await call(
      harness.app,
      'DELETE',
      accountPath(API_ROUTES.mail.account, account.id),
      { confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(remove.statusCode).toBe(403);
    // Pemilik nonaktif → Owner boleh memutus.
    await harness.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, cs.session.user.id));
    const removed = await call(
      harness.app,
      'DELETE',
      accountPath(API_ROUTES.mail.account, account.id),
      { confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(removed.statusCode, removed.body).toBe(202);
    const [row] = await harness.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, account.id));
    expect(row?.syncState).toBe('deleting');
    expect(row?.imapPasswordEncrypted).toBeNull();
  });
});

describe('akses akun bersama', () => {
  async function sharedAccount() {
    const response = await create(owner, { ...body(), confirmation: await confirmationOf(owner) });
    return mailAccountResponseSchema.parse(response.json()).account;
  }

  it('memberi akses wajib konfirmasi; grant ke Admin ditolak; hak Baca tidak bisa aksi Kelola', async () => {
    const account = await sharedAccount();
    const { signed: cs, user: csUser } = await signIn('cs');
    const { user: admin } = await signIn('admin');
    const route = accountPath(API_ROUTES.mail.accountAccess, account.id);
    const grant = { grants: [{ principalType: 'user', userId: csUser.id, level: 'read' }] };
    expect((await call(harness.app, 'PUT', route, grant, owner)).statusCode).toBe(400);
    const forAdmin = await call(
      harness.app,
      'PUT',
      route,
      {
        grants: [{ principalType: 'user', userId: admin.id, level: 'read' }],
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(errorEnvelopeSchema.parse(forAdmin.json()).error.details?.[0]?.reason).toBe(
      'grant_for_admin',
    );
    const ok = await call(
      harness.app,
      'PUT',
      route,
      { ...grant, confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(ok.statusCode, ok.body).toBe(200);

    const read = mailAccountResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          accountPath(API_ROUTES.mail.account, account.id),
          undefined,
          cs,
        )
      ).json(),
    );
    expect(read.account.myLevel).toBe('read');
    expect(read.account.imap).toBeNull();
    const rename = await call(
      harness.app,
      'PATCH',
      accountPath(API_ROUTES.mail.account, account.id),
      { displayName: 'X' },
      cs,
    );
    expect(rename.statusCode).toBe(403);
    expect(
      (
        await call(
          harness.app,
          'POST',
          accountPath(API_ROUTES.mail.accountSync, account.id),
          {},
          cs,
        )
      ).statusCode,
    ).toBe(403);

    // Mengurangi tidak butuh konfirmasi.
    expect((await call(harness.app, 'PUT', route, { grants: [] }, owner)).statusCode).toBe(200);
    expect(
      (
        await call(
          harness.app,
          'GET',
          accountPath(API_ROUTES.mail.account, account.id),
          undefined,
          cs,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('"Kelola" tidak bisa menambah akses atau mengubah server', async () => {
    const account = await sharedAccount();
    const { signed: supervisor, user } = await signIn('supervisor');
    await call(
      harness.app,
      'PUT',
      accountPath(API_ROUTES.mail.accountAccess, account.id),
      {
        grants: [{ principalType: 'user', userId: user.id, level: 'manage' }],
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    const rename = await call(
      harness.app,
      'PATCH',
      accountPath(API_ROUTES.mail.account, account.id),
      { displayName: 'Billing' },
      supervisor,
    );
    expect(rename.statusCode, rename.body).toBe(200);
    const access = await call(
      harness.app,
      'PUT',
      accountPath(API_ROUTES.mail.accountAccess, account.id),
      { grants: [] },
      supervisor,
    );
    expect(access.statusCode).toBe(403);
    const server = await call(
      harness.app,
      'PATCH',
      accountPath(API_ROUTES.mail.account, account.id),
      {
        imap: {
          host: 'evil.contoh.test',
          port: imap.port,
          security: 'ssl',
          username: 'x',
          password: 'y',
        },
      },
      supervisor,
    );
    expect(server.statusCode).toBe(403);
    // Tes dengan kredensial tersimpan boleh (hasil saja, password tidak keluar).
    const stored = await call(
      harness.app,
      'POST',
      accountPath(API_ROUTES.mail.accountTest, account.id),
      {},
      supervisor,
    );
    expect(stored.statusCode, stored.body).toBe(200);
    expect(testMailAccountResponseSchema.parse(stored.json()).incoming?.ok).toBe(true);
    expect(stored.body).not.toContain(IMAP_PASSWORD);
    // Daftar akses boleh DIBACA pemegang Kelola, tidak bisa diubah (editable false).
    const view = await call(
      harness.app,
      'GET',
      accountPath(API_ROUTES.mail.accountAccess, account.id),
      undefined,
      supervisor,
    );
    expect(view.json()).toMatchObject({ editable: false });
  });

  it('tab Akses email (departemen) + navigation.mail untuk Teknisi', async () => {
    const account = await sharedAccount();
    const { signed: teknisi, user } = await signIn('teknisi');
    const me = () =>
      call(harness.app, 'GET', API_ROUTES.auth.me, undefined, teknisi).then((r) =>
        meResponseSchema.parse(r.json()),
      );
    expect((await me()).navigation?.mail).toBe(false);
    const team = apiPath(API_ROUTES.mail.teamAccess, { userId: user.id });
    const put = await call(
      harness.app,
      'PUT',
      team,
      {
        grants: [{ accountId: account.id, level: 'send' }],
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(put.statusCode, put.body).toBe(200);
    const view = teamMailAccessResponseSchema.parse(put.json());
    expect(view.accounts[0]).toMatchObject({ effectiveLevel: 'send', directLevel: 'send' });
    expect(view.menuVisible).toBe(true);
    expect((await me()).navigation?.mail).toBe(true);
    // Hanya Owner/Admin.
    expect((await call(harness.app, 'GET', team, undefined, teknisi)).statusCode).toBe(403);
    const subjects = await mailAccessUsersOf(harness.db, owner.session.organization.id, [user.id]);
    expect(subjects.get(user.id)?.role).toBe('teknisi');
  });
});

describe('tes, sinkron, foto, pengaturan, deteksi', () => {
  it('tes tanpa menyimpan memberi rincian Masuk & Keluar terpisah', async () => {
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.test,
      { emailAddress: 'cs@contoh.test', ...server(), targets: ['incoming', 'outgoing'] },
      owner,
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = testMailAccountResponseSchema.parse(response.json());
    expect(result.incoming).toMatchObject({ ok: true, code: 'ok' });
    expect(result.incoming?.details?.folderCount).toBe(5);
    expect(result.outgoing).toMatchObject({ ok: true, code: 'ok' });
    // SMTP sameCredentials memakai password IMAP.
    expect(smtpCalls.at(-1)?.password).toBe(IMAP_PASSWORD);
  });

  it('sinkron sekarang 202, jeda/lanjut, foto PNG, pengaturan retensi', async () => {
    const { account } = mailAccountResponseSchema.parse(
      (await create(owner, { ...body(), confirmation: await confirmationOf(owner) })).json(),
    );
    expect(
      (
        await call(
          harness.app,
          'POST',
          accountPath(API_ROUTES.mail.accountSync, account.id),
          {},
          owner,
        )
      ).statusCode,
    ).toBe(202);
    const paused = await call(
      harness.app,
      'POST',
      accountPath(API_ROUTES.mail.accountPause, account.id),
      {},
      owner,
    );
    expect(mailAccountResponseSchema.parse(paused.json()).account.sync.state).toBe('paused');
    expect(
      (
        await call(
          harness.app,
          'POST',
          accountPath(API_ROUTES.mail.accountSync, account.id),
          {},
          owner,
        )
      ).statusCode,
    ).toBe(409);
    const resumed = await call(
      harness.app,
      'POST',
      accountPath(API_ROUTES.mail.accountResume, account.id),
      {},
      owner,
    );
    expect(mailAccountResponseSchema.parse(resumed.json()).account.sync.state).toBe('syncing');

    const png = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#2266aa' },
    })
      .png()
      .toBuffer();
    const put = await call(
      harness.app,
      'PUT',
      accountPath(API_ROUTES.mail.accountAvatar, account.id),
      { image: png.toString('base64') },
      owner,
    );
    expect(put.statusCode, put.body).toBe(200);
    const url = put.json<{ avatarUrl: string }>().avatarUrl;
    const image = await call(harness.app, 'GET', url, undefined, owner);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    const meta = await sharp(image.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const rejected = await call(
      harness.app,
      'PUT',
      accountPath(API_ROUTES.mail.accountAvatar, account.id),
      { image: svg.toString('base64') },
      owner,
    );
    expect(rejected.statusCode).toBe(415);

    const settings = await call(
      harness.app,
      'PUT',
      API_ROUTES.mail.settings,
      { cacheRetentionDays: 30, defaultSyncWindowDays: 90 },
      owner,
    );
    expect(settings.statusCode).toBe(200);
    const { signed: cs } = await signIn('cs');
    expect(
      (await call(harness.app, 'GET', API_ROUTES.mail.settings, undefined, cs)).statusCode,
    ).toBe(403);
  });

  it('deteksi: autoconfig/ISPDB tanpa alamat privat; tebakan mail.<domain> LAN tidak disarankan', async () => {
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.detect,
      { emailAddress: 'budi@perusahaan.test' },
      owner,
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ suggestions: { source: string; provider: string }[] }>();
    expect(result.suggestions[0]).toMatchObject({ source: 'mx', provider: 'cpanel' });
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const request of fetchCalls) {
      expect(request.privateCidrs).toEqual([]);
      expect(request.url.startsWith('https://')).toBe(true);
      expect(request.maxRedirects).toBe(2);
    }
    const lan = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.detect,
      { emailAddress: 'budi@lan.test' },
      owner,
    );
    expect(lan.json<{ suggestions: unknown[] }>().suggestions).toEqual([]);
  });

  it('log tidak memuat password', () => {
    expect(createLogCapture).toBeDefined();
    expect(harness.logs.text()).not.toContain(IMAP_PASSWORD);
  });
});
