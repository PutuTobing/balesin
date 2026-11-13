/**
 * Tes integrasi antrian `email`: Postgres + Redis + penangkap email (Mailpit) sungguhan.
 * Alurnya sama dengan produksi: API mengantre job berisi ID → worker mengambil penerima dan
 * pengaturan SMTP dari database, membuka password terenkripsi, lalu mengirim.
 *
 * Setiap kasus memakai organisasi dan alamat penerima unik, jadi aman berjalan paralel dengan
 * berkas tes lain yang memakai database/Mailpit yang sama.
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  createSecretBox,
  DEFAULT_JOB_OPTIONS,
  EMAIL_JOBS,
  emailJobResultSchema,
  QUEUE_NAMES,
  Secret,
  SMTP_PASSWORD_PURPOSE,
  type Redis,
  type SecretBox,
  type SmtpFallbackConfig,
} from '@balesin/core';
import {
  assertMailCatcherReachable,
  capturedMailFor,
  connectTestRedis,
  createLogCapture,
  TEST_MAIL,
  waitForCapturedMail,
  type LogCapture,
} from '@balesin/core/testing';
import { closeDb, createDb, emailSettings, type Database } from '@balesin/db';
import { insertOrganization, insertUser, uniqueSuffix } from '@balesin/db/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createEmailWorker, processEmailJob, type EmailJobDeps } from './email';

const MASTER_KEY = new Secret(randomBytes(32));
const SMTP_PASSWORD_MARKER = TEST_MAIL.password;

let logs: LogCapture;
let redis: Redis;
let db: Database;
let secretBox: SecretBox;
let queue: Queue;
let worker: ReturnType<typeof createEmailWorker>;
let deps: EmailJobDeps;

beforeAll(async () => {
  await assertMailCatcherReachable();
  logs = createLogCapture();
  redis = await connectTestRedis('queue', logs.logger);
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-email' });
  secretBox = createSecretBox(MASTER_KEY);
  deps = {
    db,
    secretBox,
    fallback: null,
    allowedPorts: [25, 465, 587, 2525, TEST_MAIL.smtpPort],
    logger: logs.logger,
    timeouts: { totalMs: 8_000 },
  };

  const prefix = `balesin-tes-${randomBytes(6).toString('hex')}`;
  queue = new Queue(QUEUE_NAMES.email, {
    connection: redis,
    prefix,
    // Tanpa jeda ulang supaya tes kegagalan tidak menunggu lama.
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 50 } },
  });
  worker = createEmailWorker({ connection: redis, prefix }, deps);
  worker.on('error', () => undefined);
}, 30_000);

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  if (redis) await closeRedis(redis);
  if (db) await closeDb(db);
}, 30_000);

/** Organisasi + pengguna dengan alamat email unik (jadi kotak masuk Mailpit-nya juga unik). */
async function recipient(overrides: Parameters<typeof insertUser>[2] = {}) {
  const organization = await insertOrganization(db, { productName: 'Balesin Contoh' });
  const user = await insertUser(db, organization.id, {
    name: 'Budi <Santoso>',
    email: `budi-${uniqueSuffix()}@contoh.test`,
    ...overrides,
  });
  return { organization, user };
}

async function configureEmail(
  organizationId: string,
  options: { password?: string; box?: SecretBox; port?: number } = {},
) {
  await db.insert(emailSettings).values({
    organizationId,
    fromName: 'Balesin Contoh',
    fromAddress: 'cs@contoh.test',
    replyTo: 'bantuan@contoh.test',
    host: TEST_MAIL.host,
    port: options.port ?? TEST_MAIL.smtpPort,
    security: 'none',
    username: TEST_MAIL.username,
    passwordEncrypted: (options.box ?? secretBox).encrypt(options.password ?? TEST_MAIL.password, {
      organizationId,
      purpose: SMTP_PASSWORD_PURPOSE,
    }),
    passwordTail: null,
  });
}

function lockedPayload(organizationId: string, userId: string) {
  return {
    organizationId,
    userId,
    lockedUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

async function runJob(name: string, data: unknown) {
  const added = await queue.add(name, data);
  if (!added.id) throw new Error('Job tidak punya ID');
  const jobId = added.id;
  await expect
    .poll(() => queue.getJobState(jobId), { timeout: 15_000, interval: 50 })
    .toMatch(/^(completed|failed)$/);
  const job = await queue.getJob(jobId);
  if (!job) throw new Error('Job hilang dari antrian');
  return job;
}

describe('antrian email — pemberitahuan akun dikunci', () => {
  it('mengirim email ke pemilik akun lewat SMTP organisasi (password dibuka dari bentuk terenkripsi)', async () => {
    const { organization, user } = await recipient();
    await configureEmail(organization.id);

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(await job.getState()).toBe('completed');
    expect(emailJobResultSchema.parse(job.returnvalue)).toEqual({ status: 'sent' });

    const mail = await waitForCapturedMail(user.email);
    expect(mail.subject).toBe('Percobaan masuk ke akun Balesin Contoh kamu dihentikan sementara');
    expect(mail.from).toEqual({ name: 'Balesin Contoh', address: 'cs@contoh.test' });
    expect(mail.to).toEqual([user.email]);
    expect(mail.replyTo).toEqual(['bantuan@contoh.test']);
    expect(mail.text).toContain('Halo Budi <Santoso>,');
    // Payload tanpa `scope` = kunci akun dari banyak jaringan (bawaan).
    expect(mail.text).toContain('dikunci sementara selama 15 menit');
    expect(mail.text).toContain('perangkat yang biasa kamu pakai');
    expect(mail.text).toContain('(Asia/Jakarta)');
    expect(mail.text).not.toMatch(/\bAnda\b/i);
    // Nama pengguna di-escape di HTML.
    expect(mail.html).toContain('Halo Budi &lt;Santoso&gt;,');
    expect(mail.html).not.toContain('<Santoso>');
  }, 30_000);

  it('payload di Redis hanya berisi ID dan waktu — tanpa alamat email maupun rahasia', async () => {
    const { organization, user } = await recipient();
    await configureEmail(organization.id);

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(Object.keys(job.data as object).sort()).toEqual([
      'lockedUntil',
      'organizationId',
      'userId',
    ]);
    const stored = JSON.stringify(await redis.hgetall(`${queue.opts.prefix}:email:${job.id}`));
    expect(stored).not.toContain(user.email);
    expect(stored).not.toContain(SMTP_PASSWORD_MARKER);
  }, 30_000);

  it('email belum diatur: job selesai dengan status dilewati, bukan gagal', async () => {
    const { organization, user } = await recipient();

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(await job.getState()).toBe('completed');
    expect(job.returnvalue).toEqual({ status: 'skipped', reason: 'email_not_configured' });
    expect(await capturedMailFor(user.email)).toEqual([]);
  }, 30_000);

  it('tanpa pengaturan di database memakai cadangan SMTP dari .env', async () => {
    const { organization, user } = await recipient();
    // Cadangan .env hanya mengenal SSL/TLS atau STARTTLS, sedangkan Mailpit lokal tidak punya
    // TLS. Jadi buktinya: worker MENYAMBUNG ke server cadangan (port-nya dipercaya walau tidak
    // ada di daftar izin) dan berhenti di STARTTLS yang ditolak server itu.
    const fallback: SmtpFallbackConfig = {
      host: TEST_MAIL.host,
      port: TEST_MAIL.smtpPort,
      security: 'starttls',
      username: TEST_MAIL.username,
      password: new Secret(TEST_MAIL.password),
      fromName: 'Cadangan',
      fromAddress: 'cadangan@contoh.test',
    };
    const job = {
      id: 'cadangan',
      name: EMAIL_JOBS.accountLocked,
      data: lockedPayload(organization.id, user.id),
    };

    const withFallback = await processEmailJob(job, { ...deps, allowedPorts: [], fallback }).catch(
      (error: unknown) => error,
    );
    const withoutFallback = await processEmailJob(job, {
      ...deps,
      allowedPorts: [],
      fallback: null,
    });

    expect(withFallback).toBeInstanceOf(Error);
    expect((withFallback as Error).message).toBe('Email gagal dikirim (tls_failed)');
    expect(withoutFallback).toEqual({ status: 'skipped', reason: 'email_not_configured' });
  }, 30_000);

  it('penerima nonaktif, tidak ada, atau dari organisasi lain: dilewati tanpa mengirim', async () => {
    const disabled = await recipient({ disabledAt: new Date() });
    const other = await recipient();
    const target = await recipient();
    for (const { organization } of [disabled, other, target]) await configureEmail(organization.id);

    const results = [
      await runJob(
        EMAIL_JOBS.accountLocked,
        lockedPayload(disabled.organization.id, disabled.user.id),
      ),
      await runJob(
        EMAIL_JOBS.accountLocked,
        lockedPayload(target.organization.id, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'),
      ),
      // ID pengguna benar, tetapi organisasinya bukan organisasi pengguna itu.
      await runJob(EMAIL_JOBS.accountLocked, lockedPayload(other.organization.id, target.user.id)),
    ];

    for (const job of results) {
      expect(job.returnvalue).toEqual({ status: 'skipped', reason: 'recipient_unavailable' });
    }
    expect(await capturedMailFor(disabled.user.email)).toEqual([]);
    expect(await capturedMailFor(target.user.email)).toEqual([]);
  }, 60_000);

  it('password SMTP salah: gagal permanen (tidak diulang) dan alasannya hanya kode', async () => {
    const { organization, user } = await recipient();
    await configureEmail(organization.id, { password: 'sandi-smtp-yang-salah' });

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toBe('Email gagal dikirim (auth_failed)');
    expect(logs.text()).not.toContain('sandi-smtp-yang-salah');
  }, 30_000);

  it('server email tidak bisa dihubungi: diulang sesuai jatah percobaan', async () => {
    const { organization, user } = await recipient();
    // Port 2525 ada di daftar izin tetapi tidak ada yang mendengarkan.
    await configureEmail(organization.id, { port: 2525 });

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(job.failedReason).toBe('Email gagal dikirim (connection_refused)');
  }, 30_000);

  it('password tersimpan tidak bisa dibuka (master key berbeda): gagal permanen', async () => {
    const { organization, user } = await recipient();
    const otherBox = createSecretBox(new Secret(randomBytes(32)));
    await configureEmail(organization.id, { box: otherBox });

    const job = await runJob(EMAIL_JOBS.accountLocked, lockedPayload(organization.id, user.id));

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toContain('tidak bisa dibuka');
    expect(await capturedMailFor(user.email)).toEqual([]);
  }, 30_000);

  it('payload rusak atau berisi isian tak dikenal, dan job tak dikenal, gagal permanen', async () => {
    const { organization, user } = await recipient();
    const valid = lockedPayload(organization.id, user.id);

    const jobs = [
      await runJob(EMAIL_JOBS.accountLocked, { ...valid, smtpPassword: 'nyelip' }),
      await runJob(EMAIL_JOBS.accountLocked, { ...valid, userId: 'bukan-uuid' }),
      await runJob('tidak-dikenal', valid),
    ];

    for (const job of jobs) {
      expect(await job.getState()).toBe('failed');
      expect(job.attemptsMade).toBe(1);
    }
    expect(jobs[0]?.failedReason).toBe('Payload job email:account-locked tidak valid');
  }, 60_000);

  it('log worker tidak pernah memuat password SMTP', () => {
    // `balesin` juga awalan kunci tes dan nama koneksi, jadi yang diperiksa adalah bentuk
    // penugasan rahasia, bukan sekadar kemunculan katanya.
    expect(logs.text()).not.toMatch(/"pass(word)?":"balesin"/);
    expect(logs.text()).not.toContain('sandi-smtp-yang-salah');
    expect(logs.entries().some((entry) => entry.msg === 'Email terkirim')).toBe(true);
  });
});
