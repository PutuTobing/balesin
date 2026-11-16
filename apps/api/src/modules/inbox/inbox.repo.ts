import {
  channels,
  contacts,
  conversations,
  messages,
  users,
  type ContactRow,
  type DbExecutor,
  type MessageRow,
} from '@balesin/db';
import type { ChannelType, ConversationListQuery, ConversationStatus } from '@balesin/shared';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';

import { scopeCondition, type PermissionGrant } from '../auth/permission-grant';

/**
 * Query inbox (baca saja). SEMUA query memakai `grant` (organisasi + cakupan) — bukan
 * `organizationId` lepas — dan menyaring cakupan di SQL (`scopeCondition`):
 *  - percakapan: pemegang = `conversations.assignee_user_id` (Teknisi `assigned`);
 *  - kontak: terlihat bila ada percakapan kontak itu yang di-assign ke pengguna.
 *
 * Urutan daftar: `last_message_at desc, id desc`; pesan: `occurred_at desc, id desc`. Kursor = waktu
 * PERSIS (mikrodetik, teks dari Postgres) + ID — `Date` JavaScript hanya milidetik (lihat audit.repo).
 */

export interface Cursor {
  atExact: string;
  id: string;
}

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.atExact}|${cursor.id}`, 'utf8').toString('base64url');
}

/** `undefined` bila kursor rusak/dibuat-buat. */
export function decodeCursor(value: string): Cursor | undefined {
  const match = CURSOR_PATTERN.exec(Buffer.from(value, 'base64url').toString('utf8'));
  if (!match?.[1] || !match[2]) return undefined;
  return { atExact: match[1], id: match[2] };
}

const exactTime = (column: SQL | typeof conversations.lastMessageAt) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Pola `ILIKE` dengan `%`, `_`, dan `\` di-escape (masukan pengguna tidak menjadi wildcard). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Filter cakupan kontak: ada percakapan kontak ini yang dipegang pengguna. */
function contactHeldBy(userId: string): SQL {
  return sql`exists (select 1 from ${conversations} where ${conversations.organizationId} = ${contacts.organizationId} and ${conversations.contactId} = ${contacts.id} and ${conversations.assigneeUserId} = ${userId})`;
}

export function conversationScope(grant: PermissionGrant): SQL {
  return scopeCondition(grant, { holder: conversations.assigneeUserId });
}

export function contactScope(grant: PermissionGrant): SQL {
  return scopeCondition(grant, { holder: contactHeldBy });
}

/** Kondisi pencarian nama/nomor kontak. */
export function searchCondition(q: string): SQL {
  const pattern = likePattern(q);
  const conditions: SQL[] = [
    ilike(contacts.name, pattern),
    ilike(contacts.profileName, pattern),
    ilike(contacts.waUsername, pattern),
  ];
  const digits = q.replace(/[^0-9]/g, '');
  // Nomor: potongan digit (≥ 3) dicocokkan ke E.164 tanpa memedulikan `+`, spasi, atau tanda hubung;
  // awalan lokal `0…` juga dicoba sebagai `62…` (kebiasaan menulis nomor Indonesia).
  if (digits.length >= 3 && digits.length === q.replace(/[\s+()-]/g, '').length) {
    conditions.push(sql`${contacts.phone} like ${likePattern(digits)}`);
    if (digits.startsWith('0') && digits.length >= 4) {
      conditions.push(sql`${contacts.phone} like ${likePattern(`62${digits.slice(1)}`)}`);
    }
  }
  return or(...conditions) as SQL;
}

export interface ConversationRowView {
  id: string;
  number: number;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: Date;
  lastMessageAtExact: string;
  lastInboundAt: Date | null;
  windowExpiresAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  channel: { id: string; name: string; type: ChannelType };
  contact: Pick<ContactRow, 'id' | 'number' | 'name' | 'profileName' | 'phone' | 'waUsername'>;
  assignee: { id: string; name: string } | null;
}

function selectConversations(db: DbExecutor) {
  return db
    .select({
      id: conversations.id,
      number: conversations.number,
      status: conversations.status,
      unreadCount: conversations.unreadCount,
      lastMessageAt: conversations.lastMessageAt,
      lastMessageAtExact: exactTime(conversations.lastMessageAt),
      lastInboundAt: conversations.lastInboundAt,
      windowExpiresAt: conversations.windowExpiresAt,
      createdAt: conversations.createdAt,
      resolvedAt: conversations.resolvedAt,
      channelId: channels.id,
      channelName: channels.name,
      channelType: channels.type,
      contactId: contacts.id,
      contactNumber: contacts.number,
      contactName: contacts.name,
      contactProfileName: contacts.profileName,
      contactPhone: contacts.phone,
      contactWaUsername: contacts.waUsername,
      assigneeId: users.id,
      assigneeName: users.name,
    })
    .from(conversations)
    .innerJoin(
      contacts,
      and(
        eq(contacts.organizationId, conversations.organizationId),
        eq(contacts.id, conversations.contactId),
      ),
    )
    .innerJoin(
      channels,
      and(
        eq(channels.organizationId, conversations.organizationId),
        eq(channels.id, conversations.channelId),
      ),
    )
    .leftJoin(
      users,
      and(
        eq(users.organizationId, conversations.organizationId),
        eq(users.id, conversations.assigneeUserId),
      ),
    );
}

type SelectedConversation = Awaited<
  ReturnType<ReturnType<typeof selectConversations>['where']>
>[number];

function toConversationRowView(row: SelectedConversation): ConversationRowView {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt,
    lastMessageAtExact: row.lastMessageAtExact,
    lastInboundAt: row.lastInboundAt,
    windowExpiresAt: row.windowExpiresAt,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    channel: { id: row.channelId, name: row.channelName, type: row.channelType },
    contact: {
      id: row.contactId,
      number: row.contactNumber,
      name: row.contactName,
      profileName: row.contactProfileName,
      phone: row.contactPhone,
      waUsername: row.contactWaUsername,
    },
    assignee:
      row.assigneeId !== null && row.assigneeName !== null
        ? { id: row.assigneeId, name: row.assigneeName }
        : null,
  };
}

export async function listConversations(
  db: DbExecutor,
  grant: PermissionGrant,
  query: Omit<ConversationListQuery, 'cursor' | 'limit'>,
  options: { limit: number; cursor?: Cursor | undefined },
): Promise<ConversationRowView[]> {
  const rows = await selectConversations(db)
    .where(
      and(
        eq(conversations.organizationId, grant.organizationId),
        conversationScope(grant),
        query.status === undefined ? undefined : eq(conversations.status, query.status),
        query.channelId === undefined ? undefined : eq(conversations.channelId, query.channelId),
        query.q === undefined ? undefined : searchCondition(query.q),
        options.cursor === undefined
          ? undefined
          : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(options.limit);
  return rows.map(toConversationRowView);
}

/** Satu percakapan DALAM cakupan, atau `undefined` (pemanggil menjawab 404). */
export async function findConversation(
  db: DbExecutor,
  grant: PermissionGrant,
  conversationId: string,
): Promise<ConversationRowView | undefined> {
  const [row] = await selectConversations(db)
    .where(
      and(
        eq(conversations.organizationId, grant.organizationId),
        eq(conversations.id, conversationId),
        conversationScope(grant),
      ),
    )
    .limit(1);
  return row ? toConversationRowView(row) : undefined;
}

export type LastMessageRow = Pick<
  MessageRow,
  'conversationId' | 'direction' | 'type' | 'text' | 'reactionEmoji' | 'status' | 'occurredAt'
>;

/** Pesan terakhir tiap percakapan (satu query `distinct on`). */
export async function lastMessagesOf(
  db: DbExecutor,
  organizationId: string,
  conversationIds: readonly string[],
): Promise<Map<string, LastMessageRow>> {
  const found = new Map<string, LastMessageRow>();
  if (conversationIds.length === 0) return found;
  const rows = await db
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      direction: messages.direction,
      type: messages.type,
      text: messages.text,
      reactionEmoji: messages.reactionEmoji,
      status: messages.status,
      occurredAt: messages.occurredAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        inArray(messages.conversationId, [...conversationIds]),
      ),
    )
    .orderBy(messages.conversationId, desc(messages.occurredAt), desc(messages.id));
  for (const row of rows) found.set(row.conversationId, row);
  return found;
}

export type MessageRowView = MessageRow & { occurredAtExact: string };

/** Pesan satu percakapan (PEMANGGIL sudah memastikan percakapannya dalam cakupan). */
export async function listMessages(
  db: DbExecutor,
  organizationId: string,
  conversationId: string,
  options: { limit: number; cursor?: Cursor | undefined },
): Promise<MessageRowView[]> {
  const rows = await db
    .select({ message: messages, occurredAtExact: exactTime(sql`${messages.occurredAt}`) })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.conversationId, conversationId),
        options.cursor === undefined
          ? undefined
          : sql`(${messages.occurredAt}, ${messages.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(messages.occurredAt), desc(messages.id))
    .limit(options.limit);
  return rows.map((row) => ({ ...row.message, occurredAtExact: row.occurredAtExact }));
}

/** Satu kontak DALAM cakupan `contacts.view`, atau `undefined`. */
export async function findContact(
  db: DbExecutor,
  grant: PermissionGrant,
  contactId: string,
): Promise<ContactRow | undefined> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, grant.organizationId),
        eq(contacts.id, contactId),
        contactScope(grant),
      ),
    )
    .limit(1);
  return row;
}
