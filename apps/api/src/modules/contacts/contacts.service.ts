import {
  AppError,
  cleanFileName,
  contactIdentityLockKeys,
  type InboxEventPublisher,
  type Logger,
} from '@balesin/core';
import {
  channelAccessSql,
  userPrincipal,
  channels,
  contactEvents,
  contactTags,
  contacts,
  conversations,
  lockAdvisoryKeys,
  messages,
  recordOutgoingEvent,
  tags,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  CONTACT_EXPORT_MESSAGES_MAX,
  CONTACT_EXPORT_PARTIAL_REASON,
  TAGS_PER_CONTACT_MAX,
  TAGS_PER_ORGANIZATION_MAX,
  type ContactEditableField,
  type ContactExport,
  type ConversationDetailSection,
  type DeleteContactResponse,
  type IdentityConfirmation,
  type PublicCreateContactRequest,
  type UpdateContactRequest,
  validateAttributeValues,
} from '@balesin/shared';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { attributeRules, attributeValidationError } from '../attributes/attributes.service';
import { deleteContactData } from './contacts.repo';

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
  /** Lewat API publik (`contacts:write`): pelaku = API key (riwayat tanpa pengguna). */
  updateFromApi(
    organizationId: string,
    apiKeyId: string,
    contactId: string,
    input: UpdateContactRequest,
  ): Promise<void>;
  /** Kontak WhatsApp dari nomor E.164; nomor yang sudah ada → kontak itu (`created: false`). */
  createFromApi(
    organizationId: string,
    input: PublicCreateContactRequest,
  ): Promise<{ id: string; created: boolean }>;
  /** Pasang/lepas tag berdasarkan NAMA (pasang membuat tag yang belum ada). */
  tagsByNameFromApi(
    organizationId: string,
    apiKeyId: string,
    contactId: string,
    names: readonly string[],
    operation: 'add' | 'remove',
  ): Promise<void>;
  /** Hapus kontak + data pribadinya (UU PDP). Konfirmasi identitas wajib. */
  remove(
    auth: AuthContext,
    contactId: string,
    confirmation: IdentityConfirmation | undefined,
    context: TwoFactorContext,
  ): Promise<DeleteContactResponse['deleted']>;
  /** Data satu kontak (permintaan akses data), diaudit. */
  exportData(auth: AuthContext, client: ClientInfo, contactId: string): Promise<ContactExport>;
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
  /** Wajib untuk hapus kontak (konfirmasi identitas). */
  twoFactor?: Pick<TwoFactorService, 'confirmIdentity'>;
  /**
   * Pembersih media KHUSUS berkas kontak yang dihapus (`outbound.purgeMediaFiles`) — dipanggil
   * SETELAH commit (R4; review hapus Info: bukan pembersih global di dalam permintaan).
   */
  purgeMedia?: (mediaFileIds: readonly string[]) => Promise<number>;
  logger?: Pick<Logger, 'warn' | 'info'>;
  now?: () => Date;
}): ContactsService {
  const { db, publisher } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Ubah isian kontak + riwayat (`contact_events`, tanpa nilai). `actorUserId` `null` = lewat API
   * key (pelaku integrasi). `check` = pemeriksaan pelaku di dalam transaksi (sesi web).
   */
  async function applyUpdate(
    organizationId: string,
    actorUserId: string | null,
    contactId: string,
    input: UpdateContactRequest,
    check?: (tx: DbExecutor) => Promise<void>,
    apiKeyId: string | null = null,
  ): Promise<void> {
    const changed = await db.transaction(async (tx) => {
      await check?.(tx);
      const current = await lockContact(tx, organizationId, contactId);
      if (input.attributes !== undefined) {
        // Fase 5: nilai atribut berdefinisi divalidasi & dibakukan. "Wajib" hanya ditegakkan untuk
        // simpan dari aplikasi (sesi); bot/API tidak tahu definisi organisasi.
        const checked = validateAttributeValues(
          await attributeRules(tx, organizationId, { entity: 'contact' }),
          input.attributes,
          { enforceRequired: actorUserId !== null },
        );
        if (!checked.ok) throw attributeValidationError(checked.issues);
        input = { ...input, attributes: checked.values };
      }
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
      if (input.attributes !== undefined && !sameAttributes(input.attributes, current.attributes)) {
        patch.attributes = input.attributes;
        fields.push('attributes');
      }
      if (fields.length === 0) return false;
      await tx
        .update(contacts)
        .set(patch)
        .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));
      await tx.insert(contactEvents).values({
        organizationId,
        contactId,
        kind: 'contact_updated',
        actorUserId,
        apiKeyId,
        fields,
      });
      await recordOutgoingEvent(tx, {
        organizationId,
        type: 'contact.updated',
        contactId,
        actorUserId,
      });
      return true;
    });
    if (changed) {
      await publishContactDetail(db, publisher, organizationId, [contactId], 'contact');
    }
  }

  async function tagsByName(
    organizationId: string,
    apiKeyId: string,
    contactId: string,
    names: readonly string[],
    operation: 'add' | 'remove',
  ): Promise<void> {
    const changed = await db.transaction(async (tx) => {
      await lockContact(tx, organizationId, contactId);
      // Nama kembar (tanpa beda huruf besar/kecil) → kemunculan PERTAMA yang dipakai.
      const wanted: string[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        const folded = name.toLocaleLowerCase('id-ID');
        if (seen.has(folded)) continue;
        seen.add(folded);
        wanted.push(name);
      }
      const byName = (name: string) =>
        tx
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .where(
            and(eq(tags.organizationId, organizationId), sql`lower(${tags.name}) = lower(${name})`),
          );
      let touched = false;
      for (const name of wanted) {
        let [tag] = await byName(name);
        if (!tag && operation === 'add') {
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(tags)
            .where(eq(tags.organizationId, organizationId));
          if (Number(count?.total ?? 0) >= TAGS_PER_ORGANIZATION_MAX) {
            throw new AppError('CONFLICT', {
              message: `Organisasi ini sudah punya ${String(TAGS_PER_ORGANIZATION_MAX)} tag (batas).`,
            });
          }
          await tx
            .insert(tags)
            .values({ organizationId, name, color: 'blue' })
            .onConflictDoNothing();
          [tag] = await byName(name);
        }
        if (!tag) continue;
        if (operation === 'add') {
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(contactTags)
            .where(
              and(
                eq(contactTags.organizationId, organizationId),
                eq(contactTags.contactId, contactId),
              ),
            );
          const inserted = await tx
            .insert(contactTags)
            .values({ organizationId, contactId, tagId: tag.id })
            .onConflictDoNothing()
            .returning({ tagId: contactTags.tagId });
          if (inserted.length === 0) continue;
          if (Number(count?.total ?? 0) >= TAGS_PER_CONTACT_MAX) {
            throw new AppError('CONFLICT', {
              message: `Kontak ini sudah memakai ${String(TAGS_PER_CONTACT_MAX)} tag (batas).`,
            });
          }
        } else {
          const removed = await tx
            .delete(contactTags)
            .where(
              and(
                eq(contactTags.organizationId, organizationId),
                eq(contactTags.contactId, contactId),
                eq(contactTags.tagId, tag.id),
              ),
            )
            .returning({ tagId: contactTags.tagId });
          if (removed.length === 0) continue;
        }
        if (!touched) {
          await recordOutgoingEvent(tx, { organizationId, type: 'contact.updated', contactId });
        }
        touched = true;
        await tx.insert(contactEvents).values({
          organizationId,
          contactId,
          kind: operation === 'add' ? 'tag_added' : 'tag_removed',
          actorUserId: null,
          apiKeyId,
          tagName: tag.name,
          tagColor: tag.color,
        });
      }
      return touched;
    });
    if (changed) await publishContactDetail(db, publisher, organizationId, [contactId], 'tags');
  }

  return {
    async update(auth, contactId, input) {
      await applyUpdate(auth.organizationId, auth.user.id, contactId, input, async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'contacts.manage');
      });
    },

    updateFromApi: (organizationId, apiKeyId, contactId, input) =>
      applyUpdate(organizationId, null, contactId, input, undefined, apiKeyId),

    tagsByNameFromApi: tagsByName,

    async createFromApi(organizationId, input) {
      return db.transaction(async (tx) => {
        // Kunci identitas yang SAMA dengan worker pesan masuk (tidak ada kontak kembar bersamaan).
        await lockAdvisoryKeys(
          tx,
          contactIdentityLockKeys(organizationId, 'whatsapp', { bsuid: null, phone: input.phone }),
        );
        const [existing] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              eq(contacts.channelType, 'whatsapp'),
              eq(contacts.phone, input.phone),
            ),
          );
        if (existing) return { id: existing.id, created: false };
        let attributes = input.attributes ?? [];
        if (attributes.length > 0) {
          const checked = validateAttributeValues(
            await attributeRules(tx, organizationId, { entity: 'contact' }),
            attributes,
            { enforceRequired: false },
          );
          if (!checked.ok) throw attributeValidationError(checked.issues);
          attributes = checked.values;
        }
        const [row] = await tx
          .insert(contacts)
          .values({
            organizationId,
            channelType: 'whatsapp',
            phone: input.phone,
            name: input.name ?? null,
            email: input.email ?? null,
            attributes,
          })
          .returning({ id: contacts.id });
        if (!row) throw new Error('Kontak tidak tersimpan');
        await recordOutgoingEvent(tx, {
          organizationId,
          type: 'contact.created',
          contactId: row.id,
        });
        return { id: row.id, created: true };
      });
    },

    async remove(auth, contactId, confirmation, context) {
      if (!deps.twoFactor) throw new Error('Hapus kontak butuh layanan 2FA');
      await requireIdentityConfirmation(
        deps.twoFactor,
        auth,
        confirmation,
        'contact.delete',
        context,
        'Masukkan password (dan kode verifikasi) untuk menghapus kontak ini.',
      );
      const outcome = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'contacts.delete');
        const media = await tx
          .select({ id: messages.mediaFileId })
          .from(messages)
          .where(
            and(
              eq(messages.organizationId, auth.organizationId),
              eq(messages.contactId, contactId),
              isNotNull(messages.mediaFileId),
            ),
          );
        const affected = await tx
          .select({
            id: conversations.id,
            status: conversations.status,
            assigneeUserId: conversations.assigneeUserId,
            channelId: conversations.channelId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.contactId, contactId),
            ),
          );
        const result = await deleteContactData(tx, auth.organizationId, contactId);
        if (!result) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
        const hadOpenConversation = affected.some((row) => row.status !== 'resolved');
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.contactDeleted,
          targetType: 'contact',
          targetId: contactId,
          // HANYA jumlah — tanpa nama, nomor, atau isi (UU PDP).
          metadata: {
            messages: result.messages,
            conversations: result.conversations,
            webhookEvents: result.webhookEvents,
            hadOpenConversation,
            actorRole: role,
          },
          client: context.client,
        });
        return {
          result,
          affected,
          mediaFileIds: [
            ...new Set(media.map((row) => row.id).filter((id): id is string => id !== null)),
          ],
        };
      });
      // Setelah commit: berkas media langsung dihapus dari disk (review ruang chat R4), lalu web
      // diberi tahu percakapan yang hilang (ID saja).
      let mediaFiles = 0;
      try {
        mediaFiles = (await deps.purgeMedia?.(outcome.mediaFileIds)) ?? 0;
      } catch (err) {
        deps.logger?.warn(
          { err },
          'Pembersihan media setelah hapus kontak gagal (dicoba lagi berkala)',
        );
      }
      // Agen pemegang ikut dikirim supaya hub menyaring per cakapan (review hapus Info).
      await publisher.publish(
        outcome.affected.map((row) => ({
          type: 'conversation.deleted' as const,
          organizationId: auth.organizationId,
          conversationId: row.id,
          channelId: row.channelId,
          ...(row.assigneeUserId ? { previousAssigneeUserId: row.assigneeUserId } : {}),
        })),
      );
      return {
        messages: outcome.result.messages,
        conversations: outcome.result.conversations,
        webhookEvents: outcome.result.webhookEvents,
        mediaFiles,
      };
    },

    async exportData(auth, client, contactId) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'contacts.export');
        const [contact] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.organizationId, auth.organizationId), eq(contacts.id, contactId)));
        if (!contact) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
        const tagRows = await tx
          .select({ name: tags.name })
          .from(contactTags)
          .innerJoin(
            tags,
            and(
              eq(tags.organizationId, contactTags.organizationId),
              eq(tags.id, contactTags.tagId),
            ),
          )
          .where(
            and(
              eq(contactTags.organizationId, auth.organizationId),
              eq(contactTags.contactId, contactId),
            ),
          )
          .orderBy(sql`lower(${tags.name})`);
        const conversationRows = await tx
          .select({
            id: conversations.id,
            number: conversations.number,
            channel: channels.name,
            status: conversations.status,
            createdAt: conversations.createdAt,
            resolvedAt: conversations.resolvedAt,
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
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.contactId, contactId),
              // Tahap 9.0: percakapan channel yang tidak boleh dilihat pengekspor tidak ikut.
              channelAccessSql(
                auth.organizationId,
                userPrincipal(auth.user.id),
                conversations.channelId,
              ),
            ),
          )
          .orderBy(asc(conversations.createdAt));
        const messageRows = await tx
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            direction: messages.direction,
            type: messages.type,
            text: messages.text,
            media: messages.media,
            location: messages.location,
            status: messages.status,
            occurredAt: messages.occurredAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.organizationId, auth.organizationId),
              eq(messages.contactId, contactId),
              ne(messages.type, 'system'),
              channelAccessSql(
                auth.organizationId,
                userPrincipal(auth.user.id),
                messages.channelId,
              ),
            ),
          )
          .orderBy(asc(messages.occurredAt), asc(messages.id))
          .limit(CONTACT_EXPORT_MESSAGES_MAX + 1);
        const truncated = messageRows.length > CONTACT_EXPORT_MESSAGES_MAX;
        const kept = messageRows.slice(0, CONTACT_EXPORT_MESSAGES_MAX);
        const attributes = z
          .array(z.object({ key: z.string(), value: z.string() }))
          .catch([])
          .parse(contact.attributes);
        const mediaOf = (value: unknown) => {
          const parsed = z
            .object({
              kind: z.string(),
              mimeType: z.string().nullable().catch(null),
              filename: z.string().nullable().catch(null),
            })
            .safeParse(value);
          return parsed.success
            ? {
                kind: parsed.data.kind,
                mimeType: parsed.data.mimeType,
                filename: cleanFileName(parsed.data.filename),
              }
            : null;
        };
        const locationOf = (value: unknown) => {
          const parsed = z
            .object({
              latitude: z.number(),
              longitude: z.number(),
              name: z.string().nullable().catch(null),
              address: z.string().nullable().catch(null),
            })
            .safeParse(value);
          return parsed.success ? parsed.data : null;
        };
        // Review 9.0 R6: ekspor parsial (akses per channel) ditandai di respons & audit.
        const [all] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, auth.organizationId),
              eq(conversations.contactId, contactId),
            ),
          );
        const excludedConversations = Math.max(
          0,
          Number(all?.total ?? 0) - conversationRows.length,
        );
        const partial = excludedConversations > 0;
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.contactExported,
          targetType: 'contact',
          targetId: contactId,
          metadata: {
            messages: kept.length,
            conversations: conversationRows.length,
            truncated,
            partial,
            excludedConversations,
          },
          client,
        });
        return {
          exportedAt: now().toISOString(),
          contact: {
            id: contact.id,
            number: contact.number,
            channelType: contact.channelType,
            phone: contact.phone,
            waUsername: contact.waUsername,
            name: contact.name,
            profileName: contact.profileName,
            email: contact.email,
            notes: contact.notes,
            attributes,
            tags: tagRows.map((row) => row.name),
            createdAt: contact.createdAt.toISOString(),
          },
          conversations: conversationRows.map((row) => ({
            id: row.id,
            number: row.number,
            channel: row.channel,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            resolvedAt: row.resolvedAt?.toISOString() ?? null,
          })),
          messages: kept.map((row) => ({
            id: row.id,
            conversationId: row.conversationId,
            direction: row.direction,
            type: row.type,
            text: row.text,
            media: mediaOf(row.media),
            location: locationOf(row.location),
            status: row.status,
            createdAt: row.occurredAt.toISOString(),
          })),
          truncated,
          partial,
          partialReason: partial ? CONTACT_EXPORT_PARTIAL_REASON : null,
          excludedConversations,
        };
      });
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
        await recordOutgoingEvent(tx, {
          organizationId: auth.organizationId,
          type: 'contact.updated',
          contactId,
          actorUserId: auth.user.id,
        });
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
          await recordOutgoingEvent(tx, {
            organizationId: auth.organizationId,
            type: 'contact.updated',
            contactId,
            actorUserId: auth.user.id,
          });
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
