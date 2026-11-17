import {
  AppError,
  contactIdentityLockKeys,
  type InboxEventPublisher,
  type Logger,
} from '@balesin/core';
import {
  broadcastRecipients,
  contactEvents,
  contactTags,
  contacts,
  conversations,
  lockAdvisoryKeys,
  messages,
  outgoingEvents,
  recordOutgoingEvent,
  tags,
  tickets,
  webhookEvents,
  type ContactRow,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  CONTACT_ATTRIBUTES_MAX,
  CONTACT_BULK_EXPORT_MAX,
  CONTACT_IMPORT_ISSUES,
  CONTACT_NAME_MAX,
  CONTACT_NOTES_MAX,
  TAGS_PER_CONTACT_MAX,
  TAGS_PER_ORGANIZATION_MAX,
  emailAddressSchema,
  hasControlCharacters,
  normalizeBroadcastPhone,
  permissionScope,
  tagNameSchema,
  validateAttributeValues,
  type ContactEditableField,
  type ContactFilter,
  type ContactImportIssue,
  type ContactImportMapping,
  type ContactImportResult,
  type IdentityConfirmation,
  type MergeContactResponse,
} from '@balesin/shared';
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { attributeRules, listAttributeDefinitions } from '../attributes/attributes.service';
import { csvRow } from '../audit/audit-view';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { contactScope, searchCondition, type Cursor } from '../inbox/inbox.repo';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { CONTACT_NOT_FOUND, publishContactDetail } from './contacts.service';

/**
 * CRM Fase 5 (docs/KONTRAK-API-CRM-TIKET.md "Kontak"): daftar & cari kontak, ekspor massal CSV, gabung
 * duplikat, dan impor massal (tabel hasil parser terisolasi modul broadcast).
 *
 * - Daftar = cakupan `contacts.view` (Teknisi: kontak percakapannya / tiket terbukanya).
 * - Ekspor massal = `contacts.export` + konfirmasi identitas + audit + CSRF (POST) + sel kebal rumus.
 * - Gabung = `contacts.manage` + konfirmasi identitas (tidak bisa dibatalkan) + audit; hanya dalam
 *   SATU organisasi (keduanya dicari dengan `organization_id` pemanggil).
 * - Impor = `contacts.export` (PRD §4 "Impor/ekspor kontak massal"); diaudit SEKALI tanpa isi berkas;
 *   tidak memicu webhook per kontak (cegah banjir event ke n8n).
 */

// ── Daftar ──────────────────────────────────────────────────────────────────

const createdExact = sql<string>`to_char(${contacts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function contactFilterCondition(grant: PermissionGrant, filter: ContactFilter): SQL {
  return and(
    eq(contacts.organizationId, grant.organizationId),
    contactScope(grant),
    filter.q === undefined ? undefined : searchCondition(filter.q),
    filter.tagId === undefined
      ? undefined
      : sql`exists (select 1 from ${contactTags} where ${contactTags.organizationId} = ${contacts.organizationId} and ${contactTags.contactId} = ${contacts.id} and ${contactTags.tagId} = ${filter.tagId})`,
    filter.attributeKey === undefined || filter.attributeValue === undefined
      ? undefined
      : sql`exists (select 1 from jsonb_array_elements(${contacts.attributes}) as attribute where lower(attribute ->> 'key') = lower(${filter.attributeKey}) and attribute ->> 'value' = ${filter.attributeValue})`,
    filter.possibleDuplicate === undefined
      ? undefined
      : filter.possibleDuplicate
        ? isNotNull(contacts.possibleDuplicateOfContactId)
        : sql`${contacts.possibleDuplicateOfContactId} is null`,
  ) as SQL;
}

export async function listContacts(
  db: DbExecutor,
  grant: PermissionGrant,
  filter: ContactFilter,
  options: { limit: number; cursor?: Cursor | undefined },
): Promise<(ContactRow & { createdAtExact: string })[]> {
  const rows = await db
    .select({ contact: contacts, createdAtExact: createdExact })
    .from(contacts)
    .where(
      and(
        contactFilterCondition(grant, filter),
        options.cursor === undefined
          ? undefined
          : sql`(${contacts.createdAt}, ${contacts.id}) < (${options.cursor.atExact}::timestamptz, ${options.cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(options.limit);
  return rows.map((row) => ({ ...row.contact, createdAtExact: row.createdAtExact }));
}

// ── Impor: pembersih isian ──────────────────────────────────────────────────

const IMPORT_BATCH = 200;
const ISSUES_REPORTED = 200;
const VALUE_MAX = 500;

/** Tabel hasil parser (judul unik + baris bernomor). Sama bentuknya dengan `ParsedTable` broadcast. */
export interface ImportTable {
  columns: string[];
  rows: { row: number; values: string[] }[];
}

interface PreparedRow {
  row: number;
  phone: string;
  name?: string;
  email?: string;
  notes?: string;
  attributes: { key: string; value: string }[];
  tags: string[];
}

function cleanCell(value: string | undefined): string {
  return (value ?? '').replace(/[\p{Cc}]/gu, ' ').trim();
}

// ── Layanan ─────────────────────────────────────────────────────────────────

export interface CrmService {
  exportCsv(
    auth: AuthContext,
    filter: ContactFilter,
    confirmation: IdentityConfirmation | undefined,
    context: TwoFactorContext,
  ): Promise<{ csv: string; rows: number }>;
  merge(
    auth: AuthContext,
    targetId: string,
    sourceId: string,
    confirmation: IdentityConfirmation | undefined,
    context: TwoFactorContext,
  ): Promise<MergeContactResponse['moved']>;
  importTable(
    auth: AuthContext,
    table: ImportTable,
    mapping: ContactImportMapping,
    client: ClientInfo,
  ): Promise<ContactImportResult>;
}

export function createCrmService(deps: {
  db: Database;
  publisher: InboxEventPublisher;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  logger?: Pick<Logger, 'warn'>;
  now?: () => Date;
}): CrmService {
  const { db, publisher, twoFactor } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    // ── Ekspor massal ──────────────────────────────────────────────────────
    async exportCsv(auth, filter, confirmation, context) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'contact.bulk_export',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengekspor data kontak.',
      );
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'contacts.export');
        const scope = permissionScope(role, 'contacts.view');
        if (!scope) throw authorityChanged();
        const grant: PermissionGrant = {
          permission: 'contacts.view',
          scope,
          userId: auth.user.id,
          organizationId: auth.organizationId,
        };
        const where = contactFilterCondition(grant, filter);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(contacts)
          .where(where);
        const total = Number(count?.total ?? 0);
        if (total > CONTACT_BULK_EXPORT_MAX) {
          throw new AppError('CONFLICT', {
            message: `Hasil ekspor ${total.toLocaleString('id-ID')} kontak melebihi batas ${CONTACT_BULK_EXPORT_MAX.toLocaleString('id-ID')}. Persempit saringan (mis. per tag).`,
          });
        }
        const definitions = await listAttributeDefinitions(tx, auth.organizationId, {
          entity: 'contact',
        });
        const definedKeys = definitions.map((definition) =>
          definition.key.toLocaleLowerCase('id-ID'),
        );
        const rows = await tx
          .select({
            contact: contacts,
            // SQL literal: Drizzle tidak mengualifikasi kolom di daftar select satu tabel.
            tagNames: sql<
              string | null
            >`(select string_agg(t.name, '; ' order by lower(t.name)) from contact_tags ct join tags t on t.organization_id = ct.organization_id and t.id = ct.tag_id where ct.organization_id = contacts.organization_id and ct.contact_id = contacts.id)`,
          })
          .from(contacts)
          .where(where)
          .orderBy(asc(contacts.number));
        const header = [
          'Nomor kontak',
          'Nama',
          'Nama profil WhatsApp',
          'Nomor WhatsApp',
          'Username WhatsApp',
          'Email',
          'Tag',
          'Catatan',
          'Dibuat (UTC)',
          ...definitions.map((definition) => definition.label),
          'Atribut lain',
        ];
        let csv = `\ufeff${csvRow(header)}`;
        for (const { contact, tagNames } of rows) {
          const attributes = Array.isArray(contact.attributes) ? contact.attributes : [];
          const byKey = new Map(
            attributes.map((item) => [item.key.toLocaleLowerCase('id-ID'), item.value]),
          );
          const others = attributes
            .filter((item) => !definedKeys.includes(item.key.toLocaleLowerCase('id-ID')))
            .map((item) => `${item.key}=${item.value}`)
            .join('; ');
          csv += csvRow([
            contact.number,
            contact.name,
            contact.profileName,
            contact.phone,
            contact.waUsername,
            contact.email,
            tagNames,
            contact.notes,
            contact.createdAt.toISOString(),
            ...definedKeys.map((key) => byKey.get(key) ?? null),
            others || null,
          ]);
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.contactBulkExported,
          targetType: 'contact',
          // HANYA jumlah & ada/tidaknya saringan — tanpa kata cari (bisa berisi nama/nomor).
          metadata: {
            rows: rows.length,
            filtered: Object.values(filter).some((value) => value !== undefined),
            actorRole: role,
          },
          client: context.client,
        });
        return { csv, rows: rows.length };
      });
    },

    // ── Gabung duplikat ────────────────────────────────────────────────────
    async merge(auth, targetId, sourceId, confirmation, context) {
      if (targetId === sourceId) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Pilih kontak lain untuk digabung.',
          details: [
            {
              location: 'body',
              field: 'sourceContactId',
              message: 'Pilih kontak lain untuk digabung.',
            },
          ],
        });
      }
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'contact.merge',
        context,
        'Masukkan password (dan kode verifikasi) untuk menggabungkan kontak.',
      );
      const org = auth.organizationId;
      const moved = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'contacts.manage');
        // Identitas kedua kontak dikunci dengan kunci yang SAMA dengan worker pesan masuk (urut =
        // bebas deadlock), lalu barisnya (urut ID).
        const peek = await tx
          .select({
            id: contacts.id,
            channelType: contacts.channelType,
            bsuid: contacts.waBsuid,
            phone: contacts.phone,
          })
          .from(contacts)
          .where(and(eq(contacts.organizationId, org), inArray(contacts.id, [targetId, sourceId])));
        if (peek.length !== 2) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
        const keys = [
          ...new Set(
            peek.flatMap((row) =>
              contactIdentityLockKeys(org, row.channelType, { bsuid: row.bsuid, phone: row.phone }),
            ),
          ),
        ].sort();
        await lockAdvisoryKeys(tx, keys);
        const locked = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.organizationId, org), inArray(contacts.id, [targetId, sourceId])))
          .orderBy(asc(contacts.id))
          .for('update');
        const target = locked.find((row) => row.id === targetId);
        const source = locked.find((row) => row.id === sourceId);
        if (!target || !source) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });

        const conflict = (message: string) => new AppError('CONFLICT', { message });
        if (target.channelType !== source.channelType) {
          throw conflict('Kontak dari jenis channel berbeda tidak bisa digabung.');
        }
        if (
          (target.waBsuid && source.waBsuid && target.waBsuid !== source.waBsuid) ||
          (target.phone && source.phone && target.phone !== source.phone)
        ) {
          throw conflict(
            'Kedua kontak punya identitas WhatsApp berbeda (nomor/akun lain) — tidak bisa digabung.',
          );
        }
        const [openClash] = await tx
          .select({ channelId: conversations.channelId })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, org),
              eq(conversations.contactId, sourceId),
              ne(conversations.status, 'resolved'),
              sql`exists (select 1 from ${conversations} as other where other.organization_id = ${org} and other.contact_id = ${targetId} and other.channel_id = ${conversations.channelId} and other.status <> 'resolved')`,
            ),
          )
          .limit(1);
        if (openClash) {
          throw conflict(
            'Kedua kontak punya percakapan terbuka di channel yang sama. Tandai selesai salah satunya dulu.',
          );
        }

        // Atribut: gabungan, nilai kontak tujuan menang bila kuncinya sama.
        const targetAttributes = Array.isArray(target.attributes) ? target.attributes : [];
        const seen = new Set(targetAttributes.map((item) => item.key.toLocaleLowerCase('id-ID')));
        const attributes = [
          ...targetAttributes,
          ...(Array.isArray(source.attributes) ? source.attributes : []).filter(
            (item) => !seen.has(item.key.toLocaleLowerCase('id-ID')),
          ),
        ];
        if (attributes.length > CONTACT_ATTRIBUTES_MAX) {
          throw conflict(
            `Gabungan atribut melebihi ${String(CONTACT_ATTRIBUTES_MAX)}. Hapus sebagian atribut dulu.`,
          );
        }
        const [tagCount] = await tx
          .select({ total: sql<number>`count(distinct ${contactTags.tagId})::int` })
          .from(contactTags)
          .where(
            and(
              eq(contactTags.organizationId, org),
              inArray(contactTags.contactId, [targetId, sourceId]),
            ),
          );
        if (Number(tagCount?.total ?? 0) > TAGS_PER_CONTACT_MAX) {
          throw conflict(
            `Gabungan tag melebihi ${String(TAGS_PER_CONTACT_MAX)}. Lepas sebagian tag dulu.`,
          );
        }

        // Identitas WhatsApp pindah ke kontak tujuan bila tujuan belum punya (mis. kontak lama hanya
        // catatan CRM dan kontak baru bertanda "mungkin duplikat", review R4). Sumber dilepas dulu
        // supaya indeks unik identitas tidak bentrok.
        const takeBsuid = !target.waBsuid && source.waBsuid ? source.waBsuid : null;
        const takePhone = !target.phone && source.phone ? source.phone : null;
        if (takeBsuid || takePhone) {
          await tx
            .update(contacts)
            .set({ waBsuid: null, phone: null, waIdentityReleasedAt: now() })
            .where(and(eq(contacts.organizationId, org), eq(contacts.id, sourceId)));
        }
        const notes =
          target.notes && source.notes && target.notes !== source.notes
            ? `${target.notes}\n\n${source.notes}`.length <= CONTACT_NOTES_MAX
              ? `${target.notes}\n\n${source.notes}`
              : target.notes
            : (target.notes ?? source.notes);
        const gainsIdentity = takeBsuid !== null || takePhone !== null;
        await tx
          .update(contacts)
          .set({
            name: target.name ?? source.name,
            profileName: target.profileName ?? source.profileName,
            waUsername: target.waUsername ?? source.waUsername,
            email: target.email ?? source.email,
            notes,
            attributes,
            ...(takeBsuid ? { waBsuid: takeBsuid } : {}),
            ...(takePhone ? { phone: takePhone } : {}),
            ...(gainsIdentity ? { waIdentityReleasedAt: null } : {}),
            possibleDuplicateOfContactId:
              target.possibleDuplicateOfContactId === sourceId
                ? null
                : (target.possibleDuplicateOfContactId ??
                  (source.possibleDuplicateOfContactId === targetId
                    ? null
                    : source.possibleDuplicateOfContactId)),
          })
          .where(and(eq(contacts.organizationId, org), eq(contacts.id, targetId)));
        // Kontak lain yang menandai SUMBER sebagai pasangan duplikatnya → menunjuk tujuan.
        await tx
          .update(contacts)
          .set({
            possibleDuplicateOfContactId: sql`case when ${contacts.id} = ${targetId} then null else ${targetId}::uuid end`,
          })
          .where(
            and(
              eq(contacts.organizationId, org),
              eq(contacts.possibleDuplicateOfContactId, sourceId),
            ),
          );

        const movedConversations = await tx
          .update(conversations)
          .set({ contactId: targetId })
          .where(and(eq(conversations.organizationId, org), eq(conversations.contactId, sourceId)))
          .returning({ id: conversations.id });
        const movedMessages = await tx
          .update(messages)
          .set({ contactId: targetId })
          .where(and(eq(messages.organizationId, org), eq(messages.contactId, sourceId)))
          .returning({ id: messages.id });
        const sourceTags = await tx
          .select({ tagId: contactTags.tagId, createdByUserId: contactTags.createdByUserId })
          .from(contactTags)
          .where(and(eq(contactTags.organizationId, org), eq(contactTags.contactId, sourceId)));
        let movedTags = 0;
        if (sourceTags.length > 0) {
          const inserted = await tx
            .insert(contactTags)
            .values(
              sourceTags.map((tag) => ({
                organizationId: org,
                contactId: targetId,
                tagId: tag.tagId,
                createdByUserId: tag.createdByUserId,
              })),
            )
            .onConflictDoNothing()
            .returning({ tagId: contactTags.tagId });
          movedTags = inserted.length;
          await tx
            .delete(contactTags)
            .where(and(eq(contactTags.organizationId, org), eq(contactTags.contactId, sourceId)));
        }
        await tx
          .update(contactEvents)
          .set({ contactId: targetId })
          .where(and(eq(contactEvents.organizationId, org), eq(contactEvents.contactId, sourceId)));
        await tx
          .update(webhookEvents)
          .set({ contactId: targetId })
          .where(and(eq(webhookEvents.organizationId, org), eq(webhookEvents.contactId, sourceId)));
        await tx
          .update(broadcastRecipients)
          .set({ contactId: targetId })
          .where(
            and(
              eq(broadcastRecipients.organizationId, org),
              eq(broadcastRecipients.contactId, sourceId),
            ),
          );
        await tx
          .update(outgoingEvents)
          .set({ contactId: targetId })
          .where(
            and(eq(outgoingEvents.organizationId, org), eq(outgoingEvents.contactId, sourceId)),
          );
        const movedTickets = await tx
          .update(tickets)
          .set({ contactId: targetId })
          .where(and(eq(tickets.organizationId, org), eq(tickets.contactId, sourceId)))
          .returning({ id: tickets.id });
        await tx
          .delete(contacts)
          .where(and(eq(contacts.organizationId, org), eq(contacts.id, sourceId)));

        await tx.insert(contactEvents).values({
          organizationId: org,
          contactId: targetId,
          kind: 'merged',
          actorUserId: auth.user.id,
        });
        await recordOutgoingEvent(tx, {
          organizationId: org,
          type: 'contact.updated',
          contactId: targetId,
          actorUserId: auth.user.id,
        });
        const result = {
          conversations: movedConversations.length,
          messages: movedMessages.length,
          tags: movedTags,
          tickets: movedTickets.length,
        };
        await recordAudit(tx, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.contactMerged,
          targetType: 'contact',
          targetId,
          // Tanpa nama/nomor (UU PDP): hanya ID & jumlah.
          metadata: { sourceContactId: sourceId, ...result, actorRole: role },
          client: context.client,
        });
        return result;
      });
      await publishContactDetail(db, publisher, org, [targetId], 'contact');
      return moved;
    },

    // ── Impor massal ───────────────────────────────────────────────────────
    async importTable(auth, table, mapping, client) {
      const org = auth.organizationId;
      const indexOf = (column: string | null, field: string): number | null => {
        if (column === null) return null;
        const index = table.columns.indexOf(column);
        if (index < 0) {
          throw new AppError('VALIDATION_ERROR', {
            message: `Kolom "${column}" tidak ada di berkas.`,
            details: [
              {
                location: 'body',
                field: `mapping.${field}`,
                message: 'Kolom tidak ada di berkas.',
              },
            ],
          });
        }
        return index;
      };
      const phoneIndex = indexOf(mapping.phoneColumn, 'phoneColumn') as number;
      const nameIndex = indexOf(mapping.nameColumn, 'nameColumn');
      const emailIndex = indexOf(mapping.emailColumn, 'emailColumn');
      const notesIndex = indexOf(mapping.notesColumn, 'notesColumn');
      const tagsIndex = indexOf(mapping.tagsColumn, 'tagsColumn');
      const attributeColumns = mapping.attributes.map((item, position) => ({
        key: item.key,
        index: indexOf(item.column, `attributes.${String(position)}.column`) as number,
      }));
      const rules = await attributeRules(db, org, { entity: 'contact' });

      const issueCounts = Object.fromEntries(
        CONTACT_IMPORT_ISSUES.map((issue) => [issue, 0]),
      ) as Record<ContactImportIssue, number>;
      const issues: ContactImportResult['issues'] = [];
      const report = (row: number, issue: ContactImportIssue, key?: string) => {
        issueCounts[issue] += 1;
        if (issues.length < ISSUES_REPORTED) issues.push({ row, issue, ...(key ? { key } : {}) });
      };

      const prepared: PreparedRow[] = [];
      const seen = new Set<string>();
      for (const { row, values } of table.rows) {
        if (values.some((value) => value.length > VALUE_MAX)) {
          report(row, 'value_too_long');
          continue;
        }
        const phone = normalizeBroadcastPhone(values[phoneIndex]);
        if (!phone.ok) {
          report(row, phone.issue);
          continue;
        }
        if (seen.has(phone.phone)) {
          report(row, 'duplicate');
          continue;
        }
        seen.add(phone.phone);
        const item: PreparedRow = { row, phone: phone.phone, attributes: [], tags: [] };
        if (nameIndex !== null) {
          const name = (values[nameIndex] ?? '').trim();
          if (name !== '') {
            if (name.length > CONTACT_NAME_MAX || hasControlCharacters(name)) {
              report(row, 'name_invalid');
              continue;
            }
            item.name = name;
          }
        }
        if (emailIndex !== null) {
          const raw = cleanCell(values[emailIndex]);
          if (raw !== '') {
            const email = emailAddressSchema.safeParse(raw);
            if (!email.success) {
              report(row, 'email_invalid');
              continue;
            }
            item.email = email.data;
          }
        }
        if (notesIndex !== null) {
          const notes = (values[notesIndex] ?? '').trim();
          if (notes !== '') {
            if (
              notes.length > CONTACT_NOTES_MAX ||
              hasControlCharacters(notes.replace(/\r?\n|\t/g, ' '))
            ) {
              report(row, 'value_too_long');
              continue;
            }
            item.notes = notes;
          }
        }
        const rawAttributes = attributeColumns
          .map(({ key, index }) => ({ key, value: cleanCell(values[index]) }))
          .filter((attribute) => attribute.value !== '');
        const checked = validateAttributeValues(rules, rawAttributes, { enforceRequired: false });
        if (!checked.ok) {
          report(row, 'attribute_invalid', checked.issues[0]?.key);
          continue;
        }
        item.attributes = checked.values;
        if (tagsIndex !== null) {
          const names = [
            ...new Map(
              cleanCell(values[tagsIndex])
                .split(/[,;]/)
                .map((name) => name.trim())
                .filter((name) => name !== '')
                .map((name) => [name.toLocaleLowerCase('id-ID'), name] as const),
            ).values(),
          ];
          if (names.some((name) => !tagNameSchema.safeParse(name).success)) {
            report(row, 'tag_invalid');
            continue;
          }
          if (names.length > TAGS_PER_CONTACT_MAX) {
            report(row, 'tags_limit');
            continue;
          }
          item.tags = names;
        }
        prepared.push(item);
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (let start = 0; start < prepared.length; start += IMPORT_BATCH) {
        const batch = prepared.slice(start, start + IMPORT_BATCH);
        const outcome = await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'contacts.export');
          if (!mapping.dryRun) {
            const keys = batch
              .flatMap((item) =>
                contactIdentityLockKeys(org, 'whatsapp', { bsuid: null, phone: item.phone }),
              )
              .sort();
            await lockAdvisoryKeys(tx, keys);
          }
          const existing = await tx
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.organizationId, org),
                eq(contacts.channelType, 'whatsapp'),
                inArray(
                  contacts.phone,
                  batch.map((item) => item.phone),
                ),
              ),
            )
            .for(mapping.dryRun ? 'share' : 'update');
          const byPhone = new Map(existing.map((row) => [row.phone, row]));
          const counts = { created: 0, updated: 0, unchanged: 0 };
          const tagIds = mapping.dryRun
            ? new Map<string, string>()
            : await ensureTags(tx, org, batch);
          for (const item of batch) {
            const current = byPhone.get(item.phone);
            if (current && mapping.mode === 'create_only') {
              report(item.row, 'exists');
              continue;
            }
            if (!current) {
              counts.created += 1;
              if (mapping.dryRun) continue;
              const [row] = await tx
                .insert(contacts)
                .values({
                  organizationId: org,
                  channelType: 'whatsapp',
                  phone: item.phone,
                  name: item.name ?? null,
                  email: item.email ?? null,
                  notes: item.notes ?? null,
                  attributes: item.attributes,
                })
                .returning({ id: contacts.id });
              if (!row) throw new Error('Kontak impor tidak tersimpan');
              if (
                (await attachTags(tx, org, auth.user.id, row.id, item.tags, tagIds)) === 'limit'
              ) {
                report(item.row, 'tags_limit');
              }
              const fields: ContactEditableField[] = [];
              if (item.name) fields.push('name');
              if (item.email) fields.push('email');
              if (item.notes) fields.push('notes');
              if (item.attributes.length > 0) fields.push('attributes');
              await tx.insert(contactEvents).values({
                organizationId: org,
                contactId: row.id,
                kind: 'imported',
                actorUserId: auth.user.id,
                fields: fields.length > 0 ? fields : null,
              });
              continue;
            }
            // Kontak yang sudah ada: HANYA isian yang dipetakan & terisi yang diganti; atribut
            // digabung per kunci.
            const patch: Partial<typeof contacts.$inferInsert> = {};
            const fields: ContactEditableField[] = [];
            if (item.name !== undefined && item.name !== current.name) {
              patch.name = item.name;
              fields.push('name');
            }
            if (item.email !== undefined && item.email !== current.email) {
              patch.email = item.email;
              fields.push('email');
            }
            if (item.notes !== undefined && item.notes !== current.notes) {
              patch.notes = item.notes;
              fields.push('notes');
            }
            if (item.attributes.length > 0) {
              const merged = [...(Array.isArray(current.attributes) ? current.attributes : [])];
              for (const attribute of item.attributes) {
                const folded = attribute.key.toLocaleLowerCase('id-ID');
                const at = merged.findIndex(
                  (existingItem) => existingItem.key.toLocaleLowerCase('id-ID') === folded,
                );
                if (at >= 0) merged[at] = attribute;
                else merged.push(attribute);
              }
              if (merged.length > CONTACT_ATTRIBUTES_MAX) {
                report(item.row, 'attributes_limit');
                continue;
              }
              if (JSON.stringify(merged) !== JSON.stringify(current.attributes)) {
                patch.attributes = merged;
                fields.push('attributes');
              }
            }
            let tagged = false;
            if (!mapping.dryRun && item.tags.length > 0) {
              const result = await attachTags(tx, org, auth.user.id, current.id, item.tags, tagIds);
              if (result === 'limit') {
                report(item.row, 'tags_limit');
                continue;
              }
              tagged = result > 0;
            }
            if (fields.length === 0 && !tagged && !(mapping.dryRun && item.tags.length > 0)) {
              counts.unchanged += 1;
              continue;
            }
            counts.updated += 1;
            if (mapping.dryRun) continue;
            if (fields.length > 0) {
              await tx
                .update(contacts)
                .set(patch)
                .where(and(eq(contacts.organizationId, org), eq(contacts.id, current.id)));
            }
            await tx.insert(contactEvents).values({
              organizationId: org,
              contactId: current.id,
              kind: 'imported',
              actorUserId: auth.user.id,
              fields: fields.length > 0 ? fields : null,
            });
          }
          return counts;
        });
        created += outcome.created;
        updated += outcome.updated;
        unchanged += outcome.unchanged;
      }

      const skipped = Object.values(issueCounts).reduce((sum, value) => sum + value, 0);
      if (!mapping.dryRun) {
        await recordAudit(db, {
          organizationId: org,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.contactImported,
          targetType: 'contact',
          // Tanpa isi berkas, nama kolom, atau nomor.
          metadata: {
            sourceRows: table.rows.length,
            created,
            updated,
            unchanged,
            skipped,
            mode: mapping.mode,
          },
          client,
        });
      }
      return {
        dryRun: mapping.dryRun,
        sourceRows: table.rows.length,
        created,
        updated,
        unchanged,
        skipped,
        issueCounts,
        issues,
      };
    },
  };
}

/**
 * Tag yang dipakai batch ini (nama tanpa beda huruf → ID); yang belum ada dibuat (biru) sampai batas
 * organisasi. Tag yang tidak bisa dibuat (batas) tidak ada di peta → baris itu `tags_limit`.
 */
async function ensureTags(
  tx: DbExecutor,
  organizationId: string,
  batch: readonly PreparedRow[],
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const item of batch) {
    for (const name of item.tags) wanted.set(name.toLocaleLowerCase('id-ID'), name);
  }
  const result = new Map<string, string>();
  if (wanted.size === 0) return result;
  const load = async () => {
    const rows = await tx
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(
        and(
          eq(tags.organizationId, organizationId),
          or(...[...wanted.keys()].map((folded) => sql`lower(${tags.name}) = ${folded}`)),
        ),
      );
    for (const row of rows) result.set(row.name.toLocaleLowerCase('id-ID'), row.id);
  };
  await load();
  const missing = [...wanted.entries()].filter(([folded]) => !result.has(folded));
  if (missing.length === 0) return result;
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(tags)
    .where(eq(tags.organizationId, organizationId));
  const room = Math.max(0, TAGS_PER_ORGANIZATION_MAX - Number(count?.total ?? 0));
  const creatable = missing.slice(0, room);
  if (creatable.length > 0) {
    await tx
      .insert(tags)
      .values(creatable.map(([, name]) => ({ organizationId, name, color: 'blue' as const })))
      .onConflictDoNothing();
    await load();
  }
  return result;
}

/** Pasang tag ke kontak (lewati yang sudah terpasang). `'limit'` = melebihi batas per kontak/organisasi. */
async function attachTags(
  tx: DbExecutor,
  organizationId: string,
  actorUserId: string,
  contactId: string,
  names: readonly string[],
  tagIds: ReadonlyMap<string, string>,
): Promise<number | 'limit'> {
  if (names.length === 0) return 0;
  const ids = names.map((name) => tagIds.get(name.toLocaleLowerCase('id-ID')));
  if (ids.some((id) => id === undefined)) return 'limit';
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(contactTags)
    .where(
      and(eq(contactTags.organizationId, organizationId), eq(contactTags.contactId, contactId)),
    );
  const inserted = await tx
    .insert(contactTags)
    .values(
      (ids as string[]).map((tagId) => ({
        organizationId,
        contactId,
        tagId,
        createdByUserId: actorUserId,
      })),
    )
    .onConflictDoNothing()
    .returning({ tagId: contactTags.tagId });
  if (Number(count?.total ?? 0) + inserted.length > TAGS_PER_CONTACT_MAX) {
    // Batalkan pemasangan baris ini saja (tag lain di batch tetap).
    await tx.delete(contactTags).where(
      and(
        eq(contactTags.organizationId, organizationId),
        eq(contactTags.contactId, contactId),
        inArray(
          contactTags.tagId,
          inserted.map((row) => row.tagId),
        ),
      ),
    );
    return 'limit';
  }
  return inserted.length;
}
