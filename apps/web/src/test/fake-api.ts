import {
  API_ROUTES,
  type AuthenticatedSession,
  type BrandingResponse,
  type EmailSettingsResponse,
  type SetupStatusResponse,
  type UserRole,
} from '@balesin/shared';
import { vi } from 'vitest';

/**
 * API tiruan untuk tes komponen: `fetch` global diganti penangan per path. Tanpa pengaturan
 * khusus, API menjawab seperti instalasi yang sudah selesai dengan Owner yang sedang masuk.
 */
export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeHandler = (request: FakeRequest) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  options: { details?: { field: string; message: string }[]; retryAfter?: number } = {},
): Response {
  return json(
    { error: { code, message, details: options.details, requestId: 'req-tes' } },
    {
      status,
      headers: options.retryAfter ? { 'retry-after': String(options.retryAfter) } : {},
    },
  );
}

export function fakeSession(role: UserRole = 'owner', name = 'Rina Kartika'): AuthenticatedSession {
  return {
    status: 'authenticated',
    user: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001',
      name,
      email: 'rina@majujaya.co.id',
      role,
    },
    organization: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0002',
      name: 'PT Maju Jaya',
      timezone: 'Asia/Jakarta',
    },
    csrfToken: 'csrf-tes-1',
    session: {
      idleExpiresAt: '2026-11-14T00:00:00.000Z',
      absoluteExpiresAt: '2026-12-13T00:00:00.000Z',
    },
  };
}

export const defaultBranding: BrandingResponse = {
  productName: 'Balesin',
  organizationName: 'PT Maju Jaya',
  primaryColor: null,
  logoUrl: null,
};

export const emptyEmailSettings: EmailSettingsResponse = {
  source: 'none',
  settings: null,
  status: 'not_configured',
  lastTest: null,
  updatedAt: null,
  canStoreSecrets: true,
};

export interface FakeApiOptions {
  /** `null` = belum masuk (401). */
  session?: AuthenticatedSession | null;
  branding?: BrandingResponse;
  setupStatus?: SetupStatusResponse;
  emailSettings?: EmailSettingsResponse;
  /** Penangan tambahan, kunci `"METODE /path"`; mengalahkan bawaan. */
  routes?: Record<string, FakeHandler>;
}

export interface FakeApi {
  requests: FakeRequest[];
  /** Ganti/tambah penangan setelah dipasang. */
  on(key: string, handler: FakeHandler): void;
  setSession(session: AuthenticatedSession | null): void;
}

export function installFakeApi(options: FakeApiOptions = {}): FakeApi {
  let session = options.session === undefined ? fakeSession() : options.session;
  const routes = new Map<string, FakeHandler>();
  const requests: FakeRequest[] = [];

  const unauthenticated = () => apiError(401, 'UNAUTHENTICATED', 'Masuk dulu untuk melanjutkan.');
  const defaults: Record<string, FakeHandler> = {
    [`GET ${API_ROUTES.auth.me}`]: () => (session ? json(session) : unauthenticated()),
    [`GET ${API_ROUTES.branding.get}`]: () => json(options.branding ?? defaultBranding),
    [`GET ${API_ROUTES.setup.status}`]: () =>
      json(
        options.setupStatus ?? {
          needsSetup: false,
          setupTokenConfigured: true,
          canStoreSecrets: true,
        },
      ),
    [`GET ${API_ROUTES.settings.email}`]: () =>
      session ? json(options.emailSettings ?? emptyEmailSettings) : unauthenticated(),
    [`POST ${API_ROUTES.auth.logout}`]: () => {
      session = null;
      return json({ status: 'logged_out' });
    },
  };
  for (const [key, handler] of Object.entries({ ...defaults, ...options.routes })) {
    routes.set(key, handler);
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, 'http://localhost');
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const request = { method, path: url.pathname, headers, body };
      requests.push(request);
      const handler = routes.get(`${method} ${url.pathname}`);
      if (!handler) {
        return apiError(404, 'NOT_FOUND', `Tidak ada penangan untuk ${method} ${url.pathname}`);
      }
      return handler(request);
    }),
  );

  return {
    requests,
    on(key, handler) {
      routes.set(key, handler);
    },
    setSession(next) {
      session = next;
    },
  };
}
