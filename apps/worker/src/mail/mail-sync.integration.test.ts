/**
 * Worker sinkron modul Email (KONTRAK-API-EMAIL §11) — Postgres sungguhan + server IMAP TIRUAN
 * multi-folder (TLS sertifikat tes) + Redis tes (sewa IDLE).
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  createLogger,
  createSecretBox,
  Secret,
  sealMailAccountSecret,
  type MailBusEventInput,
} from '@balesin/core';
import {
  connectTestRedis,
  deleteRedisKeys,
  startFakeMailImap,
  TEST_IMAP_CERT,
  type FakeMailImapServer,
} from '@balesin/core/testing';
import {
  auditLogs,
  closeDb,
  createDb,
  mailAccounts,
  mailFolders,
  mailIdentities,
  mailMessages,
  newId,
  users,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import type { Redis } from '@balesin/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createIdleSupervisor } from '../mail-idle/supervisor';
import { acquireLease, mailIdleLeaseKey } from './lease';
import { backoffMinutes, createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-worker-01';
const DAY = 24 * 60 * 60 * 1000;
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-mail', level: 'silent' });

let db: Database;
let redis: Redis;
let imap: FakeMailImapServer;
const prefix = `balesin-tes-mail-${randomBytes(4).toString('hex')}`;
const published: MailBusEventInput[] = [];
const notices: { recipientUserId: string; event: string }[] = [];

function email(subject: string, extra: string[] = []): string {
  return [
    'From: "Budi‮ Santoso" <Budi@Pelanggan.Test>',
    'To: cs@contoh.test',
    'Delivered-To: billing@contoh.test',
    `Subject: ${subject}`,
    `Message-ID: <${randomBytes(6).toString('hex')}@pelanggan.test>`,
    'Date: Tue, 17 Nov 2026 10:00:00 +0700',
    ...extra,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Halo, tagihan bulan ini sudah saya bayar lewat transfer.',
    '',
  ].join('\r\n');
}

function syncFor() {
  return createMailSync({
    db,
    logger,
    secretBox,
    publisher: { publish: (events) => Promise.resolve(void published.push(...events)) },
    imap: {
      extraPorts: [imap.port],
      testCa: TEST_IMAP_CERT,
      allowLoopback: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
    },
    notify: (payload) => Promise.resolve(void notices.push(payload)),
  });
}

async function seedAccount(
  overrides: { password?: string; kind?: 'shared' | 'personal'; ownerUserId?: string } = {},
) {
  const organization = await insertOrganization(db);
  const owner = await insertUser(db, organization.id, { role: 'owner' });
  const id = newId();
  const address = 'cs@contoh.test';
  await db.insert(mailAccounts).values({
    id,
    organizationId: organization.id,
    kind: overrides.kind ?? 'shared',
    ownerUserId: overrides.ownerUserId ?? null,
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: address,
    fromName: 'Tim CS',
    color: 'tagBlue',
    imapHost: 'imap.contoh.test',
    imapPort: imap.port,
    imapSecurity: 'ssl',
    imapUsername: 'cs@contoh.test',
    imapPasswordEncrypted: sealMailAccountSecret(
      secretBox,
      { id, organizationId: organization.id },
      'imapPassword',
      overrides.password ?? PASSWORD,
    ),
    smtpHost: 'imap.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    trustedAuthServIds: ['mail.contoh.test'],
    nextAttemptAt: new Date(),
  });
  await db.insert(mailIdentities).values({
    organizationId: organization.id,
    accountId: id,
    address,
    displayName: 'Tim CS',
    isPrimary: true,
  });
  return { organizationId: organization.id, accountId: id, ownerId: owner.id };
}

const accountRow = async (id: string) =>
  (await db.select().from(mailAccounts).where(eq(mailAccounts.id, id)))[0];

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-mail' });
  redis = await connectTestRedis('client', logger, 'balesin-tes-mail');
});

beforeEach(async () => {
  await imap?.close();
  imap = await startFakeMailImap({ password: PASSWORD });
  published.length = 0;
  notices.length = 0;
});

afterAll(async () => {
  await imap?.close();
  await deleteRedisKeys(redis, prefix);
  await closeRedis(redis);
  await closeDb(db);
});

describe('sinkron awal & inkremental', () => {
  it('folder + peran Indonesia, header dalam jendela 90 hari dari yang terbaru, cuplikan, verifikasi', async () => {
    imap.add(
      'INBOX',
      email('Tagihan Nov', ['Authentication-Results: mail.contoh.test; dmarc=pass']),
      {
        internalDate: new Date(Date.now() - DAY),
      },
    );
    imap.add('INBOX', email('Lama'), {
      internalDate: new Date(Date.now() - 200 * DAY),
      flags: ['\\Seen'],
    });
    imap.add('INBOX.Sent', email('Terkirim'), {
      internalDate: new Date(Date.now() - 2 * DAY),
      flags: ['\\Seen'],
    });
    const seed = await seedAccount();
    const result = await syncFor().syncAccount(seed);
    expect(result).toMatchObject({ status: 'synced', created: 2 });

    const folders = await db
      .select()
      .from(mailFolders)
      .where(eq(mailFolders.accountId, seed.accountId));
    const byRole = Object.fromEntries(
      folders.map((folder) => [folder.role ?? folder.path, folder]),
    );
    expect(byRole.inbox?.name).toBe('Kotak masuk');
    expect(byRole.sent?.name).toBe('Terkirim');
    expect(byRole.junk?.name).toBe('Spam');
    expect(byRole.trash?.name).toBe('Sampah');
    expect(byRole.inbox?.hasOlderOnServer).toBe(true);

    const messages = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.accountId, seed.accountId));
    const inbox = messages.find((message) => message.subject === 'Tagihan Nov');
    expect(inbox).toMatchObject({
      fromAddress: 'budi@pelanggan.test',
      folderRole: 'inbox',
      isRead: false,
      senderVerification: 'pass',
      deliveredTo: 'billing@contoh.test',
      bodyState: 'none',
    });
    expect(inbox?.fromName).not.toContain('‮');
    expect(inbox?.snippet).toContain('tagihan bulan ini');
    expect(messages.some((message) => message.subject === 'Lama')).toBe(false);

    const account = await accountRow(seed.accountId);
    expect(account?.syncState).toBe('ready');
    expect(account?.capabilities).toMatchObject({ idle: true });
    // Event WS hanya ID & angka.
    expect(JSON.stringify(published)).not.toContain('Tagihan');
    expect(published.some((event) => event.event.type === 'mail.message.created')).toBe(true);
  });

  it('bendera berubah, email hilang, UIDVALIDITY berubah → sinkron ulang', async () => {
    const uid = imap.add('INBOX', email('Satu'));
    imap.add('INBOX', email('Dua'));
    const seed = await seedAccount();
    const sync = syncFor();
    await sync.syncAccount(seed);
    imap.setFlags('INBOX', uid, ['\\Seen', '\\Flagged']);
    imap.remove('INBOX', uid + 1);
    await sync.syncAccount({ ...seed, force: true });
    let messages = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.accountId, seed.accountId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ isRead: true, isStarred: true });

    imap.setUidValidity('INBOX', 99);
    published.length = 0;
    await sync.syncAccount({ ...seed, force: true });
    messages = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.accountId, seed.accountId));
    expect(messages.map((message) => message.uidvalidity)).toEqual([99]);
    expect(published.some((event) => event.event.type === 'mail.resync')).toBe(true);
  });
});

describe('ketahanan', () => {
  it('login ditolak → auth_failed, berhenti mencoba, audit + notifikasi', async () => {
    const seed = await seedAccount({ password: 'password-salah-x' });
    const result = await syncFor().syncAccount(seed);
    expect(result).toEqual({ status: 'failed', code: 'imap_auth_failed' });
    const account = await accountRow(seed.accountId);
    expect(account?.syncState).toBe('auth_failed');
    expect(account?.nextAttemptAt).toBeNull();
    expect(notices.map((notice) => notice.recipientUserId)).toContain(seed.ownerId);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'mail.account.auth_failed'),
          eq(auditLogs.targetId, seed.accountId),
        ),
      );
    expect(audit).toHaveLength(1);
    // auth_failed tidak dicoba lagi (job berikutnya dilewati).
    expect(await syncFor().syncAccount(seed)).toEqual({ status: 'skipped', reason: 'stopped' });
  });

  it('server tidak bisa dihubungi → error + backoff (1, 2, 5, 15, 30, 60 menit maks.)', async () => {
    const seed = await seedAccount();
    await imap.close();
    const before = Date.now();
    await syncFor().syncAccount(seed);
    const account = await accountRow(seed.accountId);
    expect(account?.syncState).toBe('error');
    expect((account?.nextAttemptAt?.getTime() ?? 0) - before).toBeGreaterThanOrEqual(55_000);
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMinutes)).toEqual([1, 2, 5, 15, 30, 60, 60, 60]);
  });

  it('pemilik akun pribadi nonaktif → owner_inactive (tanpa sambungan)', async () => {
    const organization = await insertOrganization(db);
    const cs = await insertUser(db, organization.id, { role: 'cs' });
    const id = newId();
    await db.insert(mailAccounts).values({
      id,
      organizationId: organization.id,
      kind: 'personal',
      ownerUserId: cs.id,
      provider: 'imap',
      displayName: 'Pribadi',
      emailAddress: `p-${id.slice(-6)}@contoh.test`,
      fromName: 'Saya',
      color: 'accent',
      imapHost: 'imap.contoh.test',
      imapPort: imap.port,
      imapSecurity: 'ssl',
      imapUsername: 'cs@contoh.test',
      imapPasswordEncrypted: sealMailAccountSecret(
        secretBox,
        { id, organizationId: organization.id },
        'imapPassword',
        PASSWORD,
      ),
      smtpHost: 'imap.contoh.test',
      smtpPort: 465,
      smtpSecurity: 'ssl',
    });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.id));
    const connectionsBefore = imap.commands.length;
    expect(await syncFor().syncAccount({ organizationId: organization.id, accountId: id })).toEqual(
      {
        status: 'skipped',
        reason: 'owner_inactive',
      },
    );
    expect((await accountRow(id))?.syncState).toBe('owner_inactive');
    expect(imap.commands.length).toBe(connectionsBefore);
  });
});

describe('IDLE', () => {
  it('satu IDLE per akun lewat sewa Redis; EXISTS → antre sinkron Kotak masuk', async () => {
    const seed = await seedAccount();
    const sync = syncFor();
    await sync.syncAccount(seed);
    const queued: string[] = [];
    // Replika lain sudah memegang sewa akun ini → tidak dibuka di sini.
    const foreign = await acquireLease(redis, mailIdleLeaseKey(prefix, seed.accountId), 60_000);
    const supervisor = createIdleSupervisor({
      db,
      redis,
      logger,
      secretBox,
      sync,
      prefix,
      debounceMs: 50,
      scanIntervalMs: 60_000,
      enqueueFolder: (payload) => Promise.resolve(void queued.push(payload.folderId)),
    });
    try {
      await supervisor.scan();
      expect(supervisor.running()).not.toContain(seed.accountId);
      await foreign?.release();
      await supervisor.scan();
      expect(supervisor.running()).toContain(seed.accountId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await accountRow(seed.accountId))?.idleActive).toBe(true);
      imap.add('INBOX', email('Masuk saat IDLE'));
      for (let i = 0; i < 40 && queued.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const [inbox] = await db
        .select()
        .from(mailFolders)
        .where(and(eq(mailFolders.accountId, seed.accountId), eq(mailFolders.role, 'inbox')));
      expect(queued).toContain(inbox?.id);
      // Dijeda → IDLE ditutup di pemindaian berikutnya.
      await db
        .update(mailAccounts)
        .set({ syncState: 'paused' })
        .where(eq(mailAccounts.id, seed.accountId));
      await supervisor.scan();
      for (let i = 0; i < 40 && supervisor.running().length > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(supervisor.running()).toEqual([]);
    } finally {
      await supervisor.close();
    }
  });
});
