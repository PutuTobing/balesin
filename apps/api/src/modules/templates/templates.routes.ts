import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  TEMPLATE_PRESETS,
  createFromPresetRequestSchema,
  createTemplateRequestSchema,
  errorEnvelopeSchema,
  messageResponseSchema,
  startConversationRequestSchema,
  syncTemplatesRequestSchema,
  syncTemplatesResponseSchema,
  templateIdParamsSchema,
  templateListQuerySchema,
  templateListResponseSchema,
  templatePresetListResponseSchema,
  templatePresetParamsSchema,
  templateResponseSchema,
  updateTemplateRequestSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { normalizeWhatsappNumber } from '../compat-mobichat/mobichat.service';
import type { ContactsService } from '../contacts/contacts.service';
import { toMessage } from '../inbox/inbox-view';
import { SEND_ORGANIZATION_RULE, SEND_USER_RULE } from '../messages/outbound.routes';
import type { OutboundService } from '../messages/outbound.service';
import type { TemplatesService } from './templates.service';

export interface TemplatesRoutesOptions {
  templates: TemplatesService;
  outbound: OutboundService;
  contacts: Pick<ContactsService, 'createFromApi'>;
  limiter: RateLimiter;
}

/**
 * Template Meta + mulai percakapan dengan template (Fase 4, docs/KONTRAK-API-TEMPLATE.md). Tulis =
 * CSRF (hook auth). PRD §4: daftar/detail = `inbox.reply`; kelola = `templates.manage`; mulai
 * percakapan ke nomor baru = `inbox.initiate` + batas harian per pengguna.
 */
const WRITE_RULE: RateLimitRule = { name: 'template-tulis', limit: 60, windowSeconds: 60 };
const SYNC_RULE: RateLimitRule = { name: 'template-sinkron', limit: 6, windowSeconds: 60 };
/** Mulai percakapan baru: maks. 200 per pengguna per 24 jam (selain batas kirim harian biasa). */
export const INITIATE_USER_RULE: RateLimitRule = {
  name: 'mulai-percakapan',
  limit: 200,
  windowSeconds: 24 * 60 * 60,
};
const MANAGE = requirePermission('templates.manage');
const VIEW = requirePermission('inbox.reply');
const UUID = z.uuid();

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  423: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  502: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

function idOf(value: string): string {
  if (!UUID.safeParse(value).success) {
    throw new AppError('NOT_FOUND', { message: 'Template tidak ditemukan.' });
  }
  return value;
}

const limitMessage = (wait: string) => `Terlalu banyak permintaan. Coba lagi dalam ${wait}.`;

export const templatesRoutes: FastifyPluginCallbackZod<TemplatesRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { templates, limiter, outbound } = options;
  const routes = API_ROUTES.templates;
  const writeGuard = (userId: string) =>
    enforceRateLimit(limiter, WRITE_RULE, userId, limitMessage);

  app.get(
    routes.list,
    {
      config: { access: VIEW },
      schema: {
        querystring: templateListQuerySchema,
        response: { 200: templateListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return { templates: await templates.list(auth.organizationId, request.query) };
    },
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createTemplateRequestSchema,
        response: { 201: templateResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await writeGuard(auth.user.id);
      const template = await templates.create(auth, request.body, clientInfo(request));
      void reply.code(201);
      return { template };
    },
  );

  app.get(
    routes.presets,
    {
      config: { access: MANAGE },
      schema: { response: { 200: templatePresetListResponseSchema, ...errors } },
    },
    () => ({ presets: [...TEMPLATE_PRESETS] }),
  );

  app.post(
    routes.fromPreset,
    {
      config: { access: MANAGE },
      schema: {
        params: templatePresetParamsSchema,
        body: createFromPresetRequestSchema,
        response: { 201: templateResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await writeGuard(auth.user.id);
      const template = await templates.createFromPreset(
        auth,
        request.params.presetId,
        request.body,
        clientInfo(request),
      );
      void reply.code(201);
      return { template };
    },
  );

  app.post(
    routes.sync,
    {
      config: { access: MANAGE },
      schema: {
        body: syncTemplatesRequestSchema,
        response: { 200: syncTemplatesResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, SYNC_RULE, auth.organizationId, limitMessage);
      return {
        channels: await templates.sync(auth, request.body.channelId, clientInfo(request)),
      };
    },
  );

  app.get(
    routes.template,
    {
      config: { access: VIEW },
      schema: {
        params: templateIdParamsSchema,
        response: { 200: templateResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return {
        template: await templates.get(auth.organizationId, idOf(request.params.templateId)),
      };
    },
  );

  app.patch(
    routes.template,
    {
      config: { access: MANAGE },
      schema: {
        params: templateIdParamsSchema,
        body: updateTemplateRequestSchema,
        response: { 200: templateResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeGuard(auth.user.id);
      return {
        template: await templates.update(
          auth,
          idOf(request.params.templateId),
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.delete(
    routes.template,
    {
      config: { access: MANAGE },
      schema: {
        params: templateIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeGuard(auth.user.id);
      await templates.remove(auth, idOf(request.params.templateId), clientInfo(request));
      return { deleted: true as const };
    },
  );

  app.post(
    routes.submit,
    {
      config: { access: MANAGE },
      schema: {
        params: templateIdParamsSchema,
        response: { 200: templateResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeGuard(auth.user.id);
      return {
        template: await templates.submit(
          auth,
          idOf(request.params.templateId),
          clientInfo(request),
        ),
      };
    },
  );

  // Mulai percakapan (bisa nomor baru) dengan template — `inbox.initiate` (PRD §4).
  app.post(
    API_ROUTES.inbox.start,
    {
      config: { access: requirePermission('inbox.initiate') },
      schema: {
        body: startConversationRequestSchema,
        response: {
          200: messageResponseSchema.extend({ conversationId: z.uuid() }),
          202: messageResponseSchema.extend({ conversationId: z.uuid() }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const grant = await permissionGrant(request, 'inbox.initiate');
      const phone = normalizeWhatsappNumber(request.body.phone);
      if (!phone) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Nomor tujuan tidak valid. Contoh: 081234567890 atau +6281234567890.',
          details: [{ location: 'body', field: 'phone', message: 'Nomor tidak valid.' }],
        });
      }
      await enforceRateLimit(limiter, SEND_USER_RULE, auth.user.id, limitMessage);
      await enforceRateLimit(limiter, SEND_ORGANIZATION_RULE, auth.organizationId, limitMessage);
      await enforceRateLimit(
        limiter,
        INITIATE_USER_RULE,
        auth.user.id,
        (wait) => `Batas harian memulai percakapan baru tercapai. Coba lagi dalam ${wait}.`,
      );
      const { message, created, conversationId } = await outbound.startWithTemplate(
        { kind: 'user', grant },
        {
          channelId: request.body.channelId,
          phone,
          clientMessageId: request.body.clientMessageId,
          templateId: request.body.templateId,
          parameters: request.body.parameters,
        },
        clientInfo(request),
        async (organizationId, normalized) =>
          (await options.contacts.createFromApi(organizationId, { phone: normalized })).id,
      );
      void reply.code(created ? 202 : 200);
      return { message: toMessage(message), conversationId };
    },
  );

  done();
};
