import {
  inboxEventsChannel,
  parseInboxBusMessage,
  type InboxBusEvent,
  type Logger,
  type Redis,
} from '@balesin/core';
import { conversations, messages, type Database } from '@balesin/db';
import {
  INBOX_STREAM_CLOSE_CODES,
  INBOX_STREAM_HEARTBEAT_SECONDS,
  isWithinScope,
  permissionScope,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';

import type { SessionService } from '../auth/session.service';

/**
 * Hub WebSocket inbox (Fase 2 butir 5, docs/KONTRAK-API-INBOX.md "Real-time").
 *
 * - Satu langganan Redis pub/sub per proses api (`inboxEventsChannel`). Event bus hanya berisi ID;
 *   hub membaca keadaan TERBARU dari database (terfilter organisasi) lalu mengirimnya hanya ke socket
 *   yang boleh melihat percakapan itu: cakupan `inbox.view` peran pengguna SAAT INI (Teknisi =
 *   `assigned`: hanya bila dia agen percakapan itu). Tidak pernah "siarkan semua, saring di klien".
 * - Isi event minimal: ID + status/penghitung/waktu. Tanpa isi pesan, nama, atau nomor pelanggan.
 * - Validasi ulang setiap `revalidateMs` (bawaan 30 detik, ≤ 60 detik sesuai review akhir Fase 1):
 *   sesi dicabut/kedaluwarsa, akun dinonaktifkan, atau 2FA kini wajib → tutup 4401; peran tidak lagi
 *   memegang `inbox.view` → 4403; peran berubah → cakupan baru langsung dipakai. Validasi ulang
 *   memakai `sessions.peek` (tidak memperpanjang sesi: socket terbuka tidak membuat sesi abadi).
 * - Heartbeat: ping tiap `heartbeatMs`; tanpa pong sampai ping berikutnya → 4408.
 * - Batas `maxConnectionsPerUser` socket per pengguna per proses (tab/perangkat) → 4429.
 * - Klien yang lambat (antrean kirim > `MAX_BUFFERED_BYTES`) diputus supaya memori tidak bocor.
 */

export const DEFAULT_MAX_CONNECTIONS_PER_USER = 10;
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface StreamClient {
  socket: WebSocket;
  userId: string;
  organizationId: string;
  role: UserRole;
  sessionTokenHash: string;
  alive: boolean;
}

export interface InboxStreamHub {
  /** Masih boleh membuka socket baru untuk pengguna ini (dicek sebelum upgrade). */
  canConnect(userId: string): boolean;
  register(
    socket: WebSocket,
    identity: Pick<StreamClient, 'userId' | 'organizationId' | 'role' | 'sessionTokenHash'>,
  ): void;
  /** Mengantar satu event bus ke socket yang berhak (dipakai langganan Redis; publik untuk tes). */
  deliver(event: InboxBusEvent): Promise<number>;
  revalidate(): Promise<void>;
  heartbeat(): void;
  /** Jumlah socket terbuka (semua / satu pengguna). */
  connections(userId?: string): number;
  close(): Promise<void>;
}

export interface InboxStreamHubOptions {
  db: Database;
  sessions: SessionService;
  /** Koneksi Redis induk — hub membuat duplikat khusus subscribe. `null` = tanpa langganan. */
  redis: Redis | null;
  prefix: string;
  logger: Logger;
  heartbeatMs?: number;
  revalidateMs?: number;
  maxConnectionsPerUser?: number;
}

function send(client: StreamClient, event: InboxStreamEvent): boolean {
  if (client.socket.readyState !== client.socket.OPEN) return false;
  if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    client.socket.terminate();
    return false;
  }
  client.socket.send(JSON.stringify(event));
  return true;
}

export function createInboxStreamHub(options: InboxStreamHubOptions): InboxStreamHub {
  const { db, sessions, logger } = options;
  const maxPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;
  const clients = new Set<StreamClient>();
  const byOrganization = new Map<string, Set<StreamClient>>();

  function remove(client: StreamClient) {
    clients.delete(client);
    const group = byOrganization.get(client.organizationId);
    group?.delete(client);
    if (group?.size === 0) byOrganization.delete(client.organizationId);
  }

  function countFor(userId: string): number {
    let count = 0;
    for (const client of clients) if (client.userId === userId) count += 1;
    return count;
  }

  async function payloadFor(event: InboxBusEvent): Promise<{
    assigneeUserId: string | null;
    message: InboxStreamEvent;
  } | null> {
    const [conversation] = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        assigneeUserId: conversations.assigneeUserId,
        unreadCount: conversations.unreadCount,
        lastMessageAt: conversations.lastMessageAt,
        windowExpiresAt: conversations.windowExpiresAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, event.organizationId),
          eq(conversations.id, event.conversationId),
        ),
      )
      .limit(1);
    if (!conversation) return null;
    const { assigneeUserId } = conversation;
    if (event.type === 'conversation.updated') {
      return {
        assigneeUserId,
        message: {
          type: 'conversation.updated',
          conversationId: conversation.id,
          status: conversation.status,
          assigneeUserId,
          unreadCount: conversation.unreadCount,
          lastMessageAt: conversation.lastMessageAt.toISOString(),
          windowExpiresAt: conversation.windowExpiresAt?.toISOString() ?? null,
        },
      };
    }
    if (!event.messageId) return null;
    const [message] = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        status: messages.status,
        occurredAt: messages.occurredAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, event.organizationId),
          eq(messages.conversationId, conversation.id),
          eq(messages.id, event.messageId),
        ),
      )
      .limit(1);
    if (!message) return null;
    if (event.type === 'message.created') {
      return {
        assigneeUserId,
        message: {
          type: 'message.created',
          conversationId: conversation.id,
          messageId: message.id,
          direction: message.direction,
          createdAt: message.occurredAt.toISOString(),
        },
      };
    }
    if (message.status === null) return null;
    return {
      assigneeUserId,
      message: {
        type: 'message.status',
        conversationId: conversation.id,
        messageId: message.id,
        status: message.status,
      },
    };
  }

  const hub: InboxStreamHub = {
    canConnect: (userId) => countFor(userId) < maxPerUser,

    register(socket, identity) {
      const client: StreamClient = { socket, ...identity, alive: true };
      if (countFor(identity.userId) >= maxPerUser) {
        socket.close(INBOX_STREAM_CLOSE_CODES.tooManyConnections, 'Terlalu banyak koneksi');
        return;
      }
      clients.add(client);
      const group = byOrganization.get(client.organizationId) ?? new Set<StreamClient>();
      group.add(client);
      byOrganization.set(client.organizationId, group);
      socket.on('pong', () => {
        client.alive = true;
      });
      // Klien tidak mengirim apa pun yang bermakna; pesan masuk diabaikan (ukurannya dibatasi
      // `maxPayload` plugin).
      socket.on('message', () => undefined);
      socket.on('close', () => remove(client));
      socket.on('error', () => remove(client));
      send(client, { type: 'hello', heartbeatSeconds: INBOX_STREAM_HEARTBEAT_SECONDS });
    },

    async deliver(event) {
      const group = byOrganization.get(event.organizationId);
      if (!group || group.size === 0) return 0;
      const payload = await payloadFor(event);
      if (!payload) return 0;
      let delivered = 0;
      for (const client of group) {
        const scope = permissionScope(client.role, 'inbox.view');
        if (scope === null) continue;
        const holders = payload.assigneeUserId ? [payload.assigneeUserId] : [];
        if (!isWithinScope(scope, client.userId, { holderUserIds: holders })) continue;
        if (send(client, payload.message)) delivered += 1;
      }
      return delivered;
    },

    async revalidate() {
      for (const client of [...clients]) {
        try {
          const session = await sessions.peek(client.sessionTokenHash);
          if (
            !session ||
            session.user.id !== client.userId ||
            session.twoFactor.enrollmentRequired
          ) {
            client.socket.close(INBOX_STREAM_CLOSE_CODES.sessionEnded, 'Sesi berakhir');
            remove(client);
            continue;
          }
          client.role = session.user.role;
          if (permissionScope(client.role, 'inbox.view') === null) {
            client.socket.close(INBOX_STREAM_CLOSE_CODES.forbidden, 'Akses inbox dicabut');
            remove(client);
          }
        } catch (err) {
          // Database sesaat bermasalah: socket dibiarkan, dicoba lagi di putaran berikutnya.
          logger.warn({ err }, 'Validasi ulang socket inbox gagal');
        }
      }
    },

    heartbeat() {
      for (const client of [...clients]) {
        if (!client.alive) {
          client.socket.close(INBOX_STREAM_CLOSE_CODES.heartbeatTimeout, 'Tidak ada respons');
          client.socket.terminate();
          remove(client);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          remove(client);
        }
      }
    },

    connections: (userId) => (userId === undefined ? clients.size : countFor(userId)),

    close() {
      clearInterval(heartbeatTimer);
      clearInterval(revalidateTimer);
      for (const client of [...clients]) {
        client.socket.close(1001, 'Server berhenti');
        remove(client);
      }
      if (subscriber) {
        subscriber.removeAllListeners('message');
        subscriber.disconnect();
      }
      return Promise.resolve();
    },
  };

  const heartbeatTimer = setInterval(
    () => hub.heartbeat(),
    options.heartbeatMs ?? INBOX_STREAM_HEARTBEAT_SECONDS * 1000,
  );
  heartbeatTimer.unref();
  const revalidateTimer = setInterval(() => {
    void hub.revalidate();
  }, options.revalidateMs ?? 30_000);
  revalidateTimer.unref();

  // ── Langganan Redis ──────────────────────────────────────────────────────
  const channel = inboxEventsChannel(options.prefix);
  const subscriber = options.redis ? options.redis.duplicate() : null;
  if (subscriber) {
    let lastErrorLogAt = 0;
    subscriber.on('error', (err: Error) => {
      const now = Date.now();
      if (now - lastErrorLogAt < 30_000) return;
      lastErrorLogAt = now;
      logger.warn({ err }, 'Langganan event inbox (Redis) bermasalah, mencoba sambung ulang');
    });
    // `ready` juga terpancar setelah sambung ulang; SUBSCRIBE idempoten.
    subscriber.on('ready', () => {
      subscriber.subscribe(channel).catch((err: unknown) => {
        logger.warn({ err }, 'Gagal berlangganan event inbox');
      });
    });
    subscriber.on('message', (received: string, raw: string) => {
      if (received !== channel) return;
      const event = parseInboxBusMessage(raw);
      if (!event) return;
      hub.deliver(event).catch((err: unknown) => {
        logger.warn({ err, type: event.type }, 'Event inbox gagal diantar ke socket');
      });
    });
  }

  return hub;
}
