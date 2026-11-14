import {
  API_ROUTES,
  isTwoFactorRequired,
  type AuthenticatedSession,
  type BrandingResponse,
  type EmailSettingsResponse,
  type MeResponse,
  type SetupStatusResponse,
  type StartTwoFactorEnrollmentResponse,
  type TwoFactorEnrollmentSession,
  type TwoFactorStatusResponse,
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

/** Sesi terbatas: peran wajib 2FA yang belum mendaftar. */
export function fakeEnrollmentSession(
  role: UserRole = 'owner',
  csrfToken = 'csrf-terbatas',
): TwoFactorEnrollmentSession {
  return { ...fakeSession(role), status: 'two_factor_enrollment_required', csrfToken };
}

/** Status 2FA bawaan: peran wajib sudah aktif dengan 10 kode; peran lain belum aktif. */
export function fakeTwoFactorStatus(
  role: UserRole = 'owner',
  overrides: Partial<TwoFactorStatusResponse> = {},
): TwoFactorStatusResponse {
  const required = isTwoFactorRequired(role);
  return {
    enabled: required,
    required,
    enabledAt: required ? '2026-11-13T03:00:00.000Z' : null,
    backupCodesRemaining: required ? 10 : 0,
    backupCodesGeneratedAt: required ? '2026-11-13T03:00:00.000Z' : null,
    enrollmentPending: false,
    ...overrides,
  };
}

/** Rahasia contoh (base32, 32 karakter) — hanya untuk tes. */
export const FAKE_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export function fakeEnrollment(
  overrides: Partial<StartTwoFactorEnrollmentResponse> = {},
): StartTwoFactorEnrollmentResponse {
  return {
    otpauthUri: `otpauth://totp/Balesin:rina%40majujaya.co.id?secret=${FAKE_TOTP_SECRET}&issuer=Balesin&algorithm=SHA1&digits=6&period=30`,
    secret: FAKE_TOTP_SECRET,
    secretGrouped: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
    issuer: 'Balesin',
    accountName: 'rina@majujaya.co.id',
    expiresAt: '2026-11-14T00:15:00.000Z',
    digits: 6,
    periodSeconds: 30,
    ...overrides,
  };
}

/** 10 kode cadangan contoh (bentuk tampilan `xxxxx-xxxxx`). */
export const FAKE_BACKUP_CODES = [
  'k7m2p-x9q4r',
  'a3b4c-d5e6f',
  'g7h8j-k9m2n',
  'p3q4r-s5t6u',
  'v7w8x-y9z2a',
  'b3c4d-e5f6g',
  'h7j8k-m9n2p',
  'q3r4s-t5u6v',
  'w7x8y-z9a2b',
  'c3d4e-f5g6h',
];

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
  /** `null` = belum masuk (401). Sesi terbatas (`two_factor_enrollment_required`) juga bisa. */
  session?: MeResponse | null;
  /** Bawaan: `fakeTwoFactorStatus(peran sesi)`. */
  twoFactorStatus?: TwoFactorStatusResponse;
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
  setSession(session: MeResponse | null): void;
}

export function installFakeApi(options: FakeApiOptions = {}): FakeApi {
  let session = options.session === undefined ? fakeSession() : options.session;
  const routes = new Map<string, FakeHandler>();
  const requests: FakeRequest[] = [];

  const unauthenticated = () => apiError(401, 'UNAUTHENTICATED', 'Masuk dulu untuk melanjutkan.');
  const enrollmentRequired = () =>
    apiError(403, 'TWO_FACTOR_ENROLLMENT_REQUIRED', 'Aktifkan verifikasi dua langkah dulu.');
  /** Seperti hook auth server: sesi terbatas hanya boleh ke rute pendaftaran 2FA. */
  const fullSessionOnly =
    (handler: FakeHandler): FakeHandler =>
    (request) => {
      if (!session) return unauthenticated();
      if (session.status !== 'authenticated') return enrollmentRequired();
      return handler(request);
    };
  const defaults: Record<string, FakeHandler> = {
    [`GET ${API_ROUTES.auth.me}`]: () => (session ? json(session) : unauthenticated()),
    [`GET ${API_ROUTES.twoFactor.status}`]: () =>
      session
        ? json(options.twoFactorStatus ?? fakeTwoFactorStatus(session.user.role))
        : unauthenticated(),
    [`GET ${API_ROUTES.branding.get}`]: () => json(options.branding ?? defaultBranding),
    [`GET ${API_ROUTES.setup.status}`]: () =>
      json(
        options.setupStatus ?? {
          needsSetup: false,
          setupTokenConfigured: true,
          canStoreSecrets: true,
        },
      ),
    [`GET ${API_ROUTES.settings.email}`]: fullSessionOnly(() =>
      json(options.emailSettings ?? emptyEmailSettings),
    ),
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
