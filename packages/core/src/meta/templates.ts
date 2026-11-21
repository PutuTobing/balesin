import { fromMetaComponents, type TemplateContent } from '@balesin/shared';
import { z } from 'zod';

import type { MetaCredentials, MetaGraphClient } from './graph-client';

/**
 * Template pesan lewat klien Graph terpusat (kelompok laju `management`). Sumber (dibaca 19 Nov
 * 2026): developers.facebook.com/docs/whatsapp/business-management-api/message-templates.
 *  - daftar: `GET /{waba-id}/message_templates` berhalaman kursor (`paging.cursors.after`);
 *  - buat: `POST /{waba-id}/message_templates`;
 *  - ubah: `POST /{template-id}` (komponen/kategori; dibatasi Meta);
 *  - hapus: `DELETE /{waba-id}/message_templates?name=…&hsm_id=…`.
 * Isi template bukan data pribadi; tetap tidak ditulis ke log (hanya nama operasi + jumlah).
 */

/** Satu template dari Meta (isian yang dipakai Balesin; sisanya dibuang). */
export const metaTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(16),
  status: z.string().max(32),
  category: z.string().max(32),
  components: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  rejected_reason: z.string().max(200).optional(),
  quality_score: z
    .object({ score: z.string().max(16).optional() })
    .loose()
    .optional(),
  parameter_format: z.string().max(16).optional(),
});
export type MetaTemplate = z.infer<typeof metaTemplateSchema>;

const pageSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z
        .object({ after: z.string().max(512).optional() })
        .loose()
        .optional(),
      next: z.string().optional(),
    })
    .loose()
    .optional(),
});

const FIELDS =
  'id,name,language,status,category,components,rejected_reason,quality_score,parameter_format';

/** Batas halaman per sinkron (100 × 50 = 5.000 template — jauh di atas batas Meta per WABA). */
export const TEMPLATE_SYNC_MAX_PAGES = 50;

/**
 * Semua template satu WABA. Baris yang tidak lolos skema dilewati (dihitung). Melempar
 * `MetaApiError` bila Meta menolak.
 */
export async function listMessageTemplates(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  wabaId: string,
): Promise<{ templates: MetaTemplate[]; skipped: number; truncated: boolean }> {
  const templates: MetaTemplate[] = [];
  let skipped = 0;
  let after: string | undefined;
  for (let page = 0; page < TEMPLATE_SYNC_MAX_PAGES; page += 1) {
    const result = await client.request(credentials, {
      operation: 'message_templates.list',
      method: 'GET',
      path: [wabaId, 'message_templates'],
      query: { fields: FIELDS, limit: 100, ...(after ? { after } : {}) },
      schema: pageSchema,
    });
    for (const item of result.data) {
      const parsed = metaTemplateSchema.safeParse(item);
      if (parsed.success) templates.push(parsed.data);
      else skipped += 1;
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined;
    if (!after) return { templates, skipped, truncated: false };
  }
  return { templates, skipped, truncated: true };
}

export async function createMessageTemplate(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  wabaId: string,
  template: {
    name: string;
    language: string;
    category: string;
    components: readonly Record<string, unknown>[];
    named: boolean;
  },
): Promise<{ id: string; status: string; category: string | null }> {
  return client.request(credentials, {
    operation: 'message_templates.create',
    method: 'POST',
    path: [wabaId, 'message_templates'],
    body: {
      name: template.name,
      language: template.language,
      category: template.category,
      components: template.components,
      ...(template.named ? { parameter_format: 'NAMED' } : {}),
    },
    schema: z
      .object({
        id: z.string().min(1).max(64),
        status: z.string().max(32).default('PENDING'),
        category: z.string().max(32).optional(),
      })
      .transform((value) => ({
        id: value.id,
        status: value.status,
        category: value.category ?? null,
      })),
  });
}

/** Ubah template yang sudah ada di Meta (komponen + kategori bila belum disetujui). */
export async function editMessageTemplate(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  metaTemplateId: string,
  change: { components: readonly Record<string, unknown>[]; category?: string },
): Promise<void> {
  await client.request(credentials, {
    operation: 'message_templates.edit',
    method: 'POST',
    path: [metaTemplateId],
    body: {
      components: change.components,
      ...(change.category ? { category: change.category } : {}),
    },
    schema: z.object({ success: z.boolean() }).loose(),
  });
}

/** Hapus satu bahasa template (`hsm_id`) — tanpa `hsm_id` Meta menghapus SEMUA bahasa nama itu. */
export async function deleteMessageTemplate(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  wabaId: string,
  template: { name: string; metaTemplateId: string },
): Promise<void> {
  await client.request(credentials, {
    operation: 'message_templates.delete',
    method: 'DELETE',
    path: [wabaId, 'message_templates'],
    query: { name: template.name, hsm_id: template.metaTemplateId },
    schema: z.object({ success: z.boolean() }).loose(),
  });
}

/** Template Meta → bentuk penyimpanan Balesin (dipakai sinkron api & worker). */
export function metaTemplateToSynced(template: MetaTemplate): {
  metaTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  qualityScore: string | null;
  metaComponents: Record<string, unknown>[];
  content: TemplateContent;
} {
  return {
    metaTemplateId: template.id,
    name: template.name,
    language: template.language,
    category: template.category,
    status: template.status,
    rejectedReason: template.rejected_reason ?? null,
    qualityScore: template.quality_score?.score ?? null,
    metaComponents: template.components,
    content: fromMetaComponents(template.components, template.parameter_format),
  };
}
