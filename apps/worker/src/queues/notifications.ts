import {
  NOTIFICATION_JOBS,
  NOTIFICATION_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  notificationJobId,
  notificationJobPayloadSchema,
  sendWebPush,
  type Logger,
  type NotificationJobPayload,
  type PushSubscriptionKeys,
  type Redis,
  type SecretBox,
} from '@balesin/core';
import {
  contacts,
  conversations,
  messages,
  notificationPreferences,
  organizations,
  pushSubscriptions,
  pushVapidKeys,
  userSessions,
  users,
  type Database,
} from '@balesin/db';
import {
  NOTIFICATION_PREVIEW_MAX,
  NOTIFICATION_THROTTLE_SECONDS,
  hasPermission,
  isWithinScope,
  permissionScope,
  rolesWithPermission,
  type PushNotificationPayload,
} from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Antrian `notifications` (Fase 2 butir 10, docs/KONTRAK-API-NOTIFIKASI.md): satu kejadian inbox →
 * Web Push ke penerima yang BERHAK.
 *
 * Penerima ditentukan ulang dari database saat job berjalan (bukan dari pengantre):
 *  - pesan masuk di percakapan `served` → agen pemegangnya (`assignedMessage`);
 *  - pesan masuk / kembali ke antrian di percakapan `unserved` → semua pengguna aktif yang boleh
 *    mengambil chat (`inbox.assign`) kecuali pelaku (`queue`);
 *  - ditugaskan/dialihkan → agen baru bila bukan pelakunya sendiri (`assignedToMe`);
 *  - percakapan `bot`/`resolved` → tidak ada push.
 * Setiap penerima diperiksa: aktif, `inbox.view` dalam cakupan (Teknisi hanya yang di-assign),
 * preferensi + jam tenang (zona waktu organisasi), jeda gabung 30 dtk per pengguna per percakapan.
 *
 * Langganan dipakai hanya bila SESI pendaftarnya masih berlaku (tidak dicabut/kedaluwarsa, 2FA
 * terpenuhi); selain itu langganannya dihapus. Jawaban 404/410 layanan push → dihapus.
 *
 * Isi push: judul + badan singkat. Bawaan TANPA isi pesan (layar kunci); cuplikan hanya bila
 * organisasi mengizinkan (`organizations.notification_preview`). URL hanya path relatif aplikasi.
 * Isi pesan / nama kontak tidak pernah ditulis ke log.
 */

export interface NotificationJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface NotificationJobDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  /** URL aplikasi — `sub` VAPID. */
  appUrl: string;
  /** `true` = boleh kirim (penanda baru dipasang); `false` = masih dalam jeda gabung. */
  throttle: (key: string, seconds: number) => Promise<boolean>;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Origin server push TIRUAN (tes saja). */
  extraOrigins?: readonly string[];
}

export type NotificationJobResult =
  | { status: 'sent'; recipients: number; delivered: number; removed: number }
  | { status: 'skipped'; reason: string };

type PreferenceKey = 'queue' | 'assignedMessage' | 'assignedToMe';

interface Audience {
  conversationId: string | null;
  holderUserId: string | null;
  candidates: string[];
  preference: PreferenceKey | null;
  title: string;
  body: string;
  /** Penerima harus bisa mengambil chat (`inbox.assign`). */
  needsAssign: boolean;
}

const MEDIA_LABELS: Readonly<Record<string, string>> = {
  image: 'Mengirim gambar',
  video: 'Mengirim video',
  audio: 'Mengirim pesan suara',
  document: 'Mengirim dokumen',
  sticker: 'Mengirim stiker',
  location: 'Mengirim lokasi',
  contacts: 'Mengirim kartu kontak',
};
const NO_PREVIEW = 'Buka untuk membaca pesan.';
const NAME_MAX = 60;

function truncate(text: string, max: number): string {
  const points = Array.from(text.replace(/\s+/g, ' ').trim());
  return points.length > max ? `${points.slice(0, max).join('')}…` : points.join('');
}

/** Menit sejak 00:00 di zona waktu organisasi. */
export function localMinute(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  }
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value('hour') * 60 + value('minute');
}

/** Jam tenang `[start, end)`; boleh melewati tengah malam (start > end). */
export function inQuietHours(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

async function claimersOf(
  db: Database,
  organizationId: string,
  excludeUserId: string | undefined,
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        isNull(users.disabledAt),
        inArray(users.role, rolesWithPermission('inbox.assign')),
        excludeUserId === undefined ? undefined : ne(users.id, excludeUserId),
      ),
    );
  return rows.map((row) => row.id);
}

export async function processNotificationJob(
  job: NotificationJob,
  deps: NotificationJobDeps,
): Promise<NotificationJobResult> {
  if (job.name !== NOTIFICATION_JOBS.inbox) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian notifications`);
  }
  const parsed = notificationJobPayloadSchema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError('Payload job notifikasi tidak valid');
  const payload = parsed.data;
  const { db, logger, secretBox } = deps;
  const now = deps.now?.() ?? new Date();
  if (!secretBox) return { status: 'skipped', reason: 'no_master_key' };

  const [org] = await db
    .select({ timezone: organizations.timezone, preview: organizations.notificationPreview })
    .from(organizations)
    .where(eq(organizations.id, payload.organizationId));
  const [vapid] = await db
    .select()
    .from(pushVapidKeys)
    .where(eq(pushVapidKeys.organizationId, payload.organizationId));
  if (!org || !vapid) return { status: 'skipped', reason: 'no_subscribers' };

  const audience = await audienceOf(db, payload, org.preview);
  if (!audience) return { status: 'skipped', reason: 'no_audience' };

  // Penerima yang masih berhak SEKARANG.
  const people = audience.candidates.length
    ? await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(
          and(
            eq(users.organizationId, payload.organizationId),
            inArray(users.id, [...new Set(audience.candidates)]),
            isNull(users.disabledAt),
          ),
        )
    : [];
  const allowed = people.filter((person) => {
    const role = person.role;
    const scope = permissionScope(role, 'inbox.view');
    if (scope === null) return false;
    if (audience.needsAssign && !hasPermission(role, 'inbox.assign')) return false;
    if (audience.conversationId === null) return true;
    return isWithinScope(scope, person.id, {
      holderUserIds: audience.holderUserId ? [audience.holderUserId] : [],
    });
  });
  if (allowed.length === 0) return { status: 'skipped', reason: 'no_audience' };

  const prefs = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.organizationId, payload.organizationId),
        inArray(
          notificationPreferences.userId,
          allowed.map((person) => person.id),
        ),
      ),
    );
  const prefOf = new Map(prefs.map((row) => [row.userId, row]));
  const minute = localMinute(now, org.timezone);
  const recipients: string[] = [];
  for (const person of allowed) {
    const pref = prefOf.get(person.id);
    if (audience.preference) {
      if (pref && !pref[audience.preference]) continue;
      if (
        pref?.quietStartMinute != null &&
        pref.quietEndMinute != null &&
        inQuietHours(minute, pref.quietStartMinute, pref.quietEndMinute)
      ) {
        continue;
      }
    }
    if (audience.conversationId !== null) {
      const fresh = await deps.throttle(
        `${payload.organizationId}:${person.id}:${audience.conversationId}`,
        NOTIFICATION_THROTTLE_SECONDS,
      );
      if (!fresh) continue;
    }
    recipients.push(person.id);
  }
  if (recipients.length === 0) return { status: 'skipped', reason: 'muted' };

  const subscriptions = await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      keysEncrypted: pushSubscriptions.keysEncrypted,
      sessionLive: sql<boolean>`(${userSessions.revokedAt} is null and ${userSessions.idleExpiresAt} > now() and ${userSessions.absoluteExpiresAt} > now() and ${userSessions.kind} = 'standard' and (${users.totpEnabledAt} is null or ${userSessions.twoFactorVerifiedAt} is not null))`,
    })
    .from(pushSubscriptions)
    .innerJoin(userSessions, eq(userSessions.id, pushSubscriptions.sessionId))
    .innerJoin(
      users,
      and(
        eq(users.organizationId, pushSubscriptions.organizationId),
        eq(users.id, pushSubscriptions.userId),
      ),
    )
    .where(
      and(
        eq(pushSubscriptions.organizationId, payload.organizationId),
        inArray(pushSubscriptions.userId, recipients),
        eq(userSessions.userId, pushSubscriptions.userId),
      ),
    );

  const notification: PushNotificationPayload = {
    v: 1,
    title: audience.title,
    body: audience.body,
    url: audience.conversationId
      ? `/inbox?chat=${encodeURIComponent(audience.conversationId)}`
      : '/inbox',
    tag: audience.conversationId ? `chat-${audience.conversationId}` : 'balesin-test',
    conversationId: audience.conversationId,
  };
  const body = Buffer.from(JSON.stringify(notification), 'utf8');
  const vapidKeys = {
    publicKey: vapid.publicKey,
    privateKey: secretBox.decrypt(vapid.privateKeyEncrypted, {
      organizationId: payload.organizationId,
      purpose: 'push_vapid_keys.private_key',
    }),
  };
  const subject = new URL(deps.appUrl).origin;

  let delivered = 0;
  const remove: string[] = [];
  for (const subscription of subscriptions) {
    if (!subscription.sessionLive) {
      remove.push(subscription.id);
      continue;
    }
    let keys: PushSubscriptionKeys;
    try {
      keys = JSON.parse(
        secretBox.decrypt(subscription.keysEncrypted, {
          organizationId: payload.organizationId,
          purpose: 'push_subscriptions.keys',
          subjectId: subscription.userId,
        }),
      ) as PushSubscriptionKeys;
    } catch {
      remove.push(subscription.id);
      continue;
    }
    let result;
    try {
      result = await sendWebPush({
        endpoint: subscription.endpoint,
        keys,
        payload: body,
        vapid: vapidKeys,
        subject,
        ttlSeconds: audience.conversationId ? 60 * 60 : 5 * 60,
        urgency: 'high',
        ...(audience.conversationId ? { topic: audience.conversationId.replaceAll('-', '') } : {}),
        ...(deps.extraOrigins ? { extraOrigins: deps.extraOrigins } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        now,
      });
    } catch {
      remove.push(subscription.id);
      continue;
    }
    if (result.status === 'sent') {
      delivered += 1;
      await db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: now })
        .where(eq(pushSubscriptions.id, subscription.id));
    } else if (
      result.status === 'gone' ||
      (result.status === 'unreachable' && result.reason === 'endpoint')
    ) {
      remove.push(subscription.id);
    } else {
      logger.warn({ subscriptionId: subscription.id, ...result }, 'Notifikasi push tidak terkirim');
    }
  }
  if (remove.length > 0) {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.organizationId, payload.organizationId),
          inArray(pushSubscriptions.id, remove),
        ),
      );
  }
  logger.info(
    { kind: payload.kind, recipients: recipients.length, delivered, removed: remove.length },
    'Notifikasi push diproses',
  );
  return { status: 'sent', recipients: recipients.length, delivered, removed: remove.length };
}

async function audienceOf(
  db: Database,
  payload: NotificationJobPayload,
  preview: boolean,
): Promise<Audience | null> {
  if (payload.kind === 'test') {
    if (!payload.userId) return null;
    return {
      conversationId: null,
      holderUserId: null,
      candidates: [payload.userId],
      preference: null,
      title: 'Notifikasi aktif',
      body: 'Perangkat ini akan menerima pemberitahuan chat.',
      needsAssign: false,
    };
  }
  if (!payload.conversationId) return null;
  const [conversation] = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      assigneeUserId: conversations.assigneeUserId,
      contactName: contacts.name,
      contactProfileName: contacts.profileName,
    })
    .from(conversations)
    .innerJoin(
      contacts,
      and(
        eq(contacts.organizationId, conversations.organizationId),
        eq(contacts.id, conversations.contactId),
      ),
    )
    .where(
      and(
        eq(conversations.organizationId, payload.organizationId),
        eq(conversations.id, payload.conversationId),
      ),
    );
  if (!conversation) return null;
  const name = truncate(
    conversation.contactName ?? conversation.contactProfileName ?? 'pelanggan',
    NAME_MAX,
  );
  const base = { conversationId: conversation.id, holderUserId: conversation.assigneeUserId };

  if (payload.kind === 'message') {
    if (!payload.messageId) return null;
    const [message] = await db
      .select({ type: messages.type, text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, payload.organizationId),
          eq(messages.conversationId, conversation.id),
          eq(messages.id, payload.messageId),
          eq(messages.direction, 'inbound'),
        ),
      );
    if (!message || ['reaction', 'system'].includes(message.type)) return null;
    const body = preview
      ? message.text
        ? truncate(message.text, NOTIFICATION_PREVIEW_MAX)
        : (MEDIA_LABELS[message.type] ?? NO_PREVIEW)
      : NO_PREVIEW;
    const title = `Pesan baru dari ${name}`;
    if (conversation.status === 'served' && conversation.assigneeUserId) {
      return {
        ...base,
        candidates: [conversation.assigneeUserId],
        preference: 'assignedMessage',
        title,
        body,
        needsAssign: false,
      };
    }
    if (conversation.status === 'unserved') {
      return {
        ...base,
        candidates: await claimersOf(db, payload.organizationId, undefined),
        preference: 'queue',
        title,
        body,
        needsAssign: true,
      };
    }
    return null;
  }

  if (payload.kind === 'assigned') {
    const assignee = conversation.assigneeUserId;
    if (conversation.status !== 'served' || !assignee || assignee === payload.actorUserId) {
      return null;
    }
    return {
      ...base,
      candidates: [assignee],
      preference: 'assignedToMe',
      title: 'Chat ditugaskan ke kamu',
      body: `Percakapan dengan ${name}`,
      needsAssign: false,
    };
  }

  // queued
  if (conversation.status !== 'unserved') return null;
  return {
    ...base,
    candidates: await claimersOf(db, payload.organizationId, payload.actorUserId),
    preference: 'queue',
    title: 'Chat menunggu di antrian',
    body: `Percakapan dengan ${name}`,
    needsAssign: true,
  };
}

export function createNotificationWorker(
  options: QueueConnectionOptions,
  deps: NotificationJobDeps,
): Worker {
  return new Worker(QUEUE_NAMES.notifications, (job) => processNotificationJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 5,
  });
}

// ── Produsen (dipakai pemroses webhook: pesan masuk baru) ───────────────────

export interface NotificationProducer {
  /** Usaha terbaik: gagal mengantre hanya dicatat. */
  enqueue(jobs: readonly NotificationJobPayload[]): Promise<void>;
  close(): Promise<void>;
}

export function createNotificationProducer(
  options: QueueConnectionOptions,
  logger: Pick<Logger, 'warn'>,
): NotificationProducer {
  const queue = new Queue(QUEUE_NAMES.notifications, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
  });
  queue.on('error', () => undefined);
  return {
    async enqueue(jobs) {
      if (jobs.length === 0) return;
      try {
        await queue.addBulk(
          jobs.map((job) => {
            const data = notificationJobPayloadSchema.parse(job);
            const jobId = notificationJobId(data);
            return { name: NOTIFICATION_JOBS.inbox, data, opts: jobId ? { jobId } : {} };
          }),
        );
      } catch (err) {
        logger.warn({ err, jobs: jobs.length }, 'Notifikasi tidak terantre');
      }
    },
    close: () => queue.close(),
  };
}

/** Jeda gabung lewat Redis `SET NX EX` (kunci tanpa isi pesan/nama). */
export function redisThrottle(redis: Redis, prefix: string = QUEUE_PREFIX) {
  return async (key: string, seconds: number): Promise<boolean> =>
    (await redis.set(`${prefix}:notif-jeda:${key}`, '1', 'EX', seconds, 'NX')) === 'OK';
}
