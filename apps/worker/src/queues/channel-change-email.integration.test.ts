/**
 * Pemberitahuan "channel diubah selain Owner" ke Owner — Postgres + Mailpit sungguhan. Payload job
 * hanya ID; pelaku, channel, perubahan, waktu, dan IP/perangkat dibaca worker dari baris audit.
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
  deleteCapturedMailFor,
  TEST_MAIL,
  type LogCapture,
} from '@balesin/core/testing';
import { auditLogs, closeDb, createDb, emailSettings, type Database } from '@balesin/db';
import { insertOrganization, insertUser, uniqueSuffix } from '@balesin/db/testing';
import { CHANNEL_CHANGE_AUDIT_ACTIONS, type ChannelChangeKind } from '@balesin/shared';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { processEmailJob, type EmailJob, type EmailJobDeps } from './email';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

let logs: LogCapture;
let db: Database;
let box: SecretBox;
let deps: EmailJobDeps;
/** Alamat penerima yang dipakai tes ini — email-nya dihapus dari Mailpit setelah selesai. */
const mailboxes: string[] = [];

beforeAll(async () => {
  await assertMailCatcherReachable();
  logs = createLogCapture();
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-channel' });
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
  for (const mailbox of mailboxes) await deleteCapturedMailFor(mailbox);
  if (db) await closeDb(db);
}, 30_000);

/** Organisasi ber-SMTP Mailpit dengan satu Owner (penerima) dan satu Admin (pelaku). */
async function organizationWithAdmin(options: { adminDisabled?: boolean } = {}) {
  const organization = await insertOrganization(db, {
    name: 'PT Maju',
    productName: 'Balesin Maju',
  });
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
  const owner = await insertUser(db, organization.id, {
    role: 'owner',
    name: 'Rina Owner',
    email: `rina-${uniqueSuffix()}@maju.test`,
  });
  mailboxes.push(owner.email);
  const admin = await insertUser(db, organization.id, {
    role: 'admin',
    name: 'Adi Admin',
    email: `adi-${uniqueSuffix()}@maju.test`,
    ...(options.adminDisabled ? { disabledAt: new Date() } : {}),
  });
  return { organization, owner, admin };
}

/** Baris audit seperti yang ditulis modul channels untuk perubahan oleh Admin. */
async function channelAudit(
  organizationId: string,
  actorUserId: string,
  change: ChannelChangeKind,
  metadata: Record<string, unknown> = {},
  action: string = CHANNEL_CHANGE_AUDIT_ACTIONS[change],
) {
  const [row] = await db
    .insert(auditLogs)
    .values({
      organizationId,
      actorUserId,
      action,
      targetType: 'channel',
      targetId: randomUUID(),
      metadata: {
        name: 'CS Utama',
        phoneNumberId: '106540352249999',
        change,
        actorRole: 'admin',
        ownersNotified: true,
        ...metadata,
      },
      ipAddress: '198.51.100.7',
      userAgent: CHROME_WINDOWS,
    })
    .returning();
  if (!row) throw new Error('baris audit tidak dibuat');
  return row;
}

function job(
  data: unknown,
  attempt: { attemptsMade: number; attempts: number } = { attemptsMade: 0, attempts: 3 },
): EmailJob {
  return {
    id: randomUUID(),
    name: EMAIL_JOBS.channelChanged,
    data,
    attemptsMade: attempt.attemptsMade,
    opts: { attempts: attempt.attempts },
  };
}

describe('antrian email — channel diubah selain Owner', () => {
  it('ganti kredensial oleh Admin: email ke Owner dengan pelaku, channel, isian yang diganti, waktu, IP, perangkat', async () => {
    const { organization, owner, admin } = await organizationWithAdmin();
    const audit = await channelAudit(organization.id, admin.id, 'credentials_changed', {
      changedFields: ['name', 'phoneNumberId', 'accessToken', 'isianAsing'],
      previousPhoneNumberId: '106540352242922',
    });

    const result = await processEmailJob(
      job({ organizationId: organization.id, recipientUserId: owner.id, auditLogId: audit.id }),
      deps,
    );
    expect(result).toEqual({ status: 'sent' });

    await expect.poll(async () => (await capturedMailFor(owner.email)).length).toBe(1);
    const [mail] = await capturedMailFor(owner.email);
    expect(mail?.subject).toBe(
      'Kredensial channel "CS Utama" di Balesin Maju diganti oleh Adi Admin (Admin)',
    );
    expect(mail?.from.address).toBe('cs@maju.test');
    expect(mail?.text).toContain('Halo Rina Owner,');
    expect(mail?.text).toContain(`Adi Admin (${admin.email}, peran Admin)`);
    expect(mail?.text).toContain('Phone Number ID: 106540352242922 → 106540352249999');
    // Hanya isian kredensial yang dikenal (nama channel & isian asing tidak ikut).
    expect(mail?.text).toContain('Yang diganti: Phone Number ID, Token System User');
    expect(mail?.text).toContain('Alamat IP: 198.51.100.7');
    expect(mail?.text).toContain('Perangkat: Chrome di Windows');
    expect(mail?.text).toContain('(Asia/Jakarta)');
    expect(mail?.text).not.toMatch(/\bAnda\b/i);
    expect(mail?.text).not.toContain('isianAsing');
  }, 30_000);

  it('buat, verify token dibuat ulang, nonaktifkan, hapus: subjek sesuai perubahan; pelaku nonaktif tetap disebut', async () => {
    const { organization, owner, admin } = await organizationWithAdmin({ adminDisabled: true });
    for (const change of ['created', 'verify_token_rotated', 'disabled', 'deleted'] as const) {
      const audit = await channelAudit(organization.id, admin.id, change);
      const result = await processEmailJob(
        job({ organizationId: organization.id, recipientUserId: owner.id, auditLogId: audit.id }),
        deps,
      );
      expect(result, change).toEqual({ status: 'sent' });
    }
    await expect.poll(async () => (await capturedMailFor(owner.email)).length).toBe(4);
    const subjects = (await capturedMailFor(owner.email)).map((mail) => mail.subject).sort();
    expect(subjects).toEqual(
      [
        'Channel baru "CS Utama" ditambahkan di Balesin Maju oleh Adi Admin (Admin)',
        'Verify token channel "CS Utama" di Balesin Maju dibuat ulang oleh Adi Admin (Admin)',
        'Channel "CS Utama" di Balesin Maju dinonaktifkan oleh Adi Admin (Admin)',
        'Channel "CS Utama" di Balesin Maju dihapus oleh Adi Admin (Admin)',
      ].sort(),
    );
  }, 30_000);

  it('penerima bukan Owner lagi, nonaktif, atau dari organisasi lain: dilewati tanpa mengirim', async () => {
    const { organization, owner, admin } = await organizationWithAdmin();
    const audit = await channelAudit(organization.id, admin.id, 'disabled');
    const demoted = await insertUser(db, organization.id, {
      role: 'admin',
      email: `turun-${uniqueSuffix()}@maju.test`,
    });
    const inactive = await insertUser(db, organization.id, {
      role: 'owner',
      email: `nonaktif-${uniqueSuffix()}@maju.test`,
      disabledAt: new Date(),
    });
    const other = await organizationWithAdmin();
    mailboxes.push(demoted.email, inactive.email);

    for (const recipientUserId of [demoted.id, inactive.id, other.owner.id]) {
      const result = await processEmailJob(
        job({ organizationId: organization.id, recipientUserId, auditLogId: audit.id }),
        deps,
      );
      expect(result).toEqual({ status: 'skipped', reason: 'recipient_unavailable' });
    }
    // Baris audit organisasi lain tidak bisa dipakai lewat organisasi sendiri.
    const foreign = await processEmailJob(
      job(
        {
          organizationId: other.organization.id,
          recipientUserId: other.owner.id,
          auditLogId: audit.id,
        },
        { attemptsMade: 2, attempts: 3 },
      ),
      deps,
    );
    expect(foreign).toEqual({ status: 'skipped', reason: 'no_longer_valid' });

    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const email of [demoted.email, inactive.email, other.owner.email, owner.email]) {
      expect(await capturedMailFor(email)).toEqual([]);
    }
  }, 30_000);

  it('baris audit belum terlihat diulang; tetap tidak ada di percobaan terakhir = dilewati', async () => {
    const { organization, owner } = await organizationWithAdmin();
    const data = {
      organizationId: organization.id,
      recipientUserId: owner.id,
      auditLogId: randomUUID(),
    };
    await expect(processEmailJob(job(data), deps)).rejects.not.toBeInstanceOf(UnrecoverableError);
    await expect(processEmailJob(job(data), deps)).rejects.toThrow(/belum tersedia/);
    expect(await processEmailJob(job(data, { attemptsMade: 2, attempts: 3 }), deps)).toEqual({
      status: 'skipped',
      reason: 'no_longer_valid',
    });
  });

  it('baris audit yang bukan perubahan channel yang diberitahukan, atau payload rusak: gagal permanen', async () => {
    const { organization, owner, admin } = await organizationWithAdmin();
    const byOwner = await channelAudit(organization.id, admin.id, 'deleted', {
      ownersNotified: false,
    });
    const mismatched = await channelAudit(
      organization.id,
      admin.id,
      'deleted',
      {},
      'channel.enabled',
    );
    const unknownChange = await channelAudit(organization.id, admin.id, 'deleted', {
      change: 'renamed',
    });
    for (const audit of [byOwner, mismatched, unknownChange]) {
      await expect(
        processEmailJob(
          job({ organizationId: organization.id, recipientUserId: owner.id, auditLogId: audit.id }),
          deps,
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    }
    for (const data of [
      { organizationId: organization.id, recipientUserId: owner.id },
      {
        organizationId: organization.id,
        recipientUserId: owner.id,
        auditLogId: byOwner.id,
        accessToken: 'EAAG-tidak-boleh-ada-di-payload',
      },
    ]) {
      await expect(processEmailJob(job(data), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(await capturedMailFor(owner.email)).toEqual([]);
  });
});
