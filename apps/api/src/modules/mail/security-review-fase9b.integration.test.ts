/**
 * Review keamanan tahap 9B (docs/security-reviews/2026-11-23-fase9b.md) — tes PENGUNCI temuan api.
 * Setiap `it.fails` menegaskan perilaku AMAN yang BELUM dipenuhi kode saat ini; saat temuannya
 * diperbaiki, tes ini mulai lulus sehingga `it.fails` gagal → ubah menjadi `it` (asersi jangan diubah).
 *
 * Model ancaman: satu akun CS dibobol (punya hak Baca di kotak bersama, boleh menghubungkan akun
 * pribadi) dan ingin mengirim email atas nama alamat resmi organisasi / menghabiskan sumber daya.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMailComposeKeys, type RemoteFileResult } from '@balesin/core';
import {
  emailSettings,
  mailAccountAccess,
  mailAccounts,
  mailCorrespondents,
  mailDraftAttachments,
  mailFolders,
  mailIdentities,
  mailMessageBodies,
  mailMessages,
  mailOutbox,
  mailRemoteImageCache,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  createMailDraftResponseSchema,
  errorEnvelopeSchema,
  mailMessageViewResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

const PASSWORD = 'sandi-uji-review-9b-01';
const keys = createMailComposeKeys(TEST_MASTER_KEY);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let mediaDir: string;
let fetchRemote: () => Promise<RemoteFileResult>;

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

async function insertAccount(
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
  options: { verified?: boolean } = {},
) {
  const address = overrides.emailAddress ?? `cs-${randomBytes(3).toString('hex')}@majujaya.test`;
  const [row] = await harness.db
    .insert(mailAccounts)
    .values({
      organizationId,
      kind: 'shared',
      provider: 'cpanel',
      displayName: 'CS',
      emailAddress: address,
      fromName: 'Tim CS',
      color: 'tagBlue',
      imapHost: 'mail.majujaya.test',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: address,
      imapPasswordEncrypted: 'v1.x.y',
      smtpHost: 'mail.majujaya.test',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      syncState: 'ready',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('akun');
  const verified = options.verified ?? true;
  const [identity] = await harness.db
    .insert(mailIdentities)
    .values({
      organizationId,
      accountId: row.id,
      address,
      displayName: 'Tim CS',
      isPrimary: true,
      ...(verified
        ? { verificationState: 'verified', verifiedAt: new Date(), verifiedMethod: 'code' }
        : {}),
    })
    .returning();
  if (!identity) throw new Error('identitas');
  const [inbox] = await harness.db
    .insert(mailFolders)
    .values({
      organizationId,
      accountId: row.id,
      path: 'INBOX',
      name: 'Kotak masuk',
      role: 'inbox',
      roleSource: 'special_use',
    })
    .returning();
  if (!inbox) throw new Error('folder');
  return { account: row, identity, inbox };
}

/** Akun PRIBADI milik `userId` di server milik pendaftar (bukan server organisasi). */
const personalOf = (userId: string, verified = false) =>
  insertAccount(
    {
      kind: 'personal',
      ownerUserId: userId,
      emailAddress: `budi-${randomBytes(3).toString('hex')}@pribadi.test`,
      imapHost: 'imap.pribadi.test',
      smtpHost: 'smtp.pribadi.test',
    },
    { verified },
  );

async function grant(accountId: string, userId: string, level: 'read' | 'send' | 'manage') {
  await harness.db
    .insert(mailAccountAccess)
    .values({ organizationId, accountId, principalType: 'user', userId, level });
}

const reasonOf = (response: { json(): unknown }) =>
  errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason;

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-review-9b-'));
  harness = await createIntegrationHarness({
    config: { mediaDir },
    mailQueue: {
      sync: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      fetchBody: () => Promise.resolve(),
      fetchAttachment: () => Promise.resolve(),
      action: () => Promise.resolve(),
    },
    overrides: { mail: { fetchRemote: () => fetchRemote() } },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  const [org] = await harness.db.select({ id: organizations.id }).from(organizations).limit(1);
  organizationId = org?.id ?? '';
  fetchRemote = () =>
    Promise.resolve({
      ok: true,
      body: PNG,
      contentType: 'image/png',
      finalUrl: new URL('https://cdn.penyerang.test/a.png'),
    });
});

afterAll(async () => {
  await harness?.close();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('S2 (Tinggi) — kode verifikasi terbaca lewat Terkirim kotak surat Email pengirim sistem', () => {
  it.fails(
    'kotak surat pengirim sistem terhubung sebagai akun Email MANA PUN → verifikasi identitas lain di organisasi tidak tersedia',
    async () => {
      // Kotak surat `kotak@` = SMTP Email pengirim sistem (Gmail/M365 menyimpan salinan di Terkirim),
      // dihubungkan sebagai akun bersama yang bisa DIBACA CS.
      const shared = await insertAccount();
      await harness.db.insert(emailSettings).values({
        organizationId,
        fromName: 'Sistem',
        fromAddress: 'noreply@majujaya.test',
        host: shared.account.smtpHost ?? 'mail.majujaya.test',
        port: 465,
        security: 'ssl',
        username: shared.account.imapUsername,
        passwordEncrypted: 'v1.x.y',
      });
      const cs = await signIn('cs');
      await grant(shared.account.id, cs.user.id, 'read');
      // CS memulai verifikasi alamat di akun PRIBADI-nya: salinan email ber-kode akan tersimpan di
      // Terkirim `kotak@` yang ia baca → kode didapat tanpa memiliki alamatnya.
      const personal = await personalOf(cs.user.id);
      const started = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.identityVerification, { identityId: personal.identity.id }),
        undefined,
        cs.signed,
      );
      expect(started.statusCode, started.body).toBe(409);
      expect(reasonOf(started)).toBe('verification_unavailable');
    },
  );
});

describe('S3 (Sedang) — alias akun PRIBADI berdomain organisasi diverifikasi sendiri lewat kode', () => {
  it.fails(
    'pemilik akun pribadi tidak bisa memverifikasi sendiri alias di domain organisasi (butuh Owner/Admin)',
    async () => {
      // Domain organisasi: domain akun bersama yang sudah ada.
      await insertAccount();
      await harness.db.insert(emailSettings).values({
        organizationId,
        fromName: 'Sistem',
        fromAddress: 'noreply@majujaya.test',
        host: 'smtp.sistem.test',
        port: 465,
        security: 'ssl',
      });
      const cs = await signIn('cs');
      const personal = await personalOf(cs.user.id, true);
      // `tagihan@` tidak terhubung di mana pun, tetapi diteruskan ke kotak bersama yang dibaca CS
      // (pola umum) → email verifikasi ber-kode terbaca CS.
      const created = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.account.id }),
        { address: 'tagihan@majujaya.test', displayName: 'Tim Tagihan' },
        cs.signed,
      );
      expect(created.statusCode, created.body).toBe(201);
      const aliasId = created.json<{ identity: { id: string } }>().identity.id;
      await harness.db
        .update(mailIdentities)
        .set({
          verificationState: 'pending',
          verificationCodeHash: keys.hashVerificationCode(aliasId, '482913'),
          verificationExpiresAt: new Date(Date.now() + 10 * 60_000),
          verificationAttempts: 0,
        })
        .where(eq(mailIdentities.id, aliasId));
      await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.identityVerificationConfirm, { identityId: aliasId }),
        { code: '482913' },
        cs.signed,
      );
      const [row] = await harness.db
        .select({ state: mailIdentities.verificationState })
        .from(mailIdentities)
        .where(eq(mailIdentities.id, aliasId));
      expect(row?.state).not.toBe('verified');
    },
  );
});

describe('S4 (Sedang) — syarat 3 S4 9A-1: alamat organisasi bisa "diduduki" alias pribadi', () => {
  it.fails(
    'alias akun pribadi yang BELUM terverifikasi tidak menghalangi Owner memakai alamat itu di akun bersama',
    async () => {
      const shared = await insertAccount();
      const cs = await signIn('cs');
      const personal = await personalOf(cs.user.id);
      const squat = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.account.id }),
        { address: 'tagihan@majujaya.test', displayName: 'Tagihan' },
        cs.signed,
      );
      expect(squat.statusCode, squat.body).toBe(201);
      const claim = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: shared.account.id }),
        {
          address: 'tagihan@majujaya.test',
          displayName: 'Tim Tagihan',
          confirmation: await confirmationOf(owner),
        },
        owner,
      );
      expect(claim.statusCode, claim.body).toBe(201);
    },
  );
});

describe('S5 (Sedang) — sisa P2-S8: berkas cache gambar yatim dari unduhan bersamaan', () => {
  it.fails(
    '8 permintaan bersamaan untuk gambar yang sama → berkas di disk = baris cache (tanpa berkas yatim)',
    async () => {
      const shared = await insertAccount();
      const [message] = await harness.db
        .insert(mailMessages)
        .values({
          organizationId,
          accountId: shared.account.id,
          folderId: shared.inbox.id,
          folderRole: 'inbox',
          uid: Math.floor(Math.random() * 1_000_000) + 1,
          uidvalidity: 1,
          fromAddress: 'promo@mitra.test',
          to: [{ address: shared.account.emailAddress, name: null }],
          subject: 'Promo',
          receivedAt: new Date(),
          bodyState: 'ready',
          senderVerification: 'pass',
        })
        .returning();
      if (!message) throw new Error('pesan');
      await harness.db.insert(mailMessageBodies).values({
        messageId: message.id,
        organizationId,
        text: 'Halo',
        htmlSanitized: '<p><img src="balesin-remote:0"></p>',
        remoteImages: [`https://cdn.penyerang.test/${randomUUID()}.png`],
        rawHeaders: 'From: promo@mitra.test',
      });
      fetchRemote = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          ok: true,
          body: PNG,
          contentType: 'image/png',
          finalUrl: new URL('https://cdn.penyerang.test/a.png'),
        };
      };
      const viewed = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.messageView, { messageId: message.id }),
        { images: 'show' },
        owner,
      );
      expect(viewed.statusCode, viewed.body).toBe(200);
      const { url } = mailMessageViewResponseSchema.parse(viewed.json());
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => call(harness.app, 'GET', `${url}/images/0`)),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const rows = await harness.db
        .select({ key: mailRemoteImageCache.storageKey })
        .from(mailRemoteImageCache)
        .where(eq(mailRemoteImageCache.accountId, shared.account.id));
      const files = await readdir(join(mediaDir, 'mail')).catch(() => [] as string[]);
      expect(rows).toHaveLength(1);
      // Setiap berkas di folder cache harus dirujuk baris (kuota & retensi hanya melihat baris).
      expect(files).toHaveLength(rows.length);
    },
  );
});

describe('R2 (Rendah) — batas harian pengguna bisa dilewati dengan kirim paralel', () => {
  it.fails(
    '4 kirim paralel × 50 penerima dengan batas harian 60 → total penerima di outbox ≤ 60',
    async () => {
      const { account, identity } = await insertAccount();
      await harness.db
        .update(organizations)
        .set({ sendDailyLimitPerUser: 60 })
        .where(eq(organizations.id, organizationId));
      const addresses = Array.from({ length: 50 }, (_, i) => `kenal${String(i)}@pelanggan.test`);
      await harness.db
        .insert(mailCorrespondents)
        .values(addresses.map((address) => ({ organizationId, accountId: account.id, address })));
      const drafts = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await call(
          harness.app,
          'POST',
          API_ROUTES.mail.drafts,
          {
            mode: 'new',
            identityId: identity.id,
            to: addresses.map((address) => ({ address })),
            subject: `Info ${String(i)}`,
          },
          owner,
        );
        expect(response.statusCode, response.body).toBe(201);
        drafts.push(createMailDraftResponseSchema.parse(response.json()).draft);
      }
      await Promise.all(
        drafts.map((draft) =>
          call(
            harness.app,
            'POST',
            apiPath(API_ROUTES.mail.draftSend, { draftId: draft.id }),
            { baseVersion: draft.version },
            owner,
          ),
        ),
      );
      const [total] = await harness.db
        .select({ value: sql<number>`coalesce(sum(${mailOutbox.recipientCount}), 0)::int` })
        .from(mailOutbox)
        .where(eq(mailOutbox.organizationId, organizationId));
      expect(total?.value ?? 0).toBeLessThanOrEqual(60);
    },
  );
});

describe('R5 (Rendah) — kuota unggah 500 MB/24 jam bisa diakali unggah-lalu-hapus', () => {
  it.fails(
    'lampiran 500 MB yang diunggah lalu dihapus tetap memakai kuota unggah 24 jam',
    async () => {
      const { identity } = await insertAccount();
      const created = await call(
        harness.app,
        'POST',
        API_ROUTES.mail.drafts,
        {
          mode: 'new',
          identityId: identity.id,
          to: [{ address: 'rina@pelanggan.test' }],
          subject: 'Berkas',
        },
        owner,
      );
      const draft = createMailDraftResponseSchema.parse(created.json()).draft;
      // 20 × 25 MB "terunggah" hari ini (baris saja; berkasnya tidak perlu ada untuk kuota).
      const rows = await harness.db
        .insert(mailDraftAttachments)
        .values(
          Array.from({ length: 20 }, (_, position) => ({
            organizationId,
            draftId: draft.id,
            position,
            filename: `besar-${String(position)}.pdf`,
            contentType: 'application/pdf',
            sizeBytes: 25 * 1024 * 1024,
            storageKey: `email-out/${randomUUID()}`,
            source: 'upload',
            state: 'ready',
            createdByUserId: owner.session.user.id,
          })),
        )
        .returning({ id: mailDraftAttachments.id });
      for (const row of rows) {
        const removed = await call(
          harness.app,
          'DELETE',
          apiPath(API_ROUTES.mail.draftAttachment, { draftId: draft.id, attachmentId: row.id }),
          undefined,
          owner,
        );
        expect(removed.statusCode, removed.body).toBe(200);
      }
      const boundary = `----balesin${randomUUID()}`;
      const response = await harness.app.inject({
        method: 'POST',
        url: apiPath(API_ROUTES.mail.draftAttachments, { draftId: draft.id }),
        headers: {
          cookie: owner.cookie,
          origin: TEST_APP_ORIGIN,
          'x-csrf-token': owner.csrf,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          Buffer.from('%PDF-1.4 isi kecil'),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      expect(response.statusCode, response.body).toBe(429);
      expect(reasonOf(response)).toBe('upload_quota');
    },
  );
});
