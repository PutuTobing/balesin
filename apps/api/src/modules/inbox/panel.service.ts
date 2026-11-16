import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  conversationEvents,
  conversationNotes,
  conversations,
  messages,
  users,
  type Database,
  type DbExecutor,
  type MessageRow,
} from '@balesin/db';
import {
  CONVERSATION_NOTES_MAX,
  hasPermission,
  permissionScope,
  type ConversationDetailSection,
  type ConversationNote,
  type ConversationRecordKind,
  type Permission,
  type UserRole,
} from '@balesin/shared';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { conversationScope } from './inbox.repo';

/**
 * Panel detail (Fase 2 butir 8, docs/KONTRAK-API-INBOX.md "Panel detail"): catatan sesi dan pesan
 * ditandai.
 *
 * - Catatan: lihat = `inbox.view` (cakupan); tulis = `inbox.reply` (cakupan); ubah = PENULIS saja;
 *   hapus = penulis atau `inbox.notes.moderate` (Owner/Admin). Selain itu 403 lewat `forbidByRule`
 *   (diaudit). Isi catatan TIDAK PERNAH masuk log/audit/event — `conversation_events` hanya mencatat
 *   bahwa catatan ditambah/diubah/dihapus.
 * - Tanda pesan (bintang): satu tanda bersama per pesan; pasang/lepas = `inbox.reply` (cakupan).
 *
 * Setiap tulis: pelaku diperiksa ulang di transaksi (`assertActorStillAuthorized`), cakupan dihitung
 * dari peran SEKARANG, percakapan dikunci dengan saringan cakupan (di luar cakupan = 404). Setelah
 * commit: `conversation.detail` (`notes` / `stars`), hanya ID.
 */

export interface PanelContext {
  auth: AuthContext;
  client: ClientInfo;
}

export interface PanelService {
  notes(
    grant: PermissionGrant,
    role: UserRole,
    conversationId: string,
  ): Promise<ConversationNote[] | undefined>;
  addNote(context: PanelContext, conversationId: string, body: string): Promise<ConversationNote>;
  editNote(
    context: PanelContext,
    conversationId: string,
    noteId: string,
    body: string,
  ): Promise<ConversationNote>;
  deleteNote(context: PanelContext, conversationId: string, noteId: string): Promise<void>;
  /** Pasang (`true`) / lepas (`false`) tanda. Mengembalikan baris pesan terbaru. */
  star(context: PanelContext, messageId: string, starred: boolean): Promise<MessageRow>;
}

const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';
const NOTE_NOT_FOUND = 'Catatan tidak ditemukan.';
const MESSAGE_NOT_FOUND = 'Pesan tidak ditemukan.';

interface NoteRowView {
  id: string;
  body: string;
  authorUserId: string;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
}

function toNote(row: NoteRowView, userId: string, role: UserRole): ConversationNote {
  const mine = row.authorUserId === userId;
  return {
    id: row.id,
    body: row.body,
    author: { id: row.authorUserId, name: row.authorName },
    createdAt: row.createdAt.toISOString(),
    updatedAt: (row.editedAt ?? row.createdAt).toISOString(),
    edited: row.editedAt !== null,
    canEdit: mine,
    canDelete: mine || hasPermission(role, 'inbox.notes.moderate'),
  };
}

export function createPanelService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}): PanelService {
  const { db, publisher, accessDenied } = deps;
  const now = deps.now ?? (() => new Date());

  /** Pelaku diperiksa ulang + percakapan dalam cakupan PERAN SEKARANG dikunci (FOR SHARE). */
  async function lockScoped(
    tx: DbExecutor,
    auth: AuthContext,
    permission: Permission,
    conversationId: string,
  ): Promise<UserRole> {
    const { role } = await assertActorStillAuthorized(tx, auth, permission);
    const scope = permissionScope(role, permission);
    if (!scope) throw authorityChanged();
    const grant: PermissionGrant = {
      permission,
      scope,
      userId: auth.user.id,
      organizationId: auth.organizationId,
    };
    const [row] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, auth.organizationId),
          eq(conversations.id, conversationId),
          conversationScope(grant),
        ),
      )
      .for('share');
    if (!row) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
    return role;
  }

  async function noteRows(
    tx: DbExecutor,
    organizationId: string,
    conversationId: string,
    noteId?: string,
  ): Promise<NoteRowView[]> {
    return tx
      .select({
        id: conversationNotes.id,
        body: conversationNotes.body,
        authorUserId: conversationNotes.authorUserId,
        authorName: users.name,
        createdAt: conversationNotes.createdAt,
        updatedAt: conversationNotes.updatedAt,
        editedAt: conversationNotes.editedAt,
      })
      .from(conversationNotes)
      .innerJoin(
        users,
        and(
          eq(users.organizationId, conversationNotes.organizationId),
          eq(users.id, conversationNotes.authorUserId),
        ),
      )
      .where(
        and(
          eq(conversationNotes.organizationId, organizationId),
          eq(conversationNotes.conversationId, conversationId),
          noteId === undefined ? undefined : eq(conversationNotes.id, noteId),
        ),
      )
      .orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id))
      .limit(CONVERSATION_NOTES_MAX);
  }

  async function logEvent(
    tx: DbExecutor,
    auth: AuthContext,
    conversationId: string,
    kind: ConversationRecordKind,
  ) {
    await tx.insert(conversationEvents).values({
      organizationId: auth.organizationId,
      conversationId,
      kind,
      actorUserId: auth.user.id,
    });
  }

  const detailChanged = (
    organizationId: string,
    conversationId: string,
    section: ConversationDetailSection,
  ) =>
    publisher.publish([{ type: 'conversation.detail', organizationId, conversationId, section }]);

  /** Catatan untuk diubah/dihapus (dikunci), atau 404. */
  async function lockNote(
    tx: DbExecutor,
    auth: AuthContext,
    conversationId: string,
    noteId: string,
  ) {
    const [note] = await tx
      .select({ id: conversationNotes.id, authorUserId: conversationNotes.authorUserId })
      .from(conversationNotes)
      .where(
        and(
          eq(conversationNotes.organizationId, auth.organizationId),
          eq(conversationNotes.conversationId, conversationId),
          eq(conversationNotes.id, noteId),
        ),
      )
      .for('update');
    if (!note) throw new AppError('NOT_FOUND', { message: NOTE_NOT_FOUND });
    return note;
  }

  return {
    async notes(grant, role, conversationId) {
      const [visible] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, grant.organizationId),
            eq(conversations.id, conversationId),
            conversationScope(grant),
          ),
        );
      if (!visible) return undefined;
      const rows = await noteRows(db, grant.organizationId, conversationId);
      return rows.map((row) => toNote(row, grant.userId, role));
    },

    async addNote({ auth }, conversationId, body) {
      const { row, role } = await db.transaction(async (tx) => {
        const role = await lockScoped(tx, auth, 'inbox.reply', conversationId);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(conversationNotes)
          .where(
            and(
              eq(conversationNotes.organizationId, auth.organizationId),
              eq(conversationNotes.conversationId, conversationId),
            ),
          );
        if (Number(count?.total ?? 0) >= CONVERSATION_NOTES_MAX) {
          throw new AppError('CONFLICT', {
            message: `Percakapan ini sudah punya ${String(CONVERSATION_NOTES_MAX)} catatan (batas). Hapus catatan lama dulu.`,
          });
        }
        const [inserted] = await tx
          .insert(conversationNotes)
          .values({
            organizationId: auth.organizationId,
            conversationId,
            authorUserId: auth.user.id,
            body,
          })
          .returning({ id: conversationNotes.id });
        if (!inserted) throw new Error('Catatan tidak tersimpan');
        await logEvent(tx, auth, conversationId, 'note_added');
        const [row] = await noteRows(tx, auth.organizationId, conversationId, inserted.id);
        if (!row) throw new Error('Catatan tidak terbaca');
        return { row, role };
      });
      await detailChanged(auth.organizationId, conversationId, 'notes');
      return toNote(row, auth.user.id, role);
    },

    async editNote({ auth, client }, conversationId, noteId, body) {
      const { row, role } = await db.transaction(async (tx) => {
        const role = await lockScoped(tx, auth, 'inbox.reply', conversationId);
        const note = await lockNote(tx, auth, conversationId, noteId);
        if (note.authorUserId !== auth.user.id) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.noteEditOthers,
            client,
            message: 'Catatan hanya bisa diubah penulisnya.',
          });
        }
        await tx
          .update(conversationNotes)
          .set({ body, editedAt: now() })
          .where(
            and(
              eq(conversationNotes.organizationId, auth.organizationId),
              eq(conversationNotes.id, noteId),
            ),
          );
        await logEvent(tx, auth, conversationId, 'note_updated');
        const [row] = await noteRows(tx, auth.organizationId, conversationId, noteId);
        if (!row) throw new Error('Catatan tidak terbaca');
        return { row, role };
      });
      await detailChanged(auth.organizationId, conversationId, 'notes');
      return toNote(row, auth.user.id, role);
    },

    async deleteNote({ auth, client }, conversationId, noteId) {
      await db.transaction(async (tx) => {
        const role = await lockScoped(tx, auth, 'inbox.reply', conversationId);
        const note = await lockNote(tx, auth, conversationId, noteId);
        if (note.authorUserId !== auth.user.id && !hasPermission(role, 'inbox.notes.moderate')) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.noteDeleteOthers,
            client,
            message: 'Catatan orang lain hanya bisa dihapus Owner atau Admin.',
          });
        }
        await tx
          .delete(conversationNotes)
          .where(
            and(
              eq(conversationNotes.organizationId, auth.organizationId),
              eq(conversationNotes.id, noteId),
            ),
          );
        await logEvent(tx, auth, conversationId, 'note_deleted');
      });
      await detailChanged(auth.organizationId, conversationId, 'notes');
    },

    async star({ auth }, messageId, starred) {
      const { row, changed } = await db.transaction(async (tx) => {
        const [target] = await tx
          .select({ conversationId: messages.conversationId })
          .from(messages)
          .where(and(eq(messages.organizationId, auth.organizationId), eq(messages.id, messageId)));
        if (!target) throw new AppError('NOT_FOUND', { message: MESSAGE_NOT_FOUND });
        try {
          await lockScoped(tx, auth, 'inbox.reply', target.conversationId);
        } catch (error) {
          // Pesan di percakapan luar cakupan = "tidak ditemukan" (tanpa membocorkan keberadaannya).
          if (error instanceof AppError && error.code === 'NOT_FOUND') {
            throw new AppError('NOT_FOUND', { message: MESSAGE_NOT_FOUND });
          }
          throw error;
        }
        const updated = await tx
          .update(messages)
          .set(
            starred
              ? { starredAt: now(), starredByUserId: auth.user.id }
              : { starredAt: null, starredByUserId: null },
          )
          .where(
            and(
              eq(messages.organizationId, auth.organizationId),
              eq(messages.id, messageId),
              starred ? sql`${messages.starredAt} is null` : sql`${messages.starredAt} is not null`,
            ),
          )
          .returning();
        if (updated[0]) return { row: updated[0], changed: true };
        const [current] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.organizationId, auth.organizationId), eq(messages.id, messageId)));
        if (!current) throw new AppError('NOT_FOUND', { message: MESSAGE_NOT_FOUND });
        return { row: current, changed: false };
      });
      if (changed) await detailChanged(auth.organizationId, row.conversationId, 'stars');
      return row;
    },
  };
}
