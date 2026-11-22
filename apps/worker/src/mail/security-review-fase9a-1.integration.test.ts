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
  createLogger,
  createSecretBox,
  Secret,
  sealMailAccountSecret,
  type MailBodyStructureNode,
  type MailImapSession,
} from '@balesin/core';
import {
  closeDb,
  createDb,
  mailAccounts,
  mailIdentities,
  mailMessages,
  newId,
  type Database,
} from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createMailSync } from './sync';

const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-review-mail', level: 'silent' });

let db: Database;

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

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-mail' });
});

afterAll(async () => {
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
  it.fails(
    'satu job sinkron punya anggaran header (saran ≤ 2.000 per job; sisanya job berikutnya)',
    async () => {
      const seed = await seedAccount();
      const result = await syncWith(floodSession(2_500, null)).syncAccount(seed);
      expect(result.status).toBe('synced');
      expect(result.status === 'synced' ? result.created : 0).toBeLessThanOrEqual(2_000);
    },
    60_000,
  );

  it.fails(
    '`bodystructure` yang disimpan per email dibatasi (≤ 64 KB) walau server mengirim struktur MIME raksasa',
    async () => {
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
    },
    30_000,
  );
});

describe('S2 (Tinggi) — sinkron tanpa tenggat total terhadap server jahat', () => {
  it.fails(
    'syncAccount ke server yang tidak pernah menyelesaikan LIST selesai (gagal + backoff) dalam tenggat totalMs, sambungan ditutup',
    async () => {
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
    },
    10_000,
  );
});
