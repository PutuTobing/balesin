import {
  AppError,
  newOutboundMessageId,
  sanitizeOutboundEmailHtml,
  scanTemplateVariables,
  type Logger,
  type MediaStore,
} from '@balesin/core';
import {
  channelAccessOf,
  emailOutbound,
  emailOutboundAttachments,
  emailTemplateVersions,
  emailTemplates,
  isPgError,
  PG_ERROR_CODES,
  users,
  type Database,
  type DbExecutor,
  type EmailTemplateRow,
  type EmailTemplateVersionRow,
} from '@balesin/db';
import {
  EMAIL_TEMPLATES_PER_ORGANIZATION_MAX,
  EMAIL_TEMPLATE_BUILTIN_VARIABLE_NAMES,
  EMAIL_TEMPLATE_PRESETS,
  EMAIL_TEMPLATE_VERSIONS_KEPT,
  parseEmailSenderId,
  type CreateEmailTemplateRequest,
  type EmailMessageTemplatePreviewRequest,
  type EmailStatus,
  type EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateContentInput,
  type EmailTemplateSummary,
  type EmailTemplateVariable,
  type IdentityConfirmation,
  type UpdateEmailTemplateRequest,
} from '@balesin/shared';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { riskyAdditions } from '../quick-replies/quick-replies.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { detail, emailError } from '../email-send/email-content';
import {
  SAMPLE_QRIS_PAYLOAD,
  loadEmailBrand,
  prepareQris,
  renderEmail,
  renderFailure,
} from '../email-send/email-render';
import { composeEmail, storeParts, toEmailStatus } from '../email-send/email-send.service';
import { findChannelSender } from '../email-send/senders';

/**
 * Pengaturan → Template email (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §7). Izin
 * `templates.manage`. Draf bebas disimpan apa adanya (editor tidak kehilangan isi); TERBIT =
 * konfirmasi identitas + validasi penuh (HTML disanitasi profil keluar — skrip/elemen terlarang → 400;
 * variabel persis cocok) + deteksi tautan/angka panjang baru (`email_template_risky` + email Owner).
 * Audit tanpa isi HTML/subjek.
 */

export interface EmailTemplatesContext {
  auth: AuthContext;
  client: ClientInfo;
}

export interface EmailMessageTemplatesService {
  list(
    organizationId: string,
    query: { q?: string; archived?: boolean },
  ): Promise<EmailTemplateSummary[]>;
  get(organizationId: string, id: string): Promise<EmailTemplate>;
  create(context: EmailTemplatesContext, input: CreateEmailTemplateRequest): Promise<EmailTemplate>;
  update(
    context: EmailTemplatesContext,
    id: string,
    input: UpdateEmailTemplateRequest,
  ): Promise<EmailTemplate>;
  publish(
    auth: AuthContext,
    id: string,
    confirmation: IdentityConfirmation | undefined,
    context: TwoFactorContext,
  ): Promise<EmailTemplate>;
  setArchived(
    context: EmailTemplatesContext,
    id: string,
    archived: boolean,
  ): Promise<EmailTemplate>;
  versions(
    organizationId: string,
    id: string,
  ): Promise<
    {
      version: number;
      state: 'draft' | 'published' | 'superseded';
      subject: string;
      createdBy: { id: string; name: string } | null;
      createdAt: string;
      publishedBy: { id: string; name: string } | null;
      publishedAt: string | null;
    }[]
  >;
  version(
    organizationId: string,
    id: string,
    version: number,
  ): Promise<{
    version: number;
    state: 'draft' | 'published' | 'superseded';
    subject: string;
    createdBy: { id: string; name: string } | null;
    createdAt: string;
    publishedBy: { id: string; name: string } | null;
    publishedAt: string | null;
    content: EmailTemplateContent;
  }>;
  restore(context: EmailTemplatesContext, id: string, version: number): Promise<EmailTemplate>;
  preview(
    organizationId: string,
    input: EmailMessageTemplatePreviewRequest,
  ): Promise<{ subject: string; html: string; text: string; warnings: string[] }>;
  test(
    context: EmailTemplatesContext,
    id: string,
    input: { senderId: string; which: 'draft' | 'published'; values?: Record<string, string> },
  ): Promise<EmailStatus>;
  fromPreset(
    context: EmailTemplatesContext,
    presetKey: string,
    input: { name?: string; slug?: string },
  ): Promise<EmailTemplate>;
  /** API publik `GET /public/email/templates`: terbit + tidak diarsip, tanpa HTML. */
  published(organizationId: string): Promise<
    {
      id: string;
      slug: string;
      name: string;
      subject: string;
      version: number;
      layout: 'brand' | 'none';
      hasQrisSlot: boolean;
      updatedAt: string;
      variables: EmailTemplateVariable[];
    }[]
  >;
}

const UUID = z.uuid();
const NOT_FOUND = 'Template email tidak ditemukan.';
const DRAFT_AUDIT_FLAG = 'template-email-draf';
const BUILTINS = new Set<string>(EMAIL_TEMPLATE_BUILTIN_VARIABLE_NAMES);

const notFound = () => new AppError('NOT_FOUND', { message: NOT_FOUND });

function bodyInvalid(field: string, message: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message, ...(reason ? { reason } : {}) }],
  });
}

function contentOf(row: EmailTemplateVersionRow): EmailTemplateContent {
  return {
    subject: row.subject,
    html: row.html,
    text: row.text,
    variables: row.variables,
    layout: row.layout === 'none' ? 'none' : 'brand',
    footerText: row.footerText,
  };
}

function normalizeContent(input: EmailTemplateContentInput): EmailTemplateContent {
  return {
    subject: input.subject,
    html: input.html,
    text: input.text?.trim() ? input.text : null,
    variables: input.variables.map((variable) => ({
      name: variable.name,
      label: variable.label,
      required: variable.required,
      example: variable.example ?? '',
    })),
    layout: input.layout,
    footerText: input.footerText?.trim() ? input.footerText.trim() : null,
  };
}

const sameContent = (a: EmailTemplateContent | null, b: EmailTemplateContent | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Teks yang dibandingkan untuk tautan/angka panjang baru (`riskyAdditions`). */
const riskText = (content: EmailTemplateContent | null) =>
  content
    ? [content.subject, content.html, content.text ?? '', content.footerText ?? ''].join('\n')
    : '';

/**
 * Validasi penuh (terbit): subjek 1–200 satu baris, HTML lolos sanitasi keluar tanpa elemen
 * terlarang, variabel di atribut selain href ditolak, daftar variabel = variabel yang dipakai persis.
 * Mengembalikan isi dengan HTML tersanitasi.
 */
export function validateForPublish(content: EmailTemplateContent): EmailTemplateContent {
  const subject = content.subject.trim();
  if (subject.length === 0 || subject.length > 200 || /[\r\n]/.test(subject)) {
    throw bodyInvalid(
      'draft.subject',
      'Subjek wajib diisi (maks. 200 karakter, satu baris).',
      'subject_invalid',
    );
  }
  if (content.html.trim() === '') throw bodyInvalid('draft.html', 'Isi HTML template wajib diisi.');
  const sanitized = sanitizeOutboundEmailHtml(content.html);
  if (sanitized.forbidden) {
    throw bodyInvalid(
      'draft.html',
      `HTML memuat bagian yang tidak boleh ada di email (${sanitized.warnings.join(' ')}). Hapus dulu, lalu terbitkan lagi.`,
      'html_forbidden',
    );
  }
  const scan = scanTemplateVariables({ subject, html: content.html, text: content.text });
  const problem = scan.problems[0];
  if (problem) {
    throw bodyInvalid(
      `draft.${problem.field}`,
      problem.reason === 'attribute_not_supported'
        ? `Variabel {{${problem.name}}} hanya boleh di teks atau sebagai seluruh nilai href tautan.`
        : `Nama variabel {{${problem.name}}} tidak valid: huruf kecil, angka, garis bawah, diawali huruf.`,
      'template_variable_invalid',
    );
  }
  const declared = new Map(content.variables.map((variable) => [variable.name, variable]));
  if (declared.size !== content.variables.length) {
    throw bodyInvalid('draft.variables', 'Nama variabel tidak boleh kembar.');
  }
  for (const name of declared.keys()) {
    if (BUILTINS.has(name)) {
      throw bodyInvalid(
        'draft.variables',
        `{{${name}}} adalah variabel bawaan dan tidak perlu dideklarasikan.`,
      );
    }
  }
  const used = scan.used.filter((name) => !BUILTINS.has(name));
  const missingDeclaration = used.find((name) => !declared.has(name));
  if (missingDeclaration) {
    throw bodyInvalid(
      'draft.variables',
      `Variabel {{${missingDeclaration}}} dipakai tetapi belum dideklarasikan.`,
    );
  }
  const unused = [...declared.keys()].find((name) => !used.includes(name));
  if (unused) {
    throw bodyInvalid(
      'draft.variables',
      `Variabel {{${unused}}} dideklarasikan tetapi tidak dipakai di subjek, HTML, atau teks.`,
    );
  }
  return { ...content, subject, html: sanitized.html };
}

export function createEmailMessageTemplatesService(deps: {
  db: Database;
  store: MediaStore;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  logger: Logger;
  now?: () => Date;
}): EmailMessageTemplatesService {
  const { db, store, limiter, notifier, twoFactor, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function versionRows(executor: DbExecutor, templateId: string) {
    return executor
      .select()
      .from(emailTemplateVersions)
      .where(eq(emailTemplateVersions.templateId, templateId));
  }

  async function personMap(executor: DbExecutor, organizationId: string, ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map<string, { id: string; name: string }>();
    const rows = await executor
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function view(executor: DbExecutor, row: EmailTemplateRow): Promise<EmailTemplate> {
    const rows = await versionRows(executor, row.id);
    const draft = rows.find((item) => item.state === 'draft') ?? null;
    const published =
      row.publishedVersion === null
        ? null
        : (rows.find((item) => item.version === row.publishedVersion) ?? null);
    const people = await personMap(executor, row.organizationId, [
      published?.publishedByUserId ?? null,
    ]);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      presetKey: row.presetKey,
      archived: row.archivedAt !== null,
      publishedVersion: row.publishedVersion,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      draft: draft ? contentOf(draft) : null,
      published: published
        ? {
            ...contentOf(published),
            version: published.version,
            publishedAt: (published.publishedAt ?? published.createdAt).toISOString(),
            publishedBy: published.publishedByUserId
              ? (people.get(published.publishedByUserId) ?? null)
              : null,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function load(executor: DbExecutor, organizationId: string, id: string, lock = false) {
    if (!UUID.safeParse(id).success) throw notFound();
    const query = executor
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.organizationId, organizationId), eq(emailTemplates.id, id)))
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  async function upsertDraft(
    tx: DbExecutor,
    organizationId: string,
    templateId: string,
    content: EmailTemplateContent,
    userId: string,
  ) {
    const values = {
      subject: content.subject,
      html: content.html,
      text: content.text,
      variables: content.variables,
      layout: content.layout,
      footerText: content.footerText,
    };
    await tx
      .insert(emailTemplateVersions)
      .values({
        organizationId,
        templateId,
        version: 0,
        state: 'draft',
        ...values,
        createdByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [emailTemplateVersions.templateId, emailTemplateVersions.version],
        set: { ...values, createdByUserId: userId },
      });
  }

  function slugTaken(): AppError {
    return new AppError('CONFLICT', {
      message: 'Slug itu sudah dipakai template lain (termasuk yang diarsip).',
      details: [
        { location: 'body', field: 'slug', message: 'Slug itu sudah dipakai template lain.' },
      ],
    });
  }

  async function insertTemplate(
    context: EmailTemplatesContext,
    input: {
      name: string;
      slug: string;
      description: string | null;
      presetKey: string | null;
      draft: EmailTemplateContent | null;
    },
  ): Promise<EmailTemplate> {
    const { auth } = context;
    try {
      return await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`email-templates:${auth.organizationId}`}, 0))`,
        );
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(emailTemplates)
          .where(eq(emailTemplates.organizationId, auth.organizationId));
        if (Number(count?.total ?? 0) >= EMAIL_TEMPLATES_PER_ORGANIZATION_MAX) {
          throw new AppError('CONFLICT', {
            message: `Sudah ada ${String(EMAIL_TEMPLATES_PER_ORGANIZATION_MAX)} template email (batas). Arsipkan atau pakai ulang yang lama.`,
          });
        }
        const [row] = await tx
          .insert(emailTemplates)
          .values({
            organizationId: auth.organizationId,
            slug: input.slug,
            name: input.name,
            description: input.description,
            presetKey: input.presetKey,
            createdByUserId: auth.user.id,
            updatedByUserId: auth.user.id,
          })
          .returning();
        if (!row) throw new Error('INSERT template email tidak mengembalikan baris');
        if (input.draft) {
          await upsertDraft(tx, auth.organizationId, row.id, input.draft, auth.user.id);
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.emailTemplateCreated,
          targetType: 'email_template',
          targetId: row.id,
          metadata: {
            templateId: row.id,
            slug: row.slug,
            name: row.name,
            presetKey: input.presetKey,
            actorRole: role,
          },
          client: context.client,
        });
        return view(tx, row);
      });
    } catch (error) {
      if (
        isPgError(
          error,
          PG_ERROR_CODES.uniqueViolation,
          'email_templates_organization_id_slug_unique',
        )
      ) {
        throw slugTaken();
      }
      throw error;
    }
  }

  /** Email ke semua Owner aktif (selain pelaku) — gagal antre = log saja. */
  async function notifyOwners(
    organizationId: string,
    event: 'email_template_risky',
    subjectUserId: string,
    auditLogId: string,
  ) {
    const owners = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.role, 'owner'),
          isNull(users.disabledAt),
        ),
      );
    const occurredAt = now().toISOString();
    for (const owner of owners) {
      if (owner.id === subjectUserId) continue;
      await notifier
        .securityNoticeAdmin({
          organizationId,
          recipientUserId: owner.id,
          subjectUserId,
          event,
          occurredAt,
          auditLogId,
        })
        .catch((err: unknown) => {
          logger.warn({ err, event }, 'Gagal mengantre email template email berisiko ke Owner');
        });
    }
  }

  return {
    async list(organizationId, query) {
      const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
      const rows = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.organizationId, organizationId),
            query.archived === undefined
              ? undefined
              : query.archived
                ? isNotNull(emailTemplates.archivedAt)
                : isNull(emailTemplates.archivedAt),
            pattern
              ? sql`(${ilike(emailTemplates.name, pattern)} or ${ilike(emailTemplates.slug, pattern)})`
              : undefined,
          ),
        )
        .orderBy(asc(emailTemplates.name))
        .limit(EMAIL_TEMPLATES_PER_ORGANIZATION_MAX);
      if (rows.length === 0) return [];
      const versions = await db
        .select()
        .from(emailTemplateVersions)
        .where(
          and(
            eq(emailTemplateVersions.organizationId, organizationId),
            inArray(
              emailTemplateVersions.templateId,
              rows.map((row) => row.id),
            ),
            sql`(${emailTemplateVersions.state} = 'draft' or ${emailTemplateVersions.state} = 'published')`,
          ),
        );
      return rows.map((row) => {
        const draft = versions.find((item) => item.templateId === row.id && item.state === 'draft');
        const published = versions.find(
          (item) => item.templateId === row.id && item.version === row.publishedVersion,
        );
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          presetKey: row.presetKey,
          archived: row.archivedAt !== null,
          publishedVersion: row.publishedVersion,
          hasUnpublishedChanges:
            draft !== undefined &&
            !sameContent(contentOf(draft), published ? contentOf(published) : null),
          subject: published?.subject ?? draft?.subject ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    },

    async get(organizationId, id) {
      return view(db, await load(db, organizationId, id));
    },

    create(context, input) {
      return insertTemplate(context, {
        name: input.name,
        slug: input.slug,
        description: input.description?.trim() || null,
        presetKey: null,
        draft: input.draft ? normalizeContent(input.draft) : null,
      });
    },

    async update(context, id, input) {
      const { auth } = context;
      const changedFields: string[] = [];
      let draftSaved = false;
      try {
        await db.transaction(async (tx) => {
          const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
          const row = await load(tx, auth.organizationId, id, true);
          const set: Partial<typeof emailTemplates.$inferInsert> = {};
          if (input.name !== undefined && input.name !== row.name) {
            set.name = input.name;
            changedFields.push('name');
          }
          if (input.description !== undefined) {
            const description = input.description?.trim() || null;
            if (description !== row.description) {
              set.description = description;
              changedFields.push('description');
            }
          }
          if (input.slug !== undefined && input.slug !== row.slug) {
            if (row.publishedVersion !== null) {
              throw bodyInvalid(
                'slug',
                'Slug tidak bisa diubah setelah template pernah diterbitkan (dipakai integrasi).',
              );
            }
            set.slug = input.slug;
            changedFields.push('slug');
          }
          if (input.draft !== undefined) {
            await upsertDraft(
              tx,
              auth.organizationId,
              id,
              normalizeContent(input.draft),
              auth.user.id,
            );
            draftSaved = true;
          }
          if (Object.keys(set).length > 0 || draftSaved) {
            await tx
              .update(emailTemplates)
              .set({ ...set, updatedByUserId: auth.user.id })
              .where(
                and(
                  eq(emailTemplates.organizationId, auth.organizationId),
                  eq(emailTemplates.id, id),
                ),
              );
          }
          // Simpan draf sering (ketik-simpan): audit paling sering sekali per 10 menit per template
          // per pengguna. Perubahan nama/slug selalu diaudit.
          const auditDraft =
            draftSaved &&
            (await limiter
              .claimFlag(DRAFT_AUDIT_FLAG, `${id}:${auth.user.id}`, 10 * 60)
              .catch(() => true));
          if (changedFields.length > 0 || auditDraft) {
            await recordAudit(tx, {
              organizationId: auth.organizationId,
              actorUserId: auth.user.id,
              action: AUDIT_ACTIONS.emailTemplateDraftSaved,
              targetType: 'email_template',
              targetId: id,
              metadata: {
                templateId: id,
                slug: set.slug ?? row.slug,
                changedFields: [...changedFields, ...(draftSaved ? ['draft'] : [])].join(','),
                actorRole: role,
              },
              client: context.client,
            });
          }
        });
      } catch (error) {
        if (
          isPgError(
            error,
            PG_ERROR_CODES.uniqueViolation,
            'email_templates_organization_id_slug_unique',
          )
        ) {
          throw slugTaken();
        }
        throw error;
      }
      return this.get(auth.organizationId, id);
    },

    async publish(auth, id, confirmation, context) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'email_template.publish',
        context,
        'Masukkan password (dan kode verifikasi) untuk menerbitkan template email.',
      );
      let risky: { auditLogId: string } | null = null;
      const result = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
        const row = await load(tx, auth.organizationId, id, true);
        if (row.archivedAt) {
          throw new AppError('CONFLICT', {
            message: 'Template ini diarsipkan. Pulihkan dulu sebelum diterbitkan.',
          });
        }
        const rows = await versionRows(tx, id);
        const draftRow = rows.find((item) => item.state === 'draft');
        if (!draftRow) {
          throw bodyInvalid('draft', 'Belum ada draf untuk diterbitkan. Simpan isinya dulu.');
        }
        const previousRow =
          row.publishedVersion === null
            ? undefined
            : rows.find((item) => item.version === row.publishedVersion);
        const previous = previousRow ? contentOf(previousRow) : null;
        const content = validateForPublish(contentOf(draftRow));
        const version = (row.publishedVersion ?? 0) + 1;
        const at = now();
        if (previousRow) {
          await tx
            .update(emailTemplateVersions)
            .set({ state: 'superseded' })
            .where(eq(emailTemplateVersions.id, previousRow.id));
        }
        await tx.insert(emailTemplateVersions).values({
          organizationId: auth.organizationId,
          templateId: id,
          version,
          state: 'published',
          subject: content.subject,
          html: content.html,
          text: content.text,
          variables: content.variables,
          layout: content.layout,
          footerText: content.footerText,
          createdByUserId: draftRow.createdByUserId ?? auth.user.id,
          publishedByUserId: auth.user.id,
          publishedAt: at,
        });
        await tx
          .update(emailTemplates)
          .set({ publishedVersion: version, updatedByUserId: auth.user.id })
          .where(
            and(eq(emailTemplates.organizationId, auth.organizationId), eq(emailTemplates.id, id)),
          );
        // Versi `superseded` lebih dari 50 terakhir dipangkas KECUALI dirujuk email.
        await tx.execute(sql`
          delete from ${emailTemplateVersions}
          where ${emailTemplateVersions.templateId} = ${id}
            and ${emailTemplateVersions.state} = 'superseded'
            and ${emailTemplateVersions.version} <= ${version - EMAIL_TEMPLATE_VERSIONS_KEPT}
            and not exists (
              select 1 from ${emailOutbound}
              where ${emailOutbound.templateVersionId} = ${emailTemplateVersions.id}
            )`);
        const added = riskyAdditions(riskText(previous), riskText(content));
        const isRisky = added.links > 0 || added.numbers > 0;
        const changedFields = previous
          ? (['subject', 'html', 'text', 'variables', 'layout', 'footerText'] as const).filter(
              (field) => JSON.stringify(previous[field]) !== JSON.stringify(content[field]),
            )
          : ['created'];
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.emailTemplatePublished,
          targetType: 'email_template',
          targetId: id,
          metadata: {
            templateId: id,
            slug: row.slug,
            name: row.name,
            version,
            changedFields: changedFields.join(','),
            ...(isRisky
              ? { risky: true, addedLinks: added.links, addedNumbers: added.numbers }
              : { risky: false }),
            actorRole: role,
          },
          client: context.client,
        });
        if (isRisky) risky = { auditLogId };
        return view(tx, { ...row, publishedVersion: version });
      });
      const flagged = risky as { auditLogId: string } | null;
      if (flagged) {
        await notifyOwners(
          auth.organizationId,
          'email_template_risky',
          auth.user.id,
          flagged.auditLogId,
        );
      }
      return result;
    },

    async setArchived(context, id, archived) {
      const { auth } = context;
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
        const row = await load(tx, auth.organizationId, id, true);
        if ((row.archivedAt !== null) === archived) return;
        await tx
          .update(emailTemplates)
          .set({ archivedAt: archived ? now() : null, updatedByUserId: auth.user.id })
          .where(
            and(eq(emailTemplates.organizationId, auth.organizationId), eq(emailTemplates.id, id)),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: archived
            ? AUDIT_ACTIONS.emailTemplateArchived
            : AUDIT_ACTIONS.emailTemplateUnarchived,
          targetType: 'email_template',
          targetId: id,
          metadata: { templateId: id, slug: row.slug, actorRole: role },
          client: context.client,
        });
      });
      return this.get(auth.organizationId, id);
    },

    async versions(organizationId, id) {
      const row = await load(db, organizationId, id);
      const rows = await db
        .select()
        .from(emailTemplateVersions)
        .where(eq(emailTemplateVersions.templateId, row.id))
        .orderBy(desc(emailTemplateVersions.version))
        .limit(EMAIL_TEMPLATE_VERSIONS_KEPT + 1);
      const people = await personMap(
        db,
        organizationId,
        rows.flatMap((item) => [item.createdByUserId, item.publishedByUserId]),
      );
      return rows.map((item) => ({
        version: item.version,
        state: item.state as 'draft' | 'published' | 'superseded',
        subject: item.subject,
        createdBy: item.createdByUserId ? (people.get(item.createdByUserId) ?? null) : null,
        createdAt: item.createdAt.toISOString(),
        publishedBy: item.publishedByUserId ? (people.get(item.publishedByUserId) ?? null) : null,
        publishedAt: item.publishedAt?.toISOString() ?? null,
      }));
    },

    async version(organizationId, id, version) {
      const row = await load(db, organizationId, id);
      const [item] = await db
        .select()
        .from(emailTemplateVersions)
        .where(
          and(
            eq(emailTemplateVersions.templateId, row.id),
            eq(emailTemplateVersions.version, version),
          ),
        )
        .limit(1);
      if (!item) throw new AppError('NOT_FOUND', { message: 'Versi template tidak ditemukan.' });
      const people = await personMap(db, organizationId, [
        item.createdByUserId,
        item.publishedByUserId,
      ]);
      return {
        version: item.version,
        state: item.state as 'draft' | 'published' | 'superseded',
        subject: item.subject,
        createdBy: item.createdByUserId ? (people.get(item.createdByUserId) ?? null) : null,
        createdAt: item.createdAt.toISOString(),
        publishedBy: item.publishedByUserId ? (people.get(item.publishedByUserId) ?? null) : null,
        publishedAt: item.publishedAt?.toISOString() ?? null,
        content: contentOf(item),
      };
    },

    async restore(context, id, version) {
      const { auth } = context;
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
        const row = await load(tx, auth.organizationId, id, true);
        const [item] = await tx
          .select()
          .from(emailTemplateVersions)
          .where(
            and(
              eq(emailTemplateVersions.templateId, id),
              eq(emailTemplateVersions.version, version),
            ),
          )
          .limit(1);
        if (!item || item.state === 'draft') {
          throw new AppError('NOT_FOUND', { message: 'Versi template tidak ditemukan.' });
        }
        await upsertDraft(tx, auth.organizationId, id, contentOf(item), auth.user.id);
        await tx
          .update(emailTemplates)
          .set({ updatedByUserId: auth.user.id })
          .where(
            and(eq(emailTemplates.organizationId, auth.organizationId), eq(emailTemplates.id, id)),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.emailTemplateRestored,
          targetType: 'email_template',
          targetId: id,
          metadata: { templateId: id, slug: row.slug, version, actorRole: role },
          client: context.client,
        });
      });
      return this.get(auth.organizationId, id);
    },

    async preview(organizationId, input) {
      const warnings = new Set<string>();
      const sanitized = sanitizeOutboundEmailHtml(input.html);
      for (const warning of sanitized.warnings) warnings.add(warning);
      const scan = scanTemplateVariables({
        subject: input.subject,
        html: input.html,
        text: input.text ?? null,
      });
      for (const problem of scan.problems) {
        warnings.add(
          problem.reason === 'attribute_not_supported'
            ? `Variabel {{${problem.name}}} hanya boleh di teks atau sebagai seluruh nilai href.`
            : `Nama variabel {{${problem.name}}} tidak valid.`,
        );
      }
      const values: Record<string, string> = {};
      for (const variable of input.variables ?? []) values[variable.name] = variable.example ?? '';
      for (const [name, value] of Object.entries(input.values ?? {})) values[name] = value;
      // Variabel tanpa contoh di href → contoh aman supaya pratinjau tetap tampil.
      const brand = await loadEmailBrand(db, organizationId);
      const qris =
        input.sampleQris || scan.used.includes('qris')
          ? prepareQris({ payload: SAMPLE_QRIS_PAYLOAD, sizePx: 480 })
          : null;
      const rendered = renderEmail(
        brand,
        {
          subject: input.subject.trim() === '' ? '(Tanpa subjek)' : input.subject,
          html: input.html,
          text: input.text ?? null,
          layout: input.layout,
          footerText: input.footerText ?? null,
          values,
          fromTemplate: true,
        },
        { qris, inline: 'data' },
      );
      if (!rendered.ok) renderFailure(rendered.errors);
      return {
        subject: rendered.subject,
        html: rendered.html ?? '',
        text: rendered.text,
        warnings: [...warnings],
      };
    },

    async test(context, id, input) {
      const { auth } = context;
      const row = await load(db, auth.organizationId, id);
      const rows = await versionRows(db, id);
      const source =
        input.which === 'draft'
          ? rows.find((item) => item.state === 'draft')
          : row.publishedVersion === null
            ? undefined
            : rows.find((item) => item.version === row.publishedVersion);
      if (!source) {
        throw bodyInvalid(
          'which',
          input.which === 'draft'
            ? 'Belum ada draf untuk dites.'
            : 'Template ini belum pernah diterbitkan.',
        );
      }
      const parsed = parseEmailSenderId(input.senderId);
      const found = parsed
        ? await findChannelSender(db, auth.organizationId, input.senderId)
        : null;
      // Review 9.1 R5: channel yang dibatasi dari pengguna ini (akses per channel 9.0) = tidak ada.
      const sender =
        found &&
        (await channelAccessOf(db, auth.organizationId, [auth.user.id])).allows(
          auth.user.id,
          found.channelId,
        )
          ? found
          : null;
      if (!sender) {
        throw emailError('NOT_FOUND', [
          detail('senderId', 'sender_not_found', 'Pengirim email tidak ditemukan.'),
        ]);
      }
      if (!sender.enabled) {
        throw emailError('CONFLICT', [
          detail('senderId', 'sender_disabled', 'Channel pengirim sedang nonaktif.'),
        ]);
      }
      // Draf belum tentu lolos validasi terbit: kirim tes tetap memakai sanitasi & render yang sama.
      const content = input.which === 'draft' ? contentOf(source) : contentOf(source);
      const values: Record<string, string> = {};
      for (const variable of content.variables) values[variable.name] = variable.example;
      for (const [name, value] of Object.entries(input.values ?? {})) values[name] = value;
      const scan = scanTemplateVariables({
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      const qris = scan.used.includes('qris')
        ? prepareQris({ payload: SAMPLE_QRIS_PAYLOAD, sizePx: 480 })
        : null;
      const composed = await composeEmail(
        db,
        auth.organizationId,
        {
          kind: 'template',
          template: row,
          version: { ...source, ...content, subject: `[Tes] ${content.subject}` },
          values,
        },
        qris,
        [],
      );
      const saved = await storeParts(store, composed.parts);
      const at = now();
      try {
        const created = await db.transaction(async (tx) => {
          const { role } = await assertActorStillAuthorized(tx, auth, 'templates.manage');
          const [inserted] = await tx
            .insert(emailOutbound)
            .values({
              organizationId: auth.organizationId,
              source: 'test',
              createdByUserId: auth.user.id,
              senderKind: 'channel',
              channelId: sender.channelId,
              fromAddress: sender.fromAddress,
              fromName: sender.fromName,
              replyTo: sender.smtpMode === 'system' ? sender.address : null,
              // Penerima SELALU alamat akun pengguna itu sendiri (tidak bisa diisi).
              to: [{ email: auth.user.email.toLowerCase(), name: auth.user.name }],
              recipientCount: 1,
              subject: composed.subject.slice(0, 200),
              html: composed.html,
              text: composed.text,
              sanitized: false,
              templateId: row.id,
              templateVersionId: source.state === 'draft' ? null : source.id,
              templateVersion: source.state === 'draft' ? null : source.version,
              messageIdHeader: newOutboundMessageId(sender.fromAddress),
              status: 'queued',
              nextAttemptAt: at,
            })
            .returning();
          if (!inserted) throw new Error('INSERT email tes tidak mengembalikan baris');
          if (saved.length > 0) {
            await tx.insert(emailOutboundAttachments).values(
              saved.map((item, position) => ({
                organizationId: auth.organizationId,
                emailOutboundId: inserted.id,
                position,
                filename: item.part.filename,
                contentType: item.part.contentType,
                sizeBytes: item.sizeBytes,
                sha256: item.sha256,
                storageKey: item.storageKey,
                source: item.part.source,
                sourceHost: null,
                inline: item.part.inline,
                contentId: item.part.contentId,
              })),
            );
          }
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.emailTemplateTestSent,
            targetType: 'email_template',
            targetId: row.id,
            metadata: {
              templateId: row.id,
              slug: row.slug,
              which: input.which,
              version: source.state === 'draft' ? null : source.version,
              senderId: sender.id,
              actorRole: role,
            },
            client: context.client,
          });
          return inserted;
        });
        return await toEmailStatus(db, created);
      } catch (error) {
        await Promise.all(
          saved.map((item) => store.remove(item.storageKey).catch(() => undefined)),
        );
        throw error;
      }
    },

    async fromPreset(context, presetKey, input) {
      const preset = EMAIL_TEMPLATE_PRESETS.find((item) => item.key === presetKey);
      if (!preset) throw new AppError('NOT_FOUND', { message: 'Preset template tidak ditemukan.' });
      return insertTemplate(context, {
        name: input.name ?? preset.name,
        slug: input.slug ?? preset.key,
        description: preset.description,
        presetKey: preset.key,
        draft: {
          subject: preset.subject,
          html: preset.html,
          text: preset.text,
          variables: preset.variables.map((variable) => ({ ...variable })),
          layout: preset.layout,
          footerText: preset.footerText,
        },
      });
    },

    async published(organizationId) {
      const rows = await db
        .select({ template: emailTemplates, version: emailTemplateVersions })
        .from(emailTemplates)
        .innerJoin(
          emailTemplateVersions,
          and(
            eq(emailTemplateVersions.templateId, emailTemplates.id),
            eq(emailTemplateVersions.version, emailTemplates.publishedVersion),
          ),
        )
        .where(
          and(
            eq(emailTemplates.organizationId, organizationId),
            isNull(emailTemplates.archivedAt),
            isNotNull(emailTemplates.publishedVersion),
          ),
        )
        .orderBy(asc(emailTemplates.name));
      return rows.map(({ template, version }) => ({
        id: template.id,
        slug: template.slug,
        name: template.name,
        subject: version.subject,
        version: version.version,
        layout: version.layout === 'none' ? ('none' as const) : ('brand' as const),
        hasQrisSlot: scanTemplateVariables({
          subject: version.subject,
          html: version.html,
          text: version.text,
        }).used.includes('qris'),
        updatedAt: (version.publishedAt ?? version.createdAt).toISOString(),
        variables: version.variables,
      }));
    },
  };
}
