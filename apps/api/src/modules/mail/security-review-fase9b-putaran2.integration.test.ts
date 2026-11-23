/**
 * Review keamanan tahap 9B putaran 2 (docs/security-reviews/2026-11-23-fase9b.md §Putaran 2) — tes
 * PENGUNCI temuan baru dari mekanisme persetujuan S3. Setiap `it.fails` menegaskan perilaku AMAN yang
 * BELUM dipenuhi kode; saat temuannya diperbaiki, ubah menjadi `it` (asersi jangan diubah).
 *
 * Model ancaman: satu akun CS dibobol (boleh menghubungkan akun pribadi, `mail.private.own`).
 */
import { randomBytes } from 'node:crypto';

import {
  emailSettings,
  mailAccounts,
  mailFolders,
  mailIdentities,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, mailIdentityResponseSchema, type UserRole } from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

const PASSWORD = 'sandi-uji-review-9b-p2';

let harness: IntegrationHarness;
let organizationId: string;

async function signIn(role: UserRole) {
  const hasher = createPasswordHasher();
  const user = await insertUser(harness.db, organizationId, {
    role,
    name: `Pengguna ${role}`,
    email: `${role}-${randomBytes(4).toString('hex')}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { user, signed: await login(harness.app, { email: user.email, password: PASSWORD }) };
}

async function insertAccount(overrides: Partial<typeof mailAccounts.$inferInsert> = {}) {
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
  await harness.db.insert(mailIdentities).values({
    organizationId,
    accountId: row.id,
    address,
    displayName: 'Tim CS',
    isPrimary: true,
    verificationState: 'verified',
    verifiedAt: new Date(),
    verifiedMethod: 'code',
  });
  await harness.db.insert(mailFolders).values({
    organizationId,
    accountId: row.id,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    roleSource: 'special_use',
  });
  return row;
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
  await completeSetup(harness.app);
  const [org] = await harness.db.select({ id: organizations.id }).from(organizations).limit(1);
  organizationId = org?.id ?? '';
});

afterAll(async () => {
  await harness?.close();
});

describe('P2-S1 (Sedang) — banjir email "menunggu persetujuan" lewat tambah-hapus alias pribadi', () => {
  it('6× tambah lalu hapus alias pribadi berdomain organisasi → Owner menerima ≤ 3 email persetujuan', async () => {
    // Domain organisasi: akun bersama @majujaya.test + Email pengirim sistem.
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
    const personal = await insertAccount({
      kind: 'personal',
      ownerUserId: cs.user.id,
      emailAddress: `budi-${randomBytes(3).toString('hex')}@pribadi.test`,
      imapHost: 'imap.pribadi.test',
      smtpHost: 'smtp.pribadi.test',
    });
    for (let round = 0; round < 6; round += 1) {
      const created = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.mail.accountIdentities, { accountId: personal.id }),
        { address: `tagihan${String(round)}@majujaya.test`, displayName: 'Tim Tagihan' },
        cs.signed,
      );
      expect(created.statusCode, created.body).toBe(201);
      const identity = mailIdentityResponseSchema.parse(created.json()).identity;
      expect(identity.approval.state).toBe('pending');
      const removed = await call(
        harness.app,
        'DELETE',
        apiPath(API_ROUTES.mail.identity, { identityId: identity.id }),
        undefined,
        cs.signed,
      );
      expect(removed.statusCode, removed.body).toBeLessThan(300);
    }
    const notices = harness.adminNotices.filter(
      (notice) => notice.event === 'mail_identity_approval_requested',
    );
    // Setiap putaran = 1 email per Owner/Admin lewat Email pengirim SISTEM, hanya dibatasi
    // `mail-tulis` 60/menit → ±30 email/menit/Owner/Admin: kuota SMTP pengirim sistem habis
    // (tautan reset password, undangan, kode verifikasi gagal terkirim) dan kotak masuk Owner
    // dibanjiri sehingga pemberitahuan keamanan lain tenggelam.
    expect(notices.length).toBeLessThanOrEqual(3);
  });
});
