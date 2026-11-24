import {
  channelAccessSql,
  channels,
  contactTags,
  contacts,
  conversations,
  departments,
  messages,
  tags,
  tickets,
  users,
  type ContactRow,
  type DbExecutor,
  type MessageRow,
} from '@balesin/db';
import {
  WINDOW_EXPIRING_SOON_MS,
  type ChannelType,
  type ConversationCountsResponse,
  type ConversationFilter,
  type ConversationListQuery,
  type ConversationStatus,
  type MessageListFilter,
  type TagColor,
  type TagRef,
} from '@balesin/shared';
import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { grantPrincipal, scopeCondition, type PermissionGrant } from '../auth/permission-grant';

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

/**
 * Filter cakupan kontak: ada percakapan kontak ini yang dipegang pengguna — di channel yang boleh ia
 * lihat (review 9.0 R4: Teknisi tanpa akses channel tidak membuka kontaknya lewat penugasan lama).
 */
function contactHeldBy(grant: PermissionGrant, userId: string): SQL {
  return sql`exists (select 1 from ${conversations} where ${conversations.organizationId} = ${contacts.organizationId} and ${conversations.contactId} = ${contacts.id} and ${conversations.assigneeUserId} = ${userId} and ${channelAccessSql(grant.organizationId, grantPrincipal(grant), conversations.channelId)})`;
}

/**
 * "Terkait tiketnya" (PRD §4, Fase 5): ada tiket TERBUKA yang dipegang pengguna dan menaut kontak
 * ini. Tiket yang menaut percakapan selalu menaut kontaknya, jadi semua percakapan kontak itu ikut.
 */
export function openTicketLinksContact(userId: string, contactId: SQL | typeof contacts.id): SQL {
  return sql`exists (select 1 from ${tickets} where ${tickets.organizationId} = ${contacts.organizationId} and ${tickets.assigneeUserId} = ${userId} and ${tickets.closedAt} is null and ${tickets.contactId} = ${contactId})`;
}

/**
 * Percakapan kontak tiket: yang ditautkan eksplisit, yang masih terbuka, atau yang dibuat setelah
 * tiket — riwayat lama yang sudah selesai TIDAK terbuka lewat tiket (review Fase 5 Info 1: tiket dari
 * API key/rekan yang ditugaskan ke Teknisi tidak membuka seluruh riwayat pelanggan).
 */
function conversationLinkedByTicket(userId: string): SQL {
  return sql`exists (select 1 from ${tickets} where ${tickets.organizationId} = ${conversations.organizationId} and ${tickets.assigneeUserId} = ${userId} and ${tickets.closedAt} is null and ${tickets.contactId} = ${conversations.contactId} and (${tickets.conversationId} = ${conversations.id} or ${conversations.status} <> 'resolved' or ${conversations.createdAt} >= ${tickets.createdAt}))`;
}

export function conversationScope(grant: PermissionGrant): SQL {
  return scopeCondition(grant, {
    holder: conversations.assigneeUserId,
    linkedTicketHolder: conversationLinkedByTicket,
    department: conversations.departmentId,
    // Tahap 9.0: percakapan channel terbatas hanya untuk pengguna yang berhak atas channel itu.
    channel: conversations.channelId,
  });
}

export function contactScope(grant: PermissionGrant): SQL {
  return scopeCondition(grant, {
    holder: (userId) => contactHeldBy(grant, userId),
    linkedTicketHolder: (userId) => openTicketLinksContact(userId, contacts.id),
  });
}

/** Kondisi pencarian nama/nomor kontak. */
export function searchCondition(q: string): SQL {
  const pattern = likePattern(q);
  const conditions: SQL[] = [
    ilike(contacts.name, pattern),
    ilike(contacts.profileName, pattern),
    ilike(contacts.waUsername, pattern),
    // Fase 6: @username Telegram/Instagram, alamat email.
    ilike(contacts.channelHandle, pattern),
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
  firstAssignedAt: Date | null;
  firstResponseAt: Date | null;
  channel: { id: string; name: string; type: ChannelType };
  contact: Pick<
    ContactRow,
    | 'id'
    | 'number'
    | 'name'
    | 'profileName'
    | 'phone'
    | 'waUsername'
    | 'channelType'
    | 'channelHandle'
  >;
  assignee: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
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
      firstAssignedAt: conversations.firstAssignedAt,
      firstResponseAt: conversations.firstResponseAt,
      channelId: channels.id,
      channelName: channels.name,
      channelType: channels.type,
      contactId: contacts.id,
      contactNumber: contacts.number,
      contactName: contacts.name,
      contactProfileName: contacts.profileName,
      contactPhone: contacts.phone,
      contactWaUsername: contacts.waUsername,
      contactChannelType: contacts.channelType,
      contactChannelHandle: contacts.channelHandle,
      assigneeId: users.id,
      assigneeName: users.name,
      departmentId: departments.id,
      departmentName: departments.name,
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
    )
    .leftJoin(
      departments,
      and(
        eq(departments.organizationId, conversations.organizationId),
        eq(departments.id, conversations.departmentId),
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
    firstAssignedAt: row.firstAssignedAt,
    firstResponseAt: row.firstResponseAt,
    channel: { id: row.channelId, name: row.channelName, type: row.channelType },
    contact: {
      id: row.contactId,
      number: row.contactNumber,
      name: row.contactName,
      profileName: row.contactProfileName,
      phone: row.contactPhone,
      waUsername: row.contactWaUsername,
      channelType: row.contactChannelType,
      channelHandle: row.contactChannelHandle,
    },
    assignee:
      row.assigneeId !== null && row.assigneeName !== null
        ? { id: row.assigneeId, name: row.assigneeName }
        : null,
    department:
      row.departmentId !== null && row.departmentName !== null
        ? { id: row.departmentId, name: row.departmentName }
        : null,
  };
}

/**
 * Saringan bersama daftar & hitungan (tanpa tab/status). Status jendela dihitung terhadap `now`
 * (jam server); "hampir habis" = sisa ≤ `WINDOW_EXPIRING_SOON_MS`.
 */
export function conversationFilterCondition(
  grant: PermissionGrant,
  filter: ConversationFilter,
  now: Date,
): SQL {
  const soon = new Date(now.getTime() + WINDOW_EXPIRING_SOON_MS);
  let assignee: SQL | undefined;
  if (filter.assignee === 'me') assignee = eq(conversations.assigneeUserId, grant.userId);
  else if (filter.assignee === 'unassigned') assignee = isNull(conversations.assigneeUserId);
  else if (filter.assignee !== undefined) {
    assignee = eq(conversations.assigneeUserId, filter.assignee);
  }
  let window: SQL | undefined;
  switch (filter.window) {
    case 'open':
      window = gt(conversations.windowExpiresAt, soon);
      break;
    case 'expiring':
      window = and(
        gt(conversations.windowExpiresAt, now),
        lte(conversations.windowExpiresAt, soon),
      );
      break;
    case 'expired':
      window = lte(conversations.windowExpiresAt, now);
      break;
    case 'none':
      window = isNull(conversations.windowExpiresAt);
      break;
    case undefined:
      break;
  }
  return and(
    eq(conversations.organizationId, grant.organizationId),
    conversationScope(grant),
    filter.channelId === undefined ? undefined : eq(conversations.channelId, filter.channelId),
    filter.departmentId === undefined
      ? undefined
      : filter.departmentId === 'none'
        ? isNull(conversations.departmentId)
        : eq(conversations.departmentId, filter.departmentId),
    assignee,
    window,
    filter.unread === undefined
      ? undefined
      : filter.unread
        ? gt(conversations.unreadCount, 0)
        : eq(conversations.unreadCount, 0),
    filter.q === undefined ? undefined : searchCondition(filter.q),
    // Tag menempel ke KONTAK (DECISIONS 2026-11-17): percakapan yang kontaknya memakai tag ini.
    filter.tagId === undefined
      ? undefined
      : sql`exists (select 1 from ${contactTags} where ${contactTags.organizationId} = ${conversations.organizationId} and ${contactTags.contactId} = ${conversations.contactId} and ${contactTags.tagId} = ${filter.tagId})`,
    // Tahap 9.0 "Alamat tujuan": pernah menerima email masuk ke alamat/alias ini (indeks
    // `messages_email_recipient_idx`).
    filter.emailRecipient === undefined
      ? undefined
      : sql`exists (select 1 from ${messages} where ${messages.organizationId} = ${conversations.organizationId} and ${messages.emailRecipient} = ${filter.emailRecipient} and ${messages.conversationId} = ${conversations.id})`,
  ) as SQL;
}

export async function listConversations(
  db: DbExecutor,
  grant: PermissionGrant,
  query: Omit<ConversationListQuery, 'cursor' | 'limit'>,
  options: { limit: number; cursor?: Cursor | undefined; now: Date },
): Promise<ConversationRowView[]> {
  const { status, ...filter } = query;
  const rows = await selectConversations(db)
    .where(
      and(
        conversationFilterCondition(grant, filter, options.now),
        status === undefined ? undefined : eq(conversations.status, status),
        options.cursor === undefined
          ? undefined
          : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(options.limit);
  return rows.map(toConversationRowView);
}

/** Jumlah per tab dalam satu query (`count(*) filter (…)`), sesuai cakupan + saringan. */
export async function countConversations(
  db: DbExecutor,
  grant: PermissionGrant,
  filter: ConversationFilter,
  now: Date,
): Promise<ConversationCountsResponse> {
  const byStatus = (status: ConversationStatus) =>
    sql<number>`(count(*) filter (where ${conversations.status} = ${status}))::int`;
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      bot: byStatus('bot'),
      unserved: byStatus('unserved'),
      served: byStatus('served'),
      resolved: byStatus('resolved'),
      unreadOpen: sql<number>`(count(*) filter (where ${conversations.status} <> 'resolved' and ${conversations.unreadCount} > 0))::int`,
    })
    .from(conversations)
    .innerJoin(
      contacts,
      and(
        eq(contacts.organizationId, conversations.organizationId),
        eq(contacts.id, conversations.contactId),
      ),
    )
    .where(conversationFilterCondition(grant, filter, now));
  const value = (n: number | undefined) => Number(n ?? 0);
  return {
    counts: {
      all: value(row?.all),
      bot: value(row?.bot),
      unserved: value(row?.unserved),
      served: value(row?.served),
      resolved: value(row?.resolved),
    },
    unreadOpen: value(row?.unreadOpen),
  };
}

/**
 * Tandai sudah dibaca: `unread_count = 0` untuk percakapan DALAM cakupan. Penghitung per
 * PERCAKAPAN (dipakai bersama tim — DECISIONS 2026-11-16). `true` bila ada yang berubah,
 * `false` bila sudah 0, `undefined` bila percakapan tidak ada/di luar cakupan.
 */
export async function markConversationRead(
  db: DbExecutor,
  grant: PermissionGrant,
  conversationId: string,
): Promise<boolean | undefined> {
  const scoped = and(
    eq(conversations.organizationId, grant.organizationId),
    eq(conversations.id, conversationId),
    conversationScope(grant),
  );
  const updated = await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(and(scoped, gt(conversations.unreadCount, 0)))
    .returning({ id: conversations.id });
  if (updated.length > 0) return true;
  const [exists] = await db.select({ id: conversations.id }).from(conversations).where(scoped);
  return exists ? false : undefined;
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

/** `senderName` = nama tampilan agen pengirim (pesan keluar oleh manusia), tanpa email. */
export type MessageRowView = MessageRow & { occurredAtExact: string; senderName?: string | null };

/** Nama tampilan pengirim satu pesan (untuk jawaban kirim/kirim ulang/tandai). */
export async function senderNameOf(
  db: DbExecutor,
  row: Pick<MessageRow, 'organizationId' | 'senderUserId'>,
): Promise<string | null> {
  if (!row.senderUserId) return null;
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, row.organizationId), eq(users.id, row.senderUserId)));
  return user?.name ?? null;
}

/** Saringan panel detail (`only`): pesan ditandai / media / file. */
function messageFilterCondition(only: MessageListFilter | undefined): SQL | undefined {
  switch (only) {
    case 'starred':
      return isNotNull(messages.starredAt);
    case 'media':
      return inArray(messages.type, ['image', 'video', 'sticker']);
    case 'files':
      return inArray(messages.type, ['document', 'audio']);
    case undefined:
      return undefined;
  }
}

/** Pesan satu percakapan (PEMANGGIL sudah memastikan percakapannya dalam cakupan). */
export async function listMessages(
  db: DbExecutor,
  organizationId: string,
  conversationId: string,
  options: { limit: number; cursor?: Cursor | undefined; only?: MessageListFilter | undefined },
): Promise<MessageRowView[]> {
  const rows = await db
    .select({
      message: messages,
      occurredAtExact: exactTime(sql`${messages.occurredAt}`),
      senderName: users.name,
    })
    .from(messages)
    .leftJoin(
      users,
      and(eq(users.organizationId, messages.organizationId), eq(users.id, messages.senderUserId)),
    )
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.conversationId, conversationId),
        messageFilterCondition(options.only),
        options.cursor === undefined
          ? undefined
          : sql`(${messages.occurredAt}, ${messages.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(messages.occurredAt), desc(messages.id))
    .limit(options.limit);
  return rows.map((row) => ({
    ...row.message,
    occurredAtExact: row.occurredAtExact,
    senderName: row.senderName,
  }));
}

/** Tag tiap kontak (satu query), urut nama tanpa membedakan huruf besar/kecil. */
export async function contactTagsOf(
  db: DbExecutor,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Map<string, TagRef[]>> {
  const found = new Map<string, TagRef[]>();
  if (contactIds.length === 0) return found;
  const rows = await db
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(contactTags)
    .innerJoin(
      tags,
      and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)),
    )
    .where(
      and(
        eq(contactTags.organizationId, organizationId),
        inArray(contactTags.contactId, [...new Set(contactIds)]),
      ),
    )
    .orderBy(sql`lower(${tags.name})`, tags.id);
  for (const row of rows) {
    const list = found.get(row.contactId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color as TagColor });
    found.set(row.contactId, list);
  }
  return found;
}

/** Pesan terakhir + tag kontak untuk sekumpulan percakapan (dua query, bukan N+1). */
export async function conversationExtras(
  db: DbExecutor,
  organizationId: string,
  rows: readonly ConversationRowView[],
): Promise<{ lastMessages: Map<string, LastMessageRow>; tags: Map<string, TagRef[]> }> {
  const [lastMessages, tagsByContact] = await Promise.all([
    lastMessagesOf(
      db,
      organizationId,
      rows.map((row) => row.id),
    ),
    contactTagsOf(
      db,
      organizationId,
      rows.map((row) => row.contact.id),
    ),
  ]);
  return { lastMessages, tags: tagsByContact };
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
