import multipart from '@fastify/multipart';
import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  BROADCAST_LIMITS,
  CONTACT_LIST_PAGE_DEFAULT,
  attributeDefinitionListResponseSchema,
  attributeDefinitionResponseSchema,
  attributeIdParamsSchema,
  contactBulkExportRequestSchema,
  contactIdParamsSchema,
  contactImportMappingSchema,
  contactImportResultSchema,
  contactListQuerySchema,
  contactListResponseSchema,
  createAttributeDefinitionRequestSchema,
  errorEnvelopeSchema,
  mergeContactRequestSchema,
  mergeContactResponseSchema,
  updateAttributeDefinitionRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { ATTRIBUTE_NOT_FOUND, type AttributesService } from '../attributes/attributes.service';
import { requireAuth } from '../auth/auth.hook';
import { ImportBusyError } from '../broadcasts/import-runner';
import { ImportError } from '../broadcasts/recipient-import';
import { permissionGrant } from '../auth/permission-grant';
import { contactTagsOf, decodeCursor, encodeCursor, findContact } from '../inbox/inbox.repo';
import { toContact } from '../inbox/inbox-view';
import { CONTACT_NOT_FOUND } from './contacts.service';
import { listContacts, type CrmService, type ImportTable } from './crm.service';

export interface CrmRoutesOptions {
  db: Database;
  crm: CrmService;
  attributes: AttributesService;
  limiter: RateLimiter;
  cookieSecure: boolean;
  /**
   * Parser CSV/XLSX TERISOLASI (thread terpisah, batas waktu & memori) — milik modul broadcast
   * (`parseTableIsolated`). Galat parser = `ImportError` berpesan Indonesia.
   */
  parseTable: (key: string, buffer: Buffer) => Promise<ImportTable>;
}

/** Ekspor massal: 5/jam per pengguna. Impor: 10/jam. Gabung: 30/jam. Daftar: 120/menit. */
export const CONTACT_BULK_EXPORT_RULE: RateLimitRule = {
  name: 'kontak-ekspor-massal',
  limit: 5,
  windowSeconds: 60 * 60,
};
export const CONTACT_IMPORT_RULE: RateLimitRule = {
  name: 'kontak-impor',
  limit: 10,
  windowSeconds: 60 * 60,
};
const MERGE_RULE: RateLimitRule = { name: 'kontak-gabung', limit: 30, windowSeconds: 60 * 60 };
const LIST_RULE: RateLimitRule = { name: 'kontak-daftar', limit: 120, windowSeconds: 60 };
const ATTRIBUTE_RULE: RateLimitRule = { name: 'atribut-ubah', limit: 60, windowSeconds: 60 };

const UUID = z.uuid();
const limitMessage = (wait: string) => `Terlalu banyak permintaan. Coba lagi dalam ${wait}.`;

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

function uuidOr404(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

/**
 * CRM Fase 5 (docs/KONTRAK-API-CRM-TIKET.md "Kontak"): daftar & cari kontak, ekspor/impor massal,
 * gabung duplikat, definisi atribut kontak. Tulis = CSRF (hook auth).
 */
export const crmRoutes: FastifyPluginAsyncZod<CrmRoutesOptions> = async (app, options) => {
  const { db, crm, attributes, limiter, cookieSecure } = options;
  const routes = API_ROUTES.crm;

  // Parser multipart HANYA di plugin ini: satu isian `mapping` (JSON) lalu satu berkas `file`.
  await app.register(multipart, {
    limits: {
      fileSize: BROADCAST_LIMITS.maxFileBytes,
      files: 1,
      fields: 1,
      parts: 2,
      fieldNameSize: 32,
      fieldSize: 16 * 1024,
    },
  });

  const contextOf = (request: FastifyRequest) => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  // ── Daftar & cari ─────────────────────────────────────────────────────────

  app.get(
    routes.contacts,
    {
      config: { access: requirePermission('contacts.view') },
      schema: {
        querystring: contactListQuerySchema,
        response: { 200: contactListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'contacts.view');
      await enforceRateLimit(limiter, LIST_RULE, grant.userId, limitMessage);
      const { cursor: rawCursor, limit, ...filter } = request.query;
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
      }
      const pageSize = limit ?? CONTACT_LIST_PAGE_DEFAULT;
      const rows = await listContacts(db, grant, filter, { limit: pageSize + 1, cursor });
      const visible = rows.slice(0, pageSize);
      const tagsByContact = await contactTagsOf(
        db,
        grant.organizationId,
        visible.map((row) => row.id),
      );
      const last = visible.at(-1);
      return {
        contacts: visible.map((row) => toContact(row, tagsByContact.get(row.id) ?? [])),
        nextCursor:
          rows.length > pageSize && last
            ? encodeCursor({ atExact: last.createdAtExact, id: last.id })
            : null,
      };
    },
  );

  // ── Ekspor massal (CSV) ───────────────────────────────────────────────────

  app.post(
    routes.exportContacts,
    {
      config: { access: requirePermission('contacts.export'), rawResponse: true },
      schema: { body: contactBulkExportRequestSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CONTACT_BULK_EXPORT_RULE, auth.user.id, limitMessage);
      const { csv, rows } = await crm.exportCsv(
        auth,
        request.body.filter,
        request.body.confirmation,
        contextOf(request),
      );
      void reply.headers({
        'content-disposition': 'attachment; filename="kontak.csv"',
        'cache-control': 'no-store',
        'x-export-rows': String(rows),
      });
      return reply.type('text/csv; charset=utf-8').send(csv);
    },
  );

  // ── Impor massal ──────────────────────────────────────────────────────────

  app.post(
    routes.importContacts,
    {
      config: { access: requirePermission('contacts.export') },
      schema: { response: { 200: contactImportResultSchema, ...errors } },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CONTACT_IMPORT_RULE, auth.user.id, limitMessage);
      if (!request.isMultipart()) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Kirim sebagai multipart/form-data: isian "mapping" (JSON) lalu berkas "file".',
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
      const field = part.fields.mapping;
      const rawMapping =
        field && !Array.isArray(field) && field.type === 'field' ? field.value : undefined;
      let mappingJson: unknown;
      try {
        mappingJson = typeof rawMapping === 'string' ? JSON.parse(rawMapping) : undefined;
      } catch {
        mappingJson = undefined;
      }
      const mapping = contactImportMappingSchema.safeParse(mappingJson);
      if (!mapping.success) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Pemetaan kolom tidak valid (isian "mapping" dikirim SEBELUM berkas).',
          details: mapping.error.issues.slice(0, 10).map((issue) => ({
            location: 'body' as const,
            field: ['mapping', ...issue.path.map(String)].join('.'),
            message: issue.message,
          })),
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      if (part.file.truncated) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Berkas terlalu besar (maks. 5 MB).' });
      }
      let table: ImportTable;
      try {
        // Kunci gerbang = ID pengguna (sama dengan impor broadcast): satu parsing per pengguna.
        table = await options.parseTable(auth.user.id, Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof ImportBusyError) {
          throw new AppError('RATE_LIMITED', {
            message: 'Impor lain sedang diproses. Tunggu sebentar lalu coba lagi.',
            retryAfterSeconds: 5,
          });
        }
        if (error instanceof ImportError) {
          throw new AppError('VALIDATION_ERROR', {
            message: error.message,
            details: [{ location: 'body', field: 'file', message: error.message }],
          });
        }
        throw error;
      }
      return crm.importTable(auth, table, mapping.data, clientInfo(request));
    },
  );

  // ── Gabung duplikat ───────────────────────────────────────────────────────

  app.post(
    routes.merge,
    {
      config: { access: requirePermission('contacts.manage') },
      schema: {
        params: contactIdParamsSchema,
        body: mergeContactRequestSchema,
        response: { 200: mergeContactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const targetId = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await enforceRateLimit(limiter, MERGE_RULE, auth.user.id, limitMessage);
      const moved = await crm.merge(
        auth,
        targetId,
        request.body.sourceContactId,
        request.body.confirmation,
        contextOf(request),
      );
      const grant = await permissionGrant(request, 'contacts.view');
      const row = await findContact(db, grant, targetId);
      if (!row) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
      const tagsByContact = await contactTagsOf(db, grant.organizationId, [row.id]);
      return { contact: toContact(row, tagsByContact.get(row.id) ?? []), moved };
    },
  );

  // ── Definisi atribut kontak ───────────────────────────────────────────────

  const SETTINGS = requirePermission('settings.workspace.manage');

  app.get(
    routes.attributes,
    {
      config: { access: requirePermission('contacts.view') },
      schema: { response: { 200: attributeDefinitionListResponseSchema, ...errors } },
    },
    async (request) => ({
      attributes: await attributes.list(requireAuth(request).organizationId, { entity: 'contact' }),
    }),
  );

  app.post(
    routes.attributes,
    {
      config: { access: SETTINGS },
      schema: {
        body: createAttributeDefinitionRequestSchema,
        response: { 201: attributeDefinitionResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, ATTRIBUTE_RULE, auth.user.id, limitMessage);
      const attribute = await attributes.create(
        auth,
        { entity: 'contact' },
        request.body,
        clientInfo(request),
      );
      void reply.code(201);
      return { attribute };
    },
  );

  app.patch(
    routes.attribute,
    {
      config: { access: SETTINGS },
      schema: {
        params: attributeIdParamsSchema,
        body: updateAttributeDefinitionRequestSchema,
        response: { 200: attributeDefinitionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, ATTRIBUTE_RULE, auth.user.id, limitMessage);
      const id = uuidOr404(request.params.attributeId, ATTRIBUTE_NOT_FOUND);
      return {
        attribute: await attributes.update(
          auth,
          { entity: 'contact' },
          id,
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.delete(
    routes.attribute,
    {
      config: { access: SETTINGS },
      schema: {
        params: attributeIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, ATTRIBUTE_RULE, auth.user.id, limitMessage);
      const id = uuidOr404(request.params.attributeId, ATTRIBUTE_NOT_FOUND);
      await attributes.remove(auth, { entity: 'contact' }, id, clientInfo(request));
      return { deleted: true as const };
    },
  );
};
