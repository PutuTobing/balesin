import { AppError, type InboxEventPublisher, type Logger } from '@balesin/core';
import {
  PG_ERROR_CODES,
  apiKeys,
  channels,
  contactEvents,
  conversationEvents,
  conversations,
  departments,
  hasActiveBotReceiver,
  isPgError,
  messages,
  recordOutgoingEvent,
  users,
  type ConversationRow,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  CONTACT_EDITABLE_FIELDS,
  hasPermission,
  tagColorSchema,
  type ContactEditableField,
  permissionScope,
  rolesWithPermission,
  type ConversationEvent,
  type ConversationRecordKind,
  type InboxAgent,
  type Permission,
} from '@balesin/shared';
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql, type Column } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimitRule, RateLimiter } from '../../http/rate-limit';
import {
  NOOP_NOTIFICATION_ENQUEUER,
  type NotificationEnqueuer,
} from '../../queues/notification-queue';
import { assertApiKeyStillAuthorized, type ApiKeyActor } from '../api-keys/api-key-actor';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { conversationScope } from './inbox.repo';

/**
 * Penanganan percakapan (Fase 2 butir 7, docs/KONTRAK-API-INBOX.md "Penanganan"): ambil dari
 * antrian, tugaskan/alihkan, kembalikan ke antrian, tandai selesai, buka lagi.
 *
 * Setiap aksi berjalan dalam SATU transaksi:
 *  1. Pelaku diperiksa ulang (`assertActorStillAuthorized`, pola wajib) — peran SEKARANG dipakai
 *     untuk menghitung cakupan;
 *  2. Baris percakapan dikunci `FOR UPDATE` dengan saringan organisasi + cakupan (di luar cakupan
 *     = 404). Dua agen yang mengambil bersamaan: yang kedua menunggu kunci lalu melihat status
 *     `served` → 409 dengan nama pemegangnya;
 *  3. Perubahan + baris `conversation_events` (tanpa isi pesan).
 * Setelah commit: event `conversation.updated` (dengan agen sebelumnya bila berubah — hub mengirim
 * `conversation.removed` ke agen lama yang kehilangan akses).
 *
 * Urutan kunci: pengguna pelaku (FOR SHARE) → pengguna sasaran (FOR SHARE) → percakapan. Worker
 * pesan masuk mengunci kontak → percakapan dan tidak pernah mengunci pengguna: tanpa siklus.
 *
 * TITIK KAIT (fase berikutnya): penugasan otomatis round-robin + kapasitas maks. per agen
 * (Pengaturan → Alokasi agen) memanggil `assign` dengan pelaku `null` (sistem); saringan
 * departemen (PRD §3.6) menyempitkan cakupan & agen sasaran; CSAT dikirim setelah `resolve`.
 */

export interface AssignmentServiceDeps {
  db: Database;
  publisher: InboxEventPublisher;
  accessDenied: AccessDeniedRecorder;
  logger: Logger;
  /** Penghitung aksi massal (review butir 7 R1). Tanpa limiter = alarm mati (tes unit). */
  limiter?: RateLimiter;
  /** Notifikasi push (butir 10): ditugaskan ke seseorang / kembali ke antrian. */
  notifications?: NotificationEnqueuer;
  now?: () => Date;
}

/**
 * Alarm aksi massal (review butir 7 R1): > 30 ambil/selesai/kembalikan oleh SATU pengguna dalam 10
 * menit → audit `inbox.bulk_action` + kejadian keamanan `warning` (banner Owner/Admin), paling banyak
 * sekali per jam per pengguna. Ambang: CS sibuk menangani ±1 chat/menit; 30 dalam 10 menit = 3/menit
 * terus-menerus — pola menguras antrian, bukan kerja normal (DECISIONS 2026-11-17).
 */
export const BULK_ACTION_RULE: RateLimitRule = {
  name: 'inbox-aksi-massal',
  limit: 30,
  windowSeconds: 10 * 60,
};
const BULK_ACTION_FLAG = 'inbox-aksi-massal';
const BULK_ACTION_KINDS: ReadonlySet<ConversationRecordKind> = new Set([
  'claimed',
  'assigned',
  'resolved',
  'unassigned',
  // Review bot Info 1: "memarkir" banyak percakapan ke bot juga menghilangkannya dari antrian.
  'bot_resumed',
  'handoff',
]);

export interface AssignmentContext {
  auth: AuthContext;
  client: ClientInfo;
}

/** Aksi penanganan: `true` = ada perubahan, `false` = sudah begitu (idempoten). */
export interface AssignmentService {
  claim(context: AssignmentContext, conversationId: string): Promise<boolean>;
  assign(context: AssignmentContext, conversationId: string, userId: string): Promise<boolean>;
  unassign(context: AssignmentContext, conversationId: string): Promise<boolean>;
  resolve(context: AssignmentContext, conversationId: string): Promise<boolean>;
  reopen(context: AssignmentContext, conversationId: string): Promise<boolean>;
  events(grant: PermissionGrant, conversationId: string): Promise<ConversationEvent[] | undefined>;
  agents(organizationId: string): Promise<InboxAgent[]>;
  /**
   * Lapisan kompatibel MobiChat / API v1 (`conversations:write`, pelaku = API key): lepas BOT
   * (status `bot` → `unserved`, kejadian `handoff`). Key TIDAK PERNAH mengeluarkan agen manusia
   * (review MobiChat Info 2): `agentUserId` diabaikan; bukan `bot` = tidak berubah (`changed: false`).
   */
  releaseAsApiKey(
    actor: ApiKeyActor,
    conversationId: string,
    agentUserId: string | null,
  ): Promise<{ changed: boolean }>;
  assignAsApiKey(actor: ApiKeyActor, conversationId: string, userId: string): Promise<void>;
  resolveAsApiKey(actor: ApiKeyActor, conversationId: string): Promise<{ changed: boolean }>;
  /**
   * Saklar bot per percakapan (`inbox.reply` + cakupan). `false` = serahkan ke tim (status `bot` →
   * `unserved`, kejadian `handoff`); `true` = kembalikan ke bot (`bot_resumed`; bot channel harus
   * aktif; mengambil dari agen LAIN butuh `inbox.assign`).
   */
  setBot(context: AssignmentContext, conversationId: string, active: boolean): Promise<boolean>;
}

const NOT_FOUND = 'Percakapan tidak ditemukan.';

interface Change {
  /** `null` = tidak ada yang berubah (aksi idempoten). */
  kind: ConversationRecordKind | null;
  patch?: Partial<typeof conversations.$inferInsert>;
  assigneeUserId?: string | null;
  /**
   * `bot_resumed`: pesan pelanggan terakhir yang belum dibalas (ikut di webhook
   * `conversation.bot_resumed` supaya bot bisa langsung bertindak), `null` bila tidak ada.
   */
  pendingMessageId?: string | null;
}

export function createAssignmentService(deps: AssignmentServiceDeps): AssignmentService {
  const { db, publisher, accessDenied, logger, limiter } = deps;
  const notifications = deps.notifications ?? NOOP_NOTIFICATION_ENQUEUER;
  const now = deps.now ?? (() => new Date());

  async function nameOf(tx: DbExecutor, organizationId: string, userId: string | null) {
    if (!userId) return null;
    const [row] = await tx
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
    return row?.name ?? null;
  }

  /** Pelaku aksi: pengguna bersesi (izin + cakupan peran) atau API key (cakupan organisasi). */
  type Actor =
    | { kind: 'user'; context: AssignmentContext; permission: Permission }
    | { kind: 'apiKey'; key: ApiKeyActor };

  const asUser = (context: AssignmentContext, permission: Permission): Actor => ({
    kind: 'user',
    context,
    permission,
  });

  /** `true` bila ada perubahan (aksi idempoten → `false`). */
  async function mutate(
    actor: Actor,
    conversationId: string,
    decide: (tx: DbExecutor, conversation: ConversationRow, role: string) => Promise<Change>,
  ): Promise<boolean> {
    const organizationId =
      actor.kind === 'user' ? actor.context.auth.organizationId : actor.key.organizationId;
    const actorUserId = actor.kind === 'user' ? actor.context.auth.user.id : null;
    let published: {
      previous: string | null;
      next: string | null;
      kind: ConversationRecordKind;
      role: string;
    } | null = null;
    await db.transaction(async (tx) => {
      let grant: PermissionGrant;
      let role: string;
      if (actor.kind === 'user') {
        const { auth } = actor.context;
        const checked = await assertActorStillAuthorized(tx, auth, actor.permission, logger);
        role = checked.role;
        const scope = permissionScope(checked.role, actor.permission);
        if (!scope) throw authorityChanged();
        grant = { permission: actor.permission, scope, userId: auth.user.id, organizationId };
      } else {
        // API key: cek ulang di transaksi akhir (dicabut/kedaluwarsa/scope); cakupan organisasi.
        await assertApiKeyStillAuthorized(tx, actor.key, 'conversations:write', now());
        role = 'api_key';
        grant = {
          permission: 'inbox.assign',
          scope: 'all',
          userId: actor.key.apiKeyId,
          organizationId,
        };
      }
      const [conversation] = await tx
        .select({ conversation: conversations })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.id, conversationId),
            conversationScope(grant),
          ),
        )
        .limit(1)
        .for('update');
      if (!conversation) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
      const current = conversation.conversation;
      const change = await decide(tx, current, role);
      if (change.kind === null) return;

      const nextAssignee =
        change.assigneeUserId === undefined ? current.assigneeUserId : change.assigneeUserId;
      const nextStatus = change.patch?.status ?? current.status;
      try {
        await tx
          .update(conversations)
          .set({
            assigneeUserId: nextAssignee,
            // Penanda "menunggu balasan bot" hanya bermakna selama bot memegang.
            ...(nextStatus !== 'bot' || current.status !== 'bot' ? { botAwaitingSince: null } : {}),
            // Aksi yang mengisi penanda sendiri (kembali ke bot, B3) menang.
            ...change.patch,
          })
          .where(
            and(eq(conversations.organizationId, organizationId), eq(conversations.id, current.id)),
          );
      } catch (error) {
        if (
          isPgError(
            error,
            PG_ERROR_CODES.uniqueViolation,
            'conversations_open_contact_channel_unique',
          )
        ) {
          throw new AppError('CONFLICT', {
            message:
              'Pelanggan ini sudah punya percakapan terbuka di nomor yang sama. Lanjutkan di percakapan itu.',
          });
        }
        throw error;
      }
      await tx.insert(conversationEvents).values({
        organizationId,
        conversationId: current.id,
        kind: change.kind,
        actorUserId,
        apiKeyId: actor.kind === 'apiKey' ? actor.key.apiKeyId : null,
        assigneeUserId: nextAssignee,
        previousAssigneeUserId: current.assigneeUserId,
      });
      // Webhook keluar (Fase 3): outbox di transaksi yang sama.
      const outgoingType = {
        claimed: 'conversation.assigned',
        assigned: 'conversation.assigned',
        unassigned: 'conversation.unassigned',
        resolved: 'conversation.resolved',
        reopened: 'conversation.reopened',
      }[change.kind as 'claimed' | 'assigned' | 'unassigned' | 'resolved' | 'reopened'];
      if (outgoingType) {
        await recordOutgoingEvent(tx, {
          organizationId,
          type: outgoingType,
          conversationId: current.id,
          contactId: current.contactId,
          actorUserId,
        });
      }
      // Dikembalikan ke bot → bot diberi tahu (+ pesan pelanggan yang belum dibalas), DECISIONS P2-3.
      if (change.kind === 'bot_resumed') {
        await recordOutgoingEvent(tx, {
          organizationId,
          type: 'conversation.bot_resumed',
          conversationId: current.id,
          contactId: current.contactId,
          messageId: change.pendingMessageId ?? null,
          actorUserId,
        });
      }
      // Bot berhenti memegang (diserahkan bot/agen/sistem, atau agen mengambil alih) → bot diberi tahu.
      if (current.status === 'bot' && (nextStatus === 'unserved' || nextStatus === 'served')) {
        await recordOutgoingEvent(tx, {
          organizationId,
          type: 'conversation.handoff',
          conversationId: current.id,
          contactId: current.contactId,
          actorUserId,
        });
      }
      published = { previous: current.assigneeUserId, next: nextAssignee, kind: change.kind, role };
    });
    const done = published as {
      previous: string | null;
      next: string | null;
      kind: ConversationRecordKind;
      role: string;
    } | null;
    if (!done) return false;
    await publisher.publish([
      {
        type: 'conversation.updated',
        organizationId,
        conversationId,
        ...(done.previous && done.previous !== done.next
          ? { previousAssigneeUserId: done.previous }
          : {}),
      },
    ]);
    logger.info(
      actor.kind === 'user'
        ? { conversationId, actorRef: actorUserId }
        : { conversationId, apiKeyId: actor.key.apiKeyId },
      'Penanganan percakapan diubah',
    );
    // Push (usaha terbaik, payload hanya ID): ditugaskan ke ORANG LAIN → penerima baru; kembali ke
    // antrian → yang bisa mengambil. Mengambil sendiri tidak memberi tahu siapa pun.
    const actorRef = actorUserId ? { actorUserId } : {};
    if (done.next !== null && done.next !== actorUserId && done.next !== done.previous) {
      await notifications.enqueue({
        organizationId,
        kind: 'assigned',
        conversationId,
        ...actorRef,
      });
    } else if (
      done.next === null &&
      (done.kind === 'unassigned' || done.kind === 'reopened' || done.kind === 'handoff')
    ) {
      await notifications.enqueue({ organizationId, kind: 'queued', conversationId, ...actorRef });
    }
    if (actor.kind === 'user' && BULK_ACTION_KINDS.has(done.kind)) {
      await watchBulk(actor.context, done.role);
    }
    return true;
  }

  /** Alarm aksi massal (R1). Usaha terbaik: Redis/DB bermasalah tidak menggagalkan aksinya. */
  async function watchBulk(context: AssignmentContext, role: string): Promise<void> {
    if (!limiter) return;
    const { auth, client } = context;
    try {
      const state = await limiter.consume(
        BULK_ACTION_RULE,
        `${auth.organizationId}:${auth.user.id}`,
      );
      if (state.allowed) return;
      const first = await limiter.claimFlag(
        BULK_ACTION_FLAG,
        `${auth.organizationId}:${auth.user.id}`,
        60 * 60,
      );
      if (!first) return;
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.inboxBulkAction,
        targetType: 'user',
        targetId: auth.user.id,
        metadata: {
          actions: state.count,
          windowMinutes: BULK_ACTION_RULE.windowSeconds / 60,
          kinds: [...BULK_ACTION_KINDS].join(','),
          actorRole: role,
        },
        client,
      });
      logger.warn({ actorRef: auth.user.id, actions: state.count }, 'Aksi massal di inbox');
    } catch (err) {
      logger.warn({ err, actorRef: auth.user.id }, 'Alarm aksi massal inbox gagal dicatat');
    }
  }

  async function heldBy(tx: DbExecutor, conversation: ConversationRow): Promise<AppError> {
    if (conversation.status === 'resolved') {
      return new AppError('CONFLICT', {
        message: 'Percakapan ini sudah selesai. Buka lagi dulu bila perlu ditangani.',
      });
    }
    const holder = await nameOf(tx, conversation.organizationId, conversation.assigneeUserId);
    return new AppError('CONFLICT', {
      message: holder
        ? `Percakapan ini sudah diambil ${holder}.`
        : 'Percakapan ini sudah tidak ada di antrian.',
    });
  }

  /** Agen sasaran penugasan: aktif + boleh membalas (dikunci FOR SHARE), atau 400. */
  async function assignTarget(
    tx: DbExecutor,
    organizationId: string,
    userId: string,
    field: string,
  ): Promise<{ id: string }> {
    const valid = z.uuid().safeParse(userId).success;
    const [target] = valid
      ? await tx
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(
            and(
              eq(users.organizationId, organizationId),
              eq(users.id, userId),
              isNull(users.disabledAt),
            ),
          )
          .limit(1)
          .for('share')
      : [];
    // TITIK KAIT departemen: agen sasaran harus satu departemen dengan percakapan.
    if (!target || !hasPermission(target.role, 'inbox.reply')) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Agen tidak ditemukan, sudah dinonaktifkan, atau tidak boleh membalas percakapan.',
        details: [{ location: 'body', field, message: 'Agen tidak valid.' }],
      });
    }
    return target;
  }

  return {
    claim: (context, conversationId) =>
      mutate(asUser(context, 'inbox.assign'), conversationId, async (tx, conversation) => {
        // Antrian terbuka (`unserved`) atau mengambil alih dari bot.
        if (
          (conversation.status !== 'unserved' && conversation.status !== 'bot') ||
          conversation.assigneeUserId !== null
        ) {
          if (
            conversation.assigneeUserId === context.auth.user.id &&
            conversation.status === 'served'
          ) {
            return { kind: null };
          }
          throw await heldBy(tx, conversation);
        }
        return {
          kind: 'claimed',
          assigneeUserId: context.auth.user.id,
          patch: {
            status: 'served',
            firstAssignedAt:
              sql`coalesce(${conversations.firstAssignedAt}, ${now()})` as unknown as Date,
          },
        };
      }),

    assign: (context, conversationId, userId) =>
      mutate(asUser(context, 'inbox.assign'), conversationId, async (tx, conversation) => {
        if (conversation.status === 'resolved') throw await heldBy(tx, conversation);
        const target = await assignTarget(tx, context.auth.organizationId, userId, 'userId');
        if (conversation.assigneeUserId === target.id && conversation.status === 'served') {
          return { kind: null };
        }
        return {
          kind:
            target.id === context.auth.user.id && conversation.assigneeUserId === null
              ? 'claimed'
              : 'assigned',
          assigneeUserId: target.id,
          patch: {
            status: 'served',
            firstAssignedAt:
              sql`coalesce(${conversations.firstAssignedAt}, ${now()})` as unknown as Date,
          },
        };
      }),

    unassign: (context, conversationId) =>
      mutate(asUser(context, 'inbox.reply'), conversationId, async (tx, conversation, role) => {
        if (conversation.status === 'resolved') throw await heldBy(tx, conversation);
        if (conversation.assigneeUserId === null) return { kind: null };
        // Tanpa `inbox.assign` (Teknisi) hanya boleh mengembalikan chat MILIKNYA (PRD §4).
        if (
          !hasPermission(role as Parameters<typeof hasPermission>[0], 'inbox.assign') &&
          conversation.assigneeUserId !== context.auth.user.id
        ) {
          await forbidByRule(accessDenied, {
            auth: context.auth,
            rule: ACCESS_RULES.inboxUnassignOthers,
            client: context.client,
            message: 'Kamu hanya bisa mengembalikan percakapan yang kamu pegang.',
          });
        }
        return { kind: 'unassigned', assigneeUserId: null, patch: { status: 'unserved' } };
      }),

    resolve: (context, conversationId) =>
      mutate(asUser(context, 'inbox.reply'), conversationId, (_tx, conversation) => {
        if (conversation.status === 'resolved') return Promise.resolve({ kind: null });
        // TITIK KAIT CSAT: antrekan survei kepuasan (ID percakapan) setelah commit.
        return Promise.resolve({
          kind: 'resolved' as const,
          patch: { status: 'resolved' as const, resolvedAt: now() },
        });
      }),

    reopen: (context, conversationId) =>
      mutate(asUser(context, 'inbox.reply'), conversationId, async (tx, conversation) => {
        if (conversation.status !== 'resolved') return { kind: null };
        // Percakapan = satu sesi: hanya sesi TERAKHIR kontak × channel yang boleh dibuka lagi, dan
        // hanya bila belum ada sesi terbuka yang lebih baru (indeks unik juga menjaganya).
        const [newer] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, conversation.organizationId),
              eq(conversations.contactId, conversation.contactId),
              eq(conversations.channelId, conversation.channelId),
              ne(conversations.id, conversation.id),
              sql`${conversations.createdAt} > ${conversation.createdAt}`,
            ),
          )
          .limit(1);
        if (newer) {
          throw new AppError('CONFLICT', {
            message:
              'Pelanggan ini sudah punya percakapan yang lebih baru. Hanya sesi terakhir yang bisa dibuka lagi.',
          });
        }
        // Pemegang sebelumnya masih boleh membalas? Bila tidak, kembali ke antrian.
        let assignee = conversation.assigneeUserId;
        if (assignee) {
          const [holder] = await tx
            .select({ role: users.role })
            .from(users)
            .where(
              and(
                eq(users.organizationId, conversation.organizationId),
                eq(users.id, assignee),
                isNull(users.disabledAt),
              ),
            );
          if (!holder || !hasPermission(holder.role, 'inbox.reply')) assignee = null;
        }
        return {
          kind: 'reopened',
          assigneeUserId: assignee,
          patch: { status: assignee ? 'served' : 'unserved', resolvedAt: null },
        };
      }),

    async releaseAsApiKey(actor, conversationId) {
      const changed = await mutate(
        { kind: 'apiKey', key: actor },
        conversationId,
        async (tx, conversation) => {
          if (conversation.status === 'resolved') throw await heldBy(tx, conversation);
          // Review MobiChat Info 2: key hanya bisa melepas BOT — tidak pernah mengeluarkan agen
          // manusia dari percakapannya (`agent_id` dari MobiChat diabaikan).
          if (conversation.status !== 'bot') return { kind: null };
          return { kind: 'handoff', assigneeUserId: null, patch: { status: 'unserved' } };
        },
      );
      return { changed };
    },

    async assignAsApiKey(actor, conversationId, userId) {
      await mutate({ kind: 'apiKey', key: actor }, conversationId, async (tx, conversation) => {
        if (conversation.status === 'resolved') throw await heldBy(tx, conversation);
        const target = await assignTarget(tx, actor.organizationId, userId, 'agent_id');
        if (conversation.assigneeUserId === target.id && conversation.status === 'served') {
          return { kind: null };
        }
        // Review MobiChat Info 2: key hanya menugaskan dari bot/antrian, tidak mengalihkan chat agen.
        if (conversation.status === 'served') throw await heldBy(tx, conversation);
        return {
          kind: 'assigned',
          assigneeUserId: target.id,
          patch: {
            status: 'served',
            firstAssignedAt:
              sql`coalesce(${conversations.firstAssignedAt}, ${now()})` as unknown as Date,
          },
        };
      });
    },

    async resolveAsApiKey(actor, conversationId) {
      const changed = await mutate({ kind: 'apiKey', key: actor }, conversationId, (_tx, row) => {
        if (row.status === 'resolved') return Promise.resolve({ kind: null });
        // Review MobiChat Info 2: key hanya menyelesaikan percakapan yang dipegang bot.
        if (row.status !== 'bot') {
          throw new AppError('CONFLICT', {
            message: 'Bot hanya bisa menyelesaikan percakapan yang sedang dipegang bot.',
          });
        }
        return Promise.resolve({
          kind: 'resolved' as const,
          patch: { status: 'resolved' as const, resolvedAt: now() },
        });
      });
      return { changed };
    },

    setBot: (context, conversationId, active) =>
      mutate(asUser(context, 'inbox.reply'), conversationId, async (tx, conversation, role) => {
        if (!active) {
          // Matikan bot = serahkan ke antrian tim (mengambil sendiri = tombol "Ambil").
          if (conversation.status !== 'bot') return { kind: null };
          return { kind: 'handoff', assigneeUserId: null, patch: { status: 'unserved' } };
        }
        if (conversation.status === 'resolved') throw await heldBy(tx, conversation);
        if (conversation.status === 'bot') return { kind: null };
        const [channel] = await tx
          .select({ type: channels.type, botEnabled: channels.botEnabled })
          .from(channels)
          .where(
            and(
              eq(channels.organizationId, conversation.organizationId),
              eq(channels.id, conversation.channelId),
            ),
          );
        if (!channel?.botEnabled) {
          throw new AppError('CONFLICT', {
            message:
              'Bot belum aktif untuk channel ini. Nyalakan dulu di Pengaturan → Channel → Bot.',
          });
        }
        // Mengembalikan chat yang dipegang agen LAIN ke bot = mengambil dari rekan (PRD §4).
        if (
          conversation.assigneeUserId !== null &&
          conversation.assigneeUserId !== context.auth.user.id &&
          !hasPermission(role as Parameters<typeof hasPermission>[0], 'inbox.assign')
        ) {
          await forbidByRule(accessDenied, {
            auth: context.auth,
            rule: ACCESS_RULES.inboxUnassignOthers,
            client: context.client,
            message: 'Kamu hanya bisa mengembalikan ke bot percakapan yang kamu pegang.',
          });
        }
        // Review bot semua channel B3: jangan parkir pelanggan di bot yang tidak menerima apa pun.
        const at = now();
        const receiverReady = await hasActiveBotReceiver(tx, {
          organizationId: conversation.organizationId,
          channelType: channel.type,
          at,
        });
        if (!receiverReady) {
          throw new AppError('CONFLICT', {
            message:
              'Belum ada penerima bot aktif untuk channel ini. Tambahkan webhook bot di Pengaturan → Webhook, lalu coba lagi.',
          });
        }
        // B3: pesan pelanggan terakhir belum dibalas → batas waktu bot langsung berjalan, dihitung
        // dari SAAT dikembalikan (bot tidak pernah menerima pesan lama itu lewat webhook; memakai
        // `last_inbound_at` lama akan langsung melepasnya lagi di pemeriksaan berikutnya).
        const [latest] = await tx
          .select({ id: messages.id, direction: messages.direction })
          .from(messages)
          .where(
            and(
              eq(messages.organizationId, conversation.organizationId),
              eq(messages.conversationId, conversation.id),
              ne(messages.type, 'reaction'),
            ),
          )
          .orderBy(desc(messages.occurredAt))
          .limit(1);
        const awaiting = latest?.direction === 'inbound' && conversation.lastInboundAt !== null;
        return {
          kind: 'bot_resumed',
          assigneeUserId: null,
          patch: { status: 'bot', botAwaitingSince: awaiting ? at : null },
          pendingMessageId: awaiting ? (latest?.id ?? null) : null,
        };
      }),

    async events(grant, conversationId) {
      const [visible] = await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, grant.organizationId),
            eq(conversations.id, conversationId),
            conversationScope(grant),
          ),
        );
      if (!visible) return undefined;
      const actor = alias(users, 'event_actor');
      const assignee = alias(users, 'event_assignee');
      const previous = alias(users, 'event_previous');
      const actorKey = alias(apiKeys, 'event_actor_key');
      const sameOrg = (table: { organizationId: Column; id: Column }, column: Column) =>
        and(eq(table.organizationId, conversationEvents.organizationId), eq(table.id, column));
      const rows = await db
        .select({
          id: conversationEvents.id,
          kind: conversationEvents.kind,
          createdAt: conversationEvents.createdAt,
          actorId: actor.id,
          actorName: actor.name,
          actorKeyId: actorKey.id,
          actorKeyName: actorKey.name,
          assigneeId: assignee.id,
          assigneeName: assignee.name,
          previousId: previous.id,
          previousName: previous.name,
          departmentId: conversationEvents.departmentId,
          departmentName: departments.name,
        })
        .from(conversationEvents)
        .leftJoin(actor, sameOrg(actor, conversationEvents.actorUserId))
        .leftJoin(actorKey, sameOrg(actorKey, conversationEvents.apiKeyId))
        .leftJoin(assignee, sameOrg(assignee, conversationEvents.assigneeUserId))
        .leftJoin(previous, sameOrg(previous, conversationEvents.previousAssigneeUserId))
        .leftJoin(departments, sameOrg(departments, conversationEvents.departmentId))
        .where(
          and(
            eq(conversationEvents.organizationId, grant.organizationId),
            eq(conversationEvents.conversationId, conversationId),
          ),
        )
        .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id))
        .limit(500);
      // Kejadian KONTAK selama sesi ini (tag dipasang/dilepas, data kontak diubah) — butir 8.
      const contactActor = alias(users, 'contact_event_actor');
      const contactRows = await db
        .select({
          id: contactEvents.id,
          kind: contactEvents.kind,
          createdAt: contactEvents.createdAt,
          actorId: contactActor.id,
          actorName: contactActor.name,
          tagName: contactEvents.tagName,
          tagColor: contactEvents.tagColor,
          fields: contactEvents.fields,
        })
        .from(contactEvents)
        .leftJoin(
          contactActor,
          and(
            eq(contactActor.organizationId, contactEvents.organizationId),
            eq(contactActor.id, contactEvents.actorUserId),
          ),
        )
        .where(
          and(
            eq(contactEvents.organizationId, grant.organizationId),
            eq(contactEvents.contactId, visible.contactId),
            gte(contactEvents.createdAt, visible.createdAt),
          ),
        )
        .orderBy(asc(contactEvents.createdAt), asc(contactEvents.id))
        .limit(200);
      const ref = (id: string | null, name: string | null) =>
        id !== null && name !== null ? { id, name } : null;
      const merged: (ConversationEvent & { at: number })[] = [
        ...rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          // Pelaku API key (bot lewat lapisan MobiChat) tampil dengan nama key-nya.
          actor:
            ref(row.actorId, row.actorName) ??
            ref(row.actorKeyId, row.actorKeyName === null ? null : `Bot · ${row.actorKeyName}`),
          assignee: ref(row.assigneeId, row.assigneeName),
          previousAssignee: ref(row.previousId, row.previousName),
          tag: null,
          fields: null,
          // Fase 5: departemen baru (`null` = dilepas / departemen sudah dihapus).
          department:
            row.kind === 'department_changed' ? ref(row.departmentId, row.departmentName) : null,
          createdAt: row.createdAt.toISOString(),
          at: row.createdAt.getTime(),
        })),
        ...contactRows.map((row) => {
          const color = tagColorSchema.safeParse(row.tagColor);
          const fields = (row.fields ?? []).filter((field): field is ContactEditableField =>
            (CONTACT_EDITABLE_FIELDS as readonly string[]).includes(field),
          );
          return {
            id: row.id,
            kind: row.kind,
            actor: ref(row.actorId, row.actorName),
            assignee: null,
            previousAssignee: null,
            tag:
              row.tagName !== null && color.success
                ? { name: row.tagName, color: color.data }
                : null,
            fields: row.kind === 'contact_updated' ? fields : null,
            createdAt: row.createdAt.toISOString(),
            at: row.createdAt.getTime(),
          };
        }),
      ];
      // UUIDv7 berurutan waktu: pemecah seri yang stabil untuk waktu yang sama.
      merged.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return merged.map(({ at: _at, ...event }) => event);
    },

    async agents(organizationId) {
      const roles = rolesWithPermission('inbox.reply');
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: sql<boolean>`${users.disabledAt} is null`,
        })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), inArray(users.role, roles)))
        .orderBy(asc(users.name), desc(users.id));
      // Beban: percakapan `served` per agen (satu query berkelompok).
      const loads = await db
        .select({ userId: conversations.assigneeUserId, total: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(eq(conversations.organizationId, organizationId), eq(conversations.status, 'served')),
        )
        .groupBy(conversations.assigneeUserId);
      const byUser = new Map(loads.map((load) => [load.userId, Number(load.total)]));
      return rows.map((row) => ({ ...row, openConversations: byUser.get(row.id) ?? 0 }));
    },
  };
}
