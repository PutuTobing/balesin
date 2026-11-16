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
  contactResponseSchema,
  conversationCountsResponseSchema,
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
} from '@balesin/shared';
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
      messages: (conversationId: string, cursor: string | null, signal?: AbortSignal) =>
        client.request(
          `${apiPath(API_ROUTES.inbox.messages, { conversationId })}${
            cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
          }`,
          { schema: messageListResponseSchema, signal },
        ),
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
      /** Ringkasan channel untuk saringan (nama saja, semua peran ber-`inbox.view`). */
      channels: (signal?: AbortSignal) =>
        client.request(API_ROUTES.channels.list, {
          schema: channelSummaryListResponseSchema,
          signal,
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
