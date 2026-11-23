/**
 * Review keamanan tahap 9B (docs/security-reviews/2026-11-23-fase9b.md) — tes PENGUNCI temuan worker.
 * Setiap `it.fails` menegaskan perilaku AMAN yang BELUM dipenuhi kode saat ini; saat temuannya
 * diperbaiki, tes ini mulai lulus sehingga `it.fails` gagal → ubah menjadi `it` (asersi jangan diubah).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Secret,
  createLogger,
  createMediaStore,
  createSecretBox,
  mailIdentityVerificationContext,
  mailMessageIdHash,
  randomBase32,
  sealMailAccountSecret,
  type MediaStore,
  type Redis,
} from '@balesin/core';
import {
  connectTestRedis,
  startFakeMailImap,
  TEST_IMAP_CERT,
  type FakeMailImapServer,
} from '@balesin/core/testing';
import {
  closeDb,
  createDb,
  mailAccountAccess,
  mailAccounts,
  mailDraftAttachments,
  mailDrafts,
  mailFolders,
  mailIdentities,
  mailOutbox,
  newId,
  organizations,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { broadcastGuard } from '../queues/broadcast';
import { createMailCopies } from './copies';
import { createMailReader } from './read';
import { createMailSender } from './send';
import { createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-review-9b';
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-review-9b', level: 'silent' });
const publisher = { publish: () => Promise.resolve() };

let db: Database;
let redis: Redis;
let imap: FakeMailImapServer;
let mediaDir: string;
let store: MediaStore;
const prefix = `balesin-tes-review-9b-${randomBytes(4).toString('hex')}`;

const imapDeps = () => ({
  extraPorts: [imap.port],
  testCa: TEST_IMAP_CERT,
  allowLoopback: true,
  lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
  timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 10_000, totalMs: 30_000 },
});

async function seed(options: { kind?: 'shared' | 'personal'; verified?: boolean } = {}) {
  const organization = await insertOrganization(db);
  const user = await insertUser(db, organization.id, { role: 'cs' });
  const id = newId();
  await db.insert(mailAccounts).values({
    id,
    organizationId: organization.id,
    kind: options.kind ?? 'shared',
    ...(options.kind === 'personal' ? { ownerUserId: user.id } : {}),
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
    smtpHost: 'smtp.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    syncState: 'ready',
    sentCopyMode: 'append',
  });
  if (options.kind !== 'personal') {
    await db.insert(mailAccountAccess).values({
      organizationId: organization.id,
      accountId: id,
      principalType: 'user',
      userId: user.id,
      level: 'send',
    });
  }
  const verified = options.verified ?? true;
  const [identity] = await db
    .insert(mailIdentities)
    .values({
      organizationId: organization.id,
      accountId: id,
      address: 'cs@contoh.test',
      displayName: 'Tim CS',
      isPrimary: true,
      ...(verified
        ? { verificationState: 'verified', verifiedAt: new Date(), verifiedMethod: 'code' }
        : {}),
    })
    .returning();
  if (!identity) throw new Error('identitas');
  return { organizationId: organization.id, accountId: id, userId: user.id, identity };
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-9b' });
  redis = await connectTestRedis('client', logger, 'balesin-tes-review-9b');
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-review-9b-'));
  store = createMediaStore(mediaDir);
});

beforeEach(async () => {
  await imap?.close();
  imap = await startFakeMailImap({ password: PASSWORD });
});

afterAll(async () => {
  await imap?.close();
  await redis.quit();
  await closeDb(db);
  await rm(mediaDir, { recursive: true, force: true });
});

describe('S1 (Tinggi) — cadangan SEARCH mempercayai (dan membocorkan Message-ID ke) server IMAP akun', () => {
  it('server IMAP milik pendaftar yang menjawab SEARCH "ketemu" TIDAK memverifikasi alamat, dan Message-ID rahasia tidak dikirim ke server', async () => {
    // Akun PRIBADI CS di server IMAP miliknya sendiri; alias `direktur@` yang kotak suratnya ada di
    // tempat lain. Email verifikasi (lewat SMTP sistem) TIDAK pernah sampai ke server ini.
    const ctx = await seed({ kind: 'personal', verified: false });
    const messageId = `v.${randomBase32()}@sistem.test`;
    await db
      .update(mailIdentities)
      .set({
        address: 'direktur@contoh.test',
        isPrimary: false,
        verificationState: 'pending',
        verificationMessageIdHash: mailMessageIdHash(messageId),
        verificationSentAt: new Date(),
        verificationExpiresAt: new Date(Date.now() + 30 * 60_000),
        verificationSecretEncrypted: secretBox.encrypt(
          JSON.stringify({ messageId }),
          mailIdentityVerificationContext(ctx.organizationId, ctx.identity.id),
        ),
      })
      .where(eq(mailIdentities.id, ctx.identity.id));
    await db.insert(mailFolders).values({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      path: 'INBOX',
      name: 'Kotak masuk',
      role: 'inbox',
      roleSource: 'special_use',
    });
    const searched: string[] = [];
    // Server pendaftar: setiap SEARCH dijawab "ada" (dan isi kriteria SEARCH-nya tercatat).
    const lying = {
      select: () => Promise.resolve({ uidValidity: 1, uidNext: 2, exists: 1 }),
      searchMessageId: (id: string) => {
        searched.push(id);
        return Promise.resolve([1]);
      },
      append: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const copier = createMailCopies({
      db,
      logger,
      secretBox,
      publisher,
      store,
      openSession: () => Promise.resolve(lying as never),
    });
    await copier.verifyCheck({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      identityId: ctx.identity.id,
    });
    const [row] = await db
      .select({ state: mailIdentities.verificationState })
      .from(mailIdentities)
      .where(eq(mailIdentities.id, ctx.identity.id));
    expect(row?.state).toBe('pending');
    expect(searched).not.toContain(messageId);
  });
});

describe('S6 (Sedang) — salinan draf server di-APPEND ulang utuh (lampiran besar) setiap simpan', () => {
  it('5 simpan berturut-turut dengan lampiran 4 MB yang SAMA → total APPEND ≤ 2 × ukuran satu salinan', async () => {
    const ctx = await seed();
    const sync = createMailSync({ db, logger, secretBox, publisher, imap: imapDeps() });
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
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
    const appended: number[] = [];
    const copier = createMailCopies({
      db,
      logger,
      secretBox,
      publisher,
      store,
      openSession: async (account) => {
        const session = await reader.openSession(account);
        const original = (session as unknown as { append: (...args: unknown[]) => unknown }).append;
        (session as unknown as { append: unknown }).append = (
          path: string,
          raw: Buffer,
          flags: string[],
        ) => {
          appended.push(raw.length);
          return original.call(session, path, raw, flags);
        };
        return session;
      },
    });
    const [draft] = await db
      .insert(mailDrafts)
      .values({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        identityId: ctx.identity.id,
        ownerUserId: ctx.userId,
        mode: 'new',
        to: [{ address: 'rina@pelanggan.test', name: null }],
        subject: 'Penawaran',
        bodyHtml: '<p>Halo</p>',
        serverRef: randomBase32(),
        updatedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!draft) throw new Error('draf');
    const file = await store.save('email-out', randomBytes(4 * 1024 * 1024));
    await db.insert(mailDraftAttachments).values({
      organizationId: ctx.organizationId,
      draftId: draft.id,
      position: 0,
      filename: 'katalog.pdf',
      contentType: 'application/pdf',
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey: file.storageKey,
      source: 'upload',
      state: 'ready',
      createdByUserId: ctx.userId,
    });
    for (let version = 1; version <= 5; version += 1) {
      // Simpan otomatis (hanya badan yang berubah), lalu job salinan jatuh tempo.
      await db
        .update(mailDrafts)
        .set({
          version,
          bodyHtml: `<p>Halo ${String(version)}</p>`,
          serverSyncState: 'pending',
          updatedAt: new Date(Date.now() - 60_000),
          serverSyncedAt: version === 1 ? null : new Date(Date.now() - 3 * 60_000),
        })
        .where(eq(mailDrafts.id, draft.id));
      expect(
        (
          await copier.syncDraft({
            organizationId: ctx.organizationId,
            accountId: ctx.accountId,
            draftId: draft.id,
          })
        ).status,
      ).toBe('done');
    }
    const single = appended[0] ?? 0;
    expect(single).toBeGreaterThan(4 * 1024 * 1024);
    expect(appended.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(2 * single);
  }, 60_000);
});

describe('R1 (Rendah) — rem otomatis organisasi tidak menghitung email menu Email', () => {
  it('500 penerima email menu Email dalam 1 menit (> batas mutlak 400) → organisasi direm', async () => {
    const ctx = await seed();
    // Waktu tes jauh di depan supaya tidak menyentuh data berkas tes lain di database yang sama.
    const at = new Date(Date.UTC(2099, 0, 1, 12, 0, 0));
    await db.insert(mailOutbox).values(
      Array.from({ length: 10 }, () => ({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        identityId: ctx.identity.id,
        createdByUserId: ctx.userId,
        mode: 'new',
        fromAddress: 'cs@contoh.test',
        fromName: 'Tim CS',
        envelopeFrom: 'cs@contoh.test',
        to: Array.from({ length: 50 }, (_, i) => ({
          address: `p${String(i)}@pelanggan.test`,
          name: null,
        })),
        recipientCount: 50,
        subject: 'Promo',
        messageIdHeader: `${randomBytes(8).toString('hex')}@contoh.test`,
        status: 'sent',
        sendAfter: new Date(at.getTime() - 20_000),
        sendingStartedAt: new Date(at.getTime() - 15_000),
        sentAt: new Date(at.getTime() - 10_000),
        createdAt: new Date(at.getTime() - 20_000),
        sentCopyState: 'skipped',
      })),
    );
    await broadcastGuard({ db, logger, meta: {} as never, secretBox: null, now: () => at });
    const [org] = await db
      .select({ pausedAt: organizations.sendingPausedAt })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    expect(org?.pausedAt).not.toBeNull();
  });
});

describe('R4 (Rendah) — `sending` basi vs SMTP yang sedang berjalan', () => {
  it('sendOne memperbarui sending_started_at sesaat sebelum SMTP (pemulihan 15 menit tidak menggagalkan kiriman yang sedang berjalan)', async () => {
    const ctx = await seed();
    const [row] = await db
      .insert(mailOutbox)
      .values({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        identityId: ctx.identity.id,
        createdByUserId: ctx.userId,
        mode: 'new',
        fromAddress: 'cs@contoh.test',
        fromName: 'Tim CS',
        envelopeFrom: 'cs@contoh.test',
        to: [{ address: 'rina@pelanggan.test', name: null }],
        recipientCount: 1,
        subject: 'Halo',
        html: '<div dir="auto"><p>Halo</p></div>',
        text: 'Halo',
        messageIdHeader: `${randomBytes(8).toString('hex')}@contoh.test`,
        status: 'sending',
        // Diklaim tick 14 menit lalu; job tertunda (SMTP akun sibuk) baru jalan sekarang.
        sendAfter: new Date(Date.now() - 15 * 60_000),
        sendingStartedAt: new Date(Date.now() - 14 * 60_000),
        sentCopyState: 'skipped',
      })
      .returning();
    if (!row) throw new Error('outbox');
    let startedAtDuringSmtp: Date | null = null;
    const sender = createMailSender({
      db,
      logger,
      redis,
      prefix,
      secretBox,
      publisher,
      store,
      smtp: {},
      send: async () => {
        const [current] = await db
          .select({ startedAt: mailOutbox.sendingStartedAt })
          .from(mailOutbox)
          .where(eq(mailOutbox.id, row.id));
        startedAtDuringSmtp = current?.startedAt ?? null;
        return { ok: true, rejected: [] };
      },
    });
    await sender.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    expect(startedAtDuringSmtp).not.toBeNull();
    expect((startedAtDuringSmtp as Date | null)?.getTime() ?? 0).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});
