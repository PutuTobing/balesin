import {
  API_ROUTES,
  createMailAccountRequestSchema,
  deleteMailAccountRequestSchema,
  deleteMailAccountResponseSchema,
  detectMailAccountRequestSchema,
  detectMailAccountResponseSchema,
  errorEnvelopeSchema,
  hasPermission,
  mailAccountAccessResponseSchema,
  mailAccountIdParamsSchema,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  mailAccountSyncResponseSchema,
  mailAvatarQuerySchema,
  mailAvatarResponseSchema,
  mailFolderListResponseSchema,
  mailProvidersResponseSchema,
  mailSettingsAccountListResponseSchema,
  mailSettingsResponseSchema,
  mailSidebarResponseSchema,
  mailUserIdParamsSchema,
  putMailAvatarRequestSchema,
  teamMailAccessResponseSchema,
  testMailAccountRequestSchema,
  testMailAccountResponseSchema,
  updateMailAccountAccessRequestSchema,
  updateMailAccountRequestSchema,
  updateMailSettingsRequestSchema,
  updateTeamMailAccessRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { CHANNEL_TEST_RULE } from '../channels/channels.routes';
import type { MailAccessService } from './mail-access.service';
import type { MailContext, MailService } from './mail.service';

export interface MailRoutesOptions {
  mail: MailService;
  mailAccess: MailAccessService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Tulis = 60/menit/pengguna (kontrak §4). */
export const MAIL_WRITE_RULE: RateLimitRule = { name: 'mail-tulis', limit: 60, windowSeconds: 60 };
export const MAIL_DETECT_RULE: RateLimitRule = {
  name: 'mail-deteksi',
  limit: 10,
  windowSeconds: 300,
};
/** "Sinkron sekarang": 6/menit per AKUN. */
export const MAIL_SYNC_RULE: RateLimitRule = { name: 'mail-sinkron', limit: 6, windowSeconds: 60 };

const VIEW = requirePermission('mail.view');
const MANAGE = requirePermission('mail.accounts.manage');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  502: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

const BODY_LIMIT_BYTES = 32 * 1024;
const AVATAR_BODY_LIMIT_BYTES = 1_500_000;

/**
 * Modul Email — akun, akses, folder, pengaturan (Fase 9 tahap 9A bagian 1, docs/KONTRAK-API-EMAIL.md
 * §4–§6). Izin rute `mail.view` (pintu masuk), hak nyata per akun di service. Rute tulis lewat CSRF
 * (hook auth). Respons `no-store` (bawaan plugin keamanan).
 */
export const mailRoutes: FastifyPluginCallbackZod<MailRoutesOptions> = (app, options, done) => {
  const { mail, mailAccess, limiter, cookieSecure } = options;
  const routes = API_ROUTES.mail;
  const contextOf = (request: FastifyRequest): MailContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });
  const writeLimit = (userId: string) =>
    enforceRateLimit(
      limiter,
      MAIL_WRITE_RULE,
      userId,
      (wait) => `Terlalu banyak perubahan akun email. Coba lagi dalam ${wait}.`,
    );
  /** `mail.private.own` ATAU `mail.accounts.manage` (deteksi/tes wizard). */
  async function requireConnectPermission(request: FastifyRequest) {
    const auth = requireAuth(request);
    if (
      !hasPermission(auth.user.role, 'mail.private.own') &&
      !hasPermission(auth.user.role, 'mail.accounts.manage')
    ) {
      await permissionGrant(request, 'mail.private.own');
    }
    return auth;
  }

  app.get(
    routes.providers,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailProvidersResponseSchema, ...errors } },
    },
    () => mail.providers(),
  );

  app.post(
    routes.detect,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: detectMailAccountRequestSchema,
        response: { 200: detectMailAccountResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = await requireConnectPermission(request);
      await enforceRateLimit(
        limiter,
        MAIL_DETECT_RULE,
        auth.user.id,
        (wait) => `Terlalu sering mendeteksi server. Coba lagi dalam ${wait}.`,
      );
      return mail.detect(auth, request.body.emailAddress);
    },
  );

  app.post(
    routes.test,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: testMailAccountRequestSchema,
        response: { 200: testMailAccountResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = await requireConnectPermission(request);
      await enforceRateLimit(
        limiter,
        CHANNEL_TEST_RULE,
        auth.user.id,
        () => `Batas tes koneksi (${CHANNEL_TEST_RULE.limit} kali per 5 menit) sudah tercapai.`,
      );
      return mail.test(auth, request.body, contextOf(request));
    },
  );

  app.get(
    routes.accounts,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailAccountListResponseSchema, ...errors } },
    },
    (request) => mail.list(requireAuth(request)),
  );

  app.post(
    routes.accounts,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: createMailAccountRequestSchema,
        response: { 201: mailAccountResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await permissionGrant(
        request,
        request.body.kind === 'shared' ? 'mail.accounts.manage' : 'mail.private.own',
      );
      await writeLimit(auth.user.id);
      const account = await mail.create(auth, request.body, contextOf(request));
      return reply.code(201).send({ account });
    },
  );

  app.get(
    routes.settingsAccounts,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailSettingsAccountListResponseSchema, ...errors } },
    },
    (request) => mail.settingsList(requireAuth(request)),
  );

  app.get(
    routes.account,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailAccountResponseSchema, ...errors },
      },
    },
    async (request) => ({
      account: await mail.get(requireAuth(request), request.params.accountId),
    }),
  );

  app.patch(
    routes.account,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailAccountIdParamsSchema,
        body: updateMailAccountRequestSchema,
        response: { 200: mailAccountResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return {
        account: await mail.update(
          auth,
          request.params.accountId,
          request.body,
          contextOf(request),
        ),
      };
    },
  );

  app.delete(
    routes.account,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailAccountIdParamsSchema,
        body: deleteMailAccountRequestSchema.optional(),
        response: { 202: deleteMailAccountResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      const result = await mail.remove(
        auth,
        request.params.accountId,
        request.body?.confirmation,
        contextOf(request),
      );
      return reply.code(202).send(result);
    },
  );

  app.post(
    routes.accountTest,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: testMailAccountResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        CHANNEL_TEST_RULE,
        auth.user.id,
        () => `Batas tes koneksi (${CHANNEL_TEST_RULE.limit} kali per 5 menit) sudah tercapai.`,
      );
      return mail.testStored(auth, request.params.accountId, contextOf(request));
    },
  );

  app.post(
    routes.accountSync,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 202: mailAccountSyncResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        MAIL_SYNC_RULE,
        `${auth.organizationId}:${request.params.accountId.slice(0, 64)}`,
        (wait) => `Sinkron akun ini baru saja diminta. Coba lagi dalam ${wait}.`,
      );
      return reply
        .code(202)
        .send(await mail.syncNow(auth, request.params.accountId, contextOf(request)));
    },
  );

  for (const [route, paused] of [
    [routes.accountPause, true],
    [routes.accountResume, false],
  ] as const) {
    app.post(
      route,
      {
        config: { access: VIEW },
        schema: {
          params: mailAccountIdParamsSchema,
          response: { 200: mailAccountResponseSchema, ...errors },
        },
      },
      async (request) => {
        const auth = requireAuth(request);
        await writeLimit(auth.user.id);
        return {
          account: await mail.setPaused(auth, request.params.accountId, paused, contextOf(request)),
        };
      },
    );
  }

  app.put(
    routes.accountAvatar,
    {
      config: { access: VIEW },
      bodyLimit: AVATAR_BODY_LIMIT_BYTES,
      schema: {
        params: mailAccountIdParamsSchema,
        body: putMailAvatarRequestSchema,
        response: { 200: mailAvatarResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return mail.putAvatar(auth, request.params.accountId, request.body.image, contextOf(request));
    },
  );

  app.delete(
    routes.accountAvatar,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailAvatarResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return mail.deleteAvatar(auth, request.params.accountId, contextOf(request));
    },
  );

  app.get(
    routes.accountAvatar,
    {
      config: { access: VIEW, rawResponse: true },
      schema: { params: mailAccountIdParamsSchema, querystring: mailAvatarQuerySchema },
    },
    async (request, reply) => {
      const image = await mail.avatar(requireAuth(request), request.params.accountId);
      const etag = `"${image.sha256.slice(0, 32)}"`;
      void reply.headers({
        etag,
        'cache-control': request.query.v
          ? 'private, max-age=31536000, immutable'
          : 'private, max-age=300',
        'content-disposition': 'inline; filename="foto-akun.png"',
        'x-content-type-options': 'nosniff',
      });
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.type('image/png').send(image.data);
    },
  );

  app.get(
    routes.accountAccess,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailAccountAccessResponseSchema, ...errors },
      },
    },
    (request) =>
      mailAccess.getForAccount(requireAuth(request), request.params.accountId, contextOf(request)),
  );

  app.put(
    routes.accountAccess,
    {
      config: { access: MANAGE },
      bodyLimit: 64 * 1024,
      schema: {
        params: mailAccountIdParamsSchema,
        body: updateMailAccountAccessRequestSchema,
        response: { 200: mailAccountAccessResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return mailAccess.updateForAccount(
        auth,
        request.params.accountId,
        request.body,
        contextOf(request),
      );
    },
  );

  app.get(
    routes.accountFolders,
    {
      config: { access: VIEW },
      schema: {
        params: mailAccountIdParamsSchema,
        response: { 200: mailFolderListResponseSchema, ...errors },
      },
    },
    (request) => mail.folders(requireAuth(request), request.params.accountId),
  );

  app.get(
    routes.sidebar,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailSidebarResponseSchema, ...errors } },
    },
    (request) => mail.sidebar(requireAuth(request)),
  );

  app.get(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: { response: { 200: mailSettingsResponseSchema, ...errors } },
    },
    async (request) => ({ settings: await mail.settings(requireAuth(request)) }),
  );

  app.put(
    routes.settings,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: updateMailSettingsRequestSchema,
        response: { 200: mailSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return { settings: await mail.updateSettings(auth, request.body, contextOf(request)) };
    },
  );

  app.get(
    routes.teamAccess,
    {
      config: { access: MANAGE },
      schema: {
        params: mailUserIdParamsSchema,
        response: { 200: teamMailAccessResponseSchema, ...errors },
      },
    },
    (request) => mailAccess.getForUser(requireAuth(request), request.params.userId),
  );

  app.put(
    routes.teamAccess,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailUserIdParamsSchema,
        body: updateTeamMailAccessRequestSchema,
        response: { 200: teamMailAccessResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await writeLimit(auth.user.id);
      return mailAccess.updateForUser(
        auth,
        request.params.userId,
        request.body,
        contextOf(request),
      );
    },
  );

  done();
};
