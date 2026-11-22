import multipart from '@fastify/multipart';
import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  BROADCAST_LIMITS,
  broadcastConfirmRequestSchema,
  broadcastConnectorIdParamsSchema,
  broadcastConnectorListResponseSchema,
  broadcastConnectorOptionsResponseSchema,
  broadcastConnectorResponseSchema,
  broadcastConnectorSourceRequestSchema,
  broadcastConnectorTestResponseSchema,
  broadcastEstimateResponseSchema,
  broadcastIdParamsSchema,
  broadcastImportResponseSchema,
  broadcastListQuerySchema,
  broadcastListResponseSchema,
  broadcastPauseRequestSchema,
  broadcastPreviewResponseSchema,
  broadcastRecipientListQuerySchema,
  broadcastRecipientListResponseSchema,
  broadcastRejectRequestSchema,
  broadcastReportResponseSchema,
  broadcastResponseSchema,
  broadcastSegmentRequestSchema,
  broadcastSettingsResponseSchema,
  broadcastUploadQuerySchema,
  createBroadcastConnectorRequestSchema,
  createBroadcastRequestSchema,
  errorEnvelopeSchema,
  telegramAlarmSettingsResponseSchema,
  telegramTestResponseSchema,
  updateBroadcastConnectorRequestSchema,
  updateBroadcastRequestSchema,
  updateBroadcastSettingsRequestSchema,
  updateTelegramAlarmRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { BroadcastSettingsService, SettingsContext } from './broadcast-settings.service';
import type { BroadcastsService } from './broadcasts.service';

export interface BroadcastsRoutesOptions {
  broadcasts: BroadcastsService;
  settings: BroadcastSettingsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/**
 * Broadcast (Fase 4, docs/KONTRAK-API-BROADCAST.md). PRD §4: buat/kelola = `broadcast.send`
 * (Owner/Admin/Supervisor), setujui = `broadcast.approve` (Owner/Admin, bukan pembuat), ekspor laporan
 * per penerima = `contacts.export` (data pribadi), pengaturan = `sending.limits.manage`, konektor &
 * alarm Telegram = `integrations.manage`. Tulis = CSRF (hook auth).
 */
const SEND = requirePermission('broadcast.send');
const APPROVE = requirePermission('broadcast.approve');
const SETTINGS = requirePermission('sending.limits.manage');
const INTEGRATIONS = requirePermission('integrations.manage');
const UUID = z.uuid();

const WRITE_RULE: RateLimitRule = { name: 'broadcast-tulis', limit: 60, windowSeconds: 60 };
const IMPORT_RULE: RateLimitRule = { name: 'broadcast-impor', limit: 30, windowSeconds: 60 * 60 };
const EXPORT_RULE: RateLimitRule = { name: 'broadcast-ekspor', limit: 10, windowSeconds: 60 * 60 };
const TEST_RULE: RateLimitRule = { name: 'konektor-tes', limit: 6, windowSeconds: 60 };

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

const limitMessage = (wait: string) => `Terlalu banyak permintaan. Coba lagi dalam ${wait}.`;

function idOf(value: string, message = 'Broadcast tidak ditemukan.'): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

export const broadcastsRoutes: FastifyPluginAsyncZod<BroadcastsRoutesOptions> = async (
  app,
  options,
) => {
  const { broadcasts, settings, limiter, cookieSecure } = options;
  const routes = API_ROUTES.broadcasts;
  const alarms = API_ROUTES.alarms;

  // Parser multipart HANYA di plugin ini (unggah CSV/XLSX).
  await app.register(multipart, {
    limits: {
      fileSize: BROADCAST_LIMITS.maxFileBytes,
      files: 1,
      fields: 0,
      parts: 1,
      fieldNameSize: 32,
    },
  });

  const contextOf = (request: FastifyRequest): SettingsContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });
  const write = (userId: string) => enforceRateLimit(limiter, WRITE_RULE, userId, limitMessage);

  // Tahap 9.0 "Akses per channel": SETIAP rute ber-`:broadcastId` di plugin ini menolak (404 sama
  // dengan ID tak dikenal) broadcast dari channel yang tidak boleh dilihat pengguna. Setelah auth +
  // validasi (preHandler), sebelum handler.
  app.addHook('preHandler', async (request) => {
    const params = request.params as { broadcastId?: unknown } | undefined;
    if (typeof params?.broadcastId !== 'string' || !request.auth) return;
    await broadcasts.assertVisible(requireAuth(request), idOf(params.broadcastId));
  });

  // ── Kampanye ──────────────────────────────────────────────────────────────

  app.get(
    routes.list,
    {
      config: { access: SEND },
      schema: {
        querystring: broadcastListQuerySchema,
        response: { 200: broadcastListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return broadcasts.list(auth.organizationId, request.query, auth.user.id);
    },
  );

  app.post(
    routes.list,
    {
      config: { access: SEND },
      schema: {
        body: createBroadcastRequestSchema,
        response: { 201: broadcastResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      const broadcast = await broadcasts.create(auth, request.body, clientInfo(request));
      void reply.code(201);
      return { broadcast };
    },
  );

  app.get(
    routes.connectorOptions,
    {
      config: { access: SEND },
      schema: { response: { 200: broadcastConnectorOptionsResponseSchema, ...errors } },
    },
    async (request) => ({
      connectors: await settings.connectorOptions(requireAuth(request).organizationId),
    }),
  );

  app.get(
    routes.broadcast,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => ({
      broadcast: await broadcasts.get(
        requireAuth(request).organizationId,
        idOf(request.params.broadcastId),
      ),
    }),
  );

  app.patch(
    routes.broadcast,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: updateBroadcastRequestSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        broadcast: await broadcasts.update(
          auth,
          idOf(request.params.broadcastId),
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.delete(
    routes.broadcast,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      await broadcasts.remove(auth, idOf(request.params.broadcastId), clientInfo(request));
      return { deleted: true as const };
    },
  );

  app.post(
    routes.upload,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        querystring: broadcastUploadQuerySchema,
        response: { 200: broadcastImportResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = idOf(request.params.broadcastId);
      await enforceRateLimit(limiter, IMPORT_RULE, auth.user.id, limitMessage);
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
          message: 'Pilih berkas CSV atau Excel (.xlsx).',
          details: [{ location: 'body', field: 'file', message: 'Berkas wajib diisi.' }],
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      if (part.file.truncated) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Berkas terlalu besar (maks. 5 MB).' });
      }
      return broadcasts.importUpload(
        auth,
        id,
        { buffer: Buffer.concat(chunks), filename: part.filename || null },
        request.query.phoneColumn,
        clientInfo(request),
      );
    },
  );

  app.post(
    routes.segment,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastSegmentRequestSchema,
        response: { 200: broadcastImportResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, IMPORT_RULE, auth.user.id, limitMessage);
      return broadcasts.importSegment(
        auth,
        idOf(request.params.broadcastId),
        request.body,
        clientInfo(request),
      );
    },
  );

  app.post(
    routes.connector,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastConnectorSourceRequestSchema,
        response: { 200: broadcastImportResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, IMPORT_RULE, auth.user.id, limitMessage);
      return broadcasts.importConnector(
        auth,
        idOf(request.params.broadcastId),
        request.body.connectorId,
        clientInfo(request),
      );
    },
  );

  app.get(
    routes.recipients,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        querystring: broadcastRecipientListQuerySchema,
        response: { 200: broadcastRecipientListResponseSchema, ...errors },
      },
    },
    async (request) =>
      broadcasts.recipients(
        requireAuth(request).organizationId,
        idOf(request.params.broadcastId),
        request.query,
      ),
  );

  app.get(
    routes.preview,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        response: { 200: broadcastPreviewResponseSchema, ...errors },
      },
    },
    async (request) =>
      broadcasts.preview(requireAuth(request).organizationId, idOf(request.params.broadcastId)),
  );

  app.get(
    routes.estimate,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        response: { 200: broadcastEstimateResponseSchema, ...errors },
      },
    },
    async (request) => ({
      estimate: await broadcasts.estimate(
        requireAuth(request).organizationId,
        idOf(request.params.broadcastId),
      ),
    }),
  );

  app.post(
    routes.submit,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastConfirmRequestSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        broadcast: await broadcasts.submit(
          auth,
          idOf(request.params.broadcastId),
          request.body.confirmation,
          contextOf(request),
        ),
      };
    },
  );

  app.post(
    routes.approve,
    {
      config: { access: APPROVE },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastConfirmRequestSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        broadcast: await broadcasts.approve(
          auth,
          idOf(request.params.broadcastId),
          request.body.confirmation,
          contextOf(request),
        ),
      };
    },
  );

  app.post(
    routes.reject,
    {
      config: { access: APPROVE },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastRejectRequestSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        broadcast: await broadcasts.reject(
          auth,
          idOf(request.params.broadcastId),
          request.body.reason,
          clientInfo(request),
        ),
      };
    },
  );

  app.post(
    routes.pause,
    {
      // Arah aman & harus cepat: tanpa konfirmasi identitas, TANPA batas laju tulis.
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastPauseRequestSchema.optional(),
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => ({
      broadcast: await broadcasts.pause(
        requireAuth(request),
        idOf(request.params.broadcastId),
        clientInfo(request),
      ),
    }),
  );

  app.post(
    routes.resume,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastConfirmRequestSchema,
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        broadcast: await broadcasts.resume(
          auth,
          idOf(request.params.broadcastId),
          request.body.confirmation,
          contextOf(request),
        ),
      };
    },
  );

  app.post(
    routes.cancel,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        body: broadcastPauseRequestSchema.optional(),
        response: { 200: broadcastResponseSchema, ...errors },
      },
    },
    async (request) => ({
      broadcast: await broadcasts.cancel(
        requireAuth(request),
        idOf(request.params.broadcastId),
        clientInfo(request),
      ),
    }),
  );

  app.get(
    routes.report,
    {
      config: { access: SEND },
      schema: {
        params: broadcastIdParamsSchema,
        response: { 200: broadcastReportResponseSchema, ...errors },
      },
    },
    async (request) => ({
      report: await broadcasts.report(
        requireAuth(request).organizationId,
        idOf(request.params.broadcastId),
      ),
    }),
  );

  app.get(
    routes.exportCsv,
    {
      // CSV (data pribadi): wajib CSRF walau GET + jatah 10/jam + audit `broadcast.exported`.
      config: {
        access: requirePermission('contacts.export'),
        rawResponse: true,
        requireCsrf: true,
      },
      schema: { params: broadcastIdParamsSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, EXPORT_RULE, auth.user.id, limitMessage);
      const { csv, rows } = await broadcasts.exportCsv(
        auth,
        idOf(request.params.broadcastId),
        clientInfo(request),
      );
      void reply.headers({
        'content-disposition': `attachment; filename="broadcast-${request.params.broadcastId.slice(0, 8)}.csv"`,
        'cache-control': 'no-store',
        'x-export-rows': String(rows),
      });
      return reply.type('text/csv; charset=utf-8').send(csv);
    },
  );

  // ── Pengaturan broadcast ──────────────────────────────────────────────────

  app.get(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: { response: { 200: broadcastSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      settings: await settings.getSettings(requireAuth(request).organizationId),
    }),
  );

  app.put(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: {
        body: updateBroadcastSettingsRequestSchema,
        response: { 200: broadcastSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return { settings: await settings.updateSettings(auth, request.body, contextOf(request)) };
    },
  );

  // ── Konektor REST ─────────────────────────────────────────────────────────

  app.get(
    routes.connectors,
    {
      config: { access: INTEGRATIONS },
      schema: { response: { 200: broadcastConnectorListResponseSchema, ...errors } },
    },
    async (request) => ({
      connectors: await settings.listConnectors(requireAuth(request).organizationId),
    }),
  );

  app.post(
    routes.connectors,
    {
      config: { access: INTEGRATIONS },
      schema: {
        body: createBroadcastConnectorRequestSchema,
        response: { 201: broadcastConnectorResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      const connector = await settings.createConnector(auth, request.body, contextOf(request));
      void reply.code(201);
      return { connector };
    },
  );

  app.patch(
    routes.connectorItem,
    {
      config: { access: INTEGRATIONS },
      schema: {
        params: broadcastConnectorIdParamsSchema,
        body: updateBroadcastConnectorRequestSchema,
        response: { 200: broadcastConnectorResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        connector: await settings.updateConnector(
          auth,
          idOf(request.params.connectorId, 'Konektor tidak ditemukan.'),
          request.body,
          contextOf(request),
        ),
      };
    },
  );

  app.delete(
    routes.connectorItem,
    {
      config: { access: INTEGRATIONS },
      schema: {
        params: broadcastConnectorIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      await settings.deleteConnector(
        auth,
        idOf(request.params.connectorId, 'Konektor tidak ditemukan.'),
        clientInfo(request),
      );
      return { deleted: true as const };
    },
  );

  app.post(
    routes.connectorTest,
    {
      config: { access: INTEGRATIONS },
      schema: {
        params: broadcastConnectorIdParamsSchema,
        response: { 200: broadcastConnectorTestResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, TEST_RULE, auth.organizationId, limitMessage);
      return settings.testConnector(
        auth.organizationId,
        idOf(request.params.connectorId, 'Konektor tidak ditemukan.'),
      );
    },
  );

  // ── Alarm Telegram ────────────────────────────────────────────────────────

  app.get(
    alarms.telegram,
    {
      config: { access: INTEGRATIONS },
      schema: { response: { 200: telegramAlarmSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      telegram: await settings.getTelegram(requireAuth(request).organizationId),
    }),
  );

  app.put(
    alarms.telegram,
    {
      config: { access: INTEGRATIONS },
      schema: {
        body: updateTelegramAlarmRequestSchema,
        response: { 200: telegramAlarmSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return { telegram: await settings.updateTelegram(auth, request.body, contextOf(request)) };
    },
  );

  app.delete(
    alarms.telegram,
    {
      config: { access: INTEGRATIONS },
      schema: {
        body: broadcastConfirmRequestSchema,
        response: { 200: telegramAlarmSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await write(auth.user.id);
      return {
        telegram: await settings.deleteTelegram(
          auth,
          request.body.confirmation,
          contextOf(request),
        ),
      };
    },
  );

  app.post(
    alarms.telegramTest,
    {
      config: { access: INTEGRATIONS },
      schema: { response: { 200: telegramTestResponseSchema, ...errors } },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        { name: 'telegram-tes', limit: 6, windowSeconds: 60 },
        auth.organizationId,
        limitMessage,
      );
      return settings.testTelegram(auth);
    },
  );
};
