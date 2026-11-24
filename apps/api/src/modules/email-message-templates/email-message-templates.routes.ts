import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  EMAIL_TEMPLATE_PRESETS,
  createEmailTemplateFromPresetRequestSchema,
  createEmailTemplateRequestSchema,
  emailMessageTemplatePreviewRequestSchema,
  emailMessageTemplatePreviewResponseSchema,
  emailTemplateIdParamsSchema,
  emailTemplateListQuerySchema,
  emailTemplateListResponseSchema,
  emailTemplatePresetParamsSchema,
  emailTemplatePresetsResponseSchema,
  emailTemplateResponseSchema,
  emailTemplateTestRequestSchema,
  emailTemplateTestResponseSchema,
  emailTemplateVersionParamsSchema,
  emailTemplateVersionResponseSchema,
  emailTemplateVersionsResponseSchema,
  errorEnvelopeSchema,
  publishEmailTemplateRequestSchema,
  updateEmailTemplateRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type {
  EmailMessageTemplatesService,
  EmailTemplatesContext,
} from './email-message-templates.service';

export interface EmailMessageTemplatesRoutesOptions {
  templates: EmailMessageTemplatesService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/**
 * Pengaturan → Template email (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §7). Izin
 * `templates.manage` (Owner/Admin/Supervisor). Tulis = CSRF (hook), 60/menit/pengguna; terbit =
 * konfirmasi identitas; kirim tes 10/10 menit/pengguna, selalu ke alamat akun sendiri.
 */
const MANAGE = requirePermission('templates.manage');
const WRITE_RULE: RateLimitRule = { name: 'template-email-tulis', limit: 60, windowSeconds: 60 };
const TEST_RULE: RateLimitRule = { name: 'template-email-tes', limit: 10, windowSeconds: 600 };
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

function versionOf(value: string): number {
  if (!/^\d{1,6}$/.test(value)) {
    throw new AppError('NOT_FOUND', { message: 'Versi template tidak ditemukan.' });
  }
  return Number(value);
}

export const emailMessageTemplatesRoutes: FastifyPluginCallbackZod<
  EmailMessageTemplatesRoutesOptions
> = (app, options, done) => {
  const { templates, limiter, cookieSecure } = options;
  const routes = API_ROUTES.emailTemplates;

  const writeContext = async (request: FastifyRequest): Promise<EmailTemplatesContext> => {
    const auth = requireAuth(request);
    await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
    return { auth, client: clientInfo(request) };
  };

  app.get(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        querystring: emailTemplateListQuerySchema,
        response: { 200: emailTemplateListResponseSchema, ...errors },
      },
    },
    async (request) => ({
      templates: await templates.list(requireAuth(request).organizationId, {
        ...(request.query.q ? { q: request.query.q } : {}),
        ...(request.query.archived ? { archived: request.query.archived === 'true' } : {}),
      }),
    }),
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createEmailTemplateRequestSchema,
        response: { 201: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const template = await templates.create(await writeContext(request), request.body);
      void reply.code(201);
      return { template };
    },
  );

  app.get(
    routes.presets,
    {
      config: { access: MANAGE },
      schema: { response: { 200: emailTemplatePresetsResponseSchema, ...errors } },
    },
    () => ({
      presets: EMAIL_TEMPLATE_PRESETS.map((preset) => ({
        key: preset.key,
        name: preset.name,
        description: preset.description,
        subject: preset.subject,
        layout: preset.layout,
        variables: preset.variables.map((variable) => ({ ...variable })),
      })),
    }),
  );

  app.post(
    routes.fromPreset,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplatePresetParamsSchema,
        body: createEmailTemplateFromPresetRequestSchema,
        response: { 201: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const template = await templates.fromPreset(
        await writeContext(request),
        request.params.presetId,
        request.body,
      );
      void reply.code(201);
      return { template };
    },
  );

  app.post(
    routes.preview,
    {
      config: { access: MANAGE },
      schema: {
        body: emailMessageTemplatePreviewRequestSchema,
        response: { 200: emailMessageTemplatePreviewResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return templates.preview(auth.organizationId, request.body);
    },
  );

  app.get(
    routes.template,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateIdParamsSchema,
        response: { 200: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request) => ({
      template: await templates.get(requireAuth(request).organizationId, request.params.templateId),
    }),
  );

  app.patch(
    routes.template,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateIdParamsSchema,
        body: updateEmailTemplateRequestSchema,
        response: { 200: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request) => ({
      template: await templates.update(
        await writeContext(request),
        request.params.templateId,
        request.body,
      ),
    }),
  );

  app.post(
    routes.publish,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateIdParamsSchema,
        body: publishEmailTemplateRequestSchema,
        response: { 200: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        template: await templates.publish(
          auth,
          request.params.templateId,
          request.body.confirmation,
          {
            client: clientInfo(request),
            log: request.log,
            presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
          },
        ),
      };
    },
  );

  for (const [path, archived] of [
    [routes.archive, true],
    [routes.unarchive, false],
  ] as const) {
    app.post(
      path,
      {
        config: { access: MANAGE },
        schema: {
          params: emailTemplateIdParamsSchema,
          response: { 200: emailTemplateResponseSchema, ...errors },
        },
      },
      async (request) => ({
        template: await templates.setArchived(
          await writeContext(request),
          request.params.templateId,
          archived,
        ),
      }),
    );
  }

  app.get(
    routes.versions,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateIdParamsSchema,
        response: { 200: emailTemplateVersionsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      versions: await templates.versions(
        requireAuth(request).organizationId,
        request.params.templateId,
      ),
    }),
  );

  app.get(
    routes.version,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateVersionParamsSchema,
        response: { 200: emailTemplateVersionResponseSchema, ...errors },
      },
    },
    async (request) => ({
      version: await templates.version(
        requireAuth(request).organizationId,
        request.params.templateId,
        versionOf(request.params.versionId),
      ),
    }),
  );

  app.post(
    routes.restore,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateVersionParamsSchema,
        response: { 200: emailTemplateResponseSchema, ...errors },
      },
    },
    async (request) => ({
      template: await templates.restore(
        await writeContext(request),
        request.params.templateId,
        versionOf(request.params.versionId),
      ),
    }),
  );

  app.post(
    routes.test,
    {
      config: { access: MANAGE },
      schema: {
        params: emailTemplateIdParamsSchema,
        body: emailTemplateTestRequestSchema,
        response: { 202: emailTemplateTestResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        TEST_RULE,
        auth.user.id,
        (wait) => `Kirim tes dibatasi 10 kali per 10 menit. Coba lagi dalam ${wait}.`,
      );
      const email = await templates.test(
        { auth, client: clientInfo(request) },
        request.params.templateId,
        request.body,
      );
      void reply.code(202);
      return { email };
    },
  );

  done();
};
