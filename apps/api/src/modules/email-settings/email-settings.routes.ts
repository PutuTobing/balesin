import {
  API_ROUTES,
  detectEmailHostRequestSchema,
  detectEmailHostResponseSchema,
  emailSettingsResponseSchema,
  emailTemplateParamsSchema,
  emailTemplatePreviewResponseSchema,
  emailTestResultSchema,
  errorEnvelopeSchema,
  saveEmailSettingsRequestSchema,
  sendTestEmailRequestSchema,
  testEmailConnectionRequestSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { EmailSettingsService } from './email-settings.service';
import type { EmailTemplatePreview } from './email-template-preview';

export interface EmailSettingsRoutesOptions {
  emailSettings: EmailSettingsService;
  templatePreview: EmailTemplatePreview;
  limiter: RateLimiter;
}

/**
 * Owner dan Admin (`settings.email.manage`; PENGATURAN-UI.md: "Hanya Owner/Admin yang bisa
 * mengubah" — sebelum RBAC sementara khusus Owner). Tes koneksi membuat server menyambung ke host
 * pilihan pengguna (permukaan SSRF): penjaga host/port dan batas laju per pengguna tetap berlaku.
 */
const ACCESS = requirePermission('settings.email.manage');

/** Tes koneksi / kirim email tes: permintaan keluar yang mahal dan bisa disalahgunakan. */
export const EMAIL_TEST_RULE: RateLimitRule = { name: 'email-tes', limit: 10, windowSeconds: 300 };
export const EMAIL_DETECT_RULE: RateLimitRule = {
  name: 'email-deteksi',
  limit: 30,
  windowSeconds: 300,
};

export const emailTestLimitMessage = (wait: string) =>
  `Terlalu banyak tes email dalam waktu singkat. Coba lagi dalam ${wait}.`;
export const emailDetectLimitMessage = (wait: string) =>
  `Terlalu banyak permintaan deteksi server email. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

/**
 * Pengaturan → Email pengirim (docs/PENGATURAN-UI.md §1).
 *
 * - `GET  /settings/email`                  pengaturan tersamar + status + hasil tes terakhir
 * - `PUT  /settings/email`                  simpan
 * - `POST /settings/email/detect-host`      saran host dari domain email
 * - `POST /settings/email/test-connection`  tes koneksi (tersimpan atau isi form)
 * - `POST /settings/email/send-test`        kirim email tes
 * - `GET  /settings/email/templates/:template/preview`  pratinjau template email bermerek
 */
export const emailSettingsRoutes: FastifyPluginCallbackZod<EmailSettingsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { emailSettings, templatePreview, limiter } = options;

  app.get(
    API_ROUTES.settings.email,
    {
      config: { access: ACCESS },
      schema: { response: { 200: emailSettingsResponseSchema, ...errors } },
    },
    async (request, reply) =>
      reply.send(await emailSettings.view(requireAuth(request).organizationId)),
  );

  app.put(
    API_ROUTES.settings.email,
    {
      config: { access: ACCESS },
      schema: {
        body: saveEmailSettingsRequestSchema,
        response: { 200: emailSettingsResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const saved = await emailSettings.save(
        { organizationId: auth.organizationId, userId: auth.user.id },
        request.body,
        { client: clientInfo(request), log: request.log },
      );
      return reply.send(saved);
    },
  );

  app.post(
    API_ROUTES.settings.detectEmailHost,
    {
      config: { access: ACCESS },
      schema: {
        body: detectEmailHostRequestSchema,
        response: { 200: detectEmailHostResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, EMAIL_DETECT_RULE, auth.user.id, emailDetectLimitMessage);
      return reply.send(await emailSettings.detectHost(request.body.emailAddress));
    },
  );

  app.post(
    API_ROUTES.settings.testEmailConnection,
    {
      config: { access: ACCESS },
      schema: {
        body: testEmailConnectionRequestSchema,
        response: { 200: emailTestResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, EMAIL_TEST_RULE, auth.user.id, emailTestLimitMessage);
      const result = await emailSettings.testConnection(
        { organizationId: auth.organizationId, userId: auth.user.id },
        request.body.settings,
        { client: clientInfo(request), log: request.log },
      );
      return reply.send(result);
    },
  );

  app.post(
    API_ROUTES.settings.sendTestEmail,
    {
      config: { access: ACCESS },
      schema: {
        body: sendTestEmailRequestSchema,
        response: { 200: emailTestResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, EMAIL_TEST_RULE, auth.user.id, emailTestLimitMessage);
      const result = await emailSettings.sendTest(
        { organizationId: auth.organizationId, userId: auth.user.id },
        request.body.to,
        request.body.settings,
        { client: clientInfo(request), log: request.log },
      );
      return reply.send(result);
    },
  );

  app.get(
    API_ROUTES.settings.emailTemplatePreview,
    {
      config: { access: ACCESS },
      schema: {
        params: emailTemplateParamsSchema,
        response: { 200: emailTemplatePreviewResponseSchema, ...errors },
      },
    },
    async (request) => templatePreview.render(requireAuth(request), request.params.template),
  );

  done();
};
