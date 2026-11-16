import {
  inboxEventsChannel,
  parseInboxBusMessage,
  parseSessionRevokedMessage,
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
 * - Sinyal `session.revoked` (logout/cabut/nonaktifkan/ganti peran) → socket pengguna itu diperiksa
 *   ulang 250 ms & 2 detik kemudian (tutup seketika). Putaran berkala tidak pernah tumpang tindih.
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
  /** Sinyal pencabutan sesi: validasi ulang socket pengguna/organisasi itu sesaat lagi. */
  onSessionRevoked(event: { organizationId: string; userId?: string | undefined }): void;
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
  /** Jeda pemeriksaan ulang setelah sinyal `session.revoked` (bawaan 250 ms dan 2 detik). */
  sessionRecheckDelaysMs?: readonly number[];
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

  let revalidating: Promise<void> | null = null;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const sessionRecheckDelays = options.sessionRecheckDelaysMs ?? [250, 2_000];

  /**
   * Pemeriksaan karena sinyal, per kunci (organisasi|pengguna), TIDAK tumpang tindih (review
   * real-time putaran 2 Info 2): sinyal yang datang saat pemeriksaan kunci yang sama berjalan cukup
   * menandai "ulangi sekali lagi" — banjir sinyal tidak menjadi banjir query.
   */
  const signalChecks = new Map<string, { again: boolean }>();
  async function checkOnce(key: string, match: (client: StreamClient) => boolean): Promise<void> {
    const running = signalChecks.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    signalChecks.set(key, state);
    try {
      do {
        state.again = false;
        await checkClients(match);
      } while (state.again);
    } finally {
      signalChecks.delete(key);
    }
  }

  /** Validasi ulang socket yang cocok (sesi, 2FA, peran) — dipakai berkala dan saat sinyal. */
  async function checkClients(match: (client: StreamClient) => boolean): Promise<void> {
    for (const client of [...clients]) {
      if (!match(client) || !clients.has(client)) continue;
      try {
        const session = await sessions.peek(client.sessionTokenHash);
        if (!session || session.user.id !== client.userId || session.twoFactor.enrollmentRequired) {
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
        const holders = payload.assigneeUserId ? [payload.assigneeUserId] : [];
        if (scope !== null && isWithinScope(scope, client.userId, { holderUserIds: holders })) {
          if (send(client, payload.message)) delivered += 1;
          continue;
        }
        // Agen sebelumnya yang kehilangan akses (mis. Teknisi yang percakapannya dialihkan): hanya
        // ID, supaya web menutup panel dan membuang cache-nya.
        if (
          event.type === 'conversation.updated' &&
          event.previousAssigneeUserId !== undefined &&
          client.userId === event.previousAssigneeUserId
        ) {
          send(client, { type: 'conversation.removed', conversationId: event.conversationId });
        }
      }
      return delivered;
    },

    revalidate() {
      // R2 (review real-time): putaran tidak pernah tumpang tindih — pemanggil berikutnya
      // menunggu putaran yang sedang berjalan.
      if (revalidating) return revalidating;
      revalidating = checkClients(() => true).finally(() => {
        revalidating = null;
      });
      return revalidating;
    },

    onSessionRevoked(event) {
      const matches = (client: StreamClient) =>
        client.organizationId === event.organizationId &&
        (event.userId === undefined || client.userId === event.userId);
      if (![...clients].some(matches)) return;
      // Sinyal diterbitkan dari dalam transaksi pencabutan (belum tentu sudah commit): periksa lagi
      // beberapa saat kemudian. Sinyal palsu hanya memicu pemeriksaan, tidak pernah menutup sesi sah.
      const key = `${event.organizationId}|${event.userId ?? '*'}`;
      for (const delay of sessionRecheckDelays) {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          void checkOnce(key, matches);
        }, delay);
        timer.unref();
        pendingTimers.add(timer);
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
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
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
      const revoked = parseSessionRevokedMessage(raw);
      if (revoked) {
        hub.onSessionRevoked(revoked);
        return;
      }
      const event = parseInboxBusMessage(raw);
      if (!event) return;
      hub.deliver(event).catch((err: unknown) => {
        logger.warn({ err, type: event.type }, 'Event inbox gagal diantar ke socket');
      });
    });
  }

  return hub;
}
