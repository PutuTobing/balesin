/**
 * Review keamanan Fase 9 tahap 9A bagian 1 (docs/security-reviews/2026-11-23-fase9a-1.md) — worker
 * sinkron terhadap server IMAP yang DIKENDALIKAN PENYERANG (CS boleh menghubungkan akun pribadi ke
 * host apa pun yang publik). Server jahat disimulasikan dengan sesi tiruan di memori (tanpa jaringan).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang). Saat
 * diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  createLogger,
  createSecretBox,
  EMAIL_JOBS,
  ImapFailure,
  Secret,
  sealMailAccountSecret,
  type MailBodyStructureNode,
  type MailImapSession,
  type MailSessionLimits,
  type Redis,
} from '@balesin/core';
import { connectTestRedis, createLogCapture, deleteRedisKeys } from '@balesin/core/testing';
import {
  auditLogs,
  closeDb,
  createDb,
  mailAccountAccess,
  mailAccounts,
  mailFolders,
  mailIdentities,
  mailMessages,
  newId,
  users,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { mailFolderDisplayName } from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createIdleSupervisor } from '../mail-idle/supervisor';
import { processEmailJob } from '../queues/email';
import { runMailTick } from '../queues/mail';
import { createMailReader } from './read';
import { createMailSync } from './sync';

const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-review-mail', level: 'silent' });

let db: Database;
let redis: Redis;
const prefix = `balesin-tes-review-mail-${randomBytes(4).toString('hex')}`;

/** Sesi server jahat: LIST tidak pernah selesai (tarpit / aliran tanpa akhir). */
function tarpitSession(closed: { value: boolean }): MailImapSession {
  const never = () => new Promise<never>(() => undefined);
  return {
    capabilities: {
      idle: true,
      condstore: false,
      qresync: false,
      move: false,
      uidplus: false,
      specialUse: false,
      quota: false,
    },
    listFolders: never,
    quota: () => Promise.resolve(null),
    status: never,
    select: never,
    searchUids: never,
    fetchHeaders: never,
    fetchFlags: never,
    idle: never,
    close: () => {
      closed.value = true;
      return Promise.resolve();
    },
  };
}

async function seedAccount() {
  const organization = await insertOrganization(db);
  const id = newId();
  await db.insert(mailAccounts).values({
    id,
    organizationId: organization.id,
    kind: 'shared',
    provider: 'imap',
    displayName: 'Jahat',
    emailAddress: `x-${randomBytes(3).toString('hex')}@penyerang.test`,
    fromName: 'X',
    color: 'tagBlue',
    imapHost: 'imap.penyerang.test',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'x',
    imapPasswordEncrypted: sealMailAccountSecret(
      secretBox,
      { id, organizationId: organization.id },
      'imapPassword',
      'apa-saja',
    ),
    smtpHost: 'imap.penyerang.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    nextAttemptAt: new Date(),
  });
  await db.insert(mailIdentities).values({
    organizationId: organization.id,
    accountId: id,
    address: 'x@penyerang.test',
    displayName: 'X',
    isPrimary: true,
  });
  return { organizationId: organization.id, accountId: id };
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-mail' });
  redis = await connectTestRedis('client', logger, 'balesin-tes-review-mail');
});

afterAll(async () => {
  await deleteRedisKeys(redis, prefix);
  await closeRedis(redis);
  await closeDb(db);
});

/** Sesi server jahat yang "sah" tetapi raksasa: N email di Kotak masuk, struktur MIME tertentu. */
function floodSession(count: number, bodyStructure: MailBodyStructureNode | null): MailImapSession {
  const status = {
    messages: count,
    unseen: 0,
    uidNext: count + 1,
    uidValidity: 7,
    highestModseq: null,
  };
  return {
    capabilities: {
      idle: false,
      condstore: false,
      qresync: false,
      move: false,
      uidplus: false,
      specialUse: false,
      quota: false,
    },
    listFolders: () =>
      Promise.resolve([
        { path: 'INBOX', delimiter: '/', flags: [], subscribed: true, selectable: true, status },
      ]),
    quota: () => Promise.resolve(null),
    status: () => Promise.resolve(status),
    select: () =>
      Promise.resolve({ uidValidity: 7, uidNext: count + 1, exists: count, highestModseq: null }),
    searchUids: () => Promise.resolve(Array.from({ length: count }, (_, index) => index + 1)),
    fetchHeaders: (uids) =>
      Promise.resolve(
        uids.map((uid) => ({
          uid,
          flags: [],
          internalDate: new Date(),
          size: 100,
          headers: Buffer.from(`Subject: banjir ${String(uid)}\r\nFrom: a@penyerang.test\r\n`),
          bodyStructure,
          textPreview: null,
          modseq: null,
        })),
      ),
    fetchFlags: () => Promise.resolve([]),
    idle: () => Promise.reject(new Error('tanpa IDLE')),
    close: () => Promise.resolve(),
  };
}

function wideStructure(width: number, depth: number): MailBodyStructureNode {
  const node = (level: number, part: string): MailBodyStructureNode => ({
    part,
    type: level === depth ? 'text/plain' : 'multipart/mixed',
    encoding: null,
    charset: null,
    size: 1,
    disposition: null,
    filename: level === depth ? 'x'.repeat(200) : null,
    id: null,
    childNodes:
      level === depth
        ? []
        : Array.from({ length: width }, (_, index) => node(level + 1, `${part}.${String(index)}`)),
  });
  return node(0, '1');
}

function syncWith(session: MailImapSession) {
  return createMailSync({
    db,
    logger,
    secretBox,
    publisher: { publish: () => Promise.resolve() },
    imap: {},
    connector: () => Promise.resolve(session),
  });
}

describe('S3 (Sedang) — penimbunan data dari server jahat ke Postgres bersama', () => {
  it('satu job sinkron punya anggaran header (saran ≤ 2.000 per job; sisanya job berikutnya)', async () => {
    const seed = await seedAccount();
    const result = await syncWith(floodSession(2_500, null)).syncAccount(seed);
    expect(result.status).toBe('synced');
    expect(result.status === 'synced' ? result.created : 0).toBeLessThanOrEqual(2_000);
  }, 60_000);

  it('`bodystructure` yang disimpan per email dibatasi (≤ 64 KB) walau server mengirim struktur MIME raksasa', async () => {
    const seed = await seedAccount();
    // 30 × 30 = 900 daun bernama 200 karakter ≈ ratusan KB per email (imapflow mengizinkan
    // hingga ~6 MB per respons; `structureOf` membatasi 100 anak × kedalaman 20).
    await syncWith(floodSession(1, wideStructure(30, 2))).syncAccount(seed);
    const [row] = await db
      .select({ size: sql<number>`octet_length(${mailMessages.bodystructure}::text)` })
      .from(mailMessages)
      .where(eq(mailMessages.accountId, seed.accountId));
    expect(row?.size ?? 0).toBeGreaterThan(0);
    expect(row?.size ?? 0).toBeLessThanOrEqual(64 * 1024);
  }, 30_000);
});

describe('S2 (Tinggi) — sinkron tanpa tenggat total terhadap server jahat', () => {
  it('syncAccount ke server yang tidak pernah menyelesaikan LIST selesai (gagal + backoff) dalam tenggat totalMs, sambungan ditutup', async () => {
    const closed = { value: false };
    const sync = createMailSync({
      db,
      logger,
      secretBox,
      publisher: { publish: () => Promise.resolve() },
      imap: {
        timeouts: { connectionMs: 1_000, greetingMs: 1_000, socketMs: 1_000, totalMs: 1_500 },
      },
      connector: () => Promise.resolve(tarpitSession(closed)),
    });
    const seed = await seedAccount();
    const outcome = await Promise.race([
      sync.syncAccount(seed),
      new Promise<'hang'>((resolve) => setTimeout(() => resolve('hang'), 4_000)),
    ]);
    // Yang DIHARAPKAN: job berhenti sendiri (status gagal, backoff dicatat) dan sesi ditutup.
    // Sekarang job menggantung selamanya → memegang 1 dari 4 slot `concurrency` antrean `mail`
    // (juga `mail-tick`) dan sewa kerja kedaluwarsa setelah 10 mnt tanpa diperpanjang.
    expect(outcome).not.toBe('hang');
    expect(closed.value).toBe(true);
  }, 10_000);
});

// ── Regresi temuan Rendah R2–R6 & S2 (sesi kerja isi/aksi) ─────────────────────────────────────

const IDLE_CAPS = {
  idle: true,
  condstore: false,
  qresync: false,
  move: false,
  uidplus: false,
  specialUse: false,
  quota: false,
};

/** Sesi IDLE tiruan: `idle()` menunggu sampai dibatalkan. Mencatat host yang dibuka & penutupan. */
function idleSession(state: { hosts: string[]; closed: number }, host: string): MailImapSession {
  state.hosts.push(host);
  return {
    capabilities: IDLE_CAPS,
    listFolders: () => Promise.resolve([]),
    quota: () => Promise.resolve(null),
    status: () => Promise.reject(new Error('tidak dipakai')),
    select: () => Promise.resolve({ uidValidity: 1, uidNext: 1, exists: 0, highestModseq: null }),
    searchUids: () => Promise.resolve([]),
    fetchHeaders: () => Promise.resolve([]),
    fetchFlags: () => Promise.resolve([]),
    idle: ({ signal, maxMs }) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, maxMs).unref();
      }),
    close: () => {
      state.closed += 1;
      return Promise.resolve();
    },
  };
}

/** Akun siap IDLE (status `ready`, kapabilitas IDLE, folder Kotak masuk). */
async function seedIdleAccount(
  organizationId: string,
  overrides: { kind?: 'shared' | 'personal'; ownerUserId?: string } = {},
) {
  const id = newId();
  await db.insert(mailAccounts).values({
    id,
    organizationId,
    kind: overrides.kind ?? 'shared',
    ownerUserId: overrides.ownerUserId ?? null,
    provider: 'imap',
    displayName: 'IDLE',
    emailAddress: `idle-${randomBytes(3).toString('hex')}@contoh.test`,
    fromName: 'X',
    color: 'tagBlue',
    imapHost: 'imap.lama.test',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'idle@contoh.test',
    imapPasswordEncrypted: sealMailAccountSecret(
      secretBox,
      { id, organizationId },
      'imapPassword',
      'password-lama',
    ),
    smtpHost: 'imap.lama.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    syncState: 'ready',
    capabilities: IDLE_CAPS,
  });
  await db.insert(mailFolders).values({
    organizationId,
    accountId: id,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    roleSource: 'special_use',
  });
  return id;
}

const until = async (check: () => boolean, ms = 3_000) => {
  for (let waited = 0; waited < ms && !check(); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('R2 (Rendah) — IDLE mengikuti perubahan server/kredensial & pemilik nonaktif', () => {
  function supervisorFor(organizationId: string, state: { hosts: string[]; closed: number }) {
    return createIdleSupervisor({
      db,
      redis,
      logger,
      secretBox,
      prefix,
      organizationIds: [organizationId],
      scanIntervalMs: 60_000,
      retryAfterFailureMs: 0,
      sync: { policyFor: () => Promise.resolve({ allowedPorts: [993] }) },
      connector: (config) => Promise.resolve(idleSession(state, config.host)),
      enqueueFolder: () => Promise.resolve(),
    });
  }

  it('host/password diganti → sambungan IDLE lama (host & password LAMA) ditutup pada pindaian berikutnya', async () => {
    const organization = await insertOrganization(db);
    const accountId = await seedIdleAccount(organization.id);
    const state = { hosts: [] as string[], closed: 0 };
    const supervisor = supervisorFor(organization.id, state);
    try {
      await supervisor.scan();
      await until(() => state.hosts.length > 0);
      expect(supervisor.running()).toEqual([accountId]);
      expect(state.hosts).toEqual(['imap.lama.test']);
      // Admin mengganti server & password (mis. server lama dibobol); status tetap eligible.
      await db
        .update(mailAccounts)
        .set({
          imapHost: 'imap.baru.test',
          imapPasswordEncrypted: sealMailAccountSecret(
            secretBox,
            { id: accountId, organizationId: organization.id },
            'imapPassword',
            'password-baru',
          ),
        })
        .where(eq(mailAccounts.id, accountId));
      await supervisor.scan();
      await until(() => state.closed > 0 && supervisor.running().length === 0);
      expect(state.closed).toBeGreaterThan(0);
      expect(supervisor.running()).toEqual([]);
      // Pindaian berikutnya membuka ulang ke host BARU.
      await supervisor.scan();
      await until(() => state.hosts.length > 1);
      expect(state.hosts.at(-1)).toBe('imap.baru.test');
    } finally {
      await supervisor.close();
    }
  });

  it('pemilik akun pribadi dinonaktifkan → IDLE ditutup pada pindaian itu juga (tanpa menunggu tick)', async () => {
    const organization = await insertOrganization(db);
    const cs = await insertUser(db, organization.id, { role: 'cs' });
    const accountId = await seedIdleAccount(organization.id, {
      kind: 'personal',
      ownerUserId: cs.id,
    });
    const state = { hosts: [] as string[], closed: 0 };
    const supervisor = supervisorFor(organization.id, state);
    try {
      await supervisor.scan();
      await until(() => supervisor.running().length > 0);
      expect(supervisor.running()).toEqual([accountId]);
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.id));
      // Status akun masih `ready` (tick belum jalan), tetapi pemiliknya nonaktif.
      await supervisor.scan();
      await until(() => supervisor.running().length === 0);
      expect(supervisor.running()).toEqual([]);
      expect(state.closed).toBeGreaterThan(0);
    } finally {
      await supervisor.close();
    }
  });
});

describe('R3 (Rendah) — tick tidak menimpa `paused`/`auth_failed` saat pemilik nonaktif', () => {
  it('pemilik nonaktif lalu aktif lagi: jeda & login ditolak tetap; hanya akun aktif yang berhenti lalu lanjut', async () => {
    const organization = await insertOrganization(db);
    const cs = await insertUser(db, organization.id, { role: 'cs' });
    const ids = { paused: '', auth_failed: '', ready: '' };
    for (const state of ['paused', 'auth_failed', 'ready'] as const) {
      ids[state] = await seedIdleAccount(organization.id, { kind: 'personal', ownerUserId: cs.id });
      await db
        .update(mailAccounts)
        .set({ syncState: state, nextAttemptAt: null })
        .where(eq(mailAccounts.id, ids[state]));
    }
    const deps = {
      db,
      logger,
      redis,
      prefix,
      sync: syncWith(floodSession(0, null)),
      store: null,
      enqueueSync: () => Promise.resolve(),
      enqueuePurge: () => Promise.resolve(),
    };
    const stateOf = async () =>
      new Map(
        (
          await db
            .select({ id: mailAccounts.id, state: mailAccounts.syncState })
            .from(mailAccounts)
            .where(eq(mailAccounts.organizationId, organization.id))
        ).map((row) => [row.id, row.state]),
      );

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.id));
    await runMailTick(deps);
    let states = await stateOf();
    expect(states.get(ids.paused)).toBe('paused');
    expect(states.get(ids.auth_failed)).toBe('auth_failed');
    expect(states.get(ids.ready)).toBe('owner_inactive');

    await db.update(users).set({ disabledAt: null }).where(eq(users.id, cs.id));
    await runMailTick(deps);
    states = await stateOf();
    expect(states.get(ids.paused)).toBe('paused');
    expect(states.get(ids.auth_failed)).toBe('auth_failed');
    expect(states.get(ids.ready)).toBe('syncing');
  });
});

describe('R4 (Rendah) — nama/path folder dari server jahat', () => {
  it('nama folder dibersihkan dari karakter kendali & pengubah arah', () => {
    expect(mailFolderDisplayName('Tagihan‮gpj.exe', '/', null)).toBe('Tagihangpj.exe');
    expect(mailFolderDisplayName('A\u0000B\u0007C‏', '/', null)).toBe('ABC');
    expect(mailFolderDisplayName('\u0001\u0002', '/', null)).toBe('Folder');
    expect(Array.from(mailFolderDisplayName('x'.repeat(5_000), '/', null))).toHaveLength(200);
  });

  it('path/pemisah ber-NUL dilewati (tidak menggagalkan sinkron), nama yang disimpan bersih', async () => {
    const seed = await seedAccount();
    const folder = (path: string, delimiter: string | null = '/') => ({
      path,
      delimiter,
      flags: [],
      subscribed: true,
      selectable: true,
      status: null,
    });
    const session: MailImapSession = {
      ...floodSession(0, null),
      listFolders: () =>
        Promise.resolve([
          folder('INBOX'),
          folder('Tagihan‮gpj.exe'),
          folder('Rusak\u0000Path'),
          folder('Pemisah', '\u0000'),
          folder('\u0007\u0008'),
        ]),
    };
    const result = await syncWith(session).syncAccount(seed);
    expect(result).not.toMatchObject({ status: 'failed' });
    const rows = await db
      .select({ path: mailFolders.path, name: mailFolders.name })
      .from(mailFolders)
      .where(eq(mailFolders.accountId, seed.accountId));
    expect(rows.map((row) => row.path).sort()).toEqual(
      ['INBOX', 'Tagihan‮gpj.exe', '\u0007\u0008'].sort(),
    );
    for (const row of rows) {
      // eslint-disable-next-line no-control-regex -- memastikan karakter kendali tidak tersimpan.
      expect(row.name).not.toMatch(/[\u0000-\u001f‪-‮]/);
    }
  });
});

describe('R6 (Rendah) — pemberitahuan & log', () => {
  it('auth_failed berulang ("Sinkron sekarang"): paling banyak satu putaran pemberitahuan per akun per 24 jam', async () => {
    const seed = await seedAccount();
    await insertUser(db, seed.organizationId, { role: 'owner' });
    const notices: string[] = [];
    const rejected: MailImapSession = {
      ...floodSession(0, null),
      listFolders: () => Promise.reject(new ImapFailure('imap_auth_failed')),
    };
    const sync = createMailSync({
      db,
      logger,
      secretBox,
      publisher: { publish: () => Promise.resolve() },
      imap: {},
      connector: () => Promise.resolve(rejected),
      notify: (payload) => Promise.resolve(void notices.push(payload.recipientUserId)),
    });
    for (let round = 0; round < 3; round += 1) {
      expect(await sync.syncAccount(seed)).toEqual({ status: 'failed', code: 'imap_auth_failed' });
      // Pengguna menekan "Sinkron sekarang" / melanjutkan → dicoba lagi.
      await db
        .update(mailAccounts)
        .set({ syncState: 'ready', nextAttemptAt: new Date() })
        .where(eq(mailAccounts.id, seed.accountId));
    }
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, seed.accountId),
          eq(auditLogs.action, 'mail.account.auth_failed'),
        ),
      );
    expect(audits).toHaveLength(3);
    expect(notices).toHaveLength(1);
  });

  it('galat internal (mis. Drizzle memuat parameter kueri) dicatat tanpa subjek/alamat lawan', async () => {
    const capture = createLogCapture('info');
    const seed = await seedAccount();
    const leaky = Object.assign(
      new Error(
        'Failed query: insert into "mail_messages" ... params: Tagihan rahasia Budi,budi@pelanggan.test',
      ),
      { params: ['Tagihan rahasia Budi', 'budi@pelanggan.test'] },
    );
    const sync = createMailSync({
      db,
      logger: capture.logger,
      secretBox,
      publisher: { publish: () => Promise.resolve() },
      imap: {},
      connector: () =>
        Promise.resolve({ ...floodSession(0, null), listFolders: () => Promise.reject(leaky) }),
    });
    expect(await sync.syncAccount(seed)).toMatchObject({ status: 'failed' });
    const text = capture.text();
    expect(text).toContain('Sinkron akun email gagal (internal)');
    expect(text).not.toContain('Tagihan rahasia');
    expect(text).not.toContain('budi@pelanggan.test');
  });

  it('pemberitahuan password ditolak: hak penerima atas akun diperiksa ULANG saat mengirim', async () => {
    const organization = await insertOrganization(db);
    const cs = await insertUser(db, organization.id, { role: 'cs' });
    const accountId = await seedIdleAccount(organization.id);
    await db.insert(mailAccountAccess).values({
      organizationId: organization.id,
      accountId,
      principalType: 'user',
      userId: cs.id,
      level: 'manage',
    });
    const [audit] = await db
      .insert(auditLogs)
      .values({
        organizationId: organization.id,
        actorUserId: null,
        action: 'mail.account.auth_failed',
        targetType: 'mail_account',
        targetId: accountId,
        metadata: { kind: 'shared', code: 'imap_auth_failed' },
      })
      .returning({ id: auditLogs.id });
    const job = {
      name: EMAIL_JOBS.securityNoticeAdmin,
      data: {
        organizationId: organization.id,
        recipientUserId: cs.id,
        subjectUserId: cs.id,
        event: 'mail_account_auth_failed',
        occurredAt: new Date().toISOString(),
        auditLogId: audit?.id,
      },
    };
    const deps = {
      appUrl: 'https://balesin.contoh.test',
      db,
      secretBox,
      fallback: null,
      allowedPorts: [],
      logger,
    };
    // Masih Kelola → lolos pemeriksaan hak (lalu dilewati karena email organisasi belum diatur).
    expect(await processEmailJob(job, deps)).not.toEqual({
      status: 'skipped',
      reason: 'recipient_unavailable',
    });
    // Grant dicabut di antara antre & kirim → tidak dikirimi alamat akun itu.
    await db.delete(mailAccountAccess).where(eq(mailAccountAccess.accountId, accountId));
    expect(await processEmailJob(job, deps)).toEqual({
      status: 'skipped',
      reason: 'recipient_unavailable',
    });
  });
});

describe('S2 (Tinggi) — sesi kerja isi/lampiran/aksi punya tenggat total yang memutus sambungan', () => {
  function readerWith(connector: NonNullable<Parameters<typeof createMailReader>[0]['connector']>) {
    return createMailReader({
      db,
      logger,
      secretBox,
      publisher: { publish: () => Promise.resolve() },
      store: null,
      appUrl: 'https://balesin.contoh.test',
      policyFor: () => Promise.resolve({ allowedPorts: [993] }),
      sessionMs: 300,
      connector,
    });
  }

  async function accountOf(accountId: string) {
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
    if (!row) throw new Error('akun tidak ada');
    return row;
  }

  it('server tarpit saat menyambung: dibatalkan pada tenggat (bukan menggantung selamanya)', async () => {
    const seed = await seedAccount();
    let seen: AbortSignal | undefined;
    const reader = readerWith((_config, _policy, limits?: MailSessionLimits) => {
      seen = limits?.signal;
      return new Promise<never>((_resolve, reject) => {
        limits?.signal?.addEventListener(
          'abort',
          () => reject(new ImapFailure('imap_connection_timeout', 'ABORTED')),
          { once: true },
        );
      });
    });
    const started = Date.now();
    await expect(reader.openSession(await accountOf(seed.accountId))).rejects.toMatchObject({
      code: 'imap_connection_timeout',
    });
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('sesi yang sudah terbuka diputus saat tenggat habis (perintah tarpit tidak menahan slot antrean)', async () => {
    const seed = await seedAccount();
    const closed = { value: false };
    const never = () => new Promise<never>(() => undefined);
    const session = {
      ...tarpitSession(closed),
      openWritable: never,
      fetchSource: never,
      fetchPart: never,
      storeFlags: () => Promise.resolve(true),
      move: () => Promise.resolve(null),
      expunge: () => Promise.resolve(true),
      createFolder: () => Promise.resolve(true),
    };
    const reader = readerWith(() => Promise.resolve(session));
    const opened = await reader.openSession(await accountOf(seed.accountId));
    expect(closed.value).toBe(false);
    await until(() => closed.value);
    expect(closed.value).toBe(true);
    await opened.close();
  });
});
