import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOK_JOBS,
  WEBHOOK_JOB_OPTIONS,
  webhookEventJobId,
  webhookEventJobPayloadSchema,
  type Logger,
} from '@balesin/core';
import { Queue as BullQueue, type Queue, type Worker } from 'bullmq';

import {
  createBroadcastQueue,
  createBroadcastWorker,
  runEnqueuer,
  scheduleBroadcastJobs,
  type BroadcastJobDeps,
} from './queues/broadcast';
import { createEmailWorker, type EmailJobDeps } from './queues/email';
import {
  createEmailOutboundQueue,
  createEmailOutboundWorker,
  scheduleEmailOutbound,
  type EmailOutboundDeps,
} from './queues/email-outbound';
import { createMessageWorker, type MessageJobDeps } from './queues/messages';
import { createNotificationWorker, type NotificationJobDeps } from './queues/notifications';
import {
  createMaintenanceQueue,
  createMaintenanceWorker,
  scheduleMaintenanceJobs,
  type MaintenanceJobDeps,
} from './queues/maintenance';
import { createSystemWorker, type QueueConnectionOptions } from './queues/system';
import {
  createWebhooksOutQueue,
  createWebhooksOutWorker,
  scheduleWebhooksOut,
  type WebhooksOutDeps,
} from './queues/webhooks-out';
import { createWebhookWorker, type WebhookJobDeps } from './queues/webhooks';
import { createIdleSupervisor, type IdleSupervisor } from './mail-idle/supervisor';
import { createMailActions } from './mail/actions';
import { createComposeMaintenance } from './mail/compose-maintenance';
import { createMailCopies, markVerifiedByMailbox } from './mail/copies';
import { createMailSender, type MailSendDeps } from './mail/send';
import { createMailReader } from './mail/read';
import { createMailSync, type MailSyncDeps } from './mail/sync';
import {
  createMailQueue,
  createMailScheduleQueue,
  createMailScheduleWorker,
  createMailSendQueue,
  createMailSendWorker,
  createMailWorker,
  mailEnqueuers,
  mailSendEnqueuer,
  scheduleMailJobs,
  type MailJobDeps,
} from './queues/mail';
import {
  createChannelsQueue,
  createChannelsWorker,
  pollEnqueuer,
  scheduleChannelJobs,
  type ChannelMailboxDeps,
} from './queues/channel-mailboxes';

export interface WorkerRuntime {
  workers: Worker[];
  /** Berhenti mengambil job baru dan menunggu job yang sedang berjalan selesai. */
  close(): Promise<void>;
}

/** Dependensi pemroses job selain koneksi antrian. */
export interface WorkerServices {
  /** Untuk antrian `email` (database, kotak rahasia, cadangan SMTP). */
  email: Omit<EmailJobDeps, 'logger'>;
  /** Untuk antrian `webhooks` (kejadian webhook masuk yang sudah tersimpan). */
  webhooks: Omit<WebhookJobDeps, 'logger'>;
  /**
   * Antrian `maintenance` + jadwal berkalanya (retensi payload webhook). Opsional supaya tes yang
   * tidak membutuhkannya tidak mendaftarkan jadwal di Redis.
   */
  maintenance?: Omit<MaintenanceJobDeps, 'logger'>;
  /** Antrian `messages` (pesan keluar ke Meta). Opsional untuk tes yang tidak membutuhkannya. */
  messages?: Omit<MessageJobDeps, 'logger'>;
  /** Antrian `notifications` (Web Push). Opsional untuk tes yang tidak membutuhkannya. */
  notifications?: Omit<NotificationJobDeps, 'logger'>;
  /** Antrian `webhooks-out` (webhook keluar, job berkala tiap 5 dtk). Opsional untuk tes. */
  webhooksOut?: Omit<WebhooksOutDeps, 'logger'>;
  /** Antrian `broadcast` (kampanye, rem otomatis, alarm Telegram). Opsional untuk tes. */
  broadcast?: Omit<BroadcastJobDeps, 'logger' | 'enqueueRun'>;
  /** Fase 6 — antrian `channels` (ambil kotak masuk email). Opsional untuk tes. */
  channels?: Omit<ChannelMailboxDeps, 'logger' | 'enqueuePoll' | 'enqueueEvents'>;
  /** Tahap 9.1 — antrian `email-outbound` (email lewat API, job berkala tiap 5 dtk). Opsional. */
  emailOutbound?: Omit<EmailOutboundDeps, 'logger'>;
  /**
   * Fase 9 — modul Email: antrian `mail` (tick, sinkron, putuskan, retensi) + pengawas IDLE.
   * Opsional untuk tes. `idle: false` = tanpa pengawas IDLE (tes antrian saja).
   */
  mail?: Omit<MailSyncDeps, 'logger'> &
    Pick<MailJobDeps, 'store'> & {
      idle?: boolean;
      prefix?: string;
      /** Origin web (`APP_URL`) — halaman peringatan tautan menipu di dokumen tampilan. */
      appUrl: string;
      /** 9B: SMTP akun (port tambahan/CA/loopback HANYA tes), pengganti pengirim tes, email Owner. */
      smtp?: MailSendDeps['smtp'];
      send?: MailSendDeps['send'];
      notifyOwner?: MailSendDeps['notifyOwner'];
    };
}

const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Menyalakan semua pemroses antrian. Setiap antrian baru didaftarkan di sini.
 * Tidak melempar bila Redis mati: BullMQ menunggu koneksi pulih lalu lanjut memproses.
 */
export function startWorkers(
  options: QueueConnectionOptions,
  logger: Logger,
  services: WorkerServices,
): WorkerRuntime {
  const workers = [
    createSystemWorker(options, { logger }),
    createEmailWorker(options, { ...services.email, logger }),
    createWebhookWorker(options, { ...services.webhooks, logger }),
  ];
  if (services.messages) {
    workers.push(createMessageWorker(options, { ...services.messages, logger }));
  }
  if (services.notifications) {
    workers.push(createNotificationWorker(options, { ...services.notifications, logger }));
  }
  let maintenanceQueue: Queue | undefined;
  let webhooksOutQueue: Queue | undefined;
  let emailOutboundQueue: Queue | undefined;
  let broadcastQueue: Queue | undefined;
  let channelsQueue: Queue | undefined;
  let webhookProducer: Queue | undefined;
  let mailQueue: Queue | undefined;
  let mailScheduleQueue: Queue | undefined;
  let mailSendQueue: Queue | undefined;
  let idleSupervisor: IdleSupervisor | undefined;
  if (services.mail) {
    const queue = createMailQueue(options);
    mailQueue = queue;
    queue.on('error', () => undefined);
    const enqueue = mailEnqueuers(queue);
    const { store, idle, prefix, appUrl, smtp, send, notifyOwner, ...syncDeps } = services.mail;
    const sync = createMailSync({
      ...syncDeps,
      logger,
      verifyByMailbox: (organizationId, identityId, at) =>
        markVerifiedByMailbox(syncDeps.db, organizationId, identityId, at),
    });
    const reader = createMailReader({
      db: syncDeps.db,
      logger,
      secretBox: syncDeps.secretBox,
      publisher: syncDeps.publisher,
      store,
      appUrl,
      policyFor: (organizationId) => sync.policyFor(organizationId),
      ...(syncDeps.connector ? { connector: syncDeps.connector } : {}),
      ...(syncDeps.now ? { now: syncDeps.now } : {}),
    });
    const actions = createMailActions({
      db: syncDeps.db,
      logger,
      publisher: syncDeps.publisher,
      reader,
      enqueueSync: (payload) => enqueue.enqueueSync(payload),
      ...(syncDeps.now ? { now: syncDeps.now } : {}),
    });
    const sendQueue = createMailSendQueue(options);
    mailSendQueue = sendQueue;
    sendQueue.on('error', () => undefined);
    const queuePrefix = prefix ?? QUEUE_PREFIX;
    const sender = createMailSender({
      db: syncDeps.db,
      logger,
      redis: options.connection,
      prefix: queuePrefix,
      secretBox: syncDeps.secretBox,
      publisher: syncDeps.publisher,
      store,
      smtp: smtp ?? {},
      ...(send ? { send } : {}),
      ...(notifyOwner ? { notifyOwner } : {}),
      enqueueSend: mailSendEnqueuer(sendQueue),
      enqueueAppendSent: (payload, delayMs) => enqueue.enqueueAppendSent(payload, delayMs),
      enqueueDraftRemoteDelete: (payload) => enqueue.enqueueDraftRemoteDelete(payload),
      ...(syncDeps.now ? { now: syncDeps.now } : {}),
    });
    const copies = createMailCopies({
      db: syncDeps.db,
      logger,
      secretBox: syncDeps.secretBox,
      publisher: syncDeps.publisher,
      store,
      openSession: (account) => reader.openSession(account),
      redis: options.connection,
      prefix: queuePrefix,
      enqueueFolder: (payload) => enqueue.enqueueFolder(payload),
      ...(syncDeps.now ? { now: syncDeps.now } : {}),
    });
    const compose = createComposeMaintenance({
      db: syncDeps.db,
      redis: options.connection,
      prefix: queuePrefix,
      logger,
      publisher: syncDeps.publisher,
      store,
      enqueueDraftSync: (payload, delayMs) => enqueue.enqueueDraftSync(payload, delayMs),
      ...(syncDeps.now ? { now: syncDeps.now } : {}),
    });
    const mailDeps = {
      sender,
      copies,
      compose,
      db: services.mail.db,
      logger,
      redis: options.connection,
      ...(prefix ? { prefix } : {}),
      sync,
      store,
      reader,
      actions,
      enqueueSync: (payload: Parameters<typeof enqueue.enqueueSync>[0]) =>
        enqueue.enqueueSync(payload),
      enqueuePurge: (payload: Parameters<typeof enqueue.enqueuePurge>[0]) =>
        enqueue.enqueuePurge(payload),
      enqueueAction: (payload: Parameters<typeof enqueue.enqueueAction>[0]) =>
        enqueue.enqueueAction(payload),
    };
    const scheduleQueue = createMailScheduleQueue(options);
    mailScheduleQueue = scheduleQueue;
    scheduleQueue.on('error', () => undefined);
    workers.push(
      createMailWorker(options, mailDeps),
      createMailScheduleWorker(options, mailDeps),
      createMailSendWorker(options, sender),
    );
    scheduleMailJobs(scheduleQueue, queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal modul Email gagal didaftarkan');
    });
    if (idle !== false) {
      idleSupervisor = createIdleSupervisor({
        db: services.mail.db,
        redis: options.connection,
        logger,
        secretBox: services.mail.secretBox,
        sync,
        enqueueFolder: (payload) => enqueue.enqueueFolder(payload),
        ...(services.mail.connector ? { connector: services.mail.connector } : {}),
        ...(prefix ? { prefix } : {}),
      });
    }
  }
  if (services.channels) {
    const queue = createChannelsQueue(options);
    channelsQueue = queue;
    // Kejadian email masuk diantrekan ke antrian `webhooks` (pemroses yang sama dengan channel lain).
    const producer = new BullQueue(QUEUE_NAMES.webhooks, {
      connection: options.connection,
      prefix: options.prefix ?? QUEUE_PREFIX,
      defaultJobOptions: WEBHOOK_JOB_OPTIONS,
    });
    webhookProducer = producer;
    producer.on('error', () => undefined);
    workers.push(
      createChannelsWorker(options, {
        ...services.channels,
        logger,
        enqueuePoll: pollEnqueuer(queue),
        enqueueEvents: async (events) => {
          await producer.addBulk(
            events.map((event) => ({
              name: WEBHOOK_JOBS.whatsappEvent,
              data: webhookEventJobPayloadSchema.parse(event),
              opts: { jobId: webhookEventJobId(event.eventId) },
            })),
          );
        },
      }),
    );
    scheduleChannelJobs(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal kotak masuk email gagal didaftarkan');
    });
    queue.on('error', () => undefined);
  }
  if (services.broadcast) {
    const queue = createBroadcastQueue(options);
    broadcastQueue = queue;
    workers.push(
      createBroadcastWorker(options, {
        ...services.broadcast,
        logger,
        enqueueRun: runEnqueuer(queue),
      }),
    );
    scheduleBroadcastJobs(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal broadcast gagal didaftarkan');
    });
    queue.on('error', () => undefined);
  }
  if (services.webhooksOut) {
    workers.push(createWebhooksOutWorker(options, { ...services.webhooksOut, logger }));
    const queue = createWebhooksOutQueue(options);
    webhooksOutQueue = queue;
    scheduleWebhooksOut(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal webhook keluar gagal didaftarkan');
    });
    queue.on('error', () => undefined);
  }
  if (services.emailOutbound) {
    workers.push(createEmailOutboundWorker(options, { ...services.emailOutbound, logger }));
    const queue = createEmailOutboundQueue(options);
    emailOutboundQueue = queue;
    scheduleEmailOutbound(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal antrean email API gagal didaftarkan');
    });
    queue.on('error', () => undefined);
  }
  if (services.maintenance) {
    workers.push(createMaintenanceWorker(options, { ...services.maintenance, logger }));
    const queue = createMaintenanceQueue(options);
    maintenanceQueue = queue;
    // Tidak ditunggu: Redis yang belum siap tidak boleh menahan start. Gagal = dicoba lagi saat
    // worker dijalankan ulang (retensi tertunda, bukan data hilang).
    scheduleMaintenanceJobs(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal pemeliharaan (retensi payload webhook) gagal didaftarkan');
    });
    queue.on('error', () => {
      // Error koneksi sudah dicatat listener worker; listener ini mencegah proses jatuh.
    });
  }

  for (const worker of workers) {
    const queue = worker.name;

    // Wajib ada listener `error`: tanpa itu error koneksi menjatuhkan proses. Dibatasi agar
    // log tidak banjir selama Redis mati.
    let lastErrorLogAt = 0;
    worker.on('error', (err) => {
      const now = Date.now();
      if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
      lastErrorLogAt = now;
      logger.error({ err, queue }, 'Worker antrian bermasalah');
    });

    worker.on('failed', (job, err) => {
      logger.warn(
        { err, queue, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade },
        'Job gagal',
      );
    });

    worker.on('completed', (job) => {
      logger.debug({ queue, jobId: job.id, jobName: job.name }, 'Job selesai');
    });
  }

  return {
    workers,
    async close() {
      // Tanpa koneksi Redis tidak ada job yang bisa diselesaikan, dan penutupan biasa akan
      // menunggu Redis selamanya — jadi tutup paksa (langsung putus) bila Redis sedang mati.
      const force = options.connection.status !== 'ready';
      await idleSupervisor?.close();
      await Promise.all(workers.map((worker) => worker.close(force)));
      if (webhooksOutQueue) {
        if (force) await webhooksOutQueue.disconnect();
        else await webhooksOutQueue.close();
      }
      if (maintenanceQueue) {
        if (force) await maintenanceQueue.disconnect();
        else await maintenanceQueue.close();
      }
      if (broadcastQueue) {
        if (force) await broadcastQueue.disconnect();
        else await broadcastQueue.close();
      }
      for (const queue of [
        channelsQueue,
        webhookProducer,
        emailOutboundQueue,
        mailQueue,
        mailScheduleQueue,
        mailSendQueue,
      ]) {
        if (!queue) continue;
        if (force) await queue.disconnect();
        else await queue.close();
      }
    },
  };
}
