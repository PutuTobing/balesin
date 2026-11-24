import {
  API_ROUTES,
  apiPath,
  emailMessageTemplatePreviewResponseSchema,
  emailOutboundListResponseSchema,
  emailSenderSettingsListResponseSchema,
  emailSenderSettingsResponseSchema,
  emailTemplateListResponseSchema,
  emailTemplatePresetsResponseSchema,
  emailTemplateResponseSchema,
  emailTemplateTestResponseSchema,
  emailTemplateVersionResponseSchema,
  emailTemplateVersionsResponseSchema,
  type CreateEmailTemplateRequest,
  type EmailMessageTemplatePreviewRequest,
  type EmailOutboundListQuery,
  type EmailTemplatePresetKey,
  type IdentityConfirmation,
  type UpdateEmailSenderLimitRequest,
  type UpdateEmailTemplateRequest,
} from '@balesin/shared';
import type { ApiClient } from './client';
import { queryString } from './endpoints-crm';

/**
 * Tahap 9.1 — Pengaturan → Template email, batas per pengirim email, dan riwayat email API
 * (docs/KONTRAK-API-EMAIL-KIRIM.md §7–§8). Permintaan berkonfirmasi identitas (terbitkan template,
 * menaikkan batas, melanjutkan pengirim) dipanggil langsung dari komponen, bukan lewat `useMutation`.
 */
export function createEmailEndpoints(client: ApiClient) {
  const routes = API_ROUTES.emailTemplates;
  const template = (templateId: string) => apiPath(routes.template, { templateId });
  return {
    emailTemplates: {
      list: (filter: { q?: string; archived?: boolean }, signal?: AbortSignal) =>
        client.request(
          `${routes.list}${queryString({
            q: filter.q,
            archived: filter.archived === undefined ? undefined : String(filter.archived),
          })}`,
          { schema: emailTemplateListResponseSchema, signal },
        ),
      create: (body: CreateEmailTemplateRequest) =>
        client.request(routes.list, {
          method: 'POST',
          body,
          schema: emailTemplateResponseSchema,
        }),
      get: (templateId: string, signal?: AbortSignal) =>
        client.request(template(templateId), { schema: emailTemplateResponseSchema, signal }),
      /** Simpan draf / nama / slug / deskripsi (tanpa konfirmasi). */
      update: (templateId: string, body: UpdateEmailTemplateRequest) =>
        client.request(template(templateId), {
          method: 'PATCH',
          body,
          schema: emailTemplateResponseSchema,
        }),
      /** Draf → versi terbit baru. Wajib konfirmasi identitas. */
      publish: (templateId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(routes.publish, { templateId }), {
          method: 'POST',
          body: { confirmation },
          schema: emailTemplateResponseSchema,
        }),
      setArchived: (templateId: string, archived: boolean) =>
        client.request(apiPath(archived ? routes.archive : routes.unarchive, { templateId }), {
          method: 'POST',
          schema: emailTemplateResponseSchema,
        }),
      versions: (templateId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.versions, { templateId }), {
          schema: emailTemplateVersionsResponseSchema,
          signal,
        }),
      version: (templateId: string, version: number, signal?: AbortSignal) =>
        client.request(apiPath(routes.version, { templateId, versionId: String(version) }), {
          schema: emailTemplateVersionResponseSchema,
          signal,
        }),
      /** Salin versi lama ke draf (belum terbit). */
      restore: (templateId: string, version: number) =>
        client.request(apiPath(routes.restore, { templateId, versionId: String(version) }), {
          method: 'POST',
          schema: emailTemplateResponseSchema,
        }),
      /** Dokumen lengkap untuk `<iframe sandbox="" srcdoc>` (tanpa menyimpan). */
      preview: (body: EmailMessageTemplatePreviewRequest, signal?: AbortSignal) =>
        client.request(routes.preview, {
          method: 'POST',
          body,
          schema: emailMessageTemplatePreviewResponseSchema,
          signal,
        }),
      /** Kirim tes ke alamat akun sendiri (10 kali / 10 menit). */
      test: (
        templateId: string,
        body: { senderId: string; which: 'draft' | 'published'; values?: Record<string, string> },
      ) =>
        client.request(apiPath(routes.test, { templateId }), {
          method: 'POST',
          body,
          schema: emailTemplateTestResponseSchema,
        }),
      presets: (signal?: AbortSignal) =>
        client.request(routes.presets, { schema: emailTemplatePresetsResponseSchema, signal }),
      fromPreset: (presetKey: EmailTemplatePresetKey, body: { name?: string; slug?: string }) =>
        client.request(apiPath(routes.fromPreset, { presetId: presetKey }), {
          method: 'POST',
          body,
          schema: emailTemplateResponseSchema,
        }),
    },
    /** Pengaturan → Batas kirim → "Email per pengirim" (`sending.limits.manage`). */
    emailSenders: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.emailSenders.list, {
          schema: emailSenderSettingsListResponseSchema,
          signal,
        }),
      /** Menaikkan batas wajib konfirmasi identitas; menurunkan tidak. */
      updateLimit: (senderId: string, body: UpdateEmailSenderLimitRequest) =>
        client.request(apiPath(API_ROUTES.emailSenders.sender, { senderId }), {
          method: 'PUT',
          body,
          schema: emailSenderSettingsResponseSchema,
        }),
      /** Jeda (arah aman, tanpa konfirmasi). */
      pause: (senderId: string, reason?: string) =>
        client.request(apiPath(API_ROUTES.emailSenders.pause, { senderId }), {
          method: 'POST',
          body: reason ? { reason } : {},
          schema: emailSenderSettingsResponseSchema,
        }),
      /** Lanjutkan (juga melepas `blocked`/`throttled`). Wajib konfirmasi identitas. */
      resume: (senderId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.emailSenders.resume, { senderId }), {
          method: 'POST',
          body: { confirmation },
          schema: emailSenderSettingsResponseSchema,
        }),
    },
    /** Pengaturan → API key → Email terkirim (`api_keys.manage`; penerima tersamar). */
    emailOutbound: {
      list: (query: EmailOutboundListQuery, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.emailOutbound.list}${queryString({ ...query })}`, {
          schema: emailOutboundListResponseSchema,
          signal,
        }),
    },
  };
}
