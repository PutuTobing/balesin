import { fillSignatureVariables, htmlToText, sanitizeComposerHtml } from '@balesin/core';
import {
  mailIdentities,
  mailSignatures,
  mailUserPreferences,
  type Database,
  type DbExecutor,
  type MailAccountRow,
  type MailSignatureChoicesRow,
  type MailSignatureRow,
} from '@balesin/db';
import {
  API_ROUTES,
  MAIL_COMPOSE_MESSAGES,
  MAIL_SIGNATURES_PERSONAL_MAX,
  MAIL_SIGNATURES_SHARED_MAX,
  MAIL_SIGNATURE_HTML_MAX_BYTES,
  MAIL_SIGNATURE_TEXT_MAX_BYTES,
  MAIL_UNDO_SEND_SECONDS,
  apiPath,
  mailLevelAtLeast,
  unknownSignatureVariables,
  type CreateMailSignatureRequest,
  type MailPreferences,
  type MailSignature,
  type UpdateMailPreferencesRequest,
  type UpdateMailSignatureRequest,
} from '@balesin/shared';
import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';

import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import type { AccessDeniedRecorder } from '../auth/access-denied';
import type { AuthContext } from '../auth/session.service';
import { riskyAdditions } from '../quick-replies/quick-replies.service';
import { createComposeAccess } from './mail-compose-access';
import { composeNotFound, detailError, loadIdentity } from './mail-compose.repo';
import { processSignatureLogo } from './mail-avatar';
import { isUuid } from './mail.repo';
import type { MailContext } from './mail.service';

/**
 * Tanda tangan & preferensi tulis (KONTRAK-API-EMAIL-TULIS §4–§5).
 *  - BERSAMA (per akun; `owner_user_id` null): lihat = `read`; ubah = level `manage`; diaudit.
 *  - PRIBADI (per pengguna per akun): pemiliknya, level ≥ `send`; tidak diaudit; orang lain → 404.
 *  - HTML lewat profil editor (tanpa gambar kecuali `{{logo}}`), variabel di daftar izin (lainnya
 *    400 `signature_variable_unknown`), diisi & di-escape saat disisipkan.
 *  - Preferensi = PRIBADI pengguna (ID identitas/tanda tangan yang tidak boleh dipakai → 400).
 */

const SIGNATURE_NOT_FOUND = 'Tanda tangan tidak ditemukan.';

function logoUrlOf(row: Pick<MailSignatureRow, 'id' | 'logoSha256'>): string | null {
  return row.logoSha256
    ? `${apiPath(API_ROUTES.mail.signatureLogo, { signatureId: row.id })}?v=${row.logoSha256.slice(0, 8)}`
    : null;
}

/** Lebar PNG dari IHDR (byte 16–19). */
export function pngWidthOf(data: Buffer | null): number {
  if (!data || data.length < 24) return 0;
  return data.readUInt32BE(16);
}

export function createMailSignaturesService(deps: {
  db: Database;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const access = createComposeAccess({ db, accessDenied: deps.accessDenied });

  function toView(row: MailSignatureRow, editable: boolean): MailSignature {
    return {
      id: row.id,
      accountId: row.accountId,
      scope: row.ownerUserId ? 'personal' : 'shared',
      name: row.name,
      html: row.html,
      text: row.text,
      logoUrl: logoUrlOf(row),
      editable,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** HTML tanda tangan: variabel dikenal + profil editor (gambar hanya lewat `{{logo}}`). */
  function cleanHtml(html: string): { html: string; text: string } {
    const unknown = unknownSignatureVariables(html);
    if (unknown.length > 0) {
      throw detailError(
        'VALIDATION_ERROR',
        'signature_variable_unknown',
        MAIL_COMPOSE_MESSAGES.signatureVariableUnknown(unknown[0] ?? ''),
        'html',
      );
    }
    const clean = sanitizeComposerHtml(html, { allowedCids: new Set() });
    if (clean.tooComplex || Buffer.byteLength(clean.html, 'utf8') > MAIL_SIGNATURE_HTML_MAX_BYTES) {
      throw detailError(
        'VALIDATION_ERROR',
        'content_too_large',
        'Tanda tangan maksimal 32 KB.',
        'html',
      );
    }
    let text = htmlToText(clean.html);
    if (Buffer.byteLength(text, 'utf8') > MAIL_SIGNATURE_TEXT_MAX_BYTES) {
      text = Buffer.from(text, 'utf8').subarray(0, MAIL_SIGNATURE_TEXT_MAX_BYTES).toString('utf8');
    }
    return { html: clean.html, text };
  }

  /** Tanda tangan + akunnya; pribadi orang lain → 404. `write` = hak ubah sesuai jenisnya. */
  async function loadSignature(
    auth: AuthContext,
    signatureId: string,
    context: MailContext,
    mode: 'read' | 'write',
  ) {
    if (!isUuid(signatureId)) throw composeNotFound(SIGNATURE_NOT_FOUND);
    const [row] = await db
      .select()
      .from(mailSignatures)
      .where(
        and(
          eq(mailSignatures.organizationId, auth.organizationId),
          eq(mailSignatures.id, signatureId),
        ),
      )
      .limit(1);
    if (!row) throw composeNotFound(SIGNATURE_NOT_FOUND);
    if (row.ownerUserId && row.ownerUserId !== auth.user.id) {
      throw composeNotFound(SIGNATURE_NOT_FOUND);
    }
    const minimum = row.ownerUserId ? 'send' : mode === 'write' ? 'manage' : 'read';
    const loaded = await access.require(auth, row.accountId, minimum, context.client);
    return { row, account: loaded.row, level: loaded.level };
  }

  async function auditShared(
    executor: DbExecutor,
    auth: AuthContext,
    account: MailAccountRow,
    action:
      | typeof AUDIT_ACTIONS.mailSignatureCreated
      | typeof AUDIT_ACTIONS.mailSignatureUpdated
      | typeof AUDIT_ACTIONS.mailSignatureDeleted,
    signature: Pick<MailSignatureRow, 'id' | 'name'>,
    context: MailContext,
    extra: Record<string, unknown> = {},
  ) {
    await recordAudit(executor, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action,
      targetType: 'mail_account',
      targetId: account.id,
      metadata: {
        accountId: account.id,
        signatureId: signature.id,
        name: signature.name,
        actorRole: auth.user.role,
        ...extra,
      },
      client: context.client,
    });
  }

  async function preferencesRow(executor: DbExecutor, auth: AuthContext) {
    const [row] = await executor
      .select()
      .from(mailUserPreferences)
      .where(
        and(
          eq(mailUserPreferences.organizationId, auth.organizationId),
          eq(mailUserPreferences.userId, auth.user.id),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  const service = {
    async list(auth: AuthContext, accountId: string, context: MailContext) {
      const { row: account, level } = await access.require(auth, accountId, 'read', context.client);
      const rows = await db
        .select()
        .from(mailSignatures)
        .where(
          and(
            eq(mailSignatures.organizationId, auth.organizationId),
            eq(mailSignatures.accountId, account.id),
            or(isNull(mailSignatures.ownerUserId), eq(mailSignatures.ownerUserId, auth.user.id)),
          ),
        )
        .orderBy(mailSignatures.name);
      const canSend = mailLevelAtLeast(level, 'send');
      return {
        shared: rows
          .filter((row) => row.ownerUserId === null)
          .map((row) => toView(row, mailLevelAtLeast(level, 'manage'))),
        mine: canSend
          ? rows.filter((row) => row.ownerUserId !== null).map((row) => toView(row, true))
          : [],
      };
    },

    async create(
      auth: AuthContext,
      accountId: string,
      input: CreateMailSignatureRequest,
      context: MailContext,
    ): Promise<MailSignature> {
      const shared = input.scope === 'shared';
      const { row: account } = await access.require(
        auth,
        accountId,
        shared ? 'manage' : 'send',
        context.client,
      );
      const clean = cleanHtml(input.html);
      const row = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ value: count() })
          .from(mailSignatures)
          .where(
            and(
              eq(mailSignatures.organizationId, auth.organizationId),
              eq(mailSignatures.accountId, account.id),
              shared
                ? isNull(mailSignatures.ownerUserId)
                : eq(mailSignatures.ownerUserId, auth.user.id),
            ),
          );
        const max = shared ? MAIL_SIGNATURES_SHARED_MAX : MAIL_SIGNATURES_PERSONAL_MAX;
        if ((existing?.value ?? 0) >= max) {
          throw detailError(
            'CONFLICT',
            'signature_limit',
            `Maksimal ${String(max)} tanda tangan ${shared ? 'bersama per akun' : 'pribadi per akun'}.`,
            'scope',
          );
        }
        const [inserted] = await tx
          .insert(mailSignatures)
          .values({
            organizationId: auth.organizationId,
            accountId: account.id,
            ownerUserId: shared ? null : auth.user.id,
            name: input.name,
            html: clean.html,
            text: clean.text,
            createdByUserId: auth.user.id,
            updatedByUserId: auth.user.id,
          })
          .returning();
        if (!inserted) throw new Error('Tanda tangan tidak tersimpan');
        if (shared) {
          const risky = riskyAdditions('', clean.text);
          await auditShared(
            tx,
            auth,
            account,
            AUDIT_ACTIONS.mailSignatureCreated,
            inserted,
            context,
            {
              risky: auth.user.role !== 'owner' && risky.links + risky.numbers > 0,
            },
          );
        }
        return inserted;
      });
      return toView(row, true);
    },

    async update(
      auth: AuthContext,
      signatureId: string,
      input: UpdateMailSignatureRequest,
      context: MailContext,
    ): Promise<MailSignature> {
      const { row, account } = await loadSignature(auth, signatureId, context, 'write');
      const changes: Partial<MailSignatureRow> = { updatedByUserId: auth.user.id };
      const changedFields: string[] = [];
      if (input.name !== undefined && input.name !== row.name) {
        changes.name = input.name;
        changedFields.push('name');
      }
      let risky = false;
      if (input.html !== undefined) {
        const clean = cleanHtml(input.html);
        if (clean.html !== row.html) {
          changes.html = clean.html;
          changes.text = clean.text;
          changedFields.push('html');
          const added = riskyAdditions(row.text, clean.text);
          risky = auth.user.role !== 'owner' && added.links + added.numbers > 0;
        }
      }
      if (changedFields.length === 0) return toView(row, true);
      const saved = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(mailSignatures)
          .set(changes)
          .where(
            and(
              eq(mailSignatures.organizationId, auth.organizationId),
              eq(mailSignatures.id, row.id),
            ),
          )
          .returning();
        if (!updated) throw composeNotFound(SIGNATURE_NOT_FOUND);
        if (!row.ownerUserId) {
          await auditShared(
            tx,
            auth,
            account,
            AUDIT_ACTIONS.mailSignatureUpdated,
            updated,
            context,
            {
              changedFields,
              risky,
            },
          );
        }
        return updated;
      });
      return toView(saved, true);
    },

    async remove(auth: AuthContext, signatureId: string, context: MailContext) {
      const { row, account } = await loadSignature(auth, signatureId, context, 'write');
      await db.transaction(async (tx) => {
        // Bawaan identitas yang merujuknya → null (FK `set null`).
        await tx
          .delete(mailSignatures)
          .where(
            and(
              eq(mailSignatures.organizationId, auth.organizationId),
              eq(mailSignatures.id, row.id),
            ),
          );
        if (!row.ownerUserId) {
          await auditShared(tx, auth, account, AUDIT_ACTIONS.mailSignatureDeleted, row, context);
        }
      });
      return { deleted: true as const };
    },

    async putLogo(auth: AuthContext, signatureId: string, image: string, context: MailContext) {
      const { row, account } = await loadSignature(auth, signatureId, context, 'write');
      const logo = await processSignatureLogo(image);
      const saved = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(mailSignatures)
          .set({ logoPng: logo.data, logoSha256: logo.sha256, updatedByUserId: auth.user.id })
          .where(
            and(
              eq(mailSignatures.organizationId, auth.organizationId),
              eq(mailSignatures.id, row.id),
            ),
          )
          .returning();
        if (!updated) throw composeNotFound(SIGNATURE_NOT_FOUND);
        if (!row.ownerUserId) {
          await auditShared(
            tx,
            auth,
            account,
            AUDIT_ACTIONS.mailSignatureUpdated,
            updated,
            context,
            {
              changedFields: ['logo'],
            },
          );
        }
        return updated;
      });
      return { logoUrl: logoUrlOf(saved) };
    },

    async deleteLogo(auth: AuthContext, signatureId: string, context: MailContext) {
      const { row } = await loadSignature(auth, signatureId, context, 'write');
      await db
        .update(mailSignatures)
        .set({ logoPng: null, logoSha256: null, updatedByUserId: auth.user.id })
        .where(
          and(
            eq(mailSignatures.organizationId, auth.organizationId),
            eq(mailSignatures.id, row.id),
          ),
        );
      return { logoUrl: null };
    },

    async logo(auth: AuthContext, signatureId: string, context: MailContext) {
      const { row } = await loadSignature(auth, signatureId, context, 'read');
      if (!row.logoPng || !row.logoSha256) throw composeNotFound('Logo tidak ditemukan.');
      return { data: row.logoPng, sha256: row.logoSha256 };
    },

    /**
     * Pilihan efektif (pengguna, identitas, tujuan): preferensi pribadi → bawaan identitas → tanpa.
     * ID yang tidak lagi sah (dihapus / bukan milik akun ini / pribadi orang lain) diabaikan.
     */
    async effectiveSignature(
      executor: DbExecutor,
      auth: AuthContext,
      identity: {
        id: string;
        accountId: string;
        defaultSignatureNewId: string | null;
        defaultSignatureReplyId: string | null;
      },
      purpose: 'new' | 'reply',
    ): Promise<MailSignatureRow | null> {
      const preferences = await preferencesRow(executor, auth);
      const choice = preferences?.signatureChoices[identity.id]?.[purpose];
      if (choice === 'none') return null;
      const candidates = [
        ...(typeof choice === 'string' ? [choice] : []),
        ...(purpose === 'new'
          ? [identity.defaultSignatureNewId]
          : [identity.defaultSignatureReplyId]),
      ].filter((id): id is string => typeof id === 'string' && isUuid(id));
      if (candidates.length === 0) return null;
      const rows = await executor
        .select()
        .from(mailSignatures)
        .where(
          and(
            eq(mailSignatures.organizationId, auth.organizationId),
            eq(mailSignatures.accountId, identity.accountId),
            inArray(mailSignatures.id, candidates),
            or(isNull(mailSignatures.ownerUserId), eq(mailSignatures.ownerUserId, auth.user.id)),
          ),
        );
      for (const id of candidates) {
        const found = rows.find((row) => row.id === id);
        if (found) return found;
      }
      return null;
    },

    /** Blok tanda tangan siap sisip (`<div data-signature>`, variabel terisi & di-escape). */
    renderSignature(
      signature: MailSignatureRow | null,
      values: { agentName: string; senderAddress: string; organizationName: string },
    ): { signatureId: string | null; html: string; text: string } {
      if (!signature) return { signatureId: null, html: '', text: '' };
      const filled = fillSignatureVariables(signature.html, {
        ...values,
        logo: signature.logoPng
          ? { signatureId: signature.id, width: pngWidthOf(signature.logoPng) }
          : null,
      });
      const text = fillSignatureVariables(signature.text, { ...values, logo: null });
      return {
        signatureId: signature.id,
        html: `<div data-signature="${signature.id}">${filled}</div>`,
        text,
      };
    },

    async identitySignature(
      auth: AuthContext,
      identityId: string,
      purpose: 'new' | 'reply',
      context: MailContext,
    ) {
      if (!isUuid(identityId)) throw composeNotFound();
      const identity = await loadIdentity(db, auth.organizationId, identityId);
      if (!identity) throw composeNotFound();
      await access.require(auth, identity.accountId, 'send', context.client);
      const signature = await service.effectiveSignature(db, auth, identity, purpose);
      return service.renderSignature(signature, {
        agentName: auth.user.name,
        senderAddress: identity.address,
        organizationName: auth.organization.name,
      });
    },

    async preferences(auth: AuthContext): Promise<MailPreferences> {
      const row = await preferencesRow(db, auth);
      return {
        undoSendSeconds: row?.undoSendSeconds ?? MAIL_UNDO_SEND_SECONDS.default,
        composeFormat: (row?.composeFormat as 'html' | 'text' | undefined) ?? 'html',
        signatureChoices: row?.signatureChoices ?? {},
      };
    },

    async updatePreferences(
      auth: AuthContext,
      input: UpdateMailPreferencesRequest,
    ): Promise<MailPreferences> {
      const current = await service.preferences(auth);
      const next: MailPreferences = { ...current, ...input };
      if (input.signatureChoices) {
        // Identitas harus yang bisa kupakai (level ≥ send); tanda tangan bersama akun itu / milikku.
        const identityIds = Object.keys(input.signatureChoices);
        const signatureIds = Object.values(input.signatureChoices)
          .flatMap((choice) => [choice.new, choice.reply])
          .filter((id): id is string => typeof id === 'string' && id !== 'none');
        const identities = identityIds.length
          ? await db
              .select({ id: mailIdentities.id, accountId: mailIdentities.accountId })
              .from(mailIdentities)
              .where(
                and(
                  eq(mailIdentities.organizationId, auth.organizationId),
                  inArray(mailIdentities.id, identityIds),
                ),
              )
          : [];
        const accountOf = new Map(identities.map((row) => [row.id, row.accountId]));
        for (const id of identityIds) {
          const accountId = accountOf.get(id);
          if (!accountId) {
            throw detailError(
              'VALIDATION_ERROR',
              'identity_not_found',
              'Identitas tidak ditemukan.',
              'signatureChoices',
            );
          }
          const loaded = await access.load(auth, accountId).catch(() => null);
          if (!loaded || !mailLevelAtLeast(loaded.level, 'send')) {
            throw detailError(
              'VALIDATION_ERROR',
              'identity_not_found',
              'Identitas tidak ditemukan.',
              'signatureChoices',
            );
          }
        }
        const signatures = signatureIds.length
          ? await db
              .select({
                id: mailSignatures.id,
                accountId: mailSignatures.accountId,
                ownerUserId: mailSignatures.ownerUserId,
              })
              .from(mailSignatures)
              .where(
                and(
                  eq(mailSignatures.organizationId, auth.organizationId),
                  inArray(mailSignatures.id, signatureIds),
                ),
              )
          : [];
        for (const [identityId, choice] of Object.entries(input.signatureChoices)) {
          for (const value of [choice.new, choice.reply]) {
            if (typeof value !== 'string' || value === 'none') continue;
            const signature = signatures.find((row) => row.id === value);
            if (
              !signature ||
              signature.accountId !== accountOf.get(identityId) ||
              (signature.ownerUserId !== null && signature.ownerUserId !== auth.user.id)
            ) {
              throw detailError(
                'VALIDATION_ERROR',
                'signature_not_found',
                SIGNATURE_NOT_FOUND,
                'signatureChoices',
              );
            }
          }
        }
      }
      const choices = next.signatureChoices as MailSignatureChoicesRow;
      await db
        .insert(mailUserPreferences)
        .values({
          userId: auth.user.id,
          organizationId: auth.organizationId,
          undoSendSeconds: next.undoSendSeconds,
          composeFormat: next.composeFormat,
          signatureChoices: choices,
        })
        .onConflictDoUpdate({
          target: mailUserPreferences.userId,
          set: {
            undoSendSeconds: next.undoSendSeconds,
            composeFormat: next.composeFormat,
            signatureChoices: choices,
            updatedAt: now(),
          },
        });
      return next;
    },
  };
  return service;
}

export type MailSignaturesService = ReturnType<typeof createMailSignaturesService>;
