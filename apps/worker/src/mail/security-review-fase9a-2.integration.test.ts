/**
 * Review keamanan 9A bagian 2 (docs/security-reviews/2026-11-23-fase9a-2.md) — worker isi/lampiran.
 * Server IMAP TIRUAN di loopback (TLS sertifikat tes) + Postgres sungguhan; tanpa sambungan keluar.
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
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
  mailIdentities,
  mailMessages,
  newId,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createMailReader } from './read';
import { createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-review-9a2';
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-review-9a2', level: 'silent' });

let db: Database;
let imap: FakeMailImapServer;
let mediaDir: string;
let store: MediaStore;
const published: MailBusEventInput[] = [];

function services() {
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
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
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
  });
  return { sync, reader };
}

/** Email dari domain MIRIP domain organisasi (c0ntoh.test vs contoh.test) + lampiran PDF. */
const lookalike = () =>
  [
    'From: "Direktur Contoh" <direktur@c0ntoh.test>',
    'To: cs@contoh.test',
    'Subject: Transfer mendesak',
    `Message-ID: <${randomBytes(4).toString('hex')}@c0ntoh.test>`,
    'Date: Tue, 17 Nov 2026 10:00:00 +0700',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BATAS"',
    '',
    '--BATAS',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Tolong transfer hari ini ke rekening baru.',
    '--BATAS',
    'Content-Type: application/pdf; name="rekening.pdf"',
    'Content-Disposition: attachment; filename="rekening.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 rekening').toString('base64'),
    '--BATAS--',
    '',
  ].join('\r\n');

function accountValues(
  organizationId: string,
  id: string,
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
) {
  return {
    id,
    organizationId,
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
      { id, organizationId },
      'imapPassword',
      PASSWORD,
    ),
    smtpHost: 'imap.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    nextAttemptAt: new Date(),
    ...overrides,
  } satisfies typeof mailAccounts.$inferInsert;
}

async function seedShared() {
  const organization = await insertOrganization(db);
  await insertUser(db, organization.id, { role: 'owner' });
  const id = newId();
  await db.insert(mailAccounts).values(accountValues(organization.id, id));
  await db.insert(mailIdentities).values({
    organizationId: organization.id,
    accountId: id,
    address: 'cs@contoh.test',
    displayName: 'Tim CS',
    isPrimary: true,
  });
  return { organizationId: organization.id, accountId: id };
}

async function syncedMessage(seed: { organizationId: string; accountId: string }) {
  const { sync, reader } = services();
  await sync.syncAccount(seed);
  const [message] = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, seed.accountId),
        eq(mailMessages.subject, 'Transfer mendesak'),
      ),
    );
  if (!message) throw new Error('pesan');
  return { message, reader };
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-9a2' });
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-review-9a2-'));
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

describe('S6 — domain organisasi untuk peringatan penyamaran', () => {
  it('kontrol: email dari c0ntoh.test ke akun bersama contoh.test → lookalike_sender', async () => {
    imap.add('INBOX', lookalike());
    const seed = await seedShared();
    const { message, reader } = await syncedMessage(seed);
    await reader.fetchBody({ ...seed, messageId: message.id });
    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, message.id));
    expect(after?.warnings).toContain('lookalike_sender');
  });

  // Satu CS dibobol menghubungkan akun PRIBADI berlabel alamat apa pun di domain mirip (alamat tidak
  // diikat ke kotak surat — sisa S4; identitasnya `verified_at = null`). `senderContext` memasukkan
  // semua alamat akun & identitas ke "domain organisasi" → domain penipu dianggap INTERNAL → peringatan
  // domain mirip/penyamaran hilang untuk SEMUA akun organisasi.
  it('akun pribadi CS ber-alamat di domain mirip TIDAK membuat domain itu "internal"', async () => {
    imap.add('INBOX', lookalike());
    const seed = await seedShared();
    const cs = await insertUser(db, seed.organizationId, { role: 'cs' });
    const personalId = newId();
    await db.insert(mailAccounts).values(
      accountValues(seed.organizationId, personalId, {
        kind: 'personal',
        ownerUserId: cs.id,
        displayName: 'Pribadi',
        emailAddress: 'apa.saja@c0ntoh.test',
        imapUsername: 'cs-sendiri',
        syncState: 'paused',
      }),
    );
    await db.insert(mailIdentities).values({
      organizationId: seed.organizationId,
      accountId: personalId,
      address: 'apa.saja@c0ntoh.test',
      displayName: 'Pribadi',
      isPrimary: true,
      verifiedAt: null,
    });
    const { message, reader } = await syncedMessage(seed);
    await reader.fetchBody({ ...seed, messageId: message.id });
    const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, message.id));
    expect(after?.warnings).toContain('lookalike_sender');
  });
});

describe('S7 — kuota cache isi & lampiran', () => {
  // Server IMAP milik CS: email berlampiran banyak × 50 MB; setiap unduhan disimpan ke media store
  // (disk yang sama dengan media WhatsApp) tanpa kuota per akun/organisasi, retensi bawaan 90 hari.
  it('akun yang cache lampirannya sudah 20 GB tidak menyimpan lampiran baru (kuota)', async () => {
    imap.add('INBOX', lookalike());
    const seed = await seedShared();
    const { message, reader } = await syncedMessage(seed);
    await reader.fetchBody({ ...seed, messageId: message.id });
    // Cache yang sudah ada (baris saja; berkas tidak perlu ada untuk menghitung kuota): 10 × 2 GB.
    await db.insert(mailAttachments).values(
      Array.from({ length: 10 }, (_, index) => ({
        organizationId: seed.organizationId,
        messageId: message.id,
        partId: `9.${String(index + 1)}`,
        filename: `arsip-${String(index)}.bin`,
        declaredType: 'application/octet-stream',
        detectedType: 'application/octet-stream',
        sizeBytes: 2_000_000_000,
        risk: 'ok',
        storageKey: `mail/palsu-${randomBytes(6).toString('hex')}`,
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      })),
    );
    const [pdf] = await db
      .select()
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.messageId, message.id),
          eq(mailAttachments.filename, 'rekening.pdf'),
        ),
      );
    if (!pdf) throw new Error('lampiran');
    const result = await reader.fetchAttachment({ ...seed, attachmentId: pdf.id });
    expect(result.status).toBe('failed');
    const [after] = await db.select().from(mailAttachments).where(eq(mailAttachments.id, pdf.id));
    expect(after?.storageKey).toBeNull();
  });
});
