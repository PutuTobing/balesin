import { AppError, type InboxEventPublisher } from '@balesin/core';
import {
  PG_ERROR_CODES,
  contactTags,
  isPgError,
  tags,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  TAGS_PER_ORGANIZATION_MAX,
  type CreateTagRequest,
  type Tag,
  type TagColor,
  type UpdateTagRequest,
} from '@balesin/shared';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Master tag organisasi (Fase 2 butir 8). Lihat = `inbox.view` (saringan & panel); buat =
 * `contacts.manage` (agen membuat tag dari panel seperti di MobiChat); ganti nama/warna & hapus =
 * `settings.workspace.manage` (Owner/Admin). Buat/ubah/hapus diaudit. Setelah commit: `tags.changed`.
 */

export const TAG_NOT_FOUND = 'Tag tidak ditemukan.';
const DUPLICATE = 'Tag dengan nama itu sudah ada.';

export interface TagContext {
  auth: AuthContext;
  client: ClientInfo;
}

export interface TagsService {
  list(organizationId: string): Promise<Tag[]>;
  create(context: TagContext, input: CreateTagRequest): Promise<Tag>;
  update(context: TagContext, tagId: string, input: UpdateTagRequest): Promise<Tag>;
  remove(context: TagContext, tagId: string): Promise<void>;
}

const usage = sql<number>`(select count(*)::int from ${contactTags} where ${contactTags.organizationId} = ${tags.organizationId} and ${contactTags.tagId} = ${tags.id})`;

async function selectTags(db: DbExecutor, organizationId: string, tagId?: string): Promise<Tag[]> {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      contactCount: usage,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(tags)
    .where(
      and(
        eq(tags.organizationId, organizationId),
        tagId === undefined ? undefined : eq(tags.id, tagId),
      ),
    )
    .orderBy(sql`lower(${tags.name})`, asc(tags.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color as TagColor,
    contactCount: Number(row.contactCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function duplicateName(error: unknown): boolean {
  return isPgError(error, PG_ERROR_CODES.uniqueViolation, 'tags_organization_id_name_unique');
}

export function createTagsService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
}): TagsService {
  const { db, publisher } = deps;
  const changed = (organizationId: string) =>
    publisher.publish([{ type: 'tags.changed', organizationId }]);

  async function findOne(organizationId: string, tagId: string): Promise<Tag> {
    const [tag] = await selectTags(db, organizationId, tagId);
    if (!tag) throw new AppError('NOT_FOUND', { message: TAG_NOT_FOUND });
    return tag;
  }

  return {
    list: (organizationId) => selectTags(db, organizationId),

    async create({ auth, client }, input) {
      const color = input.color ?? 'blue';
      let id: string;
      try {
        id = await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'contacts.manage');
          // Serialkan pembuatan per organisasi supaya batas jumlah tidak terlewati bersamaan.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${auth.organizationId}`}, 0))`,
          );
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(tags)
            .where(eq(tags.organizationId, auth.organizationId));
          if (Number(count?.total ?? 0) >= TAGS_PER_ORGANIZATION_MAX) {
            throw new AppError('CONFLICT', {
              message: `Organisasi ini sudah punya ${String(TAGS_PER_ORGANIZATION_MAX)} tag (batas). Hapus tag yang tidak dipakai dulu.`,
            });
          }
          const [row] = await tx
            .insert(tags)
            .values({
              organizationId: auth.organizationId,
              name: input.name,
              color,
              createdByUserId: auth.user.id,
            })
            .returning({ id: tags.id });
          if (!row) throw new Error('Tag tidak tersimpan');
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.tagCreated,
            targetType: 'tag',
            targetId: row.id,
            metadata: { name: input.name, color },
            client,
          });
          return row.id;
        });
      } catch (error) {
        if (duplicateName(error)) throw new AppError('CONFLICT', { message: DUPLICATE });
        throw error;
      }
      await changed(auth.organizationId);
      return findOne(auth.organizationId, id);
    },

    async update({ auth, client }, tagId, input) {
      try {
        await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
          const [current] = await tx
            .select({ name: tags.name, color: tags.color })
            .from(tags)
            .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)))
            .for('update');
          if (!current) throw new AppError('NOT_FOUND', { message: TAG_NOT_FOUND });
          const next = { name: input.name ?? current.name, color: input.color ?? current.color };
          if (next.name === current.name && next.color === current.color) return;
          await tx
            .update(tags)
            .set(next)
            .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)));
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.tagUpdated,
            targetType: 'tag',
            targetId: tagId,
            metadata: { previous: current, name: next.name, color: next.color },
            client,
          });
        });
      } catch (error) {
        if (duplicateName(error)) throw new AppError('CONFLICT', { message: DUPLICATE });
        throw error;
      }
      await changed(auth.organizationId);
      return findOne(auth.organizationId, tagId);
    },

    async remove({ auth, client }, tagId) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const [current] = await tx
          .select({ name: tags.name, color: tags.color, contacts: usage })
          .from(tags)
          .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)))
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: TAG_NOT_FOUND });
        // `contact_tags` ikut terhapus (FK cascade). Riwayat kontak menyimpan nama tag sendiri.
        await tx
          .delete(tags)
          .where(and(eq(tags.organizationId, auth.organizationId), eq(tags.id, tagId)));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.tagDeleted,
          targetType: 'tag',
          targetId: tagId,
          metadata: {
            name: current.name,
            color: current.color,
            contacts: Number(current.contacts),
          },
          client,
        });
      });
      await changed(auth.organizationId);
    },
  };
}
