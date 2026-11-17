import {
  API_ROUTES,
  acceptInvitationResponseSchema,
  activeSessionListResponseSchema,
  apiPath,
  auditLogListResponseSchema,
  brandingResponseSchema,
  businessProfileResponseSchema,
  channelResponseSchema,
  channelSettingsListResponseSchema,
  channelTestResultSchema,
  channelSummaryListResponseSchema,
  channelWebhookResponseSchema,
  webhookHealthResponseSchema,
  contactResponseSchema,
  conversationActionResponseSchema,
  conversationEventListResponseSchema,
  contactExportSchema,
  deleteContactResponseSchema,
  conversationNoteListResponseSchema,
  conversationNoteResponseSchema,
  tagListResponseSchema,
  tagResponseSchema,
  type CreateTagRequest,
  type MessageListFilter,
  type PauseSendingRequest,
  type UpdateContactRequest,
  type UpdateSendingLimitsRequest,
  quickReplyListResponseSchema,
  quickReplyResponseSchema,
  useQuickReplyResponseSchema,
  type CreateQuickReplyRequest,
  type UpdateQuickReplyRequest,
  conversationCountsResponseSchema,
  inboxAgentListResponseSchema,
  messageResponseSchema,
  sendingLimitsResponseSchema,
  sendingStatusResponseSchema,
  uploadMediaResponseSchema,
  type SendMessageRequest,
  conversationListResponseSchema,
  conversationResponseSchema,
  messageListResponseSchema,
  createChannelResponseSchema,
  deleteChannelResponseSchema,
  updateBusinessProfileResponseSchema,
  completePasswordResetResponseSchema,
  completeSetupResponseSchema,
  confirmTwoFactorEnrollmentResponseSchema,
  detectEmailHostResponseSchema,
  disableTwoFactorResponseSchema,
  emailSettingsResponseSchema,
  emailTemplatePreviewResponseSchema,
  emailTestResultSchema,
  emailVerificationStatusResponseSchema,
  inspectInvitationResponseSchema,
  inspectPasswordResetResponseSchema,
  invitationIssuedResponseSchema,
  invitationListResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  passwordCheckResponseSchema,
  passwordResetStatusResponseSchema,
  regenerateBackupCodesResponseSchema,
  requestPasswordResetResponseSchema,
  revokeInvitationResponseSchema,
  revokeSessionResponseSchema,
  revokeSessionsResponseSchema,
  securitySummaryResponseSchema,
  sendEmailVerificationResponseSchema,
  setupStatusResponseSchema,
  startTwoFactorEnrollmentResponseSchema,
  teamUserActionResponseSchema,
  teamUserListResponseSchema,
  teamUserResponseSchema,
  twoFactorStatusResponseSchema,
  verifyEmailResponseSchema,
  verifySetupTokenResponseSchema,
  verifyTwoFactorResponseSchema,
  vapidPublicKeyResponseSchema,
  channelBotSettingsResponseSchema,
  type ChannelBotSettings,
  apiKeyListResponseSchema,
  apiKeyResponseSchema,
  createApiKeyResponseSchema,
  apiSettingsResponseSchema,
  outgoingWebhookListResponseSchema,
  outgoingWebhookResponseSchema,
  outgoingWebhookSecretResponseSchema,
  webhookDeliveryListResponseSchema,
  webhookDeliveryResponseSchema,
  privateNetworkResponseSchema,
  type CreateApiKeyRequest,
  type ApiSettings,
  type CreateOutgoingWebhookRequest,
  type UpdateOutgoingWebhookRequest,
  pushSubscriptionResponseSchema,
  pushSubscriptionDeletedResponseSchema,
  notificationPreferencesResponseSchema,
  notificationSettingsResponseSchema,
  notificationTestResponseSchema,
  type CreatePushSubscriptionRequest,
  type NotificationPreferences,
  type NotificationSettings,
  type AcceptInvitationRequest,
  type AuditLogFilter,
  type AuditLogListQuery,
  type IdentityConfirmation,
  type InvitableRole,
  type CheckSetupPasswordRequest,
  type CompletePasswordResetRequest,
  type CreateInvitationRequest,
  type CreateChannelRequest,
  type UpdateBusinessProfileRequest,
  type UpdateChannelRequest,
  type SaveEmailSettingsRequest,
  type CompleteSetupRequest,
  type EmailSettingsInput,
  type EmailTemplateId,
  type LoginRequest,
  type SetupDetectEmailHostRequest,
  type SetupSendTestEmailRequest,
  type SetupTestEmailConnectionRequest,
  type TwoFactorReauthRequest,
  type VerifyTwoFactorRequest,
  syncTemplatesResponseSchema,
  templateListResponseSchema,
  templatePresetListResponseSchema,
  templateResponseSchema,
  type CreateTemplateRequest,
  type TemplateCategory,
  type TemplateContent,
  type TemplateSendParametersInput,
  type TemplateStatus,
  broadcastConnectorListResponseSchema,
  broadcastConnectorOptionsResponseSchema,
  broadcastConnectorResponseSchema,
  broadcastConnectorTestResponseSchema,
  broadcastEstimateResponseSchema,
  broadcastImportResponseSchema,
  broadcastListResponseSchema,
  broadcastPreviewResponseSchema,
  broadcastRecipientListResponseSchema,
  broadcastReportResponseSchema,
  broadcastResponseSchema,
  broadcastSettingsResponseSchema,
  telegramAlarmSettingsResponseSchema,
  telegramTestResponseSchema,
  type BroadcastSegmentRequest,
  type BroadcastStatus,
  type CreateBroadcastConnectorRequest,
  type CreateBroadcastRequest,
  type UpdateBroadcastConnectorRequest,
  type UpdateBroadcastRequest,
  type UpdateBroadcastSettingsRequest,
  type UpdateTelegramAlarmRequest,
} from '@balesin/shared';
import { z } from 'zod';
import { api, type ApiClient } from './client';

/** Saringan & kursor daftar percakapan → query string (lihat `features/inbox/inbox-filters.ts`). */
export type QueryString = string;

/** Saringan audit log → query string (nilai kosong tidak dikirim). */
export function auditQueryString(query: AuditLogListQuery | AuditLogFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Semua endpoint yang dipakai web, satu fungsi per endpoint. Skema respons diambil dari
 * `@balesin/shared` (tidak ada tipe yang disalin).
 */
export function createEndpoints(client: ApiClient) {
  return {
    setup: {
      status: (signal?: AbortSignal) =>
        client.request(API_ROUTES.setup.status, { schema: setupStatusResponseSchema, signal }),
      verifyToken: (setupToken: string) =>
        client.request(API_ROUTES.setup.verifyToken, {
          method: 'POST',
          body: { setupToken },
          schema: verifySetupTokenResponseSchema,
        }),
      checkPassword: (body: CheckSetupPasswordRequest, signal?: AbortSignal) =>
        client.request(API_ROUTES.setup.checkPassword, {
          method: 'POST',
          body,
          schema: passwordCheckResponseSchema,
          signal,
        }),
      detectEmailHost: (body: SetupDetectEmailHostRequest, signal?: AbortSignal) =>
        client.request(API_ROUTES.setup.detectEmailHost, {
          method: 'POST',
          body,
          schema: detectEmailHostResponseSchema,
          signal,
        }),
      testEmailConnection: (body: SetupTestEmailConnectionRequest) =>
        client.request(API_ROUTES.setup.testEmailConnection, {
          method: 'POST',
          body,
          schema: emailTestResultSchema,
        }),
      sendTestEmail: (body: SetupSendTestEmailRequest) =>
        client.request(API_ROUTES.setup.sendTestEmail, {
          method: 'POST',
          body,
          schema: emailTestResultSchema,
        }),
      complete: (body: CompleteSetupRequest) =>
        client.request(API_ROUTES.setup.complete, {
          method: 'POST',
          body,
          schema: completeSetupResponseSchema,
        }),
    },
    auth: {
      login: (body: LoginRequest) =>
        client.request(API_ROUTES.auth.login, {
          method: 'POST',
          body,
          schema: loginResponseSchema,
        }),
      logout: () =>
        client.request(API_ROUTES.auth.logout, { method: 'POST', schema: logoutResponseSchema }),
      me: (signal?: AbortSignal) =>
        client.request(API_ROUTES.auth.me, { schema: meResponseSchema, signal }),
    },
    /** Verifikasi dua langkah (docs/KONTRAK-API-AUTH.md bagian 2FA). */
    twoFactor: {
      status: (signal?: AbortSignal) =>
        client.request(API_ROUTES.twoFactor.status, {
          schema: twoFactorStatusResponseSchema,
          signal,
        }),
      /** Langkah kedua saat masuk (publik, tanpa CSRF). */
      verify: (body: VerifyTwoFactorRequest) =>
        client.request(API_ROUTES.twoFactor.verify, {
          method: 'POST',
          body,
          schema: verifyTwoFactorResponseSchema,
        }),
      /** Sesi terbatas: tanpa password. Sesi penuh: password wajib. */
      enroll: (password?: string) =>
        client.request(API_ROUTES.twoFactor.enroll, {
          method: 'POST',
          body: password === undefined ? {} : { password },
          schema: startTwoFactorEnrollmentResponseSchema,
        }),
      confirmEnrollment: (code: string) =>
        client.request(API_ROUTES.twoFactor.confirmEnrollment, {
          method: 'POST',
          body: { code },
          schema: confirmTwoFactorEnrollmentResponseSchema,
        }),
      regenerateBackupCodes: (body: TwoFactorReauthRequest) =>
        client.request(API_ROUTES.twoFactor.regenerateBackupCodes, {
          method: 'POST',
          body,
          schema: regenerateBackupCodesResponseSchema,
        }),
      disable: (body: TwoFactorReauthRequest) =>
        client.request(API_ROUTES.twoFactor.disable, {
          method: 'POST',
          body,
          schema: disableTwoFactorResponseSchema,
        }),
    },
    /**
     * Undangan (docs/KONTRAK-API-AUTH.md bagian "Undangan"). Respons buat/kirim ulang bisa memuat
     * tautan undangan (`link`) yang setara kunci akses: pemanggil TIDAK boleh menyimpannya di cache
     * Query/mutasi atau storage (lihat `features/team`).
     */
    invitations: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.invitations.collection, {
          schema: invitationListResponseSchema,
          signal,
        }),
      create: (body: CreateInvitationRequest) =>
        client.request(API_ROUTES.invitations.collection, {
          method: 'POST',
          body,
          schema: invitationIssuedResponseSchema,
        }),
      /** Konfirmasi identitas pelaku wajib (semua peran, Owner juga — review akhir Fase 1 T1). */
      resend: (invitationId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.invitations.resend, { invitationId }), {
          method: 'POST',
          body: { confirmation },
          schema: invitationIssuedResponseSchema,
        }),
      revoke: (invitationId: string) =>
        client.request(apiPath(API_ROUTES.invitations.revoke, { invitationId }), {
          method: 'DELETE',
          schema: revokeInvitationResponseSchema,
        }),
      /** Publik: token dari fragment tautan, dikirim di body. */
      inspect: (token: string, signal?: AbortSignal) =>
        client.request(API_ROUTES.invitations.inspect, {
          method: 'POST',
          body: { token },
          schema: inspectInvitationResponseSchema,
          signal,
        }),
      accept: (body: AcceptInvitationRequest) =>
        client.request(API_ROUTES.invitations.accept, {
          method: 'POST',
          body,
          schema: acceptInvitationResponseSchema,
        }),
    },
    /** Atur ulang password (semua publik). */
    passwordReset: {
      status: (signal?: AbortSignal) =>
        client.request(API_ROUTES.passwordReset.status, {
          schema: passwordResetStatusResponseSchema,
          signal,
        }),
      request: (email: string) =>
        client.request(API_ROUTES.passwordReset.request, {
          method: 'POST',
          body: { email },
          schema: requestPasswordResetResponseSchema,
        }),
      inspect: (token: string, signal?: AbortSignal) =>
        client.request(API_ROUTES.passwordReset.inspect, {
          method: 'POST',
          body: { token },
          schema: inspectPasswordResetResponseSchema,
          signal,
        }),
      complete: (body: CompletePasswordResetRequest) =>
        client.request(API_ROUTES.passwordReset.complete, {
          method: 'POST',
          body,
          schema: completePasswordResetResponseSchema,
        }),
    },
    /** Verifikasi email akun sendiri. */
    emailVerification: {
      status: (signal?: AbortSignal) =>
        client.request(API_ROUTES.emailVerification.status, {
          schema: emailVerificationStatusResponseSchema,
          signal,
        }),
      send: () =>
        client.request(API_ROUTES.emailVerification.status, {
          method: 'POST',
          body: {},
          schema: sendEmailVerificationResponseSchema,
        }),
      /** Publik: token dari fragment tautan. */
      verify: (token: string) =>
        client.request(API_ROUTES.emailVerification.verify, {
          method: 'POST',
          body: { token },
          schema: verifyEmailResponseSchema,
        }),
    },
    /**
     * Manajemen pengguna (izin `team.manage`). Aksi kelola wajib konfirmasi ulang identitas
     * pelaku (password + kode 2FA): isian itu tidak boleh disimpan di cache Query/mutasi atau
     * storage, jadi pemanggil memanggil fungsi ini langsung (bukan lewat `useMutation`).
     */
    team: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.team.users, { schema: teamUserListResponseSchema, signal }),
      get: (userId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.team.user, { userId }), {
          schema: teamUserResponseSchema,
          signal,
        }),
      changeRole: (userId: string, role: InvitableRole, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.role, { userId }), {
          method: 'PUT',
          body: { ...identity, role },
          schema: teamUserActionResponseSchema,
        }),
      disable: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.disable, { userId }), {
          method: 'POST',
          body: identity,
          schema: teamUserActionResponseSchema,
        }),
      enable: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.enable, { userId }), {
          method: 'POST',
          body: identity,
          schema: teamUserActionResponseSchema,
        }),
      resetTwoFactor: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.resetTwoFactor, { userId }), {
          method: 'POST',
          body: identity,
          schema: teamUserActionResponseSchema,
        }),
      reopenTwoFactorEnrollment: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.reopenTwoFactorEnrollment, { userId }), {
          method: 'POST',
          body: identity,
          schema: teamUserActionResponseSchema,
        }),
      unlock: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.unlock, { userId }), {
          method: 'POST',
          body: identity,
          schema: teamUserActionResponseSchema,
        }),
      sessions: (userId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.team.sessions, { userId }), {
          schema: activeSessionListResponseSchema,
          signal,
        }),
      revokeSession: (userId: string, sessionId: string) =>
        client.request(apiPath(API_ROUTES.team.revokeSession, { userId, sessionId }), {
          method: 'DELETE',
          schema: revokeSessionResponseSchema,
        }),
      revokeAllSessions: (userId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.team.revokeAllSessions, { userId }), {
          method: 'POST',
          body: identity,
          schema: revokeSessionsResponseSchema,
        }),
    },
    /** Sesi aktif milik sendiri (cukup sesi penuh). */
    sessions: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.sessions.list, {
          schema: activeSessionListResponseSchema,
          signal,
        }),
      /**
       * Sesi yang lebih baru dari sesi ini (`confirmationRequired`) wajib konfirmasi identitas di
       * body; sesi yang lebih lama cukup tanpa body.
       */
      revoke: (sessionId: string, identity?: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.sessions.revoke, { sessionId }), {
          method: 'DELETE',
          body: identity,
          schema: revokeSessionResponseSchema,
        }),
      revokeOthers: (identity: IdentityConfirmation) =>
        client.request(API_ROUTES.sessions.revokeOthers, {
          method: 'POST',
          body: identity,
          schema: revokeSessionsResponseSchema,
        }),
    },
    /** Audit log (izin `audit.view`). */
    audit: {
      list: (query: AuditLogListQuery, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.audit.list}${auditQueryString(query)}`, {
          schema: auditLogListResponseSchema,
          signal,
        }),
      /** CSV lewat `fetch` (cookie sesi), bukan membuka URL di tab baru. */
      exportCsv: (filter: AuditLogFilter, signal?: AbortSignal) =>
        client.download(`${API_ROUTES.audit.export}${auditQueryString(filter)}`, { signal }),
      securitySummary: (signal?: AbortSignal) =>
        client.request(API_ROUTES.audit.securitySummary, {
          schema: securitySummaryResponseSchema,
          signal,
        }),
    },
    branding: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.branding.get, { schema: brandingResponseSchema, signal }),
    },
    /**
     * Pengaturan → Channel (izin `channels.manage`, docs/KONTRAK-API-CHANNEL.md). Token System
     * User dan App Secret hanya pernah dikirim KE server; jawaban hanya memuat petunjuk tersamar.
     */
    channels: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.channels.settings, {
          schema: channelSettingsListResponseSchema,
          signal,
        }),
      /** `confirmation` wajib untuk semua peran (Owner juga). */
      create: (body: CreateChannelRequest) =>
        client.request(API_ROUTES.channels.settings, {
          method: 'POST',
          body,
          schema: createChannelResponseSchema,
        }),
      get: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.channel, { channelId }), {
          schema: channelResponseSchema,
          signal,
        }),
      /** Hanya isian yang berubah; kredensial/ID Meta wajib `confirmation`. */
      update: (channelId: string, body: UpdateChannelRequest) =>
        client.request(apiPath(API_ROUTES.channels.channel, { channelId }), {
          method: 'PATCH',
          body,
          schema: channelResponseSchema,
        }),
      remove: (channelId: string, identity: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.channels.channel, { channelId }), {
          method: 'DELETE',
          body: identity,
          schema: deleteChannelResponseSchema,
        }),
      setEnabled: (channelId: string, enabled: boolean) =>
        client.request(
          apiPath(enabled ? API_ROUTES.channels.enable : API_ROUTES.channels.disable, {
            channelId,
          }),
          { method: 'POST', schema: channelResponseSchema },
        ),
      /** Memakai kredensial tersimpan; hasil gagal tetap 200 dengan `ok: false`. */
      test: (channelId: string) =>
        client.request(apiPath(API_ROUTES.channels.test, { channelId }), {
          method: 'POST',
          schema: channelTestResultSchema,
        }),
      webhook: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.webhook, { channelId }), {
          schema: channelWebhookResponseSchema,
          signal,
        }),
      /** Diagnosis webhook 24 jam: hanya hitungan & waktu, tanpa payload (`channels.manage`). */
      webhookHealth: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.webhookHealth, { channelId }), {
          schema: webhookHealthResponseSchema,
          signal,
        }),
      rotateVerifyToken: (channelId: string) =>
        client.request(apiPath(API_ROUTES.channels.rotateVerifyToken, { channelId }), {
          method: 'POST',
          schema: channelWebhookResponseSchema,
        }),
      /** GET ber-CSRF: memanggil Meta dan memakai jatah batas laju. */
      businessProfile: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.businessProfile, { channelId }), {
          schema: businessProfileResponseSchema,
          signal,
          csrf: true,
        }),
      /** Saklar bot channel, jam kerja bot, batas waktu (`integrations.manage`, tanpa konfirmasi). */
      bot: (channelId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.channels.bot, { channelId }), {
          schema: channelBotSettingsResponseSchema,
          signal,
        }),
      updateBot: (channelId: string, body: ChannelBotSettings) =>
        client.request(apiPath(API_ROUTES.channels.bot, { channelId }), {
          method: 'PUT',
          body,
          schema: channelBotSettingsResponseSchema,
        }),
      updateBusinessProfile: (channelId: string, body: UpdateBusinessProfileRequest) =>
        client.request(apiPath(API_ROUTES.channels.businessProfile, { channelId }), {
          method: 'PUT',
          body,
          schema: updateBusinessProfileResponseSchema,
        }),
    },
    /**
     * Inbox (izin `inbox.view` / `contacts.view`, bercakupan — docs/KONTRAK-API-INBOX.md).
     * `query` = query string yang sudah disusun (`conversationQueryString`), diawali `?` atau kosong.
     */
    inbox: {
      conversations: (query: QueryString, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.inbox.conversations}${query}`, {
          schema: conversationListResponseSchema,
          signal,
        }),
      counts: (query: QueryString, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.inbox.counts}${query}`, {
          schema: conversationCountsResponseSchema,
          signal,
        }),
      conversation: (conversationId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.inbox.conversation, { conversationId }), {
          schema: conversationResponseSchema,
          signal,
        }),
      messages: (
        conversationId: string,
        cursor: string | null,
        signal?: AbortSignal,
        only?: MessageListFilter,
      ) => {
        const query = new URLSearchParams();
        if (cursor) query.set('cursor', cursor);
        if (only) query.set('only', only);
        const text = query.toString();
        return client.request(
          `${apiPath(API_ROUTES.inbox.messages, { conversationId })}${text ? `?${text}` : ''}`,
          { schema: messageListResponseSchema, signal },
        );
      },
      /** Ubah kontak (`contacts.manage`): nama tim, email, catatan, atribut. */
      updateContact: (contactId: string, body: UpdateContactRequest) =>
        client.request(apiPath(API_ROUTES.inbox.contact, { contactId }), {
          method: 'PATCH',
          body,
          schema: contactResponseSchema,
        }),
      /** Hapus kontak + data pribadinya (`contacts.delete`, wajib konfirmasi identitas). */
      deleteContact: (contactId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.inbox.contact, { contactId }), {
          method: 'DELETE',
          body: { confirmation },
          schema: deleteContactResponseSchema,
        }),
      /** Data pribadi satu kontak (JSON, `contacts.export`) untuk permintaan akses data. */
      exportContact: (contactId: string) =>
        client.request(apiPath(API_ROUTES.inbox.contactExport, { contactId }), {
          schema: contactExportSchema,
          csrf: true,
        }),
      addTag: (contactId: string, tagId: string) =>
        client.request(apiPath(API_ROUTES.inbox.contactTags, { contactId }), {
          method: 'POST',
          body: { tagId },
          schema: contactResponseSchema,
        }),
      removeTag: (contactId: string, tagId: string) =>
        client.request(apiPath(API_ROUTES.inbox.contactTag, { contactId, tagId }), {
          method: 'DELETE',
          schema: contactResponseSchema,
        }),
      notes: (conversationId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.inbox.notes, { conversationId }), {
          schema: conversationNoteListResponseSchema,
          signal,
        }),
      addNote: (conversationId: string, body: string) =>
        client.request(apiPath(API_ROUTES.inbox.notes, { conversationId }), {
          method: 'POST',
          body: { body },
          schema: conversationNoteResponseSchema,
        }),
      updateNote: (conversationId: string, noteId: string, body: string) =>
        client.request(apiPath(API_ROUTES.inbox.note, { conversationId, noteId }), {
          method: 'PATCH',
          body: { body },
          schema: conversationNoteResponseSchema,
        }),
      deleteNote: (conversationId: string, noteId: string) =>
        client.request(apiPath(API_ROUTES.inbox.note, { conversationId, noteId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
      /** Tandai / lepas tanda pesan (bintang, satu tanda bersama). */
      star: (messageId: string, starred: boolean) =>
        client.request(apiPath(API_ROUTES.inbox.star, { messageId }), {
          method: starred ? 'PUT' : 'DELETE',
          schema: messageResponseSchema,
        }),
      /** Riwayat penanganan + kejadian kontak (tab "Log"). */
      events: (conversationId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.inbox.events, { conversationId }), {
          schema: conversationEventListResponseSchema,
          signal,
        }),
      /** Tandai sudah dibaca (POST ber-CSRF, idempoten). */
      markRead: (conversationId: string) =>
        client.request(apiPath(API_ROUTES.inbox.read, { conversationId }), {
          method: 'POST',
          schema: conversationResponseSchema,
        }),
      contact: (contactId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.inbox.contact, { contactId }), {
          schema: contactResponseSchema,
          signal,
        }),
      /** Kirim pesan (CSRF). 202 `pending` atau 200 bila `clientMessageId` sama sudah pernah dikirim. */
      send: (conversationId: string, body: SendMessageRequest) =>
        client.request(apiPath(API_ROUTES.inbox.messages, { conversationId }), {
          method: 'POST',
          body,
          schema: messageResponseSchema,
        }),
      /** Unggah satu berkas (multipart `file`, CSRF) → `mediaId` untuk dikirim. */
      upload: (conversationId: string, file: File, signal?: AbortSignal) => {
        const form = new FormData();
        form.append('file', file, file.name);
        return client.request(apiPath(API_ROUTES.inbox.upload, { conversationId }), {
          method: 'POST',
          body: form,
          schema: uploadMediaResponseSchema,
          signal,
        });
      },
      /** Kirim ulang pesan keluar yang gagal (`failure.retryable`). */
      retry: (messageId: string) =>
        client.request(apiPath(API_ROUTES.inbox.retry, { messageId }), {
          method: 'POST',
          schema: messageResponseSchema,
        }),
      /** Berkas media pesan (GET ber-CSRF) → Blob; tidak pernah `<img src>` langsung ke API. */
      media: (messageId: string, signal?: AbortSignal) =>
        client.download(apiPath(API_ROUTES.inbox.media, { messageId }), {
          signal,
          accept: '*/*',
        }),
      /** Rem darurat ditarik atau tidak (semua peran ber-`inbox.view`, tanpa rincian). */
      sendingStatus: (signal?: AbortSignal) =>
        client.request(API_ROUTES.inbox.sendingStatus, {
          schema: sendingStatusResponseSchema,
          signal,
        }),
      /** Agen inbox (saringan agen, alihkan). */
      agents: (signal?: AbortSignal) =>
        client.request(API_ROUTES.inbox.agents, { schema: inboxAgentListResponseSchema, signal }),
      /** Tugaskan/alihkan ke agen (`inbox.assign`). */
      assign: (conversationId: string, userId: string) =>
        client.request(apiPath(API_ROUTES.inbox.assign, { conversationId }), {
          method: 'POST',
          body: { userId },
          schema: conversationActionResponseSchema,
        }),
      /** Kembalikan ke antrian (Teknisi: hanya chat miliknya). */
      unassign: (conversationId: string) =>
        client.request(apiPath(API_ROUTES.inbox.unassign, { conversationId }), {
          method: 'POST',
          schema: conversationActionResponseSchema,
        }),
      resolve: (conversationId: string) =>
        client.request(apiPath(API_ROUTES.inbox.resolve, { conversationId }), {
          method: 'POST',
          schema: conversationActionResponseSchema,
        }),
      reopen: (conversationId: string) =>
        client.request(apiPath(API_ROUTES.inbox.reopen, { conversationId }), {
          method: 'POST',
          schema: conversationActionResponseSchema,
        }),
      /**
       * Mulai percakapan ke nomor (bisa baru) dengan template DISETUJUI (`inbox.initiate`). 202 baru,
       * 200 bila `clientMessageId` sama sudah pernah dikirim (percakapan sama).
       */
      start: (body: {
        channelId: string;
        phone: string;
        clientMessageId: string;
        templateId: string;
        parameters: TemplateSendParametersInput;
      }) =>
        client.request(API_ROUTES.inbox.start, {
          method: 'POST',
          body,
          schema: messageResponseSchema.extend({ conversationId: z.uuid() }),
        }),
      /** Saklar bot per percakapan: `false` = serahkan ke tim, `true` = kembalikan ke bot. */
      bot: (conversationId: string, active: boolean) =>
        client.request(apiPath(API_ROUTES.inbox.bot, { conversationId }), {
          method: 'POST',
          body: { active },
          schema: conversationActionResponseSchema,
        }),
      /** Ambil chat dari antrian / ambil alih dari bot (`inbox.assign`). */
      claim: (conversationId: string) =>
        client.request(apiPath(API_ROUTES.inbox.claim, { conversationId }), {
          method: 'POST',
          schema: conversationActionResponseSchema,
        }),
      /** Ringkasan channel untuk saringan (nama saja, semua peran ber-`inbox.view`). */
      channels: (signal?: AbortSignal) =>
        client.request(API_ROUTES.channels.list, {
          schema: channelSummaryListResponseSchema,
          signal,
        }),
    },
    /**
     * Balasan cepat / quick reply `/`: daftar & pakai (`inbox.reply`), kelola
     * (`quick_replies.manage`).
     */
    quickReplies: {
      list: (q: string | null, signal?: AbortSignal) =>
        client.request(`${API_ROUTES.quickReplies.list}${q ? `?q=${encodeURIComponent(q)}` : ''}`, {
          schema: quickReplyListResponseSchema,
          signal,
        }),
      /** Isi variabel untuk percakapan ini (+ penghitung pemakaian) → teks siap di composer. */
      use: (quickReplyId: string, conversationId: string) =>
        client.request(apiPath(API_ROUTES.quickReplies.use, { quickReplyId }), {
          method: 'POST',
          body: { conversationId },
          schema: useQuickReplyResponseSchema,
        }),
      create: (body: CreateQuickReplyRequest) =>
        client.request(API_ROUTES.quickReplies.list, {
          method: 'POST',
          body,
          schema: quickReplyResponseSchema,
        }),
      update: (quickReplyId: string, body: UpdateQuickReplyRequest) =>
        client.request(apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId }), {
          method: 'PATCH',
          body,
          schema: quickReplyResponseSchema,
        }),
      remove: (quickReplyId: string) =>
        client.request(apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
    },
    /**
     * Template pesan Meta (docs/KONTRAK-API-TEMPLATE.md). Daftar/detail = `inbox.reply`; kelola
     * (buat, ubah, ajukan, hapus, sinkron, preset) = `templates.manage`.
     */
    templates: {
      list: (
        filter: {
          channelId?: string;
          status?: TemplateStatus;
          category?: TemplateCategory;
        } = {},
        signal?: AbortSignal,
      ) => {
        const query = new URLSearchParams();
        if (filter.channelId) query.set('channelId', filter.channelId);
        if (filter.status) query.set('status', filter.status);
        if (filter.category) query.set('category', filter.category);
        const text = query.toString();
        return client.request(`${API_ROUTES.templates.list}${text ? `?${text}` : ''}`, {
          schema: templateListResponseSchema,
          signal,
        });
      },
      get: (templateId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.templates.template, { templateId }), {
          schema: templateResponseSchema,
          signal,
        }),
      create: (body: CreateTemplateRequest) =>
        client.request(API_ROUTES.templates.list, {
          method: 'POST',
          body,
          schema: templateResponseSchema,
        }),
      update: (
        templateId: string,
        body: {
          name?: string;
          language?: string;
          category?: TemplateCategory;
          content?: TemplateContent;
        },
      ) =>
        client.request(apiPath(API_ROUTES.templates.template, { templateId }), {
          method: 'PATCH',
          body,
          schema: templateResponseSchema,
        }),
      /** Ajukan ke Meta (baru) atau ajukan perubahan (sudah di Meta). */
      submit: (templateId: string) =>
        client.request(apiPath(API_ROUTES.templates.submit, { templateId }), {
          method: 'POST',
          schema: templateResponseSchema,
        }),
      remove: (templateId: string) =>
        client.request(apiPath(API_ROUTES.templates.template, { templateId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
      /** Sinkron dari Meta; tanpa `channelId` = semua nomor WhatsApp aktif. */
      sync: (channelId?: string) =>
        client.request(API_ROUTES.templates.sync, {
          method: 'POST',
          body: channelId ? { channelId } : {},
          schema: syncTemplatesResponseSchema,
        }),
      presets: (signal?: AbortSignal) =>
        client.request(API_ROUTES.templates.presets, {
          schema: templatePresetListResponseSchema,
          signal,
        }),
      /** Draf dari preset industri (`source: preset`), bisa diubah sebelum diajukan. */
      fromPreset: (presetId: string, body: { channelId: string; name?: string }) =>
        client.request(apiPath(API_ROUTES.templates.fromPreset, { presetId }), {
          method: 'POST',
          body,
          schema: templateResponseSchema,
        }),
    },
    /** Broadcast / kampanye template (docs/KONTRAK-API-BROADCAST.md, `broadcast.send`). */
    broadcasts: {
      list: (status: BroadcastStatus | null, cursor: string | null, signal?: AbortSignal) => {
        const query = new URLSearchParams();
        if (status) query.set('status', status);
        if (cursor) query.set('cursor', cursor);
        const text = query.toString();
        return client.request(`${API_ROUTES.broadcasts.list}${text ? `?${text}` : ''}`, {
          schema: broadcastListResponseSchema,
          signal,
        });
      },
      get: (broadcastId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId }), {
          schema: broadcastResponseSchema,
          signal,
        }),
      create: (body: CreateBroadcastRequest) =>
        client.request(API_ROUTES.broadcasts.list, {
          method: 'POST',
          body,
          schema: broadcastResponseSchema,
        }),
      update: (broadcastId: string, body: UpdateBroadcastRequest) =>
        client.request(apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId }), {
          method: 'PATCH',
          body,
          schema: broadcastResponseSchema,
        }),
      remove: (broadcastId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
      /** Penerima dari CSV/XLSX (multipart `file`); `phoneColumn` = kolom nomor pilihan. */
      upload: (broadcastId: string, file: File, phoneColumn?: string) => {
        const form = new FormData();
        form.append('file', file, file.name);
        const query = phoneColumn ? `?phoneColumn=${encodeURIComponent(phoneColumn)}` : '';
        return client.request(`${apiPath(API_ROUTES.broadcasts.upload, { broadcastId })}${query}`, {
          method: 'POST',
          body: form,
          schema: broadcastImportResponseSchema,
        });
      },
      segment: (broadcastId: string, body: BroadcastSegmentRequest) =>
        client.request(apiPath(API_ROUTES.broadcasts.segment, { broadcastId }), {
          method: 'POST',
          body,
          schema: broadcastImportResponseSchema,
        }),
      fromConnector: (broadcastId: string, connectorId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.connector, { broadcastId }), {
          method: 'POST',
          body: { connectorId },
          schema: broadcastImportResponseSchema,
        }),
      recipients: (
        broadcastId: string,
        status: string | null,
        cursor: string | null,
        signal?: AbortSignal,
      ) => {
        const query = new URLSearchParams();
        if (status) query.set('status', status);
        if (cursor) query.set('cursor', cursor);
        const text = query.toString();
        return client.request(
          `${apiPath(API_ROUTES.broadcasts.recipients, { broadcastId })}${text ? `?${text}` : ''}`,
          { schema: broadcastRecipientListResponseSchema, signal },
        );
      },
      preview: (broadcastId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.broadcasts.preview, { broadcastId }), {
          schema: broadcastPreviewResponseSchema,
          signal,
        }),
      estimate: (broadcastId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.broadcasts.estimate, { broadcastId }), {
          schema: broadcastEstimateResponseSchema,
          signal,
        }),
      /** Ajukan (wajib konfirmasi identitas) → `scheduled` atau `pending_approval`. */
      submit: (broadcastId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.broadcasts.submit, { broadcastId }), {
          method: 'POST',
          body: { confirmation },
          schema: broadcastResponseSchema,
        }),
      approve: (broadcastId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.broadcasts.approve, { broadcastId }), {
          method: 'POST',
          body: { confirmation },
          schema: broadcastResponseSchema,
        }),
      reject: (broadcastId: string, reason: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.reject, { broadcastId }), {
          method: 'POST',
          body: { reason },
          schema: broadcastResponseSchema,
        }),
      /** Jeda seketika (arah aman, tanpa konfirmasi). */
      pause: (broadcastId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.pause, { broadcastId }), {
          method: 'POST',
          body: {},
          schema: broadcastResponseSchema,
        }),
      resume: (broadcastId: string, confirmation: IdentityConfirmation) =>
        client.request(apiPath(API_ROUTES.broadcasts.resume, { broadcastId }), {
          method: 'POST',
          body: { confirmation },
          schema: broadcastResponseSchema,
        }),
      cancel: (broadcastId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.cancel, { broadcastId }), {
          method: 'POST',
          body: {},
          schema: broadcastResponseSchema,
        }),
      report: (broadcastId: string, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.broadcasts.report, { broadcastId }), {
          schema: broadcastReportResponseSchema,
          signal,
        }),
      /** CSV per penerima (`contacts.export`): GET ber-CSRF → Blob, tidak pernah lewat cache. */
      exportCsv: (broadcastId: string) =>
        client.download(apiPath(API_ROUTES.broadcasts.exportCsv, { broadcastId }), {
          accept: 'text/csv',
        }),
      connectorOptions: (signal?: AbortSignal) =>
        client.request(API_ROUTES.broadcasts.connectorOptions, {
          schema: broadcastConnectorOptionsResponseSchema,
          signal,
        }),
      settings: (signal?: AbortSignal) =>
        client.request(API_ROUTES.broadcasts.settings, {
          schema: broadcastSettingsResponseSchema,
          signal,
        }),
      updateSettings: (body: UpdateBroadcastSettingsRequest) =>
        client.request(API_ROUTES.broadcasts.settings, {
          method: 'PUT',
          body,
          schema: broadcastSettingsResponseSchema,
        }),
    },
    /** Konektor data REST untuk penerima broadcast (`integrations.manage`). */
    connectors: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.broadcasts.connectors, {
          schema: broadcastConnectorListResponseSchema,
          signal,
        }),
      create: (body: CreateBroadcastConnectorRequest) =>
        client.request(API_ROUTES.broadcasts.connectors, {
          method: 'POST',
          body,
          schema: broadcastConnectorResponseSchema,
        }),
      update: (connectorId: string, body: UpdateBroadcastConnectorRequest) =>
        client.request(apiPath(API_ROUTES.broadcasts.connectorItem, { connectorId }), {
          method: 'PATCH',
          body,
          schema: broadcastConnectorResponseSchema,
        }),
      remove: (connectorId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.connectorItem, { connectorId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
      test: (connectorId: string) =>
        client.request(apiPath(API_ROUTES.broadcasts.connectorTest, { connectorId }), {
          method: 'POST',
          body: {},
          schema: broadcastConnectorTestResponseSchema,
        }),
    },
    /** Alarm Telegram (`integrations.manage`); token tidak pernah dikirim balik. */
    alarms: {
      telegram: (signal?: AbortSignal) =>
        client.request(API_ROUTES.alarms.telegram, {
          schema: telegramAlarmSettingsResponseSchema,
          signal,
        }),
      updateTelegram: (body: UpdateTelegramAlarmRequest) =>
        client.request(API_ROUTES.alarms.telegram, {
          method: 'PUT',
          body,
          schema: telegramAlarmSettingsResponseSchema,
        }),
      removeTelegram: (confirmation: IdentityConfirmation) =>
        client.request(API_ROUTES.alarms.telegram, {
          method: 'DELETE',
          body: { confirmation },
          schema: telegramAlarmSettingsResponseSchema,
        }),
      testTelegram: () =>
        client.request(API_ROUTES.alarms.telegramTest, {
          method: 'POST',
          body: {},
          schema: telegramTestResponseSchema,
        }),
    },
    /** Master tag (lihat `inbox.view`; buat `contacts.manage`). */
    tags: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.tags.list, { schema: tagListResponseSchema, signal }),
      create: (body: CreateTagRequest) =>
        client.request(API_ROUTES.tags.list, {
          method: 'POST',
          body,
          schema: tagResponseSchema,
        }),
    },
    /** API key API publik (`api_keys.manage`; docs/KONTRAK-API-PUBLIK.md). */
    apiKeys: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.apiKeys.list, { schema: apiKeyListResponseSchema, signal }),
      /** Wajib konfirmasi identitas. Jawaban memuat `secret` — tampil SEKALI, jangan disimpan. */
      create: (body: CreateApiKeyRequest) =>
        client.request(API_ROUTES.apiKeys.list, {
          method: 'POST',
          body,
          schema: createApiKeyResponseSchema,
        }),
      revoke: (apiKeyId: string) =>
        client.request(apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId }), {
          method: 'POST',
          schema: apiKeyResponseSchema,
        }),
      settings: (signal?: AbortSignal) =>
        client.request(API_ROUTES.apiKeys.settings, { schema: apiSettingsResponseSchema, signal }),
      updateSettings: (body: ApiSettings) =>
        client.request(API_ROUTES.apiKeys.settings, {
          method: 'PUT',
          body,
          schema: apiSettingsResponseSchema,
        }),
    },
    /** Webhook keluar (`integrations.manage`; docs/KONTRAK-WEBHOOK-KELUAR.md). */
    webhooks: {
      list: (signal?: AbortSignal) =>
        client.request(API_ROUTES.outgoingWebhooks.list, {
          schema: outgoingWebhookListResponseSchema,
          signal,
        }),
      create: (body: CreateOutgoingWebhookRequest) =>
        client.request(API_ROUTES.outgoingWebhooks.list, {
          method: 'POST',
          body,
          schema: outgoingWebhookSecretResponseSchema,
        }),
      update: (webhookId: string, body: UpdateOutgoingWebhookRequest) =>
        client.request(apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId }), {
          method: 'PATCH',
          body,
          schema: outgoingWebhookResponseSchema,
        }),
      remove: (webhookId: string) =>
        client.request(apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId }), {
          method: 'DELETE',
          schema: z.object({ deleted: z.literal(true) }),
        }),
      rotateSecret: (
        webhookId: string,
        confirmation: IdentityConfirmation,
        revokePrevious = false,
      ) =>
        client.request(apiPath(API_ROUTES.outgoingWebhooks.rotateSecret, { webhookId }), {
          method: 'POST',
          body: { confirmation, ...(revokePrevious ? { revokePrevious: true } : {}) },
          schema: outgoingWebhookSecretResponseSchema,
        }),
      test: (webhookId: string) =>
        client.request(apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId }), {
          method: 'POST',
          schema: webhookDeliveryResponseSchema,
        }),
      deliveries: (webhookId: string, cursor: string | null, signal?: AbortSignal) =>
        client.request(
          `${apiPath(API_ROUTES.outgoingWebhooks.deliveries, { webhookId })}?limit=20${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          }`,
          { schema: webhookDeliveryListResponseSchema, signal },
        ),
      redeliver: (webhookId: string, deliveryId: string) =>
        client.request(apiPath(API_ROUTES.outgoingWebhooks.redeliver, { webhookId, deliveryId }), {
          method: 'POST',
          schema: webhookDeliveryResponseSchema,
        }),
      privateNetwork: (signal?: AbortSignal) =>
        client.request(API_ROUTES.outgoingWebhooks.privateNetwork, {
          schema: privateNetworkResponseSchema,
          signal,
        }),
      updatePrivateNetwork: (cidrs: string[], confirmation: IdentityConfirmation) =>
        client.request(API_ROUTES.outgoingWebhooks.privateNetwork, {
          method: 'PUT',
          body: { cidrs, confirmation },
          schema: privateNetworkResponseSchema,
        }),
    },
    /** Notifikasi Web Push (docs/KONTRAK-API-NOTIFIKASI.md). */
    notifications: {
      vapidPublicKey: () =>
        client.request(API_ROUTES.notifications.vapidPublicKey, {
          schema: vapidPublicKeyResponseSchema,
        }),
      subscribe: (body: CreatePushSubscriptionRequest) =>
        client.request(API_ROUTES.notifications.subscriptions, {
          method: 'POST',
          body,
          schema: pushSubscriptionResponseSchema,
        }),
      unsubscribe: (endpoint: string) =>
        client.request(API_ROUTES.notifications.subscriptions, {
          method: 'DELETE',
          body: { endpoint },
          schema: pushSubscriptionDeletedResponseSchema,
        }),
      preferences: (signal?: AbortSignal) =>
        client.request(API_ROUTES.notifications.preferences, {
          schema: notificationPreferencesResponseSchema,
          signal,
        }),
      updatePreferences: (body: NotificationPreferences) =>
        client.request(API_ROUTES.notifications.preferences, {
          method: 'PUT',
          body,
          schema: notificationPreferencesResponseSchema,
        }),
      test: () =>
        client.request(API_ROUTES.notifications.test, {
          method: 'POST',
          schema: notificationTestResponseSchema,
        }),
      settings: (signal?: AbortSignal) =>
        client.request(API_ROUTES.notifications.settings, {
          schema: notificationSettingsResponseSchema,
          signal,
        }),
      updateSettings: (body: NotificationSettings) =>
        client.request(API_ROUTES.notifications.settings, {
          method: 'PUT',
          body,
          schema: notificationSettingsResponseSchema,
        }),
    },
    /** Batas kirim & rem darurat (izin `sending.limits.manage`; lanjutkan = `sending.resume`). */
    sendingLimits: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.sendingLimits.settings, {
          schema: sendingLimitsResponseSchema,
          signal,
        }),
      /** Wajib konfirmasi identitas. */
      update: (body: UpdateSendingLimitsRequest) =>
        client.request(API_ROUTES.sendingLimits.settings, {
          method: 'PUT',
          body,
          schema: sendingLimitsResponseSchema,
        }),
      /** Tarik rem darurat (tanpa konfirmasi identitas — arah aman, harus cepat). */
      pause: (body: PauseSendingRequest) =>
        client.request(API_ROUTES.sendingLimits.pause, {
          method: 'POST',
          body,
          schema: sendingLimitsResponseSchema,
        }),
      resume: (confirmation: IdentityConfirmation) =>
        client.request(API_ROUTES.sendingLimits.resume, {
          method: 'POST',
          body: { confirmation },
          schema: sendingLimitsResponseSchema,
        }),
    },
    emailSettings: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.settings.email, { schema: emailSettingsResponseSchema, signal }),
      /**
       * `confirmation` wajib bila jalur kirim berubah atau simpan pertama kali (semua peran, Owner
       * juga — review akhir Fase 1 T2); cukup tanpa bila hanya nama pengirim yang berubah.
       */
      save: (body: SaveEmailSettingsRequest) =>
        client.request(API_ROUTES.settings.email, {
          method: 'PUT',
          body,
          schema: emailSettingsResponseSchema,
        }),
      detectHost: (emailAddress: string, signal?: AbortSignal) =>
        client.request(API_ROUTES.settings.detectEmailHost, {
          method: 'POST',
          body: { emailAddress },
          schema: detectEmailHostResponseSchema,
          signal,
        }),
      testConnection: (settings?: EmailSettingsInput) =>
        client.request(API_ROUTES.settings.testEmailConnection, {
          method: 'POST',
          body: settings ? { settings } : {},
          schema: emailTestResultSchema,
        }),
      sendTest: (to: string, settings?: EmailSettingsInput) =>
        client.request(API_ROUTES.settings.sendTestEmail, {
          method: 'POST',
          body: settings ? { to, settings } : { to },
          schema: emailTestResultSchema,
        }),
      /** Pratinjau template email (data contoh, tanpa token sungguhan). */
      templatePreview: (template: EmailTemplateId, signal?: AbortSignal) =>
        client.request(apiPath(API_ROUTES.settings.emailTemplatePreview, { template }), {
          schema: emailTemplatePreviewResponseSchema,
          signal,
        }),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;

export const endpoints = createEndpoints(api);
