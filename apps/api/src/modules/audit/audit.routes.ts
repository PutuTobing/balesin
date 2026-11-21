import {
  API_ROUTES,
  auditLogFilterSchema,
  auditLogListQuerySchema,
  auditLogListResponseSchema,
  errorEnvelopeSchema,
  securitySummaryResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { AuditService } from './audit.service';

export interface AuditRoutesOptions {
  audit: AuditService;
}

/** PRD §4 "Audit log" = `audit.view` (Owner, Admin). */
const VIEW = requirePermission('audit.view');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

/**
 * Audit log (docs/KONTRAK-API-AUTH.md bagian "Audit log").
 *
 * - `GET /audit-logs`                   daftar bersaring + kursor
 * - `GET /audit-logs/export`            CSV (unduhan) dengan saringan yang sama
 * - `GET /audit-logs/security-summary`  ringkasan kejadian keamanan 7 hari terakhir
 */
export const auditRoutes: FastifyPluginCallbackZod<AuditRoutesOptions> = (app, options, done) => {
  const { audit } = options;

  app.get(
    API_ROUTES.audit.list,
    {
      config: { access: VIEW },
      schema: {
        querystring: auditLogListQuerySchema,
        response: { 200: auditLogListResponseSchema, ...errors },
      },
    },
    async (request) => audit.list(requireAuth(request), request.query),
  );

  app.get(
    API_ROUTES.audit.export,
    {
      // Isi CSV, bukan JSON: tidak lewat skema respons (error tetap amplop JSON biasa).
      // Efek samping (jatah 10/jam + audit `audit.exported` + unduhan data pribadi): wajib CSRF
      // walau GET, dan permintaan lintas situs ditolak (review butir 6 R3).
      config: { access: VIEW, rawResponse: true, requireCsrf: true },
      schema: { querystring: auditLogFilterSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { csv, rows, truncated } = await audit.exportCsv(
        auth,
        request.query,
        clientInfo(request),
      );
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      void reply.headers({
        'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
        'cache-control': 'no-store',
        'x-export-rows': String(rows),
        'x-export-truncated': truncated ? '1' : '0',
      });
      return reply.type('text/csv; charset=utf-8').send(csv);
    },
  );

  app.get(
    API_ROUTES.audit.securitySummary,
    {
      config: { access: VIEW },
      schema: { response: { 200: securitySummaryResponseSchema, ...errors } },
    },
    async (request) => audit.securitySummary(requireAuth(request)),
  );

  done();
};
