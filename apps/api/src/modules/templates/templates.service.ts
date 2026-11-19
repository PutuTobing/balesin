import {
  AppError,
  createMessageTemplate,
  deleteMessageTemplate,
  editMessageTemplate,
  isMetaApiError,
  listMessageTemplates,
  metaTemplateToSynced,
  openWhatsAppCredentials,
  type MetaGraphClient,
  type SecretBox,
} from '@balesin/core';
import {
  PG_ERROR_CODES,
  channels,
  isPgError,
  messageTemplates,
  upsertSyncedTemplates,
  type Channel,
  type Database,
  type MessageTemplateRow,
} from '@balesin/db';
import {
  TEMPLATE_META_ERROR_MESSAGES,
  TEMPLATE_META_REJECTED,
  findTemplatePreset,
  templateContentSchema,
  toMetaComponents,
  validateTemplate,
  type MessageTemplate,
  type TemplateCategory,
  type AuditAction,
  type TemplateStatus,
} from '@balesin/shared';
import { and, asc, eq, ilike, isNull, ne, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { likePattern } from '../inbox/inbox.repo';
import type {
  createTemplateRequestSchema,
  syncTemplatesResponseSchema,
  updateTemplateRequestSchema,
} from '@balesin/shared';

/**
 * Template Meta (Fase 4, docs/KONTRAK-API-TEMPLATE.md). Lihat = `inbox.reply` (agen memilih template);
 * kelola = `templates.manage` (Owner/Admin/Supervisor). Semua panggilan Meta lewat klien Graph terpusat
 * (kelompok laju `management`). Galat Meta → pesan Indonesia (`templateMetaError`). Diaudit tanpa isi
 * template (nama, bahasa, kategori, status saja).
 */

const NOT_FOUND = 'Template tidak ditemukan.';

type SyncResult = z.infer<typeof syncTemplatesResponseSchema>['channels'][number];

export interface TemplatesService {
  list(
    organizationId: string,
    query: { channelId?: string; status?: TemplateStatus; category?: TemplateCategory; q?: string },
  ): Promise<MessageTemplate[]>;
  get(organizationId: string, id: string): Promise<MessageTemplate>;
  create(
    auth: AuthContext,
    input: z.infer<typeof createTemplateRequestSchema>,
    client: ClientInfo,
    origin?: { presetKey: string },
  ): Promise<MessageTemplate>;
  update(
    auth: AuthContext,
    id: string,
    input: z.infer<typeof updateTemplateRequestSchema>,
    client: ClientInfo,
  ): Promise<MessageTemplate>;
  submit(auth: AuthContext, id: string, client: ClientInfo): Promise<MessageTemplate>;
  remove(auth: AuthContext, id: string, client: ClientInfo): Promise<void>;
  sync(auth: AuthContext, channelId: string | undefined, client: ClientInfo): Promise<SyncResult[]>;
  createFromPreset(
    auth: AuthContext,
    presetKey: string,
    input: { channelId: string; name?: string | undefined; language?: string | undefined },
    client: ClientInfo,
  ): Promise<MessageTemplate>;
}

export function toTemplate(row: MessageTemplateRow): MessageTemplate {
  const content = templateContentSchema.safeParse(row.content);
  return {
    id: row.id,
    channelId: row.channelId,
    wabaId: row.wabaId,
    metaTemplateId: row.metaTemplateId,
    name: row.name,
    language: row.language,
    category: row.category as TemplateCategory,
    status: row.status as TemplateStatus,
    rejectedReason: row.rejectedReason,
    qualityScore: (row.qualityScore as MessageTemplate['qualityScore']) ?? null,
    content: content.success ? content.data : templateContentSchema.parse({ body: { text: '' } }),
    source: row.source as MessageTemplate['source'],
    presetKey: row.presetKey,
    localChanges: row.localChanges,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Galat Meta saat mengelola template → AppError dengan pesan Indonesia (tanpa teks mentah Meta). */
export function templateMetaError(error: unknown): AppError {
  if (!isMetaApiError(error))
    return error instanceof AppError ? error : new AppError('META_REQUEST_FAILED');
  const specific =
    error.metaSubcode !== null ? TEMPLATE_META_ERROR_MESSAGES[error.metaSubcode] : undefined;
  const message =
    specific ?? (error.kind === 'invalid_parameter' ? TEMPLATE_META_REJECTED : error.message);
  return new AppError(
    error.kind === 'invalid_parameter' ? 'VALIDATION_ERROR' : 'META_REQUEST_FAILED',
    {
      message,
      cause: error,
      ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    },
  );
}

export function createTemplatesService(deps: {
  db: Database;
  secretBox: SecretBox | null;
  meta: MetaGraphClient;
  now?: () => Date;
}): TemplatesService {
  const { db, meta } = deps;
  const now = deps.now ?? (() => new Date());

  async function row(organizationId: string, id: string): Promise<MessageTemplateRow> {
    const [found] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.organizationId, organizationId), eq(messageTemplates.id, id)))
      .limit(1);
    if (!found) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
    return found;
  }

  async function liveChannel(organizationId: string, channelId: string): Promise<Channel> {
    const [channel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    if (!channel || channel.type !== 'whatsapp' || !channel.waBusinessAccountId) {
      throw new AppError('NOT_FOUND', { message: 'Nomor WhatsApp tidak ditemukan.' });
    }
    return channel;
  }

  function credentialsOf(channel: Channel) {
    if (!deps.secretBox) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: 'Kredensial channel tidak bisa dibuka di server. Hubungi admin server.',
      });
    }
    return openWhatsAppCredentials(deps.secretBox, channel);
  }

  async function audit(
    auth: AuthContext,
    action: AuditAction,
    template: Pick<MessageTemplateRow, 'id' | 'name' | 'language' | 'category' | 'status'>,
    client: ClientInfo,
    extra: Record<string, string | number | boolean> = {},
  ) {
    await recordAudit(db, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action,
      targetType: 'template',
      targetId: template.id,
      metadata: {
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        ...extra,
      },
      client,
    });
  }

  async function syncChannel(channel: Channel): Promise<SyncResult> {
    const base = { channelId: channel.id, created: 0, updated: 0, removed: 0 };
    try {
      const credentials = credentialsOf(channel);
      const wabaId = channel.waBusinessAccountId ?? '';
      const { templates } = await listMessageTemplates(meta, credentials, wabaId);
      const counts = await db.transaction((tx) =>
        upsertSyncedTemplates(tx, {
          organizationId: channel.organizationId,
          channelId: channel.id,
          wabaId,
          templates: templates.map(metaTemplateToSynced),
          now: now(),
        }),
      );
      return { ...base, ...counts, ok: true, error: null };
    } catch (error) {
      return { ...base, ok: false, error: templateMetaError(error).message };
    }
  }

  const service: TemplatesService = {
    async list(organizationId, query) {
      const conditions: SQL[] = [eq(messageTemplates.organizationId, organizationId)];
      if (query.channelId) conditions.push(eq(messageTemplates.channelId, query.channelId));
      if (query.status) conditions.push(eq(messageTemplates.status, query.status));
      else conditions.push(ne(messageTemplates.status, 'DELETED'));
      if (query.category) conditions.push(eq(messageTemplates.category, query.category));
      if (query.q) conditions.push(ilike(messageTemplates.name, likePattern(query.q)));
      const rows = await db
        .select()
        .from(messageTemplates)
        .where(and(...conditions))
        .orderBy(asc(messageTemplates.name), asc(messageTemplates.language))
        .limit(500);
      return rows.map(toTemplate);
    },

    async get(organizationId, id) {
      return toTemplate(await row(organizationId, id));
    },

    async create(auth, input, client, origin) {
      const channel = await liveChannel(auth.organizationId, input.channelId);
      let created: MessageTemplateRow | undefined;
      try {
        created = await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'templates.manage');
          const [inserted] = await tx
            .insert(messageTemplates)
            .values({
              organizationId: auth.organizationId,
              channelId: channel.id,
              wabaId: channel.waBusinessAccountId ?? '',
              name: input.name,
              language: input.language,
              category: input.category,
              status: 'DRAFT',
              content: input.content,
              source: origin ? 'preset' : 'balesin',
              presetKey: origin?.presetKey ?? null,
              createdByUserId: auth.user.id,
            })
            .returning();
          return inserted;
        });
      } catch (error) {
        if (
          isPgError(
            error,
            PG_ERROR_CODES.uniqueViolation,
            'message_templates_channel_name_language_unique',
          )
        ) {
          throw new AppError('CONFLICT', {
            message: 'Template dengan nama dan bahasa ini sudah ada di nomor ini. Pakai nama lain.',
          });
        }
        throw error;
      }
      if (!created) throw new Error('Template tidak tersimpan');
      await audit(auth, AUDIT_ACTIONS.templateCreated, created, client, {
        ...(origin ? { presetKey: origin.presetKey } : {}),
      });
      return toTemplate(created);
    },

    async update(auth, id, input, client) {
      const current = await row(auth.organizationId, id);
      if (
        current.status === 'PENDING' ||
        current.status === 'PENDING_DELETION' ||
        current.status === 'DELETED'
      ) {
        throw new AppError('CONFLICT', {
          message: 'Template sedang ditinjau/dihapus Meta, jadi belum bisa diubah.',
        });
      }
      const submitted = current.metaTemplateId !== null;
      if (
        submitted &&
        ((input.name !== undefined && input.name !== current.name) ||
          (input.language !== undefined && input.language !== current.language))
      ) {
        throw new AppError('CONFLICT', {
          message:
            'Nama dan bahasa template tidak bisa diubah setelah diajukan ke Meta. Buat template baru.',
        });
      }
      if (
        input.category !== undefined &&
        input.category !== current.category &&
        current.status === 'APPROVED'
      ) {
        throw new AppError('CONFLICT', {
          message: 'Kategori template yang sudah disetujui tidak bisa diubah dari aplikasi ini.',
        });
      }
      let updated: MessageTemplateRow | undefined;
      try {
        updated = await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'templates.manage');
          const [next] = await tx
            .update(messageTemplates)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.language !== undefined ? { language: input.language } : {}),
              ...(input.category !== undefined ? { category: input.category } : {}),
              ...(input.content !== undefined ? { content: input.content } : {}),
              localChanges: current.status !== 'DRAFT',
            })
            .where(
              and(
                eq(messageTemplates.organizationId, auth.organizationId),
                eq(messageTemplates.id, id),
              ),
            )
            .returning();
          return next;
        });
      } catch (error) {
        if (
          isPgError(
            error,
            PG_ERROR_CODES.uniqueViolation,
            'message_templates_channel_name_language_unique',
          )
        ) {
          throw new AppError('CONFLICT', {
            message: 'Template dengan nama dan bahasa ini sudah ada di nomor ini. Pakai nama lain.',
          });
        }
        throw error;
      }
      if (!updated) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
      await audit(auth, AUDIT_ACTIONS.templateUpdated, updated, client);
      return toTemplate(updated);
    },

    async submit(auth, id, client) {
      const current = await row(auth.organizationId, id);
      if (!['DRAFT', 'REJECTED', 'APPROVED', 'PAUSED'].includes(current.status)) {
        throw new AppError('CONFLICT', {
          message: 'Template dengan status ini tidak bisa diajukan sekarang.',
        });
      }
      if (
        current.metaTemplateId !== null &&
        !current.localChanges &&
        current.status !== 'REJECTED'
      ) {
        throw new AppError('CONFLICT', { message: 'Tidak ada perubahan yang perlu diajukan.' });
      }
      const content = templateContentSchema.parse(current.content);
      const category = current.category as TemplateCategory;
      const issues = validateTemplate(category, content);
      if (issues.length > 0) {
        throw new AppError('VALIDATION_ERROR', {
          message: issues[0]?.message ?? 'Template belum sesuai aturan Meta.',
          details: issues.map((issue) => ({
            location: 'body',
            field: issue.field,
            message: issue.message,
          })),
        });
      }
      if (content.header && content.header.format !== 'TEXT') {
        throw new AppError('VALIDATION_ERROR', {
          message:
            'Template dengan judul gambar/video/dokumen belum bisa diajukan dari aplikasi ini. Buat di WhatsApp Manager, lalu sinkron.',
        });
      }
      const channel = await liveChannel(auth.organizationId, current.channelId);
      const credentials = credentialsOf(channel);
      const components = toMetaComponents(category, content);
      const at = now();
      let patch: Partial<typeof messageTemplates.$inferInsert>;
      try {
        if (current.metaTemplateId === null) {
          const result = await createMessageTemplate(meta, credentials, current.wabaId, {
            name: current.name,
            language: current.language,
            category,
            components,
            named: content.parameterFormat === 'named',
          });
          patch = {
            metaTemplateId: result.id,
            status: ['PENDING', 'APPROVED', 'REJECTED'].includes(result.status.toUpperCase())
              ? result.status.toUpperCase()
              : 'PENDING',
            ...(result.category ? { category: result.category.toUpperCase() } : {}),
          };
        } else {
          await editMessageTemplate(meta, credentials, current.metaTemplateId, {
            components,
            ...(current.status !== 'APPROVED' ? { category } : {}),
          });
          patch = { status: 'PENDING' };
        }
      } catch (error) {
        throw templateMetaError(error);
      }
      const [updated] = await db
        .update(messageTemplates)
        .set({
          ...patch,
          rejectedReason: null,
          localChanges: false,
          submittedAt: at,
          statusUpdatedAt: at,
          metaComponents: components,
        })
        .where(
          and(
            eq(messageTemplates.organizationId, auth.organizationId),
            eq(messageTemplates.id, id),
          ),
        )
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
      await audit(auth, AUDIT_ACTIONS.templateSubmitted, updated, client, {
        edit: current.metaTemplateId !== null,
      });
      return toTemplate(updated);
    },

    async remove(auth, id, client) {
      const current = await row(auth.organizationId, id);
      if (current.metaTemplateId !== null && current.status !== 'DELETED') {
        const channel = await liveChannel(auth.organizationId, current.channelId);
        try {
          await deleteMessageTemplate(meta, credentialsOf(channel), current.wabaId, {
            name: current.name,
            metaTemplateId: current.metaTemplateId,
          });
        } catch (error) {
          // Sudah tidak ada di Meta = boleh dihapus lokal.
          if (!(isMetaApiError(error) && error.kind === 'not_found'))
            throw templateMetaError(error);
        }
      }
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'templates.manage');
        await tx
          .delete(messageTemplates)
          .where(
            and(
              eq(messageTemplates.organizationId, auth.organizationId),
              eq(messageTemplates.id, id),
            ),
          );
      });
      await audit(auth, AUDIT_ACTIONS.templateDeleted, current, client);
    },

    async sync(auth, channelId, client) {
      const targets = channelId
        ? [await liveChannel(auth.organizationId, channelId)]
        : await db
            .select()
            .from(channels)
            .where(
              and(
                eq(channels.organizationId, auth.organizationId),
                eq(channels.type, 'whatsapp'),
                eq(channels.enabled, true),
                isNull(channels.deletedAt),
              ),
            );
      const results: SyncResult[] = [];
      for (const channel of targets) results.push(await syncChannel(channel));
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.templatesSynced,
        targetType: 'organization',
        targetId: auth.organizationId,
        metadata: {
          channels: results.length,
          failed: results.filter((result) => !result.ok).length,
          created: results.reduce((sum, result) => sum + result.created, 0),
          updated: results.reduce((sum, result) => sum + result.updated, 0),
        },
        client,
      });
      return results;
    },

    async createFromPreset(auth, presetKey, input, client) {
      const preset = findTemplatePreset(presetKey);
      if (!preset) throw new AppError('NOT_FOUND', { message: 'Preset template tidak ditemukan.' });
      return service.create(
        auth,
        {
          channelId: input.channelId,
          name: input.name ?? preset.name,
          language: input.language ?? preset.language,
          category: preset.category,
          content: templateContentSchema.parse(preset.content),
        },
        client,
        { presetKey: preset.key },
      );
    },
  };
  return service;
}
