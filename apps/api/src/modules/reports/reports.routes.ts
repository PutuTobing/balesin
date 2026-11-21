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
import { permissionGrant } from '../auth/permission-grant';
import { createReportGate, type ReportGate } from './report-gate';
import type { ReportsService } from './reports.service';

export interface ReportsRoutesOptions {
  reports: ReportsService;
  limiter: RateLimiter;
  /** Pengganti gerbang laporan (tes). */
  gate?: ReportGate;
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
 * Laporan yang BERJALAN bersamaan (review Fase 5 Info 5; audit akhir QA S1): per proses api 6 (pool
 * koneksi; tiap query ≤ `statement_timeout` 8 dtk), per organisasi 4, per pengguna 3. Belum dapat slot
 * → MENUNGGU hingga 6 dtk (antrean ≤ 50 per proses) — pemakaian normal tidak pernah 429. Antrean penuh /
 * waktu tunggu habis → 429 + `Retry-After`.
 */
export const REPORT_CONCURRENCY = {
  global: 6,
  perOrganization: 4,
  perUser: 3,
  maxWaiting: 50,
  waitMs: 6_000,
} as const;

async function gated<T>(
  gate: ReportGate,
  grant: { organizationId: string; userId: string },
  run: () => Promise<T>,
): Promise<T> {
  const release = await gate.acquire(grant.organizationId, grant.userId);
  if (!release) {
    throw new AppError('RATE_LIMITED', {
      message: 'Laporan sedang ramai diproses. Coba lagi beberapa detik lagi.',
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
  const gate = options.gate ?? createReportGate(REPORT_CONCURRENCY);

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
        report: await gated(gate, grant, () =>
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
        costs: await gated(gate, grant, () =>
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
      const { csv, rows, filename } = await gated(gate, grant, () =>
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
