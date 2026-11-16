import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  contactEvents,
  contactTags,
  contacts,
  conversations,
  tags,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  TAGS_PER_CONTACT_MAX,
  type ContactEditableField,
  type ConversationDetailSection,
  type UpdateContactRequest,
} from '@balesin/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Data kontak dari panel detail (Fase 2 butir 8, docs/KONTRAK-API-INBOX.md "Panel detail"): ubah
 * nama/email/catatan/atribut dan pasang/lepas tag. Izin `contacts.manage` (cakupan `all` untuk semua
 * pemegangnya — Teknisi tidak memegangnya, PRD §4).
 *
 * Riwayat: `contact_events` TANPA nilai data pelanggan (hanya nama isian / nama tag). Bukan audit log
 * keamanan: perubahan data pelanggan sehari-hari tidak membanjiri audit (DECISIONS 2026-11-17).
 * Setelah commit: `conversation.detail` untuk percakapan terbaru kontak itu (maks.
 * `DETAIL_FANOUT_MAX`) — web memuat ulang panel/daftar lewat REST.
 */

/** Percakapan terbaru yang diberi tahu saat data kontak berubah. */
export const DETAIL_FANOUT_MAX = 20;

export const CONTACT_NOT_FOUND = 'Kontak tidak ditemukan.';
export const TAG_NOT_FOUND = 'Tag tidak ditemukan.';

export interface ContactsService {
  update(auth: AuthContext, contactId: string, input: UpdateContactRequest): Promise<void>;
  addTag(auth: AuthContext, contactId: string, tagId: string): Promise<void>;
  removeTag(auth: AuthContext, contactId: string, tagId: string): Promise<void>;
}

/** Terbitkan `conversation.detail` untuk percakapan terbaru kontak-kontak ini (setelah commit). */
export async function publishContactDetail(
  db: DbExecutor,
  publisher: InboxEventPublisher,
  organizationId: string,
  contactIds: readonly string[],
  section: ConversationDetailSection,
): Promise<void> {
  const events = [];
  for (const contactId of new Set(contactIds)) {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(DETAIL_FANOUT_MAX);
    for (const row of rows) {
      events.push({
        type: 'conversation.detail' as const,
        organizationId,
        conversationId: row.id,
        section,
      });
    }
  }
  await publisher.publish(events);
}

async function lockContact(tx: DbExecutor, organizationId: string, contactId: string) {
  const [row] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
  return row;
}

function sameAttributes(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export function createContactsService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
}): ContactsService {
  const { db, publisher } = deps;

  return {
    async update(auth, contactId, input) {
      const changed = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'contacts.manage');
        const current = await lockContact(tx, auth.organizationId, contactId);
        const patch: Partial<typeof contacts.$inferInsert> = {};
        const fields: ContactEditableField[] = [];
        if (input.name !== undefined && input.name !== current.name) {
          patch.name = input.name;
          fields.push('name');
        }
        if (input.email !== undefined && input.email !== current.email) {
          patch.email = input.email;
          fields.push('email');
        }
        if (input.notes !== undefined && input.notes !== current.notes) {
          patch.notes = input.notes;
          fields.push('notes');
        }
        if (
          input.attributes !== undefined &&
          !sameAttributes(input.attributes, current.attributes)
        ) {
          patch.attributes = input.attributes;
          fields.push('attributes');
        }
        if (fields.length === 0) return false;
        await tx
          .update(contacts)
          .set(patch)
          .where(and(eq(contacts.organizationId, auth.organizationId), eq(contacts.id, contactId)));
        await tx.insert(contactEvents).values({
          organizationId: auth.organizationId,
          contactId,
          kind: 'contact_updated',
          actorUserId: auth.user.id,
          fields,
        });
        return true;
      });
      if (changed) {
        await publishContactDetail(db, publisher, auth.organizationId, [contactId], 'contact');
      }
    },

    async addTag(auth, contactId, tagId) {
      const added = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'contacts.manage');
        // Kunci kontak: hitungan batas tag per kontak tidak bisa dilewati permintaan bersamaan.
        await lockContact(tx, auth.organizationId, contactId);
        const [tag] = await tx
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)))
          .for('share');
        if (!tag) throw new AppError('NOT_FOUND', { message: TAG_NOT_FOUND });
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(contactTags)
          .where(
            and(
              eq(contactTags.organizationId, auth.organizationId),
              eq(contactTags.contactId, contactId),
            ),
          );
        const inserted = await tx
          .insert(contactTags)
          .values({
            organizationId: auth.organizationId,
            contactId,
            tagId,
            createdByUserId: auth.user.id,
          })
          .onConflictDoNothing()
          .returning({ tagId: contactTags.tagId });
        if (inserted.length === 0) return false;
        if (Number(count?.total ?? 0) >= TAGS_PER_CONTACT_MAX) {
          throw new AppError('CONFLICT', {
            message: `Kontak ini sudah memakai ${String(TAGS_PER_CONTACT_MAX)} tag (batas). Lepas salah satu dulu.`,
          });
        }
        await tx.insert(contactEvents).values({
          organizationId: auth.organizationId,
          contactId,
          kind: 'tag_added',
          actorUserId: auth.user.id,
          tagName: tag.name,
          tagColor: tag.color,
        });
        return true;
      });
      if (added) {
        await publishContactDetail(db, publisher, auth.organizationId, [contactId], 'tags');
      }
    },

    async removeTag(auth, contactId, tagId) {
      const removed = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'contacts.manage');
        await lockContact(tx, auth.organizationId, contactId);
        const deleted = await tx
          .delete(contactTags)
          .where(
            and(
              eq(contactTags.organizationId, auth.organizationId),
              eq(contactTags.contactId, contactId),
              eq(contactTags.tagId, tagId),
            ),
          )
          .returning({ tagId: contactTags.tagId });
        if (deleted.length === 0) return false;
        const [tag] = await tx
          .select({ name: tags.name, color: tags.color })
          .from(tags)
          .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)));
        if (tag) {
          await tx.insert(contactEvents).values({
            organizationId: auth.organizationId,
            contactId,
            kind: 'tag_removed',
            actorUserId: auth.user.id,
            tagName: tag.name,
            tagColor: tag.color,
          });
        }
        return true;
      });
      if (removed) {
        await publishContactDetail(db, publisher, auth.organizationId, [contactId], 'tags');
      }
    },
  };
}
