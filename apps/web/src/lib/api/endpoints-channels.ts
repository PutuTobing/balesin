import {
  API_ROUTES,
  apiPath,
  allocationAgentListResponseSchema,
  allocationAgentResponseSchema,
  availabilityResponseSchema,
  channelWebhookResponseSchema,
  connectionChannelListResponseSchema,
  connectionChannelResponseSchema,
  connectionTestResultSchema,
  createConnectionChannelResponseSchema,
  deleteChannelResponseSchema,
  emailHtmlResponseSchema,
  workspaceSettingsResponseSchema,
  channelAccessResponseSchema,
  updateChannelAccessResponseSchema,
  type CreateConnectionChannelRequest,
  type UpdateChannelAccessInput,
  type IdentityConfirmation,
  type UpdateAllocationAgentRequest,
  type UpdateConnectionChannelRequest,
  type UpdateWorkspaceSettingsRequest,
} from '@balesin/shared';
import type { ApiClient } from './client';

/**
 * Endpoint Fase 6 + jam kerja: channel selain WhatsApp (docs/KONTRAK-API-CHANNEL-LAIN.md), HTML email
 * tersanitasi, pengaturan kerja tim (jam kerja, pesan otomatis, alokasi) dan ketersediaan agen
 * (docs/KONTRAK-API-INBOX.md "Jam kerja, pesan otomatis, alokasi").
 */
export function createChannelEndpoints(client: ApiClient) {
  const R = API_ROUTES.channelConnections;
  const one = (route: string, channelId: string) => apiPath(route, { channelId });
  return {
    connections: {
      list: (signal?: AbortSignal) =>
        client.request(R.list, { schema: connectionChannelListResponseSchema, signal }),
      get: (channelId: string, signal?: AbortSignal) =>
        client.request(one(R.channel, channelId), {
          schema: connectionChannelResponseSchema,
          signal,
        }),
      /** Wajib konfirmasi identitas. Rahasia hanya dikirim ke server, tidak pernah dibaca balik. */
      create: (body: CreateConnectionChannelRequest) =>
        client.request(R.list, {
          method: 'POST',
          body,
          schema: createConnectionChannelResponseSchema,
        }),
      update: (channelId: string, body: UpdateConnectionChannelRequest) =>
        client.request(one(R.channel, channelId), {
          method: 'PATCH',
          body,
          schema: connectionChannelResponseSchema,
        }),
      remove: (channelId: string, confirmation: IdentityConfirmation) =>
        client.request(one(R.channel, channelId), {
          method: 'DELETE',
          // `deleteChannelRequestSchema`: password & kode di tingkat atas (bukan `{ confirmation }`).
          body: confirmation,
          schema: deleteChannelResponseSchema,
        }),
      enable: (channelId: string) =>
        client.request(one(R.enable, channelId), {
          method: 'POST',
          body: {},
          schema: connectionChannelResponseSchema,
        }),
      disable: (channelId: string) =>
        client.request(one(R.disable, channelId), {
          method: 'POST',
          body: {},
          schema: connectionChannelResponseSchema,
        }),
      test: (channelId: string) =>
        client.request(one(R.test, channelId), {
          method: 'POST',
          body: {},
          schema: connectionTestResultSchema,
        }),
      webhook: (channelId: string, signal?: AbortSignal) =>
        client.request(one(R.webhook, channelId), {
          schema: channelWebhookResponseSchema,
          signal,
        }),
      /** Telegram: pasang ulang (secret baru). Messenger/Instagram: verify token baru. */
      renewWebhook: (channelId: string) =>
        client.request(one(R.webhook, channelId), {
          method: 'POST',
          body: {},
          schema: createConnectionChannelResponseSchema,
        }),
    },
    /**
     * Tahap 9.0 — akses per channel (semua jenis, `channels.manage`). PUT mengganti seluruh aturan.
     */
    channelAccess: {
      get: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.access, { channelId }), {
          schema: channelAccessResponseSchema,
          signal,
        }),
      update: (channelId: string, body: UpdateChannelAccessInput) =>
        client.request(apiPath(API_ROUTES.channels.access, { channelId }), {
          method: 'PUT',
          body,
          schema: updateChannelAccessResponseSchema,
        }),
    },
    emailHtml: (messageId: string, signal?: AbortSignal) =>
      client.request(apiPath(API_ROUTES.inbox.emailHtml, { messageId }), {
        schema: emailHtmlResponseSchema,
        signal,
      }),
    workspace: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.workspace.settings, {
          schema: workspaceSettingsResponseSchema,
          signal,
        }),
      /** Mengaktifkan/mengubah teks pesan otomatis wajib `confirmation`. */
      update: (body: UpdateWorkspaceSettingsRequest) =>
        client.request(API_ROUTES.workspace.settings, {
          method: 'PUT',
          body,
          schema: workspaceSettingsResponseSchema,
        }),
      agents: (signal?: AbortSignal) =>
        client.request(API_ROUTES.workspace.agents, {
          schema: allocationAgentListResponseSchema,
          signal,
        }),
      updateAgent: (userId: string, body: UpdateAllocationAgentRequest) =>
        client.request(apiPath(API_ROUTES.workspace.agent, { userId }), {
          method: 'PATCH',
          body,
          schema: allocationAgentResponseSchema,
        }),
    },
    availability: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.inbox.availability, {
          schema: availabilityResponseSchema,
          signal,
        }),
      set: (available: boolean) =>
        client.request(API_ROUTES.inbox.availability, {
          method: 'PUT',
          body: { available },
          schema: availabilityResponseSchema,
        }),
    },
  };
}
