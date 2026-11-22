import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  contacts,
  conversations,
  departmentAccessOf,
  departments,
  recordOutgoingEvent,
  ticketBoards,
  ticketColumns,
  ticketComments,
  ticketEvents,
  tickets,
  users,
  type Database,
  type DbExecutor,
  type TicketColumnRow,
  type TicketRow,
} from '@balesin/db';
import {
  DEFAULT_TICKET_COLUMNS,
  TICKET_LIMITS,
  effectivePermissionScope,
  hasPermission,
  isWithinScope,
  permissionScope,
  validateAttributeValues,
  type CreateTicketBoardRequest,
  type CreateTicketColumnRequest,
  type CreateTicketRequest,
  type PermissionScope,
  type TicketComment,
  type TicketEditableField,
  type TicketEvent,
  type UpdateTicketBoardRequest,
  type UpdateTicketColumnRequest,
  type UpdateTicketRequest,
} from '@balesin/shared';
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Column } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { assertApiKeyStillAuthorized } from '../api-keys/api-key-actor';
import { attributeRules, attributeValidationError } from '../attributes/attributes.service';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { findContact, findConversation } from '../inbox/inbox.repo';
import { ticketScope } from './tickets.repo';

/**
 * Tiket / tugas (Fase 5, docs/KONTRAK-API-CRM-TIKET.md "Tiket").
 *
 * Pelaku: pengguna (sesi, `tickets.manage` + cakupan) atau API key (`tickets:write`, cakupan
 * organisasi). Pemeriksaan wewenang diulang DI TRANSAKSI TULIS (`assertActorStillAuthorized` /
 * `assertApiKeyStillAuthorized`).
 *
 * Aturan keamanan penting:
 *  - Tautan kontak/percakapan hanya ke data yang BOLEH dilihat pelaku (cakupan `contacts.view` /
 *    `inbox.view`) — tiket tidak bisa dipakai untuk "membuka" percakapan di luar cakupan, karena
 *    tiket terbuka yang dipegang Teknisi memberi akses ke percakapan kontak tautannya.
 *  - Teknisi (`own`): hanya tiket miliknya; tidak bisa mengubah penanggung jawab/tautan; tiket yang
 *    ia buat selalu ditugaskan ke dirinya.
 *  - Pengguna bertanda departemen: membuat/memindah tiket hanya ke board departemennya (kecuali
 *    tiket itu ia pegang sendiri).
 * Riwayat (`ticket_events`) dan webhook (`ticket.created`/`ticket.updated`) tanpa isi deskripsi/komentar
 * di riwayat; webhook memuat tiket seperti API.
 */

export const TICKET_NOT_FOUND = 'Tiket tidak ditemukan.';
export const BOARD_NOT_FOUND = 'Board tidak ditemukan.';
export const COLUMN_NOT_FOUND = 'Kolom tidak ditemukan.';

export type TicketActor =
  | { kind: 'user'; auth: AuthContext; client: ClientInfo }
  | { kind: 'api_key'; organizationId: string; apiKeyId: string };

interface ResolvedActor {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
  scope: PermissionScope;
  departmentIds: string[];
  /** Grant `tickets.manage` untuk filter SQL. */
  grant: PermissionGrant;
  /** Grant untuk memeriksa tautan (inbox/kontak). */
  inboxGrant: PermissionGrant;
  contactsGrant: PermissionGrant;
}

export function createTicketsService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}) {
  const { db, publisher, accessDenied } = deps;
  const now = deps.now ?? (() => new Date());

  /** Pemeriksaan ulang pelaku di transaksi + cakupan sebenarnya. */
  async function resolveActor(tx: DbExecutor, actor: TicketActor): Promise<ResolvedActor> {
    if (actor.kind === 'api_key') {
      await assertApiKeyStillAuthorized(tx, actor, 'tickets:write', now());
      const base = {
        scope: 'all' as const,
        userId: actor.apiKeyId,
        organizationId: actor.organizationId,
        principal: 'apiKey' as const,
      };
      return {
        organizationId: actor.organizationId,
        userId: null,
        apiKeyId: actor.apiKeyId,
        scope: 'all',
        departmentIds: [],
        grant: { ...base, permission: 'tickets.manage' },
        inboxGrant: { ...base, permission: 'inbox.view' },
        contactsGrant: { ...base, permission: 'contacts.view' },
      };
    }
    const { auth } = actor;
    const { role } = await assertActorStillAuthorized(tx, auth, 'tickets.manage');
    const access = (await departmentAccessOf(tx, auth.organizationId, [auth.user.id])).get(
      auth.user.id,
    );
    const scope = effectivePermissionScope(role, 'tickets.manage', {
      departmentRestricted: access?.restricted ?? false,
    });
    const inboxScope = permissionScope(role, 'inbox.view');
    const contactsScope = permissionScope(role, 'contacts.view');
    if (!scope) throw authorityChanged();
    const base = {
      userId: auth.user.id,
      organizationId: auth.organizationId,
      principal: 'user' as const,
    };
    return {
      organizationId: auth.organizationId,
      userId: auth.user.id,
      apiKeyId: null,
      scope,
      departmentIds: access?.departmentIds ?? [],
      // SQL cakupan membaca tanda departemen sendiri → grant memakai cakupan PERAN.
      grant: {
        ...base,
        permission: 'tickets.manage',
        scope: permissionScope(role, 'tickets.manage') ?? 'own',
      },
      // Tanpa izin lihat percakapan/kontak → tautan apa pun ditolak (cakupan `own` = hanya miliknya).
      inboxGrant: { ...base, permission: 'inbox.view', scope: inboxScope ?? 'own' },
      contactsGrant: { ...base, permission: 'contacts.view', scope: contactsScope ?? 'own' },
    };
  }

  async function lockTicket(tx: DbExecutor, resolved: ResolvedActor, ticketId: string) {
    const [row] = await tx
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.organizationId, resolved.organizationId),
          eq(tickets.id, ticketId),
          ticketScope(resolved.grant),
        ),
      )
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
    return row;
  }

  async function boardOf(tx: DbExecutor, organizationId: string, boardId: string, lock = false) {
    const query = tx
      .select()
      .from(ticketBoards)
      .where(and(eq(ticketBoards.organizationId, organizationId), eq(ticketBoards.id, boardId)));
    const [board] = lock ? await query.for('update') : await query;
    if (!board) throw new AppError('NOT_FOUND', { message: BOARD_NOT_FOUND });
    return board;
  }

  async function columnsOf(tx: DbExecutor, organizationId: string, boardId: string) {
    return tx
      .select()
      .from(ticketColumns)
      .where(
        and(eq(ticketColumns.organizationId, organizationId), eq(ticketColumns.boardId, boardId)),
      )
      .orderBy(asc(ticketColumns.position), asc(ticketColumns.createdAt));
  }

  async function columnById(tx: DbExecutor, organizationId: string, columnId: string) {
    const [column] = await tx
      .select()
      .from(ticketColumns)
      .where(and(eq(ticketColumns.organizationId, organizationId), eq(ticketColumns.id, columnId)));
    if (!column) throw new AppError('NOT_FOUND', { message: COLUMN_NOT_FOUND });
    return column;
  }

  /** Penanggung jawab: pengguna aktif organisasi yang memegang `tickets.manage`. */
  async function assertAssignable(tx: DbExecutor, organizationId: string, userId: string) {
    const [user] = await tx
      .select({ role: users.role })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.id, userId),
          isNull(users.disabledAt),
        ),
      );
    if (!user || !hasPermission(user.role, 'tickets.manage')) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Penanggung jawab tidak ditemukan atau tidak aktif.',
        details: [
          { location: 'body', field: 'assigneeUserId', message: 'Pilih anggota tim yang aktif.' },
        ],
      });
    }
  }

  /**
   * Tautan kontak/percakapan → `{ contactId, conversationId }` yang sah. Percakapan menentukan
   * kontaknya. Data di luar cakupan pelaku = "tidak ditemukan".
   */
  async function resolveLinks(
    tx: DbExecutor,
    resolved: ResolvedActor,
    contactId: string | null,
    conversationId: string | null,
  ): Promise<{ contactId: string | null; conversationId: string | null }> {
    if (conversationId !== null) {
      const conversation = await findConversation(tx, resolved.inboxGrant, conversationId);
      if (!conversation) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Percakapan tidak ditemukan.',
          details: [
            { location: 'body', field: 'conversationId', message: 'Percakapan tidak ditemukan.' },
          ],
        });
      }
      if (contactId !== null && contactId !== conversation.contact.id) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Kontak tidak sesuai dengan percakapan yang ditautkan.',
          details: [
            {
              location: 'body',
              field: 'contactId',
              message: 'Kontak berbeda dengan kontak percakapan.',
            },
          ],
        });
      }
      return { contactId: conversation.contact.id, conversationId };
    }
    if (contactId !== null) {
      const contact = await findContact(tx, resolved.contactsGrant, contactId);
      if (!contact) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Kontak tidak ditemukan.',
          details: [{ location: 'body', field: 'contactId', message: 'Kontak tidak ditemukan.' }],
        });
      }
    }
    return { contactId, conversationId: null };
  }

  /** Tiket hasil aksi harus tetap dalam cakupan pelaku bercakupan sempit (`department`/`own`). */
  async function assertTargetInScope(
    actor: TicketActor,
    resolved: ResolvedActor,
    target: { assigneeUserId: string | null; departmentId: string | null },
  ) {
    if (actor.kind !== 'user' || resolved.userId === null || resolved.scope === 'all') return;
    const allowed = isWithinScope(
      resolved.scope,
      resolved.userId,
      {
        holderUserIds: target.assigneeUserId ? [target.assigneeUserId] : [],
        departmentId: target.departmentId,
      },
      resolved.departmentIds,
    );
    if (!allowed) {
      await forbidByRule(accessDenied, {
        auth: actor.auth,
        rule: ACCESS_RULES.ticketOutsideScope,
        client: actor.client,
        message:
          'Kamu hanya bisa menaruh tiket di board departemenmu, atau tiket yang kamu pegang.',
      });
    }
  }

  async function nextPosition(tx: DbExecutor, organizationId: string, columnId: string) {
    const [row] = await tx
      .select({ max: sql<number | null>`max(${tickets.position})` })
      .from(tickets)
      .where(and(eq(tickets.organizationId, organizationId), eq(tickets.columnId, columnId)));
    return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
  }

  async function event(
    tx: DbExecutor,
    resolved: ResolvedActor,
    ticketId: string,
    values: Partial<typeof ticketEvents.$inferInsert> & {
      kind: (typeof ticketEvents.$inferInsert)['kind'];
    },
  ) {
    await tx.insert(ticketEvents).values({
      organizationId: resolved.organizationId,
      ticketId,
      actorUserId: resolved.userId,
      apiKeyId: resolved.apiKeyId,
      ...values,
    });
  }

  async function outgoing(tx: DbExecutor, resolved: ResolvedActor, type: string, ticketId: string) {
    await recordOutgoingEvent(tx, {
      organizationId: resolved.organizationId,
      type,
      ticketId,
      actorUserId: resolved.userId,
    });
  }

  /**
   * Akses Teknisi lewat tiket berubah (penanggung jawab/tautan/selesai) → percakapan kontak itu diberi
   * `conversation.updated` supaya inbox pemegang baru memuat ulang (hub menyaring per cakupan).
   */
  async function publishLinkedConversations(organizationId: string, contactIds: (string | null)[]) {
    const ids = [...new Set(contactIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return;
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          inArray(conversations.contactId, ids),
          ne(conversations.status, 'resolved'),
        ),
      )
      .limit(20);
    await publisher.publish(
      rows.map((row) => ({
        type: 'conversation.updated' as const,
        organizationId,
        conversationId: row.id,
      })),
    );
  }

  async function validatedAttributes(
    tx: DbExecutor,
    organizationId: string,
    boardId: string,
    values: { key: string; value: string }[],
  ) {
    const checked = validateAttributeValues(
      await attributeRules(tx, organizationId, { entity: 'ticket', boardId }),
      values,
      { enforceRequired: true },
    );
    if (!checked.ok) throw attributeValidationError(checked.issues);
    return checked.values;
  }

  async function applyColumnChange(
    tx: DbExecutor,
    resolved: ResolvedActor,
    current: TicketRow,
    target: TicketColumnRow,
    position: number,
  ): Promise<Partial<TicketRow>> {
    const from = await columnById(tx, resolved.organizationId, current.columnId);
    const patch: Partial<TicketRow> = {
      boardId: target.boardId,
      columnId: target.id,
      position,
    };
    if (from.id !== target.id) {
      await event(tx, resolved, current.id, {
        kind: 'moved',
        fromColumn: from.name,
        toColumn: target.name,
      });
    }
    if (target.isDone && current.closedAt === null) {
      patch.closedAt = now();
      await event(tx, resolved, current.id, { kind: 'closed' });
    } else if (!target.isDone && current.closedAt !== null) {
      patch.closedAt = null;
      await event(tx, resolved, current.id, { kind: 'reopened' });
    }
    return patch;
  }

  /** Posisi Kanban: di bawah `afterTicketId` (null = paling atas; undefined = paling bawah). */
  async function positionFor(
    tx: DbExecutor,
    organizationId: string,
    columnId: string,
    ticketId: string,
    afterTicketId: string | null | undefined,
  ): Promise<number> {
    const inColumn = and(
      eq(tickets.organizationId, organizationId),
      eq(tickets.columnId, columnId),
      ne(tickets.id, ticketId),
    );
    if (afterTicketId === undefined) return nextPosition(tx, organizationId, columnId);
    if (afterTicketId === null) {
      const [first] = await tx
        .select({ position: tickets.position })
        .from(tickets)
        .where(inColumn)
        .orderBy(asc(tickets.position))
        .limit(1);
      return first ? first.position - 1 : 0;
    }
    const [after] = await tx
      .select({ position: tickets.position })
      .from(tickets)
      .where(and(inColumn, eq(tickets.id, afterTicketId)));
    if (!after) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Tiket acuan tidak ada di kolom tujuan.',
        details: [
          { location: 'body', field: 'afterTicketId', message: 'Tiket acuan tidak ditemukan.' },
        ],
      });
    }
    const [next] = await tx
      .select({ position: tickets.position })
      .from(tickets)
      .where(and(inColumn, gt(tickets.position, after.position)))
      .orderBy(asc(tickets.position))
      .limit(1);
    return next ? (after.position + next.position) / 2 : after.position + 1;
  }

  return {
    // ── Tiket ──────────────────────────────────────────────────────────────

    async create(actor: TicketActor, input: CreateTicketRequest): Promise<string> {
      const result = await db.transaction(async (tx) => {
        const resolved = await resolveActor(tx, actor);
        const org = resolved.organizationId;
        const board = await boardOf(tx, org, input.boardId, true);
        if (board.archivedAt !== null) {
          throw new AppError('CONFLICT', {
            message: 'Board ini diarsipkan — tiket baru tidak bisa dibuat.',
          });
        }
        const columns = await columnsOf(tx, org, board.id);
        const column = input.columnId
          ? columns.find((candidate) => candidate.id === input.columnId)
          : columns[0];
        if (!column) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Kolom tidak ada di board ini.',
            details: [
              { location: 'body', field: 'columnId', message: 'Kolom tidak ada di board ini.' },
            ],
          });
        }
        let assigneeUserId = input.assigneeUserId ?? null;
        if (resolved.scope === 'own') {
          // Teknisi: tiket yang ia buat selalu miliknya.
          if (
            assigneeUserId !== null &&
            assigneeUserId !== resolved.userId &&
            actor.kind === 'user'
          ) {
            await forbidByRule(accessDenied, {
              auth: actor.auth,
              rule: ACCESS_RULES.ticketOwnRestrictedFields,
              client: actor.client,
              message: 'Kamu hanya bisa membuat tiket untuk dirimu sendiri.',
            });
          }
          assigneeUserId = resolved.userId;
        }
        if (assigneeUserId !== null) await assertAssignable(tx, org, assigneeUserId);
        await assertTargetInScope(actor, resolved, {
          assigneeUserId,
          departmentId: board.departmentId,
        });
        const links = await resolveLinks(
          tx,
          resolved,
          input.contactId ?? null,
          input.conversationId ?? null,
        );
        const attributes = await validatedAttributes(tx, org, board.id, input.attributes ?? []);
        const [row] = await tx
          .insert(tickets)
          .values({
            organizationId: org,
            boardId: board.id,
            columnId: column.id,
            title: input.title,
            description: input.description ?? null,
            priority: input.priority ?? 'normal',
            assigneeUserId,
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            contactId: links.contactId,
            conversationId: links.conversationId,
            attributes,
            position: await nextPosition(tx, org, column.id),
            closedAt: column.isDone ? now() : null,
            createdByUserId: resolved.userId,
            createdByApiKeyId: resolved.apiKeyId,
          })
          .returning();
        if (!row) throw new Error('Tiket tidak tersimpan');
        await event(tx, resolved, row.id, {
          kind: 'created',
          toColumn: column.name,
          assigneeUserId,
        });
        await outgoing(tx, resolved, 'ticket.created', row.id);
        return { id: row.id, organizationId: org, contactId: links.contactId, assigneeUserId };
      });
      if (result.assigneeUserId !== null) {
        await publishLinkedConversations(result.organizationId, [result.contactId]);
      }
      return result.id;
    },

    async update(actor: TicketActor, ticketId: string, input: UpdateTicketRequest): Promise<void> {
      const outcome = await db.transaction(async (tx) => {
        const resolved = await resolveActor(tx, actor);
        const org = resolved.organizationId;
        const current = await lockTicket(tx, resolved, ticketId);
        const restricted =
          input.assigneeUserId !== undefined ||
          input.contactId !== undefined ||
          input.conversationId !== undefined;
        if (resolved.scope === 'own' && restricted && actor.kind === 'user') {
          await forbidByRule(accessDenied, {
            auth: actor.auth,
            rule: ACCESS_RULES.ticketOwnRestrictedFields,
            client: actor.client,
            message: 'Penanggung jawab dan tautan tiket hanya bisa diubah Supervisor/CS/Admin.',
          });
        }
        const patch: Partial<typeof tickets.$inferInsert> = {};
        const fields: TicketEditableField[] = [];
        if (input.title !== undefined && input.title !== current.title) {
          patch.title = input.title;
          fields.push('title');
        }
        if (input.description !== undefined && input.description !== current.description) {
          patch.description = input.description;
          fields.push('description');
        }
        if (input.priority !== undefined && input.priority !== current.priority) {
          patch.priority = input.priority;
          fields.push('priority');
        }
        if (input.dueAt !== undefined) {
          const due = input.dueAt === null ? null : new Date(input.dueAt);
          if ((due?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
            patch.dueAt = due;
            fields.push('dueAt');
          }
        }
        if (input.attributes !== undefined) {
          const attributes = await validatedAttributes(tx, org, current.boardId, input.attributes);
          if (JSON.stringify(attributes) !== JSON.stringify(current.attributes)) {
            patch.attributes = attributes;
            fields.push('attributes');
          }
        }
        if (input.contactId !== undefined || input.conversationId !== undefined) {
          const links = await resolveLinks(
            tx,
            resolved,
            input.contactId === undefined ? current.contactId : input.contactId,
            input.conversationId === undefined
              ? input.contactId === undefined || input.contactId === current.contactId
                ? current.conversationId
                : null
              : input.conversationId,
          );
          if (links.contactId !== current.contactId) {
            patch.contactId = links.contactId;
            fields.push('contactId');
          }
          if (links.conversationId !== current.conversationId) {
            patch.conversationId = links.conversationId;
            fields.push('conversationId');
          }
        }
        let assigneeChanged = false;
        if (input.assigneeUserId !== undefined && input.assigneeUserId !== current.assigneeUserId) {
          if (input.assigneeUserId !== null) await assertAssignable(tx, org, input.assigneeUserId);
          patch.assigneeUserId = input.assigneeUserId;
          assigneeChanged = true;
          await event(tx, resolved, current.id, {
            kind: 'assigned',
            assigneeUserId: input.assigneeUserId,
            previousAssigneeUserId: current.assigneeUserId,
          });
        }
        if (fields.length === 0 && !assigneeChanged) return null;
        await tx
          .update(tickets)
          .set(patch)
          .where(and(eq(tickets.organizationId, org), eq(tickets.id, current.id)));
        if (fields.length > 0) await event(tx, resolved, current.id, { kind: 'updated', fields });
        await outgoing(tx, resolved, 'ticket.updated', current.id);
        const accessChanged =
          assigneeChanged || patch.contactId !== undefined || patch.conversationId !== undefined;
        return accessChanged
          ? { organizationId: org, contactIds: [current.contactId, patch.contactId ?? null] }
          : null;
      });
      if (outcome) await publishLinkedConversations(outcome.organizationId, outcome.contactIds);
    },

    async move(
      actor: TicketActor,
      ticketId: string,
      input: { columnId: string; afterTicketId?: string | null | undefined },
    ): Promise<void> {
      const outcome = await db.transaction(async (tx) => {
        const resolved = await resolveActor(tx, actor);
        const org = resolved.organizationId;
        const current = await lockTicket(tx, resolved, ticketId);
        const target = await columnById(tx, org, input.columnId);
        if (target.boardId !== current.boardId) {
          const board = await boardOf(tx, org, target.boardId);
          if (board.archivedAt !== null) {
            throw new AppError('CONFLICT', { message: 'Board tujuan diarsipkan.' });
          }
          if (resolved.scope === 'own' && actor.kind === 'user') {
            await forbidByRule(accessDenied, {
              auth: actor.auth,
              rule: ACCESS_RULES.ticketOwnRestrictedFields,
              client: actor.client,
              message: 'Kamu tidak bisa memindahkan tiket ke board lain.',
            });
          }
          await assertTargetInScope(actor, resolved, {
            assigneeUserId: current.assigneeUserId,
            departmentId: board.departmentId,
          });
          // Atribut wajib board tujuan harus terpenuhi.
          await validatedAttributes(tx, org, board.id, current.attributes);
        }
        const position = await positionFor(tx, org, target.id, current.id, input.afterTicketId);
        const patch = await applyColumnChange(tx, resolved, current, target, position);
        await tx
          .update(tickets)
          .set(patch)
          .where(and(eq(tickets.organizationId, org), eq(tickets.id, current.id)));
        if (current.columnId !== target.id)
          await outgoing(tx, resolved, 'ticket.updated', current.id);
        const closedChanged = patch.closedAt !== undefined;
        return closedChanged ? { organizationId: org, contactId: current.contactId } : null;
      });
      if (outcome) await publishLinkedConversations(outcome.organizationId, [outcome.contactId]);
    },

    async remove(auth: AuthContext, ticketId: string, client: ClientInfo): Promise<void> {
      const outcome = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const [row] = await tx
          .delete(tickets)
          .where(and(eq(tickets.organizationId, auth.organizationId), eq(tickets.id, ticketId)))
          .returning();
        if (!row) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.ticketDeleted,
          targetType: 'ticket',
          targetId: row.id,
          metadata: { number: row.number, boardId: row.boardId, actorRole: role },
          client,
        });
        return row;
      });
      await publishLinkedConversations(auth.organizationId, [outcome.contactId]);
    },

    // ── Komentar & riwayat ─────────────────────────────────────────────────

    async addComment(actor: TicketActor, ticketId: string, body: string): Promise<string> {
      return db.transaction(async (tx) => {
        const resolved = await resolveActor(tx, actor);
        const current = await lockTicket(tx, resolved, ticketId);
        const [row] = await tx
          .insert(ticketComments)
          .values({
            organizationId: resolved.organizationId,
            ticketId: current.id,
            body,
            authorUserId: resolved.userId,
            authorApiKeyId: resolved.apiKeyId,
          })
          .returning({ id: ticketComments.id });
        if (!row) throw new Error('Komentar tidak tersimpan');
        await event(tx, resolved, current.id, { kind: 'commented' });
        await tx
          .update(tickets)
          .set({ updatedAt: sql`now()` })
          .where(
            and(eq(tickets.organizationId, resolved.organizationId), eq(tickets.id, current.id)),
          );
        await outgoing(tx, resolved, 'ticket.updated', current.id);
        return row.id;
      });
    },

    async comments(grant: PermissionGrant, ticketId: string): Promise<TicketComment[] | undefined> {
      const [visible] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.organizationId, grant.organizationId),
            eq(tickets.id, ticketId),
            ticketScope(grant),
          ),
        );
      if (!visible) return undefined;
      const author = alias(users, 'comment_author');
      const rows = await db
        .select({
          comment: ticketComments,
          authorName: author.name,
          keyName: sql<
            string | null
          >`(select name from api_keys where api_keys.organization_id = ${ticketComments.organizationId} and api_keys.id = ${ticketComments.authorApiKeyId})`,
        })
        .from(ticketComments)
        .leftJoin(
          author,
          and(
            eq(author.organizationId, ticketComments.organizationId),
            eq(author.id, ticketComments.authorUserId),
          ),
        )
        .where(
          and(
            eq(ticketComments.organizationId, grant.organizationId),
            eq(ticketComments.ticketId, ticketId),
          ),
        )
        .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id))
        .limit(500);
      return rows.map(({ comment, authorName, keyName }) => ({
        id: comment.id,
        body: comment.body,
        author:
          comment.authorUserId !== null && authorName !== null
            ? { kind: 'user' as const, id: comment.authorUserId, name: authorName }
            : comment.authorApiKeyId !== null && keyName !== null
              ? { kind: 'api_key' as const, id: comment.authorApiKeyId, name: keyName }
              : null,
        createdAt: comment.createdAt.toISOString(),
      }));
    },

    /** Hapus komentar: penulisnya, atau pemegang `tickets.configure` (moderasi). */
    async deleteComment(
      auth: AuthContext,
      ticketId: string,
      commentId: string,
      client: ClientInfo,
    ) {
      await db.transaction(async (tx) => {
        const resolved = await resolveActor(tx, { kind: 'user', auth, client });
        await lockTicket(tx, resolved, ticketId);
        const [comment] = await tx
          .select()
          .from(ticketComments)
          .where(
            and(
              eq(ticketComments.organizationId, auth.organizationId),
              eq(ticketComments.ticketId, ticketId),
              eq(ticketComments.id, commentId),
            ),
          )
          .for('update');
        if (!comment) throw new AppError('NOT_FOUND', { message: 'Komentar tidak ditemukan.' });
        if (
          comment.authorUserId !== auth.user.id &&
          !hasPermission(auth.user.role, 'tickets.configure')
        ) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.ticketCommentDeleteOthers,
            client,
            message: 'Kamu hanya bisa menghapus komentarmu sendiri.',
          });
        }
        await tx
          .delete(ticketComments)
          .where(
            and(
              eq(ticketComments.organizationId, auth.organizationId),
              eq(ticketComments.id, commentId),
            ),
          );
      });
    },

    async events(grant: PermissionGrant, ticketId: string): Promise<TicketEvent[] | undefined> {
      const [visible] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.organizationId, grant.organizationId),
            eq(tickets.id, ticketId),
            ticketScope(grant),
          ),
        );
      if (!visible) return undefined;
      const actorUser = alias(users, 'event_actor');
      const nextUser = alias(users, 'event_assignee');
      const previousUser = alias(users, 'event_previous');
      const sameOrg = (table: { organizationId: Column; id: Column }, column: Column) =>
        and(eq(table.organizationId, ticketEvents.organizationId), eq(table.id, column));
      const rows = await db
        .select({
          event: ticketEvents,
          actorName: actorUser.name,
          keyName: sql<
            string | null
          >`(select name from api_keys where api_keys.organization_id = ${ticketEvents.organizationId} and api_keys.id = ${ticketEvents.apiKeyId})`,
          assigneeName: nextUser.name,
          previousName: previousUser.name,
        })
        .from(ticketEvents)
        .leftJoin(actorUser, sameOrg(actorUser, ticketEvents.actorUserId))
        .leftJoin(nextUser, sameOrg(nextUser, ticketEvents.assigneeUserId))
        .leftJoin(previousUser, sameOrg(previousUser, ticketEvents.previousAssigneeUserId))
        .where(
          and(
            eq(ticketEvents.organizationId, grant.organizationId),
            eq(ticketEvents.ticketId, ticketId),
          ),
        )
        .orderBy(desc(ticketEvents.createdAt), desc(ticketEvents.id))
        .limit(500);
      return rows.map(({ event: row, actorName, keyName, assigneeName, previousName }) => ({
        id: row.id,
        kind: row.kind,
        actor:
          row.actorUserId !== null && actorName !== null
            ? { kind: 'user' as const, id: row.actorUserId, name: actorName }
            : row.apiKeyId !== null && keyName !== null
              ? { kind: 'api_key' as const, id: row.apiKeyId, name: keyName }
              : null,
        fields: (row.fields as TicketEditableField[] | null) ?? null,
        fromColumn: row.fromColumn,
        toColumn: row.toColumn,
        assignee:
          row.assigneeUserId !== null && assigneeName !== null
            ? { id: row.assigneeUserId, name: assigneeName }
            : null,
        previousAssignee:
          row.previousAssigneeUserId !== null && previousName !== null
            ? { id: row.previousAssigneeUserId, name: previousName }
            : null,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    // ── Board & kolom (`tickets.configure`) ────────────────────────────────

    async createBoard(auth: AuthContext, input: CreateTicketBoardRequest, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const org = auth.organizationId;
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(ticketBoards)
          .where(and(eq(ticketBoards.organizationId, org), isNull(ticketBoards.archivedAt)));
        if (Number(count?.total ?? 0) >= TICKET_LIMITS.boardsPerOrganization) {
          throw new AppError('CONFLICT', {
            message: `Sudah ada ${String(TICKET_LIMITS.boardsPerOrganization)} board aktif (batas).`,
          });
        }
        if (input.departmentId) await assertDepartment(tx, org, input.departmentId);
        const [board] = await tx
          .insert(ticketBoards)
          .values({
            organizationId: org,
            name: input.name,
            description: input.description ?? null,
            departmentId: input.departmentId ?? null,
            position: Number(count?.total ?? 0),
          })
          .returning();
        if (!board) throw new Error('Board tidak tersimpan');
        const columns = input.columns ?? DEFAULT_TICKET_COLUMNS;
        await tx.insert(ticketColumns).values(
          columns.map((column, position) => ({
            organizationId: org,
            boardId: board.id,
            name: column.name,
            isDone: column.isDone ?? false,
            position,
          })),
        );
        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.ticketBoardCreated,
          targetType: 'ticket_board',
          targetId: board.id,
          metadata: { name: board.name, columns: columns.length },
          client,
        });
        return board.id;
      });
    },

    async updateBoard(
      auth: AuthContext,
      boardId: string,
      input: UpdateTicketBoardRequest,
      client: ClientInfo,
    ) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const org = auth.organizationId;
        const board = await boardOf(tx, org, boardId, true);
        const patch: Partial<typeof ticketBoards.$inferInsert> = {};
        const changed: string[] = [];
        if (input.name !== undefined && input.name !== board.name) {
          patch.name = input.name;
          changed.push('name');
        }
        if (input.description !== undefined && input.description !== board.description) {
          patch.description = input.description;
          changed.push('description');
        }
        if (input.departmentId !== undefined && input.departmentId !== board.departmentId) {
          if (input.departmentId !== null) await assertDepartment(tx, org, input.departmentId);
          patch.departmentId = input.departmentId;
          changed.push('departmentId');
        }
        if (input.position !== undefined && input.position !== board.position) {
          patch.position = input.position;
          changed.push('position');
        }
        if (input.archived !== undefined && input.archived !== (board.archivedAt !== null)) {
          patch.archivedAt = input.archived ? now() : null;
          changed.push('archived');
        }
        if (changed.length === 0) return;
        await tx
          .update(ticketBoards)
          .set(patch)
          .where(and(eq(ticketBoards.organizationId, org), eq(ticketBoards.id, boardId)));
        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.ticketBoardUpdated,
          targetType: 'ticket_board',
          targetId: boardId,
          metadata: { changedFields: changed },
          client,
        });
      });
    },

    async createColumn(
      auth: AuthContext,
      boardId: string,
      input: CreateTicketColumnRequest,
      client: ClientInfo,
    ) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const org = auth.organizationId;
        await boardOf(tx, org, boardId, true);
        const columns = await columnsOf(tx, org, boardId);
        if (columns.length >= TICKET_LIMITS.columnsPerBoard) {
          throw new AppError('CONFLICT', {
            message: `Board ini sudah punya ${String(TICKET_LIMITS.columnsPerBoard)} kolom (batas).`,
          });
        }
        const position = Math.min(input.position ?? columns.length, columns.length);
        const [row] = await tx
          .insert(ticketColumns)
          .values({
            organizationId: org,
            boardId,
            name: input.name,
            isDone: input.isDone ?? false,
            position,
          })
          .returning();
        if (!row) throw new Error('Kolom tidak tersimpan');
        const ordered = [...columns];
        ordered.splice(position, 0, row);
        await renumber(tx, org, ordered);
        await configured(tx, auth, boardId, 'column_created', client);
      });
    },

    async updateColumn(
      auth: AuthContext,
      boardId: string,
      columnId: string,
      input: UpdateTicketColumnRequest,
      client: ClientInfo,
    ) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const org = auth.organizationId;
        await boardOf(tx, org, boardId, true);
        const columns = await columnsOf(tx, org, boardId);
        const column = columns.find((candidate) => candidate.id === columnId);
        if (!column) throw new AppError('NOT_FOUND', { message: COLUMN_NOT_FOUND });
        const patch: Partial<typeof ticketColumns.$inferInsert> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.isDone !== undefined && input.isDone !== column.isDone) {
          patch.isDone = input.isDone;
          // Tiket di kolom ini ikut selesai / terbuka lagi (akses Teknisi lewat tiket ikut berubah).
          await tx
            .update(tickets)
            .set({ closedAt: input.isDone ? now() : null })
            .where(
              and(
                eq(tickets.organizationId, org),
                eq(tickets.columnId, columnId),
                input.isDone ? isNull(tickets.closedAt) : sql`${tickets.closedAt} is not null`,
              ),
            );
        }
        if (Object.keys(patch).length > 0) {
          await tx
            .update(ticketColumns)
            .set(patch)
            .where(and(eq(ticketColumns.organizationId, org), eq(ticketColumns.id, columnId)));
        }
        if (input.position !== undefined) {
          const ordered = columns.filter((candidate) => candidate.id !== columnId);
          ordered.splice(Math.min(input.position, ordered.length), 0, column);
          await renumber(tx, org, ordered);
        }
        await configured(tx, auth, boardId, 'column_updated', client);
      });
    },

    async deleteColumn(
      auth: AuthContext,
      boardId: string,
      columnId: string,
      moveToColumnId: string | undefined,
      client: ClientInfo,
    ) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'tickets.configure');
        const org = auth.organizationId;
        await boardOf(tx, org, boardId, true);
        const columns = await columnsOf(tx, org, boardId);
        const column = columns.find((candidate) => candidate.id === columnId);
        if (!column) throw new AppError('NOT_FOUND', { message: COLUMN_NOT_FOUND });
        if (columns.length === 1) {
          throw new AppError('CONFLICT', { message: 'Board butuh minimal satu kolom.' });
        }
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(tickets)
          .where(and(eq(tickets.organizationId, org), eq(tickets.columnId, columnId)));
        if (Number(count?.total ?? 0) > 0) {
          const target = columns.find(
            (candidate) => candidate.id === moveToColumnId && candidate.id !== columnId,
          );
          if (!target) {
            throw new AppError('CONFLICT', {
              message: 'Kolom ini masih berisi tiket. Pilih kolom tujuan untuk memindahkannya.',
            });
          }
          const base = await nextPosition(tx, org, target.id);
          await tx
            .update(tickets)
            .set({
              columnId: target.id,
              position: sql`${base} + ${tickets.position}`,
              closedAt: target.isDone ? sql`coalesce(${tickets.closedAt}, now())` : null,
            })
            .where(and(eq(tickets.organizationId, org), eq(tickets.columnId, columnId)));
        }
        await tx
          .delete(ticketColumns)
          .where(and(eq(ticketColumns.organizationId, org), eq(ticketColumns.id, columnId)));
        await renumber(
          tx,
          org,
          columns.filter((candidate) => candidate.id !== columnId),
        );
        await configured(tx, auth, boardId, 'column_deleted', client);
      });
    },

    /** Board default API (bot): board aktif pertama. */
    async defaultBoardId(organizationId: string): Promise<string | null> {
      const [board] = await db
        .select({ id: ticketBoards.id })
        .from(ticketBoards)
        .where(
          and(eq(ticketBoards.organizationId, organizationId), isNull(ticketBoards.archivedAt)),
        )
        .orderBy(asc(ticketBoards.position), asc(ticketBoards.createdAt))
        .limit(1);
      return board?.id ?? null;
    },

    /** Kolom berdasarkan nama (tanpa beda huruf) di sebuah board — untuk API bot. */
    async columnIdByName(organizationId: string, boardId: string, name: string): Promise<string> {
      const [column] = await db
        .select({ id: ticketColumns.id })
        .from(ticketColumns)
        .where(
          and(
            eq(ticketColumns.organizationId, organizationId),
            eq(ticketColumns.boardId, boardId),
            sql`lower(${ticketColumns.name}) = lower(${name})`,
          ),
        )
        .orderBy(asc(ticketColumns.position))
        .limit(1);
      if (!column) {
        throw new AppError('VALIDATION_ERROR', {
          message: `Kolom "${name}" tidak ada di board ini.`,
          details: [{ location: 'body', field: 'columnName', message: 'Kolom tidak ditemukan.' }],
        });
      }
      return column.id;
    },

    /** Kontak WhatsApp dari nomor E.164 (harus sudah ada) — untuk API bot. */
    async contactIdByPhone(organizationId: string, phone: string): Promise<string> {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            eq(contacts.channelType, 'whatsapp'),
            eq(contacts.phone, phone),
          ),
        );
      if (!contact) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Kontak dengan nomor itu belum ada.',
          details: [{ location: 'body', field: 'contactPhone', message: 'Kontak belum ada.' }],
        });
      }
      return contact.id;
    },
  };

  async function assertDepartment(tx: DbExecutor, organizationId: string, departmentId: string) {
    const [row] = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.organizationId, organizationId), eq(departments.id, departmentId)));
    if (!row) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Departemen tidak ditemukan.',
        details: [
          { location: 'body', field: 'departmentId', message: 'Departemen tidak ditemukan.' },
        ],
      });
    }
  }

  async function renumber(
    tx: DbExecutor,
    organizationId: string,
    ordered: readonly { id: string; position: number }[],
  ) {
    for (const [position, column] of ordered.entries()) {
      if (column.position === position) continue;
      await tx
        .update(ticketColumns)
        .set({ position })
        .where(
          and(eq(ticketColumns.organizationId, organizationId), eq(ticketColumns.id, column.id)),
        );
    }
  }

  async function configured(
    tx: DbExecutor,
    auth: AuthContext,
    boardId: string,
    operation: string,
    client: ClientInfo,
  ) {
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action: AUDIT_ACTIONS.ticketBoardConfigured,
      targetType: 'ticket_board',
      targetId: boardId,
      metadata: { operation },
      client,
    });
  }
}

export type TicketsService = ReturnType<typeof createTicketsService>;
