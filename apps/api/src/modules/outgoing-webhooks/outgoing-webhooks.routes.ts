import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  createOutgoingWebhookRequestSchema,
  deletedResponseSchema,
  errorEnvelopeSchema,
  outgoingWebhookDeliveryParamsSchema,
  outgoingWebhookIdParamsSchema,
  outgoingWebhookListResponseSchema,
  outgoingWebhookResponseSchema,
  outgoingWebhookSecretResponseSchema,
  privateNetworkResponseSchema,
  rotateOutgoingWebhookSecretRequestSchema,
  updateOutgoingWebhookRequestSchema,
  updatePrivateNetworkRequestSchema,
  webhookDeliveryListQuerySchema,
  webhookDeliveryListResponseSchema,
  webhookDeliveryResponseSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { OutgoingWebhooksService, WebhookContext } from './outgoing-webhooks.service';

export interface OutgoingWebhooksRoutesOptions {
  webhooks: OutgoingWebhooksService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Pengaturan → Webhook keluar (`integrations.manage` = Owner/Admin). Tulis lewat CSRF hook. */
const MANAGE = requirePermission('integrations.manage');
const WRITE_RULE: RateLimitRule = { name: 'webhook-kelola', limit: 30, windowSeconds: 60 };
const UUID = z.uuid();
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

function uuidOr404(value: string, message = 'Webhook tidak ditemukan.'): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

export const outgoingWebhooksRoutes: FastifyPluginCallbackZod<OutgoingWebhooksRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { webhooks, limiter, cookieSecure } = options;
  const routes = API_ROUTES.outgoingWebhooks;

  async function writeContext(request: FastifyRequest): Promise<WebhookContext> {
    const auth = requireAuth(request);
    await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
    return {
      client: clientInfo(request),
      log: request.log,
      presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
    };
  }

  app.get(
    routes.list,
    {
      config: { access: MANAGE },
      schema: { response: { 200: outgoingWebhookListResponseSchema, ...errors } },
    },
    async (request) => ({ webhooks: await webhooks.list(requireAuth(request).organizationId) }),
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createOutgoingWebhookRequestSchema,
        response: { 201: outgoingWebhookSecretResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const context = await writeContext(request);
      const created = await webhooks.create(requireAuth(request), request.body, context);
      void reply.code(201).header('Cache-Control', 'no-store');
      return created;
    },
  );

  app.patch(
    routes.webhook,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookIdParamsSchema,
        body: updateOutgoingWebhookRequestSchema,
        response: { 200: outgoingWebhookResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.webhookId);
      const context = await writeContext(request);
      return { webhook: await webhooks.update(requireAuth(request), id, request.body, context) };
    },
  );

  app.delete(
    routes.webhook,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookIdParamsSchema,
        response: { 200: deletedResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.webhookId);
      const context = await writeContext(request);
      await webhooks.remove(requireAuth(request), context.client, id);
      return { deleted: true as const };
    },
  );

  app.post(
    routes.rotateSecret,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookIdParamsSchema,
        body: rotateOutgoingWebhookSecretRequestSchema,
        response: { 200: outgoingWebhookSecretResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.webhookId);
      const context = await writeContext(request);
      const rotated = await webhooks.rotateSecret(
        requireAuth(request),
        id,
        request.body.confirmation,
        context,
      );
      void reply.header('Cache-Control', 'no-store');
      return rotated;
    },
  );

  app.post(
    routes.test,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookIdParamsSchema,
        response: { 201: webhookDeliveryResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.webhookId);
      await writeContext(request);
      const delivery = await webhooks.test(requireAuth(request), id);
      void reply.code(201);
      return { delivery };
    },
  );

  app.get(
    routes.deliveries,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookIdParamsSchema,
        querystring: webhookDeliveryListQuerySchema,
        response: { 200: webhookDeliveryListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.webhookId);
      return webhooks.deliveries(requireAuth(request).organizationId, id, request.query);
    },
  );

  app.post(
    routes.redeliver,
    {
      config: { access: MANAGE },
      schema: {
        params: outgoingWebhookDeliveryParamsSchema,
        response: { 201: webhookDeliveryResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.webhookId);
      const deliveryId = uuidOr404(
        request.params.deliveryId,
        'Riwayat pengiriman tidak ditemukan.',
      );
      await writeContext(request);
      const delivery = await webhooks.redeliver(requireAuth(request), id, deliveryId);
      void reply.code(201);
      return { delivery };
    },
  );

  app.get(
    routes.privateNetwork,
    {
      config: { access: MANAGE },
      schema: { response: { 200: privateNetworkResponseSchema, ...errors } },
    },
    async (request) => ({
      settings: await webhooks.privateNetwork(requireAuth(request).organizationId),
    }),
  );

  app.put(
    routes.privateNetwork,
    {
      config: { access: MANAGE },
      schema: {
        body: updatePrivateNetworkRequestSchema,
        response: { 200: privateNetworkResponseSchema, ...errors },
      },
    },
    async (request) => {
      const context = await writeContext(request);
      return {
        settings: await webhooks.updatePrivateNetwork(
          requireAuth(request),
          request.body.cidrs,
          request.body.confirmation,
          context,
        ),
      };
    },
  );

  done();
};
