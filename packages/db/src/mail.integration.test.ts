import { eq, type Column } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, type Database } from './client';
import { PG_ERROR_CODES } from './errors';
import { accessibleMailAccountsOf, mailAccessIndexOf } from './mail-access';
import {
  departmentMembers,
  departments,
  mailAccountAccess,
  mailAccounts,
  mailFolders,
  mailMessages,
  type NewMailAccountRow,
} from './schema';
import { insertOrganization, insertUser, pgErrorOf, uniqueSuffix } from './testing';

/**
 * Skema modul Email (migrasi 0036): isolasi tenant lewat FK komposit, aturan akun pribadi/bersama,
 * alamat unik selama hidup, principal tepat satu, dan pemuat hak `resolveMailAccess`.
 */

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test' });
});

afterAll(async () => {
  await closeDb(db);
});

function account(
  organizationId: string,
  overrides: Partial<NewMailAccountRow> = {},
): NewMailAccountRow {
  return {
    organizationId,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: `cs-${uniqueSuffix()}@contoh.test`,
    fromName: 'Tim CS',
    color: 'tagBlue',
    imapHost: 'mail.contoh.test',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'cs',
    imapPasswordEncrypted: 'v1.x.y',
    smtpHost: 'mail.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    ...overrides,
  };
}

describe('skema mail_*', () => {
  it('akun pribadi wajib pemilik; akun bersama tanpa pemilik', async () => {
    const org = await insertOrganization(db);
    const owner = await insertUser(db, org.id);
    expect(
      (await pgErrorOf(db.insert(mailAccounts).values(account(org.id, { kind: 'personal' }))))
        .constraint,
    ).toBe('mail_accounts_owner');
    expect(
      (await pgErrorOf(db.insert(mailAccounts).values(account(org.id, { ownerUserId: owner.id }))))
        .constraint,
    ).toBe('mail_accounts_owner');
  });

  it('pemilik dari organisasi lain ditolak (FK komposit)', async () => {
    const orgA = await insertOrganization(db);
    const orgB = await insertOrganization(db);
    const foreign = await insertUser(db, orgB.id);
    const error = await pgErrorOf(
      db
        .insert(mailAccounts)
        .values(account(orgA.id, { kind: 'personal', ownerUserId: foreign.id })),
    );
    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });

  it('alamat unik per organisasi selama akun hidup; bisa dipakai lagi setelah diputus', async () => {
    const org = await insertOrganization(db);
    const address = `billing-${uniqueSuffix()}@contoh.test`;
    const [first] = await db
      .insert(mailAccounts)
      .values(account(org.id, { emailAddress: address }))
      .returning();
    expect(
      (await pgErrorOf(db.insert(mailAccounts).values(account(org.id, { emailAddress: address }))))
        .code,
    ).toBe(PG_ERROR_CODES.uniqueViolation);
    await db
      .update(mailAccounts)
      .set({ deletedAt: new Date(), syncState: 'deleting', imapPasswordEncrypted: null })
      .where(eqId(first?.id));
    await db.insert(mailAccounts).values(account(org.id, { emailAddress: address }));
  });

  it('akun hidup wajib server lengkap; TLS saja; alamat huruf kecil', async () => {
    const org = await insertOrganization(db);
    expect(
      (
        await pgErrorOf(
          db.insert(mailAccounts).values(account(org.id, { imapPasswordEncrypted: null })),
        )
      ).constraint,
    ).toBe('mail_accounts_live_complete');
    expect(
      (await pgErrorOf(db.insert(mailAccounts).values(account(org.id, { smtpSecurity: 'none' }))))
        .constraint,
    ).toBe('mail_accounts_servers');
    expect(
      (
        await pgErrorOf(
          db.insert(mailAccounts).values(account(org.id, { emailAddress: 'CS@Contoh.test' })),
        )
      ).constraint,
    ).toBe('mail_accounts_text_lengths');
  });

  it('grant tepat satu principal; folder & pesan tidak bisa merujuk akun organisasi lain', async () => {
    const orgA = await insertOrganization(db);
    const orgB = await insertOrganization(db);
    const userA = await insertUser(db, orgA.id);
    const [shared] = await db.insert(mailAccounts).values(account(orgA.id)).returning();
    if (!shared) throw new Error('akun');
    expect(
      (
        await pgErrorOf(
          db.insert(mailAccountAccess).values({
            organizationId: orgA.id,
            accountId: shared.id,
            principalType: 'user',
            level: 'read',
          }),
        )
      ).constraint,
    ).toBe('mail_account_access_principal');
    expect(
      (
        await pgErrorOf(
          db.insert(mailFolders).values({
            organizationId: orgB.id,
            accountId: shared.id,
            path: 'INBOX',
            name: 'Kotak masuk',
          }),
        )
      ).code,
    ).toBe(PG_ERROR_CODES.foreignKeyViolation);
    await db.insert(mailAccountAccess).values({
      organizationId: orgA.id,
      accountId: shared.id,
      principalType: 'user',
      userId: userA.id,
      level: 'read',
    });
    // Grant ganda untuk pengguna yang sama ditolak.
    expect(
      (
        await pgErrorOf(
          db.insert(mailAccountAccess).values({
            organizationId: orgA.id,
            accountId: shared.id,
            principalType: 'user',
            userId: userA.id,
            level: 'send',
          }),
        )
      ).code,
    ).toBe(PG_ERROR_CODES.uniqueViolation);
  });

  it('hapus akun = cascade folder & pesan', async () => {
    const org = await insertOrganization(db);
    const [row] = await db.insert(mailAccounts).values(account(org.id)).returning();
    if (!row) throw new Error('akun');
    const [folder] = await db
      .insert(mailFolders)
      .values({
        organizationId: org.id,
        accountId: row.id,
        path: 'INBOX',
        name: 'Kotak masuk',
        role: 'inbox',
        roleSource: 'special_use',
      })
      .returning();
    if (!folder) throw new Error('folder');
    await db.insert(mailMessages).values({
      organizationId: org.id,
      accountId: row.id,
      folderId: folder.id,
      uid: 1,
      uidvalidity: 1,
      receivedAt: new Date(),
    });
    await db.delete(mailAccounts).where(eqId(row.id));
    expect(
      await db.select().from(mailMessages).where(eqOrg(mailMessages.organizationId, org.id)),
    ).toEqual([]);
  });

  it('pemuat hak: pribadi orang lain tidak pernah terbuka, departemen memberi hak, Owner semua bersama', async () => {
    const org = await insertOrganization(db);
    const ownerUser = await insertUser(db, org.id, { role: 'owner' });
    const cs = await insertUser(db, org.id, { role: 'cs' });
    const [dept] = await db
      .insert(departments)
      .values({ organizationId: org.id, name: `Billing ${uniqueSuffix()}` })
      .returning();
    if (!dept) throw new Error('departemen');
    await db
      .insert(departmentMembers)
      .values({ organizationId: org.id, departmentId: dept.id, userId: cs.id });
    const [shared] = await db.insert(mailAccounts).values(account(org.id)).returning();
    const [personal] = await db
      .insert(mailAccounts)
      .values(account(org.id, { kind: 'personal', ownerUserId: cs.id }))
      .returning();
    if (!shared || !personal) throw new Error('akun');
    await db.insert(mailAccountAccess).values({
      organizationId: org.id,
      accountId: shared.id,
      principalType: 'department',
      departmentId: dept.id,
      level: 'send',
    });
    const forOwner = await accessibleMailAccountsOf(db, org.id, ownerUser.id);
    expect(forOwner.get(shared.id)).toBe('manage');
    expect(forOwner.has(personal.id)).toBe(false);
    const forCs = await accessibleMailAccountsOf(db, org.id, cs.id);
    expect(forCs.get(shared.id)).toBe('send');
    expect(forCs.get(personal.id)).toBe('manage');
    const index = await mailAccessIndexOf(
      db,
      org.id,
      [ownerUser.id, cs.id],
      [shared.id, personal.id],
    );
    expect(index.levelOf(ownerUser.id, personal.id)).toBeNull();
    // Keluar departemen → hak hilang.
    await db.delete(departmentMembers).where(eqOrg(departmentMembers.userId, cs.id));
    expect((await accessibleMailAccountsOf(db, org.id, cs.id)).has(shared.id)).toBe(false);
  });
});

function eqId(id: string | undefined) {
  return eq(mailAccounts.id, id ?? '00000000-0000-4000-8000-000000000000');
}
function eqOrg(column: Column, value: string) {
  return eq(column, value);
}
