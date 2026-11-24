import { CONVERSATION_DETAIL_SECTIONS, mailStreamEventSchema } from '@balesin/shared';
import { z } from 'zod';

import type { Logger } from './logger';
import { QUEUE_PREFIX } from './queues';
import type { Redis } from './redis';

/**
 * Bus event inbox real-time (Fase 2 butir 5): worker/api → Redis pub/sub → setiap proses api →
 * WebSocket pengguna yang BOLEH melihatnya.
 *
 * Isi pesan Redis HANYA ID (organisasi, percakapan, pesan) + jenis event. Tidak ada isi pesan,
 * nomor, nama, atau BSUID: api membaca keadaan terbaru dari database dan menyaring cakupan per
 * penerima sebelum mengirim apa pun ke browser. Pesan yang tidak lolos skema dibuang penerima.
 *
 * Pub/sub bersifat "paling banyak sekali" — event yang terlewat (api restart, Redis putus) tidak
 * diulang. Klien wajib memuat ulang daftar lewat REST saat tersambung kembali.
 */

export const INBOX_BUS_EVENT_TYPES = [
  'conversation.updated',
  'message.created',
  'message.status',
  /** Bagian panel detail berubah (butir 8) — wajib `section`. */
  'conversation.detail',
  /** Master tag organisasi berubah (butir 8) — TANPA `conversationId`. */
  'tags.changed',
  /** Rem darurat pengiriman ditarik/dilepas (butir 10) — TANPA `conversationId`. */
  'sending.changed',
  /**
   * Percakapan DIHAPUS (hapus kontak, UU PDP) — barisnya sudah tidak ada, jadi hub mengirim
   * `conversation.removed` (ID saja) ke semua socket organisasi yang memegang `inbox.view`.
   */
  'conversation.deleted',
  /**
   * Akses seorang pengguna berubah (departemen/tanda "akses departemen sendiri", Fase 5) — wajib
   * `userId`, TANPA `conversationId`: hub mengirim `resync` ke socket pengguna itu (muat ulang REST).
   */
  'access.changed',
] as const;
export type InboxBusEventType = (typeof INBOX_BUS_EVENT_TYPES)[number];

export const inboxBusEventSchema = z.strictObject({
  v: z.literal(1),
  type: z.enum(INBOX_BUS_EVENT_TYPES),
  organizationId: z.uuid(),
  /** Wajib untuk semua jenis kecuali `tags.changed` (tingkat organisasi). */
  conversationId: z.uuid().optional(),
  /** Wajib untuk `message.*`. */
  messageId: z.uuid().optional(),
  /** Wajib untuk `conversation.detail`. */
  section: z.enum(CONVERSATION_DETAIL_SECTIONS).optional(),
  /**
   * `conversation.updated` karena dialihkan/dikembalikan: agen sebelumnya. Hub mengirim
   * `conversation.removed` kepadanya bila ia tidak lagi boleh melihat percakapan itu.
   */
  previousAssigneeUserId: z.uuid().optional(),
  /**
   * `conversation.updated` karena pindah departemen (Fase 5): departemen sebelumnya. Pengguna bertanda
   * departemen itu yang kini tidak lagi boleh melihatnya menerima `conversation.removed`.
   */
  previousDepartmentId: z.uuid().optional(),
  /** Wajib untuk `access.changed`. */
  userId: z.uuid().optional(),
  /**
   * `conversation.deleted` (tahap 9.0, review R5): channel percakapan yang dihapus — barisnya sudah
   * tidak ada, jadi hub memakai ini untuk akses per channel (`conversation.removed` hanya ke yang
   * boleh melihat channel itu).
   */
  channelId: z.uuid().optional(),
});
export type InboxBusEvent = z.infer<typeof inboxBusEventSchema>;
export type InboxBusEventInput = Omit<InboxBusEvent, 'v'>;

/** Nama channel pub/sub (awalan sama dengan kunci BullMQ; tes memakai awalan sendiri). */
export function inboxEventsChannel(prefix: string = QUEUE_PREFIX): string {
  return `${prefix}:inbox-events`;
}

/** Event yang sama dalam satu batch digabung (mis. dua pembaruan percakapan yang sama). */
export function dedupeInboxEvents(events: readonly InboxBusEventInput[]): InboxBusEventInput[] {
  const seen = new Set<string>();
  const unique: InboxBusEventInput[] = [];
  for (const event of events) {
    const key = `${event.type}|${event.organizationId}|${event.conversationId ?? ''}|${event.messageId ?? ''}|${event.previousAssigneeUserId ?? ''}|${event.section ?? ''}|${event.previousDepartmentId ?? ''}|${event.userId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

export interface InboxEventPublisher {
  /**
   * Menerbitkan event SETELAH transaksi yang membuatnya commit. Tidak pernah melempar: real-time
   * bersifat "usaha terbaik" (gagal = dicatat di log; klien memuat ulang saat tersambung lagi).
   */
  publish(events: readonly InboxBusEventInput[]): Promise<void>;
}

export const NOOP_INBOX_EVENT_PUBLISHER: InboxEventPublisher = {
  publish: () => Promise.resolve(),
};

export function createInboxEventPublisher(
  redis: Redis,
  options: { prefix?: string; logger: Pick<Logger, 'warn'> },
): InboxEventPublisher {
  const channel = inboxEventsChannel(options.prefix);
  return {
    async publish(events) {
      const unique = dedupeInboxEvents(events);
      if (unique.length === 0) return;
      try {
        const pipeline = redis.pipeline();
        for (const event of unique) {
          const message: InboxBusEvent = inboxBusEventSchema.parse({ v: 1, ...event });
          if (!isComplete(message)) throw new Error(`Event inbox ${message.type} tidak lengkap`);
          pipeline.publish(channel, JSON.stringify(message));
        }
        await pipeline.exec();
      } catch (err) {
        options.logger.warn(
          { err, events: unique.length },
          'Event inbox real-time gagal diterbitkan',
        );
      }
    },
  };
}

/** Pesan Redis → event, atau `null` bila bukan event yang sah (dibuang tanpa mencatat isinya). */
export function parseInboxBusMessage(raw: string): InboxBusEvent | null {
  if (raw.length > 2_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = inboxBusEventSchema.safeParse(value);
  if (!parsed.success || !isComplete(parsed.data)) return null;
  return parsed.data;
}

/** Isian wajib per jenis (skema datar supaya pesan Redis tetap kecil & ketat). */
function isComplete(event: InboxBusEvent): boolean {
  switch (event.type) {
    case 'tags.changed':
    case 'sending.changed':
      return event.conversationId === undefined && event.messageId === undefined;
    case 'conversation.updated':
    case 'conversation.deleted':
      return event.conversationId !== undefined;
    case 'conversation.detail':
      return event.conversationId !== undefined && event.section !== undefined;
    case 'message.created':
    case 'message.status':
      return event.conversationId !== undefined && event.messageId !== undefined;
    case 'access.changed':
      return event.userId !== undefined && event.conversationId === undefined;
  }
}

// ── Pencabutan sesi (penutupan socket seketika) ─────────────────────────────

/**
 * Sinyal "sesi/akses pengguna ini mungkin baru dicabut" (logout, cabut sesi, nonaktifkan, ganti
 * peran, atur ulang password/2FA). Hub api memvalidasi ulang socket pengguna itu (atau semua socket
 * organisasi bila `userId` tidak ada) dari database — sinyal palsu hanya memicu pemeriksaan ulang,
 * tidak pernah menutup socket yang sesinya masih sah.
 */
export const sessionRevokedBusEventSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('session.revoked'),
  organizationId: z.uuid(),
  userId: z.uuid().optional(),
});
export type SessionRevokedBusEvent = z.infer<typeof sessionRevokedBusEventSchema>;

export interface SessionRevocationPublisher {
  /** Tidak pernah melempar (usaha terbaik; validasi ulang berkala tetap menutup socket ≤ 30 dtk). */
  publish(event: { organizationId: string; userId?: string | undefined }): Promise<void>;
}

export function createSessionRevocationPublisher(
  redis: Redis,
  options: { prefix?: string; logger: Pick<Logger, 'warn'> },
): SessionRevocationPublisher {
  const channel = inboxEventsChannel(options.prefix);
  return {
    async publish(event) {
      try {
        const message = sessionRevokedBusEventSchema.parse({
          v: 1,
          type: 'session.revoked',
          organizationId: event.organizationId,
          ...(event.userId ? { userId: event.userId } : {}),
        });
        await redis.publish(channel, JSON.stringify(message));
      } catch (err) {
        options.logger.warn({ err }, 'Sinyal pencabutan sesi gagal diterbitkan');
      }
    },
  };
}

/** Pesan Redis → sinyal pencabutan sesi, atau `null`. */
export function parseSessionRevokedMessage(raw: string): SessionRevokedBusEvent | null {
  if (raw.length > 2_000) return null;
  try {
    const parsed = sessionRevokedBusEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── Event modul Email (Fase 9, KONTRAK-API-EMAIL §10) ────────────────────────

/**
 * Event `mail.*` lewat channel pub/sub yang SAMA dengan inbox (satu soket untuk Inbox & Email).
 * Isinya event WS final (ID & angka saja — tanpa subjek/alamat/nama/isi) + organisasi + akun; hub
 * mengirimnya hanya ke soket yang penggunanya punya hak ≥ `read` atas akun itu SAAT ITU
 * (`resolveMailAccess`). `mail.access.changed` membawa `userIds` penerima (tanpa akun).
 */
export const mailBusEventSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('mail'),
  organizationId: z.uuid(),
  accountId: z.uuid().optional(),
  userIds: z.array(z.uuid()).max(1_000).optional(),
  event: mailStreamEventSchema,
});
export type MailBusEvent = z.infer<typeof mailBusEventSchema>;
export type MailBusEventInput = Omit<MailBusEvent, 'v' | 'type'>;

function mailEventComplete(event: MailBusEvent): boolean {
  if (event.event.type === 'mail.access.changed') {
    return event.accountId === undefined && (event.userIds?.length ?? 0) > 0;
  }
  return event.accountId !== undefined && event.event.accountId === event.accountId;
}

export interface MailEventPublisher {
  /** Setelah commit. Tidak pernah melempar (kegagalan Redis tidak menggagalkan sinkron/permintaan). */
  publish(events: readonly MailBusEventInput[]): Promise<void>;
}

export const NOOP_MAIL_EVENT_PUBLISHER: MailEventPublisher = { publish: () => Promise.resolve() };

export function createMailEventPublisher(
  redis: Redis,
  options: { prefix?: string; logger: Pick<Logger, 'warn'> },
): MailEventPublisher {
  const channel = inboxEventsChannel(options.prefix);
  return {
    async publish(events) {
      if (events.length === 0) return;
      try {
        const pipeline = redis.pipeline();
        for (const input of events) {
          const message = mailBusEventSchema.parse({ v: 1, type: 'mail', ...input });
          if (!mailEventComplete(message)) throw new Error('Event email tidak lengkap');
          pipeline.publish(channel, JSON.stringify(message));
        }
        await pipeline.exec();
      } catch (err) {
        options.logger.warn(
          { err, events: events.length },
          'Event email real-time gagal diterbitkan',
        );
      }
    },
  };
}

/** Pesan Redis → event email, atau `null` (bukan event email / tidak sah). */
export function parseMailBusMessage(raw: string): MailBusEvent | null {
  if (raw.length > 64_000 || !raw.includes('"type":"mail"')) return null;
  try {
    const parsed = mailBusEventSchema.safeParse(JSON.parse(raw));
    return parsed.success && mailEventComplete(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}
