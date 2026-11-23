import multipart from '@fastify/multipart';
import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES,
  cancelMailOutboxResponseSchema,
  confirmMailVerificationRequestSchema,
  createMailDraftRequestSchema,
  createMailDraftResponseSchema,
  createMailIdentityRequestSchema,
  createMailSignatureRequestSchema,
  deleteMailDraftResponseSchema,
  deleteMailIdentityResponseSchema,
  errorEnvelopeSchema,
  mailAccountIdParamsSchema,
  mailComposeIdentityListResponseSchema,
  mailDraftAttachmentParamsSchema,
  mailDraftAttachmentQuerySchema,
  mailDraftAttachmentResponseSchema,
  mailDraftAttachmentsFromMessageRequestSchema,
  mailDraftAttachmentsFromMessageResponseSchema,
  mailDraftCheckResponseSchema,
  mailDraftIdParamsSchema,
  mailDraftListQuerySchema,
  mailDraftListResponseSchema,
  mailDraftResponseSchema,
  mailIdentityApprovalListResponseSchema,
  mailIdentityApprovalRequestSchema,
  mailIdentityIdParamsSchema,
  mailIdentityListResponseSchema,
  mailIdentityResponseSchema,
  mailIdentitySignatureQuerySchema,
  mailIdentitySignatureResponseSchema,
  mailOutboxIdParamsSchema,
  mailOutboxListQuerySchema,
  mailOutboxListResponseSchema,
  mailOutboxResponseSchema,
  mailPreferencesSchema,
  mailPresenceResponseSchema,
  mailRecipientSuggestQuerySchema,
  mailRecipientSuggestResponseSchema,
  mailSignatureIdParamsSchema,
  mailSignatureListResponseSchema,
  mailSignatureLogoQuerySchema,
  mailSignatureLogoResponseSchema,
  mailSignatureResponseSchema,
  mailSnippetRequestSchema,
  mailSnippetResponseSchema,
  mailSnippetsQuerySchema,
  mailSnippetsResponseSchema,
  mailVerificationResponseSchema,
  putMailSignatureLogoRequestSchema,
  sendMailDraftRequestSchema,
  updateMailDraftRequestSchema,
  updateMailDraftResponseSchema,
  updateMailIdentityRequestSchema,
  updateMailPreferencesRequestSchema,
  updateMailSignatureRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant, sessionPermissionScope } from '../auth/permission-grant';
import type { MailDraftsService } from './mail-drafts.service';
import { VERIFY_CODE_RULE, type MailIdentitiesService } from './mail-identities.service';
import type { MailOutboxService } from './mail-outbox.service';
import type { MailSignaturesService } from './mail-signatures.service';
import { MAIL_WRITE_RULE } from './mail.routes';
import type { MailContext } from './mail.service';

export interface MailComposeRoutesOptions {
  identities: MailIdentitiesService;
  signatures: MailSignaturesService;
  drafts: MailDraftsService;
  outbox: MailOutboxService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Batas permintaan per pengguna (KONTRAK-API-EMAIL-TULIS §12.2). */
export const MAIL_COMPOSE_RULES = {
  createDraft: { name: 'mail-draf-buat', limit: 30, windowSeconds: 60 },
  saveDraft: { name: 'mail-draf-simpan', limit: 120, windowSeconds: 60 },
  check: { name: 'mail-draf-cek', limit: 60, windowSeconds: 60 },
  send: { name: 'mail-kirim', limit: 20, windowSeconds: 60 },
  upload: { name: 'mail-unggah', limit: 20, windowSeconds: 60 },
  suggest: { name: 'mail-saran', limit: 120, windowSeconds: 60 },
  snippet: { name: 'mail-snippet', limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

const VIEW = requirePermission('mail.view');
const SEND = requirePermission('mail.send');
const MANAGE_ACCOUNTS = requirePermission('mail.accounts.manage');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  410: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  423: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

const BODY_LIMIT_BYTES = 32 * 1024;
const DRAFT_BODY_LIMIT_BYTES = 512 * 1024;
const LOGO_BODY_LIMIT_BYTES = 1_500_000;

const deletedSchema = z.object({ deleted: z.literal(true) });
const deletedWithVersionSchema = z.object({
  deleted: z.literal(true),
  draft: z.object({ version: z.number().int().positive() }),
});

/**
 * Rute jendela tulis menu Email (tahap 9B, docs/KONTRAK-API-EMAIL-TULIS.md). Izin rute: `mail.view`
 * (baca identitas/tanda tangan/preferensi) atau `mail.send` (draf, kirim, outbox, snippet); hak NYATA
 * per akun di service (`resolveMailAccess`, dibaca segar). Semua tulis lewat CSRF (hook auth).
 * Draf/outbox/preferensi PRIBADI pembuatnya — orang lain (termasuk Owner) 404.
 */
export const mailComposeRoutes: FastifyPluginAsyncZod<MailComposeRoutesOptions> = async (
  app,
  options,
) => {
  const { identities, signatures, drafts, outbox, limiter, cookieSecure } = options;
  const routes = API_ROUTES.mail;
  const contextOf = (request: FastifyRequest): MailContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });
  const limit = (rule: RateLimitRule, key: string) =>
    enforceRateLimit(
      limiter,
      rule,
      key,
      (wait) => `Terlalu banyak permintaan. Coba lagi dalam ${wait}.`,
    );
  /** Cakupan `contacts.view` pemanggil (tanpa audit penolakan bila perannya tidak memegangnya). */
  const contactsGrantOf = async (request: FastifyRequest) =>
    sessionPermissionScope(requireAuth(request), 'contacts.view') === null
      ? null
      : permissionGrant(request, 'contacts.view');

  // Multipart HANYA di plugin ini (unggah lampiran draf).
  await app.register(multipart, {
    limits: {
      fileSize: MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES,
      files: 1,
      fields: 2,
      parts: 3,
      fieldNameSize: 32,
      fieldSize: 16,
    },
  });

  // ── Identitas (§3) ────────────────────────────────────────────────────

  app.get(
    routes.composeIdentities,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailComposeIdentityListResponseSchema, ...errors } },
    },
    (request) => identities.composeIdentities(requireAuth(request)),
  );

  app.get(
    routes.accountIdentities,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailIdentityListResponseSchema, ...errors },
      },
    },
    (request) => identities.accountIdentities(requireAuth(request), request.params.accountId),
  );

  app.post(
    routes.accountIdentities,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailAccountIdParamsSchema,
        body: createMailIdentityRequestSchema,
        response: { 201: mailIdentityResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      const identity = await identities.create(
        auth,
        request.params.accountId,
        request.body,
        contextOf(request),
      );
      return reply.code(201).send({ identity });
    },
  );

  app.patch(
    routes.identity,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailIdentityIdParamsSchema,
        body: updateMailIdentityRequestSchema,
        response: { 200: mailIdentityResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return {
        identity: await identities.update(
          auth,
          request.params.identityId,
          request.body,
          contextOf(request),
        ),
      };
    },
  );

  app.delete(
    routes.identity,
    {
      config: { access: VIEW },
      schema: {
        params: mailIdentityIdParamsSchema,
        response: { 200: deleteMailIdentityResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return identities.remove(auth, request.params.identityId, contextOf(request));
    },
  );

  app.post(
    routes.identityVerification,
    {
      config: { access: VIEW },
      schema: {
        params: mailIdentityIdParamsSchema,
        response: { 202: mailVerificationResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      const result = await identities.startVerification(
        auth,
        request.params.identityId,
        contextOf(request),
      );
      return reply.code(202).send(result);
    },
  );

  app.post(
    routes.identityVerificationConfirm,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailIdentityIdParamsSchema,
        body: confirmMailVerificationRequestSchema,
        response: { 200: mailIdentityResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(VERIFY_CODE_RULE, auth.user.id);
      return identities.confirm(
        auth,
        request.params.identityId,
        request.body.code,
        contextOf(request),
      );
    },
  );

  // Review 9B S3: persetujuan identitas akun pribadi berdomain organisasi (Owner/Admin).
  app.get(
    routes.identityApprovals,
    {
      config: { access: MANAGE_ACCOUNTS },
      schema: { response: { 200: mailIdentityApprovalListResponseSchema, ...errors } },
    },
    (request) => identities.approvals(requireAuth(request), contextOf(request)),
  );

  app.post(
    routes.identityApproval,
    {
      config: { access: MANAGE_ACCOUNTS },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailIdentityIdParamsSchema,
        body: mailIdentityApprovalRequestSchema,
        response: { 200: mailIdentityResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return {
        identity: await identities.decideApproval(
          auth,
          request.params.identityId,
          request.body,
          contextOf(request),
        ),
      };
    },
  );

  app.get(
    routes.identitySignature,
    {
      config: { access: SEND },
      schema: {
        params: mailIdentityIdParamsSchema,
        querystring: mailIdentitySignatureQuerySchema,
        response: { 200: mailIdentitySignatureResponseSchema, ...errors },
      },
    },
    (request) =>
      signatures.identitySignature(
        requireAuth(request),
        request.params.identityId,
        request.query.purpose,
        contextOf(request),
      ),
  );

  // ── Tanda tangan (§4) ─────────────────────────────────────────────────

  app.get(
    routes.accountSignatures,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailSignatureListResponseSchema, ...errors },
      },
    },
    (request) =>
      signatures.list(requireAuth(request), request.params.accountId, contextOf(request)),
  );

  app.post(
    routes.accountSignatures,
    {
      config: { access: VIEW },
      bodyLimit: 64 * 1024,
      schema: {
        params: mailAccountIdParamsSchema,
        body: createMailSignatureRequestSchema,
        response: { 201: mailSignatureResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      const signature = await signatures.create(
        auth,
        request.params.accountId,
        request.body,
        contextOf(request),
      );
      return reply.code(201).send({ signature });
    },
  );

  app.patch(
    routes.signature,
    {
      config: { access: VIEW },
      bodyLimit: 64 * 1024,
      schema: {
        params: mailSignatureIdParamsSchema,
        body: updateMailSignatureRequestSchema,
        response: { 200: mailSignatureResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return {
        signature: await signatures.update(
          auth,
          request.params.signatureId,
          request.body,
          contextOf(request),
        ),
      };
    },
  );

  app.delete(
    routes.signature,
    {
      config: { access: VIEW },
      schema: {
        params: mailSignatureIdParamsSchema,
        response: { 200: deletedSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return signatures.remove(auth, request.params.signatureId, contextOf(request));
    },
  );

  app.put(
    routes.signatureLogo,
    {
      config: { access: VIEW },
      bodyLimit: LOGO_BODY_LIMIT_BYTES,
      schema: {
        params: mailSignatureIdParamsSchema,
        body: putMailSignatureLogoRequestSchema,
        response: { 200: mailSignatureLogoResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return signatures.putLogo(
        auth,
        request.params.signatureId,
        request.body.image,
        contextOf(request),
      );
    },
  );

  app.delete(
    routes.signatureLogo,
    {
      config: { access: VIEW },
      schema: {
        params: mailSignatureIdParamsSchema,
        response: { 200: mailSignatureLogoResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return signatures.deleteLogo(auth, request.params.signatureId, contextOf(request));
    },
  );

  app.get(
    routes.signatureLogo,
    {
      config: { access: VIEW, rawResponse: true },
      schema: { params: mailSignatureIdParamsSchema, querystring: mailSignatureLogoQuerySchema },
    },
    async (request, reply) => {
      const image = await signatures.logo(
        requireAuth(request),
        request.params.signatureId,
        contextOf(request),
      );
      const etag = `"${image.sha256.slice(0, 32)}"`;
      void reply.headers({
        etag,
        'cache-control': request.query.v
          ? 'private, max-age=31536000, immutable'
          : 'private, max-age=300',
        'content-disposition': 'inline; filename="logo-tanda-tangan.png"',
        'x-content-type-options': 'nosniff',
      });
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.type('image/png').send(image.data);
    },
  );

  // ── Preferensi (§5) ───────────────────────────────────────────────────

  app.get(
    routes.preferences,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailPreferencesSchema, ...errors } },
    },
    (request) => signatures.preferences(requireAuth(request)),
  );

  app.put(
    routes.preferences,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: updateMailPreferencesRequestSchema,
        response: { 200: mailPreferencesSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_WRITE_RULE, auth.user.id);
      return signatures.updatePreferences(auth, request.body);
    },
  );

  // ── Draf (§6) ─────────────────────────────────────────────────────────

  app.get(
    routes.drafts,
    {
      config: { access: SEND },
      schema: {
        querystring: mailDraftListQuerySchema,
        response: { 200: mailDraftListResponseSchema, ...errors },
      },
    },
    (request) => drafts.list(requireAuth(request), request.query),
  );

  app.post(
    routes.drafts,
    {
      config: { access: SEND },
      bodyLimit: DRAFT_BODY_LIMIT_BYTES,
      schema: {
        body: createMailDraftRequestSchema,
        response: { 201: createMailDraftResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.createDraft, auth.user.id);
      return reply.code(201).send(await drafts.create(auth, request.body, contextOf(request)));
    },
  );

  app.get(
    routes.draft,
    {
      config: { access: SEND },
      schema: {
        params: mailDraftIdParamsSchema,
        response: { 200: mailDraftResponseSchema, ...errors },
      },
    },
    (request) => drafts.get(requireAuth(request), request.params.draftId, contextOf(request)),
  );

  app.put(
    routes.draft,
    {
      config: { access: SEND },
      bodyLimit: DRAFT_BODY_LIMIT_BYTES,
      schema: {
        params: mailDraftIdParamsSchema,
        body: updateMailDraftRequestSchema,
        response: { 200: updateMailDraftResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.saveDraft, auth.user.id);
      return drafts.update(auth, request.params.draftId, request.body, contextOf(request));
    },
  );

  app.delete(
    routes.draft,
    {
      config: { access: SEND },
      schema: {
        params: mailDraftIdParamsSchema,
        response: { 200: deleteMailDraftResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.saveDraft, auth.user.id);
      return drafts.remove(auth, request.params.draftId);
    },
  );

  app.post(
    routes.draftCheck,
    {
      config: { access: SEND },
      schema: {
        params: mailDraftIdParamsSchema,
        response: { 200: mailDraftCheckResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.check, auth.user.id);
      return drafts.check(
        auth,
        request.params.draftId,
        contextOf(request),
        await contactsGrantOf(request),
      );
    },
  );

  app.post(
    routes.draftSend,
    {
      config: { access: SEND },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailDraftIdParamsSchema,
        body: sendMailDraftRequestSchema,
        response: { 200: mailOutboxResponseSchema, 202: mailOutboxResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.send, auth.user.id);
      const { status, ...body } = await outbox.send(
        auth,
        request.params.draftId,
        request.body,
        contextOf(request),
      );
      return reply.code(status).send(body);
    },
  );

  for (const [method, active] of [
    ['put', true],
    ['delete', false],
  ] as const) {
    app[method](
      routes.draftPresence,
      {
        config: { access: SEND },
        schema: {
          params: mailDraftIdParamsSchema,
          response: { 200: mailPresenceResponseSchema, ...errors },
        },
      },
      (request) =>
        drafts.presence(requireAuth(request), request.params.draftId, active, contextOf(request)),
    );
  }

  app.post(
    routes.draftSnippet,
    {
      config: { access: SEND },
      bodyLimit: 128 * 1024,
      schema: {
        params: mailDraftIdParamsSchema,
        body: mailSnippetRequestSchema,
        response: { 200: mailSnippetResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.snippet, auth.user.id);
      return drafts.snippet(
        auth,
        request.params.draftId,
        request.body,
        contextOf(request),
        await contactsGrantOf(request),
      );
    },
  );

  // ── Lampiran draf (§8) ────────────────────────────────────────────────

  app.post(
    routes.draftAttachments,
    {
      config: { access: SEND },
      schema: {
        params: mailDraftIdParamsSchema,
        querystring: z.object({ inline: z.enum(['1', 'true']).optional() }),
        response: { 201: mailDraftAttachmentResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.upload, auth.user.id);
      if (!request.isMultipart()) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Kirim berkas sebagai multipart/form-data (isian "file").',
        });
      }
      let part;
      try {
        part = await request.file();
      } catch {
        throw new AppError('BAD_REQUEST', { message: 'Berkas tidak bisa dibaca.' });
      }
      if (!part || part.fieldname !== 'file') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Pilih satu berkas untuk dilampirkan.',
          details: [{ location: 'body', field: 'file', message: 'Berkas wajib diisi.' }],
        });
      }
      const field = part.fields.inline as { value?: unknown } | undefined;
      const inline =
        request.query.inline !== undefined ||
        (field !== undefined && (field.value === 'true' || field.value === '1'));
      const file = part.file;
      const result = await drafts.upload(
        auth,
        request.params.draftId,
        { stream: file, filename: part.filename || null, truncated: () => file.truncated },
        inline,
        contextOf(request),
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    routes.draftAttachmentsFromMessage,
    {
      config: { access: SEND },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailDraftIdParamsSchema,
        body: mailDraftAttachmentsFromMessageRequestSchema,
        response: { 200: mailDraftAttachmentsFromMessageResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.upload, auth.user.id);
      return drafts.attachFromMessage(
        auth,
        request.params.draftId,
        request.body.attachmentIds,
        contextOf(request),
      );
    },
  );

  app.get(
    routes.draftAttachment,
    {
      config: { access: SEND, rawResponse: true },
      schema: {
        params: mailDraftAttachmentParamsSchema,
        querystring: mailDraftAttachmentQuerySchema,
      },
    },
    async (request, reply) => {
      const file = await drafts.attachmentFile(
        requireAuth(request),
        request.params.draftId,
        request.params.attachmentId,
      );
      const preview =
        request.query.preview === '1' &&
        file.row.inline &&
        file.row.contentType.startsWith('image/');
      const ascii = file.row.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      void reply.headers({
        'content-length': String(file.sizeBytes),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'content-disposition': `${preview ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.row.filename)}`,
      });
      return reply
        .type(preview ? file.row.contentType : 'application/octet-stream')
        .send(file.stream);
    },
  );

  app.delete(
    routes.draftAttachment,
    {
      config: { access: SEND },
      schema: {
        params: mailDraftAttachmentParamsSchema,
        response: { 200: deletedWithVersionSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.saveDraft, auth.user.id);
      return drafts.removeAttachment(
        auth,
        request.params.draftId,
        request.params.attachmentId,
        contextOf(request),
      );
    },
  );

  // ── Outbox (§9.2) ─────────────────────────────────────────────────────

  app.get(
    routes.outbox,
    {
      config: { access: SEND },
      schema: {
        querystring: mailOutboxListQuerySchema,
        response: { 200: mailOutboxListResponseSchema, ...errors },
      },
    },
    (request) => outbox.list(requireAuth(request), request.query.state),
  );

  app.get(
    routes.outboxItem,
    {
      config: { access: SEND },
      schema: {
        params: mailOutboxIdParamsSchema,
        response: { 200: mailOutboxResponseSchema, ...errors },
      },
    },
    (request) => outbox.get(requireAuth(request), request.params.outboxId),
  );

  app.post(
    routes.outboxCancel,
    {
      config: { access: SEND },
      schema: {
        params: mailOutboxIdParamsSchema,
        response: { 200: cancelMailOutboxResponseSchema, ...errors },
      },
    },
    (request) => outbox.cancel(requireAuth(request), request.params.outboxId),
  );

  app.post(
    routes.outboxSendNow,
    {
      config: { access: SEND },
      schema: {
        params: mailOutboxIdParamsSchema,
        response: { 200: mailOutboxResponseSchema, ...errors },
      },
    },
    (request) => outbox.sendNow(requireAuth(request), request.params.outboxId),
  );

  // ── Snippet & saran (§10) ─────────────────────────────────────────────

  app.get(
    routes.composeSnippets,
    {
      config: { access: SEND },
      schema: {
        querystring: mailSnippetsQuerySchema,
        response: { 200: mailSnippetsResponseSchema, ...errors },
      },
    },
    (request) => drafts.snippets(requireAuth(request), request.query.q),
  );

  app.get(
    routes.recipientSuggest,
    {
      config: { access: VIEW },
      schema: {
        querystring: mailRecipientSuggestQuerySchema,
        response: { 200: mailRecipientSuggestResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_COMPOSE_RULES.suggest, auth.user.id);
      return drafts.suggest(auth, request.query, await contactsGrantOf(request));
    },
  );
};
