import {
  apiKeys,
  channelAccessSql,
  contacts,
  conversations,
  departments,
  ticketBoards,
  ticketColumns,
  tickets,
  users,
  type DbExecutor,
  type TicketColumnRow,
  type TicketRow,
} from '@balesin/db';
import {
  TICKET_LIMITS,
  type Ticket,
  type TicketBoard,
  type TicketColumn,
  type TicketListQuery,
} from '@balesin/shared';
import {
  and,
  asc,
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
import { alias } from 'drizzle-orm/pg-core';

import { toAttributeDefinition, listAttributeDefinitions } from '../attributes/attributes.service';
import { grantPrincipal, scopeCondition, type PermissionGrant } from '../auth/permission-grant';
import { likePattern, type Cursor } from '../inbox/inbox.repo';
import { toContactSummary } from '../inbox/inbox-view';

/**
 * Query tiket (Fase 5). SEMUA query daftar memakai `grant` (`tickets.manage`) dan menyaring cakupan
 * di SQL: Teknisi `own` = tiket yang ia pegang; pengguna bertanda departemen = tiket yang ia pegang
 * atau tiket di board departemennya.
 */

/** Departemen tiket = departemen board-nya. */
const ticketDepartment = sql`(select ${ticketBoards.departmentId} from ${ticketBoards} where ${ticketBoards.organizationId} = ${tickets.organizationId} and ${ticketBoards.id} = ${tickets.boardId})`;

export function ticketScope(grant: PermissionGrant): SQL {
  return scopeCondition(grant, { holder: tickets.assigneeUserId, department: ticketDepartment });
}

const assignee = alias(users, 'ticket_assignee');
const creator = alias(users, 'ticket_creator');
const creatorKey = alias(apiKeys, 'ticket_creator_key');

const updatedExact = sql<string>`to_char(${tickets.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** `grant` = penonton (akses per channel percakapan tertaut, review 9.0 R5). */
function selectTickets(db: DbExecutor, grant: PermissionGrant) {
  return db
    .select({
      ticket: tickets,
      updatedAtExact: updatedExact,
      column: ticketColumns,
      assigneeName: assignee.name,
      contactId: contacts.id,
      contactNumber: contacts.number,
      contactName: contacts.name,
      contactProfileName: contacts.profileName,
      contactPhone: contacts.phone,
      contactWaUsername: contacts.waUsername,
      conversationNumber: conversations.number,
      conversationStatus: conversations.status,
      conversationVisible: sql<boolean>`(${conversations.id} is null or ${channelAccessSql(grant.organizationId, grantPrincipal(grant), conversations.channelId)})`,
      creatorName: creator.name,
      creatorKeyName: creatorKey.name,
    })
    .from(tickets)
    .innerJoin(
      ticketColumns,
      and(eq(ticketColumns.boardId, tickets.boardId), eq(ticketColumns.id, tickets.columnId)),
    )
    .leftJoin(
      assignee,
      and(
        eq(assignee.organizationId, tickets.organizationId),
        eq(assignee.id, tickets.assigneeUserId),
      ),
    )
    .leftJoin(
      contacts,
      and(eq(contacts.organizationId, tickets.organizationId), eq(contacts.id, tickets.contactId)),
    )
    .leftJoin(
      conversations,
      and(
        eq(conversations.organizationId, tickets.organizationId),
        eq(conversations.id, tickets.conversationId),
      ),
    )
    .leftJoin(
      creator,
      and(
        eq(creator.organizationId, tickets.organizationId),
        eq(creator.id, tickets.createdByUserId),
      ),
    )
    .leftJoin(
      creatorKey,
      and(
        eq(creatorKey.organizationId, tickets.organizationId),
        eq(creatorKey.id, tickets.createdByApiKeyId),
      ),
    );
}

type SelectedTicket = Awaited<ReturnType<ReturnType<typeof selectTickets>['where']>>[number];

export function toTicketColumn(row: TicketColumnRow): TicketColumn {
  return { id: row.id, name: row.name, position: row.position, isDone: row.isDone };
}

export function toTicket(row: SelectedTicket, now: Date): Ticket & { updatedAtExact: string } {
  const ticket: TicketRow = row.ticket;
  return {
    id: ticket.id,
    number: ticket.number,
    boardId: ticket.boardId,
    column: toTicketColumn(row.column),
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    assignee:
      ticket.assigneeUserId !== null && row.assigneeName !== null
        ? { id: ticket.assigneeUserId, name: row.assigneeName }
        : null,
    dueAt: ticket.dueAt?.toISOString() ?? null,
    overdue:
      ticket.dueAt !== null && ticket.closedAt === null && ticket.dueAt.getTime() < now.getTime(),
    contact:
      row.contactId !== null && row.contactNumber !== null
        ? toContactSummary({
            id: row.contactId,
            number: row.contactNumber,
            name: row.contactName,
            profileName: row.contactProfileName,
            phone: row.contactPhone,
            waUsername: row.contactWaUsername,
          })
        : null,
    conversationUnavailable: ticket.conversationId !== null && row.conversationVisible !== true,
    conversation:
      ticket.conversationId !== null &&
      row.conversationVisible === true &&
      row.conversationNumber !== null &&
      row.conversationStatus !== null
        ? {
            id: ticket.conversationId,
            number: row.conversationNumber,
            status: row.conversationStatus,
          }
        : null,
    attributes: Array.isArray(ticket.attributes) ? ticket.attributes : [],
    position: ticket.position,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    createdBy:
      ticket.createdByUserId !== null && row.creatorName !== null
        ? { kind: 'user', id: ticket.createdByUserId, name: row.creatorName }
        : ticket.createdByApiKeyId !== null && row.creatorKeyName !== null
          ? { kind: 'api_key', id: ticket.createdByApiKeyId, name: row.creatorKeyName }
          : null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    updatedAtExact: row.updatedAtExact,
  };
}

/** Satu tiket DALAM cakupan, atau `undefined`. */
export async function findTicket(
  db: DbExecutor,
  grant: PermissionGrant,
  ticketId: string,
  now: Date,
): Promise<Ticket | undefined> {
  const [row] = await selectTickets(db, grant)
    .where(
      and(
        eq(tickets.organizationId, grant.organizationId),
        eq(tickets.id, ticketId),
        ticketScope(grant),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const { updatedAtExact: _exact, ...ticket } = toTicket(row, now);
  return ticket;
}

function ticketFilter(
  grant: PermissionGrant,
  query: Omit<TicketListQuery, 'cursor' | 'limit'>,
  now: Date,
) {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
  const week = new Date(now.getTime() + 7 * 86_400_000);
  let due: SQL | undefined;
  switch (query.due) {
    case 'overdue':
      due = and(isNotNull(tickets.dueAt), lte(tickets.dueAt, now), isNull(tickets.closedAt));
      break;
    case 'today':
      due = and(gt(tickets.dueAt, startOfDay), lte(tickets.dueAt, endOfDay));
      break;
    case 'week':
      due = and(gt(tickets.dueAt, now), lte(tickets.dueAt, week));
      break;
    case 'none':
      due = isNull(tickets.dueAt);
      break;
    case undefined:
      break;
  }
  let q: SQL | undefined;
  if (query.q !== undefined) {
    const number = /^#?(\d{1,15})$/.exec(query.q)?.[1];
    q = number
      ? or(eq(tickets.number, Number(number)), ilike(tickets.title, likePattern(query.q)))
      : ilike(tickets.title, likePattern(query.q));
  }
  return and(
    eq(tickets.organizationId, grant.organizationId),
    ticketScope(grant),
    query.boardId === undefined ? undefined : eq(tickets.boardId, query.boardId),
    query.columnId === undefined ? undefined : eq(tickets.columnId, query.columnId),
    query.assignee === undefined
      ? undefined
      : query.assignee === 'me'
        ? eq(tickets.assigneeUserId, grant.userId)
        : query.assignee === 'none'
          ? isNull(tickets.assigneeUserId)
          : eq(tickets.assigneeUserId, query.assignee),
    query.priority === undefined ? undefined : eq(tickets.priority, query.priority),
    query.status === 'open'
      ? isNull(tickets.closedAt)
      : query.status === 'closed'
        ? isNotNull(tickets.closedAt)
        : undefined,
    query.contactId === undefined ? undefined : eq(tickets.contactId, query.contactId),
    query.conversationId === undefined
      ? undefined
      : eq(tickets.conversationId, query.conversationId),
    due,
    q,
  ) as SQL;
}

export async function listTickets(
  db: DbExecutor,
  grant: PermissionGrant,
  query: Omit<TicketListQuery, 'cursor' | 'limit'>,
  options: { limit: number; cursor?: Cursor | undefined; now: Date },
) {
  const rows = await selectTickets(db, grant)
    .where(
      and(
        ticketFilter(grant, query, options.now),
        options.cursor === undefined
          ? undefined
          : sql`(${tickets.updatedAt}, ${tickets.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(tickets.updatedAt), desc(tickets.id))
    .limit(options.limit);
  return rows.map((row) => toTicket(row, options.now));
}

/** Kanban: tiap kolom maks. `kanbanPerColumn` tiket (urut `position`) + jumlah total per kolom. */
export async function kanbanTickets(
  db: DbExecutor,
  grant: PermissionGrant,
  boardId: string,
  query: Pick<TicketListQuery, 'assignee' | 'priority'>,
  now: Date,
) {
  const where = ticketFilter(grant, { ...query, boardId, status: 'all' }, now);
  const ranked = db
    .select({
      id: tickets.id,
      rank: sql<number>`row_number() over (partition by ${tickets.columnId} order by ${tickets.position}, ${tickets.id})`.as(
        'rank',
      ),
    })
    .from(tickets)
    .where(where)
    .as('ranked');
  const rows = await selectTickets(db, grant)
    .innerJoin(ranked, eq(ranked.id, tickets.id))
    .where(lte(ranked.rank, TICKET_LIMITS.kanbanPerColumn))
    .orderBy(asc(tickets.position), asc(tickets.id));
  const totals = await db
    .select({ columnId: tickets.columnId, total: sql<number>`count(*)::int` })
    .from(tickets)
    .where(where)
    .groupBy(tickets.columnId);
  return {
    tickets: rows.map((row) => toTicket(row, now)),
    totals: new Map(totals.map((row) => [row.columnId, Number(row.total)])),
  };
}

/** Board lengkap (kolom, atribut, departemen). */
export async function loadBoards(
  db: DbExecutor,
  organizationId: string,
  options: { boardId?: string; includeArchived?: boolean } = {},
): Promise<TicketBoard[]> {
  const boards = await db
    .select({ board: ticketBoards, departmentName: departments.name })
    .from(ticketBoards)
    .leftJoin(
      departments,
      and(
        eq(departments.organizationId, ticketBoards.organizationId),
        eq(departments.id, ticketBoards.departmentId),
      ),
    )
    .where(
      and(
        eq(ticketBoards.organizationId, organizationId),
        options.boardId === undefined ? undefined : eq(ticketBoards.id, options.boardId),
        options.includeArchived ? undefined : isNull(ticketBoards.archivedAt),
      ),
    )
    .orderBy(asc(ticketBoards.position), asc(ticketBoards.createdAt));
  if (boards.length === 0) return [];
  const columns = await db
    .select()
    .from(ticketColumns)
    .where(
      and(
        eq(ticketColumns.organizationId, organizationId),
        inArray(
          ticketColumns.boardId,
          boards.map((row) => row.board.id),
        ),
      ),
    )
    .orderBy(asc(ticketColumns.position));
  const result: TicketBoard[] = [];
  for (const { board, departmentName } of boards) {
    const definitions = await listAttributeDefinitions(db, organizationId, {
      entity: 'ticket',
      boardId: board.id,
    });
    result.push({
      id: board.id,
      name: board.name,
      description: board.description,
      department:
        board.departmentId !== null && departmentName !== null
          ? { id: board.departmentId, name: departmentName }
          : null,
      position: board.position,
      columns: columns.filter((column) => column.boardId === board.id).map(toTicketColumn),
      attributes: definitions.map(toAttributeDefinition),
      archivedAt: board.archivedAt?.toISOString() ?? null,
      createdAt: board.createdAt.toISOString(),
      updatedAt: board.updatedAt.toISOString(),
    });
  }
  return result;
}
