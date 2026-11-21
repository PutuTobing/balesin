import {
  API_ROUTES,
  errorEnvelopeSchema,
  pauseSendingRequestSchema,
  resumeSendingRequestSchema,
  sendingLimitsResponseSchema,
  sendingStatusResponseSchema,
  updateSendingLimitsRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { SendingLimitsContext, SendingLimitsService } from './sending-limits.service';

export interface SendingLimitsRoutesOptions {
  sendingLimits: SendingLimitsService;
  cookieSecure: boolean;
}

/**
 * Pengaturan → Batas kirim (docs/KONTRAK-API-INBOX.md "Batas kirim & rem darurat"). PRD §4 "Atur
 * batas kirim, ambang persetujuan broadcast, rem darurat" = `sending.limits.manage` (Owner/Admin);
 * melanjutkan setelah rem darurat = `sending.resume` (Owner/Admin).
 */
const MANAGE = requirePermission('sending.limits.manage');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

export const sendingLimitsRoutes: FastifyPluginCallbackZod<SendingLimitsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { sendingLimits, cookieSecure } = options;
  const routes = API_ROUTES.sendingLimits;

  const contextOf = (request: FastifyRequest): SendingLimitsContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  // Status rem darurat untuk banner inbox SEMUA agen (butir 10): hanya `paused`, tanpa batas/pelaku.
  app.get(
    API_ROUTES.inbox.sendingStatus,
    {
      config: { access: requirePermission('inbox.view') },
      schema: { response: { 200: sendingStatusResponseSchema, ...errors } },
    },
    async (request) => ({
      paused: await sendingLimits.paused(requireAuth(request).organizationId),
    }),
  );

  app.get(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: { response: { 200: sendingLimitsResponseSchema, ...errors } },
    },
    async (request) => ({ limits: await sendingLimits.get(requireAuth(request).organizationId) }),
  );

  app.put(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: {
        body: updateSendingLimitsRequestSchema,
        response: { 200: sendingLimitsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      limits: await sendingLimits.update(requireAuth(request), request.body, contextOf(request)),
    }),
  );

  app.post(
    routes.pause,
    {
      // Menarik rem = arah aman dan harus cepat: tanpa konfirmasi identitas (tetap CSRF + audit +
      // email ke semua Owner).
      config: { access: MANAGE },
      schema: {
        body: pauseSendingRequestSchema,
        response: { 200: sendingLimitsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      limits: await sendingLimits.pause(requireAuth(request), request.body, contextOf(request)),
    }),
  );

  app.post(
    routes.resume,
    {
      config: { access: requirePermission('sending.resume') },
      schema: {
        body: resumeSendingRequestSchema,
        response: { 200: sendingLimitsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      limits: await sendingLimits.resume(
        requireAuth(request),
        request.body.confirmation,
        contextOf(request),
      ),
    }),
  );

  done();
};
