/**
 * Tahap 9B — tulis/balas/teruskan (docs/KONTRAK-API-EMAIL-TULIS.md §17 "Integrasi api"): otorisasi
 * per level & kepemilikan draf (orang lain/Owner → 404), identitas (unik lintas akun/channel/pengirim
 * sistem, konflik pengirim sistem, kode salah/kedaluwarsa, batas kirim verifikasi), simpan otomatis +
 * konflik versi, kirim (identitas belum terverifikasi, klik ganda, versi basi, email baru di utas,
 * batas penerima, jatah alamat baru diambil & dikembalikan, rem darurat), batalkan kirim, lampiran
 * (jenis dari isi), saran penerima tidak membocorkan akun pribadi orang lain, header injection.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { createMailComposeKeys } from '@balesin/core';
import {
  channels,
  emailSettings,
  mailAccountAccess,
  mailAccounts,
  mailCorrespondents,
  mailFolders,
  mailIdentities,
  mailMessageBodies,
  mailMessages,
  mailOutbox,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  createMailDraftResponseSchema,
  errorEnvelopeSchema,
  mailDraftCheckResponseSchema,
  mailOutboxResponseSchema,
  mailRecipientSuggestResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import { createPasswordHasher } from '../auth/password-hasher';
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

const PASSWORD = 'sandi-uji-tulis-email-01';
const keys = createMailComposeKeys(TEST_MASTER_KEY);

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;

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

async function grant(accountId: string, userId: string, level: 'read' | 'send' | 'manage') {
  await harness.db
    .insert(mailAccountAccess)
    .values({ organizationId, accountId, principalType: 'user', userId, level });
}

async function insertMessage(
  accountId: string,
  folderId: string,
  overrides: Partial<typeof mailMessages.$inferInsert> = {},
) {
  const messageIdHeader = `${randomBytes(6).toString('hex')}@pelanggan.test`;
  const [row] = await harness.db
    .insert(mailMessages)
    .values({
      organizationId,
      accountId,
      folderId,
      folderRole: 'inbox',
      uid: Math.floor(Math.random() * 1_000_000) + 1,
      uidvalidity: 1,
      messageIdHeader,
      fromAddress: 'rina@pelanggan.test',
      fromName: 'Rina Wulandari',
      to: [{ address: 'cs@majujaya.test', name: null }],
      subject: 'Permintaan upgrade paket',
      receivedAt: new Date(Date.now() - 60_000),
      threadRoot: messageIdHeader,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('pesan');
  return row;
}

async function newDraft(signed: SignedIn, identityId: string, body: Record<string, unknown> = {}) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.mail.drafts,
    {
      mode: 'new',
      identityId,
      to: [{ address: 'rina@pelanggan.test', name: 'Rina' }],
      subject: 'Penawaran',
      ...body,
    },
    signed,
  );
  expect(response.statusCode, response.body).toBe(201);
  return createMailDraftResponseSchema.parse(response.json()).draft;
}

const send = (
  signed: SignedIn,
  draftId: string,
  baseVersion: number,
  extra: Record<string, unknown> = {},
) =>
  call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.mail.draftSend, { draftId }),
    { baseVersion, ...extra },
    signed,
  );

const reasonOf = (response: { json(): unknown }) =>
  errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.reason;

beforeAll(async () => {
  harness = await createIntegrationHarness();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  const [org] = await harness.db.select({ id: organizations.id }).from(organizations).limit(1);
  organizationId = org?.id ?? '';
});

afterAll(async () => {
  await harness?.close();
});

describe('otorisasi draf & kirim', () => {
  it('hak Baca tidak bisa membuat draf (403); draf orang lain → 404 termasuk Owner; akun pribadi orang lain → 404', async () => {
    const { account, identity } = await insertAccount();
    const reader = await signIn('cs');
    await grant(account.id, reader.user.id, 'read');
    const denied = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.drafts,
      { mode: 'new', identityId: identity.id },
      reader.signed,
    );
    expect(denied.statusCode).toBe(403);

    const writer = await signIn('cs');
    await grant(account.id, writer.user.id, 'send');
    const draft = await newDraft(writer.signed, identity.id);
    for (const other of [owner, reader.signed]) {
      expect(
        (
          await call(
            harness.app,
            'GET',
            apiPath(API_ROUTES.mail.draft, { draftId: draft.id }),
            undefined,
            other,
          )
        ).statusCode,
      ).toBe(404);
      expect((await send(other, draft.id, draft.version)).statusCode).toBe(404);
    }

    const personal = await insertAccount({ kind: 'personal', ownerUserId: writer.user.id });
    const ownerTry = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.drafts,
      { mode: 'new', identityId: personal.identity.id },
      owner,
    );
    expect(ownerTry.statusCode).toBe(404);
    const signatures = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.mail.accountSignatures, { accountId: personal.account.id }),
      undefined,
      owner,
    );
    expect(signatures.statusCode).toBe(404);
  });
});

describe('identitas & verifikasi', () => {
  it('alias akun bersama: butuh mail.accounts.manage (Kelola non-Admin 403) + konfirmasi identitas; alamat unik lintas akun/channel/pengirim sistem', async () => {
    const { account } = await insertAccount();
    const manager = await signIn('cs');
    await grant(account.id, manager.user.id, 'manage');
    const forbidden = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: account.id }),
      { address: 'tagihan@majujaya.test', displayName: 'Tim Tagihan' },
      manager.signed,
    );
    expect(forbidden.statusCode).toBe(403);
    const noConfirmation = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: account.id }),
      { address: 'tagihan@majujaya.test', displayName: 'Tim Tagihan' },
      owner,
    );
    expect(noConfirmation.statusCode).toBe(400);
    const created = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: account.id }),
      {
        address: 'Tagihan@MajuJaya.test',
        displayName: 'Tim Tagihan',
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(
      created.json<{ identity: { address: string; canSend: boolean } }>().identity,
    ).toMatchObject({
      address: 'tagihan@majujaya.test',
      canSend: false,
    });

    // Pembaca `cs@` bersama tidak bisa "meminjam" alamatnya lewat akun pribadi.
    const reader = await signIn('cs');
    await grant(account.id, reader.user.id, 'read');
    const personal = await insertAccount({ kind: 'personal', ownerUserId: reader.user.id });
    for (const address of [account.emailAddress, 'tagihan@majujaya.test']) {
      const borrow = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.account.id }),
        { address, displayName: 'Saya' },
        reader.signed,
      );
      expect(borrow.statusCode, borrow.body).toBe(409);
      expect(reasonOf(borrow)).toBe('address_in_use');
    }
    // Alamat Channel Email & Email pengirim sistem.
    await harness.db.insert(channels).values({
      organizationId,
      type: 'email',
      name: 'Email Inbox',
      emailAddress: 'halo@majujaya.test',
      emailFromName: 'Halo',
      emailImapHost: 'imap.majujaya.test',
      emailImapPort: 993,
      emailImapSecurity: 'ssl',
      emailImapUsername: 'halo@majujaya.test',
      emailImapPasswordEncrypted: 'v1.x.y',
      emailImapFolder: 'INBOX',
      emailPollIntervalMinutes: 5,
      emailMarkAsRead: false,
      emailSmtpMode: 'system',
    } as typeof channels.$inferInsert);
    await harness.db.insert(emailSettings).values({
      organizationId,
      fromName: 'Sistem',
      fromAddress: 'noreply@majujaya.test',
      host: 'smtp.sistem.test',
      port: 465,
      security: 'ssl',
    });
    for (const address of ['halo@majujaya.test', 'noreply@majujaya.test']) {
      const response = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.account.id }),
        { address, displayName: 'Saya' },
        reader.signed,
      );
      expect(response.statusCode, response.body).toBe(409);
    }
  });

  it('verifikasi: pengirim sistem belum ada / konflik → 409; kode salah (sisa percobaan), kedaluwarsa 410, benar → verified; batas kirim 3/identitas', async () => {
    const { account, identity } = await insertAccount({}, { verified: false });
    const start = () =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.identityVerification, { identityId: identity.id }),
        undefined,
        owner,
      );
    const missing = await start();
    expect(missing.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(missing.json()).error.details?.[0]).toMatchObject({
      reason: 'verification_unavailable',
      cause: 'system_sender_missing',
    });
    // Kotak surat SMTP sistem = kotak surat akun ini → terkunci (+ peringatan di respons akun).
    await harness.db.insert(emailSettings).values({
      organizationId,
      fromName: 'Sistem',
      fromAddress: 'noreply@majujaya.test',
      host: 'mail.majujaya.test',
      port: 465,
      security: 'ssl',
      username: account.imapUsername,
      passwordEncrypted: 'v1.x.y',
    });
    const conflict = await start();
    expect(errorEnvelopeSchema.parse(conflict.json()).error.details?.[0]?.cause).toBe(
      'system_sender_conflict',
    );
    const view = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.mail.account, { accountId: account.id }),
      undefined,
      owner,
    );
    expect(view.json<{ account: { warnings: string[] } }>().account.warnings).toContain(
      'system_sender_conflict',
    );

    await harness.db
      .update(emailSettings)
      .set({ host: 'smtp.sistem.test', username: null, passwordEncrypted: null })
      .where(eq(emailSettings.organizationId, organizationId));
    const started = await start();
    expect(started.statusCode, started.body).toBe(202);
    const [pending] = await harness.db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, identity.id));
    expect(pending?.verificationState).toBe('pending');
    expect(pending?.verificationSecretEncrypted).not.toBeNull();
    expect(JSON.stringify(started.json())).not.toMatch(/\d{6}/);
    // Kode diketahui tes: hash diganti dengan HMAC kode tes (kunci sama dengan api).
    await harness.db
      .update(mailIdentities)
      .set({ verificationCodeHash: keys.hashVerificationCode(identity.id, '482913') })
      .where(eq(mailIdentities.id, identity.id));
    const confirm = (code: string) =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.identityVerificationConfirm, { identityId: identity.id }),
        { code },
        owner,
      );
    const wrong = await confirm('000000');
    expect(wrong.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(wrong.json()).error.details?.[0]).toMatchObject({
      reason: 'verification_code_invalid',
      attemptsLeft: 4,
    });
    const ok = await confirm('482913');
    expect(ok.statusCode, ok.body).toBe(200);
    const [verified] = await harness.db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, identity.id));
    expect(verified).toMatchObject({
      verificationState: 'verified',
      verifiedMethod: 'code',
      verificationSecretEncrypted: null,
    });
    expect((await start()).statusCode).toBe(409); // already_verified

    // Kedaluwarsa → 410; batas kirim 3/identitas/24 jam → 429.
    const other = await insertAccount({}, { verified: false });
    const startOther = () =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.identityVerification, { identityId: other.identity.id }),
        undefined,
        owner,
      );
    expect((await startOther()).statusCode).toBe(202);
    await harness.db
      .update(mailIdentities)
      .set({ verificationExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mailIdentities.id, other.identity.id));
    const expired = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityVerificationConfirm, { identityId: other.identity.id }),
      { code: '123456' },
      owner,
    );
    expect(expired.statusCode).toBe(410);
    expect((await startOther()).statusCode).toBe(202);
    expect((await startOther()).statusCode).toBe(202);
    const limited = await startOther();
    expect(limited.statusCode).toBe(429);
    expect(reasonOf(limited)).toBe('verification_send_limit');
  });
});

describe('simpan otomatis', () => {
  it('konflik versi 409 + force; subjek ber-CRLF/U+2028 → 400; HTML dibersihkan profil editor', async () => {
    const { identity } = await insertAccount();
    const draft = await newDraft(owner, identity.id);
    const put = (body: Record<string, unknown>) =>
      call(harness.app, 'PUT', apiPath(API_ROUTES.mail.draft, { draftId: draft.id }), body, owner);
    const saved = await put({
      baseVersion: draft.version,
      bodyHtml:
        '<p onclick="x()">Halo<script>alert(1)</script><img src="https://pelacak.test/p.gif"></p>',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const result = saved.json<{
      draft: { version: number };
      sanitized?: boolean;
      bodyHtml?: string;
    }>();
    expect(result.sanitized).toBe(true);
    expect(result.bodyHtml).toBe('<p>Halo</p>');
    const stale = await put({ baseVersion: draft.version, subject: 'Lama' });
    expect(stale.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(stale.json()).error.details?.[0]).toMatchObject({
      reason: 'draft_version_conflict',
      currentVersion: result.draft.version,
    });
    expect(
      (await put({ baseVersion: draft.version, subject: 'Timpa', force: true })).statusCode,
    ).toBe(200);
    for (const subject of ['Halo\r\nBcc: korban@luar.test', 'Halo Bcc', 'Tagihan‮txt.exe']) {
      const bad = await put({ baseVersion: 1, force: true, subject });
      expect(bad.statusCode).toBe(400);
      expect(reasonOf(bad)).toBe('subject_invalid');
    }
  });
});

describe('kirim', () => {
  it('identitas belum terverifikasi → 409; versi basi 409; klik ganda bersamaan → satu outbox (duplicate)', async () => {
    const unverified = await insertAccount({}, { verified: false });
    const draft1 = await newDraft(owner, unverified.identity.id);
    const refused = await send(owner, draft1.id, draft1.version);
    expect(refused.statusCode).toBe(409);
    expect(reasonOf(refused)).toBe('identity_unverified');

    const { identity } = await insertAccount();
    const draft = await newDraft(owner, identity.id);
    expect((await send(owner, draft.id, draft.version + 1)).statusCode).toBe(409);
    const [a, b] = await Promise.all([
      send(owner, draft.id, draft.version),
      send(owner, draft.id, draft.version),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 202]);
    const outboxIds = new Set(
      [a, b].map((response) => mailOutboxResponseSchema.parse(response.json()).outbox.id),
    );
    expect(outboxIds.size).toBe(1);
    const rows = await harness.db.select().from(mailOutbox).where(eq(mailOutbox.draftId, draft.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    // Draf terkunci selama ada outbox aktif.
    const locked = await call(
      harness.app,
      'PUT',
      apiPath(API_ROUTES.mail.draft, { draftId: draft.id }),
      { baseVersion: draft.version, subject: 'x' },
      owner,
    );
    expect(reasonOf(locked)).toBe('draft_locked');
  });

  it('email baru di utas → 409 thread_has_new_messages, lalu Tetap kirim dengan acknowledgeNewMessagesUntil', async () => {
    const { account, identity, inbox } = await insertAccount();
    const source = await insertMessage(account.id, inbox.id);
    await harness.db.insert(mailMessageBodies).values({
      messageId: source.id,
      organizationId,
      text: 'Mohon info upgrade.',
      htmlSanitized:
        '<style>p{color:red}</style><p>Mohon info <img src="balesin-remote:0" alt="logo"> upgrade.</p>',
    });
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.drafts,
      { mode: 'reply', sourceMessageId: source.id },
      owner,
    );
    expect(created.statusCode, created.body).toBe(201);
    const draft = createMailDraftResponseSchema.parse(created.json()).draft;
    expect(draft).toMatchObject({
      identityId: identity.id,
      subject: 'Re: Permintaan upgrade paket',
    });
    expect(draft.to).toEqual([{ address: 'rina@pelanggan.test', name: 'Rina Wulandari' }]);
    expect(draft.threadKey).toBe(keys.threadKey(account.id, source.threadRoot ?? ''));
    const newer = await insertMessage(account.id, inbox.id, {
      threadRoot: source.threadRoot,
      references: [source.messageIdHeader ?? ''],
      receivedAt: new Date(Date.now() + 5_000),
    });
    const blocked = await send(owner, draft.id, draft.version);
    expect(blocked.statusCode).toBe(409);
    const detail = errorEnvelopeSchema.parse(blocked.json()).error.details?.[0];
    expect(detail).toMatchObject({ reason: 'thread_has_new_messages', count: 1 });
    expect(detail?.messageIds).toContain(newer.id);
    const forced = await send(owner, draft.id, draft.version, {
      acknowledgeNewMessagesUntil: detail?.latestReceivedAt,
    });
    expect(forced.statusCode, forced.body).toBe(202);
    const [row] = await harness.db
      .select()
      .from(mailOutbox)
      .where(eq(mailOutbox.draftId, draft.id));
    expect(row?.inReplyTo).toBe(source.messageIdHeader);
    expect(row?.references).toEqual([source.messageIdHeader]);
    expect(row?.html).toContain('menulis:');
    // Kutipan: gambar dibuang (teks alt), gaya email asli tidak ikut.
    expect(row?.html).toContain('[logo]');
    expect(row?.html).not.toMatch(/balesin-remote|color:red/);
  });

  it('batas penerima, jatah alamat baru diambil & dikembalikan saat batal, rem darurat 423', async () => {
    const { account, identity } = await insertAccount();
    await harness.db
      .insert(mailCorrespondents)
      .values({ organizationId, accountId: account.id, address: 'kenal@pelanggan.test' });
    const draft = await newDraft(owner, identity.id, {
      to: [{ address: 'kenal@pelanggan.test' }, { address: 'baru1@pelanggan.test' }],
      cc: [{ address: 'baru2@pelanggan.test' }],
    });
    const check = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.draftCheck, { draftId: draft.id }),
      undefined,
      owner,
    );
    const before = mailDraftCheckResponseSchema.parse(check.json()).checks;
    expect(before.newAddressCount).toBe(2);
    const sentResponse = await send(owner, draft.id, draft.version);
    expect(sentResponse.statusCode, sentResponse.body).toBe(202);
    const outbox = mailOutboxResponseSchema.parse(sentResponse.json()).outbox;
    const afterSend = mailDraftCheckResponseSchema.parse(
      (
        await call(
          harness.app,
          'POST',
          apiPath(API_ROUTES.mail.draftCheck, { draftId: draft.id }),
          undefined,
          owner,
        )
      ).json(),
    ).checks;
    expect(afterSend.newAddressQuota.remaining).toBe(before.newAddressQuota.remaining - 2);
    const canceled = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.outboxCancel, { outboxId: outbox.id }),
      undefined,
      owner,
    );
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<{ draftId: string }>().draftId).toBe(draft.id);
    const afterCancel = mailDraftCheckResponseSchema.parse(
      (
        await call(
          harness.app,
          'POST',
          apiPath(API_ROUTES.mail.draftCheck, { draftId: draft.id }),
          undefined,
          owner,
        )
      ).json(),
    ).checks;
    expect(afterCancel.newAddressQuota.remaining).toBe(before.newAddressQuota.remaining);
    // Sudah sending → tidak bisa dibatalkan.
    const again = await send(owner, draft.id, draft.version);
    const second = mailOutboxResponseSchema.parse(again.json()).outbox;
    await harness.db
      .update(mailOutbox)
      .set({ status: 'sending' })
      .where(eq(mailOutbox.id, second.id));
    const late = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.outboxCancel, { outboxId: second.id }),
      undefined,
      owner,
    );
    expect(late.statusCode).toBe(409);
    expect(reasonOf(late)).toBe('not_cancelable');

    // Batas penerima (setelan organisasi 2).
    const many = await newDraft(owner, identity.id, {
      to: [
        { address: 'a@pelanggan.test' },
        { address: 'b@pelanggan.test' },
        { address: 'c@pelanggan.test' },
      ],
    });
    await harness.db.execute(
      `insert into mail_settings (organization_id, max_recipients_per_email) values ('${organizationId}', 2) on conflict (organization_id) do update set max_recipients_per_email = 2` as never,
    );
    const tooMany = await send(owner, many.id, many.version);
    expect(tooMany.statusCode).toBe(400);
    expect(reasonOf(tooMany)).toBe('too_many_recipients');
    // Rem darurat.
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    const small = await newDraft(owner, identity.id);
    expect((await send(owner, small.id, small.version)).statusCode).toBe(423);
  });
});

describe('lampiran draf', () => {
  function multipart(filename: string, bytes: Buffer) {
    const boundary = `----balesin${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it('jenis dari ISI: exe/zip/SVG/HTML bernama .pdf ditolak; PDF diterima; inline hanya gambar raster', async () => {
    const { identity } = await insertAccount();
    const draft = await newDraft(owner, identity.id);
    const upload = (filename: string, bytes: Buffer, inline = false) => {
      const { payload, contentType } = multipart(filename, bytes);
      return harness.app.inject({
        method: 'POST',
        url: `${apiPath(API_ROUTES.mail.draftAttachments, { draftId: draft.id })}${inline ? '?inline=1' : ''}`,
        headers: {
          cookie: owner.cookie,
          origin: TEST_APP_ORIGIN,
          'x-csrf-token': owner.csrf,
          'content-type': contentType,
        },
        payload,
      });
    };
    for (const bytes of [
      Buffer.from('MZ\x90\x00program'),
      Buffer.from('PK\x03\x04arsip-zip-biasa'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from('<!doctype html><html><script>alert(1)</script></html>'),
    ]) {
      const response = await upload('faktur.pdf', bytes);
      expect(response.statusCode, response.body).toBe(400);
      expect(reasonOf(response)).toBe('attachment_type_blocked');
    }
    const pdf = await upload('Penawaran.pdf', Buffer.from('%PDF-1.4 isi penawaran'));
    expect(pdf.statusCode, pdf.body).toBe(201);
    const notRaster = await upload('Penawaran.pdf', Buffer.from('%PDF-1.4 isi'), true);
    expect(notRaster.statusCode).toBe(400);
  });
});

describe('saran penerima', () => {
  it('tidak membocorkan korespondensi akun pribadi orang lain', async () => {
    const other = await signIn('cs');
    const personal = await insertAccount({ kind: 'personal', ownerUserId: other.user.id });
    await harness.db
      .insert(mailCorrespondents)
      .values({ organizationId, accountId: personal.account.id, address: 'rahasia@pribadi.test' });
    const shared = await insertAccount();
    await harness.db.insert(mailCorrespondents).values({
      organizationId,
      accountId: shared.account.id,
      address: 'rahasia-bersama@kantor.test',
    });
    const ask = async (signed: SignedIn) =>
      mailRecipientSuggestResponseSchema
        .parse(
          (
            await call(
              harness.app,
              'GET',
              `${API_ROUTES.mail.recipientSuggest}?q=rahasia`,
              undefined,
              signed,
            )
          ).json(),
        )
        .suggestions.map((item) => item.address);
    expect(await ask(owner)).toEqual(['rahasia-bersama@kantor.test']);
    expect(await ask(other.signed)).toEqual(['rahasia@pribadi.test']);
  });
});

describe('pengaturan batas', () => {
  it('menaikkan maxRecipientsPerEmail butuh konfirmasi identitas; menurunkan tidak', async () => {
    const put = (body: Record<string, unknown>) =>
      call(
        harness.app,
        'PUT',
        API_ROUTES.mail.settings,
        { cacheRetentionDays: 90, defaultSyncWindowDays: 90, ...body },
        owner,
      );
    expect((await put({ maxRecipientsPerEmail: 20 })).statusCode).toBe(200);
    const raise = await put({ maxRecipientsPerEmail: 80 });
    expect(raise.statusCode).toBe(400);
    expect(
      (await put({ maxRecipientsPerEmail: 80, confirmation: await confirmationOf(owner) }))
        .statusCode,
    ).toBe(200);
  });
});
