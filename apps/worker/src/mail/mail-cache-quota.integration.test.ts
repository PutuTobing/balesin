/**
 * Perbaikan review keamanan 9A bagian 2 S7 — lampiran DIALIRKAN ke disk (beberapa potongan FETCH,
 * dekode base64/quoted-printable beralir), dokumen Office diperiksa dari disk, kuota per email, isi lama
 * digusur saat kuota akun penuh. Server IMAP TIRUAN di loopback + Postgres sungguhan.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  mailMessageBodies,
  mailMessages,
  mailRemoteImageCache,
  newId,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { runMailCacheRetention, runMailPurge, type MailJobDeps } from '../queues/mail';
import { createMailReader } from './read';
import { createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-kuota-9a2';
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-kuota-9a2', level: 'silent' });

let db: Database;
let imap: FakeMailImapServer;
let mediaDir: string;
let store: MediaStore;
const published: MailBusEventInput[] = [];

function services(cacheLimits?: { account: number; organization: number; message: number }) {
  const publisher = {
    publish: (events: readonly MailBusEventInput[]) =>
      Promise.resolve(void published.push(...events)),
  };
  const sync = createMailSync({
    db,
    logger,
    secretBox,
    publisher,
    imap: {
      extraPorts: [imap.port],
      testCa: TEST_IMAP_CERT,
      allowLoopback: true,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 10_000, totalMs: 30_000 },
    },
  });
  const reader = createMailReader({
    db,
    logger,
    secretBox,
    publisher,
    store,
    appUrl: 'https://cs.contoh.test',
    policyFor: (organizationId) => sync.policyFor(organizationId),
    ...(cacheLimits ? { cacheLimits } : {}),
  });
  return { sync, reader };
}

/** ZIP minimal tanpa kompresi (cukup untuk pemeriksaan direktori pusat). */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const base64Lines = (bytes: Buffer) =>
  (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/** Email berlampiran: PDF besar (> 3 MB mentah → beberapa potongan), docx sah, docx bermakro, QP. */
function mailWith(parts: { name: string; type: string; bytes: Buffer; qp?: boolean }[]) {
  return [
    'From: "Mitra" <mitra@luar.test>',
    'To: cs@contoh.test',
    'Subject: Berkas',
    `Message-ID: <${randomBytes(4).toString('hex')}@luar.test>`,
    'Date: Tue, 17 Nov 2026 10:00:00 +0700',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BATAS"',
    '',
    '--BATAS',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Terlampir.',
    ...parts.flatMap((part) => [
      '--BATAS',
      `Content-Type: ${part.type}; name="${part.name}"`,
      `Content-Disposition: attachment; filename="${part.name}"`,
      `Content-Transfer-Encoding: ${part.qp ? 'quoted-printable' : 'base64'}`,
      '',
      part.qp ? part.bytes.toString('latin1') : base64Lines(part.bytes),
    ]),
    '--BATAS--',
    '',
  ].join('\r\n');
}

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
  return { organizationId: organization.id, accountId: id };
}

async function attachmentsOf(seed: { organizationId: string; accountId: string }) {
  const [message] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, seed.accountId), eq(mailMessages.subject, 'Berkas')));
  if (!message) throw new Error('pesan');
  return {
    message,
    rows: await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, message.id)),
  };
}

async function readStored(storageKey: string | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.chunks(storageKey ?? '')) chunks.push(chunk);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-kuota-9a2' });
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-kuota-9a2-'));
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

describe('S7 — lampiran dialirkan ke disk', () => {
  it('PDF 4 MB (beberapa potongan FETCH) utuh byte demi byte; QP; docx sah ok, docx bermakro diblokir', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(4 * 1024 * 1024)]);
    const docx = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
    const macro = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      'word/vbaProject.bin': 'makro',
    });
    const qpText = Buffer.from('%PDF-1.4 caf=C3=A9 =\r\nsambung');
    imap.add(
      'INBOX',
      mailWith([
        { name: 'besar.pdf', type: 'application/pdf', bytes: pdf },
        { name: 'surat.docx', type: 'application/octet-stream', bytes: docx },
        { name: 'makro.docx', type: 'application/octet-stream', bytes: macro },
        { name: 'qp.pdf', type: 'application/pdf', bytes: qpText, qp: true },
      ]),
    );
    const seed = await seedAccount();
    const { sync, reader } = services();
    await sync.syncAccount(seed);
    const { message } = await attachmentsOf(seed);
    await reader.fetchBody({ ...seed, messageId: message.id });
    const { rows } = await attachmentsOf(seed);
    const byName = (name: string) => rows.find((row) => row.filename === name);

    expect(
      await reader.fetchAttachment({ ...seed, attachmentId: byName('besar.pdf')?.id ?? '' }),
    ).toMatchObject({ status: 'ready' });
    expect(
      await reader.fetchAttachment({ ...seed, attachmentId: byName('surat.docx')?.id ?? '' }),
    ).toMatchObject({ status: 'ready' });
    expect(
      await reader.fetchAttachment({ ...seed, attachmentId: byName('makro.docx')?.id ?? '' }),
    ).toMatchObject({ status: 'blocked' });
    expect(
      await reader.fetchAttachment({ ...seed, attachmentId: byName('qp.pdf')?.id ?? '' }),
    ).toMatchObject({ status: 'ready' });

    const after = await attachmentsOf(seed);
    const saved = (name: string) => after.rows.find((row) => row.filename === name);
    expect(saved('besar.pdf')?.detectedType).toBe('application/pdf');
    expect((await readStored(saved('besar.pdf')?.storageKey ?? null)).equals(pdf)).toBe(true);
    expect(saved('surat.docx')).toMatchObject({
      risk: 'ok',
      detectedType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect((await readStored(saved('surat.docx')?.storageKey ?? null)).equals(docx)).toBe(true);
    expect(saved('makro.docx')).toMatchObject({ risk: 'blocked', storageKey: null });
    expect((await readStored(saved('qp.pdf')?.storageKey ?? null)).toString('utf8')).toBe(
      '%PDF-1.4 café sambung',
    );
  }, 60_000);

  it('kuota per email: lampiran yang membuat cache email lewat batas → cache_full, tidak disimpan', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(64 * 1024)]);
    imap.add('INBOX', mailWith([{ name: 'a.pdf', type: 'application/pdf', bytes: pdf }]));
    const seed = await seedAccount();
    const { sync, reader } = services({
      account: 10 * 1024 * 1024,
      organization: 10 * 1024 * 1024,
      message: 32 * 1024,
    });
    await sync.syncAccount(seed);
    const { message } = await attachmentsOf(seed);
    await reader.fetchBody({ ...seed, messageId: message.id });
    const { rows } = await attachmentsOf(seed);
    const result = await reader.fetchAttachment({ ...seed, attachmentId: rows[0]?.id ?? '' });
    expect(result).toMatchObject({ status: 'failed', code: 'cache_full' });
    expect(
      published.some(
        (item) =>
          item.event.type === 'mail.attachment.failed' &&
          'code' in item.event &&
          item.event.code === 'cache_full',
      ),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(mailAttachments)
      .where(eq(mailAttachments.id, rows[0]?.id ?? ''));
    expect(row?.storageKey).toBeNull();
  }, 30_000);

  it('cache akun penuh: isi yang paling lama tidak dibuka digusur (bisa diambil ulang), isi baru tetap tersimpan', async () => {
    imap.add('INBOX', mailWith([]));
    const seed = await seedAccount();
    const { sync, reader } = services({ account: 1_000, organization: 10 ** 9, message: 10 ** 9 });
    await sync.syncAccount(seed);
    const { message } = await attachmentsOf(seed);
    // Isi lama (besar) milik email lain di akun yang sama.
    const [old] = await db
      .insert(mailMessages)
      .values({
        organizationId: seed.organizationId,
        accountId: seed.accountId,
        folderId: message.folderId,
        folderRole: 'inbox',
        uid: 999_999,
        uidvalidity: message.uidvalidity,
        receivedAt: new Date(),
        bodyState: 'ready',
      })
      .returning();
    if (!old) throw new Error('lama');
    await db.insert(mailMessageBodies).values({
      messageId: old.id,
      organizationId: seed.organizationId,
      text: randomBytes(4_000).toString('hex'),
      lastOpenedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(await reader.fetchBody({ ...seed, messageId: message.id })).toMatchObject({
      status: 'ready',
    });
    const bodies = await db
      .select({ id: mailMessageBodies.messageId })
      .from(mailMessageBodies)
      .where(eq(mailMessageBodies.organizationId, seed.organizationId));
    expect(bodies.map((row) => row.id)).toEqual([message.id]);
    const [evicted] = await db.select().from(mailMessages).where(eq(mailMessages.id, old.id));
    expect(evicted?.bodyState).toBe('none');
  }, 30_000);
});

describe('S5 — cache proksi gambar: kedaluwarsa & putus akun', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const deps = () => ({ db, store, logger }) as unknown as MailJobDeps;
  async function cached(seed: { organizationId: string; accountId: string }, expiresAt: Date) {
    const saved = await store.save('mail', PNG);
    await db.insert(mailRemoteImageCache).values({
      organizationId: seed.organizationId,
      accountId: seed.accountId,
      urlHash: randomBytes(32).toString('hex'),
      storageKey: saved.storageKey,
      contentType: 'image/png',
      sizeBytes: saved.sizeBytes,
      expiresAt,
    });
    return saved.storageKey;
  }

  it('retensi menghapus baris + berkas yang kedaluwarsa; yang masih berlaku tetap', async () => {
    const seed = await seedAccount();
    const expired = await cached(seed, new Date(Date.now() - 1_000));
    const fresh = await cached(seed, new Date(Date.now() + 60_000));
    await runMailCacheRetention(deps());
    const rows = await db
      .select({ storageKey: mailRemoteImageCache.storageKey })
      .from(mailRemoteImageCache)
      .where(eq(mailRemoteImageCache.accountId, seed.accountId));
    expect(rows.map((row) => row.storageKey)).toEqual([fresh]);
    expect(await store.open(expired)).toBeNull();
    const kept = await store.open(fresh);
    expect(kept).not.toBeNull();
    kept?.stream.destroy();
  });

  it('putus akun menghapus cache gambar akun itu (baris + berkas)', async () => {
    const seed = await seedAccount();
    const key = await cached(seed, new Date(Date.now() + 60_000));
    await db
      .update(mailAccounts)
      .set({ deletedAt: new Date(), syncState: 'deleting' })
      .where(eq(mailAccounts.id, seed.accountId));
    expect(await runMailPurge(seed, deps())).toMatchObject({ status: 'purged' });
    expect(
      await db
        .select()
        .from(mailRemoteImageCache)
        .where(eq(mailRemoteImageCache.accountId, seed.accountId)),
    ).toHaveLength(0);
    expect(await store.open(key)).toBeNull();
  });
});
