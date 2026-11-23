/**
 * Review keamanan 9A bagian 2 (docs/security-reviews/2026-11-23-fase9a-2.md) — dokumen tampilan
 * ber-token, proksi gambar, lampiran. Postgres + Redis sungguhan; unduhan gambar luar DITIRU (tidak ada
 * sambungan keluar).
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMediaStore, type RemoteFileRequest, type RemoteFileResult } from '@balesin/core';
import {
  mailAccountAccess,
  mailAccounts,
  mailAttachments,
  mailFolders,
  mailMessageBodies,
  mailMessages,
  users,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, mailMessageViewResponseSchema, type UserRole } from '@balesin/shared';
import { eq } from 'drizzle-orm';
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

const PASSWORD = 'sandi-uji-review-9a2-01';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const store = createMediaStore(join(tmpdir(), `balesin-tes-media-${String(process.pid)}`));

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
const fetches: RemoteFileRequest[] = [];
let fetchRemote: (request: RemoteFileRequest) => Promise<RemoteFileResult>;
const pngResult = (): RemoteFileResult => ({
  ok: true,
  body: PNG,
  contentType: 'image/png',
  finalUrl: new URL('https://cdn.mitra.test/a.png'),
});

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

async function seedMessage(
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
  body: Partial<typeof mailMessageBodies.$inferInsert> = {},
) {
  const [account] = await harness.db
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
  if (!account) throw new Error('akun');
  const [inbox] = await harness.db
    .insert(mailFolders)
    .values({
      organizationId,
      accountId: account.id,
      path: 'INBOX',
      name: 'Kotak masuk',
      delimiter: '.',
      role: 'inbox',
      roleSource: 'special_use',
    })
    .returning();
  if (!inbox) throw new Error('folder');
  const [message] = await harness.db
    .insert(mailMessages)
    .values({
      organizationId,
      accountId: account.id,
      folderId: inbox.id,
      folderRole: 'inbox',
      uid: Math.floor(Math.random() * 1_000_000) + 1,
      uidvalidity: 1,
      fromAddress: 'promo@mitra.test',
      fromName: 'Mitra',
      to: [{ address: 'cs@majujaya.test', name: null }],
      subject: 'Promo',
      snippet: 'Cuplikan',
      receivedAt: new Date(),
      bodyState: 'ready',
    })
    .returning();
  if (!message) throw new Error('pesan');
  await harness.db.insert(mailMessageBodies).values({
    messageId: message.id,
    organizationId,
    text: 'Halo',
    htmlSanitized: '<p><img src="balesin-remote:0"></p>',
    remoteImages: ['https://cdn.mitra.test/a.png'],
    rawHeaders: 'From: promo@mitra.test',
    ...body,
  });
  return { account, inbox, message };
}

const get = (url: string, signed?: SignedIn) => call(harness.app, 'GET', url, undefined, signed);
async function view(signed: SignedIn, messageId: string, images: 'auto' | 'show' = 'show') {
  const response = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.mail.messageView, { messageId }),
    { images },
    signed,
  );
  expect(response.statusCode, response.body).toBe(200);
  return mailMessageViewResponseSchema.parse(response.json());
}

beforeAll(async () => {
  harness = await createIntegrationHarness({
    mailQueue: {
      sync: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      fetchBody: () => Promise.resolve(),
      fetchAttachment: () => Promise.resolve(),
      action: () => Promise.resolve(),
    },
    overrides: {
      mail: {
        // Tes S5 menghitung UNDUHAN keluar; cache 24 jam (yang juga menutup S5/R8) diuji terpisah di
        // `mail-image-proxy.integration.test.ts`.
        imageCache: false,
        fetchRemote: (request) => {
          fetches.push(request);
          return fetchRemote(request);
        },
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  fetches.length = 0;
  fetchRemote = () => Promise.resolve(pngResult());
});

afterAll(async () => {
  await harness?.close();
});

describe('S5 — proksi gambar luar: batas per pengguna & konkurensi', () => {
  // Kontrak §8: 300/menit/PENGGUNA. Sekarang kuncinya `token.slice(0, 32)` = versi + ID pesan + 7 byte
  // ID sesi → praktis per (pesan, sesi): email lain (server IMAP milik CS bisa memuat ribuan) = jatah
  // 300 baru. Sisanya hanya 600/menit per IP (IPv6 tidak dikelompokkan /64).
  it('unduhan gambar ke-301 dalam semenit oleh pengguna yang sama → 429 walau lewat token email lain', async () => {
    const { message } = await seedMessage();
    const another = await seedMessage();
    const first = await view(owner, message.id);
    const second = await view(owner, another.message.id);
    for (let batch = 0; batch < 10; batch += 1) {
      const responses = await Promise.all(
        Array.from({ length: 30 }, () => get(`${first.url}/images/0`)),
      );
      for (const response of responses) expect(response.statusCode).toBe(200);
    }
    expect(fetches).toHaveLength(300);
    const extra = await get(`${second.url}/images/0`);
    expect(extra.statusCode).toBe(429);
  }, 60_000);

  // Setiap unduhan menampung ≤ 5 MB di memori proses api (`fetchRemoteFile` menimbun potongan lalu
  // `Buffer.concat`) tanpa batas permintaan bersamaan → ratusan unduhan paralel ke server milik
  // penyerang (menetes sampai tenggat 8 dtk) = GB memori → api OOM (termasuk penerima webhook Meta).
  it('unduhan gambar bersamaan satu pengguna dibatasi (≤ 8 berjalan sekaligus)', async () => {
    const { message } = await seedMessage();
    const issued = await view(owner, message.id);
    let inFlight = 0;
    let peak = 0;
    fetchRemote = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 150));
      inFlight -= 1;
      return pngResult();
    };
    await Promise.all(Array.from({ length: 30 }, () => get(`${issued.url}/images/0`)));
    expect(peak).toBeLessThanOrEqual(8);
  }, 60_000);
});

describe('regresi 9A-2 — token, cid, lampiran', () => {
  it('token satu email tidak bisa memuat gambar inline (cid) milik email lain, juga di akun yang sama', async () => {
    const a = await seedMessage();
    const other = await seedMessage();
    const saved = await store.save('mail', PNG);
    const [foreign] = await harness.db
      .insert(mailAttachments)
      .values({
        organizationId,
        messageId: other.message.id,
        partId: '2',
        contentId: 'logo@mitra.test',
        isInline: true,
        detectedType: 'image/png',
        storageKey: saved.storageKey,
        sizeBytes: PNG.length,
      })
      .returning();
    const issued = await view(owner, a.message.id, 'auto');
    const response = await get(`${issued.url}/cid/${foreign?.id ?? ''}`);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('image/gif');
  });

  it('akun pribadi orang lain: Owner tidak bisa membuat token; token pemilik tidak berlaku setelah ia dinonaktifkan', async () => {
    const { user: cs, signed } = await signIn('cs');
    const personal = await seedMessage({ kind: 'personal', ownerUserId: cs.id });
    const denied = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.messageView, { messageId: personal.message.id }),
      { images: 'show' },
      owner,
    );
    expect(denied.statusCode).toBe(404);
    const issued = await view(signed, personal.message.id);
    expect((await get(issued.url)).statusCode).toBe(200);
    expect((await get(`${issued.url}/images/0`)).statusCode).toBe(200);

    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.id));
    expect((await get(issued.url)).statusCode).toBe(410);
    expect((await get(`${issued.url}/images/0`)).statusCode).toBe(410);
  });

  it('Teknisi tanpa hak akun bersama → 404 untuk token; dengan Baca → boleh, dicabut → 410', async () => {
    const shared = await seedMessage();
    const { user: tech, signed } = await signIn('teknisi');
    const denied = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.messageView, { messageId: shared.message.id }),
      { images: 'auto' },
      signed,
    );
    expect(denied.statusCode).toBe(404);
    await harness.db.insert(mailAccountAccess).values({
      organizationId,
      accountId: shared.account.id,
      principalType: 'user',
      userId: tech.id,
      level: 'read',
    });
    const issued = await view(signed, shared.message.id, 'auto');
    expect((await get(issued.url)).statusCode).toBe(200);
    await harness.db.delete(mailAccountAccess).where(eq(mailAccountAccess.userId, tech.id));
    expect((await get(issued.url)).statusCode).toBe(410);
  });

  it('unduhan lampiran: nama berkas berisi CR/LF/kutip/titik koma tidak memecah header; jenis bukan raster/PDF → octet-stream', async () => {
    const { message } = await seedMessage();
    const saved = await store.save('mail', Buffer.from('<html><script>alert(1)</script></html>'));
    const [row] = await harness.db
      .insert(mailAttachments)
      .values({
        organizationId,
        messageId: message.id,
        partId: '3',
        filename: 'a\r\nSet-Cookie: x=1;"b\\c/d‮txt.exe',
        declaredType: 'text/plain',
        // Andai deteksi keliru: jenis HTML tetap tidak boleh disajikan sebagai text/html.
        detectedType: 'text/html',
        storageKey: saved.storageKey,
        sizeBytes: 40,
        risk: 'ok',
      })
      .returning();
    const response = await get(
      apiPath(API_ROUTES.mail.attachment, { attachmentId: row?.id ?? '' }),
      owner,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(String(response.headers['content-security-policy'])).toContain('sandbox');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    // Bagian ASCII: tanpa kutip/garis miring/backslash mentah di dalam nilai filename="…".
    const ascii = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(ascii).not.toMatch(/["\\/]/);
  });
});
