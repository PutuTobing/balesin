/**
 * Review keamanan Fase 9 tahap 9A bagian 1 — fondasi akun Email & sinkron
 * (docs/security-reviews/2026-11-23-fase9a-1.md).
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 * Postgres + Redis sungguhan, server IMAP TIRUAN di loopback, SMTP diganti verifier tiruan yang
 * mencatat host + password yang DIKIRIM (tidak ada sambungan ke luar).
 */
import { randomBytes } from 'node:crypto';

import { startFakeMailImap, TEST_IMAP_CERT, type FakeMailImapServer } from '@balesin/core/testing';
import type { SmtpResult } from '@balesin/core';
import { mailAccountAccess, mailAccounts, mailIdentities, users } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  mailAccountResponseSchema,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import { insertUser } from '@balesin/db/testing';
import {
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const IMAP_PASSWORD = 'rahasia-imap-review-9a1-panjang';
const PASSWORD = 'sandi-uji-review-9a1-01';
const ATTACKER_HOST = 'smtp.penyerang.test';

let harness: IntegrationHarness;
let imap: FakeMailImapServer;
let owner: SignedIn;
const smtpCalls: { host: string; password: string }[] = [];

function shared(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: `cs-${randomBytes(4).toString('hex')}@contoh.test`,
    fromName: 'Tim CS',
    color: 'tagBlue',
    imap: {
      host: 'imap.contoh.test',
      port: imap.port,
      security: 'ssl',
      username: 'cs@contoh.test',
      password: IMAP_PASSWORD,
    },
    smtp: { host: 'imap.contoh.test', port: 465, security: 'ssl', sameCredentials: true },
    ...overrides,
  };
}

async function createShared() {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.mail.accounts,
    { ...shared(), confirmation: await confirmationOf(owner) },
    owner,
  );
  expect(response.statusCode, response.body).toBe(201);
  return mailAccountResponseSchema.parse(response.json()).account;
}

beforeAll(async () => {
  imap = await startFakeMailImap({ password: IMAP_PASSWORD });
  harness = await createIntegrationHarness({
    overrides: {
      mailLookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      mail: {
        imapPorts: [imap.port],
        testCa: TEST_IMAP_CERT,
        allowLoopback: true,
        imapTimeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
        // Server SMTP "penyerang" menerima password apa pun: yang diuji adalah APA yang dikirim.
        smtpVerifier: (config) => {
          smtpCalls.push({ host: config.host, password: config.password.reveal() });
          const result: SmtpResult = { ok: true };
          return Promise.resolve(result);
        },
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  smtpCalls.length = 0;
});

afterAll(async () => {
  await harness?.close();
  await imap?.close();
});

describe('S1 (Tinggi) — password tersimpan bisa diarahkan ke host SMTP baru', () => {
  it('POST /mail/accounts/test {accountId, smtp: host baru + sameCredentials} TIDAK boleh mengirim password IMAP tersimpan ke host itu (tanpa konfirmasi identitas)', async () => {
    const account = await createShared();
    smtpCalls.length = 0;
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.test,
      {
        accountId: account.id,
        emailAddress: account.emailAddress,
        smtp: { host: ATTACKER_HOST, port: 465, security: 'ssl', sameCredentials: true },
        targets: ['outgoing'],
      },
      owner,
    );
    // Perilaku aman: 400 password_required (server berubah → isi ulang password), dan password
    // tersimpan tidak pernah dikirim ke host yang belum pernah disimpan.
    expect(
      smtpCalls.filter((entry) => entry.host === ATTACKER_HOST && entry.password === IMAP_PASSWORD),
    ).toHaveLength(0);
    expect(response.statusCode).toBe(400);
  });

  it('PATCH /mail/accounts/:id {smtp: host baru + sameCredentials} tanpa password → 400 password_required (kontrak §4: ganti host tanpa password ditolak)', async () => {
    const account = await createShared();
    smtpCalls.length = 0;
    const response = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.mail.account, { accountId: account.id }),
      {
        smtp: { host: ATTACKER_HOST, port: 465, security: 'ssl', sameCredentials: true },
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason).toBe(
      'password_required',
    );
    expect(smtpCalls.some((entry) => entry.host === ATTACKER_HOST)).toBe(false);
  });

  it('regresi: tes dengan accountId + IMAP host baru tanpa password → 400 password_required', async () => {
    const account = await createShared();
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.test,
      {
        accountId: account.id,
        emailAddress: account.emailAddress,
        imap: { host: ATTACKER_HOST, port: imap.port, security: 'ssl', username: 'cs@contoh.test' },
        targets: ['incoming'],
      },
      owner,
    );
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason).toBe(
      'password_required',
    );
  });
});

describe('S4 (Sedang) — alamat akun tidak terikat ke kotak surat (penguasaan alamat)', () => {
  it('CS tidak bisa mendaftarkan akun pribadi berlabel alamat lain (billing@) dengan kredensial kotak suratnya sendiri sebagai identitas TERVERIFIKASI', async () => {
    const hasher = createPasswordHasher();
    const csUser = await insertUser(harness.db, owner.session.organization.id, {
      role: 'cs',
      name: 'CS dibobol',
      email: `cs-${randomBytes(4).toString('hex')}@majujaya.test`,
      passwordHash: await hasher.hash(PASSWORD),
    });
    const cs = await login(harness.app, { email: csUser.email, password: PASSWORD });
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.accounts,
      // Kredensial IMAP milik cs@contoh.test, tetapi alamat yang diklaim billing@contoh.test.
      shared({ kind: 'personal', emailAddress: 'billing@contoh.test' }),
      cs,
    );
    if (response.statusCode === 201) {
      const { account } = mailAccountResponseSchema.parse(response.json());
      const [identity] = await harness.db
        .select()
        .from(mailIdentities)
        .where(eq(mailIdentities.accountId, account.id));
      // Diterima hanya bila identitasnya TIDAK ditandai terverifikasi.
      expect(identity?.verifiedAt ?? null).toBeNull();
    } else {
      expect(response.statusCode).toBe(400);
    }
    // Dampak bila lolos: Owner tidak bisa lagi menghubungkan billing@ sebagai akun bersama (409)
    // dan tidak bisa memutus akun pribadi itu selama CS aktif (403).
    const rows = await harness.db.select().from(mailAccounts);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

// ── Regresi S4 (lanjutan), R5, R6 ─────────────────────────────────────────────────────────────

async function signInAs(role: 'cs' | 'supervisor') {
  const hasher = createPasswordHasher();
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    name: `Pengguna ${role}`,
    email: `${role}-${randomBytes(4).toString('hex')}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { user, signed: await login(harness.app, { email: user.email, password: PASSWORD }) };
}

/**
 * Jalankan `request` selagi transaksi LAIN memegang kunci baris (`lock`), lalu lepaskan kunci itu
 * begitu `request` terbukti menunggu kunci tersebut (atau setelah 5 dtk bila tidak pernah menunggu —
 * artinya pemeriksaan ulang di dalam transaksi tidak ada). Mensimulasikan perubahan yang terjadi di
 * antara pemeriksaan awal dan transaksi.
 */
async function whileRowLocked<T>(
  lock: (
    tx: Parameters<Parameters<IntegrationHarness['db']['transaction']>[0]>[0],
  ) => Promise<void>,
  request: () => Promise<T>,
): Promise<T> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holderPid = 0;
  let markLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const holder = harness.db.transaction(async (tx) => {
    await lock(tx);
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    holderPid = Number((result.rows[0] as { pid: number }).pid);
    markLocked();
    await gate;
  });
  await locked;
  const pending = request();
  for (let waited = 0; waited < 5_000; waited += 50) {
    const blocked = await harness.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`,
    );
    if (Number((blocked.rows[0] as { n: number }).n) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await holder;
  return pending;
}

describe('S4 (Sedang) — verifikasi alamat tidak terbawa ke alamat/kotak surat lain', () => {
  it('ganti alamat akun → identitas utama kembali BELUM terverifikasi; ubah nama saja tidak menyentuhnya', async () => {
    const account = await createShared();
    const verifiedAt = new Date('2026-11-01T00:00:00Z');
    await harness.db
      .update(mailIdentities)
      .set({ verifiedAt })
      .where(eq(mailIdentities.accountId, account.id));
    const rename = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.mail.account, { accountId: account.id }),
      { displayName: 'CS Utama' },
      owner,
    );
    expect(rename.statusCode, rename.body).toBe(200);
    const identity = async () =>
      (
        await harness.db
          .select()
          .from(mailIdentities)
          .where(eq(mailIdentities.accountId, account.id))
      )[0];
    expect((await identity())?.verifiedAt?.toISOString()).toBe(verifiedAt.toISOString());

    const moved = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.mail.account, { accountId: account.id }),
      {
        emailAddress: `lain-${randomBytes(3).toString('hex')}@contoh.test`,
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(moved.statusCode, moved.body).toBe(200);
    const after = await identity();
    expect(after?.address).toBe(mailAccountResponseSchema.parse(moved.json()).account.emailAddress);
    expect(after?.verifiedAt ?? null).toBeNull();
  });
});

describe('R5 (Rendah) — "buat akun" & "ubah server" memakai jatah tes koneksi yang sama', () => {
  it('setelah jatah tes (10/5 menit) habis, POST /mail/accounts dan PATCH server → 429 sebelum menyambung', async () => {
    const account = await createShared(); // 1 dari 10
    for (let index = 0; index < 9; index += 1) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.mail.test,
        {
          emailAddress: 'cs@contoh.test',
          imap: {
            host: 'imap.contoh.test',
            port: imap.port,
            security: 'ssl',
            username: 'cs@contoh.test',
          },
          targets: ['incoming'],
        },
        owner,
      );
      expect(response.statusCode, response.body).toBe(400);
    }
    const commandsBefore = imap.commands.length;
    const create = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.accounts,
      { ...shared(), confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(create.statusCode, create.body).toBe(429);
    const patch = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.mail.account, { accountId: account.id }),
      {
        imap: {
          host: 'imap.contoh.test',
          port: imap.port,
          security: 'ssl',
          username: 'cs@contoh.test',
          password: IMAP_PASSWORD,
        },
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(patch.statusCode, patch.body).toBe(429);
    // Tidak ada sambungan IMAP baru (alat tebak password pihak ketiga tertutup).
    expect(imap.commands.length).toBe(commandsBefore);
  });
});

describe('R6 (Rendah) — pemeriksaan ulang di dalam transaksi', () => {
  it('PUT /settings/team/:userId/mail-access: target dipromosikan Admin di antara pemeriksaan & transaksi → 400 grant_for_admin', async () => {
    const account = await createShared();
    const { user } = await signInAs('cs');
    const confirmation = await confirmationOf(owner);
    const response = await whileRowLocked(
      async (tx) => {
        await tx.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
      },
      () =>
        call(
          harness.app,
          'PUT',
          apiPath(API_ROUTES.mail.teamAccess, { userId: user.id }),
          { grants: [{ accountId: account.id, level: 'manage' }], confirmation },
          owner,
        ),
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason).toBe(
      'grant_for_admin',
    );
    const grants = await harness.db
      .select()
      .from(mailAccountAccess)
      .where(eq(mailAccountAccess.accountId, account.id));
    expect(grants.filter((grant) => grant.userId === user.id)).toEqual([]);
  });

  it('DELETE akun pribadi oleh Owner: pemilik diaktifkan lagi di antara pemeriksaan & transaksi → 403, akun tetap', async () => {
    const { user, signed: cs } = await signInAs('cs');
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.accounts,
      shared({ kind: 'personal' }),
      cs,
    );
    expect(created.statusCode, created.body).toBe(201);
    const { account } = mailAccountResponseSchema.parse(created.json());
    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    const confirmation = await confirmationOf(owner);
    const response = await whileRowLocked(
      async (tx) => {
        await tx.update(users).set({ disabledAt: null }).where(eq(users.id, user.id));
      },
      () =>
        call(
          harness.app,
          'DELETE',
          apiPath(API_ROUTES.mail.account, { accountId: account.id }),
          { confirmation },
          owner,
        ),
    );
    expect(response.statusCode, response.body).toBe(403);
    const [row] = await harness.db
      .select({ deletedAt: mailAccounts.deletedAt })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, account.id));
    expect(row?.deletedAt ?? null).toBeNull();
  });
});
