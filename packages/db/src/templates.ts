import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_QUALITY_SCORES,
  TEMPLATE_STATUSES,
  type TemplateContent,
  type TemplateStatus,
} from '@balesin/shared';
import { and, eq, inArray, isNotNull, not, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { messageTemplates } from './schema';

/**
 * Penulisan template dari Meta (Fase 4) — dipakai api (sinkron manual) DAN worker (sinkron berkala,
 * webhook status) supaya aturannya satu. Hanya ID/nama/status/komponen template (tanpa data
 * pelanggan).
 */

/** Template Meta yang sudah dipetakan pemanggil (`fromMetaComponents` untuk `content`). */
export interface SyncedTemplate {
  metaTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  qualityScore: string | null;
  metaComponents: Record<string, unknown>[];
  content: TemplateContent;
}

/** Status Meta → status Balesin (`null` = abaikan/tidak dikenal). */
export function normalizeTemplateStatus(value: string | null | undefined): TemplateStatus | null {
  const upper = (value ?? '').toUpperCase();
  if (upper === 'REINSTATED' || upper === 'UNPAUSED') return 'APPROVED';
  if (upper === 'DRAFT') return null;
  return (TEMPLATE_STATUSES as readonly string[]).includes(upper)
    ? (upper as TemplateStatus)
    : null;
}

function category(value: string): string {
  const upper = value.toUpperCase();
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(upper) ? upper : 'UTILITY';
}

function quality(value: string | null): string | null {
  const upper = (value ?? '').toUpperCase();
  return (TEMPLATE_QUALITY_SCORES as readonly string[]).includes(upper) ? upper : null;
}

/**
 * Sinkron penuh satu channel (WABA): buat/perbarui per (nama, bahasa); template Balesin yang sudah
 * pernah diajukan tetapi tidak ada lagi di Meta → `DELETED` (baris disimpan untuk riwayat). Isi lokal
 * yang belum diajukan (`local_changes`) TIDAK ditimpa.
 */
export async function upsertSyncedTemplates(
  db: DbExecutor,
  input: {
    organizationId: string;
    channelId: string;
    wabaId: string;
    templates: readonly SyncedTemplate[];
    now: Date;
  },
): Promise<{ created: number; updated: number; removed: number }> {
  let created = 0;
  let updated = 0;
  const seen: string[] = [];
  for (const template of input.templates) {
    const status = normalizeTemplateStatus(template.status) ?? 'PENDING';
    seen.push(template.metaTemplateId);
    const [existing] = await db
      .select({ id: messageTemplates.id, localChanges: messageTemplates.localChanges })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.organizationId, input.organizationId),
          eq(messageTemplates.channelId, input.channelId),
          eq(messageTemplates.name, template.name),
          eq(messageTemplates.language, template.language),
        ),
      )
      .limit(1)
      .for('update');
    const common = {
      wabaId: input.wabaId,
      metaTemplateId: template.metaTemplateId,
      category: category(template.category),
      status,
      rejectedReason:
        template.rejectedReason && template.rejectedReason !== 'NONE'
          ? template.rejectedReason
          : null,
      qualityScore: quality(template.qualityScore),
      metaComponents: template.metaComponents,
      lastSyncedAt: input.now,
      statusUpdatedAt: input.now,
    };
    if (existing) {
      await db
        .update(messageTemplates)
        .set({ ...common, ...(existing.localChanges ? {} : { content: template.content }) })
        .where(eq(messageTemplates.id, existing.id));
      updated += 1;
    } else {
      await db.insert(messageTemplates).values({
        ...common,
        organizationId: input.organizationId,
        channelId: input.channelId,
        name: template.name,
        language: template.language,
        content: template.content,
        source: 'meta',
      });
      created += 1;
    }
  }
  const removed = await db
    .update(messageTemplates)
    .set({ status: 'DELETED', lastSyncedAt: input.now, statusUpdatedAt: input.now })
    .where(
      and(
        eq(messageTemplates.organizationId, input.organizationId),
        eq(messageTemplates.channelId, input.channelId),
        isNotNull(messageTemplates.metaTemplateId),
        not(inArray(messageTemplates.status, ['DELETED'])),
        seen.length > 0 ? not(inArray(messageTemplates.metaTemplateId, seen)) : sql`true`,
      ),
    )
    .returning({ id: messageTemplates.id });
  return { created, updated, removed: removed.length };
}

/**
 * Pembaruan dari webhook template (status / kualitas / kategori) untuk SEMUA channel organisasi yang
 * memakai WABA itu. Mengembalikan jumlah baris yang berubah.
 */
export async function applyTemplateUpdate(
  db: DbExecutor,
  input: {
    organizationId: string;
    wabaId: string;
    metaTemplateId: string;
    event: string | null;
    reason: string | null;
    quality: string | null;
    category: string | null;
    now: Date;
  },
): Promise<number> {
  const status = normalizeTemplateStatus(input.event);
  const qualityScore = input.event?.toUpperCase() === 'FLAGGED' ? 'RED' : quality(input.quality);
  const patch: Partial<typeof messageTemplates.$inferInsert> = {};
  if (status) {
    patch.status = status;
    patch.rejectedReason =
      input.reason && input.reason !== 'NONE' ? input.reason.slice(0, 200) : null;
    patch.statusUpdatedAt = input.now;
  }
  if (qualityScore) patch.qualityScore = qualityScore;
  if (input.category) patch.category = category(input.category);
  if (Object.keys(patch).length === 0) return 0;
  const rows = await db
    .update(messageTemplates)
    .set(patch)
    .where(
      and(
        eq(messageTemplates.organizationId, input.organizationId),
        eq(messageTemplates.wabaId, input.wabaId),
        eq(messageTemplates.metaTemplateId, input.metaTemplateId),
      ),
    )
    .returning({ id: messageTemplates.id });
  return rows.length;
}
