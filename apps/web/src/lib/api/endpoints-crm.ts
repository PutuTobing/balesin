import {
  API_ROUTES,
  REPORT_ROUTES,
  apiPath,
  attributeDefinitionListResponseSchema,
  attributeDefinitionResponseSchema,
  contactImportResultSchema,
  contactListResponseSchema,
  conversationActionResponseSchema,
  csatSettingsResponseSchema,
  departmentAccessResponseSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  departmentSettingsResponseSchema,
  mergeContactResponseSchema,
  reportCostsResponseSchema,
  reportPerformanceResponseSchema,
  ticketActionResponseSchema,
  ticketBoardListResponseSchema,
  ticketBoardResponseSchema,
  ticketCommentListResponseSchema,
  ticketCommentResponseSchema,
  ticketEventListResponseSchema,
  ticketKanbanResponseSchema,
  ticketListResponseSchema,
  ticketResponseSchema,
  type ContactFilter,
  type ContactImportMapping,
  type CreateAttributeDefinitionRequest,
  type CreateDepartmentRequest,
  type CreateTicketBoardRequest,
  type CreateTicketColumnRequest,
  type CreateTicketRequest,
  type CsatSettingsValues,
  type IdentityConfirmation,
  type MoveTicketRequest,
  type UpdateAttributeDefinitionRequest,
  type UpdateDepartmentAccessRequest,
  type UpdateDepartmentRequest,
  type UpdateTicketBoardRequest,
  type UpdateTicketColumnRequest,
  type UpdateTicketRequest,
} from '@balesin/shared';
import { z } from 'zod';
import type { ApiClient } from './client';

/** Objek parameter → `?a=b` (nilai kosong tidak dikirim, urutan kunci tetap). */
export function queryString(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const deleted = z.object({ deleted: z.literal(true) });

/** Jalur definisi atribut: kontak (organisasi) atau tiket (per board). */
export type AttributeScope = { kind: 'contact' } | { kind: 'board'; boardId: string };

export interface ContactListParams extends Partial<Record<keyof ContactFilter, string>> {
  cursor?: string | null;
  limit?: number;
}

export interface TicketListParams {
  boardId?: string;
  columnId?: string;
  assignee?: string;
  priority?: string;
  status?: 'open' | 'closed' | 'all';
  due?: string;
  contactId?: string;
  conversationId?: string;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * Endpoint Fase 5 (docs/KONTRAK-API-CRM-TIKET.md, docs/KONTRAK-API-LAPORAN.md): kontak (daftar,
 * impor/ekspor, gabung, atribut), tiket (board, kolom, Kanban, komentar, riwayat), departemen,
 * laporan & CSAT.
 */
export function createCrmEndpoints(client: ApiClient) {
  const attributePaths = (scope: AttributeScope) =>
    scope.kind === 'contact'
      ? {
          list: API_ROUTES.crm.attributes,
          one: (attributeId: string) => apiPath(API_ROUTES.crm.attribute, { attributeId }),
        }
      : {
          list: apiPath(API_ROUTES.tickets.attributes, { boardId: scope.boardId }),
          one: (attributeId: string) =>
            apiPath(API_ROUTES.tickets.attribute, { boardId: scope.boardId, attributeId }),
        };

  return {
    crm: {
      contacts: (params: ContactListParams, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.crm.contacts}${queryString({ ...params })}`, {
          schema: contactListResponseSchema,
          signal,
        }),
      /** CSV kontak (POST + konfirmasi identitas) → Blob. */
      exportContacts: (filter: ContactFilter, confirmation: IdentityConfirmation) =>
        client.download(API_ROUTES.crm.exportContacts, {
          method: 'POST',
          body: { filter, confirmation },
        }),
      /** Multipart: `mapping` (JSON) DIKIRIM SEBELUM `file` (server membaca berurutan). */
      importContacts: (
        file: File,
        mapping: Partial<ContactImportMapping> & { phoneColumn: string },
      ) => {
        const form = new FormData();
        form.append('mapping', JSON.stringify(mapping));
        form.append('file', file, file.name);
        return client.request(API_ROUTES.crm.importContacts, {
          method: 'POST',
          body: form,
          schema: contactImportResultSchema,
        });
      },
      merge: (contactId: string, sourceContactId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.crm.merge, { contactId }), {
          method: 'POST',
          body: { sourceContactId, confirmation },
          schema: mergeContactResponseSchema,
        }),
    },
    attributes: {
      list: (scope: AttributeScope, signal?: AbortSignal) =>
        client.request(attributePaths(scope).list, {
          schema: attributeDefinitionListResponseSchema,
          signal,
        }),
      create: (scope: AttributeScope, body: CreateAttributeDefinitionRequest) =>
        client.request(attributePaths(scope).list, {
          method: 'POST',
          body,
          schema: attributeDefinitionResponseSchema,
        }),
      update: (
        scope: AttributeScope,
        attributeId: string,
        body: UpdateAttributeDefinitionRequest,
      ) =>
        client.request(attributePaths(scope).one(attributeId), {
          method: 'PATCH',
          body,
          schema: attributeDefinitionResponseSchema,
        }),
      remove: (scope: AttributeScope, attributeId: string) =>
        client.request(attributePaths(scope).one(attributeId), {
          method: 'DELETE',
          schema: deleted,
        }),
    },
    tickets: {
      list: (params: TicketListParams, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.tickets.list}${queryString({ ...params })}`, {
          schema: ticketListResponseSchema,
          signal,
        }),
      get: (ticketId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.tickets.ticket, { ticketId }), {
          schema: ticketResponseSchema,
          signal,
        }),
      create: (body: CreateTicketRequest) =>
        client.request(API_ROUTES.tickets.list, {
          method: 'POST',
          body,
          schema: ticketActionResponseSchema,
        }),
      update: (ticketId: string, body: UpdateTicketRequest) =>
        client.request(apiPath(API_ROUTES.tickets.ticket, { ticketId }), {
          method: 'PATCH',
          body,
          schema: ticketActionResponseSchema,
        }),
      move: (ticketId: string, body: MoveTicketRequest) =>
        client.request(apiPath(API_ROUTES.tickets.move, { ticketId }), {
          method: 'POST',
          body,
          schema: ticketActionResponseSchema,
        }),
      remove: (ticketId: string) =>
        client.request(apiPath(API_ROUTES.tickets.ticket, { ticketId }), {
          method: 'DELETE',
          schema: deleted,
        }),
      comments: (ticketId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.tickets.comments, { ticketId }), {
          schema: ticketCommentListResponseSchema,
          signal,
        }),
      addComment: (ticketId: string, body: string) =>
        client.request(apiPath(API_ROUTES.tickets.comments, { ticketId }), {
          method: 'POST',
          body: { body },
          schema: ticketCommentResponseSchema,
        }),
      removeComment: (ticketId: string, commentId: string) =>
        client.request(apiPath(API_ROUTES.tickets.comment, { ticketId, commentId }), {
          method: 'DELETE',
          schema: deleted,
        }),
      events: (ticketId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.tickets.events, { ticketId }), {
          schema: ticketEventListResponseSchema,
          signal,
        }),
      boards: (archived: boolean, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.tickets.boards}${archived ? '?archived=true' : ''}`, {
          schema: ticketBoardListResponseSchema,
          signal,
        }),
      createBoard: (body: CreateTicketBoardRequest) =>
        client.request(API_ROUTES.tickets.boards, {
          method: 'POST',
          body,
          schema: ticketBoardResponseSchema,
        }),
      updateBoard: (boardId: string, body: UpdateTicketBoardRequest) =>
        client.request(apiPath(API_ROUTES.tickets.board, { boardId }), {
          method: 'PATCH',
          body,
          schema: ticketBoardResponseSchema,
        }),
      kanban: (
        boardId: string,
        params: { assignee?: string; priority?: string },
        signal?: AbortSignal,
      ) =>
        client.request(
          `${apiPath(API_ROUTES.tickets.kanban, { boardId })}${queryString({ ...params })}`,
          { schema: ticketKanbanResponseSchema, signal },
        ),
      addColumn: (boardId: string, body: CreateTicketColumnRequest) =>
        client.request(apiPath(API_ROUTES.tickets.columns, { boardId }), {
          method: 'POST',
          body,
          schema: ticketBoardResponseSchema,
        }),
      updateColumn: (boardId: string, columnId: string, body: UpdateTicketColumnRequest) =>
        client.request(apiPath(API_ROUTES.tickets.column, { boardId, columnId }), {
          method: 'PATCH',
          body,
          schema: ticketBoardResponseSchema,
        }),
      /** Body wajib objek: `{}` bila kolom kosong, `{ moveToColumnId }` bila berisi. */
      removeColumn: (boardId: string, columnId: string, moveToColumnId: string | null) =>
        client.request(apiPath(API_ROUTES.tickets.column, { boardId, columnId }), {
          method: 'DELETE',
          body: moveToColumnId ? { moveToColumnId } : {},
          schema: ticketBoardResponseSchema,
        }),
    },
    departments: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.departments.list, {
          schema: departmentListResponseSchema,
          signal,
        }),
      settings: (signal?: AbortSignal) =>
        client.request(API_ROUTES.departments.settings, {
          schema: departmentSettingsResponseSchema,
          signal,
        }),
      create: (body: CreateDepartmentRequest) =>
        client.request(API_ROUTES.departments.settings, {
          method: 'POST',
          body,
          schema: departmentResponseSchema,
        }),
      update: (departmentId: string, body: UpdateDepartmentRequest) =>
        client.request(apiPath(API_ROUTES.departments.department, { departmentId }), {
          method: 'PATCH',
          body,
          schema: departmentResponseSchema,
        }),
      remove: (departmentId: string) =>
        client.request(apiPath(API_ROUTES.departments.department, { departmentId }), {
          method: 'DELETE',
          schema: deleted,
        }),
      access: (userId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.departments.access, { userId }), {
          schema: departmentAccessResponseSchema,
          signal,
        }),
      updateAccess: (userId: string, body: UpdateDepartmentAccessRequest) =>
        client.request(apiPath(API_ROUTES.departments.access, { userId }), {
          method: 'PUT',
          body,
          schema: departmentAccessResponseSchema,
        }),
      /** Pindah percakapan ke departemen (`null` = lepas). `conversation: null` = di luar cakupan. */
      moveConversation: (conversationId: string, departmentId: string | null) =>
        client.request(apiPath(API_ROUTES.inbox.department, { conversationId }), {
          method: 'POST',
          body: { departmentId },
          schema: conversationActionResponseSchema,
        }),
    },
    reports: {
      performance: (
        params: { from: string; to: string; channelId?: string },
        signal?: AbortSignal,
      ) =>
        client.request(`${REPORT_ROUTES.performance}${queryString({ ...params })}`, {
          schema: reportPerformanceResponseSchema,
          signal,
        }),
      costs: (params: { month: string; channelId?: string }, signal?: AbortSignal) =>
        client.request(`${REPORT_ROUTES.costs}${queryString({ ...params })}`, {
          schema: reportCostsResponseSchema,
          signal,
        }),
      /** GET ber-CSRF → Blob CSV (diaudit server). */
      exportCsv: (params: {
        kind: string;
        from?: string;
        to?: string;
        month?: string;
        channelId?: string;
      }) => client.download(`${REPORT_ROUTES.exportCsv}${queryString({ ...params })}`),
      csat: (signal?: AbortSignal) =>
        client.request(REPORT_ROUTES.csatSettings, { schema: csatSettingsResponseSchema, signal }),
      updateCsat: (body: CsatSettingsValues) =>
        client.request(REPORT_ROUTES.csatSettings, {
          method: 'PUT',
          body,
          schema: csatSettingsResponseSchema,
        }),
    },
  };
}
