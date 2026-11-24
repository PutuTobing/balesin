/**
 * Modul Email 9A bagian 2 — daftar, baca (dokumen tampilan ber-token, proksi gambar, cid, sumber,
 * lampiran), aksi dua arah (docs/KONTRAK-API-EMAIL.md §7–§9, penyimpangan §16). Postgres + Redis
 * sungguhan; data email diisi langsung ke database (pengambilan dari IMAP diuji di worker).
 *
 * Fokus keamanan: akun pribadi orang lain = 404 di SEMUA rute baru (termasuk Owner), hak per level
 * (Baca: dibaca/bintang; Baca & kirim: pindah/arsip/sampah; Kelola: hapus permanen), CSP dokumen
 * tampilan + tanpa X-Frame-Options, token terikat sesi & hak, proksi gambar tanpa alamat privat & hanya
 * raster, lampiran berbahaya 403 / arsip butuh konfirmasi / `attachment` + `nosniff`.
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMediaStore,
  type MailAccountJobPayload,
  type MailAttachmentJobPayload,
  type MailMessageJobPayload,
  type RemoteFileRequest,
  type RemoteFileResult,
} from '@balesin/core';
import {
  auditLogs,
  mailAccountAccess,
  mailAccounts,
  mailAttachments,
  mailFolders,
  mailMessageBodies,
  mailMessages,
  newId,
  type NewMailMessageRow,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  mailActionResponseSchema,
  mailMessageDetailResponseSchema,
  mailMessageListResponseSchema,
  mailMessageViewResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-baca-email-01';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const store = createMediaStore(join(tmpdir(), `balesin-tes-media-${String(process.pid)}`));

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
const queued = {
  body: [] as MailMessageJobPayload[],
  attachment: [] as MailAttachmentJobPayload[],
  action: [] as Omit<MailAccountJobPayload, 'force'>[],
};
const fetches: RemoteFileRequest[] = [];
let remote: RemoteFileResult = { ok: false, error: 'dns', httpStatus: null };

async function signIn(role: UserRole) {
  const hasher = createPasswordHasher();
  const user = await insertUser(harness.db, organizationId, {
    role,
    name: `Pengguna ${role} ${randomBytes(2).toString('hex')}`,
    email: `${role}-${randomBytes(4).toString('hex')}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { user, signed: await login(harness.app, { email: user.email, password: PASSWORD }) };
}

async function insertAccount(overrides: Partial<typeof mailAccounts.$inferInsert> = {}) {
  const [row] = await harness.db
    .insert(mailAccounts)
    .values({
      organizationId,
      kind: 'shared',
      provider: 'cpanel',
      displayName: 'CS',
      emailAddress: `cs-${randomBytes(3).toString('hex')}@majujaya.test`,
      fromName: 'Tim CS',
      color: 'tagBlue',
      imapHost: 'mail.majujaya.test',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: 'cs',
      imapPasswordEncrypted: 'v1.x.y',
      smtpHost: 'mail.majujaya.test',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      syncState: 'ready',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('akun');
  const folder = async (path: string, role: string | null, name: string) => {
    const [created] = await harness.db
      .insert(mailFolders)
      .values({
        organizationId,
        accountId: row.id,
        path,
        name,
        delimiter: '.',
        role,
        roleSource: role ? 'special_use' : null,
        unreadCount: 5,
        totalCount: 10,
      })
      .returning();
    if (!created) throw new Error('folder');
    return created;
  };
  return {
    account: row,
    inbox: await folder('INBOX', 'inbox', 'Kotak masuk'),
    trash: await folder('INBOX.Trash', 'trash', 'Sampah'),
    junk: await folder('INBOX.Junk', 'junk', 'Spam'),
  };
}

let uidCounter = 1;
async function insertMessage(
  account: { id: string },
  folder: { id: string; role: string | null },
  overrides: Partial<NewMailMessageRow> = {},
) {
  const [row] = await harness.db
    .insert(mailMessages)
    .values({
      organizationId,
      accountId: account.id,
      folderId: folder.id,
      folderRole: folder.role,
      uid: uidCounter++,
      uidvalidity: 1,
      fromAddress: 'noc@mitra.test',
      fromName: 'NOC Mitra',
      to: [{ address: 'cs@majujaya.test', name: null }],
      subject: 'Pemeliharaan',
      snippet: 'Cuplikan',
      receivedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('pesan');
  return row;
}

async function insertBody(
  messageId: string,
  overrides: Partial<typeof mailMessageBodies.$inferInsert> = {},
) {
  await harness.db.insert(mailMessageBodies).values({
    messageId,
    organizationId,
    text: 'Halo teks',
    htmlSanitized:
      '<p>Halo <img src="balesin-remote:0" alt="Logo"> <img src="balesin-cid:logo@mitra.test"></p>',
    remoteImages: ['https://cdn.mitra.test/logo.png'],
    rawHeaders: 'From: noc@mitra.test\r\nSubject: Pemeliharaan',
    ...overrides,
  });
  await harness.db
    .update(mailMessages)
    .set({ bodyState: 'ready' })
    .where(eq(mailMessages.id, messageId));
}

async function grant(accountId: string, userId: string, level: 'read' | 'send' | 'manage') {
  await harness.db.insert(mailAccountAccess).values({
    organizationId,
    accountId,
    principalType: 'user',
    userId,
    level,
  });
}

const get = (url: string, signed?: SignedIn) => call(harness.app, 'GET', url, undefined, signed);
const list = async (signed: SignedIn, query: string) => {
  const response = await get(`${API_ROUTES.mail.messages}?${query}`, signed);
  expect(response.statusCode, response.body).toBe(200);
  return mailMessageListResponseSchema.parse(response.json());
};
const act = (signed: SignedIn, body: Record<string, unknown>) =>
  call(harness.app, 'POST', API_ROUTES.mail.messageActions, body, signed);
const view = async (signed: SignedIn, messageId: string, images: 'auto' | 'show' = 'auto') => {
  const response = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.mail.messageView, { messageId }),
    { images },
    signed,
  );
  expect(response.statusCode, response.body).toBe(200);
  return mailMessageViewResponseSchema.parse(response.json());
};

beforeAll(async () => {
  harness = await createIntegrationHarness({
    mailQueue: {
      sync: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      fetchBody: (payload) => Promise.resolve(void queued.body.push(payload)),
      fetchAttachment: (payload) => Promise.resolve(void queued.attachment.push(payload)),
      action: (payload) => Promise.resolve(void queued.action.push(payload)),
    },
    overrides: {
      mail: {
        // Tes ini menguji perilaku SATU unduhan per permintaan (jenis isi, galat); cache 24 jam diuji
        // di `mail-image-proxy.integration.test.ts`.
        imageCache: false,
        fetchRemote: (request) => {
          fetches.push(request);
          return Promise.resolve(remote);
        },
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  queued.body.length = 0;
  queued.attachment.length = 0;
  queued.action.length = 0;
  fetches.length = 0;
  remote = { ok: false, error: 'dns', httpStatus: null };
});

afterAll(async () => {
  await harness?.close();
});

describe('daftar email', () => {
  it('gabungan/belum dibaca/berbintang/folder, kursor, chip alias, pending pindah tersembunyi; akun pribadi orang lain tidak pernah ikut (Owner)', async () => {
    const shared = await insertAccount({ displayName: 'Billing', color: 'tagTeal' });
    const { user: budi, signed: budiSigned } = await signIn('cs');
    const personal = await insertAccount({ kind: 'personal', ownerUserId: budi.id });
    const base = Date.now();
    const a = await insertMessage(shared.account, shared.inbox, {
      receivedAt: new Date(base - 1_000),
      deliveredTo: shared.account.emailAddress,
    });
    const b = await insertMessage(shared.account, shared.inbox, {
      receivedAt: new Date(base - 2_000),
      isRead: true,
      isStarred: true,
      deliveredTo: 'tagihan@majujaya.test',
    });
    const c = await insertMessage(shared.account, shared.inbox, {
      receivedAt: new Date(base - 3_000),
    });
    await insertMessage(shared.account, shared.inbox, {
      receivedAt: new Date(base - 500),
      pendingAction: 'move',
      pendingActionAt: new Date(),
      pendingTargetFolderId: shared.trash.id,
    });
    await insertMessage(shared.account, shared.trash, { receivedAt: new Date(base - 100) });
    const secret = await insertMessage(personal.account, personal.inbox, {
      subject: 'Rahasia pribadi',
      receivedAt: new Date(base),
    });

    const page1 = await list(owner, 'view=inboxes&limit=2');
    expect(page1.messages.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(page1.messages[0]?.account).toMatchObject({ displayName: 'Billing', color: 'tagTeal' });
    expect(page1.messages[0]?.deliveredToAlias).toBe(false);
    expect(page1.messages[1]?.deliveredToAlias).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(owner, `view=inboxes&limit=2&cursor=${page1.nextCursor ?? ''}`);
    expect(page2.messages.map((item) => item.id)).toEqual([c.id]);
    expect(page2.nextCursor).toBeNull();

    expect((await list(owner, 'view=unread')).messages.map((item) => item.id)).toEqual([
      a.id,
      c.id,
    ]);
    expect((await list(owner, 'view=starred')).messages.map((item) => item.id)).toEqual([b.id]);
    expect((await list(owner, `view=folder&folderId=${shared.trash.id}`)).messages).toHaveLength(1);
    expect(JSON.stringify(await list(owner, 'view=inboxes'))).not.toContain('Rahasia pribadi');
    expect(JSON.stringify(await list(owner, 'view=unread'))).not.toContain(secret.id);

    // Folder / akun pribadi orang lain → 404 untuk Owner.
    expect(
      (await get(`${API_ROUTES.mail.messages}?view=folder&folderId=${personal.inbox.id}`, owner))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await get(
          `${API_ROUTES.mail.messages}?view=inboxes&accountId=${personal.account.id}`,
          owner,
        )
      ).statusCode,
    ).toBe(404);
    // Pemiliknya melihat akun pribadinya sendiri, bukan akun bersama tanpa grant.
    expect((await list(budiSigned, 'view=inboxes')).messages.map((item) => item.id)).toEqual([
      secret.id,
    ]);
    // Kursor rusak → 400.
    expect(
      (await get(`${API_ROUTES.mail.messages}?view=inboxes&cursor=bukan-kursor`, owner)).statusCode,
    ).toBe(400);
  });

  it('kinerja dasar: 50.000 email di satu akun → daftar gabungan & belum dibaca cepat (indeks)', async () => {
    const shared = await insertAccount();
    await harness.db.execute(sql`
      insert into mail_messages (id, organization_id, account_id, folder_id, folder_role, uid, uidvalidity, subject, received_at, is_read)
      select gen_random_uuid(), ${organizationId}::uuid, ${shared.account.id}::uuid, ${shared.inbox.id}::uuid, 'inbox', g, 1, 'Email ' || g,
        now() - (g || ' seconds')::interval, (g % 3 = 0)
      from generate_series(1, 50000) g`);
    await harness.db.execute(sql`analyze mail_messages`);
    const timed = async (query: string) => {
      await list(owner, query);
      const started = performance.now();
      const result = await list(owner, query);
      return { ms: performance.now() - started, result };
    };
    const inboxes = await timed('view=inboxes&limit=50');
    expect(inboxes.result.messages).toHaveLength(50);
    const unread = await timed('view=unread&limit=50');
    expect(unread.result.messages).toHaveLength(50);
    const deep = await timed(
      `view=folder&folderId=${shared.inbox.id}&limit=50&cursor=${inboxes.result.nextCursor ?? ''}`,
    );
    expect(deep.result.messages[0]?.subject).toBe('Email 51');
    // Target kontrak < 300 ms di server; batas tes longgar untuk mesin CI/Windows.
    for (const run of [inboxes, unread, deep]) expect(run.ms).toBeLessThan(1_000);
  }, 120_000);
});

describe('baca email', () => {
  it('isi belum ada → loading + job ambil isi; ada → detail lengkap (verifikasi, peringatan, lampiran), GET tidak menandai dibaca', async () => {
    const shared = await insertAccount();
    const message = await insertMessage(shared.account, shared.inbox, {
      senderVerification: 'fail',
      authDetails: { spf: 'fail', dkim: 'none', dmarc: 'fail', authServId: 'mail.majujaya.test' },
      warnings: ['impersonation', 'dangerous_attachment'],
    });
    const url = apiPath(API_ROUTES.mail.message, { messageId: message.id });
    const first = mailMessageDetailResponseSchema.parse((await get(url, owner)).json());
    expect(first.message.body.state).toBe('loading');
    expect(queued.body).toEqual([
      { organizationId, accountId: shared.account.id, messageId: message.id },
    ]);

    await insertBody(message.id);
    await harness.db.insert(mailAttachments).values([
      {
        organizationId,
        messageId: message.id,
        partId: '2',
        filename: 'setup.exe',
        declaredType: 'application/octet-stream',
        risk: 'blocked',
        riskReason: 'executable',
        sizeBytes: 10,
      },
      {
        organizationId,
        messageId: message.id,
        partId: '3',
        filename: 'data.zip',
        declaredType: 'application/zip',
        risk: 'warn',
        riskReason: 'archive',
        sizeBytes: 10,
      },
    ]);
    const detail = mailMessageDetailResponseSchema.parse((await get(url, owner)).json()).message;
    expect(detail.body).toMatchObject({ state: 'ready', hasHtml: true, text: 'Halo teks' });
    expect(detail.body.remoteImages).toEqual({ count: 1, senderAllowed: false, autoBlocked: true });
    expect(detail.verification).toMatchObject({ result: 'fail', spf: 'fail', dmarc: 'fail' });
    expect(detail.verification.label).toContain('gagal pemeriksaan keaslian');
    expect(detail.warningDetails.map((item) => item.type)).toEqual([
      'impersonation',
      'dangerous_attachment',
    ]);
    expect(detail.attachments.map((item) => [item.filename, item.risk, item.cached])).toEqual([
      ['setup.exe', 'blocked', false],
      ['data.zip', 'warn', false],
    ]);
    expect(detail.isRead).toBe(false);
    const [row] = await harness.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, message.id));
    expect(row?.isRead).toBe(false);
  });

  it('dokumen tampilan: CSP sendiri + frame-ancestors, tanpa X-Frame-Options, gambar luar diblokir bawaan; tampilkan → proksi https tanpa alamat privat, raster saja', async () => {
    const shared = await insertAccount();
    const message = await insertMessage(shared.account, shared.inbox);
    await insertBody(message.id);
    const saved = await store.save('mail', PNG);
    const [inline] = await harness.db
      .insert(mailAttachments)
      .values({
        organizationId,
        messageId: message.id,
        partId: '2',
        contentId: 'logo@mitra.test',
        isInline: true,
        detectedType: 'image/png',
        storageKey: saved.storageKey,
        sizeBytes: PNG.length,
      })
      .returning();

    const blocked = await view(owner, message.id);
    expect(blocked.remoteImages).toEqual({ count: 1, shown: false });
    expect(blocked.url).toMatch(/^\/api\/v1\/mail\/view\/[A-Za-z0-9_-]{72}$/);
    const doc = await get(blocked.url);
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-type']).toContain('text/html');
    const csp = String(doc.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(csp).not.toContain('script-src');
    expect(doc.headers['x-frame-options']).toBeUndefined();
    expect(doc.headers['x-content-type-options']).toBe('nosniff');
    expect(doc.headers['referrer-policy']).toBe('no-referrer');
    expect(doc.headers['cache-control']).toBe('private, no-store');
    expect(doc.body).toContain('data-gambar-diblokir="1"');
    expect(doc.body).not.toContain('cdn.mitra.test');
    expect(doc.body).toContain(`${blocked.url}/cid/${inline?.id ?? ''}`);
    // Gambar luar tanpa izin tampilan → 403; cid inline → PNG.
    expect((await get(`${blocked.url}/images/0`)).statusCode).toBe(403);
    expect(fetches).toHaveLength(0);
    const cid = await get(`${blocked.url}/cid/${inline?.id ?? ''}`);
    expect(cid.statusCode).toBe(200);
    expect(cid.headers['content-type']).toBe('image/png');
    // Rute lain tetap DENY.
    expect((await get(API_ROUTES.mail.messages, owner)).headers['x-frame-options']).toBe('DENY');

    const shown = await view(owner, message.id, 'show');
    expect(shown.remoteImages.shown).toBe(true);
    expect((await get(shown.url)).body).toContain(`${shown.url}/images/0`);
    remote = {
      ok: true,
      body: PNG,
      contentType: 'text/html',
      finalUrl: new URL('https://cdn.mitra.test/logo.png'),
    };
    const image = await get(`${shown.url}/images/0`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(fetches[0]).toMatchObject({
      url: 'https://cdn.mitra.test/logo.png',
      privateCidrs: [],
      maxBytes: 5 * 1024 * 1024,
    });
    expect(fetches[0]?.allowLoopback).toBeUndefined();
    expect(JSON.stringify(fetches[0]?.headers ?? {})).not.toMatch(/cookie|referer/i);
    // SVG / HTML dari server gambar → 415 (gambar kosong), galat jaringan → 502.
    remote = {
      ok: true,
      body: Buffer.from('<svg onload="alert(1)"></svg>'),
      contentType: 'image/svg+xml',
      finalUrl: new URL('https://cdn.mitra.test/x'),
    };
    const svg = await get(`${shown.url}/images/0`);
    expect(svg.statusCode).toBe(415);
    expect(svg.headers['content-type']).toBe('image/gif');
    remote = { ok: false, error: 'private', httpStatus: null } as unknown as RemoteFileResult;
    expect((await get(`${shown.url}/images/0`)).statusCode).toBe(502);
    expect((await get(`${shown.url}/images/1`)).statusCode).toBe(404);
    // Token tidak tercatat di log.
    expect(harness.logs.text()).not.toContain(shown.url.split('/').at(-1) ?? 'x');
  });

  it('token: dirusak / sesi asal keluar / hak dicabut → 410; "selalu dari pengirim ini" menampilkan gambar otomatis kecuali email gagal verifikasi', async () => {
    const shared = await insertAccount();
    const { user: reader, signed } = await signIn('cs');
    await grant(shared.account.id, reader.id, 'read');
    const message = await insertMessage(shared.account, shared.inbox);
    await insertBody(message.id);
    const issued = await view(signed, message.id);
    expect((await get(issued.url)).statusCode).toBe(200);
    const token = issued.url.split('/').at(-1) ?? '';
    const tampered = `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
    expect((await get(apiPath(API_ROUTES.mail.view, { token: tampered }))).statusCode).toBe(410);
    // Hak dicabut → token lama tidak berlaku lagi.
    await harness.db.delete(mailAccountAccess).where(eq(mailAccountAccess.userId, reader.id));
    expect((await get(issued.url)).statusCode).toBe(410);
    await grant(shared.account.id, reader.id, 'read');
    expect((await get(issued.url)).statusCode).toBe(200);
    await call(harness.app, 'POST', API_ROUTES.auth.logout, {}, signed);
    expect((await get(issued.url)).statusCode).toBe(410);

    const add = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.remoteImageSenders,
      { address: 'NOC@Mitra.test' },
      owner,
    );
    expect(add.statusCode, add.body).toBe(200);
    // Review 9A-2 R9: otomatis HANYA untuk pengirim yang lolos verifikasi; `unverified` tetap diblokir.
    expect((await view(owner, message.id)).remoteImages.shown).toBe(false);
    await harness.db
      .update(mailMessages)
      .set({ senderVerification: 'pass' })
      .where(eq(mailMessages.id, message.id));
    expect((await view(owner, message.id)).remoteImages.shown).toBe(true);
    await harness.db
      .update(mailMessages)
      .set({ senderVerification: 'fail' })
      .where(eq(mailMessages.id, message.id));
    expect((await view(owner, message.id)).remoteImages.shown).toBe(false);
    expect((await view(owner, message.id, 'show')).remoteImages.shown).toBe(true);
    const removed = await call(
      harness.app,
      'DELETE',
      API_ROUTES.mail.remoteImageSenders,
      { address: 'noc@mitra.test' },
      owner,
    );
    expect(removed.json()).toEqual({ senders: [] });
  });

  it('sumber header mentah & lampiran: blocked 403, arsip butuh konfirmasi, belum di cache 202 + job, di cache → attachment + nosniff + CSP sandbox', async () => {
    const shared = await insertAccount();
    const message = await insertMessage(shared.account, shared.inbox);
    const sourceUrl = apiPath(API_ROUTES.mail.messageSource, { messageId: message.id });
    expect((await get(sourceUrl, owner)).statusCode).toBe(409);
    await insertBody(message.id);
    const source = await get(sourceUrl, owner);
    expect(source.statusCode).toBe(200);
    expect(source.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(source.body).toContain('Subject: Pemeliharaan');
    expect((await get(`${sourceUrl}?download=1`, owner)).headers['content-disposition']).toContain(
      'attachment',
    );

    const pdf = await store.save('mail', Buffer.from('%PDF-1.4 isi'));
    const rows = await harness.db
      .insert(mailAttachments)
      .values([
        {
          organizationId,
          messageId: message.id,
          partId: '2',
          filename: 'setup.exe',
          risk: 'blocked',
          sizeBytes: 5,
        },
        {
          organizationId,
          messageId: message.id,
          partId: '3',
          filename: 'data.zip',
          risk: 'warn',
          sizeBytes: 5,
        },
        {
          organizationId,
          messageId: message.id,
          partId: '4',
          filename: 'faktur "Nov".pdf',
          risk: 'ok',
          detectedType: 'application/pdf',
          storageKey: pdf.storageKey,
          sizeBytes: pdf.sizeBytes,
        },
        {
          organizationId,
          messageId: message.id,
          partId: '5',
          filename: 'besar.pdf',
          risk: 'ok',
          sizeBytes: 100 * 1024 * 1024,
        },
      ])
      .returning();
    const [exe, zip, faktur, big] = rows;
    const att = (id: string, query = '') =>
      get(`${apiPath(API_ROUTES.mail.attachment, { attachmentId: id })}${query}`, owner);
    const blocked = await att(exe?.id ?? '');
    expect(blocked.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(blocked.json()).error.details?.[0]?.reason).toBe(
      'attachment_blocked',
    );
    expect(queued.attachment).toHaveLength(0);
    const needs = await att(zip?.id ?? '');
    expect(needs.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(needs.json()).error.details?.[0]?.reason).toBe(
      'attachment_needs_confirmation',
    );
    const loading = await att(zip?.id ?? '', '?confirm=1');
    expect(loading.statusCode).toBe(202);
    expect(loading.json()).toEqual({ state: 'loading' });
    expect(queued.attachment).toEqual([
      { organizationId, accountId: shared.account.id, attachmentId: zip?.id },
    ]);
    const file = await att(faktur?.id ?? '');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(
      /^attachment; filename="faktur _Nov_.pdf"; filename\*=UTF-8''/,
    );
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.body).toBe('%PDF-1.4 isi');
    expect((await att(big?.id ?? '')).statusCode).toBe(413);
    const preview = await get(
      apiPath(API_ROUTES.mail.attachmentPreview, { attachmentId: faktur?.id ?? '' }),
      owner,
    );
    expect(preview.statusCode).toBe(415);
  });
});

describe('aksi dua arah & hak per level', () => {
  it('Baca: dibaca/bintang (tertunda + hitungan + job) tetapi tidak pindah; Baca & kirim: arsip (folder dibuat) & sampah, tidak hapus permanen; Kelola: hapus permanen dari Sampah + audit', async () => {
    const shared = await insertAccount();
    const { user: readerUser, signed: reader } = await signIn('cs');
    const { user: senderUser, signed: sender } = await signIn('supervisor');
    await grant(shared.account.id, readerUser.id, 'read');
    await grant(shared.account.id, senderUser.id, 'send');
    const m1 = await insertMessage(shared.account, shared.inbox);
    const m2 = await insertMessage(shared.account, shared.inbox);
    const inTrash = await insertMessage(shared.account, shared.trash);

    const read = mailActionResponseSchema.parse(
      (await act(reader, { messageIds: [m1.id], action: 'mark_read' })).json(),
    );
    expect(read).toEqual({ results: [{ id: m1.id, ok: true }], applied: 1 });
    const [afterRead] = await harness.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, m1.id));
    expect(afterRead).toMatchObject({
      isRead: true,
      pendingAction: 'flags',
      pendingRevert: { isRead: false, isStarred: false },
    });
    const [inboxAfter] = await harness.db
      .select()
      .from(mailFolders)
      .where(eq(mailFolders.id, shared.inbox.id));
    expect(inboxAfter?.unreadCount).toBe(4);
    expect(queued.action).toEqual([{ organizationId, accountId: shared.account.id }]);

    const moveDenied = mailActionResponseSchema.parse(
      (await act(reader, { messageIds: [m1.id], action: 'archive' })).json(),
    );
    expect(moveDenied.results[0]).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const denials = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.access.denied'));
    expect(denials.length).toBeGreaterThan(0);

    const archived = mailActionResponseSchema.parse(
      (await act(sender, { messageIds: [m1.id], action: 'archive' })).json(),
    );
    expect(archived.applied).toBe(1);
    const [archiveFolder] = await harness.db
      .select()
      .from(mailFolders)
      .where(and(eq(mailFolders.accountId, shared.account.id), eq(mailFolders.role, 'archive')));
    expect(archiveFolder).toMatchObject({
      path: 'INBOX.Archive',
      name: 'Arsip',
      roleSource: 'created',
    });
    const [afterArchive] = await harness.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, m1.id));
    expect(afterArchive).toMatchObject({
      pendingAction: 'move',
      pendingTargetFolderId: archiveFolder?.id,
      folderId: shared.inbox.id,
    });
    // Tidak tampil lagi di Kotak masuk.
    expect((await list(owner, 'view=inboxes')).messages.map((item) => item.id)).toEqual([m2.id]);

    const trashAgain = mailActionResponseSchema.parse(
      (await act(sender, { messageIds: [inTrash.id], action: 'trash' })).json(),
    );
    expect(trashAgain.results[0]?.error?.code).toBe('VALIDATION_ERROR');
    const deleteBySender = mailActionResponseSchema.parse(
      (await act(sender, { messageIds: [inTrash.id], action: 'delete_permanently' })).json(),
    );
    expect(deleteBySender.results[0]?.error?.code).toBe('FORBIDDEN');
    const notInTrash = mailActionResponseSchema.parse(
      (await act(owner, { messageIds: [m2.id], action: 'delete_permanently' })).json(),
    );
    expect(notInTrash.results[0]?.error?.code).toBe('VALIDATION_ERROR');
    const deleted = mailActionResponseSchema.parse(
      (await act(owner, { messageIds: [inTrash.id], action: 'delete_permanently' })).json(),
    );
    expect(deleted.applied).toBe(1);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'mail.message.deleted_permanently'));
    expect(audit?.metadata).toEqual({
      accountId: shared.account.id,
      folderId: shared.trash.id,
      count: 1,
    });
    expect(JSON.stringify(audit)).not.toContain('Pemeliharaan');
  });

  it('pindah hanya ke folder akun yang sama; akun pribadi orang lain = 404/NOT_FOUND di detail, view, sumber, lampiran, aksi (Owner); > 100 ID → 400', async () => {
    const shared = await insertAccount();
    const other = await insertAccount();
    const { user: budi } = await signIn('cs');
    const personal = await insertAccount({ kind: 'personal', ownerUserId: budi.id });
    const m = await insertMessage(shared.account, shared.inbox);
    const cross = mailActionResponseSchema.parse(
      (
        await act(owner, { messageIds: [m.id], action: 'move', targetFolderId: other.trash.id })
      ).json(),
    );
    expect(cross.results[0]).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(
      (await act(owner, { messageIds: [m.id], action: 'move', targetFolderId: personal.trash.id }))
        .statusCode,
    ).toBe(404);

    const secret = await insertMessage(personal.account, personal.inbox, { subject: 'Rahasia' });
    await insertBody(secret.id);
    const [secretAttachment] = await harness.db
      .insert(mailAttachments)
      .values({ organizationId, messageId: secret.id, partId: '2', filename: 'a.pdf', risk: 'ok' })
      .returning();
    for (const url of [
      apiPath(API_ROUTES.mail.message, { messageId: secret.id }),
      apiPath(API_ROUTES.mail.messageSource, { messageId: secret.id }),
      apiPath(API_ROUTES.mail.attachment, { attachmentId: secretAttachment?.id ?? '' }),
      apiPath(API_ROUTES.mail.attachmentPreview, { attachmentId: secretAttachment?.id ?? '' }),
    ]) {
      const response = await get(url, owner);
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain('Rahasia');
    }
    const viewResponse = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.messageView, { messageId: secret.id }),
      {},
      owner,
    );
    expect(viewResponse.statusCode).toBe(404);
    const action = mailActionResponseSchema.parse(
      (await act(owner, { messageIds: [secret.id], action: 'mark_read' })).json(),
    );
    expect(action.results[0]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const [untouched] = await harness.db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, secret.id));
    expect(untouched?.isRead).toBe(false);

    const many = Array.from({ length: 101 }, () => newId());
    expect((await act(owner, { messageIds: many, action: 'mark_read' })).statusCode).toBe(400);
  });
});
