import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_LABELS,
  API_ROUTES,
  contactResponseSchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  errorEnvelopeSchema,
  messageListQuerySchema,
  messageListResponseSchema,
  messageResponseSchema,
  publicContactSearchQuerySchema,
  publicContactTagsRequestSchema,
  publicCreateContactRequestSchema,
  publicSendMessageRequestSchema,
  updateContactRequestSchema,
  uploadMediaResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { z } from 'zod';

/**
 * Dokumen OpenAPI 3.1 API publik v1, dibangun dari skema Zod BERSAMA (`@balesin/shared`) — tidak
 * ada definisi kedua yang bisa menyimpang. Contoh token tidak pernah memuat rahasia sungguhan.
 */

type Schema = z.ZodType;

interface Operation {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  scope: ApiKeyScope;
  summary: string;
  description?: string;
  query?: Schema;
  body?: Schema;
  multipart?: boolean;
  idempotency?: boolean;
  responses: Record<number, { description: string; schema: Schema }>;
}

const toJson = (schema: Schema, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;

/** `/api/v1/public/conversations/:conversationId` → `/api/v1/public/conversations/{conversationId}`. */
const openApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

const routes = API_ROUTES.publicApi;
const contactList = z.object({ contacts: z.array(contactResponseSchema.shape.contact) });

const OPERATIONS: readonly Operation[] = [
  {
    method: 'get',
    path: routes.conversations,
    scope: 'conversations:read',
    summary: 'Daftar percakapan',
    description:
      'Terbaru dulu. Saringan sama dengan inbox: status, channelId, tagId, assignee, window, unread, q.',
    query: conversationListQuerySchema,
    responses: { 200: { description: 'Daftar + kursor', schema: conversationListResponseSchema } },
  },
  {
    method: 'get',
    path: routes.conversation,
    scope: 'conversations:read',
    summary: 'Satu percakapan',
    responses: { 200: { description: 'Percakapan', schema: conversationResponseSchema } },
  },
  {
    method: 'post',
    path: routes.handoff,
    scope: 'conversations:write',
    summary: 'Bot menyerahkan percakapan ke tim',
    description:
      'Status `bot` → `unserved` (antrian "Belum dilayani"), event webhook `conversation.handoff`, notifikasi tim. Percakapan yang tidak dipegang bot → 200 dengan `changed: false`.',
    responses: {
      200: {
        description: 'Keadaan percakapan sesudahnya',
        schema: conversationResponseSchema.extend({ changed: z.boolean() }),
      },
    },
  },
  {
    method: 'get',
    path: routes.messages,
    scope: 'messages:read',
    summary: 'Pesan dalam percakapan',
    description: 'Terbaru dulu; `cursor` = halaman lebih lama; `only` = starred | media | files.',
    query: messageListQuerySchema,
    responses: { 200: { description: 'Pesan + kursor', schema: messageListResponseSchema } },
  },
  {
    method: 'post',
    path: routes.messages,
    scope: 'messages:send',
    summary: 'Kirim pesan ke percakapan yang sudah ada',
    description:
      'Hanya di dalam jendela 24 jam (di luar → 409 WINDOW_CLOSED). Rem darurat (423), batas harian per API key & organisasi, batas per percakapan (429) berlaku. Header Idempotency-Key opsional (disarankan).',
    body: publicSendMessageRequestSchema,
    idempotency: true,
    responses: {
      202: { description: 'Diterima, diantre (status pending)', schema: messageResponseSchema },
      200: {
        description: 'Idempotency-Key yang sama sudah dikirim',
        schema: messageResponseSchema,
      },
    },
  },
  {
    method: 'post',
    path: routes.upload,
    scope: 'messages:send',
    summary: 'Unggah media untuk dikirim',
    description:
      'multipart/form-data, isian "file". Jenis ditentukan dari isi (gambar JPG/PNG ≤ 5 MB, audio/video ≤ 16 MB, dokumen ≤ 100 MB). Lalu kirim { type: "media", mediaId }.',
    multipart: true,
    responses: { 201: { description: 'Media siap dikirim', schema: uploadMediaResponseSchema } },
  },
  {
    method: 'get',
    path: routes.message,
    scope: 'messages:read',
    summary: 'Satu pesan (termasuk status kirim)',
    responses: { 200: { description: 'Pesan', schema: messageResponseSchema } },
  },
  {
    method: 'get',
    path: routes.contacts,
    scope: 'contacts:read',
    summary: 'Cari kontak',
    query: publicContactSearchQuerySchema,
    responses: { 200: { description: 'Maks. 50 kontak', schema: contactList } },
  },
  {
    method: 'post',
    path: routes.contacts,
    scope: 'contacts:write',
    summary: 'Buat kontak WhatsApp dari nomor',
    description: 'Nomor yang sudah ada → kontak itu dikembalikan (200).',
    body: publicCreateContactRequestSchema,
    responses: {
      201: { description: 'Kontak baru', schema: contactResponseSchema },
      200: { description: 'Kontak dengan nomor itu sudah ada', schema: contactResponseSchema },
    },
  },
  {
    method: 'get',
    path: routes.contact,
    scope: 'contacts:read',
    summary: 'Satu kontak',
    responses: { 200: { description: 'Kontak', schema: contactResponseSchema } },
  },
  {
    method: 'patch',
    path: routes.contact,
    scope: 'contacts:write',
    summary: 'Ubah kontak (nama, email, catatan, atribut)',
    body: updateContactRequestSchema,
    responses: { 200: { description: 'Kontak', schema: contactResponseSchema } },
  },
  {
    method: 'post',
    path: routes.contactTags,
    scope: 'contacts:write',
    summary: 'Pasang tag (berdasarkan nama; tag baru dibuat)',
    body: publicContactTagsRequestSchema,
    responses: { 200: { description: 'Kontak', schema: contactResponseSchema } },
  },
  {
    method: 'delete',
    path: routes.contactTags,
    scope: 'contacts:write',
    summary: 'Lepas tag (berdasarkan nama)',
    body: publicContactTagsRequestSchema,
    responses: { 200: { description: 'Kontak', schema: contactResponseSchema } },
  },
];

const ERROR_RESPONSES: Record<number, string> = {
  400: 'Isian tidak valid (VALIDATION_ERROR)',
  401: 'API key tidak ada / tidak valid / dicabut / kedaluwarsa',
  403: 'Scope kurang atau IP tidak diizinkan',
  404: 'Tidak ditemukan',
  429: 'Batas permintaan / batas kirim tercapai',
};

function queryParameters(schema: Schema | undefined) {
  if (!schema) return [];
  const json = toJson(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: property,
  }));
}

/** Dokumen OpenAPI 3.1 (objek biasa; dibangun sekali saat start). */
export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    const path = openApiPath(operation.path);
    const params = [...operation.path.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    const responses: Record<string, unknown> = {};
    for (const [status, response] of Object.entries(operation.responses)) {
      responses[status] = {
        description: response.description,
        content: { 'application/json': { schema: toJson(response.schema, 'output') } },
      };
    }
    for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
      responses[status] ??= {
        description,
        content: { 'application/json': { schema: toJson(errorEnvelopeSchema, 'output') } },
      };
    }
    paths[path] ??= {};
    paths[path][operation.method] = {
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      tags: [operation.scope.split(':')[0]],
      security: [{ apiKey: [operation.scope] }],
      'x-balesin-scope': operation.scope,
      parameters: [
        ...params,
        ...queryParameters(operation.query),
        ...(operation.idempotency
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                schema: { type: 'string', maxLength: 100 },
                description:
                  'Permintaan ulang dengan kunci sama tidak menggandakan pesan (per API key).',
              },
            ]
          : []),
      ],
      ...(operation.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJson(operation.body, 'input') } },
            },
          }
        : {}),
      ...(operation.multipart
        ? {
            requestBody: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['file'],
                    properties: { file: { type: 'string', format: 'binary' } },
                  },
                },
              },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'API publik v1',
      version: '1.0.0',
      description:
        'API untuk integrasi (n8n, bot, sistem lain). Autentikasi: header `Authorization: Bearer <API key>` dari Pengaturan → API key. Galat: `{ "error": { "code", "message" } }`.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: `Scope: ${API_KEY_SCOPES.map((scope) => `${scope} (${API_KEY_SCOPE_LABELS[scope]})`).join('; ')}.`,
        },
      },
    },
    paths,
  };
}
