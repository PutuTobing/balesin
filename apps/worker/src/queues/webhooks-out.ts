import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOKS_OUT_JOBS,
  WEBHOOKS_OUT_TICK_INTERVAL_MS,
  deliverWebhook,
  securityNoticeAdminEmailPayloadSchema,
  webhookSignature,
  webhooksOutJobPayloadSchema,
  type Logger,
  type Lookup,
  type SecretBox,
  type SecurityNoticeAdminEmailPayload,
  REDACTED,
  scrubSecretsInText,
} from '@balesin/core';
import {
  apiKeys,
  auditLogs,
  channels,
  contactTags,
  contacts,
  conversations,
  messages,
  organizations,
  outgoingEvents,
  tags,
  ticketBoards,
  ticketColumns,
  tickets,
  users,
  webhookDeliveries,
  webhookEndpoints,
  type Database,
  type DbExecutor,
  type OutgoingEventRow,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@balesin/db';
import {
  OUTGOING_WEBHOOK_AUTO_DISABLE_FAILURES,
  OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS,
} from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Antrian `webhooks-out` (Fase 3, docs/KONTRAK-WEBHOOK-KELUAR.md). Satu job berkala `tick`:
 *  1. **Dispatch** — ambil `outgoing_events` (outbox, `FOR UPDATE SKIP LOCKED`), bangun payload dari
 *     database, buat satu `webhook_deliveries` per endpoint AKTIF yang melanggan, hapus kejadiannya;
 *  2. **Kirim** — pengiriman `pending` yang jatuh tempo diklaim (sewa 2 menit), dikirim lewat
 *     `deliverWebhook` (SSRF: DNS sekali + alamat diperiksa, tanpa redirect) dengan tanda tangan
 *     HMAC; gagal → dicoba lagi bertahap (6 percobaan), 4xx/alamat terlarang → langsung gagal;
 *  3. **Nonaktif otomatis** — 20 gagal final beruntun → endpoint dimatikan + audit + email Owner;
 *  4. **Retensi** — isi payload & potongan respons dikosongkan setelah 7 hari, baris dihapus 30 hari.
 * Isi payload/rahasia/URL lengkap tidak pernah ditulis ke log.
 */

export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3600_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_RETENTION_DAYS = 30;
const LEASE_MS = 2 * 60_000;
const DISPATCH_BATCH = 200;
const DELIVERY_BATCH = 50;
const PARALLEL = 10;

export interface WebhooksOutDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  now?: () => Date;
  /** Email ke Owner saat endpoint dinonaktifkan otomatis. */
  notifyOwner?: (payload: SecurityNoticeAdminEmailPayload) => Promise<void>;
  /**
   * Alamat aplikasi (`APP_URL`) = `mobichat_base_url` bawaan untuk webhook format MobiChat (endpoint
   * boleh menimpanya).
   */
  appUrl?: string;
  /** Tes saja. */
  lookup?: Lookup;
  /** Tes saja: izinkan server penerima tiruan di 127.0.0.1. */
  allowLoopback?: boolean;
  timeoutMs?: number;
}

export interface TickResult {
  dispatched: number;
  delivered: number;
  failed: number;
  retried: number;
  purged: number;
}

export function secretContext(endpoint: Pick<WebhookEndpointRow, 'organizationId' | 'id'>) {
  return {
    organizationId: endpoint.organizationId,
    purpose: 'webhook_endpoints.secret',
    subjectId: endpoint.id,
  };
}

// ── Payload ─────────────────────────────────────────────────────────────────

async function contactData(db: DbExecutor, organizationId: string, contactId: string | null) {
  if (!contactId) return null;
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));
  if (!row) return null;
  const tagRows = await db
    .select({ name: tags.name })
    .from(contactTags)
    .innerJoin(
      tags,
      and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)),
    )
    .where(and(eq(contactTags.organizationId, organizationId), eq(contactTags.contactId, row.id)));
  return {
    id: row.id,
    number: row.number,
    phone: row.phone,
    wa_username: row.waUsername,
    name: row.name,
    profile_name: row.profileName,
    email: row.email,
    // Jenis channel kontak + pengenal tampilan di channel selain WhatsApp (`@username` Telegram,
    // alamat email; `null` untuk WhatsApp/Messenger/Instagram). Tanpa BSUID/PSID mentah.
    channel_type: row.channelType,
    channel_handle: row.channelHandle,
    attributes: Array.isArray(row.attributes) ? row.attributes : [],
    tags: tagRows.map((tag) => tag.name),
  };
}

async function userRef(db: DbExecutor, organizationId: string, userId: string | null) {
  if (!userId) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
  return row ?? null;
}

async function conversationData(
  db: DbExecutor,
  organizationId: string,
  conversationId: string | null,
) {
  if (!conversationId) return null;
  const [found] = await db
    .select({
      conversation: conversations,
      channelType: channels.type,
      channelName: channels.name,
    })
    .from(conversations)
    .innerJoin(
      channels,
      and(
        eq(channels.organizationId, conversations.organizationId),
        eq(channels.id, conversations.channelId),
      ),
    )
    .where(
      and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId)),
    );
  if (!found) return null;
  const row = found.conversation;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    channel_id: row.channelId,
    // Bot per channel (DECISIONS 2026-11-19): bot tahu channel asal percakapan (balasannya lewat API
    // publik otomatis terkirim di channel ini; jendela 24 jam hanya WhatsApp/Messenger/Instagram).
    channel_type: found.channelType,
    channel: { id: row.channelId, type: found.channelType, name: found.channelName },
    assignee: await userRef(db, organizationId, row.assigneeUserId),
    window_expires_at: row.windowExpiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}

async function messageData(db: DbExecutor, organizationId: string, messageId: string | null) {
  if (!messageId) return null;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.id, messageId)));
  if (!row) return null;
  const media = row.media as {
    kind?: string;
    mimeType?: string | null;
    filename?: string | null;
  } | null;
  return {
    id: row.id,
    number: row.number,
    direction: row.direction,
    sender_kind: row.senderKind,
    type: row.type,
    text: row.text,
    media: media
      ? {
          kind: media.kind ?? null,
          mime_type: media.mimeType ?? null,
          filename: media.filename ?? null,
        }
      : null,
    location: row.location ?? null,
    // Balasan tombol/daftar pelanggan (id + judul pilihan) / pesan interaktif keluar.
    interactive: interactiveReplyOf(row),
    interactive_message: row.extras.interactiveMessage ?? null,
    // Review bot semua channel B1: pesan email membawa hasil verifikasi pengirim (SPF/DKIM/DMARC).
    // Bot WAJIB memperlakukan selain `pass` sebagai pengirim tidak tepercaya (alamat `From` bisa
    // dipalsukan) — tidak menjalankan aksi akun, sebaiknya handoff ke tim.
    email: emailDataOf(row),
    status: row.status,
    error_code: row.errorCode,
    created_at: row.occurredAt.toISOString(),
  };
}

/**
 * `{ subject, sender_verification, auth_warning }` untuk pesan email (keluar: verifikasi `null`),
 * selain itu `null`. Data lama
 * tanpa `senderVerification`: `fail` bila dulu diperingatkan, selain itu `unverified` (tidak pernah
 * dianggap lolos — sama dengan inbox).
 */
function emailDataOf(row: typeof messages.$inferSelect) {
  const email = row.extras.email;
  if (!email || typeof email !== 'object') return null;
  const subject = typeof email.subject === 'string' ? email.subject : null;
  // Pesan keluar (balasan tim/bot) tidak punya pengirim yang perlu diverifikasi.
  if (row.direction !== 'inbound') {
    return { subject, sender_verification: null, auth_warning: false };
  }
  const authWarning = email.authWarning === true;
  const verification = email.senderVerification;
  return {
    subject,
    sender_verification:
      verification === 'pass' || verification === 'fail' || verification === 'unverified'
        ? verification
        : authWarning
          ? 'fail'
          : 'unverified',
    auth_warning: authWarning,
  };
}

/** Tiket (Fase 5) — tanpa komentar/riwayat; kontak & percakapan tautannya ikut di `data`. */
async function ticketData(db: DbExecutor, organizationId: string, ticketId: string | null) {
  if (!ticketId) return null;
  const [row] = await db
    .select({
      ticket: tickets,
      boardName: ticketBoards.name,
      columnName: ticketColumns.name,
      columnIsDone: ticketColumns.isDone,
    })
    .from(tickets)
    .innerJoin(
      ticketBoards,
      and(
        eq(ticketBoards.organizationId, tickets.organizationId),
        eq(ticketBoards.id, tickets.boardId),
      ),
    )
    .innerJoin(
      ticketColumns,
      and(eq(ticketColumns.boardId, tickets.boardId), eq(ticketColumns.id, tickets.columnId)),
    )
    .where(and(eq(tickets.organizationId, organizationId), eq(tickets.id, ticketId)));
  if (!row) return null;
  const ticket = row.ticket;
  return {
    id: ticket.id,
    number: ticket.number,
    board: { id: ticket.boardId, name: row.boardName },
    column: { id: ticket.columnId, name: row.columnName, is_done: row.columnIsDone },
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    assignee: await userRef(db, organizationId, ticket.assigneeUserId),
    due_at: ticket.dueAt?.toISOString() ?? null,
    closed_at: ticket.closedAt?.toISOString() ?? null,
    contact_id: ticket.contactId,
    conversation_id: ticket.conversationId,
    attributes: Array.isArray(ticket.attributes) ? ticket.attributes : [],
    created_at: ticket.createdAt.toISOString(),
    updated_at: ticket.updatedAt.toISOString(),
  };
}

/**
 * Body `{ id, event, created_at, data }` (API-N8N §3), dibangun SAAT DISPATCH (keadaan terbaru).
 * `null` = subjeknya sudah tidak ada (mis. kontak dihapus) → tidak dikirim.
 */
export async function buildEventBody(
  db: DbExecutor,
  event: OutgoingEventRow,
): Promise<Record<string, unknown> | null> {
  const org = event.organizationId;
  const data: Record<string, unknown> = {};
  if (event.type.startsWith('ticket.')) {
    const ticket = await ticketData(db, org, event.ticketId);
    if (!ticket) return null;
    data.ticket = ticket;
    if (ticket.conversation_id) {
      const conversation = await conversationData(db, org, ticket.conversation_id);
      if (conversation) data.conversation = conversation;
    }
    const contact = await contactData(db, org, ticket.contact_id);
    if (contact) data.contact = contact;
    if (event.actorUserId) data.actor = await userRef(db, org, event.actorUserId);
    return { id: event.id, event: event.type, created_at: event.createdAt.toISOString(), data };
  }
  if (event.type.startsWith('message.')) {
    const message = await messageData(db, org, event.messageId);
    if (!message) return null;
    data.message = message;
  } else if (event.type === 'conversation.bot_resumed') {
    // Pesan pelanggan terakhir yang belum dibalas (`null` bila tidak ada / sudah dihapus).
    data.message = await messageData(db, org, event.messageId);
  }
  if (event.conversationId) {
    const conversation = await conversationData(db, org, event.conversationId);
    if (!conversation && !event.type.startsWith('contact.')) return null;
    if (conversation) data.conversation = conversation;
  }
  const contact = await contactData(db, org, event.contactId);
  if (!contact && event.type.startsWith('contact.')) return null;
  if (contact) data.contact = contact;
  if (event.actorUserId) data.actor = await userRef(db, org, event.actorUserId);
  // TITIK KAIT mode kompatibel MobiChat: endpoint `format = 'mobichat'` menambah
  // `mobichat_base_url`/`mobichat_api_key` + bentuk body MobiChat (butir berikutnya).
  return { id: event.id, event: event.type, created_at: event.createdAt.toISOString(), data };
}

/** Balasan tombol/daftar dari pelanggan: `{ type, id, title, description }` atau `null`. */
function interactiveReplyOf(row: typeof messages.$inferSelect) {
  const reply = (row.extras as { interactive?: Record<string, unknown> } | null)?.interactive;
  if (!reply || row.direction !== 'inbound') return null;
  const textOf = (value: unknown) => (typeof value === 'string' ? value : null);
  const kind = textOf(reply.kind);
  return {
    type:
      kind === 'list_reply' ? 'list_reply' : kind === 'nfm_reply' ? 'nfm_reply' : 'button_reply',
    id: textOf(reply.id),
    title: textOf(reply.title),
    description: textOf(reply.description),
  };
}

/** Teks ringkas pesan untuk bot (lokasi/tombol jadi teks; sama dengan riwayat kompatibel). */
function mobichatText(row: typeof messages.$inferSelect): string | null {
  const location = row.location as {
    latitude?: number;
    longitude?: number;
    name?: string | null;
    address?: string | null;
  } | null;
  if (location && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    const label = [location.name, location.address]
      .filter((part) => part && part.trim())
      .join(', ');
    return `[lokasi] ${label ? `${label} ` : ''}https://maps.google.com/?q=${String(location.latitude)},${String(location.longitude)}`;
  }
  if (row.text) return row.text;
  const interactive = (row.extras as { interactive?: { title?: unknown } } | null)?.interactive;
  return typeof interactive?.title === 'string' ? interactive.title : null;
}

const MOBICHAT_FALLBACK_MIME: Readonly<Record<string, string>> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

/**
 * Body format MobiChat (docs/KONTRAK-API-MOBICHAT.md "Webhook"; API-MOBICHAT-MAPPING §3.1): field
 * top-level + objek bersarang cadangan, ID numerik (`conversations.number`, `messages.number`).
 * HANYA `message.received` (pesan pelanggan). `mobichat_base_url`/`mobichat_api_key` TIDAK ada di
 * sini — disisipkan saat kirim (`withMobichatCredentials`), supaya API key tidak pernah tersimpan di
 * riwayat pengiriman. Lampiran tanpa URL (URL bertanda tangan ada di `GET /api/public/messages`).
 */
export async function buildMobichatBody(
  db: DbExecutor,
  event: OutgoingEventRow,
): Promise<Record<string, unknown> | null> {
  if (event.type !== 'message.received' || !event.messageId || !event.conversationId) return null;
  const org = event.organizationId;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, org), eq(messages.id, event.messageId)));
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, org), eq(conversations.id, event.conversationId)));
  if (!message || !conversation || message.type === 'reaction') return null;
  // Format MobiChat = WhatsApp saja (nomor sebagai identitas). Pesan channel lain hanya ke endpoint
  // native — sama dengan `hasActiveBotReceiver` (DECISIONS 2026-11-19).
  const [channel] = await db
    .select({ type: channels.type })
    .from(channels)
    .where(and(eq(channels.organizationId, org), eq(channels.id, conversation.channelId)));
  if (channel?.type !== 'whatsapp') return null;
  const contact = await contactData(db, org, conversation.contactId);
  if (!contact) return null;
  const phone = contact.phone ? contact.phone.replace(/\D/g, '') : null;
  const fullName = contact.name ?? contact.profile_name;
  const contactBody = {
    id: contact.number,
    full_name: fullName,
    name: fullName,
    edited_name: contact.name,
    profile_name: contact.profile_name,
    phone,
    phone_number: phone,
    contact_details: phone ? [{ type: 'whatsapp', value: phone }] : [],
    tags: contact.tags,
  };
  const media = message.media as {
    kind?: string;
    mimeType?: string | null;
    filename?: string | null;
  } | null;
  const kind = media?.kind ?? null;
  const mime = kind
    ? (media?.mimeType ?? MOBICHAT_FALLBACK_MIME[kind] ?? 'application/octet-stream')
    : null;
  const attachments =
    kind && mime
      ? [
          {
            id: message.number,
            type: mime,
            file_type: mime,
            mime_type: mime,
            media_type: kind,
            name:
              kind === 'sticker'
                ? `sticker_${String(message.number)}.webp`
                : (media?.filename ?? `${kind}_${String(message.number)}`),
          },
        ]
      : [];
  const text = mobichatText(message);
  const createdAt = message.occurredAt.toISOString();
  const interactiveReply = interactiveReplyOf(message);
  return {
    event: event.type,
    event_id: event.id,
    created_at: event.createdAt.toISOString(),
    conversation_id: conversation.number,
    // Satu percakapan Balesin = satu sesi (DECISIONS 2026-11-16) → ID sesi = nomor percakapan.
    conversation_session_log_id: conversation.number,
    message_id: message.number,
    message_text: text,
    message_type: message.type,
    sender: 'user',
    type: 'user',
    // Balasan tombol/daftar: id + judul pilihan (teks pesan = judul).
    ...(interactiveReply
      ? { interactive_reply: interactiveReply, reply_id: interactiveReply.id }
      : {}),
    contact_name: fullName,
    tags: contact.tags,
    contact: contactBody,
    conversation: {
      id: conversation.number,
      status: conversation.status,
      assignee: await userRef(db, org, conversation.assigneeUserId),
      window_expires_at: conversation.windowExpiresAt?.toISOString() ?? null,
    },
    message: {
      id: message.number,
      conversation_id: conversation.number,
      type: 'user',
      sender: 'user',
      sender_name: fullName,
      text,
      message_text: text,
      message_type: message.type,
      ...(interactiveReply ? { interactive_reply: interactiveReply } : {}),
      attachments,
      created_at: createdAt,
    },
  };
}

/**
 * Sisipkan `mobichat_base_url` + `mobichat_api_key` (didekripsi SAAT KIRIM). Key yang sudah dicabut/
 * kedaluwarsa → `null` (pengiriman gagal `mobichat_key_inactive`, admin mengganti key-nya).
 */
async function withMobichatCredentials(
  deps: WebhooksOutDeps,
  endpoint: WebhookEndpointRow,
  payload: Record<string, unknown>,
  now: Date,
): Promise<Record<string, unknown> | null> {
  if (!deps.secretBox || !endpoint.mobichatApiKeyEncrypted || !endpoint.mobichatApiKeyId) {
    return null;
  }
  const [key] = await deps.db
    .select({ revokedAt: apiKeys.revokedAt, expiresAt: apiKeys.expiresAt })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, endpoint.organizationId),
        eq(apiKeys.id, endpoint.mobichatApiKeyId),
      ),
    );
  if (
    !key ||
    key.revokedAt !== null ||
    (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime())
  ) {
    return null;
  }
  const apiKey = deps.secretBox.decrypt(endpoint.mobichatApiKeyEncrypted, {
    organizationId: endpoint.organizationId,
    purpose: 'webhook_endpoints.mobichat_api_key',
    subjectId: endpoint.id,
  });
  let base = endpoint.mobichatBaseUrl;
  if (!base && deps.appUrl) {
    try {
      base = new URL(deps.appUrl).origin;
    } catch {
      base = null;
    }
  }
  return { ...payload, mobichat_base_url: base, mobichat_api_key: apiKey };
}

// ── Langkah tick ───────────────────────────────────────────────────────────

/**
 * Rujukan galat untuk log TANPA isi (review webhook keluar Info 5): galat Drizzle/pg memuat teks
 * kueri + parameternya (bisa berisi potongan jawaban penerima/isi payload) — yang dicatat hanya
 * nama, kode SQLSTATE/kode sistem, dan nama constraint.
 */
export function errorRef(err: unknown): Record<string, string> {
  const ref: Record<string, string> = {
    errorName: err instanceof Error ? err.name : typeof err,
  };
  const record = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  const cause = (typeof record.cause === 'object' && record.cause !== null ? record.cause : {}) as {
    code?: unknown;
    constraint?: unknown;
  };
  const code = record.code ?? cause.code;
  const constraint = record.constraint ?? cause.constraint;
  if (typeof code === 'string' || typeof code === 'number') ref.errorCode = String(code);
  if (typeof constraint === 'string') ref.constraint = constraint;
  return ref;
}

async function dispatch(db: Database, logger: Logger, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(outgoingEvents)
      .orderBy(asc(outgoingEvents.createdAt))
      .limit(DISPATCH_BATCH)
      .for('update', { skipLocked: true });
    if (batch.length === 0) return 0;
    let created = 0;
    for (const event of batch) {
      // Satu kejadian per savepoint (review Info 3): kejadian yang gagal dibangun DIBUANG dan dicatat
      // (hanya ID + kode galat), bukan memacetkan seluruh outbox tiap 5 detik.
      try {
        created += await tx.transaction((savepoint) => dispatchOne(savepoint, event, now));
      } catch (err) {
        logger.warn(
          { eventId: event.id, eventType: event.type, ...errorRef(err) },
          'Kejadian webhook keluar gagal dibangun: dibuang',
        );
      }
    }
    await tx.delete(outgoingEvents).where(
      inArray(
        outgoingEvents.id,
        batch.map((event) => event.id),
      ),
    );
    return created;
  });
}

/** Bangun pengiriman untuk satu kejadian (di dalam savepoint `dispatch`). */
async function dispatchOne(tx: DbExecutor, event: OutgoingEventRow, now: Date): Promise<number> {
  const endpoints = await tx
    .select({
      id: webhookEndpoints.id,
      format: webhookEndpoints.format,
      botOnly: webhookEndpoints.botOnly,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, event.organizationId),
        eq(webhookEndpoints.enabled, true),
        sql`${event.type} = any(${webhookEndpoints.events})`,
      ),
    );
  if (endpoints.length === 0) return 0;
  // Satu body per format (dibangun sekali, hanya bila ada endpoint format itu).
  const bodies = new Map<string, Record<string, unknown> | null>();
  const rows = [];
  // Endpoint "hanya saat bot": pesan masuk dikirim hanya bila bot memegang percakapan SAAT DISPATCH.
  let botHolds: boolean | undefined;
  for (const endpoint of endpoints) {
    if (endpoint.botOnly && event.type === 'message.received') {
      if (botHolds === undefined) {
        const [conversation] = event.conversationId
          ? await tx
              .select({ status: conversations.status })
              .from(conversations)
              .where(
                and(
                  eq(conversations.organizationId, event.organizationId),
                  eq(conversations.id, event.conversationId),
                ),
              )
          : [];
        botHolds = conversation?.status === 'bot';
      }
      if (!botHolds) continue;
    }
    if (!bodies.has(endpoint.format)) {
      bodies.set(
        endpoint.format,
        endpoint.format === 'mobichat'
          ? await buildMobichatBody(tx, event)
          : await buildEventBody(tx, event),
      );
    }
    const body = bodies.get(endpoint.format);
    if (!body) continue;
    rows.push({
      organizationId: event.organizationId,
      endpointId: endpoint.id,
      eventId: event.id,
      event: event.type,
      payload: body,
      nextAttemptAt: now,
    });
  }
  if (rows.length === 0) return 0;
  await tx.insert(webhookDeliveries).values(rows);
  return rows.length;
}

/** Klaim pengiriman jatuh tempo (sewa) supaya proses lain tidak mengirim yang sama. */
async function claimDue(db: Database, now: Date): Promise<WebhookDeliveryRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(DELIVERY_BATCH)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(
        inArray(
          webhookDeliveries.id,
          due.map((row) => row.id),
        ),
      );
    return due;
  });
}

type Outcome = 'delivered' | 'failed' | 'retried';

async function attempt(
  deps: WebhooksOutDeps,
  delivery: WebhookDeliveryRow,
  now: Date,
): Promise<Outcome> {
  const { db, secretBox } = deps;
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, delivery.organizationId),
        eq(webhookEndpoints.id, delivery.endpointId),
      ),
    );
  const [org] = await db
    .select({ cidrs: organizations.webhookPrivateCidrs })
    .from(organizations)
    .where(eq(organizations.id, delivery.organizationId));
  const finalize = async (patch: Partial<typeof webhookDeliveries.$inferInsert>) => {
    await db.update(webhookDeliveries).set(patch).where(eq(webhookDeliveries.id, delivery.id));
  };
  if (!endpoint || !endpoint.enabled || !delivery.payload || !secretBox) {
    await finalize({
      status: 'failed',
      nextAttemptAt: null,
      errorCode:
        !endpoint || !endpoint.enabled
          ? 'endpoint_disabled'
          : !delivery.payload
            ? 'payload_purged'
            : 'no_master_key',
    });
    return 'failed';
  }
  const secrets = [secretBox.decrypt(endpoint.secretEncrypted, secretContext(endpoint))];
  if (
    endpoint.previousSecretEncrypted &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt.getTime() > now.getTime()
  ) {
    secrets.push(secretBox.decrypt(endpoint.previousSecretEncrypted, secretContext(endpoint)));
  }
  let payload: Record<string, unknown> = delivery.payload;
  let injectedKey: string | null = null;
  if (endpoint.format === 'mobichat') {
    const withKey = await withMobichatCredentials(deps, endpoint, payload, now);
    if (!withKey) {
      await finalize({ status: 'failed', nextAttemptAt: null, errorCode: 'mobichat_key_inactive' });
      return 'failed';
    }
    payload = withKey;
    injectedKey = typeof withKey.mobichat_api_key === 'string' ? withKey.mobichat_api_key : null;
  }
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  const result = await deliverWebhook({
    url: endpoint.url,
    body,
    headers: {
      'user-agent': 'Balesin-Webhook/1.0',
      'x-balesin-event': delivery.event,
      'x-balesin-delivery': delivery.id,
      'x-balesin-signature': webhookSignature(secrets, timestamp, body),
    },
    privateCidrs: org?.cidrs ?? [],
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.allowLoopback ? { allowLoopback: true } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });
  const attempts = delivery.attempts + 1;
  const common = {
    attempts,
    httpStatus: result.httpStatus,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    // Penerima bisa memantulkan body (review MobiChat S1): key yang disisipkan + pola rahasia yang
    // dikenal (`blsn_live_…`, `whsec_…`, Bearer, …) disensor SEBELUM disimpan/ditampilkan.
    responseSnippet: scrubSnippet(result.snippet, injectedKey),
  };
  if (result.ok) {
    await finalize({ ...common, status: 'succeeded', nextAttemptAt: null, deliveredAt: now });
    await db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 0, lastDeliveryAt: now })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return 'delivered';
  }
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
  if (result.retryable && delay !== undefined) {
    await finalize({ ...common, nextAttemptAt: new Date(now.getTime() + delay) });
    return 'retried';
  }
  await finalize({ ...common, status: 'failed', nextAttemptAt: null });
  await recordFinalFailure(deps, endpoint, now);
  return 'failed';
}

async function recordFinalFailure(deps: WebhooksOutDeps, endpoint: WebhookEndpointRow, now: Date) {
  const { db, logger } = deps;
  const [updated] = await db
    .update(webhookEndpoints)
    .set({
      consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
      lastDeliveryAt: now,
    })
    .where(eq(webhookEndpoints.id, endpoint.id))
    .returning({ failures: webhookEndpoints.consecutiveFailures });
  const failures = updated?.failures ?? 0;
  if (failures < OUTGOING_WEBHOOK_AUTO_DISABLE_FAILURES) return;
  // Nonaktif otomatis: sekali (hanya bila masih aktif).
  const disabled = await db
    .update(webhookEndpoints)
    .set({ enabled: false, disabledReason: 'auto_failures' })
    .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.enabled, true)))
    .returning({ id: webhookEndpoints.id });
  if (disabled.length === 0) return;
  const host = hostOf(endpoint.url);
  const [audit] = await db
    .insert(auditLogs)
    .values({
      organizationId: endpoint.organizationId,
      actorUserId: null,
      action: 'webhook.auto_disabled',
      targetType: 'webhook',
      targetId: endpoint.id,
      metadata: { host, failures },
    })
    .returning({ id: auditLogs.id });
  logger.warn({ webhookId: endpoint.id, failures }, 'Webhook keluar dinonaktifkan otomatis');
  if (!deps.notifyOwner || !endpoint.createdByUserId) return;
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, endpoint.organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  for (const owner of owners) {
    await deps
      .notifyOwner({
        organizationId: endpoint.organizationId,
        recipientUserId: owner.id,
        subjectUserId: endpoint.createdByUserId,
        event: 'webhook_disabled',
        occurredAt: now.toISOString(),
        ...(audit ? { auditLogId: audit.id } : {}),
      })
      .catch((err: unknown) => {
        logger.warn(
          { webhookId: endpoint.id, ...errorRef(err) },
          'Email webhook nonaktif tidak terantre',
        );
      });
  }
}

/** Potongan jawaban penerima tanpa rahasia (key yang disisipkan, pola rahasia yang dikenal). */
export function scrubSnippet(snippet: string | null, injectedKey: string | null): string | null {
  if (snippet === null) return null;
  let text = snippet;
  if (injectedKey) {
    text = text.split(injectedKey).join(REDACTED);
    // Key terpotong di akhir potongan (batas 500 byte): ekor yang merupakan awalan key ikut disensor.
    for (let length = Math.min(injectedKey.length - 1, text.length); length >= 12; length -= 1) {
      if (text.endsWith(injectedKey.slice(0, length))) {
        text = text.slice(0, text.length - length) + REDACTED;
        break;
      }
    }
  }
  return scrubSecretsInText(text).slice(0, 500);
}

/** Host saja (tanpa path/query yang bisa memuat token) untuk audit/email. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'url-tidak-valid';
  }
}

async function retention(db: Database, now: Date): Promise<number> {
  const purgeBefore = new Date(now.getTime() - OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS * DAY_MS);
  const deleteBefore = new Date(now.getTime() - ROW_RETENTION_DAYS * DAY_MS);
  const purged = await db.execute(sql`
    update ${webhookDeliveries} set payload = null, response_snippet = null,
      payload_purged_at = ${now}, updated_at = now()
    where id in (
      select id from ${webhookDeliveries}
      where ${webhookDeliveries.createdAt} < ${purgeBefore} and ${webhookDeliveries.payloadPurgedAt} is null
      limit 1000
    )`);
  await db.execute(sql`
    delete from ${webhookDeliveries}
    where id in (
      select id from ${webhookDeliveries} where ${webhookDeliveries.createdAt} < ${deleteBefore} limit 1000
    )`);
  return purged.rowCount ?? 0;
}

export async function processWebhooksOutTick(deps: WebhooksOutDeps): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const dispatched = await dispatch(deps.db, deps.logger, now);
  const due = await claimDue(deps.db, now);
  const counts = { delivered: 0, failed: 0, retried: 0 };
  for (let index = 0; index < due.length; index += PARALLEL) {
    const outcomes = await Promise.all(
      due.slice(index, index + PARALLEL).map((delivery) =>
        attempt(deps, delivery, now).catch((err: unknown) => {
          deps.logger.warn(
            { deliveryId: delivery.id, ...errorRef(err) },
            'Pengiriman webhook gagal diproses',
          );
          return 'retried' as const;
        }),
      ),
    );
    for (const outcome of outcomes) counts[outcome] += 1;
  }
  const purged = await retention(deps.db, now);
  if (dispatched + due.length > 0) {
    deps.logger.info({ dispatched, ...counts }, 'Webhook keluar diproses');
  }
  return { dispatched, ...counts, purged };
}

// ── BullMQ ─────────────────────────────────────────────────────────────────

export async function processWebhooksOutJob(
  job: { name: string; data: unknown },
  deps: WebhooksOutDeps,
): Promise<TickResult> {
  if (job.name !== WEBHOOKS_OUT_JOBS.tick) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian webhooks-out`);
  }
  if (!webhooksOutJobPayloadSchema.safeParse(job.data ?? {}).success) {
    throw new UnrecoverableError('Payload job webhooks-out tidak valid');
  }
  return processWebhooksOutTick(deps);
}

export function createWebhooksOutQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.webhooksOut, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export async function scheduleWebhooksOut(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    WEBHOOKS_OUT_JOBS.tick,
    { every: WEBHOOKS_OUT_TICK_INTERVAL_MS },
    {
      name: WEBHOOKS_OUT_JOBS.tick,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    },
  );
}

export function createWebhooksOutWorker(
  options: QueueConnectionOptions,
  deps: WebhooksOutDeps,
): Worker {
  return new Worker(QUEUE_NAMES.webhooksOut, (job) => processWebhooksOutJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 1,
  });
}

/** Produsen email Owner (antrian `email`) untuk pemberitahuan webhook nonaktif. */
export function createOwnerNotifier(options: QueueConnectionOptions) {
  const queue = new Queue(QUEUE_NAMES.email, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
  queue.on('error', () => undefined);
  return {
    notify: async (payload: SecurityNoticeAdminEmailPayload) => {
      const data = securityNoticeAdminEmailPayloadSchema.parse(payload);
      await queue.add(EMAIL_JOBS.securityNoticeAdmin, data, {
        jobId: `webhook-off-${data.auditLogId ?? data.occurredAt}-${data.recipientUserId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
      });
    },
    close: () => queue.close(),
  };
}
