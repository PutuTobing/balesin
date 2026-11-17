import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOK_JOBS,
  WebhookPayloadError,
  normalizeInboundMessage,
  normalizeStatusUpdate,
  normalizeWebhookFailure,
  webhookEventJobPayloadSchema,
  NOOP_INBOX_EVENT_PUBLISHER,
  type InboxBusEventInput,
  type InboxEventPublisher,
  type Logger,
  type NormalizedInboundMessage,
  type NormalizedStatusUpdate,
  type NormalizedWebhookFailure,
  type StoredOtherEvent,
  type WebhookEventJobResult,
} from '@balesin/core';
import {
  applyTemplateUpdate,
  channels,
  webhookEvents,
  type Database,
  type DbExecutor,
  type WebhookEvent,
} from '@balesin/db';
import { UnrecoverableError, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { createInboundHandlers } from '../inbound/handlers';
import type { NotificationProducer } from './notifications';
import type { QueueConnectionOptions } from './system';

/**
 * Pemroses antrian `webhooks`: satu job = satu baris `webhook_events` (payload job hanya ID).
 *
 * Untuk butir ini pemrosesannya: membaca payload tersimpan (sudah divalidasi penerima), menormalisasi
 * ke bentuk internal (`@balesin/core` `normalizeInboundMessage` / `normalizeStatusUpdate` /
 * `normalizeWebhookFailure`), meneruskannya ke `InboundEventHandlers`, lalu menandai baris
 * `processed`. Gagal → `attempts` + `last_error` (kode singkat), diulang BullMQ dengan jeda
 * eksponensial (`WEBHOOK_JOB_OPTIONS`); percobaan terakhir / payload rusak → `failed`.
 *
 * Idempoten: baris dikunci (`FOR UPDATE`) dan hanya `pending` yang diproses, jadi job ganda (Meta
 * mengirim ulang setelah job lama dibersihkan, atau dua worker) tidak memproses dua kali.
 *
 * Channel diperiksa ulang DI TRANSAKSI YANG SAMA (review webhook R3, baris channel dikunci
 * `FOR SHARE` supaya tidak dinonaktifkan di tengah pemrosesan): kejadian `pending` untuk channel
 * yang sudah dinonaktifkan/dihapus sejak diterima → `skipped` + `last_error = 'channel_inactive'`,
 * tanpa handler. Channel yang sengaja dimatikan karena insiden tidak "hidup lagi" lewat antrean lama.
 *
 * Pemroses kejadian = `InboundEventHandlers` (bawaan `createInboundHandlers` di `../inbound/handlers`:
 * kontak, percakapan, pesan, jendela 24 jam, status pesan keluar). Handler berjalan DI DALAM transaksi
 * yang sama dengan penandaan `processed` — upsert kontak/percakapan/pesan ikut batal bila handler
 * gagal, dan diulang utuh. Pekerjaan lambat/eksternal (unduh media dari Graph API, siaran WebSocket,
 * kirim ke bot) JANGAN dijalankan di dalam transaksi ini: antrekan job tersendiri dari handler (ID saja).
 *
 * N1 (review webhook): transaksi ini memegang `FOR SHARE` pada baris channel. Handler TIDAK BOLEH
 * meng-`UPDATE channels` (dua worker yang sama-sama memegang kunci bersama lalu meminta kunci
 * eksklusif = deadlock). Perbarui data channel lewat job terpisah.
 */

export interface InboundEventContext {
  organizationId: string;
  channelId: string;
  eventId: string;
  /**
   * Waktu diterima menurut jam SERVER. Jendela 24 jam / SLA wajib memakai ini, bukan cap waktu dari
   * payload Meta (review webhook R4).
   */
  receivedAt: Date;
  /** Transaksi yang mengunci baris kejadian. */
  tx: DbExecutor;
  logger: Logger;
  /**
   * Mencatat event real-time (ID saja). Diterbitkan ke Redis SETELAH transaksi commit — event dari
   * transaksi yang batal tidak pernah terkirim.
   */
  emit(event: InboxBusEventInput): void;
}

export interface InboundEventHandlers {
  /** Pesan masuk dari pelanggan. */
  message(message: NormalizedInboundMessage, context: InboundEventContext): Promise<void>;
  /** Status pesan keluar (sent/delivered/read/played/failed). */
  status(status: NormalizedStatusUpdate, context: InboundEventContext): Promise<void>;
  /** Error tingkat sistem/aplikasi/akun dari Meta. */
  error(failure: NormalizedWebhookFailure, context: InboundEventContext): Promise<void>;
}

/** Pemroses kosong (untuk tes yang hanya menguji alur antrean/penandaan). */
export const PENDING_INBOUND_HANDLERS: InboundEventHandlers = {
  message: () => Promise.resolve(),
  status: () => Promise.resolve(),
  error: () => Promise.resolve(),
};

const DEFAULT_HANDLERS = createInboundHandlers();

export interface WebhookJob {
  id?: string;
  name: string;
  data: unknown;
  /** Percobaan yang sudah GAGAL sebelum ini (BullMQ). */
  attemptsMade?: number;
  opts?: { attempts?: number };
}

export interface WebhookJobDeps {
  db: Database;
  logger: Logger;
  handlers?: InboundEventHandlers;
  now?: () => Date;
  /** Penerbit event inbox real-time (bawaan: tidak menerbitkan apa pun). */
  publisher?: InboxEventPublisher;
  /** Pengantre notifikasi push untuk pesan masuk baru (butir 10). */
  notifications?: Pick<NotificationProducer, 'enqueue'>;
}

/** `last_error` + alasan hasil job bila channel sudah nonaktif/dihapus saat diproses (R3). */
const CHANNEL_INACTIVE = 'channel_inactive';

/** Kode kesalahan singkat untuk `last_error` — TIDAK PERNAH pesan mentah (bisa memuat isi pesan). */
export function errorCodeOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error';
  const codeOf = (value: unknown): string | null => {
    const code = (value as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' ? code : null;
  };
  // Error Postgres (langsung, atau dibungkus `DrizzleQueryError` sebagai `cause`).
  const pgCode = codeOf(error) ?? codeOf((error as { cause?: unknown }).cause);
  const name = /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name) ? error.name : 'Error';
  return (pgCode && /^[0-9A-Z]{5}$/.test(pgCode) ? `${name}:${pgCode}` : name).slice(0, 200);
}

async function dispatch(
  event: WebhookEvent,
  handlers: InboundEventHandlers,
  context: InboundEventContext,
): Promise<boolean> {
  switch (event.kind) {
    case 'message':
      await handlers.message(normalizeInboundMessage(event.payload), context);
      return true;
    case 'status':
      await handlers.status(normalizeStatusUpdate(event.payload), context);
      return true;
    case 'error':
      await handlers.error(normalizeWebhookFailure(event.payload), context);
      return true;
    default: {
      // Pembaruan template (status / kualitas / kategori, Fase 4) — field lain belum punya pemroses.
      const stored = event.payload as Partial<StoredOtherEvent>;
      if (event.kind !== 'other' || !stored.template || !stored.wabaId) return false;
      const changed = await applyTemplateUpdate(context.tx, {
        organizationId: context.organizationId,
        wabaId: stored.wabaId,
        metaTemplateId: stored.template.metaTemplateId,
        event: stored.template.event,
        reason: stored.template.reason,
        quality: stored.template.quality,
        category: stored.template.category,
        now: context.receivedAt,
      });
      context.logger.info(
        { eventId: context.eventId, changed },
        'Pembaruan status template dari Meta diterapkan',
      );
      return true;
    }
  }
}

export async function processWebhookJob(
  job: WebhookJob,
  deps: WebhookJobDeps,
): Promise<WebhookEventJobResult> {
  if (job.name !== WEBHOOK_JOBS.whatsappEvent) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian webhooks`);
  }
  const payload = webhookEventJobPayloadSchema.safeParse(job.data);
  if (!payload.success) throw new UnrecoverableError('Payload job webhooks tidak valid');
  const { organizationId, eventId } = payload.data;
  const { db, logger } = deps;
  const handlers = deps.handlers ?? DEFAULT_HANDLERS;
  const now = deps.now ?? (() => new Date());
  const where = and(
    eq(webhookEvents.organizationId, organizationId),
    eq(webhookEvents.id, eventId),
  );

  const emitted: InboxBusEventInput[] = [];
  try {
    const result = await db.transaction(async (tx) => {
      const [event] = await tx.select().from(webhookEvents).where(where).limit(1).for('update');
      if (!event) return { status: 'skipped', reason: 'not_found' } as const;
      if (event.status !== 'pending') return { status: 'skipped', reason: 'already_done' } as const;

      const [channel] = await tx
        .select({ enabled: channels.enabled, deletedAt: channels.deletedAt })
        .from(channels)
        .where(and(eq(channels.organizationId, organizationId), eq(channels.id, event.channelId)))
        .limit(1)
        .for('share');
      if (!channel || !channel.enabled || channel.deletedAt !== null) {
        await tx
          .update(webhookEvents)
          .set({
            status: 'skipped',
            attempts: sql`${webhookEvents.attempts} + 1`,
            lastError: CHANNEL_INACTIVE,
            processedAt: now(),
          })
          .where(where);
        logger.info(
          { eventId, kind: event.kind, channelId: event.channelId },
          'Kejadian webhook dilewati: channel sudah nonaktif atau dihapus',
        );
        return { status: 'skipped', reason: CHANNEL_INACTIVE } as const;
      }

      const handled = await dispatch(event, handlers, {
        organizationId,
        channelId: event.channelId,
        eventId,
        receivedAt: event.receivedAt,
        tx,
        logger,
        emit: (inboxEvent) => emitted.push(inboxEvent),
      });
      await tx
        .update(webhookEvents)
        .set({
          status: handled ? 'processed' : 'skipped',
          attempts: sql`${webhookEvents.attempts} + 1`,
          lastError: null,
          processedAt: now(),
        })
        .where(where);
      logger.debug(
        { eventId, kind: event.kind, channelId: event.channelId },
        'Kejadian webhook diproses',
      );
      return handled
        ? ({ status: 'processed' } as const)
        : ({ status: 'skipped', reason: 'unhandled' } as const);
    });
    // Sesudah commit. Tidak pernah melempar (real-time = usaha terbaik).
    await (deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER).publish(emitted);
    // Pesan masuk baru → notifikasi push (penerima ditentukan worker notifikasi). Hanya ID.
    await deps.notifications?.enqueue(
      emitted.flatMap((inboxEvent) =>
        inboxEvent.type === 'message.created' &&
        inboxEvent.conversationId !== undefined &&
        inboxEvent.messageId !== undefined
          ? [
              {
                organizationId: inboxEvent.organizationId,
                kind: 'message' as const,
                conversationId: inboxEvent.conversationId,
                messageId: inboxEvent.messageId,
              },
            ]
          : [],
      ),
    );
    return result;
  } catch (error) {
    const permanent = error instanceof WebhookPayloadError;
    const maxAttempts = job.opts?.attempts ?? 1;
    const finalAttempt = permanent || (job.attemptsMade ?? 0) + 1 >= maxAttempts;
    const lastError = errorCodeOf(error);
    try {
      await db
        .update(webhookEvents)
        .set({
          status: finalAttempt ? 'failed' : 'pending',
          attempts: sql`${webhookEvents.attempts} + 1`,
          lastError,
        })
        .where(and(where, eq(webhookEvents.status, 'pending')));
    } catch (recordError) {
      logger.error({ err: recordError, eventId }, 'Kegagalan kejadian webhook tidak bisa dicatat');
    }
    // Tanpa pesan error mentah: isi pesan pelanggan bisa ikut di dalamnya (mis. nilai query).
    logger.warn(
      { eventId, lastError, attemptsMade: (job.attemptsMade ?? 0) + 1, final: finalAttempt },
      'Kejadian webhook gagal diproses',
    );
    if (permanent) throw new UnrecoverableError('Payload kejadian webhook tidak valid');
    // Pesan BARU (hanya kode): BullMQ menyimpan `failedReason` di Redis, dan pesan error query
    // Drizzle memuat nilai parameter (isi pesan pelanggan).
    throw new Error(`Kejadian webhook gagal diproses (${lastError})`, { cause: error });
  }
}

export function createWebhookWorker(options: QueueConnectionOptions, deps: WebhookJobDeps): Worker {
  return new Worker(QUEUE_NAMES.webhooks, (job) => processWebhookJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 10,
  });
}
