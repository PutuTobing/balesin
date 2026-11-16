import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  addContactTagRequestSchema,
  contactIdParamsSchema,
  contactResponseSchema,
  contactExportSchema,
  contactTagParamsSchema,
  deleteContactRequestSchema,
  deleteContactResponseSchema,
  errorEnvelopeSchema,
  updateContactRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { contactTagsOf, findContact } from '../inbox/inbox.repo';
import { toContact } from '../inbox/inbox-view';
import { CONTACT_NOT_FOUND, TAG_NOT_FOUND, type ContactsService } from './contacts.service';

export interface ContactsRoutesOptions {
  db: Database;
  contacts: ContactsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Ekspor data satu kontak: 20/jam per pengguna (permintaan akses data jarang). */
export const CONTACT_EXPORT_RULE: RateLimitRule = {
  name: 'kontak-ekspor',
  limit: 20,
  windowSeconds: 60 * 60,
};

/**
 * Ubah kontak dari panel detail (Fase 2 butir 8): `PATCH /contacts/:id`, pasang/lepas tag. Izin
 * `contacts.manage` (PRD §4 "Lihat & ubah kontak"; Teknisi hanya melihat). CSRF lewat hook auth.
 */
export const PANEL_WRITE_RULE: RateLimitRule = {
  name: 'panel-ubah',
  limit: 120,
  windowSeconds: 60,
};

const MANAGE = requirePermission('contacts.manage');
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
};

function uuidOr404(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

export const contactsRoutes: FastifyPluginCallbackZod<ContactsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db, contacts, limiter, cookieSecure } = options;
  const routes = API_ROUTES.inbox;

  async function respond(request: FastifyRequest, contactId: string) {
    const grant = await permissionGrant(request, 'contacts.view');
    const row = await findContact(db, grant, contactId);
    if (!row) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
    const tagsByContact = await contactTagsOf(db, grant.organizationId, [row.id]);
    return { contact: toContact(row, tagsByContact.get(row.id) ?? []) };
  }

  app.patch(
    routes.contact,
    {
      config: { access: MANAGE },
      schema: {
        params: contactIdParamsSchema,
        body: updateContactRequestSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
      await contacts.update(auth, id, request.body);
      return respond(request, id);
    },
  );

  // Hapus kontak (UU PDP): `contacts.delete` (Owner/Admin) + konfirmasi identitas.
  app.delete(
    routes.contact,
    {
      config: { access: requirePermission('contacts.delete') },
      schema: {
        params: contactIdParamsSchema,
        body: deleteContactRequestSchema,
        response: { 200: deleteContactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
      const deleted = await contacts.remove(auth, id, request.body.confirmation, {
        client: clientInfo(request),
        log: request.log,
        presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
      });
      return { deleted };
    },
  );

  // Ekspor data satu kontak (permintaan akses data UU PDP): `contacts.export`, diaudit.
  app.get(
    routes.contactExport,
    {
      config: { access: requirePermission('contacts.export') },
      schema: {
        params: contactIdParamsSchema,
        response: { 200: contactExportSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await enforceRateLimit(limiter, CONTACT_EXPORT_RULE, auth.user.id, limitMessage);
      const data = await contacts.exportData(auth, clientInfo(request), id);
      void reply
        .header(
          'Content-Disposition',
          `attachment; filename="kontak-${String(data.contact.number)}.json"`,
        )
        .header('Cache-Control', 'no-store');
      return data;
    },
  );

  app.post(
    routes.contactTags,
    {
      config: { access: MANAGE },
      schema: {
        params: contactIdParamsSchema,
        body: addContactTagRequestSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
      await contacts.addTag(auth, id, request.body.tagId);
      return respond(request, id);
    },
  );

  app.delete(
    routes.contactTag,
    {
      config: { access: MANAGE },
      schema: {
        params: contactTagParamsSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      const tagId = uuidOr404(request.params.tagId, TAG_NOT_FOUND);
      await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
      await contacts.removeTag(auth, id, tagId);
      return respond(request, id);
    },
  );

  done();
};
