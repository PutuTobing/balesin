/**
 * Perbaikan review keamanan 9B (docs/security-reviews/2026-11-23-fase9b.md) — perilaku baru di luar
 * tes pengunci:
 *  - S3: identitas akun PRIBADI berdomain organisasi menunggu persetujuan Owner/Admin (daftar,
 *    setujui/tolak + konfirmasi identitas, audit, hak akses).
 *  - S4: pemegang KUAT (alias pribadi terverifikasi) tetap menghalangi, dengan 409 yang menyebut
 *    pemiliknya; klaim lemah dicabut + audit.
 *  - S2 dua arah: kotak surat Email pengirim sistem ↔ akun Email ditolak 409 `system_sender_mailbox`.
 */
import { randomBytes } from 'node:crypto';

import {
  auditLogs,
  emailSettings,
  mailAccounts,
  mailFolders,
  mailIdentities,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  mailIdentityApprovalListResponseSchema,
  mailIdentityResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  mailpitSettings,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

const PASSWORD = 'sandi-uji-persetujuan-9b';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;

async function signIn(role: UserRole, name = `Pengguna ${role}`) {
  const hasher = createPasswordHasher();
  const user = await insertUser(harness.db, organizationId, {
    role,
    name,
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
  const [identity] = await harness.db
    .insert(mailIdentities)
    .values({
      organizationId,
      accountId: row.id,
      address,
      displayName: 'Tim CS',
      isPrimary: true,
      ...(options.verified === false
        ? {}
        : { verificationState: 'verified', verifiedAt: new Date(), verifiedMethod: 'code' }),
    })
    .returning();
  if (!identity) throw new Error('identitas');
  await harness.db.insert(mailFolders).values({
    organizationId,
    accountId: row.id,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    roleSource: 'special_use',
  });
  return { account: row, identity };
}

const personalOf = (userId: string) =>
  insertAccount({
    kind: 'personal',
    ownerUserId: userId,
    emailAddress: `budi-${randomBytes(3).toString('hex')}@pribadi.test`,
    imapHost: 'imap.pribadi.test',
    smtpHost: 'smtp.pribadi.test',
  });

const errorOf = (response: { json(): unknown }) => errorEnvelopeSchema.parse(response.json()).error;

async function systemSender(fromAddress = 'noreply@majujaya.test') {
  await harness.db.insert(emailSettings).values({
    organizationId,
    fromName: 'Sistem',
    fromAddress,
    host: 'smtp.sistem.test',
    port: 465,
    security: 'ssl',
  });
}

async function actions() {
  return (
    await harness.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, organizationId))
  ).map((row) => row.action);
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
  });
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

describe('S3 — persetujuan alamat akun pribadi berdomain organisasi', () => {
  it('alias pribadi @domain-organisasi menunggu persetujuan; hanya Owner/Admin (+ konfirmasi) yang memutuskan', async () => {
    await insertAccount();
    await systemSender();
    const cs = await signIn('cs', 'Budi CS');
    const personal = await personalOf(cs.user.id);
    const created = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.account.id }),
      { address: 'tagihan@majujaya.test', displayName: 'Tim Tagihan' },
      cs.signed,
    );
    expect(created.statusCode, created.body).toBe(201);
    const identity = mailIdentityResponseSchema.parse(created.json()).identity;
    expect(identity.approval.state).toBe('pending');
    expect(identity.verification).toMatchObject({
      state: 'unverified',
      available: false,
      unavailableReason: 'approval_pending',
    });
    expect(identity.cannotSendReason).toBe('identity_not_approved');
    expect(await actions()).toContain('mail.identity.approval_requested');

    // Verifikasi belum bisa dimulai.
    const start = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityVerification, { identityId: identity.id }),
      undefined,
      cs.signed,
    );
    expect(start.statusCode, start.body).toBe(409);
    expect(errorOf(start).details?.[0]).toMatchObject({
      reason: 'verification_unavailable',
      cause: 'approval_pending',
    });

    // CS tidak bisa melihat daftar maupun memutuskan.
    const listByCs = await call(
      harness.app,
      'GET',
      API_ROUTES.mail.identityApprovals,
      undefined,
      cs.signed,
    );
    expect(listByCs.statusCode).toBe(403);
    const decideByCs = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityApproval, { identityId: identity.id }),
      { decision: 'approve' },
      cs.signed,
    );
    expect(decideByCs.statusCode).toBe(403);

    const list = await call(
      harness.app,
      'GET',
      API_ROUTES.mail.identityApprovals,
      undefined,
      owner,
    );
    expect(list.statusCode, list.body).toBe(200);
    const approvals = mailIdentityApprovalListResponseSchema.parse(list.json()).approvals;
    expect(approvals).toEqual([
      expect.objectContaining({
        identityId: identity.id,
        address: 'tagihan@majujaya.test',
        owner: { id: cs.user.id, name: 'Budi CS' },
      }),
    ]);

    // Tanpa konfirmasi identitas → 400.
    const unconfirmed = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityApproval, { identityId: identity.id }),
      { decision: 'approve' },
      owner,
    );
    expect(unconfirmed.statusCode).toBe(400);
    const approved = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityApproval, { identityId: identity.id }),
      { decision: 'approve', confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(mailIdentityResponseSchema.parse(approved.json()).identity.approval.state).toBe(
      'approved',
    );
    expect(await actions()).toContain('mail.identity.approved');

    // Kini verifikasi boleh dimulai.
    const restart = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityVerification, { identityId: identity.id }),
      undefined,
      cs.signed,
    );
    expect(restart.statusCode, restart.body).toBe(202);
  });

  it('ditolak → `rejected`, verifikasi direset, kirim tetap tidak bisa; identitas domain luar tidak perlu persetujuan (404)', async () => {
    await insertAccount();
    await systemSender();
    const cs = await signIn('cs');
    const personal = await personalOf(cs.user.id);
    const [alias] = await harness.db
      .insert(mailIdentities)
      .values({
        organizationId,
        accountId: personal.account.id,
        address: 'info@majujaya.test',
        displayName: 'Info',
        verificationState: 'verified',
        verifiedAt: new Date(),
        verifiedMethod: 'code',
        createdByUserId: cs.user.id,
      })
      .returning();
    if (!alias) throw new Error('alias');
    const rejected = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityApproval, { identityId: alias.id }),
      { decision: 'reject', confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    const view = mailIdentityResponseSchema.parse(rejected.json()).identity;
    expect(view.approval.state).toBe('rejected');
    expect(view.verification.state).toBe('unverified');
    expect(view.verification.unavailableReason).toBe('approval_rejected');
    expect(await actions()).toContain('mail.identity.rejected');

    // Identitas utama akun pribadi @pribadi.test (bukan domain organisasi) → tidak terbuka.
    const outside = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.identityApproval, { identityId: personal.identity.id }),
      { decision: 'approve', confirmation: await confirmationOf(owner) },
      owner,
    );
    expect(outside.statusCode).toBe(404);
  });
});

describe('S4 — prioritas organisasi atas alamat', () => {
  it('alias pribadi TERVERIFIKASI (domain luar) tetap menghalangi; 409 menyebut pemiliknya ke Owner', async () => {
    const shared = await insertAccount();
    const cs = await signIn('cs', 'Sari Pribadi');
    const personal = await personalOf(cs.user.id);
    await harness.db.insert(mailIdentities).values({
      organizationId,
      accountId: personal.account.id,
      address: 'halo@luar.test',
      displayName: 'Halo',
      verificationState: 'verified',
      verifiedAt: new Date(),
      verifiedMethod: 'code',
      createdByUserId: cs.user.id,
    });
    const claim = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: shared.account.id }),
      {
        address: 'halo@luar.test',
        displayName: 'Halo',
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(claim.statusCode, claim.body).toBe(409);
    const detail = errorOf(claim).details?.[0];
    expect(detail).toMatchObject({ reason: 'address_in_use', cause: 'personal_identity' });
    expect(detail?.message).toContain('Sari Pribadi');
  });

  it('alias pribadi yang BELUM terverifikasi dicabut saat Owner memakai alamatnya (audit `mail.identity.revoked`)', async () => {
    const shared = await insertAccount();
    const cs = await signIn('cs');
    const personal = await personalOf(cs.user.id);
    const [squat] = await harness.db
      .insert(mailIdentities)
      .values({
        organizationId,
        accountId: personal.account.id,
        address: 'tagihan@majujaya.test',
        displayName: 'Tagihan',
        createdByUserId: cs.user.id,
      })
      .returning();
    if (!squat) throw new Error('alias');
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
    const left = await harness.db
      .select({ id: mailIdentities.id })
      .from(mailIdentities)
      .where(eq(mailIdentities.id, squat.id));
    expect(left).toHaveLength(0);
    expect(await actions()).toContain('mail.identity.revoked');
  });
});

describe('S2 — kotak surat Email pengirim sistem ↔ akun Email (dua arah)', () => {
  it('akun Email dengan alamat Email pengirim sistem ditolak 409 `system_sender_mailbox`', async () => {
    await systemSender('kotak@majujaya.test');
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.accounts,
      {
        kind: 'personal',
        provider: 'cpanel',
        displayName: 'Kotak',
        emailAddress: 'kotak@majujaya.test',
        fromName: 'Kotak',
        color: 'tagBlue',
        imap: {
          host: 'imap.majujaya.test',
          port: 993,
          security: 'ssl',
          username: 'kotak@majujaya.test',
          password: 'rahasia',
        },
        smtp: { host: 'imap.majujaya.test', port: 465, security: 'ssl', sameCredentials: true },
      },
      owner,
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).details?.[0]?.reason).toBe('system_sender_mailbox');
  });

  it('Email pengirim sistem tidak bisa diarahkan ke kotak surat akun Email (409 `system_sender_mailbox`)', async () => {
    const shared = await insertAccount();
    const response = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      {
        ...mailpitSettings({ fromAddress: shared.account.emailAddress }),
        confirmation: await confirmationOf(owner),
      },
      owner,
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).details?.[0]?.reason).toBe('system_sender_mailbox');
  });

  it('konflik lama di data → verifikasi SEMUA identitas organisasi terkunci (`system_sender_conflict`)', async () => {
    const shared = await insertAccount();
    await systemSender(shared.account.emailAddress);
    const other = await insertAccount({}, { verified: false });
    const view = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.mail.accountIdentities, { accountId: other.account.id }),
      undefined,
      owner,
    );
    expect(view.statusCode, view.body).toBe(200);
    expect(
      view.json<{ identities: { verification: { unavailableReason: string | null } }[] }>()
        .identities[0]?.verification.unavailableReason,
    ).toBe('system_sender_conflict');
  });
});
