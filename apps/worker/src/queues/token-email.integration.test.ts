/**
 * Email bertoken (undangan, atur ulang password, verifikasi) dan pemberitahuan ke Owner/Admin —
 * Postgres + penangkap email (Mailpit) sungguhan. Worker membuka salinan token terenkripsi dari
 * baris tokennya, menyusun tautan dari APP_URL, mengirim, lalu MENGHAPUS salinan itu.
 */
import { randomBytes } from 'node:crypto';

import {
  accountTokenDeliveryContext,
  createSecretBox,
  EMAIL_JOBS,
  invitationDeliveryContext,
  Secret,
  sha256Hex,
  SMTP_PASSWORD_PURPOSE,
  type SecretBox,
} from '@balesin/core';
import {
  assertMailCatcherReachable,
  capturedMailFor,
  createLogCapture,
  TEST_MAIL,
  waitForCapturedMail,
  type LogCapture,
} from '@balesin/core/testing';
import {
  accountTokens,
  auditLogs,
  closeDb,
  createDb,
  emailSettings,
  organizationLogos,
  userInvitations,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser, uniqueSuffix } from '@balesin/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { processEmailJob, type EmailJobDeps } from './email';

const APP_URL = 'https://balesin.contoh.test';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let logs: LogCapture;
let db: Database;
let box: SecretBox;
let deps: EmailJobDeps;

beforeAll(async () => {
  await assertMailCatcherReachable();
  logs = createLogCapture();
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-token' });
  box = createSecretBox(new Secret(randomBytes(32)));
  deps = {
    appUrl: APP_URL,
    db,
    secretBox: box,
    fallback: null,
    allowedPorts: [25, 465, 587, 2525, TEST_MAIL.smtpPort],
    logger: logs.logger,
    timeouts: { totalMs: 8_000 },
  };
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
});

async function organizationWithEmail(options: { logo?: boolean; configure?: boolean } = {}) {
  const organization = await insertOrganization(db, {
    name: 'PT <Maju> Jaya',
    productName: 'Balesin Maju',
    brandColor: '#0b5394',
  });
  if (options.configure !== false) {
    await db.insert(emailSettings).values({
      organizationId: organization.id,
      fromName: 'Balesin Maju',
      fromAddress: 'cs@maju.test',
      replyTo: null,
      host: TEST_MAIL.host,
      port: TEST_MAIL.smtpPort,
      security: 'none',
      username: TEST_MAIL.username,
      passwordEncrypted: box.encrypt(TEST_MAIL.password, {
        organizationId: organization.id,
        purpose: SMTP_PASSWORD_PURPOSE,
      }),
      passwordTail: null,
    });
  }
  if (options.logo) {
    await db.insert(organizationLogos).values({
      organizationId: organization.id,
      contentType: 'image/png',
      data: PNG,
      byteSize: PNG.length,
      sha256: sha256Hex(PNG),
    });
  }
  const owner = await insertUser(db, organization.id, {
    role: 'owner',
    name: 'Rina <Owner>',
    email: `rina-${uniqueSuffix()}@maju.test`,
  });
  return { organization, owner };
}

async function seedInvitation(
  organizationId: string,
  inviterId: string,
  overrides: Partial<typeof userInvitations.$inferInsert> = {},
) {
  const token = randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const sendCount = overrides.sendCount ?? 1;
  const [row] = await db
    .insert(userInvitations)
    .values({
      id,
      organizationId,
      email: `undangan-${uniqueSuffix()}@contoh.test`,
      role: 'admin',
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
      deliveryStatus: 'queued',
      deliveryTokenEncrypted: box.encrypt(
        token,
        invitationDeliveryContext(organizationId, id, sendCount),
      ),
      invitedByUserId: inviterId,
      lastSentByUserId: inviterId,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('gagal');
  return { row, token };
}

const invitationJob = (organizationId: string, invitationId: string, sendCount = 1) => ({
  id: `undangan-${uniqueSuffix()}`,
  name: EMAIL_JOBS.invitation,
  data: { organizationId, invitationId, sendCount },
  attemptsMade: 0,
  opts: { attempts: 3 },
});

async function invitationRow(id: string) {
  const [row] = await db.select().from(userInvitations).where(eq(userInvitations.id, id));
  return row;
}

describe('email undangan', () => {
  it('terkirim bermerek: tautan dari APP_URL berisi token, logo inline, salinan token dihapus', async () => {
    const { organization, owner } = await organizationWithEmail({ logo: true });
    const { row, token } = await seedInvitation(organization.id, owner.id);

    const result = await processEmailJob(invitationJob(organization.id, row.id), deps);
    expect(result).toEqual({ status: 'sent' });

    const mail = await waitForCapturedMail(row.email);
    expect(mail.subject).toBe('Rina <Owner> mengundangmu ke PT <Maju> Jaya di Balesin Maju');
    expect(mail.text).toContain(`${APP_URL}/undangan#token=${token}`);
    expect(mail.text).toContain('sebagai Admin');
    expect(mail.text).toContain('verifikasi dua langkah');
    expect(mail.html).toContain(`href="${APP_URL}/undangan#token=${token}"`);
    expect(mail.html).toContain('Rina &lt;Owner&gt;');
    expect(mail.html).not.toContain('<Owner>');
    expect(mail.html).toContain('src="cid:logo@balesin"');

    const after = await invitationRow(row.id);
    expect(after).toMatchObject({ deliveryStatus: 'sent', deliveryTokenEncrypted: null });
    expect(after?.deliveredAt).toBeInstanceOf(Date);
    expect(logs.text()).not.toContain(token);
  }, 30_000);

  it('dilewati tanpa mengirim: token sudah diganti (kirim ulang), dibatalkan, kedaluwarsa', async () => {
    const { organization, owner } = await organizationWithEmail();
    const replaced = await seedInvitation(organization.id, owner.id, { sendCount: 2 });
    const revoked = await seedInvitation(organization.id, owner.id, {
      revokedAt: new Date(),
      revokedByUserId: owner.id,
    });
    const expired = await seedInvitation(organization.id, owner.id, {
      expiresAt: new Date(Date.now() - 1_000),
    });

    // Job untuk generasi token lama (send_count 1) tidak mengirim dan tidak menyentuh baris baru.
    expect(await processEmailJob(invitationJob(organization.id, replaced.row.id, 1), deps)).toEqual(
      {
        status: 'skipped',
        reason: 'no_longer_valid',
      },
    );
    expect((await invitationRow(replaced.row.id))?.deliveryTokenEncrypted).not.toBeNull();
    for (const { row } of [revoked, expired]) {
      expect(await processEmailJob(invitationJob(organization.id, row.id), deps)).toEqual({
        status: 'skipped',
        reason: 'no_longer_valid',
      });
      expect((await invitationRow(row.id))?.deliveryTokenEncrypted).toBeNull();
    }
    for (const { row } of [replaced, revoked, expired]) {
      expect(await capturedMailFor(row.email)).toEqual([]);
    }
  }, 30_000);

  it('organisasi lain tidak bisa memicu undangan milik organisasi ini', async () => {
    const { organization, owner } = await organizationWithEmail();
    const other = await organizationWithEmail();
    const { row } = await seedInvitation(organization.id, owner.id);
    expect(await processEmailJob(invitationJob(other.organization.id, row.id), deps)).toEqual({
      status: 'skipped',
      reason: 'no_longer_valid',
    });
    expect(await capturedMailFor(row.email)).toEqual([]);
  }, 30_000);

  it('email pengirim belum diatur saat diproses: dilewati, status `skipped`, salinan token dihapus', async () => {
    const { organization, owner } = await organizationWithEmail({ configure: false });
    const { row } = await seedInvitation(organization.id, owner.id);
    expect(await processEmailJob(invitationJob(organization.id, row.id), deps)).toEqual({
      status: 'skipped',
      reason: 'email_not_configured',
    });
    expect(await invitationRow(row.id)).toMatchObject({
      deliveryStatus: 'skipped',
      deliveryTokenEncrypted: null,
    });
  }, 30_000);

  it('gagal permanen (port tidak diizinkan): status `failed`, salinan token dihapus', async () => {
    const { organization, owner } = await organizationWithEmail();
    const { row } = await seedInvitation(organization.id, owner.id);
    const failed = await processEmailJob(invitationJob(organization.id, row.id), {
      ...deps,
      allowedPorts: [25],
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(await invitationRow(row.id)).toMatchObject({
      deliveryStatus: 'failed',
      deliveryTokenEncrypted: null,
    });
  }, 30_000);

  it('gagal sementara bukan percobaan terakhir: salinan token disimpan untuk diulang', async () => {
    const { organization, owner } = await organizationWithEmail();
    const { row } = await seedInvitation(organization.id, owner.id);
    // Server tidak menjawab (port tertutup) = kegagalan sementara.
    await db
      .update(emailSettings)
      .set({ host: '127.0.0.1', port: 2525 })
      .where(eq(emailSettings.organizationId, organization.id));
    const failed = await processEmailJob(invitationJob(organization.id, row.id), {
      ...deps,
      timeouts: { totalMs: 3_000, connectionMs: 1_000 },
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(await invitationRow(row.id)).toMatchObject({ deliveryStatus: 'queued' });
    expect((await invitationRow(row.id))?.deliveryTokenEncrypted).not.toBeNull();
  }, 30_000);

  it('master key berbeda (salinan tidak bisa dibuka): gagal permanen tanpa mengirim', async () => {
    const { organization, owner } = await organizationWithEmail();
    const { row } = await seedInvitation(organization.id, owner.id);
    const other = createSecretBox(new Secret(randomBytes(32)));
    // Password SMTP juga dibuka dengan kotak yang sama, jadi gagal sebelum mengirim.
    const failed = await processEmailJob(invitationJob(organization.id, row.id), {
      ...deps,
      secretBox: other,
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(await capturedMailFor(row.email)).toEqual([]);
  }, 30_000);
});

describe('tautan atur ulang password / verifikasi email', () => {
  async function seedToken(
    purpose: 'password_reset' | 'email_verification',
    options: { userEmail?: string; tokenEmail?: string } = {},
  ) {
    const { organization } = await organizationWithEmail();
    const email = options.userEmail ?? `budi-${uniqueSuffix()}@contoh.test`;
    const user = await insertUser(db, organization.id, { name: 'Budi', email, role: 'cs' });
    const token = randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    await db.insert(accountTokens).values({
      id,
      organizationId: organization.id,
      userId: user.id,
      purpose,
      tokenHash: sha256Hex(token),
      email: options.tokenEmail ?? email,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      deliveryTokenEncrypted: box.encrypt(token, accountTokenDeliveryContext(organization.id, id)),
      requestedIp: '203.0.113.5',
      requestedUserAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    });
    return { organization, user, token, id, email };
  }
  const tokenJob = (organizationId: string, tokenId: string) => ({
    id: `token-${uniqueSuffix()}`,
    name: EMAIL_JOBS.accountToken,
    data: { organizationId, tokenId },
  });

  it('atur ulang password: tautan APP_URL, asal permintaan, salinan dihapus', async () => {
    const { organization, token, id, email } = await seedToken('password_reset');
    expect(await processEmailJob(tokenJob(organization.id, id), deps)).toEqual({ status: 'sent' });
    const mail = await waitForCapturedMail(email);
    expect(mail.subject).toBe('Atur ulang password Balesin Maju');
    expect(mail.text).toContain(`${APP_URL}/atur-ulang-password#token=${token}`);
    expect(mail.text).toContain('Alamat IP: 203.0.113.5');
    expect(mail.text).toContain('Perangkat: Chrome di Android');
    const [row] = await db.select().from(accountTokens).where(eq(accountTokens.id, id));
    expect(row).toMatchObject({ deliveryStatus: 'sent', deliveryTokenEncrypted: null });
  }, 30_000);

  it('verifikasi email: tautan APP_URL ke alamat yang diverifikasi', async () => {
    const { organization, token, id, email } = await seedToken('email_verification');
    expect(await processEmailJob(tokenJob(organization.id, id), deps)).toEqual({ status: 'sent' });
    const mail = await waitForCapturedMail(email);
    expect(mail.text).toContain(`${APP_URL}/verifikasi-email#token=${token}`);
  }, 30_000);

  it('email akun sudah berubah sejak tautan atur ulang dibuat: tidak dikirim ke alamat lama', async () => {
    const tokenEmail = `lama-${uniqueSuffix()}@contoh.test`;
    const { organization, id } = await seedToken('password_reset', { tokenEmail });
    expect(await processEmailJob(tokenJob(organization.id, id), deps)).toEqual({
      status: 'skipped',
      reason: 'no_longer_valid',
    });
    expect(await capturedMailFor(tokenEmail)).toEqual([]);
  }, 30_000);
});

describe('pemberitahuan keamanan dengan IP dan perangkat', () => {
  async function auditRow(organizationId: string, actorUserId: string) {
    const [row] = await db
      .insert(auditLogs)
      .values({
        organizationId,
        actorUserId,
        action: 'auth.2fa.enabled',
        ipAddress: '198.51.100.23',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      })
      .returning({ id: auditLogs.id });
    if (!row) throw new Error('gagal');
    return row.id;
  }

  it('2FA aktif ke pemilik akun + ke Owner (satu job per penerima), dengan IP dan perangkat', async () => {
    const { organization, owner } = await organizationWithEmail();
    const admin = await insertUser(db, organization.id, {
      role: 'admin',
      name: 'Adi Admin',
      email: `adi-${uniqueSuffix()}@maju.test`,
    });
    const auditLogId = await auditRow(organization.id, admin.id);
    const occurredAt = new Date().toISOString();

    expect(
      await processEmailJob(
        {
          name: EMAIL_JOBS.securityNotice,
          data: {
            organizationId: organization.id,
            userId: admin.id,
            event: 'two_factor_enabled',
            occurredAt,
            auditLogId,
          },
        },
        deps,
      ),
    ).toEqual({ status: 'sent' });
    const own = await waitForCapturedMail(admin.email);
    expect(own.text).toContain('Alamat IP: 198.51.100.23');
    expect(own.text).toContain('Perangkat: Safari di macOS');

    expect(
      await processEmailJob(
        {
          name: EMAIL_JOBS.securityNoticeAdmin,
          data: {
            organizationId: organization.id,
            recipientUserId: owner.id,
            subjectUserId: admin.id,
            event: 'two_factor_enabled',
            occurredAt,
            auditLogId,
          },
        },
        deps,
      ),
    ).toEqual({ status: 'sent' });
    const notice = await waitForCapturedMail(owner.email);
    expect(notice.subject).toBe(
      'Verifikasi dua langkah Adi Admin (Admin) di Balesin Maju sudah aktif',
    );
    expect(notice.text).toContain(admin.email);
    expect(notice.text).toContain('Alamat IP: 198.51.100.23');

    // Penerima yang kini bukan Owner/Admin dilewati.
    const cs = await insertUser(db, organization.id, {
      role: 'cs',
      email: `cs-${uniqueSuffix()}@maju.test`,
    });
    expect(
      await processEmailJob(
        {
          name: EMAIL_JOBS.securityNoticeAdmin,
          data: {
            organizationId: organization.id,
            recipientUserId: cs.id,
            subjectUserId: admin.id,
            event: 'two_factor_enabled',
            occurredAt,
          },
        },
        deps,
      ),
    ).toEqual({ status: 'skipped', reason: 'recipient_unavailable' });
    expect(await capturedMailFor(cs.email)).toEqual([]);
  }, 30_000);

  it('password diganti: email ke pemilik akun', async () => {
    const { organization, owner } = await organizationWithEmail();
    expect(
      await processEmailJob(
        {
          name: EMAIL_JOBS.securityNotice,
          data: {
            organizationId: organization.id,
            userId: owner.id,
            event: 'password_changed',
            occurredAt: new Date().toISOString(),
          },
        },
        deps,
      ),
    ).toEqual({ status: 'sent' });
    const mail = await waitForCapturedMail(owner.email);
    expect(mail.subject).toBe('Password akun Balesin Maju kamu sudah diganti');
  }, 30_000);

  it('payload dengan kunci tambahan (mis. token) ditolak permanen', async () => {
    const { organization } = await organizationWithEmail();
    const result = await processEmailJob(
      {
        name: EMAIL_JOBS.invitation,
        data: {
          organizationId: organization.id,
          invitationId: crypto.randomUUID(),
          sendCount: 1,
          token: 'tidak-boleh-ada',
        },
      },
      deps,
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain('tidak valid');
  });
});
