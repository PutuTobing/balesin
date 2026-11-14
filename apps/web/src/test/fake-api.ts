import {
  API_ROUTES,
  INVITE_PERMISSIONS,
  permissionsForRole,
  isTwoFactorRequired,
  type AuthenticatedSession,
  type BrandingResponse,
  type EmailSettingsResponse,
  type EmailVerificationStatusResponse,
  type Invitation,
  type InvitationListResponse,
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
    permissions: permissionsForRole(role),
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
  // Sesi terbatas tidak pernah memegang izin apa pun.
  return {
    ...fakeSession(role),
    status: 'two_factor_enrollment_required',
    csrfToken,
    permissions: [],
  };
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

/** Status verifikasi email bawaan: sudah terverifikasi (keadaan paling tenang). */
export function fakeEmailVerification(
  overrides: Partial<EmailVerificationStatusResponse> = {},
): EmailVerificationStatusResponse {
  return {
    email: 'rina@majujaya.co.id',
    verified: true,
    verifiedAt: '2026-11-13T03:00:00.000Z',
    canSend: true,
    ...overrides,
  };
}

export function fakeInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: '7d1c4f8e-2b3a-4c5d-8e9f-0a1b2c3d4e01',
    email: 'citra@majujaya.co.id',
    role: 'cs',
    status: 'pending',
    invitedBy: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
    createdAt: '2026-11-14T02:00:00.000Z',
    lastSentAt: '2026-11-14T02:00:00.000Z',
    expiresAt: '2026-11-17T02:00:00.000Z',
    sendCount: 1,
    deliveryStatus: 'sent',
    canManage: true,
    ...overrides,
  };
}

export function fakeInvitationList(
  overrides: Partial<InvitationListResponse> = {},
): InvitationListResponse {
  return {
    invitations: [],
    invitableRoles: ['admin', 'supervisor', 'cs', 'teknisi'],
    emailDelivery: true,
    ...overrides,
  };
}

export interface FakeApiOptions {
  /** `null` = belum masuk (401). Sesi terbatas (`two_factor_enrollment_required`) juga bisa. */
  session?: MeResponse | null;
  /** Bawaan: `fakeTwoFactorStatus(peran sesi)`. */
  twoFactorStatus?: TwoFactorStatusResponse;
  branding?: BrandingResponse;
  setupStatus?: SetupStatusResponse;
  emailSettings?: EmailSettingsResponse;
  /** Bawaan: `fakeEmailVerification()` dengan email sesi. */
  emailVerification?: EmailVerificationStatusResponse;
  /** Bawaan: daftar kosong, pilihan peran sesuai peran sesi, email pengirim diatur. */
  invitations?: InvitationListResponse;
  /** Bawaan: `true` (email pengirim instalasi sudah diatur). */
  passwordResetAvailable?: boolean;
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
    [`GET ${API_ROUTES.emailVerification.status}`]: fullSessionOnly(() =>
      json(
        options.emailVerification ?? fakeEmailVerification({ email: session?.user.email ?? '' }),
      ),
    ),
    [`GET ${API_ROUTES.invitations.collection}`]: fullSessionOnly(() =>
      json(
        options.invitations ??
          fakeInvitationList({
            invitableRoles: [...INVITE_PERMISSIONS[session?.user.role ?? 'cs']],
          }),
      ),
    ),
    [`GET ${API_ROUTES.passwordReset.status}`]: () =>
      json({ available: options.passwordResetAvailable ?? true }),
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
