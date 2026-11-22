import {
  inboxEventsChannel,
  parseInboxBusMessage,
  parseMailBusMessage,
  parseSessionRevokedMessage,
  type InboxBusEvent,
  type MailBusEvent,
  type Logger,
  type Redis,
} from '@balesin/core';
import {
  channelAccessOf,
  conversations,
  departmentAccessOf,
  mailAccessIndexOf,
  messages,
  openTicketHoldersOf,
  organizations,
  type ChannelAccessIndex,
  type Database,
  type DepartmentAccess,
} from '@balesin/db';
import {
  INBOX_STREAM_CLOSE_CODES,
  INBOX_STREAM_HEARTBEAT_SECONDS,
  effectivePermissionScope,
  isWithinScope,
  permissionScope,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { and, eq, inArray } from 'drizzle-orm';
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
  /** Mengantar satu event bus ke socket yang berhak (publik untuk tes; tanpa penggabungan). */
  deliver(event: InboxBusEvent): Promise<number>;
  /**
   * Mengantar SEKUMPULAN event (satu jendela penggabungan): dedupe, `message.status` massal digabung
   * ke `conversation.updated`, keadaan dibaca dengan satu query `IN (…)` per jenis, batas laju per
   * organisasi (lebih → `resync`). Dipakai langganan Redis.
   */
  deliverBatch(events: readonly InboxBusEvent[]): Promise<number>;
  /**
   * Fase 9 (modul Email, KONTRAK-API-EMAIL §10): event `mail.*` hanya ke soket yang penggunanya
   * punya hak ≥ `read` atas akunnya SAAT ITU (`resolveMailAccess`, dibaca segar per batch); akun
   * pribadi → hanya pemiliknya. Maks. `maxMailEventsPerSecond` per akun, lebih → satu `mail.resync`
   * per 5 dtk. `mail.access.changed` hanya ke pengguna yang disebut. Publik untuk tes.
   */
  deliverMail(events: readonly MailBusEvent[]): Promise<number>;
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
  /** Jendela penggabungan event dari Redis (bawaan 250 ms; 0 = langsung, untuk tes). */
  coalesceMs?: number;
  /** Batas event per organisasi per detik; lebih dari itu → event dibuang + satu `resync`. */
  maxEventsPerSecond?: number;
  /** `message.status` per organisasi per batch di atas angka ini digabung ke `conversation.updated`. */
  statusMergeThreshold?: number;
  /** Batas event `mail.*` per akun per detik (bawaan 50). */
  maxMailEventsPerSecond?: number;
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

  interface Payload {
    /** `undefined` = event tingkat organisasi (semua pemegang `inbox.view`). */
    assigneeUserId: string | null | undefined;
    /** Fase 5: departemen percakapan + pemegang tiket terbuka yang menaut kontaknya. */
    departmentId?: string | null;
    ticketHolderUserIds?: readonly string[];
    /** Tahap 9.0: channel percakapan (akses per channel). */
    channelId?: string;
    message: InboxStreamEvent;
  }

  /**
   * Keadaan terbaru untuk SEKUMPULAN event SATU organisasi: satu query percakapan `IN (…)`, satu
   * query pesan `IN (…)`, satu query organisasi (syarat broadcast Fase 4, review real-time R2).
   */
  async function payloadsFor(
    organizationId: string,
    events: readonly InboxBusEvent[],
  ): Promise<{ event: InboxBusEvent; payload: Payload }[]> {
    const conversationIds = [
      ...new Set(
        events
          .filter((event) => event.type !== 'conversation.deleted')
          .map((event) => event.conversationId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const messageIds = [
      ...new Set(
        events
          .filter((event) => event.type === 'message.created' || event.type === 'message.status')
          .map((event) => event.messageId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const conversationRows = conversationIds.length
      ? await db
          .select({
            id: conversations.id,
            status: conversations.status,
            assigneeUserId: conversations.assigneeUserId,
            contactId: conversations.contactId,
            channelId: conversations.channelId,
            departmentId: conversations.departmentId,
            createdAt: conversations.createdAt,
            unreadCount: conversations.unreadCount,
            lastMessageAt: conversations.lastMessageAt,
            windowExpiresAt: conversations.windowExpiresAt,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, organizationId),
              inArray(conversations.id, conversationIds),
            ),
          )
      : [];
    const byConversation = new Map(conversationRows.map((row) => [row.id, row]));
    // Fase 5: Teknisi pemegang tiket terbuka yang menaut kontak ikut menerima event percakapannya.
    const ticketHolders = await openTicketHoldersOf(db, organizationId, conversationRows);
    const messageRows = messageIds.length
      ? await db
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            direction: messages.direction,
            status: messages.status,
            occurredAt: messages.occurredAt,
          })
          .from(messages)
          .where(and(eq(messages.organizationId, organizationId), inArray(messages.id, messageIds)))
      : [];
    const byMessage = new Map(messageRows.map((row) => [row.id, row]));
    let paused: boolean | null = null;
    if (events.some((event) => event.type === 'sending.changed')) {
      const [org] = await db
        .select({ pausedAt: organizations.sendingPausedAt })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      paused = org ? org.pausedAt !== null : null;
    }

    const payloadOf = (event: InboxBusEvent): Payload | null => {
      if (event.type === 'tags.changed') {
        return { assigneeUserId: undefined, message: { type: 'tags.changed' } };
      }
      if (event.type === 'sending.changed') {
        return paused === null
          ? null
          : { assigneeUserId: undefined, message: { type: 'sending.changed', paused } };
      }
      if (event.conversationId === undefined) return null;
      if (event.type === 'conversation.deleted') {
        // Barisnya sudah dihapus: cakupan memakai agen pemegang TERAKHIR yang dibawa event
        // (Teknisi lain tidak mendapat ID percakapan yang bukan miliknya).
        return {
          assigneeUserId: event.previousAssigneeUserId ?? null,
          // Tahap 9.0 (review R5): channel dari event (baris sudah terhapus).
          ...(event.channelId ? { channelId: event.channelId } : {}),
          message: { type: 'conversation.removed', conversationId: event.conversationId },
        };
      }
      const conversation = byConversation.get(event.conversationId);
      if (!conversation) return null;
      const { assigneeUserId } = conversation;
      if (event.type === 'conversation.detail') {
        if (event.section === undefined) return null;
        return {
          assigneeUserId,
          message: {
            type: 'conversation.detail',
            conversationId: conversation.id,
            section: event.section,
          },
        };
      }
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
      const message = event.messageId ? byMessage.get(event.messageId) : undefined;
      if (!message || message.conversationId !== conversation.id) return null;
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
    };

    const result: { event: InboxBusEvent; payload: Payload }[] = [];
    for (const event of events) {
      const payload = payloadOf(event);
      if (!payload) continue;
      const conversation =
        event.conversationId === undefined ? undefined : byConversation.get(event.conversationId);
      if (conversation && event.type !== 'conversation.deleted') {
        payload.departmentId = conversation.departmentId;
        payload.ticketHolderUserIds = ticketHolders.get(conversation.id) ?? [];
        payload.channelId = conversation.channelId;
      }
      result.push({ event, payload });
    }
    return result;
  }

  function sendToGroup(
    group: Set<StreamClient>,
    event: InboxBusEvent,
    payload: Payload,
    access: ReadonlyMap<string, DepartmentAccess>,
    channelAccess: ChannelAccessIndex,
  ): number {
    let delivered = 0;
    for (const client of group) {
      const clientAccess = access.get(client.userId);
      const scope = effectivePermissionScope(client.role, 'inbox.view', {
        departmentRestricted: clientAccess?.restricted ?? false,
      });
      const holders = payload.assigneeUserId ? [payload.assigneeUserId] : [];
      // Tahap 9.0: irisan dengan akses per channel (Owner/Admin selalu lolos).
      const channelAllowed =
        payload.channelId === undefined || channelAccess.allows(client.userId, payload.channelId);
      const visible =
        scope !== null &&
        channelAllowed &&
        (payload.assigneeUserId === undefined ||
          isWithinScope(
            scope,
            client.userId,
            {
              holderUserIds: holders,
              linkedTicketHolderUserIds: payload.ticketHolderUserIds ?? [],
              departmentId: payload.departmentId ?? null,
            },
            clientAccess?.departmentIds ?? [],
          ));
      if (visible) {
        if (send(client, payload.message)) delivered += 1;
        continue;
      }
      // Fase 5: percakapan pindah departemen → pengguna bertanda departemen LAMA yang kini tidak
      // lagi boleh melihatnya menerima ID saja (review Fase 5 Info 2).
      if (
        event.type === 'conversation.updated' &&
        event.conversationId !== undefined &&
        event.previousDepartmentId !== undefined &&
        channelAllowed &&
        clientAccess?.restricted === true &&
        clientAccess.departmentIds.includes(event.previousDepartmentId)
      ) {
        send(client, { type: 'conversation.removed', conversationId: event.conversationId });
        continue;
      }
      // Agen sebelumnya yang kehilangan akses (mis. Teknisi yang percakapannya dialihkan): hanya
      // ID, supaya web menutup panel dan membuang cache-nya.
      if (
        event.type === 'conversation.updated' &&
        event.conversationId !== undefined &&
        event.previousAssigneeUserId !== undefined &&
        client.userId === event.previousAssigneeUserId &&
        // Review 9.0 R5: ID percakapan channel terlarang tidak dikirim (pencabutan akses channel
        // sendiri sudah memicu `resync` lewat `access.changed`).
        channelAllowed
      ) {
        send(client, { type: 'conversation.removed', conversationId: event.conversationId });
      }
    }
    return delivered;
  }

  // ── Penggabungan & batas laju per organisasi (syarat broadcast Fase 4) ──────
  const coalesceMs = options.coalesceMs ?? 250;
  const maxPerSecond = options.maxEventsPerSecond ?? 200;
  const statusMergeThreshold = options.statusMergeThreshold ?? 20;
  const rate = new Map<string, { windowStart: number; count: number; lastResync: number }>();
  const pending = new Map<string, InboxBusEvent[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function eventKey(event: InboxBusEvent): string {
    return `${event.type}|${event.conversationId ?? ''}|${event.messageId ?? ''}|${event.previousAssigneeUserId ?? ''}|${event.section ?? ''}|${event.previousDepartmentId ?? ''}|${event.userId ?? ''}`;
  }

  async function deliverOrganization(
    organizationId: string,
    events: readonly InboxBusEvent[],
  ): Promise<number> {
    const group = byOrganization.get(organizationId);
    if (!group || group.size === 0) return 0;
    const seen = new Set<string>();
    let unique = events.filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Banyak status pesan sekaligus (mis. broadcast): digabung ke pembaruan percakapannya.
    const statuses = unique.filter((event) => event.type === 'message.status');
    if (statuses.length > statusMergeThreshold) {
      const merged = new Set(
        unique
          .filter((event) => event.type === 'conversation.updated')
          .map((event) => event.conversationId),
      );
      const extra: InboxBusEvent[] = [];
      for (const event of statuses) {
        if (event.conversationId && !merged.has(event.conversationId)) {
          merged.add(event.conversationId);
          extra.push({
            v: 1,
            type: 'conversation.updated',
            organizationId,
            conversationId: event.conversationId,
          });
        }
      }
      unique = [...unique.filter((event) => event.type !== 'message.status'), ...extra];
    }
    // Batas laju: kelebihan dibuang dan diganti SATU sinyal `resync` (klien memuat ulang lewat REST).
    const nowMs = Date.now();
    const state = rate.get(organizationId) ?? { windowStart: nowMs, count: 0, lastResync: 0 };
    if (nowMs - state.windowStart >= 1_000) {
      state.windowStart = nowMs;
      state.count = 0;
    }
    rate.set(organizationId, state);
    let delivered = 0;
    if (state.count + unique.length > maxPerSecond) {
      state.count = maxPerSecond;
      if (nowMs - state.lastResync >= 2_000) {
        state.lastResync = nowMs;
        for (const client of group) {
          if (
            permissionScope(client.role, 'inbox.view') !== null &&
            send(client, { type: 'resync' })
          ) {
            delivered += 1;
          }
        }
      }
      // Event tingkat organisasi (rem darurat, tag) tetap diantar.
      unique = unique.filter(
        (event) => event.type === 'sending.changed' || event.type === 'tags.changed',
      );
    } else {
      state.count += unique.length;
    }
    // Fase 5: akses pengguna berubah (departemen) → `resync` ke socket pengguna itu saja.
    const accessChanged = new Set(
      unique.filter((event) => event.type === 'access.changed').map((event) => event.userId),
    );
    if (accessChanged.size > 0) {
      for (const client of group) {
        if (accessChanged.has(client.userId) && send(client, { type: 'resync' })) delivered += 1;
      }
      unique = unique.filter((event) => event.type !== 'access.changed');
    }
    const payloads = await payloadsFor(organizationId, unique);
    // Fase 5: tanda & departemen pengguna dibaca SEGAR per batch (satu query untuk semua socket).
    const access = payloads.length
      ? await departmentAccessOf(
          db,
          organizationId,
          [...group].map((client) => client.userId),
        )
      : new Map<string, DepartmentAccess>();
    // Tahap 9.0: akses per channel, juga dibaca segar per batch (satu query bila tanpa channel terbatas).
    const channelAccess = payloads.length
      ? await channelAccessOf(
          db,
          organizationId,
          [...group].map((client) => client.userId),
        )
      : { allows: () => true };
    for (const { event, payload } of payloads) {
      delivered += sendToGroup(group, event, payload, access, channelAccess);
    }
    return delivered;
  }

  async function deliverBatch(events: readonly InboxBusEvent[]): Promise<number> {
    const byOrg = new Map<string, InboxBusEvent[]>();
    for (const event of events) {
      const list = byOrg.get(event.organizationId) ?? [];
      list.push(event);
      byOrg.set(event.organizationId, list);
    }
    let delivered = 0;
    for (const [organizationId, list] of byOrg) {
      delivered += await deliverOrganization(organizationId, list);
    }
    return delivered;
  }

  function flushPending() {
    flushTimer = null;
    const batch = [...pending.values()].flat();
    pending.clear();
    if (batch.length === 0) return;
    deliverBatch(batch).catch((err: unknown) => {
      logger.warn({ err, events: batch.length }, 'Event inbox gagal diantar ke socket');
    });
  }

  function enqueue(event: InboxBusEvent) {
    if (!byOrganization.has(event.organizationId)) return;
    if (coalesceMs <= 0) {
      deliverBatch([event]).catch((err: unknown) => {
        logger.warn({ err, type: event.type }, 'Event inbox gagal diantar ke socket');
      });
      return;
    }
    const list = pending.get(event.organizationId) ?? [];
    // Batas memori antrean gabungan per organisasi (kelebihan pasti melewati batas laju → resync).
    if (list.length < maxPerSecond * 2) list.push(event);
    pending.set(event.organizationId, list);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPending, coalesceMs);
      flushTimer.unref();
    }
  }

  // ── Event modul Email ─────────────────────────────────────────────────────
  const maxMailPerSecond = options.maxMailEventsPerSecond ?? 50;
  const mailRate = new Map<string, { windowStart: number; count: number; lastResync: number }>();
  const pendingMail = new Map<string, MailBusEvent[]>();
  let mailFlushTimer: ReturnType<typeof setTimeout> | null = null;

  async function deliverMailOrganization(
    organizationId: string,
    events: readonly MailBusEvent[],
  ): Promise<number> {
    const group = byOrganization.get(organizationId);
    if (!group || group.size === 0) return 0;
    let delivered = 0;
    const accountEvents: MailBusEvent[] = [];
    for (const event of events) {
      if (event.event.type === 'mail.access.changed') {
        const targets = new Set(event.userIds ?? []);
        for (const client of group) {
          if (targets.has(client.userId) && send(client, { type: 'mail.access.changed' })) {
            delivered += 1;
          }
        }
        continue;
      }
      accountEvents.push(event);
    }
    if (accountEvents.length === 0) return delivered;
    // Gabung `mail.folder.counts` per folder (yang terakhir menang) dan event yang identik.
    const seen = new Map<string, MailBusEvent>();
    for (const event of accountEvents) {
      const inner = event.event;
      const key =
        inner.type === 'mail.folder.counts'
          ? `counts|${inner.folderId}`
          : inner.type === 'mail.account.status'
            ? `status|${inner.accountId}`
            : JSON.stringify(inner);
      seen.delete(key);
      seen.set(key, event);
    }
    // Batas per akun: kelebihan → satu `mail.resync` per 5 dtk.
    const nowMs = Date.now();
    const allowed: MailBusEvent[] = [];
    const resyncAccounts = new Set<string>();
    for (const event of seen.values()) {
      const accountId = event.accountId as string;
      const state = mailRate.get(accountId) ?? { windowStart: nowMs, count: 0, lastResync: 0 };
      if (nowMs - state.windowStart >= 1_000) {
        state.windowStart = nowMs;
        state.count = 0;
      }
      mailRate.set(accountId, state);
      if (event.event.type === 'mail.resync') {
        resyncAccounts.add(accountId);
        continue;
      }
      if (state.count >= maxMailPerSecond) {
        if (nowMs - state.lastResync >= 5_000) {
          state.lastResync = nowMs;
          resyncAccounts.add(accountId);
        }
        continue;
      }
      state.count += 1;
      allowed.push(event);
    }
    const accountIds = [
      ...new Set([...allowed.map((event) => event.accountId as string), ...resyncAccounts]),
    ];
    const index = await mailAccessIndexOf(
      db,
      organizationId,
      [...group].map((client) => client.userId),
      accountIds,
    );
    for (const client of group) {
      for (const event of allowed) {
        if (index.levelOf(client.userId, event.accountId as string) && send(client, event.event)) {
          delivered += 1;
        }
      }
      for (const accountId of resyncAccounts) {
        if (
          index.levelOf(client.userId, accountId) &&
          send(client, { type: 'mail.resync', accountId })
        ) {
          delivered += 1;
        }
      }
    }
    return delivered;
  }

  async function deliverMail(events: readonly MailBusEvent[]): Promise<number> {
    const byOrg = new Map<string, MailBusEvent[]>();
    for (const event of events) {
      byOrg.set(event.organizationId, [...(byOrg.get(event.organizationId) ?? []), event]);
    }
    let delivered = 0;
    for (const [organizationId, list] of byOrg) {
      delivered += await deliverMailOrganization(organizationId, list);
    }
    return delivered;
  }

  function flushMail() {
    mailFlushTimer = null;
    const batch = [...pendingMail.values()].flat();
    pendingMail.clear();
    if (batch.length === 0) return;
    deliverMail(batch).catch((err: unknown) => {
      logger.warn({ err, events: batch.length }, 'Event email gagal diantar ke socket');
    });
  }

  function enqueueMail(event: MailBusEvent) {
    if (!byOrganization.has(event.organizationId)) return;
    if (coalesceMs <= 0) {
      deliverMail([event]).catch((err: unknown) => {
        logger.warn({ err }, 'Event email gagal diantar ke socket');
      });
      return;
    }
    const list = pendingMail.get(event.organizationId) ?? [];
    if (list.length < 2_000) list.push(event);
    pendingMail.set(event.organizationId, list);
    if (!mailFlushTimer) {
      mailFlushTimer = setTimeout(flushMail, Math.max(coalesceMs, 250));
      mailFlushTimer.unref();
    }
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
    const targets = [...clients].filter((client) => match(client));
    if (targets.length === 0) return;
    let snapshots: Awaited<ReturnType<SessionService['peekMany']>>;
    try {
      // SATU query untuk semua hash token sesi (syarat broadcast Fase 4, review real-time R2).
      snapshots = await sessions.peekMany(targets.map((client) => client.sessionTokenHash));
    } catch (err) {
      // Database sesaat bermasalah: socket dibiarkan, dicoba lagi di putaran berikutnya.
      logger.warn({ err }, 'Validasi ulang socket inbox gagal');
      return;
    }
    for (const client of targets) {
      if (!clients.has(client)) continue;
      const session = snapshots.get(client.sessionTokenHash);
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

    deliver: (event) => deliverBatch([event]),
    deliverBatch,
    deliverMail,

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
      if (flushTimer) clearTimeout(flushTimer);
      pending.clear();
      if (mailFlushTimer) clearTimeout(mailFlushTimer);
      pendingMail.clear();
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
      const mailEvent = parseMailBusMessage(raw);
      if (mailEvent) {
        enqueueMail(mailEvent);
        return;
      }
      const event = parseInboxBusMessage(raw);
      if (!event) return;
      enqueue(event);
    });
  }

  return hub;
}
