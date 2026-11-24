/**
 * Tahap 9B — kirim menu Email di worker (docs/KONTRAK-API-EMAIL-TULIS.md §9, §13, §17 "Integrasi
 * worker"): kabel MIME/amplop (Bcc hanya amplop, salinan Terkirim ber-Bcc, Message-ID domain
 * identitas, utas, tanpa Auto-Submitted/X-Mailer, MAIL FROM = alamat akun), cek ulang hak & identitas
 * sebelum SMTP, klasifikasi hasil (4xx → coba ulang, login ditolak → blocked, putus setelah DATA →
 * tidak diulang), batas per jam, balapan batal vs klaim, salinan Terkirim (`auto`/`append`), salinan
 * draf server (APPEND + UID EXPUNGE / tanpa UIDPLUS tanpa EXPUNGE), verifikasi via kotak surat.
 * SMTP = pengganti `send` (merekam); IMAP = server tiruan.
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
  mailMessageIdHash,
  randomBase32,
  sealMailAccountSecret,
  type AccountMailEnvelope,
  type ApiMailResult,
  type MailBusEventInput,
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
  auditLogs,
  closeDb,
  createDb,
  emailSenderSettings,
  mailAccountAccess,
  mailAccounts,
  mailCorrespondents,
  mailDrafts,
  mailIdentities,
  mailOutbox,
  newId,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createMailCopies, markVerifiedByMailbox } from './copies';
import { createMailReader } from './read';
import { createMailSender, type MailSendDeps } from './send';
import { createMailSync } from './sync';

const PASSWORD = 'rahasia-imap-kirim-01';
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-mail-kirim', level: 'silent' });

let db: Database;
let redis: Redis;
let imap: FakeMailImapServer;
let mediaDir: string;
let store: MediaStore;
const prefix = `balesin-tes-kirim-${randomBytes(4).toString('hex')}`;
const published: MailBusEventInput[] = [];
const publisher = {
  publish: (events: readonly MailBusEventInput[]) =>
    Promise.resolve(void published.push(...events)),
};

interface Sent {
  envelope: AccountMailEnvelope;
  raw: string;
  host: string;
  strict: boolean;
}
let sent: Sent[] = [];
let nextResult: ApiMailResult = { ok: true, rejected: [] };

function sender(overrides: Partial<MailSendDeps> = {}) {
  return createMailSender({
    db,
    logger,
    redis,
    prefix,
    secretBox,
    publisher,
    store,
    smtp: {},
    send: (config, policy, envelope, raw) => {
      sent.push({
        envelope,
        raw: raw.toString('utf8'),
        host: config.host,
        strict: !!policy.strict,
      });
      return Promise.resolve(nextResult);
    },
    ...overrides,
  });
}

const imapDeps = () => ({
  extraPorts: [imap.port],
  testCa: TEST_IMAP_CERT,
  allowLoopback: true,
  lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
  timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
});

function copies() {
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
  return {
    sync,
    copies: createMailCopies({
      db,
      logger,
      secretBox,
      publisher,
      store,
      openSession: (account) => reader.openSession(account),
    }),
  };
}

async function seed(
  options: { sentCopyMode?: 'auto' | 'append' | 'none'; verified?: boolean } = {},
) {
  const organization = await insertOrganization(db);
  const user = await insertUser(db, organization.id, { role: 'cs' });
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
    smtpHost: 'smtp.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    syncState: 'ready',
    sentCopyMode: options.sentCopyMode ?? 'append',
  });
  await db.insert(mailAccountAccess).values({
    organizationId: organization.id,
    accountId: id,
    principalType: 'user',
    userId: user.id,
    level: 'send',
  });
  const verified = options.verified ?? true;
  const [identity] = await db
    .insert(mailIdentities)
    .values({
      organizationId: organization.id,
      accountId: id,
      address: 'tagihan@contoh.test',
      displayName: 'Tim Tagihan',
      isPrimary: false,
      ...(verified
        ? { verificationState: 'verified', verifiedAt: new Date(), verifiedMethod: 'code' }
        : {}),
    })
    .returning();
  await db.insert(mailIdentities).values({
    organizationId: organization.id,
    accountId: id,
    address: 'cs@contoh.test',
    displayName: 'Tim CS',
    isPrimary: true,
  });
  if (!identity) throw new Error('identitas');
  return { organizationId: organization.id, accountId: id, userId: user.id, identity };
}

async function queueOutbox(
  ctx: Awaited<ReturnType<typeof seed>>,
  overrides: Partial<typeof mailOutbox.$inferInsert> = {},
) {
  const [draft] = await db
    .insert(mailDrafts)
    .values({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      identityId: ctx.identity.id,
      ownerUserId: ctx.userId,
      mode: 'reply',
      subject: 'Re: Tagihan',
      state: 'sending',
      serverRef: randomBase32(),
    })
    .returning();
  if (!draft) throw new Error('draf');
  const [row] = await db
    .insert(mailOutbox)
    .values({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      identityId: ctx.identity.id,
      draftId: draft.id,
      createdByUserId: ctx.userId,
      mode: 'reply',
      fromAddress: 'tagihan@contoh.test',
      fromName: 'Tim Tagihan',
      envelopeFrom: 'cs@contoh.test',
      to: [{ address: 'rina@pelanggan.test', name: 'Rina Wulandari' }],
      cc: [{ address: 'budi@pelanggan.test', name: null }],
      bcc: [{ address: 'arsip@contoh.test', name: null }],
      recipientCount: 3,
      subject: 'Re: Tagihan',
      html: '<div dir="auto"><p>Halo Bu Rina</p></div>',
      text: 'Halo Bu Rina',
      messageIdHeader: `${randomBytes(8).toString('hex')}@contoh.test`,
      inReplyTo: 'asli@pelanggan.test',
      references: ['akar@pelanggan.test', 'asli@pelanggan.test'],
      status: 'pending',
      sendAfter: new Date(Date.now() - 1_000),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('outbox');
  return { draft, row };
}

const outboxRow = async (id: string) =>
  (await db.select().from(mailOutbox).where(eq(mailOutbox.id, id)))[0];

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-mail-kirim' });
  redis = await connectTestRedis('client', logger, 'balesin-tes-mail-kirim');
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-mail-kirim-'));
  store = createMediaStore(mediaDir);
});

beforeEach(async () => {
  await imap?.close();
  imap = await startFakeMailImap({ password: PASSWORD });
  published.length = 0;
  sent = [];
  nextResult = { ok: true, rejected: [] };
  // Tick memproses SEMUA organisasi: baris tes sebelumnya dibereskan supaya tidak ikut diklaim.
  await db.execute(
    sql`update mail_outbox set status = 'canceled' where status in ('pending', 'queued', 'sending')`,
  );
});

afterAll(async () => {
  await imap?.close();
  await redis.quit();
  await closeDb(db);
  await rm(mediaDir, { recursive: true, force: true });
});

describe('kabel SMTP & MIME', () => {
  it('Bcc hanya di amplop, salinan Terkirim ber-Bcc, Message-ID domain identitas, utas, tanpa Auto-Submitted/X-Mailer, MAIL FROM = alamat akun', async () => {
    const ctx = await seed();
    const { row, draft } = await queueOutbox(ctx);
    const worker = sender();
    const tick = await worker.tick();
    expect(tick.claimed).toBe(1);
    expect((await outboxRow(row.id))?.status).toBe('sending');
    const result = await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    expect(result.status).toBe('sent');
    expect(sent).toHaveLength(1);
    const wire = sent[0];
    if (!wire) throw new Error('tidak terkirim');
    const header = wire.raw.slice(0, wire.raw.indexOf('\r\n\r\n'));
    expect(wire.strict).toBe(true);
    expect(wire.envelope.from).toBe('cs@contoh.test');
    expect([...wire.envelope.to].sort()).toEqual(
      ['arsip@contoh.test', 'budi@pelanggan.test', 'rina@pelanggan.test'].sort(),
    );
    expect(header).not.toMatch(/^bcc:/im);
    expect(header).not.toContain('arsip@contoh.test');
    expect(header).toMatch(/^From: "?Tim Tagihan"? <tagihan@contoh\.test>/m);
    expect(header).toContain(`Message-ID: <${row.messageIdHeader}>`);
    expect(row.messageIdHeader.endsWith('@contoh.test')).toBe(true);
    expect(header).toContain('In-Reply-To: <asli@pelanggan.test>');
    expect(header).toMatch(/References: <akar@pelanggan\.test> <asli@pelanggan\.test>/);
    expect(header).not.toMatch(/auto-submitted|x-mailer|user-agent|disposition-notification/i);

    const after = await outboxRow(row.id);
    expect(after?.status).toBe('sent');
    expect(after?.rawStorageKey).not.toBeNull();
    const copy = after?.rawStorageKey
      ? await store.readRange(after.rawStorageKey, 0, 64 * 1024)
      : null;
    expect(copy?.toString('utf8')).toMatch(/^Bcc: arsip@contoh\.test/m);
    // Draf dihapus setelah terkirim; korespondensi & audit tercatat (tanpa alamat/subjek).
    expect(await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id))).toHaveLength(0);
    const known = await db
      .select({ address: mailCorrespondents.address })
      .from(mailCorrespondents)
      .where(eq(mailCorrespondents.accountId, ctx.accountId));
    expect(known.map((item) => item.address).sort()).toEqual(
      ['arsip@contoh.test', 'budi@pelanggan.test', 'rina@pelanggan.test'].sort(),
    );
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ctx.organizationId),
          eq(auditLogs.action, 'mail.message.sent'),
        ),
      );
    expect(audit?.metadata).toMatchObject({ outboxId: row.id, recipientCount: 3, hasBcc: true });
    expect(JSON.stringify(audit?.metadata)).not.toMatch(/rina|Tagihan/);
  });

  it('subjek ber-CRLF tidak pernah jadi header sisipan (gagal message_rejected)', async () => {
    const ctx = await seed();
    const { row } = await queueOutbox(ctx, { subject: 'Halo\r\nBcc: korban@luar.test' });
    const worker = sender();
    await worker.tick();
    const result = await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    expect(result.status).toBe('failed');
    expect(sent).toHaveLength(0);
    expect((await outboxRow(row.id))?.failureReason).toBe('message_rejected');
  });
});

describe('cek ulang sebelum SMTP', () => {
  it('identitas direset di antara kirim & klaim → failed identity_unverified + draf kembali dengan last_send_error', async () => {
    const ctx = await seed();
    const { row, draft } = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    await db
      .update(mailIdentities)
      .set({ verificationState: 'unverified', verifiedAt: null })
      .where(eq(mailIdentities.id, ctx.identity.id));
    const result = await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    expect(result).toMatchObject({ status: 'failed', reason: 'identity_unverified' });
    expect(sent).toHaveLength(0);
    const [back] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id));
    expect(back?.state).toBe('editing');
    expect(back?.lastSendError?.reason).toBe('identity_unverified');
  });

  it('hak kirim dicabut → not_allowed; akun diputus → account_unavailable', async () => {
    const ctx = await seed();
    const first = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    await db
      .update(mailAccountAccess)
      .set({ level: 'read' })
      .where(eq(mailAccountAccess.accountId, ctx.accountId));
    expect(
      await worker.sendOne({ organizationId: ctx.organizationId, outboxId: first.row.id }),
    ).toMatchObject({
      reason: 'not_allowed',
    });
    const other = await seed();
    const second = await queueOutbox(other);
    await worker.tick();
    await db
      .update(mailAccounts)
      .set({ syncState: 'owner_inactive' })
      .where(eq(mailAccounts.id, other.accountId));
    expect(
      await worker.sendOne({ organizationId: other.organizationId, outboxId: second.row.id }),
    ).toMatchObject({ reason: 'account_unavailable' });
    expect(sent).toHaveLength(0);
  });
});

describe('hasil SMTP', () => {
  it('4xx → queued + jadwal coba ulang; 4.7.x → pengirim throttled', async () => {
    const ctx = await seed();
    const { row } = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    nextResult = { ok: false, kind: 'throttled', smtpCode: 451, code: 'x' };
    await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    const after = await outboxRow(row.id);
    expect(after?.status).toBe('queued');
    expect(after?.holdReason).toBe('throttled');
    expect(after?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 30_000);
    const [settings] = await db
      .select()
      .from(emailSenderSettings)
      .where(eq(emailSenderSettings.mailAccountId, ctx.accountId));
    expect(settings?.state).toBe('throttled');
  });

  it('login SMTP ditolak → pengirim akun blocked, email ditahan (bukan gagal)', async () => {
    const ctx = await seed();
    const { row } = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    nextResult = { ok: false, kind: 'auth', smtpCode: 535, code: 'auth_failed' };
    expect(
      (await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id })).status,
    ).toBe('held');
    const after = await outboxRow(row.id);
    expect(after).toMatchObject({ status: 'queued', holdReason: 'blocked' });
    const [settings] = await db
      .select()
      .from(emailSenderSettings)
      .where(eq(emailSenderSettings.mailAccountId, ctx.accountId));
    expect(settings).toMatchObject({
      state: 'blocked',
      blockedReason: 'smtp_auth_failed',
      senderKind: 'account',
    });
    // Tick berikutnya menahan (blocked) tanpa menyambung.
    await db
      .update(mailOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(mailOutbox.id, row.id));
    await worker.tick();
    expect((await outboxRow(row.id))?.holdReason).toBe('blocked');
  });

  it('putus setelah DATA → delivery_unknown, tidak dicoba ulang', async () => {
    const ctx = await seed();
    const { row } = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    nextResult = { ok: false, kind: 'delivery_unknown', smtpCode: null, code: 'x' };
    await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    const after = await outboxRow(row.id);
    // Review 9B R4: status final tersendiri (bukan `failed`) + audit, tidak diulang.
    expect(after).toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'delivery_unknown',
      nextAttemptAt: null,
    });
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, ctx.organizationId));
    expect(audits.map((audit) => audit.action)).toContain('mail.message.delivery_unknown');
  });

  it('batas per jam akun (per penerima) menahan email berikutnya', async () => {
    const ctx = await seed();
    await db.insert(emailSenderSettings).values({
      organizationId: ctx.organizationId,
      senderKind: 'account',
      mailAccountId: ctx.accountId,
      hourlyLimit: 4,
    });
    const first = await queueOutbox(ctx);
    const second = await queueOutbox(ctx);
    const worker = sender();
    const tick = await worker.tick();
    expect(tick.claimed).toBe(1);
    const rows = await Promise.all([outboxRow(first.row.id), outboxRow(second.row.id)]);
    expect(rows.map((item) => item?.status).sort()).toEqual(['queued', 'sending']);
    expect(rows.find((item) => item?.status === 'queued')?.holdReason).toBe('hourly_limit');
  });
});

describe('batalkan kirim vs klaim worker', () => {
  it('pembatalan bersyarat dan klaim SKIP LOCKED bersamaan → tepat satu menang', async () => {
    for (let round = 0; round < 5; round += 1) {
      const ctx = await seed();
      const { row } = await queueOutbox(ctx);
      const worker = sender();
      const [canceled] = await Promise.all([
        db
          .update(mailOutbox)
          .set({ status: 'canceled', canceledAt: new Date() })
          .where(and(eq(mailOutbox.id, row.id), sql`${mailOutbox.status} in ('pending', 'queued')`))
          .returning({ id: mailOutbox.id }),
        worker.tick(),
      ]);
      const after = await outboxRow(row.id);
      if (canceled.length > 0) expect(after?.status).toBe('canceled');
      else expect(after?.status).toBe('sending');
      expect(['canceled', 'sending']).toContain(after?.status);
    }
  });

  it('belum lewat masa batal → tidak diklaim', async () => {
    const ctx = await seed();
    const { row } = await queueOutbox(ctx, { sendAfter: new Date(Date.now() + 60_000) });
    await sender().tick();
    expect((await outboxRow(row.id))?.status).toBe('pending');
  });
});

describe('salinan Terkirim', () => {
  it('append → APPEND ber-\\Seen ke folder Terkirim; auto + sudah ada di server → server_saved', async () => {
    const ctx = await seed({ sentCopyMode: 'append' });
    const { sync, copies: copier } = copies();
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const { row } = await queueOutbox(ctx);
    const worker = sender();
    await worker.tick();
    await worker.sendOne({ organizationId: ctx.organizationId, outboxId: row.id });
    expect(
      (await copier.appendSent({ organizationId: ctx.organizationId, outboxId: row.id })).status,
    ).toBe('done');
    const sentFolder = imap.folders.get('INBOX.Sent');
    expect(sentFolder?.messages).toHaveLength(1);
    expect(sentFolder?.messages[0]?.flags).toContain('\\Seen');
    expect(sentFolder?.messages[0]?.raw.toString('utf8')).toMatch(/^Bcc: arsip@contoh\.test/m);
    expect(await outboxRow(row.id)).toMatchObject({ sentCopyState: 'done', rawStorageKey: null });

    const auto = await seed({ sentCopyMode: 'auto' });
    await sync.syncAccount({
      organizationId: auto.organizationId,
      accountId: auto.accountId,
      force: true,
    });
    const second = await queueOutbox(auto);
    await worker.tick();
    await worker.sendOne({ organizationId: auto.organizationId, outboxId: second.row.id });
    // Penyedia (Gmail/M365) sudah menyimpan sendiri.
    imap.add('INBOX.Sent', `Message-ID: <${second.row.messageIdHeader}>\r\nSubject: x\r\n\r\nisi`);
    const before = imap.folders.get('INBOX.Sent')?.messages.length;
    expect(
      (await copier.appendSent({ organizationId: auto.organizationId, outboxId: second.row.id }))
        .status,
    ).toBe('server_saved');
    expect(imap.folders.get('INBOX.Sent')?.messages.length).toBe(before);
  });
});

describe('salinan draf di folder Draf server', () => {
  async function editingDraft(ctx: Awaited<ReturnType<typeof seed>>) {
    const [draft] = await db
      .insert(mailDrafts)
      .values({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        identityId: ctx.identity.id,
        ownerUserId: ctx.userId,
        mode: 'new',
        to: [{ address: 'rina@pelanggan.test', name: null }],
        bcc: [{ address: 'arsip@contoh.test', name: null }],
        subject: 'Penawaran',
        bodyHtml: '<p>Halo</p>',
        serverRef: randomBase32(),
        updatedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!draft) throw new Error('draf');
    return draft;
  }

  it('APPEND (\\Draft \\Seen, ber-Bcc) lalu ganti salinan lama dengan UID EXPUNGE; diam < 30 dtk → ditunda', async () => {
    const ctx = await seed();
    const { sync, copies: copier } = copies();
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const draft = await editingDraft(ctx);
    expect(
      (
        await copier.syncDraft({
          organizationId: ctx.organizationId,
          accountId: ctx.accountId,
          draftId: draft.id,
        })
      ).status,
    ).toBe('done');
    const folder = imap.folders.get('INBOX.Drafts');
    expect(folder?.messages).toHaveLength(1);
    expect(folder?.messages[0]?.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    expect(folder?.messages[0]?.raw.toString('utf8')).toMatch(/^Bcc: arsip@contoh\.test/m);
    const [synced] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id));
    expect(synced).toMatchObject({ serverSyncState: 'synced', serverSyncedVersion: 1 });
    expect(synced?.serverMessageId).toBe(`d.${draft.serverRef}.1@contoh.test`);

    // Simpan lagi (versi 2): baru saja diubah → ditunda; setelah diam & 2 menit → ganti salinan.
    await db
      .update(mailDrafts)
      .set({
        version: 2,
        bodyHtml: '<p>Halo lagi</p>',
        serverSyncState: 'pending',
        updatedAt: new Date(),
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
    ).toBe('delay');
    await db
      .update(mailDrafts)
      .set({
        updatedAt: new Date(Date.now() - 60_000),
        serverSyncedAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(mailDrafts.id, draft.id));
    const commandsBefore = imap.commands.length;
    expect(
      (
        await copier.syncDraft({
          organizationId: ctx.organizationId,
          accountId: ctx.accountId,
          draftId: draft.id,
        })
      ).status,
    ).toBe('done');
    const issued = imap.commands.slice(commandsBefore);
    expect(issued.some((command) => /^UID EXPUNGE/i.test(command))).toBe(true);
    expect(issued.some((command) => /^EXPUNGE/i.test(command))).toBe(false);
    expect(imap.folders.get('INBOX.Drafts')?.messages).toHaveLength(1);
  });

  it('review 9B S6: isi tidak berubah → tidak di-APPEND ulang (tetap `synced`)', async () => {
    const ctx = await seed();
    const { sync, copies: copier } = copies();
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const draft = await editingDraft(ctx);
    const run = () =>
      copier.syncDraft({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        draftId: draft.id,
      });
    expect((await run()).status).toBe('done');
    await db
      .update(mailDrafts)
      .set({
        version: 2,
        serverSyncState: 'pending',
        updatedAt: new Date(Date.now() - 60_000),
        serverSyncedAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(mailDrafts.id, draft.id));
    const commandsBefore = imap.commands.length;
    expect((await run()).status).toBe('done');
    expect(imap.commands.slice(commandsBefore)).toEqual([]);
    const [row] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id));
    expect(row).toMatchObject({ serverSyncState: 'synced', serverSyncedVersion: 2 });
  });

  it('tanpa UIDPLUS: salinan lama hanya ditandai \\Deleted, TIDAK PERNAH EXPUNGE biasa', async () => {
    await imap.close();
    imap = await startFakeMailImap({ password: PASSWORD, uidplus: false });
    const ctx = await seed();
    const { sync, copies: copier } = copies();
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const draft = await editingDraft(ctx);
    await copier.syncDraft({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      draftId: draft.id,
    });
    await db
      .update(mailDrafts)
      .set({
        version: 2,
        bodyHtml: '<p>Halo lagi</p>',
        serverSyncState: 'pending',
        updatedAt: new Date(Date.now() - 60_000),
        serverSyncedAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(mailDrafts.id, draft.id));
    const commandsBefore = imap.commands.length;
    await copier.syncDraft({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      draftId: draft.id,
    });
    const issued = imap.commands.slice(commandsBefore);
    expect(issued.some((command) => /^(UID )?EXPUNGE/i.test(command))).toBe(false);
    const flagged = imap.folders
      .get('INBOX.Drafts')
      ?.messages.filter((item) => item.flags.includes('\\Deleted'));
    expect(flagged).toHaveLength(1);
  });
});

describe('verifikasi alamat lewat kotak surat', () => {
  async function pending(ctx: Awaited<ReturnType<typeof seed>>, messageId: string) {
    await db
      .update(mailIdentities)
      .set({
        verificationState: 'pending',
        verifiedAt: null,
        verifiedMethod: null,
        verificationMessageIdHash: mailMessageIdHash(messageId),
        verificationExpiresAt: new Date(Date.now() + 30 * 60_000),
      })
      .where(eq(mailIdentities.id, ctx.identity.id));
  }

  it('Message-ID verifikasi masuk Kotak masuk → verified (mailbox); salinan di Terkirim/Draf TIDAK memverifikasi', async () => {
    const ctx = await seed({ verified: false });
    const messageId = `v.${randomBytes(8).toString('hex')}@sistem.test`;
    await pending(ctx, messageId);
    imap.add(
      'INBOX.Sent',
      `Message-ID: <${messageId}>\r\nFrom: noreply@sistem.test\r\nSubject: Kode\r\n\r\nisi`,
    );
    imap.add(
      'INBOX.Drafts',
      `Message-ID: <${messageId}>\r\nFrom: noreply@sistem.test\r\nSubject: Kode\r\n\r\nisi`,
    );
    const sync = createMailSync({
      db,
      logger,
      secretBox,
      publisher,
      imap: imapDeps(),
      verifyByMailbox: (organizationId, identityId, at) =>
        markVerifiedByMailbox(db, organizationId, identityId, at),
    });
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const [still] = await db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, ctx.identity.id));
    expect(still?.verificationState).toBe('pending');

    imap.add(
      'INBOX',
      `Message-ID: <${messageId}>\r\nFrom: noreply@sistem.test\r\nSubject: Kode\r\n\r\nisi`,
    );
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const [done] = await db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, ctx.identity.id));
    expect(done).toMatchObject({ verificationState: 'verified', verifiedMethod: 'mailbox' });
    expect(done?.verificationMessageIdHash).toBeNull();
    expect(published.some((event) => event.event.type === 'mail.identity.updated')).toBe(true);
  });

  it('cadangan LOKAL (review 9B S1): Message-ID di Spam baru terbukti setelah tersinkron, tanpa SEARCH ke server', async () => {
    const ctx = await seed({ verified: false });
    const messageId = `v.${randomBytes(8).toString('hex')}@sistem.test`;
    await pending(ctx, messageId);
    await db
      .update(mailIdentities)
      .set({ verificationSentAt: new Date(), verificationSecretEncrypted: null })
      .where(eq(mailIdentities.id, ctx.identity.id));
    // Sinkron TANPA `verifyByMailbox` → cadangan `verifyCheck` yang membuktikan (dari database).
    const { sync, copies: copier } = copies();
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    const check = () =>
      copier.verifyCheck({
        organizationId: ctx.organizationId,
        accountId: ctx.accountId,
        identityId: ctx.identity.id,
      });
    expect((await check()).status).toBe('delay');
    imap.add(
      'INBOX.Junk',
      `Message-ID: <${messageId}>

From: noreply@sistem.test

Subject: Kode



isi`,
    );
    // Email sudah di server tetapi BELUM tersinkron: server tidak ditanya → belum terbukti.
    expect((await check()).status).toBe('delay');
    await sync.syncAccount({
      organizationId: ctx.organizationId,
      accountId: ctx.accountId,
      force: true,
    });
    expect((await check()).status).toBe('verified');
    const [done] = await db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, ctx.identity.id));
    expect(done?.verifiedMethod).toBe('mailbox');
  });
});
