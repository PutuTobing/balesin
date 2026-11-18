import { AppError } from '@balesin/core';
import {
  REPORT_ROUTES,
  csatSettingsResponseSchema,
  errorEnvelopeSchema,
  reportCostsQuerySchema,
  reportCostsResponseSchema,
  reportExportQuerySchema,
  reportPerformanceResponseSchema,
  reportRangeQuerySchema,
  updateCsatSettingsRequestSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { createConcurrencyGate } from '../messages/concurrency';
import { permissionGrant } from '../auth/permission-grant';
import type { ReportsService } from './reports.service';

export interface ReportsRoutesOptions {
  reports: ReportsService;
  limiter: RateLimiter;
}

/**
 * Laporan & CSAT (Fase 5, docs/KONTRAK-API-LAPORAN.md). PRD §4 "Lihat laporan (termasuk biaya pesan
 * Meta tingkat organisasi)" = `reports.view` — cakupan `all` (Owner/Admin/Supervisor) atau `own`
 * (CS/Teknisi: kinerja sendiri). Pengaturan CSAT = `settings.workspace.manage` (Owner/Admin).
 */
const VIEW = requirePermission('reports.view');
const READ_RULE: RateLimitRule = { name: 'laporan-baca', limit: 30, windowSeconds: 60 };
const EXPORT_RULE: RateLimitRule = { name: 'laporan-ekspor', limit: 10, windowSeconds: 60 * 60 };
const WRITE_RULE: RateLimitRule = { name: 'csat-tulis', limit: 30, windowSeconds: 60 };

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};
const limitMessage = (wait: string) =>
  `Terlalu banyak permintaan laporan. Coba lagi dalam ${wait}.`;

/**
 * Review Fase 5 Info 5: laporan yang BERJALAN bersamaan dibatasi per organisasi (2) dan per proses
 * api (6) — tiap query bisa memegang koneksi pool hingga batas waktu 8 dtk. Penuh → 429 segera.
 */
export const REPORT_CONCURRENCY = { perOrganization: 2, global: 6 } as const;

async function gated<T>(
  gate: ReturnType<typeof createConcurrencyGate>,
  organizationId: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = gate.tryAcquire(organizationId);
  if (!release) {
    throw new AppError('RATE_LIMITED', {
      message: 'Laporan lain sedang diproses untuk organisasi ini. Coba lagi beberapa detik lagi.',
      retryAfterSeconds: 5,
    });
  }
  try {
    return await run();
  } finally {
    release();
  }
}

export const reportsRoutes: FastifyPluginCallbackZod<ReportsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { reports, limiter } = options;
  const gate = createConcurrencyGate({
    global: REPORT_CONCURRENCY.global,
    perUser: REPORT_CONCURRENCY.perOrganization,
  });

  app.get(
    REPORT_ROUTES.performance,
    {
      config: { access: VIEW },
      schema: {
        querystring: reportRangeQuerySchema,
        response: { 200: reportPerformanceResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'reports.view');
      await enforceRateLimit(limiter, READ_RULE, grant.userId, limitMessage);
      return {
        report: await gated(gate, grant.organizationId, () =>
          reports.performance(grant.organizationId, grant.userId, grant.scope, request.query),
        ),
      };
    },
  );

  app.get(
    REPORT_ROUTES.costs,
    {
      config: { access: VIEW },
      schema: {
        querystring: reportCostsQuerySchema,
        response: { 200: reportCostsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'reports.view');
      await enforceRateLimit(limiter, READ_RULE, grant.userId, limitMessage);
      return {
        costs: await gated(gate, grant.organizationId, () =>
          reports.costs(requireAuth(request), grant.scope, request.query, clientInfo(request)),
        ),
      };
    },
  );

  app.get(
    REPORT_ROUTES.exportCsv,
    {
      // CSV: GET ber-efek (audit + jatah) → wajib CSRF & same-origin; tanpa skema respons (biner).
      config: { access: VIEW, rawResponse: true, requireCsrf: true },
      schema: { querystring: reportExportQuerySchema },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'reports.view');
      await enforceRateLimit(limiter, EXPORT_RULE, grant.userId, limitMessage);
      const { csv, rows, filename } = await gated(gate, grant.organizationId, () =>
        reports.exportCsv(requireAuth(request), grant.scope, request.query, clientInfo(request)),
      );
      void reply.headers({
        'content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'cache-control': 'no-store',
        'x-export-rows': String(rows),
      });
      return reply.type('text/csv; charset=utf-8').send(csv);
    },
  );

  app.get(
    REPORT_ROUTES.csatSettings,
    {
      config: { access: requirePermission('settings.workspace.manage') },
      schema: { response: { 200: csatSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      csat: await reports.getCsatSettings(requireAuth(request).organizationId),
    }),
  );

  app.put(
    REPORT_ROUTES.csatSettings,
    {
      config: { access: requirePermission('settings.workspace.manage') },
      schema: {
        body: updateCsatSettingsRequestSchema,
        response: { 200: csatSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return { csat: await reports.updateCsatSettings(auth, request.body, clientInfo(request)) };
    },
  );

  done();
};
