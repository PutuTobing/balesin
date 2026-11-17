import { AppError, cleanFileName } from '@balesin/core';
import {
  auditLogs,
  broadcastCampaigns,
  broadcastRecipients,
  channels,
  contactTags,
  contacts,
  loadBroadcastSettings,
  lockAdvisoryKeys,
  messageTemplates,
  messages,
  organizations,
  recordAlarm,
  tags,
  users,
  type BroadcastCampaignRow,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  BROADCAST_LIMITS,
  BROADCAST_SKIP_REASONS,
  EMPTY_BROADCAST_MAPPING,
  broadcastMappingSchema,
  broadcastRateFor,
  broadcastRequiredVariables,
  fillTemplateText,
  outboundFailureMessage,
  outboundFailureReasonSchema,
  permissionScope,
  renderBroadcastParameters,
  templateContentSchema,
  templateVariables,
  whatsAppNumberSummarySchema,
  type BroadcastCampaign,
  type BroadcastEstimate,
  type BroadcastImportReport,
  type BroadcastListResponse,
  type BroadcastPauseReason,
  type BroadcastPreviewResponse,
  type BroadcastRecipient,
  type BroadcastReport,
  type BroadcastSettingsValues,
  type BroadcastSkipReason,
  type BroadcastSourceKind,
  type BroadcastStatus,
  type BroadcastWaitReason,
  type CreateBroadcastRequest,
  type IdentityConfirmation,
  type TemplateCategory,
  type TemplateContent,
  type UpdateBroadcastRequest,
} from '@balesin/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import type { BroadcastSettingsService } from './broadcast-settings.service';
import { ImportBusyError, parseRecipientsIsolated } from './import-runner';
import {
  ImportError,
  buildRecipients,
  type ImportResult,
  type ParsedTable,
} from './recipient-import';

/**
 * Kampanye broadcast (Fase 4, docs/KONTRAK-API-BROADCAST.md). Semua query terfilter
 * `organization_id`; ubah data = transaksi dengan cek ulang pelaku (`assertActorStillAuthorized`).
 * Aksi yang memulai pengiriman massal (ajukan, setujui, lanjutkan) = konfirmasi identitas. Log/audit
 * tanpa nomor/isi; pengiriman dilakukan worker antrian `broadcast`.
 */

export interface BroadcastsServiceDeps {
  db: Database;
  settings: Pick<BroadcastSettingsService, 'fetchConnector'>;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}

export interface BroadcastContext extends TwoFactorContext {
  client: ClientInfo;
}

const NOT_FOUND = 'Broadcast tidak ditemukan.';
const notFound = () => new AppError('NOT_FOUND', { message: NOT_FOUND });
const conflict = (message: string) => new AppError('CONFLICT', { message });
const BLOCKED_QUALITY = new Set(['RED']);
const BLOCKED_NUMBER_STATUS = new Set(['FLAGGED', 'RESTRICTED', 'BANNED', 'DISCONNECTED']);
const CHUNK = 500;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function encodeCursor(parts: string[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | undefined): string[] | null {
  if (!cursor) return null;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  } catch {
    return null;
  }
}

/** Sel CSV aman untuk spreadsheet (cegah injeksi rumus `=`, `+`, `-`, `@`). */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface UsableTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  content: TemplateContent;
}

export function createBroadcastsService(deps: BroadcastsServiceDeps) {
  const { db, twoFactor, accessDenied } = deps;
  const now = deps.now ?? (() => new Date());

  async function liveChannel(executor: DbExecutor, organizationId: string, channelId: string) {
    const [channel] = await executor
      .select()
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId)))
      .limit(1);
    if (!channel || channel.type !== 'whatsapp' || channel.deletedAt !== null) {
      throw new AppError('NOT_FOUND', { message: 'Nomor WhatsApp pengirim tidak ditemukan.' });
    }
    if (!channel.enabled) {
      throw conflict(
        'Nomor WhatsApp pengirim sedang dinonaktifkan. Aktifkan lagi di Pengaturan → Channel.',
      );
    }
    return channel;
  }

  async function usableTemplate(
    executor: DbExecutor,
    organizationId: string,
    channel: { waBusinessAccountId: string | null },
    templateId: string,
  ): Promise<UsableTemplate> {
    const [template] = await executor
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.organizationId, organizationId),
          eq(messageTemplates.id, templateId),
        ),
      )
      .limit(1);
    if (!template) throw new AppError('NOT_FOUND', { message: 'Template tidak ditemukan.' });
    if (template.wabaId !== channel.waBusinessAccountId) {
      throw conflict('Template ini milik akun WhatsApp lain. Pilih template dari nomor pengirim.');
    }
    if (template.status !== 'APPROVED') {
      throw conflict('Template ini belum disetujui Meta (atau sedang dijeda/dinonaktifkan).');
    }
    if (template.category === 'AUTHENTICATION') {
      throw conflict('Template kode verifikasi (OTP) tidak bisa dipakai untuk broadcast.');
    }
    const content = templateContentSchema.safeParse(template.content);
    if (!content.success) throw conflict('Isi template rusak. Sinkron ulang template dari Meta.');
    if (content.data.header && content.data.header.format !== 'TEXT') {
      throw conflict(
        'Template dengan judul gambar/video/dokumen belum bisa dipakai untuk broadcast. Pilih template berjudul teks atau tanpa judul.',
      );
    }
    return {
      id: template.id,
      name: template.name,
      category: template.category as TemplateCategory,
      content: content.data,
    };
  }

  async function campaignRow(
    executor: DbExecutor,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<BroadcastCampaignRow> {
    const query = executor
      .select()
      .from(broadcastCampaigns)
      .where(
        and(eq(broadcastCampaigns.organizationId, organizationId), eq(broadcastCampaigns.id, id)),
      )
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  async function view(executor: DbExecutor, row: BroadcastCampaignRow): Promise<BroadcastCampaign> {
    const org = row.organizationId;
    const [channel] = await executor
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(and(eq(channels.organizationId, org), eq(channels.id, row.channelId)));
    const [template] = await executor
      .select({
        id: messageTemplates.id,
        name: messageTemplates.name,
        language: messageTemplates.language,
        category: messageTemplates.category,
        status: messageTemplates.status,
      })
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.organizationId, org), eq(messageTemplates.id, row.templateId)),
      );
    const [tag] = row.autoTagId
      ? await executor
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .where(and(eq(tags.organizationId, org), eq(tags.id, row.autoTagId)))
      : [];
    const statusCounts = await executor
      .select({ status: broadcastRecipients.status, total: count() })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.organizationId, org),
          eq(broadcastRecipients.campaignId, row.id),
        ),
      )
      .groupBy(broadcastRecipients.status);
    const tally = (status: string) =>
      Number(statusCounts.find((entry) => entry.status === status)?.total ?? 0);
    const people = [row.createdByUserId, row.approvalDecidedByUserId, row.pausedByUserId].filter(
      (value): value is string => value !== null,
    );
    const names = people.length
      ? await executor
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(eq(users.organizationId, org), inArray(users.id, people)))
      : [];
    const person = (id: string | null) => {
      const found = id ? names.find((entry) => entry.id === id) : undefined;
      return found ? { id: found.id, name: found.name } : null;
    };
    const settings = await loadBroadcastSettings(executor, org);
    const mapping = broadcastMappingSchema.safeParse(row.mapping);
    return {
      id: row.id,
      name: row.name,
      status: row.status as BroadcastStatus,
      channel: { id: row.channelId, name: channel?.name ?? 'Channel dihapus' },
      template: template
        ? {
            ...template,
            category: template.category as TemplateCategory,
          }
        : null,
      source:
        row.sourceKind && row.sourceLabel && row.sourceImportedAt
          ? {
              kind: row.sourceKind as BroadcastSourceKind,
              label: row.sourceLabel,
              importedAt: row.sourceImportedAt.toISOString(),
            }
          : null,
      columns: row.columns,
      phoneColumn: row.phoneColumn,
      mapping: mapping.success ? mapping.data : EMPTY_BROADCAST_MAPPING,
      scheduledAt: iso(row.scheduledAt),
      ratePerSecond: row.ratePerSecond,
      dedupe: {
        hours: row.dedupeHours,
        scope: row.dedupeScope === 'any' ? 'any' : 'template',
      },
      autoTag: tag ? { id: tag.id, name: tag.name, color: tag.color as never } : null,
      counts: {
        sourceRows: row.sourceRows,
        rejectedRows: row.rejectedRows,
        recipients: statusCounts.reduce((sum, entry) => sum + Number(entry.total), 0),
        pending: tally('pending'),
        queued: tally('queued'),
        skipped: tally('skipped'),
        cancelled: tally('cancelled'),
      },
      approval: {
        required: row.approvalRequired,
        threshold: row.approvalThreshold ?? settings.approvalThreshold,
        requestedAt: iso(row.approvalRequestedAt),
        decidedAt: iso(row.approvalDecidedAt),
        decidedBy: person(row.approvalDecidedByUserId),
        rejectionReason: row.rejectionReason,
      },
      estimate: row.estimate ?? null,
      pause:
        row.pausedReason && row.pausedAt
          ? {
              reason: row.pausedReason as BroadcastPauseReason,
              at: row.pausedAt.toISOString(),
              by: person(row.pausedByUserId),
              requiresAdmin: row.pausedReason !== 'manual',
            }
          : null,
      waiting:
        row.waitingReason && row.waitingUntil
          ? {
              reason: row.waitingReason as BroadcastWaitReason,
              until: row.waitingUntil.toISOString(),
            }
          : null,
      createdBy: person(row.createdByUserId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      cancelledAt: iso(row.cancelledAt),
    };
  }

  function requireDraft(row: BroadcastCampaignRow) {
    if (row.status !== 'draft') {
      throw conflict('Broadcast ini sudah diajukan. Hanya draf yang bisa diubah.');
    }
  }

  async function audit(
    executor: DbExecutor,
    auth: AuthContext,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    campaign: { id: string; name: string },
    client: ClientInfo,
    metadata: Record<string, unknown> = {},
  ) {
    await recordAudit(executor, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action,
      targetType: 'broadcast',
      targetId: campaign.id,
      metadata: { name: campaign.name, ...metadata },
      client,
    });
  }

  async function replaceRecipients(
    auth: AuthContext,
    id: string,
    source: { kind: 'upload' | 'segment' | 'connector'; label: string },
    table: ParsedTable,
    phoneColumn: string,
    result: ImportResult,
    client: ClientInfo,
  ): Promise<{ broadcast: BroadcastCampaign; report: BroadcastImportReport }> {
    if (result.recipients.length === 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Tidak ada nomor yang valid. Periksa kolom nomor lalu coba lagi.',
      });
    }
    const broadcast = await db.transaction(async (tx) => {
      await assertActorStillAuthorized(tx, auth, 'broadcast.send');
      const row = await campaignRow(tx, auth.organizationId, id, true);
      requireDraft(row);
      await tx
        .delete(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.organizationId, auth.organizationId),
            eq(broadcastRecipients.campaignId, row.id),
          ),
        );
      for (let start = 0; start < result.recipients.length; start += CHUNK) {
        await tx.insert(broadcastRecipients).values(
          result.recipients.slice(start, start + CHUNK).map((recipient) => ({
            organizationId: auth.organizationId,
            campaignId: row.id,
            rowNumber: recipient.row,
            phone: recipient.phone,
            data: recipient.data,
          })),
        );
      }
      const [updated] = await tx
        .update(broadcastCampaigns)
        .set({
          sourceKind: source.kind,
          sourceLabel: source.label.slice(0, 200),
          sourceImportedAt: now(),
          columns: table.columns,
          phoneColumn,
          sourceRows: result.sourceRows,
          rejectedRows: result.sourceRows - result.recipients.length,
          estimate: null,
        })
        .where(eq(broadcastCampaigns.id, row.id))
        .returning();
      if (!updated) throw notFound();
      await audit(tx, auth, AUDIT_ACTIONS.broadcastRecipientsImported, updated, client, {
        source: source.kind,
        recipients: result.recipients.length,
        rejectedRows: updated.rejectedRows,
      });
      return view(tx, updated);
    });
    return {
      broadcast,
      report: {
        sourceRows: result.sourceRows,
        recipients: result.recipients.length,
        rejectedRows: result.sourceRows - result.recipients.length,
        issues: result.issues,
        issueCounts: result.issueCounts,
        columns: table.columns,
        phoneColumn,
      },
    };
  }

  function importFailure(error: unknown): never {
    if (error instanceof ImportError) {
      throw new AppError('VALIDATION_ERROR', {
        message: error.message,
        details: [{ location: 'body', field: 'file', message: error.message }],
      });
    }
    throw error;
  }

  async function pendingRecipients(
    executor: DbExecutor,
    organizationId: string,
    campaignId: string,
  ) {
    return executor
      .select({
        id: broadcastRecipients.id,
        row: broadcastRecipients.rowNumber,
        phone: broadcastRecipients.phone,
        data: broadcastRecipients.data,
      })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.organizationId, organizationId),
          eq(broadcastRecipients.campaignId, campaignId),
          eq(broadcastRecipients.status, 'pending'),
        ),
      )
      .orderBy(asc(broadcastRecipients.rowNumber));
  }

  /** Pemetaan wajib lengkap & kolomnya ada di data penerima. */
  function assertMapping(row: BroadcastCampaignRow, content: TemplateContent) {
    const parsed = broadcastMappingSchema.safeParse(row.mapping);
    const mapping = parsed.success ? parsed.data : EMPTY_BROADCAST_MAPPING;
    const required = broadcastRequiredVariables(content);
    const problems: string[] = [];
    const check = (source: { kind: string; column?: string } | null | undefined, key: string) => {
      if (!source) problems.push(key);
      else if (source.kind === 'column' && !row.columns.includes(source.column ?? '')) {
        problems.push(key);
      }
    };
    for (const name of required.body) check(mapping.body[name], `body.${name}`);
    if (required.header) check(mapping.header, 'header');
    for (const index of required.buttons) check(mapping.buttons[index], `buttons.${index}`);
    if (problems.length > 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Lengkapi pemetaan variabel template ke kolom data penerima.',
        details: problems.map((field) => ({
          location: 'body' as const,
          field: `mapping.${field}`,
          message: 'Belum dipetakan atau kolomnya tidak ada.',
        })),
      });
    }
    return mapping;
  }

  async function estimateFor(
    executor: DbExecutor,
    row: BroadcastCampaignRow,
    category: TemplateCategory,
    settings: BroadcastSettingsValues,
  ): Promise<BroadcastEstimate> {
    // Template UTILITY ke pelanggan yang jendela layanannya masih terbuka = gratis (aturan Meta).
    const rows = await executor.execute<{ phone: string; open: boolean }>(sql`
      select r.phone,
        exists (
          select 1 from contacts c
          join conversations v on v.organization_id = c.organization_id and v.contact_id = c.id
          where c.organization_id = r.organization_id and c.channel_type = 'whatsapp'
            and c.phone = r.phone and v.channel_id = ${row.channelId}
            and v.window_expires_at > now()
        ) as open
      from broadcast_recipients r
      where r.organization_id = ${row.organizationId} and r.campaign_id = ${row.id}
        and r.status = 'pending'`);
    let billable = 0;
    let free = 0;
    let unknownRate = 0;
    let total = 0;
    for (const recipient of rows.rows) {
      if (category === 'UTILITY' && recipient.open) {
        free += 1;
        continue;
      }
      const rate = broadcastRateFor(settings.rates, recipient.phone, category);
      if (rate === null) {
        unknownRate += 1;
        continue;
      }
      billable += 1;
      total += rate;
    }
    return {
      currency: settings.rates.currency,
      category,
      recipients: rows.rows.length,
      billable,
      free,
      unknownRate,
      total: Math.round(total),
      rateSource: settings.rates.source,
      computedAt: now().toISOString(),
    };
  }

  async function grantsResume(executor: DbExecutor, auth: AuthContext): Promise<boolean> {
    const [user] = await executor
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.organizationId, auth.organizationId), eq(users.id, auth.user.id)));
    return user ? permissionScope(user.role, 'sending.resume') !== null : false;
  }

  return {
    async list(
      organizationId: string,
      query: { status?: BroadcastStatus; cursor?: string; limit: number },
    ): Promise<BroadcastListResponse> {
      const cursor = decodeCursor(query.cursor);
      const cursorDate = cursor?.[0] ? new Date(cursor[0]) : null;
      const rows = await db
        .select()
        .from(broadcastCampaigns)
        .where(
          and(
            eq(broadcastCampaigns.organizationId, organizationId),
            query.status ? eq(broadcastCampaigns.status, query.status) : undefined,
            cursorDate && !Number.isNaN(cursorDate.getTime()) && cursor?.[1]
              ? or(
                  lt(broadcastCampaigns.createdAt, cursorDate),
                  and(
                    eq(broadcastCampaigns.createdAt, cursorDate),
                    lt(broadcastCampaigns.id, cursor[1]),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(broadcastCampaigns.createdAt), desc(broadcastCampaigns.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        broadcasts: await Promise.all(page.map((row) => view(db, row))),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      };
    },

    async get(organizationId: string, id: string): Promise<BroadcastCampaign> {
      return view(db, await campaignRow(db, organizationId, id));
    },

    async create(auth: AuthContext, input: CreateBroadcastRequest, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const channel = await liveChannel(tx, auth.organizationId, input.channelId);
        await usableTemplate(tx, auth.organizationId, channel, input.templateId);
        const settings = await loadBroadcastSettings(tx, auth.organizationId);
        const [row] = await tx
          .insert(broadcastCampaigns)
          .values({
            organizationId: auth.organizationId,
            name: input.name,
            channelId: channel.id,
            templateId: input.templateId,
            ratePerSecond: Math.min(
              BROADCAST_LIMITS.ratePerSecond.default,
              settings.maxRatePerSecond,
            ),
            dedupeHours: BROADCAST_LIMITS.dedupeHours.default,
            dedupeScope: 'template',
            createdByUserId: auth.user.id,
          })
          .returning();
        if (!row) throw new Error('INSERT broadcast tidak mengembalikan baris');
        await audit(tx, auth, AUDIT_ACTIONS.broadcastCreated, row, client, {
          channelId: channel.id,
          templateId: input.templateId,
        });
        return view(tx, row);
      });
    },

    async update(auth: AuthContext, id: string, input: UpdateBroadcastRequest, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        requireDraft(row);
        const changes: Partial<typeof broadcastCampaigns.$inferInsert> = {};
        const fields: string[] = [];
        if (input.name !== undefined) {
          changes.name = input.name;
          fields.push('name');
        }
        if (input.templateId !== undefined && input.templateId !== row.templateId) {
          const channel = await liveChannel(tx, auth.organizationId, row.channelId);
          await usableTemplate(tx, auth.organizationId, channel, input.templateId);
          changes.templateId = input.templateId;
          changes.mapping = EMPTY_BROADCAST_MAPPING;
          fields.push('templateId');
        }
        if (input.mapping !== undefined) {
          changes.mapping = input.mapping;
          fields.push('mapping');
        }
        if (input.scheduledAt !== undefined) {
          if (input.scheduledAt !== null) {
            const at = new Date(input.scheduledAt);
            const max = now().getTime() + 30 * 24 * 60 * 60 * 1000;
            if (at.getTime() <= now().getTime() || at.getTime() > max) {
              throw new AppError('VALIDATION_ERROR', {
                message: 'Jadwal harus di masa depan dan paling lambat 30 hari lagi.',
                details: [
                  { location: 'body', field: 'scheduledAt', message: 'Jadwal tidak valid.' },
                ],
              });
            }
            changes.scheduledAt = at;
          } else {
            changes.scheduledAt = null;
          }
          fields.push('scheduledAt');
        }
        if (input.ratePerSecond !== undefined) {
          const settings = await loadBroadcastSettings(tx, auth.organizationId);
          if (input.ratePerSecond > settings.maxRatePerSecond) {
            throw new AppError('VALIDATION_ERROR', {
              message: `Kecepatan maksimal yang diizinkan organisasi ${String(settings.maxRatePerSecond)} pesan/detik.`,
              details: [
                { location: 'body', field: 'ratePerSecond', message: 'Melebihi batas organisasi.' },
              ],
            });
          }
          changes.ratePerSecond = input.ratePerSecond;
          fields.push('ratePerSecond');
        }
        if (input.dedupe !== undefined) {
          changes.dedupeHours = input.dedupe.hours;
          changes.dedupeScope = input.dedupe.scope;
          fields.push('dedupe');
        }
        if (input.autoTagId !== undefined) {
          if (input.autoTagId !== null) {
            const [tag] = await tx
              .select({ id: tags.id })
              .from(tags)
              .where(
                and(eq(tags.organizationId, auth.organizationId), eq(tags.id, input.autoTagId)),
              );
            if (!tag) throw new AppError('NOT_FOUND', { message: 'Tag tidak ditemukan.' });
          }
          changes.autoTagId = input.autoTagId;
          fields.push('autoTagId');
        }
        if (fields.length === 0) return view(tx, row);
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({ ...changes, estimate: null })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastUpdated, updated, client, {
          changedFields: fields,
        });
        return view(tx, updated);
      });
    },

    async remove(auth: AuthContext, id: string, client: ClientInfo) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status !== 'draft') {
          throw conflict(
            'Hanya draf yang bisa dihapus. Broadcast yang sudah diajukan bisa dibatalkan.',
          );
        }
        await tx.delete(broadcastCampaigns).where(eq(broadcastCampaigns.id, row.id));
        await audit(tx, auth, AUDIT_ACTIONS.broadcastDeleted, row, client);
      });
    },

    async importUpload(
      auth: AuthContext,
      id: string,
      file: { buffer: Buffer; filename: string | null },
      phoneColumn: string | undefined,
      client: ClientInfo,
    ) {
      await campaignRow(db, auth.organizationId, id).then(requireDraft);
      // Parsing di `worker_threads` (batas waktu + memori, review T1): event loop api tidak terblokir.
      let parsed: Awaited<ReturnType<typeof parseRecipientsIsolated>>;
      try {
        parsed = await parseRecipientsIsolated(auth.user.id, file.buffer, phoneColumn);
      } catch (error) {
        if (error instanceof ImportBusyError) {
          throw new AppError('RATE_LIMITED', {
            message: 'Impor lain sedang diproses. Tunggu sebentar lalu coba lagi.',
            retryAfterSeconds: 5,
          });
        }
        importFailure(error);
      }
      const { table, phoneColumn: column, result } = parsed;
      return replaceRecipients(
        auth,
        id,
        { kind: 'upload', label: cleanFileName(file.filename) ?? 'Berkas unggahan' },
        table,
        column,
        result,
        client,
      );
    },

    async importSegment(
      auth: AuthContext,
      id: string,
      input: {
        tagIds: string[];
        tagMatch: 'any' | 'all';
        attributes: { key: string; value: string }[];
      },
      client: ClientInfo,
    ) {
      await campaignRow(db, auth.organizationId, id).then(requireDraft);
      const tagIds = [...new Set(input.tagIds)];
      const tagRows = tagIds.length
        ? await db
            .select({ id: tags.id, name: tags.name })
            .from(tags)
            .where(and(eq(tags.organizationId, auth.organizationId), inArray(tags.id, tagIds)))
        : [];
      if (tagRows.length !== tagIds.length) {
        throw new AppError('VALIDATION_ERROR', { message: 'Ada tag yang tidak ditemukan.' });
      }
      const tagList = sql.join(
        tagIds.map((tagId) => sql`${tagId}::uuid`),
        sql`, `,
      );
      const rows = await db
        .select({
          phone: contacts.phone,
          name: contacts.name,
          profileName: contacts.profileName,
          attributes: contacts.attributes,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, auth.organizationId),
            eq(contacts.channelType, 'whatsapp'),
            isNotNull(contacts.phone),
            tagIds.length === 0
              ? undefined
              : input.tagMatch === 'any'
                ? sql`exists (select 1 from ${contactTags} ct where ct.organization_id = ${contacts.organizationId} and ct.contact_id = ${contacts.id} and ct.tag_id in (${tagList}))`
                : sql`(select count(distinct ct.tag_id) from ${contactTags} ct where ct.organization_id = ${contacts.organizationId} and ct.contact_id = ${contacts.id} and ct.tag_id in (${tagList})) = ${tagIds.length}`,
            ...input.attributes.map(
              (attribute) => sql`${contacts.attributes} @> ${JSON.stringify([attribute])}::jsonb`,
            ),
          ),
        )
        .orderBy(asc(contacts.createdAt), asc(contacts.id))
        .limit(BROADCAST_LIMITS.maxRecipients + 1);
      if (rows.length > BROADCAST_LIMITS.maxRecipients) {
        throw new AppError('VALIDATION_ERROR', {
          message: `Segmen melebihi ${BROADCAST_LIMITS.maxRecipients.toLocaleString('id-ID')} kontak. Persempit saringannya.`,
        });
      }
      const attributeKeys: string[] = [];
      for (const row of rows) {
        for (const attribute of row.attributes) {
          if (
            !attributeKeys.includes(attribute.key) &&
            attributeKeys.length < BROADCAST_LIMITS.maxColumns - 2 &&
            attribute.key !== 'nomor' &&
            attribute.key !== 'nama'
          ) {
            attributeKeys.push(attribute.key.slice(0, BROADCAST_LIMITS.maxColumnNameLength));
          }
        }
      }
      const table: ParsedTable = {
        columns: ['nomor', 'nama', ...attributeKeys],
        rows: rows.map((row, index) => ({
          row: index + 1,
          values: [
            row.phone ?? '',
            row.name ?? row.profileName ?? '',
            ...attributeKeys.map(
              (key) =>
                row.attributes.find((attribute) => attribute.key === key)?.value.slice(0, 500) ??
                '',
            ),
          ],
        })),
      };
      const labelParts = [
        tagRows.length
          ? `tag ${tagRows.map((tag) => tag.name).join(input.tagMatch === 'all' ? ' + ' : ' / ')}`
          : null,
        input.attributes.length
          ? input.attributes.map((attribute) => `${attribute.key}=${attribute.value}`).join(', ')
          : null,
      ].filter(Boolean);
      return replaceRecipients(
        auth,
        id,
        { kind: 'segment', label: `Segmen: ${labelParts.join('; ') || 'semua kontak WhatsApp'}` },
        table,
        'nomor',
        buildRecipients(table, 'nomor'),
        client,
      );
    },

    async importConnector(auth: AuthContext, id: string, connectorId: string, client: ClientInfo) {
      await campaignRow(db, auth.organizationId, id).then(requireDraft);
      const { row, result } = await deps.settings.fetchConnector(auth.organizationId, connectorId);
      if (!result.ok) {
        throw new AppError('BAD_REQUEST', {
          message: `Data konektor tidak bisa diambil (${result.code}). Tes konektor di Pengaturan → Integrasi.`,
        });
      }
      let imported: ImportResult;
      try {
        if (result.table.rows.length === 0) throw new ImportError('Konektor tidak mengirim data.');
        imported = buildRecipients(result.table, row.phoneField);
      } catch (error) {
        importFailure(error);
      }
      return replaceRecipients(
        auth,
        id,
        { kind: 'connector', label: row.name },
        result.table,
        row.phoneField,
        imported,
        client,
      );
    },

    async preview(organizationId: string, id: string): Promise<BroadcastPreviewResponse> {
      const row = await campaignRow(db, organizationId, id);
      const [template] = await db
        .select({ content: messageTemplates.content })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.id, row.templateId),
          ),
        );
      const content = templateContentSchema.safeParse(template?.content);
      if (!content.success) throw conflict('Template tidak ditemukan atau rusak.');
      const mapping = broadcastMappingSchema.safeParse(row.mapping);
      const map = mapping.success ? mapping.data : EMPTY_BROADCAST_MAPPING;
      const pending = await pendingRecipients(db, organizationId, row.id);
      let missing = 0;
      let invalid = 0;
      const samples: BroadcastPreviewResponse['samples'] = [];
      for (const recipient of pending) {
        const render = renderBroadcastParameters(content.data, map, recipient.data);
        if (render.missing.length > 0) missing += 1;
        else if (render.invalid.length > 0) invalid += 1;
        if (samples.length < BROADCAST_LIMITS.previewMax) {
          const header = content.data.header;
          samples.push({
            recipientId: recipient.id,
            row: recipient.row,
            phone: recipient.phone,
            headerText:
              header?.format === 'TEXT'
                ? fillTemplateText(header.text, {
                    [templateVariables(header.text)[0] ?? '']: render.parameters.header?.text ?? '',
                  })
                : null,
            text: render.preview,
            missing: render.missing,
            invalid: render.invalid,
          });
        }
      }
      return { samples, problems: { missing, invalid } };
    },

    async estimate(organizationId: string, id: string): Promise<BroadcastEstimate> {
      const row = await campaignRow(db, organizationId, id);
      const [template] = await db
        .select({ category: messageTemplates.category })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.organizationId, organizationId),
            eq(messageTemplates.id, row.templateId),
          ),
        );
      if (!template) throw conflict('Template tidak ditemukan.');
      return estimateFor(
        db,
        row,
        template.category as TemplateCategory,
        await loadBroadcastSettings(db, organizationId),
      );
    },

    async submit(
      auth: AuthContext,
      id: string,
      confirmation: IdentityConfirmation | undefined,
      context: BroadcastContext,
    ) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'broadcast.submit',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengajukan broadcast.',
      );
      const result = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        requireDraft(row);
        const channel = await liveChannel(tx, auth.organizationId, row.channelId);
        const summary = whatsAppNumberSummarySchema.safeParse(channel.waNumberSummary);
        if (
          summary.success &&
          (BLOCKED_QUALITY.has(summary.data.qualityRating ?? '') ||
            BLOCKED_NUMBER_STATUS.has(summary.data.status ?? ''))
        ) {
          throw conflict(
            'Kualitas/status nomor pengirim sedang buruk (merah, ditandai, atau dibatasi Meta). Broadcast ditahan untuk melindungi nomor.',
          );
        }
        const template = await usableTemplate(tx, auth.organizationId, channel, row.templateId);
        const mapping = assertMapping(row, template.content);
        if (row.scheduledAt && row.scheduledAt.getTime() < now().getTime() - 60_000) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Jadwal kirim sudah lewat. Ubah jadwal atau kosongkan untuk kirim segera.',
          });
        }
        // Penerima yang datanya kurang/salah dilewati sekarang (laporan jelas sebelum persetujuan).
        const pending = await pendingRecipients(tx, auth.organizationId, row.id);
        const skip: Record<'missing_variable' | 'invalid_variable', string[]> = {
          missing_variable: [],
          invalid_variable: [],
        };
        for (const recipient of pending) {
          const render = renderBroadcastParameters(template.content, mapping, recipient.data);
          if (render.missing.length > 0) skip.missing_variable.push(recipient.id);
          else if (render.invalid.length > 0) skip.invalid_variable.push(recipient.id);
        }
        for (const [reason, ids] of Object.entries(skip)) {
          for (let start = 0; start < ids.length; start += CHUNK) {
            await tx
              .update(broadcastRecipients)
              .set({ status: 'skipped', skipReason: reason })
              .where(
                and(
                  eq(broadcastRecipients.organizationId, auth.organizationId),
                  inArray(broadcastRecipients.id, ids.slice(start, start + CHUNK)),
                ),
              );
          }
        }
        const remaining =
          pending.length - skip.missing_variable.length - skip.invalid_variable.length;
        if (remaining === 0) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Tidak ada penerima yang bisa dikirimi (data variabel kosong/salah).',
          });
        }
        const settings = await loadBroadcastSettings(tx, auth.organizationId);
        const estimate = await estimateFor(tx, row, template.category, settings);
        // Review S1: ambang berlaku untuk JUMLAH penerima tanpa persetujuan per organisasi dalam 24 jam
        // bergulir (memecah kampanye tidak menghindari persetujuan). Diserialkan per organisasi.
        await lockAdvisoryKeys(tx, [`broadcast-submit:${auth.organizationId}`]);
        const [prior] = await tx
          .select({
            mine: sql<number>`coalesce(sum((${auditLogs.metadata} ->> 'recipients')::int) filter (where ${auditLogs.actorUserId} = ${auth.user.id}), 0)::int`,
            organization: sql<number>`coalesce(sum((${auditLogs.metadata} ->> 'recipients')::int), 0)::int`,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, auth.organizationId),
              eq(auditLogs.action, AUDIT_ACTIONS.broadcastSubmitted),
              gt(auditLogs.createdAt, new Date(now().getTime() - 24 * 60 * 60 * 1000)),
              sql`(${auditLogs.metadata} ->> 'approvalRequired') = 'false'`,
              sql`(${auditLogs.metadata} ->> 'recipients') ~ '^[0-9]{1,9}$'`,
            ),
          );
        const unapprovedBefore = Number(prior?.organization ?? 0);
        const approvalReason =
          remaining > settings.approvalThreshold
            ? 'threshold'
            : unapprovedBefore + remaining > settings.approvalThreshold
              ? 'cumulative'
              : null;
        const approvalRequired = approvalReason !== null;
        const at = now();
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: approvalRequired ? 'pending_approval' : 'scheduled',
            approvalRequired,
            approvalThreshold: settings.approvalThreshold,
            approvalRequestedAt: approvalRequired ? at : null,
            approvalDecidedAt: null,
            approvalDecidedByUserId: null,
            rejectionReason: null,
            submittedByUserId: auth.user.id,
            estimate,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastSubmitted, updated, context.client, {
          recipients: remaining,
          skipped: pending.length - remaining,
          approvalRequired,
          approvalReason,
          unapprovedLast24Hours: {
            submitter: Number(prior?.mine ?? 0),
            organization: unapprovedBefore,
          },
          estimateTotal: estimate.total,
          currency: estimate.currency,
        });
        if (approvalRequired) {
          await recordAlarm(tx, {
            organizationId: auth.organizationId,
            kind: 'broadcast_pending_approval',
            campaignId: updated.id,
            details: { campaign: updated.name, recipients: remaining },
          });
        }
        return view(tx, updated);
      });
      return result;
    },

    async approve(
      auth: AuthContext,
      id: string,
      confirmation: IdentityConfirmation | undefined,
      context: BroadcastContext,
    ) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'broadcast.approve',
        context,
        'Masukkan password (dan kode verifikasi) untuk menyetujui broadcast.',
      );
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.approve');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status !== 'pending_approval') {
          throw conflict('Broadcast ini tidak sedang menunggu persetujuan.');
        }
        if (row.createdByUserId === auth.user.id || row.submittedByUserId === auth.user.id) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.broadcastApproveOwn,
            client: context.client,
            details: { broadcastId: row.id },
            message: 'Broadcast buatan atau ajuanmu sendiri harus disetujui Owner/Admin lain.',
          });
        }
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: 'scheduled',
            approvalDecidedAt: now(),
            approvalDecidedByUserId: auth.user.id,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastApproved, updated, context.client, {
          recipients: updated.estimate?.recipients ?? null,
        });
        return view(tx, updated);
      });
    },

    async reject(auth: AuthContext, id: string, reason: string, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.approve');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status !== 'pending_approval') {
          throw conflict('Broadcast ini tidak sedang menunggu persetujuan.');
        }
        // Kembali ke draf: penerima yang dilewati karena data variabel dihitung ulang saat diajukan lagi.
        await tx
          .update(broadcastRecipients)
          .set({ status: 'pending', skipReason: null })
          .where(
            and(
              eq(broadcastRecipients.organizationId, auth.organizationId),
              eq(broadcastRecipients.campaignId, row.id),
              inArray(broadcastRecipients.skipReason, ['missing_variable', 'invalid_variable']),
            ),
          );
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: 'draft',
            approvalDecidedAt: now(),
            approvalDecidedByUserId: auth.user.id,
            rejectionReason: reason,
            estimate: null,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastRejected, updated, client);
        return view(tx, updated);
      });
    },

    /** Jeda SEKETIKA (arah aman: tanpa konfirmasi identitas). Menunggu transaksi kirim yang berjalan. */
    async pause(auth: AuthContext, id: string, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status !== 'scheduled' && row.status !== 'running') {
          throw conflict('Hanya broadcast terjadwal atau berjalan yang bisa dijeda.');
        }
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: 'paused',
            pausedReason: 'manual',
            pausedAt: now(),
            pausedByUserId: auth.user.id,
            waitingReason: null,
            waitingUntil: null,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastPaused, updated, client);
        return view(tx, updated);
      });
    },

    async resume(
      auth: AuthContext,
      id: string,
      confirmation: IdentityConfirmation | undefined,
      context: BroadcastContext,
    ) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'broadcast.resume',
        context,
        'Masukkan password (dan kode verifikasi) untuk melanjutkan broadcast.',
      );
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status !== 'paused') throw conflict('Broadcast ini tidak sedang dijeda.');
        if (row.pausedReason !== 'manual' && !(await grantsResume(tx, auth))) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.broadcastResumeBrake,
            client: context.client,
            details: { broadcastId: row.id, reason: row.pausedReason ?? '' },
            message:
              'Broadcast ini dijeda rem otomatis/rem darurat. Hanya Owner/Admin yang bisa melanjutkannya.',
          });
        }
        const [org] = await tx
          .select({ pausedAt: organizations.sendingPausedAt })
          .from(organizations)
          .where(eq(organizations.id, auth.organizationId));
        if (org?.pausedAt) {
          throw conflict(
            'Rem darurat pengiriman organisasi masih ditarik. Lanjutkan pengiriman di Pengaturan → Batas kirim dulu.',
          );
        }
        const at = now();
        // Pesan yang dihentikan sebelum sampai ke Meta dikirim lagi oleh worker.
        await tx
          .update(messages)
          .set({
            status: 'pending',
            failureReason: null,
            errorCode: null,
            sendClaimedAt: null,
            statusUpdatedAt: at,
          })
          .where(
            and(
              eq(messages.organizationId, auth.organizationId),
              eq(messages.broadcastId, row.id),
              eq(messages.status, 'failed'),
              inArray(messages.failureReason, ['broadcast_stopped', 'sending_paused']),
              sql`${messages.wamid} is null`,
            ),
          );
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: row.startedAt ? 'running' : 'scheduled',
            pausedReason: null,
            pausedAt: null,
            pausedByUserId: null,
            failureWindowFrom: at,
            runnerLeaseUntil: null,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastResumed, updated, context.client, {
          previousReason: row.pausedReason,
        });
        return view(tx, updated);
      });
    },

    async cancel(auth: AuthContext, id: string, client: ClientInfo) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'broadcast.send');
        const row = await campaignRow(tx, auth.organizationId, id, true);
        if (row.status === 'completed' || row.status === 'cancelled' || row.status === 'draft') {
          throw conflict(
            row.status === 'draft'
              ? 'Draf tidak perlu dibatalkan — hapus saja.'
              : 'Broadcast ini sudah selesai atau dibatalkan.',
          );
        }
        await tx
          .update(broadcastRecipients)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(broadcastRecipients.organizationId, auth.organizationId),
              eq(broadcastRecipients.campaignId, row.id),
              eq(broadcastRecipients.status, 'pending'),
            ),
          );
        const at = now();
        const [updated] = await tx
          .update(broadcastCampaigns)
          .set({
            status: 'cancelled',
            cancelledAt: at,
            cancelledByUserId: auth.user.id,
            pausedReason: null,
            pausedAt: null,
            pausedByUserId: null,
            waitingReason: null,
            waitingUntil: null,
          })
          .where(eq(broadcastCampaigns.id, row.id))
          .returning();
        if (!updated) throw notFound();
        await audit(tx, auth, AUDIT_ACTIONS.broadcastCancelled, updated, client);
        return view(tx, updated);
      });
    },

    async recipients(
      organizationId: string,
      id: string,
      query: { status?: string; cursor?: string; limit: number },
    ): Promise<{ recipients: BroadcastRecipient[]; nextCursor: string | null }> {
      const row = await campaignRow(db, organizationId, id);
      const after = Number(decodeCursor(query.cursor)?.[0] ?? '0');
      const status = query.status;
      const rows = await db
        .select({
          id: broadcastRecipients.id,
          row: broadcastRecipients.rowNumber,
          phone: broadcastRecipients.phone,
          status: broadcastRecipients.status,
          skipReason: broadcastRecipients.skipReason,
          messageStatus: messages.status,
          failureReason: messages.failureReason,
          errorCode: messages.errorCode,
          conversationId: broadcastRecipients.conversationId,
          processedAt: broadcastRecipients.processedAt,
          repliedAt: broadcastRecipients.repliedAt,
        })
        .from(broadcastRecipients)
        .leftJoin(
          messages,
          and(
            eq(messages.organizationId, broadcastRecipients.organizationId),
            eq(messages.id, broadcastRecipients.messageId),
          ),
        )
        .where(
          and(
            eq(broadcastRecipients.organizationId, organizationId),
            eq(broadcastRecipients.campaignId, row.id),
            Number.isFinite(after) && after > 0
              ? gt(broadcastRecipients.rowNumber, after)
              : undefined,
            status === 'pending' || status === 'skipped' || status === 'cancelled'
              ? eq(broadcastRecipients.status, status)
              : status === 'replied'
                ? isNotNull(broadcastRecipients.repliedAt)
                : status === 'sent' ||
                    status === 'delivered' ||
                    status === 'read' ||
                    status === 'failed'
                  ? eq(messages.status, status)
                  : undefined,
          ),
        )
        .orderBy(asc(broadcastRecipients.rowNumber))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        recipients: page.map((entry) => {
          const reason = outboundFailureReasonSchema.safeParse(entry.failureReason);
          return {
            id: entry.id,
            row: entry.row,
            phone: entry.phone,
            status: entry.status as BroadcastRecipient['status'],
            skipReason: (BROADCAST_SKIP_REASONS as readonly string[]).includes(
              entry.skipReason ?? '',
            )
              ? (entry.skipReason as BroadcastSkipReason)
              : null,
            messageStatus: entry.messageStatus,
            failure:
              entry.messageStatus === 'failed' && reason.success
                ? {
                    reason: reason.data,
                    errorCode: entry.errorCode,
                    message: outboundFailureMessage(reason.data, entry.errorCode),
                  }
                : null,
            conversationId: entry.conversationId,
            processedAt: iso(entry.processedAt),
            repliedAt: iso(entry.repliedAt),
          };
        }),
        nextCursor:
          rows.length > query.limit && page.at(-1)
            ? encodeCursor([String(page.at(-1)?.row ?? 0)])
            : null,
      };
    },

    async report(organizationId: string, id: string): Promise<BroadcastReport> {
      const row = await campaignRow(db, organizationId, id);
      const groups = await db
        .select({
          status: broadcastRecipients.status,
          skipReason: broadcastRecipients.skipReason,
          messageStatus: messages.status,
          failureReason: messages.failureReason,
          errorCode: messages.errorCode,
          replied: sql<boolean>`${broadcastRecipients.repliedAt} is not null`,
          total: count(),
        })
        .from(broadcastRecipients)
        .leftJoin(
          messages,
          and(
            eq(messages.organizationId, broadcastRecipients.organizationId),
            eq(messages.id, broadcastRecipients.messageId),
          ),
        )
        .where(
          and(
            eq(broadcastRecipients.organizationId, organizationId),
            eq(broadcastRecipients.campaignId, row.id),
          ),
        )
        .groupBy(
          broadcastRecipients.status,
          broadcastRecipients.skipReason,
          messages.status,
          messages.failureReason,
          messages.errorCode,
          sql`${broadcastRecipients.repliedAt} is not null`,
        );
      const report: BroadcastReport = {
        broadcastId: row.id,
        status: row.status as BroadcastStatus,
        recipients: 0,
        rejectedRows: row.rejectedRows,
        pending: 0,
        skipped: 0,
        skippedByReason: Object.fromEntries(
          BROADCAST_SKIP_REASONS.map((reason) => [reason, 0]),
        ) as Record<BroadcastSkipReason, number>,
        cancelled: 0,
        sending: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        failures: [],
        replied: 0,
        cost: { currency: '', billable: 0, total: 0 },
        estimate: row.estimate ?? null,
        startedAt: iso(row.startedAt),
        completedAt: iso(row.completedAt),
      };
      const failures = new Map<string, BroadcastReport['failures'][number]>();
      for (const group of groups) {
        const total = Number(group.total);
        report.recipients += total;
        if (group.replied) report.replied += total;
        if (group.status === 'pending') report.pending += total;
        else if (group.status === 'cancelled') report.cancelled += total;
        else if (group.status === 'skipped') {
          report.skipped += total;
          const reason = group.skipReason as BroadcastSkipReason;
          if (Object.hasOwn(report.skippedByReason, reason))
            report.skippedByReason[reason] += total;
        } else {
          switch (group.messageStatus) {
            case 'sent':
              report.sent += total;
              break;
            case 'delivered':
              report.delivered += total;
              break;
            case 'read':
            case 'played':
              report.read += total;
              break;
            case 'failed': {
              report.failed += total;
              const reason = outboundFailureReasonSchema.safeParse(group.failureReason);
              const key = `${group.failureReason ?? ''}|${String(group.errorCode)}`;
              const existing = failures.get(key);
              if (existing) existing.count += total;
              else {
                failures.set(key, {
                  reason: group.failureReason ?? 'unknown',
                  errorCode: group.errorCode,
                  message: reason.success
                    ? outboundFailureMessage(reason.data, group.errorCode)
                    : 'Gagal terkirim.',
                  count: total,
                });
              }
              break;
            }
            default:
              report.sending += total;
          }
        }
      }
      report.failures = [...failures.values()].sort((a, b) => b.count - a.count);
      // Biaya perkiraan: Meta menagih pesan yang diterima (delivered/read).
      const settings = await loadBroadcastSettings(db, organizationId);
      const category: TemplateCategory = row.estimate?.category ?? 'MARKETING';
      const delivered = await db
        .select({ phone: broadcastRecipients.phone })
        .from(broadcastRecipients)
        .innerJoin(
          messages,
          and(
            eq(messages.organizationId, broadcastRecipients.organizationId),
            eq(messages.id, broadcastRecipients.messageId),
          ),
        )
        .where(
          and(
            eq(broadcastRecipients.organizationId, organizationId),
            eq(broadcastRecipients.campaignId, row.id),
            inArray(messages.status, ['delivered', 'read', 'played']),
          ),
        );
      let total = 0;
      let billable = 0;
      for (const entry of delivered) {
        const rate = broadcastRateFor(settings.rates, entry.phone, category);
        if (rate !== null) {
          billable += 1;
          total += rate;
        }
      }
      report.cost = { currency: settings.rates.currency, billable, total: Math.round(total) };
      return report;
    },

    async exportCsv(auth: AuthContext, id: string, client: ClientInfo) {
      const row = await campaignRow(db, auth.organizationId, id);
      const rows = await db
        .select({
          row: broadcastRecipients.rowNumber,
          phone: broadcastRecipients.phone,
          status: broadcastRecipients.status,
          skipReason: broadcastRecipients.skipReason,
          messageStatus: messages.status,
          failureReason: messages.failureReason,
          errorCode: messages.errorCode,
          processedAt: broadcastRecipients.processedAt,
          repliedAt: broadcastRecipients.repliedAt,
        })
        .from(broadcastRecipients)
        .leftJoin(
          messages,
          and(
            eq(messages.organizationId, broadcastRecipients.organizationId),
            eq(messages.id, broadcastRecipients.messageId),
          ),
        )
        .where(
          and(
            eq(broadcastRecipients.organizationId, auth.organizationId),
            eq(broadcastRecipients.campaignId, row.id),
          ),
        )
        .orderBy(asc(broadcastRecipients.rowNumber));
      const header = [
        'baris',
        'nomor',
        'status',
        'alasan_dilewati',
        'status_pesan',
        'alasan_gagal',
        'kode_meta',
        'diproses_pada',
        'dibalas_pada',
      ];
      const lines = [header.join(',')];
      for (const entry of rows) {
        lines.push(
          [
            entry.row,
            entry.phone,
            entry.status,
            entry.skipReason,
            entry.messageStatus,
            entry.failureReason,
            entry.errorCode,
            iso(entry.processedAt),
            iso(entry.repliedAt),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.broadcastExported,
        targetType: 'broadcast',
        targetId: row.id,
        metadata: { name: row.name, rows: rows.length },
        client,
      });
      return { csv: `\ufeff${lines.join('\r\n')}\r\n`, rows: rows.length, name: row.name };
    },
  };
}

export type BroadcastsService = ReturnType<typeof createBroadcastsService>;
