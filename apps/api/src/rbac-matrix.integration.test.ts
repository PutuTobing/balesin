/**
 * Tes otorisasi per endpoint (SECURITY.md §2): SEMUA rute terdaftar × 5 peran + tanpa sesi + sesi
 * terbatas "wajib mendaftar 2FA", dibandingkan dengan matriks izin di `@balesin/shared`.
 *
 * Dua lapis:
 *  1. Statis — `ROUTES` di bawah adalah daftar TERTULIS setiap rute modul beserta aksesnya. Rute
 *     baru tanpa entri, entri tanpa rute, atau akses yang berbeda membuat tes gagal. Menambah rute
 *     = menambah satu baris di sini (dan diff-nya dibaca `security`).
 *  2. Dinamis — setiap rute (termasuk HEAD otomatis dan rute pelengkap 405) dipanggil sebagai
 *     setiap pemanggil dengan cookie + CSRF + Origin sah. Hasilnya harus cocok dengan matriks:
 *     ditolak lapisan auth (401 / 403 izin / 403 wajib-2FA) atau lolos ke handler.
 *
 * Body permintaan pengubah data sengaja berupa array JSON (`[]`) supaya permintaan yang LOLOS
 * berhenti di validasi (400) tanpa efek samping; `POST /auth/logout` dipanggil paling akhir.
 */
import { auditLogs, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  ERROR_MESSAGES,
  errorEnvelopeSchema,
  hasPermission,
  USER_ROLES,
  type Permission,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RouteAccess, RouteDeclaration } from './http/route-access';
import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  sessionCookieOf,
  startLogin,
  type IntegrationHarness,
} from './testing/integration';

/** `public` tanpa sesi · `session` cukup sesi penuh · `enrollment` sesi penuh atau sesi terbatas 2FA. */
type Expectation = 'public' | 'session' | 'enrollment' | Permission;

/**
 * SEMUA rute modul (tanpa HEAD otomatis dan pelengkap 405 — keduanya diturunkan dari sini).
 * Urut per modul seperti `buildApp`.
 */
const ROUTES: Readonly<Record<string, Expectation>> = {
  // health
  'GET /health': 'public',
  'GET /ready': 'public',
  // setup (publik; dikunci token setup + 409 setelah selesai)
  'GET /api/v1/setup/status': 'public',
  'POST /api/v1/setup/verify-token': 'public',
  'POST /api/v1/setup/check-password': 'public',
  'POST /api/v1/setup/email/detect-host': 'public',
  'POST /api/v1/setup/email/test-connection': 'public',
  'POST /api/v1/setup/email/send-test': 'public',
  'POST /api/v1/setup/complete': 'public',
  // auth
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/2fa/verify': 'public',
  'POST /api/v1/auth/logout': 'enrollment',
  'GET /api/v1/auth/me': 'enrollment',
  // 2FA milik sendiri
  'GET /api/v1/auth/2fa': 'enrollment',
  'POST /api/v1/auth/2fa/enroll': 'enrollment',
  'POST /api/v1/auth/2fa/enroll/confirm': 'enrollment',
  'POST /api/v1/auth/2fa/backup-codes': 'session',
  'POST /api/v1/auth/2fa/disable': 'session',
  // branding halaman masuk
  'GET /api/v1/branding': 'public',
  'GET /api/v1/branding/logo': 'public',
  // Pengaturan → Email pengirim
  'GET /api/v1/settings/email': 'settings.email.manage',
  'PUT /api/v1/settings/email': 'settings.email.manage',
  'POST /api/v1/settings/email/detect-host': 'settings.email.manage',
  'POST /api/v1/settings/email/test-connection': 'settings.email.manage',
  'POST /api/v1/settings/email/send-test': 'settings.email.manage',
  'GET /api/v1/settings/email/templates/:template/preview': 'settings.email.manage',
  // undangan
  'GET /api/v1/invitations': 'team.invite',
  'POST /api/v1/invitations': 'team.invite',
  'POST /api/v1/invitations/:invitationId/resend': 'team.invite',
  'DELETE /api/v1/invitations/:invitationId': 'team.invite',
  'POST /api/v1/auth/invitation/inspect': 'public',
  'POST /api/v1/auth/invitation/accept': 'public',
  // atur ulang password (publik)
  'GET /api/v1/auth/password-reset': 'public',
  'POST /api/v1/auth/password-reset/request': 'public',
  'POST /api/v1/auth/password-reset/inspect': 'public',
  'POST /api/v1/auth/password-reset/complete': 'public',
  // verifikasi email milik sendiri
  'GET /api/v1/auth/email/verification': 'session',
  'POST /api/v1/auth/email/verification': 'session',
  'POST /api/v1/auth/email/verify': 'public',
  // sesi aktif milik sendiri
  'GET /api/v1/auth/sessions': 'session',
  'DELETE /api/v1/auth/sessions/:sessionId': 'session',
  'POST /api/v1/auth/sessions/revoke-others': 'session',
  // manajemen pengguna (aturan per peran sasaran: `MANAGE_PERMISSIONS`, diuji team.integration)
  'GET /api/v1/users': 'team.manage',
  'GET /api/v1/users/:userId': 'team.manage',
  'PUT /api/v1/users/:userId/role': 'team.manage',
  'POST /api/v1/users/:userId/disable': 'team.manage',
  'POST /api/v1/users/:userId/enable': 'team.manage',
  'POST /api/v1/users/:userId/2fa/reset': 'team.manage',
  'POST /api/v1/users/:userId/2fa/enrollment-window': 'team.manage',
  'POST /api/v1/users/:userId/unlock': 'team.manage',
  'GET /api/v1/users/:userId/sessions': 'team.manage',
  'DELETE /api/v1/users/:userId/sessions/:sessionId': 'team.manage',
  'POST /api/v1/users/:userId/sessions/revoke-all': 'team.manage',
  // audit log
  'GET /api/v1/audit-logs': 'audit.view',
  'GET /api/v1/audit-logs/export': 'audit.view',
  'GET /api/v1/audit-logs/security-summary': 'audit.view',
};

const LOGOUT = 'POST /api/v1/auth/logout';

function accessOf(expectation: Expectation): RouteAccess {
  switch (expectation) {
    case 'public':
      return { kind: 'public' };
    case 'session':
      return { kind: 'authenticated' };
    case 'enrollment':
      return { kind: 'authenticated', allowTwoFactorEnrollment: true };
    default:
      return { kind: 'permission', permission: expectation };
  }
}

/** Akses pelengkap 405 yang diharapkan, dihitung dari tabel (bukan dari kode yang diuji). */
function complementExpectation(expectations: readonly Expectation[]): Expectation {
  if (expectations.every((value) => value === 'public')) return 'public';
  const distinct = new Set(expectations);
  const [only] = distinct;
  if (distinct.size === 1 && only !== 'session' && only !== 'enrollment')
    return only as Expectation;
  return 'session';
}

type Principal =
  | { kind: 'anonymous' }
  | { kind: 'enrollment'; role: UserRole; userId: string; cookie: string; csrf: string }
  | { kind: 'full'; role: UserRole; userId: string; cookie: string; csrf: string };

type Outcome = 'allowed' | 'unauthenticated' | 'forbidden' | 'enrollment_required';
/** HEAD tanpa body: 403 tidak bisa dibedakan (versi GET-nya yang memeriksa kodenya). */
type Observed = Outcome | 'forbidden_head';

function matches(expected: Outcome, observed: Observed): boolean {
  if (observed === 'forbidden_head') {
    return expected === 'forbidden' || expected === 'enrollment_required';
  }
  return expected === observed;
}

function expectedOutcome(expectation: Expectation, principal: Principal): Outcome {
  if (expectation === 'public') return 'allowed';
  if (principal.kind === 'anonymous') return 'unauthenticated';
  if (principal.kind === 'enrollment') {
    return expectation === 'enrollment' ? 'allowed' : 'enrollment_required';
  }
  if (expectation === 'session' || expectation === 'enrollment') return 'allowed';
  return hasPermission(principal.role, expectation) ? 'allowed' : 'forbidden';
}

type Response = Awaited<ReturnType<typeof call>>;

/** Apa yang diputuskan lapisan auth untuk respons ini. */
function observedOutcome(response: Response): Observed {
  if (response.statusCode !== 401 && response.statusCode !== 403) return 'allowed';
  // HEAD tidak punya body; status + pemeriksaan GET-nya sudah cukup.
  if (response.body === '') {
    return response.statusCode === 401 ? 'unauthenticated' : 'forbidden_head';
  }
  const { code, message } = errorEnvelopeSchema.parse(response.json()).error;
  if (code === 'UNAUTHENTICATED') return 'unauthenticated';
  if (code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') return 'enrollment_required';
  // 403 dari handler sendiri (mis. Admin mengundang Admin) memakai pesan khusus; penolakan
  // izin di hook selalu memakai pesan bawaan.
  if (code === 'FORBIDDEN' && message === ERROR_MESSAGES.FORBIDDEN) return 'forbidden';
  if (code === 'CSRF_INVALID') return 'forbidden';
  return 'allowed';
}

const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  invitationId: '00000000-0000-4000-8000-0000000000aa',
  template: 'invitation',
  userId: '00000000-0000-4000-8000-0000000000bb',
  sessionId: '00000000-0000-4000-8000-0000000000cc',
};

function concreteUrl(pattern: string): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = SAMPLE_PARAMS[name];
    if (value === undefined)
      throw new Error(`Tambahkan contoh parameter "${name}" di SAMPLE_PARAMS`);
    return value;
  });
}

let harness: IntegrationHarness;
let declarations: RouteDeclaration[];
const principals = new Map<string, Principal>();
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-matriks-rbac-01';

beforeAll(async () => {
  harness = await createIntegrationHarness();
  const owner = await completeSetup(harness.app);
  const organizationId = owner.session.organization.id;
  declarations = [...harness.app.routeDeclarations];

  principals.set('tanpa sesi', { kind: 'anonymous' });
  principals.set('owner', {
    kind: 'full',
    role: 'owner',
    userId: owner.session.user.id,
    cookie: owner.cookie,
    csrf: owner.csrf,
  });
  const passwordHash = await hasher.hash(PASSWORD);
  for (const role of USER_ROLES.filter((value) => value !== 'owner')) {
    const user = await insertUser(harness.db, organizationId, {
      role,
      email: `${role}.matriks@majujaya.test`,
      name: `Pengguna ${role}`,
      passwordHash,
    });
    const signed = await login(harness.app, { email: user.email, password: PASSWORD });
    principals.set(role, {
      kind: 'full',
      role,
      userId: user.id,
      cookie: signed.cookie,
      csrf: signed.csrf,
    });
  }
  // Sesi terbatas: Admin yang belum mendaftarkan 2FA.
  const enrolling = await insertUser(harness.db, organizationId, {
    role: 'admin',
    email: 'admin.belum2fa@majujaya.test',
    name: 'Admin Belum 2FA',
    passwordHash,
  });
  const { response, body } = await startLogin(harness.app, {
    email: enrolling.email,
    password: PASSWORD,
  });
  if (body.status !== 'two_factor_enrollment_required') throw new Error('bukan sesi terbatas');
  principals.set('sesi terbatas 2FA', {
    kind: 'enrollment',
    role: 'admin',
    userId: enrolling.id,
    cookie: sessionCookieOf(response),
    csrf: body.csrfToken,
  });
});

afterAll(async () => {
  await harness?.close();
});

const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

/** Akses yang diharapkan untuk satu deklarasi (rute modul, HEAD otomatis, atau pelengkap 405). */
function expectationFor(route: RouteDeclaration): Expectation {
  if (route.methodNotAllowed) {
    const real = Object.entries(ROUTES)
      .filter(([entry]) => entry.split(' ')[1] === route.url)
      .map(([, expectation]) => expectation);
    if (real.length === 0) throw new Error(`Pelengkap 405 tanpa rute asli: ${key(route)}`);
    return complementExpectation(real);
  }
  const entry = route.method === 'HEAD' ? `GET ${route.url}` : key(route);
  const expectation = ROUTES[entry];
  if (expectation === undefined) {
    throw new Error(`Rute ${key(route)} belum ada di tabel ROUTES rbac-matrix.integration.test.ts`);
  }
  return expectation;
}

describe('deklarasi rute = tabel tertulis', () => {
  it('setiap rute modul punya entri, setiap entri punya rute, aksesnya sama persis', () => {
    const real = declarations.filter((route) => !route.methodNotAllowed && route.method !== 'HEAD');
    expect(real.map(key).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const route of real) {
      expect(route.access, key(route)).toEqual(accessOf(expectationFor(route)));
    }
  });

  it('HEAD otomatis dan rute pelengkap 405 mengikuti aksesnya', () => {
    const derived = declarations.filter(
      (route) => route.methodNotAllowed || route.method === 'HEAD',
    );
    expect(derived.length).toBeGreaterThan(Object.keys(ROUTES).length);
    for (const route of derived) {
      expect(route.access, key(route)).toEqual(accessOf(expectationFor(route)));
    }
    // HEAD modul hanya ada untuk GET; pelengkap 405 tidak pernah boleh dipakai sesi terbatas.
    for (const route of derived.filter((value) => !value.methodNotAllowed)) {
      expect(route.method, key(route)).toBe('HEAD');
      expect(ROUTES[`GET ${route.url}`], key(route)).toBeDefined();
    }
    for (const route of declarations.filter((value) => value.methodNotAllowed)) {
      expect(
        route.access.kind === 'authenticated' && route.access.allowTwoFactorEnrollment,
        key(route),
      ).toBeFalsy();
    }
  });

  it('daftar rute publik dan rute cukup-sesi eksplisit (bukan izin) tidak bertambah diam-diam', () => {
    const byExpectation = (wanted: Expectation[]) =>
      Object.entries(ROUTES)
        .filter(([, expectation]) => wanted.includes(expectation))
        .map(([entry]) => entry)
        .sort();
    // Rute "cukup sesi" hanya untuk data milik pengguna itu sendiri.
    expect(byExpectation(['session', 'enrollment'])).toEqual([
      'DELETE /api/v1/auth/sessions/:sessionId',
      'GET /api/v1/auth/2fa',
      'GET /api/v1/auth/email/verification',
      'GET /api/v1/auth/me',
      'GET /api/v1/auth/sessions',
      'POST /api/v1/auth/2fa/backup-codes',
      'POST /api/v1/auth/2fa/disable',
      'POST /api/v1/auth/2fa/enroll',
      'POST /api/v1/auth/2fa/enroll/confirm',
      'POST /api/v1/auth/email/verification',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/sessions/revoke-others',
    ]);
  });
});

describe('peran × endpoint: hasil sungguhan cocok dengan matriks', () => {
  const PRINCIPAL_NAMES = [
    'tanpa sesi',
    'sesi terbatas 2FA',
    'owner',
    'admin',
    'supervisor',
    'cs',
    'teknisi',
  ] as const;

  it.each(PRINCIPAL_NAMES)('%s', async (name) => {
    const principal = principals.get(name);
    if (!principal) throw new Error(`pemanggil ${name} belum disiapkan`);
    // Pelengkap 405 dulu, lalu rute modul; logout paling akhir (mengakhiri sesi).
    const ordered = [...declarations].sort((a, b) => {
      const rank = (route: RouteDeclaration) =>
        key(route) === LOGOUT ? 2 : route.methodNotAllowed ? 0 : 1;
      return rank(a) - rank(b);
    });

    const mismatches: string[] = [];
    const deniedPermissions = new Set<Permission>();
    for (const route of ordered) {
      const expectation = expectationFor(route);
      const expected = expectedOutcome(expectation, principal);
      const mutating = !['GET', 'HEAD'].includes(route.method);
      const response = await call(
        harness.app,
        route.method as Parameters<typeof call>[1],
        concreteUrl(route.url),
        mutating ? [] : undefined,
        principal.kind === 'anonymous' ? {} : { cookie: principal.cookie, csrf: principal.csrf },
      );
      const observed = observedOutcome(response);
      if (!matches(expected, observed)) {
        mismatches.push(
          `${key(route)}: harap ${expected}, dapat ${observed} (${response.statusCode})`,
        );
      }
      // Pelengkap yang lolos lapisan auth selalu 405 + Allow.
      if (route.methodNotAllowed && expected === 'allowed') {
        if (response.statusCode !== 405 || !response.headers.allow) {
          mismatches.push(
            `${key(route)}: pelengkap harus 405 + Allow, dapat ${response.statusCode}`,
          );
        }
      }
      if (expected === 'forbidden' && expectation !== 'public') {
        deniedPermissions.add(expectation as Permission);
      }
    }
    expect(mismatches).toEqual([]);

    // R8: setiap izin yang ditolak meninggalkan TEPAT satu entri audit (pembatas per izin).
    if (principal.kind === 'full') {
      const rows = await harness.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'auth.access.denied'),
            eq(auditLogs.actorUserId, principal.userId),
          ),
        );
      const audited = rows.map((row) => row.metadata.permission as string).sort();
      expect(audited).toEqual([...deniedPermissions].sort());
    }
  });

  it('pemanggil yang diuji mewakili kelima peran', async () => {
    const roles = [...principals.values()]
      .filter((principal) => principal.kind === 'full')
      .map((principal) => principal.role);
    expect(roles.sort()).toEqual([...USER_ROLES].sort());
    const active = await harness.db.select({ role: users.role }).from(users);
    expect(active.length).toBe(USER_ROLES.length + 1);
  });
});
