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
] as const;
export type InboxBusEventType = (typeof INBOX_BUS_EVENT_TYPES)[number];

export const inboxBusEventSchema = z.strictObject({
  v: z.literal(1),
  type: z.enum(INBOX_BUS_EVENT_TYPES),
  organizationId: z.uuid(),
  conversationId: z.uuid(),
  /** Wajib untuk `message.*`. */
  messageId: z.uuid().optional(),
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
    const key = `${event.type}|${event.organizationId}|${event.conversationId}|${event.messageId ?? ''}`;
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
  if (!parsed.success) return null;
  if (parsed.data.type !== 'conversation.updated' && parsed.data.messageId === undefined) {
    return null;
  }
  return parsed.data;
}
