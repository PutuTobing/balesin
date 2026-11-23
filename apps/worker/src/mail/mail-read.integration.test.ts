/**
 * Modul Email 9A bagian 2 — isi saat dibuka, lampiran saat diunduh, aksi dua arah tercermin ke server
 * IMAP TIRUAN (TLS sertifikat tes) + Postgres sungguhan. Juga regresi review 9A-1 R3 (tick tidak
 * menimpa `paused`/`auth_failed`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  createLogger,
  createMediaStore,
  createSecretBox,
  Secret,
  sealMailAccountSecret,
  type MailBusEventInput,
  type MediaStore,
} from '@balesin/core';
import { startFakeMailImap, TEST_IMAP_CERT, type FakeMailImapServer } from '@balesin/core/testing';
import {
  closeDb,
  createDb,
  mailAccounts,
  mailAttachments,
  mailFolders,
  mailIdentities,
  mailMessageBodies,
  mailMessages,
  newId,
  users,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { runMailTick } from '../queues/mail';
import { createMailActions } from './actions';
import { createMailReader } from './read';
import { createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-baca-01';
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-mail-baca', level: 'silent' });
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let db: Database;
let imap: FakeMailImapServer;
let mediaDir: string;
let store: MediaStore;
const published: MailBusEventInput[] = [];

const imapDeps = () => ({
  extraPorts: [imap.port],
  testCa: TEST_IMAP_CERT,
  allowLoopback: true,
  lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
  timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
});

function services() {
  const publisher = {
    publish: (events: readonly MailBusEventInput[]) =>
      Promise.resolve(void published.push(...events)),
  };
  const sync = createMailSync({ db, logger, secretBox, publisher, imap: imapDeps() });
  const reader = createMailReader({
    db,
    logger,
    secretBox,
    publisher,
    store,
    appUrl: 'https://cs.contoh.test',
    policyFor: (organizationId) => sync.policyFor(organizationId),
  });
  const actions = createMailActions({ db, logger, publisher, reader });
  return { sync, reader, actions };
}

const rich = [
  'From: "Tim Contoh" <noc@c0ntoh.test>',
  'To: cs@contoh.test',
  'Subject: Pemeliharaan',
  `Message-ID: <${randomBytes(4).toString('hex')}@mitra.test>`,
  'Date: Tue, 17 Nov 2026 10:00:00 +0700',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BATAS"',
  '',
  '--BATAS',
  'Content-Type: multipart/related; boundary="REL"',
  '',
  '--REL',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Jadwal <img src="cid:logo@mitra.test"> <img src="https://cdn.mitra.test/a.png"><script>alert(1)</script></p><p><a href="https://jahat.test/login">https://www.contoh.test/login</a></p>',
  '--REL',
  'Content-Type: image/png',
  'Content-ID: <logo@mitra.test>',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: inline',
  '',
  PNG.toString('base64'),
  '--REL--',
  '--BATAS',
  'Content-Type: application/pdf; name="jadwal.pdf"',
  'Content-Disposition: attachment; filename="jadwal.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 jadwal').toString('base64'),
  '--BATAS',
  'Content-Type: application/pdf; name="faktur.pdf"',
  'Content-Disposition: attachment; filename="faktur.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('MZ\x90\x00program jahat').toString('base64'),
  '--BATAS--',
  '',
].join('\r\n');

const plain = (subject: string) =>
  [
    'From: Budi <budi@pelanggan.test>',
    'To: cs@contoh.test',
    `Subject: ${subject}`,
    `Message-ID: <${randomBytes(4).toString('hex')}@pelanggan.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Halo',
    '',
  ].join('\r\n');

async function seedAccount() {
  const organization = await insertOrganization(db);
  await insertUser(db, organization.id, { role: 'owner' });
  const id = newId();
  await db.insert(mailAccounts).values({
    id,
    organizationId: organization.id,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: 'cs@contoh.test',
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
      PASSWORD,
    ),
    smtpHost: 'imap.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    nextAttemptAt: new Date(),
  });
  await db.insert(mailIdentities).values({
    organizationId: organization.id,
    accountId: id,
    address: 'cs@contoh.test',
    displayName: 'Tim CS',
    isPrimary: true,
  });
  return { organizationId: organization.id, accountId: id };
}

async function messageBySubject(accountId: string, subject: string) {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.subject, subject)));
  if (!row) throw new Error(`pesan ${subject}`);
  return row;
}

/** Tandai tertunda seperti api (optimistis). */
async function pend(
  id: string,
  values: Partial<typeof mailMessages.$inferInsert>,
  revert: { isRead: boolean; isStarred: boolean },
) {
  await db
    .update(mailMessages)
    .set({ ...values, pendingActionAt: new Date(), pendingRevert: revert })
    .where(eq(mailMessages.id, id));
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-mail-baca' });
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-mail-'));
  store = createMediaStore(mediaDir);
});

beforeEach(async () => {
  await imap?.close();
  imap = await startFakeMailImap({ password: PASSWORD });
  published.length = 0;
});

afterAll(async () => {
  await imap?.close();
  await closeDb(db);
  await rm(mediaDir, { recursive: true, force: true });
});

describe('isi email saat dibuka', () => {
  it('isi tersanitasi + penanda gambar, gambar inline disimpan, lampiran & risiko, peringatan, event', async () => {
    imap.add('INBOX', rich);
    const seed = await seedAccount();
    const { sync, reader } = services();
    await sync.syncAccount(seed);
    const message = await messageBySubject(seed.accountId, 'Pemeliharaan');
    expect(message.hasAttachments).toBe(true);
    published.length = 0;

    expect(await reader.fetchBody({ ...seed, messageId: message.id })).toMatchObject({
      status: 'ready',
    });
    const [body] = await db
      .select()
      .from(mailMessageBodies)
      .where(eq(mailMessageBodies.messageId, message.id));
    expect(body?.htmlSanitized).toContain('src="balesin-cid:logo@mitra.test"');
    expect(body?.htmlSanitized).toContain('src="balesin-remote:0"');
    expect(body?.htmlSanitized).not.toContain('<script');
    expect(body?.htmlSanitized).toContain('https://cs.contoh.test/email/tautan?ke=');
    expect(body?.remoteImages).toEqual(['https://cdn.mitra.test/a.png']);
    expect(body?.rawHeaders).toContain('Subject: Pemeliharaan');

    const attachments = await db
      .select()
      .from(mailAttachments)
      .where(eq(mailAttachments.messageId, message.id));
    const inline = attachments.find((row) => row.isInline);
    expect(inline?.storageKey).toMatch(/^mail\//);
    expect(inline?.detectedType).toBe('image/png');
    const pdf = attachments.find((row) => row.filename === 'jadwal.pdf');
    expect(pdf).toMatchObject({ risk: 'ok', storageKey: null });

    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, message.id));
    expect(after?.bodyState).toBe('ready');
    // Domain pengirim mirip domain organisasi (c0ntoh.test vs contoh.test), tautan menipu.
    expect(after?.warnings).toEqual(expect.arrayContaining(['link_mismatch', 'lookalike_sender']));
    expect(published.map((event) => event.event.type)).toContain('mail.message.updated');
    expect(JSON.stringify(published)).not.toContain('Pemeliharaan');

    // Lampiran PDF diambil saat diunduh; berkas berisi program (nama .pdf) diblokir dari ISI.
    expect(await reader.fetchAttachment({ ...seed, attachmentId: pdf?.id ?? '' })).toMatchObject({
      status: 'ready',
    });
    const [savedPdf] = await db
      .select()
      .from(mailAttachments)
      .where(eq(mailAttachments.id, pdf?.id ?? ''));
    expect(savedPdf?.detectedType).toBe('application/pdf');
    const file = await store.open(savedPdf?.storageKey ?? '');
    expect(file?.sizeBytes).toBe(Buffer.byteLength('%PDF-1.4 jadwal'));
    file?.stream.destroy();
    const fake = attachments.find((row) => row.filename === 'faktur.pdf');
    expect(await reader.fetchAttachment({ ...seed, attachmentId: fake?.id ?? '' })).toMatchObject({
      status: 'blocked',
    });
    const [blocked] = await db
      .select()
      .from(mailAttachments)
      .where(eq(mailAttachments.id, fake?.id ?? ''));
    expect(blocked).toMatchObject({ risk: 'blocked', storageKey: null });
    expect(published.map((event) => event.event.type)).toContain('mail.attachment.failed');
  });

  it('email hilang dari server → body_state error', async () => {
    const uid = imap.add('INBOX', plain('Hilang'));
    const seed = await seedAccount();
    const { sync, reader } = services();
    await sync.syncAccount(seed);
    const message = await messageBySubject(seed.accountId, 'Hilang');
    imap.remove('INBOX', uid);
    expect(await reader.fetchBody({ ...seed, messageId: message.id })).toMatchObject({
      status: 'failed',
      code: 'message_gone',
    });
    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, message.id));
    expect(after?.bodyState).toBe('error');
  });
});

describe('aksi dua arah tercermin ke server IMAP', () => {
  it('dibaca + bintang → UID STORE; arsip → CREATE Archive + pindah (COPYUID, baris dipindah di tempat); hapus permanen → UID EXPUNGE', async () => {
    imap.add('INBOX', plain('Satu'));
    imap.add('INBOX', plain('Dua'));
    imap.add('INBOX.Trash', plain('Buang'));
    const seed = await seedAccount();
    const { sync, actions } = services();
    await sync.syncAccount(seed);
    const one = await messageBySubject(seed.accountId, 'Satu');
    const two = await messageBySubject(seed.accountId, 'Dua');
    const trashMessage = await messageBySubject(seed.accountId, 'Buang');

    await pend(
      one.id,
      { isRead: true, isStarred: true, pendingAction: 'flags' },
      { isRead: false, isStarred: false },
    );
    const [archive] = await db
      .insert(mailFolders)
      .values({
        organizationId: seed.organizationId,
        accountId: seed.accountId,
        path: 'INBOX.Archive',
        delimiter: '.',
        name: 'Arsip',
        role: 'archive',
        roleSource: 'created',
      })
      .returning();
    await pend(
      two.id,
      { pendingAction: 'move', pendingTargetFolderId: archive?.id ?? null },
      { isRead: false, isStarred: false },
    );
    await pend(trashMessage.id, { pendingAction: 'delete' }, { isRead: false, isStarred: false });

    const result = await actions.run(seed, { finalAttempt: false });
    expect(result).toMatchObject({ status: 'applied', applied: 3, reverted: 0 });
    const inbox = imap.folders.get('INBOX')?.messages ?? [];
    expect(inbox.find((message) => message.uid === one.uid)?.flags).toEqual(
      expect.arrayContaining(['\\Seen', '\\Flagged']),
    );
    expect(inbox.some((message) => message.uid === two.uid)).toBe(false);
    expect(imap.folders.get('INBOX.Archive')?.messages).toHaveLength(1);
    expect(imap.folders.get('INBOX.Trash')?.messages).toHaveLength(0);
    expect(imap.commands.some((command) => command.startsWith('CREATE'))).toBe(true);
    expect(imap.commands).not.toContain('EXPUNGE');

    const [moved] = await db.select().from(mailMessages).where(eq(mailMessages.id, two.id));
    expect(moved).toMatchObject({
      folderId: archive?.id,
      folderRole: 'archive',
      uid: 1,
      pendingAction: null,
    });
    const [flagged] = await db.select().from(mailMessages).where(eq(mailMessages.id, one.id));
    expect(flagged).toMatchObject({
      isRead: true,
      isStarred: true,
      pendingAction: null,
      pendingRevert: null,
    });
    expect(
      await db.select().from(mailMessages).where(eq(mailMessages.id, trashMessage.id)),
    ).toEqual([]);
    expect(JSON.stringify(published)).not.toContain('Satu');
  });

  it('server menolak pada percobaan terakhir → dikembalikan (bendera lama) + mail.action.failed; sebelum itu dilempar (diulang)', async () => {
    imap.add('INBOX', plain('Tolak'));
    const seed = await seedAccount();
    const { sync, actions } = services();
    await sync.syncAccount(seed);
    const row = await messageBySubject(seed.accountId, 'Tolak');
    await pend(
      row.id,
      { isRead: true, pendingAction: 'flags' },
      { isRead: false, isStarred: false },
    );

    imap.failNext('UID STORE');
    await expect(actions.run(seed, { finalAttempt: false })).rejects.toThrow();
    imap.failNext('UID STORE');
    published.length = 0;
    const result = await actions.run(seed, { finalAttempt: true });
    expect(result).toMatchObject({ status: 'applied', reverted: 1 });
    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, row.id));
    expect(after).toMatchObject({ isRead: false, pendingAction: null });
    const failed = published.find((event) => event.event.type === 'mail.action.failed');
    expect(failed?.event).toMatchObject({ messageIds: [row.id], code: 'server_rejected' });
  });

  it('akun dijeda → aksi menunggu (tanpa sambungan); tick: > 24 jam dikembalikan (expired)', async () => {
    imap.add('INBOX', plain('Tunggu'));
    const seed = await seedAccount();
    const { sync, actions, reader } = services();
    await sync.syncAccount(seed);
    const row = await messageBySubject(seed.accountId, 'Tunggu');
    await db
      .update(mailAccounts)
      .set({ syncState: 'paused' })
      .where(eq(mailAccounts.id, seed.accountId));
    await pend(
      row.id,
      { isStarred: true, pendingAction: 'flags' },
      { isRead: false, isStarred: false },
    );
    const connections = imap.commands.length;
    expect(await actions.run(seed, { finalAttempt: false })).toEqual({ status: 'deferred' });
    expect(imap.commands.length).toBe(connections);

    await db
      .update(mailMessages)
      .set({ pendingActionAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(mailMessages.id, row.id));
    const queued: string[] = [];
    await runMailTick({
      db,
      logger,
      redis: undefined as never,
      sync,
      store: null,
      reader,
      actions,
      enqueueSync: () => Promise.resolve(),
      enqueuePurge: () => Promise.resolve(),
      enqueueAction: (payload) => Promise.resolve(void queued.push(payload.accountId)),
    });
    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, row.id));
    expect(after).toMatchObject({ isStarred: false, pendingAction: null });
  });
});

describe('review 9A-1 R3 — tick tidak menimpa jeda / password ditolak', () => {
  it('pemilik akun pribadi nonaktif lalu aktif lagi: akun `paused` & `auth_failed` tetap', async () => {
    const organization = await insertOrganization(db);
    const owner = await insertUser(db, organization.id, { role: 'cs' });
    const base = {
      organizationId: organization.id,
      kind: 'personal',
      ownerUserId: owner.id,
      provider: 'imap',
      displayName: 'Pribadi',
      fromName: 'X',
      color: 'tagBlue',
      imapHost: 'imap.contoh.test',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: 'x',
      imapPasswordEncrypted: 'v1.x.y',
      smtpHost: 'imap.contoh.test',
      smtpPort: 465,
      smtpSecurity: 'ssl',
    } as const;
    const [paused] = await db
      .insert(mailAccounts)
      .values({
        ...base,
        emailAddress: `a-${randomBytes(3).toString('hex')}@contoh.test`,
        syncState: 'paused',
      })
      .returning();
    const [failed] = await db
      .insert(mailAccounts)
      .values({
        ...base,
        emailAddress: `b-${randomBytes(3).toString('hex')}@contoh.test`,
        syncState: 'auth_failed',
      })
      .returning();
    const [ready] = await db
      .insert(mailAccounts)
      .values({
        ...base,
        emailAddress: `c-${randomBytes(3).toString('hex')}@contoh.test`,
        syncState: 'ready',
      })
      .returning();
    const tick = () =>
      runMailTick({
        db,
        logger,
        redis: undefined as never,
        sync: services().sync,
        store: null,
        enqueueSync: () => Promise.resolve(),
        enqueuePurge: () => Promise.resolve(),
      });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
    await tick();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, owner.id));
    await tick();
    const states = await db
      .select({ id: mailAccounts.id, state: mailAccounts.syncState })
      .from(mailAccounts)
      .where(eq(mailAccounts.ownerUserId, owner.id));
    const byId = new Map(states.map((row) => [row.id, row.state]));
    expect(byId.get(paused?.id ?? '')).toBe('paused');
    expect(byId.get(failed?.id ?? '')).toBe('auth_failed');
    expect(byId.get(ready?.id ?? '')).toBe('syncing');
  });
});
