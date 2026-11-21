import {
  API_ROUTES,
  INVITE_PERMISSIONS,
  MANAGE_PERMISSIONS,
  SECURITY_EVENT_KINDS,
  type SecurityEventKind,
  type ActiveSession,
  type ActiveSessionListResponse,
  type AuditLogEntry,
  type AuditLogListResponse,
  type SecuritySummaryResponse,
  type TeamUser,
  type TeamUserListResponse,
  permissionsForRole,
  isTwoFactorRequired,
  type AuthenticatedSession,
  type BrandingResponse,
  type ChannelSettingsListResponse,
  type WhatsAppChannel,
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
  type ChannelSummary,
  type Contact,
  type Conversation,
  type InboxAgent,
  type Message,
  type QuickReply,
  type Tag,
  type ConversationNote,
  type ConversationEvent,
} from '@balesin/shared';
import {
  REPORT_ROUTES,
  channelTypeInfos,
  permissionScope,
  type ReportPerformance,
} from '@balesin/shared';
import { vi } from 'vitest';
import { fakeInboxRoutes } from './fake-inbox';

/**
 * API tiruan untuk tes komponen: `fetch` global diganti penangan per path. Tanpa pengaturan
 * khusus, API menjawab seperti instalasi yang sudah selesai dengan Owner yang sedang masuk.
 */
export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** Parameter query (mis. saringan audit log). */
  query: URLSearchParams;
  /** Body mentah (mis. `FormData` unggahan multipart). */
  raw?: unknown;
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

/** Anggota tim contoh (bawaan: CS aktif tanpa 2FA yang bisa dikelola Owner). */
export function fakeTeamUser(overrides: Partial<TeamUser> = {}): TeamUser {
  return {
    id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b01',
    name: 'Citra Maharani',
    email: 'citra@majujaya.co.id',
    role: 'cs',
    status: 'active',
    disabledAt: null,
    lockedUntil: null,
    emailVerified: true,
    lastLoginAt: '2026-11-14T02:15:00.000Z',
    createdAt: '2026-11-10T03:00:00.000Z',
    twoFactor: {
      enabled: false,
      required: false,
      enabledAt: null,
      enrollmentDueAt: null,
      enrollmentExpired: false,
    },
    activeSessions: 1,
    isSelf: false,
    canManage: true,
    assignableRoles: ['admin', 'supervisor', 'cs', 'teknisi'],
    ...overrides,
  };
}

/** Diri sendiri di daftar Tim (dari sesi tiruan). */
export function fakeSelfUser(session: AuthenticatedSession): TeamUser {
  return fakeTeamUser({
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    isSelf: true,
    canManage: false,
    assignableRoles: [],
    twoFactor: {
      enabled: isTwoFactorRequired(session.user.role),
      required: isTwoFactorRequired(session.user.role),
      enabledAt: '2026-11-13T03:00:00.000Z',
      enrollmentDueAt: null,
      enrollmentExpired: false,
    },
  });
}

export function fakeActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c01',
    device: 'Chrome di Windows',
    ipAddress: '203.0.113.*',
    createdAt: '2026-11-13T01:00:00.000Z',
    lastSeenAt: '2026-11-14T02:30:00.000Z',
    current: true,
    limited: false,
    ...overrides,
  };
}

export function fakeAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c01',
    createdAt: '2026-11-14T02:00:00.000Z',
    action: 'user.role_changed',
    actor: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001',
      name: 'Rina Kartika',
      email: 'rina@majujaya.co.id',
      role: 'owner',
    },
    target: { type: 'user', id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b01', name: 'Citra Maharani' },
    metadata: { from: 'cs', to: 'supervisor' },
    ipAddress: '203.0.113.7',
    device: 'Chrome di Windows',
    ...overrides,
  };
}

export const emptySecuritySummary: SecuritySummaryResponse = {
  since: '2026-11-07T00:00:00.000Z',
  events: [],
  counts: Object.fromEntries(SECURITY_EVENT_KINDS.map((kind) => [kind, 0])) as Record<
    SecurityEventKind,
    number
  >,
  latestWarningAt: null,
};

/** Channel WhatsApp contoh: terhubung, kualitas Tinggi. */
export function fakeChannel(overrides: Partial<WhatsAppChannel> = {}): WhatsAppChannel {
  return {
    id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
    type: 'whatsapp',
    name: 'CS Utama',
    enabled: true,
    disabledAt: null,
    status: 'connected',
    phoneNumberId: '106540352242922',
    wabaId: '102290129340398',
    accessTokenHint: '••••Q2ZD',
    appSecretHint: '••••91af',
    webhookUrl: 'https://api.majujaya.co.id/webhooks/whatsapp/6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
    lastTest: {
      ok: true,
      code: 'ok',
      message: 'Koneksi berhasil. Token, App Secret, Phone Number ID, dan WABA ID cocok.',
      testedAt: '2026-11-14T02:00:00.000Z',
    },
    number: {
      displayPhoneNumber: '+62 811-7200-345',
      verifiedName: 'Maju Jaya Net',
      qualityRating: 'GREEN',
      status: 'CONNECTED',
      nameStatus: 'APPROVED',
      codeVerificationStatus: 'VERIFIED',
      messagingLimit: 'TIER_10K',
      throughputLevel: 'STANDARD',
      fetchedAt: '2026-11-14T02:00:00.000Z',
    },
    warnings: [],
    credentialsUpdatedAt: '2026-11-10T02:00:00.000Z',
    createdAt: '2026-11-10T02:00:00.000Z',
    updatedAt: '2026-11-14T02:00:00.000Z',
    ...overrides,
  };
}

export interface FakeApiOptions {
  /** Bawaan: belum ada channel, kunci enkripsi ada, batas 20. */
  channelSettings?: ChannelSettingsListResponse;
  /** Bawaan: hanya diri sendiri (dari sesi). */
  teamUsers?: TeamUserListResponse;
  /** Bawaan: satu sesi (sesi ini). */
  sessions?: ActiveSessionListResponse;
  /** Bawaan: kosong. */
  auditLog?: AuditLogListResponse;
  /** Bawaan: tanpa kejadian. */
  securitySummary?: SecuritySummaryResponse;
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
  /** Bawaan inbox: kosong (tanpa percakapan, hitungan 0, tanpa channel). */
  inbox?: FakeInbox;
  /** Penangan tambahan, kunci `"METODE /path"`; mengalahkan bawaan. */
  routes?: Record<string, FakeHandler>;
}

export interface FakeInbox {
  conversations?: Conversation[];
  messages?: Record<string, Message[]>;
  contacts?: Contact[];
  channels?: ChannelSummary[];
  agents?: InboxAgent[];
  quickReplies?: QuickReply[];
  /** Rem darurat ditarik (`GET /inbox/sending-status`). */
  paused?: boolean;
  /** Master tag organisasi (`GET /tags`). */
  tags?: Tag[];
  /** Catatan sesi per percakapan. */
  notes?: Record<string, ConversationNote[]>;
  /** Log percakapan per percakapan (terlama dulu). */
  events?: Record<string, ConversationEvent[]>;
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
    // Broadcast: bawaan belum ada kampanye (tes broadcast mengganti lewat `routes`).
    [`GET ${API_ROUTES.broadcasts.list}`]: () =>
      session ? json({ broadcasts: [], nextCursor: null }) : unauthenticated(),
    // Fase 5 (bawaan kosong; tes fitur mengganti lewat `routes`).
    [`GET ${API_ROUTES.crm.contacts}`]: fullSessionOnly(() =>
      json({ contacts: [], nextCursor: null }),
    ),
    [`GET ${API_ROUTES.crm.attributes}`]: fullSessionOnly(() => json({ attributes: [] })),
    [`GET ${API_ROUTES.tickets.boards}`]: fullSessionOnly(() => json({ boards: [] })),
    [`GET ${API_ROUTES.tickets.list}`]: fullSessionOnly(() =>
      json({ tickets: [], nextCursor: null }),
    ),
    [`GET ${API_ROUTES.departments.list}`]: fullSessionOnly(() => json({ departments: [] })),
    // Fase 6: channel selain WhatsApp (bawaan belum ada).
    [`GET ${API_ROUTES.channelConnections.list}`]: fullSessionOnly(() =>
      json({ channels: [], types: channelTypeInfos(), canStoreSecrets: true, maxChannels: 20 }),
    ),
    [`GET ${REPORT_ROUTES.performance}`]: fullSessionOnly((request) =>
      json({ report: emptyReport(request, session?.user.role ?? 'cs') }),
    ),
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
    [`GET ${API_ROUTES.team.users}`]: fullSessionOnly(() =>
      json(
        options.teamUsers ?? {
          users: session?.status === 'authenticated' ? [fakeSelfUser(session)] : [],
          manageableRoles: [...MANAGE_PERMISSIONS[session?.user.role ?? 'cs']],
        },
      ),
    ),
    [`GET ${API_ROUTES.sessions.list}`]: fullSessionOnly(() =>
      json(options.sessions ?? { sessions: [fakeActiveSession()] }),
    ),
    [`GET ${API_ROUTES.audit.list}`]: fullSessionOnly(() =>
      json(options.auditLog ?? { entries: [], nextCursor: null }),
    ),
    [`GET ${API_ROUTES.audit.securitySummary}`]: fullSessionOnly(() =>
      json(options.securitySummary ?? emptySecuritySummary),
    ),
    [`GET ${API_ROUTES.channels.settings}`]: fullSessionOnly(() =>
      json(options.channelSettings ?? { channels: [], canStoreSecrets: true, maxChannels: 20 }),
    ),
    ...fakeInboxRoutes(options.inbox ?? {}, fullSessionOnly),
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
      const request = {
        method,
        path: url.pathname,
        headers,
        body,
        query: url.searchParams,
        raw: init.body,
      };
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

/** Laporan kinerja kosong (cakupan sesuai peran) untuk rentang yang diminta. */
export function emptyReport(request: FakeRequest, role: UserRole): ReportPerformance {
  const own = permissionScope(role, 'reports.view') === 'own';
  const empty = { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null };
  return {
    range: {
      from: request.query.get('from') ?? '2026-11-12',
      to: request.query.get('to') ?? '2026-11-18',
      timezone: 'Asia/Jakarta',
    },
    scope: own ? 'own' : 'all',
    summary: own
      ? null
      : {
          conversations: 0,
          customerInitiated: 0,
          resolved: 0,
          resolvedByBotOnly: 0,
          handledByHuman: 0,
          handoffs: 0,
          firstResponse: empty,
          wait: empty,
          resolution: empty,
        },
    trends: own ? null : { daily: [], hourly: [] },
    agents: [],
    bots: own ? null : [],
    tags: own ? null : [],
    csat: {
      sent: 0,
      responses: 0,
      average: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      responseRate: null,
    },
  };
}
