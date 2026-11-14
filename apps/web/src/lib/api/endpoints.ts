import {
  API_ROUTES,
  acceptInvitationResponseSchema,
  activeSessionListResponseSchema,
  apiPath,
  auditLogListResponseSchema,
  brandingResponseSchema,
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
      resend: (invitationId: string) =>
        client.request(apiPath(API_ROUTES.invitations.resend, { invitationId }), {
          method: 'POST',
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
    emailSettings: {
      get: (signal?: AbortSignal) =>
        client.request(API_ROUTES.settings.email, { schema: emailSettingsResponseSchema, signal }),
      save: (body: EmailSettingsInput) =>
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
