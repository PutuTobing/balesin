/**
 * Pemberitahuan "email pengirim diubah" ke Owner (review keamanan RBAC S1) — Postgres + Mailpit
 * sungguhan. Intinya: dikirim lewat SALINAN pengaturan SEBELUM perubahan, bukan lewat pengaturan
 * baru (yang mungkin server penyerang), lalu salinan password-nya dihapus.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  createSecretBox,
  EMAIL_JOBS,
  Secret,
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
  closeDb,
  createDb,
  emailSettings,
  emailSettingsChangeNotices,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser, uniqueSuffix } from '@balesin/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { processEmailJob, type EmailJob, type EmailJobDeps } from './email';

let logs: LogCapture;
let db: Database;
let box: SecretBox;
let deps: EmailJobDeps;

beforeAll(async () => {
  await assertMailCatcherReachable();
  logs = createLogCapture();
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-ubah-email' });
  box = createSecretBox(new Secret(randomBytes(32)));
  deps = {
    appUrl: 'https://balesin.contoh.test',
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

const encrypt = (organizationId: string, password: string) =>
  box.encrypt(password, { organizationId, purpose: SMTP_PASSWORD_PURPOSE });

/**
 * Organisasi yang pengaturan SEKARANG-nya menunjuk `current` (bawaan: server penyerang yang tidak
 * ada), dan salinan SEBELUM perubahannya menunjuk `previous` (bawaan: Mailpit).
 */
async function changedOrganization(
  options: {
    current?: { host: string; port: number };
    previous?: { host: string; port: number } | null;
    recipientRole?: 'owner' | 'cs';
    pending?: number;
  } = {},
) {
  const organization = await insertOrganization(db, {
    name: 'PT Maju',
    productName: 'Balesin Maju',
  });
  const current = options.current ?? { host: 'smtp.penyerang.invalid', port: 587 };
  await db.insert(emailSettings).values({
    organizationId: organization.id,
    fromName: 'Balesin Maju',
    fromAddress: 'pengirim@penyerang.test',
    replyTo: null,
    host: current.host,
    port: current.port,
    security: 'none',
    username: TEST_MAIL.username,
    passwordEncrypted: encrypt(organization.id, TEST_MAIL.password),
    passwordTail: null,
  });
  const recipient = await insertUser(db, organization.id, {
    role: options.recipientRole ?? 'owner',
    name: 'Rina Owner',
    email: `rina-${uniqueSuffix()}@maju.test`,
  });
  const admin = await insertUser(db, organization.id, {
    role: 'admin',
    name: 'Adi Admin',
    email: `adi-${uniqueSuffix()}@maju.test`,
  });
  const previous =
    options.previous === undefined
      ? { host: TEST_MAIL.host, port: TEST_MAIL.smtpPort }
      : options.previous;
  const [notice] = await db
    .insert(emailSettingsChangeNotices)
    .values({
      organizationId: organization.id,
      actorUserId: admin.id,
      auditLogId: randomUUID(),
      ...(previous
        ? {
            previousFromName: 'Balesin Maju',
            previousFromAddress: 'cs@maju.test',
            previousHost: previous.host,
            previousPort: previous.port,
            previousSecurity: 'none' as const,
            previousUsername: TEST_MAIL.username,
            previousPasswordEncrypted: encrypt(organization.id, TEST_MAIL.password),
          }
        : {}),
      newHost: current.host,
      newPort: current.port,
      newFromAddress: 'pengirim@penyerang.test',
      pendingDeliveries: options.pending ?? 1,
    })
    .returning();
  if (!notice) throw new Error('baris pemberitahuan tidak dibuat');
  return { organization, recipient, admin, notice };
}

function job(
  data: { organizationId: string; recipientUserId: string; noticeId: string },
  attempt: { attemptsMade: number; attempts: number } = { attemptsMade: 0, attempts: 3 },
): EmailJob {
  return {
    id: randomUUID(),
    name: EMAIL_JOBS.emailSettingsChanged,
    data,
    attemptsMade: attempt.attemptsMade,
    opts: { attempts: attempt.attempts },
  };
}

async function noticeRow(id: string) {
  const [row] = await db
    .select()
    .from(emailSettingsChangeNotices)
    .where(eq(emailSettingsChangeNotices.id, id));
  return row;
}

describe('email:email-settings-changed', () => {
  it('dikirim lewat pengaturan LAMA (pengaturan sekarang = server penyerang tidak disentuh); salinan password dihapus', async () => {
    const { organization, recipient, notice } = await changedOrganization();

    const result = await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: recipient.id, noticeId: notice.id }),
      deps,
    );

    expect(result).toEqual({ status: 'sent' });
    const mail = await waitForCapturedMail(recipient.email);
    expect(mail.subject).toBe('Email pengirim Balesin Maju diubah oleh Adi Admin (Admin)');
    expect(mail.from.address).toBe('cs@maju.test');
    expect(mail.text).toContain(`${TEST_MAIL.host}:${String(TEST_MAIL.smtpPort)}`);
    expect(mail.text).toContain('smtp.penyerang.invalid:587');
    expect(mail.text).toContain('pengaturan yang LAMA');
    const row = await noticeRow(notice.id);
    expect(row?.pendingDeliveries).toBe(0);
    expect(row?.previousPasswordEncrypted).toBeNull();
    expect(row?.previousHost).toBe(TEST_MAIL.host);
  }, 30_000);

  it('masih ada Owner lain yang menunggu: salinan password belum dihapus', async () => {
    const { organization, recipient, notice } = await changedOrganization({ pending: 2 });
    await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: recipient.id, noticeId: notice.id }),
      deps,
    );
    const row = await noticeRow(notice.id);
    expect(row?.pendingDeliveries).toBe(1);
    expect(row?.previousPasswordEncrypted).not.toBeNull();
  }, 30_000);

  it('pengaturan lama gagal permanen (port tidak diizinkan): jatuh ke pengaturan sekarang', async () => {
    const { organization, recipient, notice } = await changedOrganization({
      previous: { host: TEST_MAIL.host, port: 2526 },
      current: { host: TEST_MAIL.host, port: TEST_MAIL.smtpPort },
    });
    logs.lines.length = 0;

    const result = await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: recipient.id, noticeId: notice.id }),
      deps,
    );

    expect(result).toEqual({ status: 'sent' });
    expect((await waitForCapturedMail(recipient.email)).from.address).toBe(
      'pengirim@penyerang.test',
    );
    expect(logs.text()).toContain('pemberitahuan dikirim lewat pengaturan sekarang');
  }, 30_000);

  it('kegagalan sementara pengaturan lama di percobaan awal: diulang (tidak jatuh ke pengaturan baru)', async () => {
    const { organization, recipient, notice } = await changedOrganization({
      // Tidak ada yang mendengarkan: sambungan ditolak = kegagalan sementara.
      previous: { host: '127.0.0.1', port: 2525 },
      current: { host: TEST_MAIL.host, port: TEST_MAIL.smtpPort },
    });

    await expect(
      processEmailJob(
        job({
          organizationId: organization.id,
          recipientUserId: recipient.id,
          noticeId: notice.id,
        }),
        deps,
      ),
    ).rejects.toThrow(/Email gagal dikirim/);
    expect(await capturedMailFor(recipient.email)).toEqual([]);
    expect((await noticeRow(notice.id))?.pendingDeliveries).toBe(1);
  }, 30_000);

  it('tanpa salinan lama (pengaturan pertama kali): dikirim lewat pengaturan sekarang', async () => {
    const { organization, recipient, notice } = await changedOrganization({
      previous: null,
      current: { host: TEST_MAIL.host, port: TEST_MAIL.smtpPort },
    });
    const result = await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: recipient.id, noticeId: notice.id }),
      deps,
    );
    expect(result).toEqual({ status: 'sent' });
    expect((await waitForCapturedMail(recipient.email)).text).toContain('Belum diatur');
  }, 30_000);

  it('penerima bukan Owner lagi: dilewati, hitungan tetap turun', async () => {
    const { organization, recipient, notice } = await changedOrganization({ recipientRole: 'cs' });
    const result = await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: recipient.id, noticeId: notice.id }),
      deps,
    );
    expect(result).toEqual({ status: 'skipped', reason: 'recipient_unavailable' });
    expect(await capturedMailFor(recipient.email)).toEqual([]);
    expect((await noticeRow(notice.id))?.previousPasswordEncrypted).toBeNull();
  }, 30_000);

  it('baris belum terlihat (job lebih cepat dari commit): error biasa supaya diulang', async () => {
    const { organization, recipient } = await changedOrganization();
    await expect(
      processEmailJob(
        job({
          organizationId: organization.id,
          recipientUserId: recipient.id,
          noticeId: randomUUID(),
        }),
        deps,
      ),
    ).rejects.toThrow('belum tersedia');
  }, 30_000);
});
