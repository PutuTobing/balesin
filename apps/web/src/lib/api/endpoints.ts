import {
  API_ROUTES,
  authenticatedSessionSchema,
  brandingResponseSchema,
  detectEmailHostResponseSchema,
  emailSettingsResponseSchema,
  emailTestResultSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  passwordCheckResponseSchema,
  setupStatusResponseSchema,
  verifySetupTokenResponseSchema,
  type CheckSetupPasswordRequest,
  type CompleteSetupRequest,
  type EmailSettingsInput,
  type LoginRequest,
  type SetupDetectEmailHostRequest,
  type SetupSendTestEmailRequest,
  type SetupTestEmailConnectionRequest,
} from '@balesin/shared';
import { api, type ApiClient } from './client';

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
          schema: authenticatedSessionSchema,
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
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;

export const endpoints = createEndpoints(api);
