/**
 * RBAC di luar tabel rute (Fase 1 butir 5):
 *  - audit `auth.access.denied` (temuan R8) beserta pembatasnya;
 *  - daftar izin di respons sesi (web menyembunyikan menu dari sini);
 *  - pemeriksaan cakupan di handler (`permissionGrant` / `assertWithinScope`).
 * Matriks rute × peran lengkap: `src/rbac-matrix.integration.test.ts`.
 */
import { auditLogs } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  loginResponseSchema,
  meResponseSchema,
  PERMISSIONS,
  permissionsForRole,
  verifyTwoFactorResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { requirePermission } from '../../http/route-access';
import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  enrollTwoFactor,
  freshTotpCode,
  login,
  sessionCookieOf,
  startLogin,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { ACCESS_DENIED_FLAG } from './access-denied';
import { createPasswordHasher } from './password-hasher';
import { assertWithinScope, permissionGrant } from './permission-grant';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-rbac-izin-01';

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  harness.logs.lines.length = 0;
});
afterAll(async () => {
  await harness?.close();
});

async function addUser(role: UserRole) {
  return insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
}

async function signIn(role: UserRole) {
  const user = await addUser(role);
  const signed = await login(harness.app, { email: user.email, password: PASSWORD });
  return { user, signed };
}

const as = (signed: { cookie: string; csrf: string }) => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

async function deniedRows(userId: string) {
  return harness.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'auth.access.denied'), eq(auditLogs.actorUserId, userId)))
    .orderBy(auditLogs.createdAt);
}

/** Menghapus penanda pembatas audit pengguna ini (seolah jendela 1 menit sudah lewat). */
async function expireDeniedFlags(userId: string) {
  const keys = await harness.redis.keys(`*:flag:${ACCESS_DENIED_FLAG}:${userId}:*`);
  if (keys.length > 0) await harness.redis.del(...keys);
  return keys.length;
}

describe('audit penolakan izin (R8)', () => {
  it('mencatat izin, metode, POLA rute, peran, dan sesi — tanpa ID dari URL, query, atau body', async () => {
    const { user, signed } = await signIn('cs');
    const secretish = 'kata-sandi-yang-tidak-boleh-tercatat';

    const response = await call(
      harness.app,
      'DELETE',
      `${apiPath(API_ROUTES.invitations.revoke, {
        invitationId: '11111111-2222-4333-8444-555555555555',
      })}?catatan=${secretish}`,
      { password: secretish },
      as(signed),
    );

    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('FORBIDDEN');
    const [row, ...rest] = await deniedRows(user.id);
    expect(rest).toEqual([]);
    expect(row?.organizationId).toBe(owner.session.organization.id);
    expect(row?.targetType).toBe('permission');
    expect(row?.targetId).toBe('team.invite');
    expect(row?.metadata).toEqual({
      permission: 'team.invite',
      method: 'DELETE',
      route: '/api/v1/invitations/:invitationId',
      role: 'cs',
      sessionRef: expect.any(String) as string,
      fetchSite: null,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(secretish);
    expect(stored).not.toContain('11111111-2222-4333-8444-555555555555');
  });

  it('pembatas: maks. satu entri per pengguna × izin per jendela; izin/pengguna lain dihitung sendiri', async () => {
    const cs = await signIn('cs');
    const teknisi = await signIn('teknisi');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call(
        harness.app,
        'GET',
        API_ROUTES.settings.email,
        undefined,
        as(cs.signed),
      );
      expect(response.statusCode).toBe(403);
    }
    // Rute lain dengan izin SAMA tidak menambah entri; izin lain menambah.
    await call(harness.app, 'PUT', API_ROUTES.settings.email, {}, as(cs.signed));
    await call(harness.app, 'GET', API_ROUTES.invitations.collection, undefined, as(cs.signed));
    await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, as(teknisi.signed));

    expect((await deniedRows(cs.user.id)).map((row) => row.metadata.permission)).toEqual([
      'settings.email.manage',
      'team.invite',
    ]);
    expect((await deniedRows(teknisi.user.id)).map((row) => row.metadata.permission)).toEqual([
      'settings.email.manage',
    ]);

    // Setelah jendela lewat, percobaan berikutnya tercatat lagi.
    expect(await expireDeniedFlags(cs.user.id)).toBe(2);
    await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, as(cs.signed));
    expect(await deniedRows(cs.user.id)).toHaveLength(3);
  });

  it('Sec-Fetch-Site dicatat (membedakan navigasi lintas situs yang membawa cookie korban); nilai asing → "lainnya"', async () => {
    const { user, signed } = await signIn('cs');
    await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      ...as(signed),
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    await call(harness.app, 'GET', API_ROUTES.invitations.collection, undefined, {
      ...as(signed),
      headers: { 'sec-fetch-site': '<script>' },
    });
    const rows = await deniedRows(user.id);
    expect(rows.map((row) => [row.metadata.permission, row.metadata.fetchSite])).toEqual([
      ['settings.email.manage', 'cross-site'],
      ['team.invite', 'lainnya'],
    ]);
  });

  it('aturan turunan (R1): Admin mengelola undangan Admin → 403 + audit "rule", dibatasi per aturan', async () => {
    const admin = await signIn('admin');
    const ownerInvite = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      await withConfirmation(owner, { email: 'calon-admin@majujaya.test', role: 'admin' }),
      as(owner),
    );
    expect(ownerInvite.statusCode).toBe(201);
    const invitationId = ownerInvite.json<{ invitation: { id: string } }>().invitation.id;

    const attempts = [
      await call(
        harness.app,
        'POST',
        API_ROUTES.invitations.collection,
        await withConfirmation(admin.signed, { email: 'admin-kedua@majujaya.test', role: 'admin' }),
        as(admin.signed),
      ),
      await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.invitations.resend, { invitationId }),
        await withConfirmation(admin.signed, {}),
        as(admin.signed),
      ),
      await call(
        harness.app,
        'DELETE',
        apiPath(API_ROUTES.invitations.revoke, { invitationId }),
        undefined,
        as(admin.signed),
      ),
    ];
    for (const response of attempts) {
      expect(response.statusCode).toBe(403);
      // Pesan khusus aturan tetap sama seperti sebelumnya.
      expect(errorEnvelopeSchema.parse(response.json()).error.message).toContain(
        'Undangan Admin hanya bisa dibuat Owner',
      );
    }
    const rows = await deniedRows(admin.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe('rule');
    expect(rows[0]?.targetId).toBe('team.invite.role');
    expect(rows[0]?.metadata).toEqual({
      rule: 'team.invite.role',
      operation: 'create',
      targetRole: 'admin',
      role: 'admin',
      sessionRef: expect.any(String) as string,
    });
    expect(JSON.stringify(rows)).not.toContain('admin-kedua@majujaya.test');
  });

  it('penolakan yang BUKAN karena izin tidak dicatat sebagai access.denied', async () => {
    const { user, signed } = await signIn('cs');
    // tanpa sesi, CSRF salah, origin asing, rute cukup-sesi milik sendiri
    await call(harness.app, 'GET', API_ROUTES.settings.email);
    await call(harness.app, 'PUT', API_ROUTES.settings.email, {}, { cookie: signed.cookie });
    await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      {},
      {
        ...as(signed),
        origin: 'https://jahat.test',
      },
    );
    await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(signed));
    // sesi terbatas 2FA (Admin yang belum mendaftar): 403 wajib-2FA, bukan penolakan izin
    const admin = await addUser('admin');
    const { body, response } = await startLogin(harness.app, {
      email: admin.email,
      password: PASSWORD,
    });
    if (body.status !== 'two_factor_enrollment_required') throw new Error('bukan sesi terbatas');
    const limited = await call(harness.app, 'GET', API_ROUTES.settings.email, undefined, {
      cookie: sessionCookieOf(response),
      csrf: body.csrfToken,
    });
    expect(errorEnvelopeSchema.parse(limited.json()).error.code).toBe(
      'TWO_FACTOR_ENROLLMENT_REQUIRED',
    );

    expect(await deniedRows(user.id)).toEqual([]);
    expect(await deniedRows(admin.id)).toEqual([]);
  });

  it('Redis mati: tetap 403 (tidak pernah 500/diloloskan), entri dilewati dan dicatat di log', async () => {
    const { user, signed } = await signIn('cs');
    await harness.rebuild({ redis: false });
    harness.logs.lines.length = 0;

    const response = await call(
      harness.app,
      'GET',
      API_ROUTES.settings.email,
      undefined,
      as(signed),
    );

    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('FORBIDDEN');
    expect(await deniedRows(user.id)).toEqual([]);
    const warning = harness.logs
      .entries()
      .find((entry) => entry.msg === 'Audit penolakan akses tidak tercatat');
    expect(warning).toMatchObject({ permission: 'settings.email.manage', userRef: user.id });
    await harness.rebuild();
  });
});

describe('izin di respons sesi', () => {
  it('GET /auth/me: Owner memegang semua izin, berurutan seperti PERMISSIONS', async () => {
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(owner));
    expect(meResponseSchema.parse(me.json()).permissions).toEqual([...PERMISSIONS]);
  });

  it.each<UserRole>(['admin', 'supervisor', 'cs', 'teknisi'])(
    'peran %s: login dan /auth/me membawa izin peran itu',
    async (role) => {
      const { signed } = await signIn(role);
      expect(signed.session.permissions).toEqual(permissionsForRole(role));
      const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(signed));
      expect(meResponseSchema.parse(me.json()).permissions).toEqual(permissionsForRole(role));
    },
  );

  it('CS: respons POST /auth/login langsung membawa izin', async () => {
    const user = await addUser('cs');
    const { body } = await startLogin(harness.app, { email: user.email, password: PASSWORD });
    expect(loginResponseSchema.parse(body)).toMatchObject({
      status: 'authenticated',
      permissions: permissionsForRole('cs'),
    });
  });

  it('langkah kedua 2FA (verify) membawa izin', async () => {
    const admin = await signIn('admin');
    const { body } = await startLogin(harness.app, { email: admin.user.email, password: PASSWORD });
    if (body.status !== 'two_factor_required') throw new Error('seharusnya butuh langkah kedua');
    const verify = await call(harness.app, 'POST', API_ROUTES.twoFactor.verify, {
      challengeToken: body.challengeToken,
      code: await freshTotpCode(admin.user.email),
    });
    expect(verifyTwoFactorResponseSchema.parse(verify.json()).permissions).toEqual(
      permissionsForRole('admin'),
    );
  });

  it('sesi terbatas 2FA: izin kosong; setelah 2FA aktif, sesi penuh membawa izin perannya', async () => {
    await harness.reset();
    const enrolling = await completeSetupWithoutTwoFactor(harness.app);
    expect(enrolling.session.status).toBe('two_factor_enrollment_required');
    expect(enrolling.session.permissions).toEqual([]);
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(enrolling));
    expect(meResponseSchema.parse(me.json()).permissions).toEqual([]);

    const full = await enrollTwoFactor(harness.app, enrolling);
    expect(full.session.permissions).toEqual([...PERMISSIONS]);
  });
});

describe('cakupan di handler: permissionGrant + assertWithinScope', () => {
  const reply = { 200: z.object({ scope: z.string() }) };

  async function withScopeRoutes() {
    await harness.rebuild();
    harness.app.get(
      '/__tes/percakapan/:holder',
      {
        config: { access: requirePermission('inbox.view') },
        schema: { params: z.object({ holder: z.string() }), response: reply },
      },
      async (request) => {
        const grant = await permissionGrant(request, 'inbox.view');
        assertWithinScope(grant, { holderUserIds: [request.params.holder] });
        return { scope: grant.scope };
      },
    );
    harness.app.get(
      '/__tes/kirim-template-massal',
      { config: { access: requirePermission('inbox.reply') }, schema: { response: reply } },
      async (request) => {
        // Izin tambahan di luar izin rute.
        const grant = await permissionGrant(request, 'broadcast.send');
        return { scope: grant.scope };
      },
    );
  }

  it('Teknisi: cakupan "assigned" — miliknya 200, milik orang lain 404 (bukan 403); CS: semua', async () => {
    await withScopeRoutes();
    const teknisi = await signIn('teknisi');
    const cs = await signIn('cs');
    const get = (holder: string, signed: SignedIn) =>
      call(harness.app, 'GET', `/__tes/percakapan/${holder}`, undefined, as(signed));

    const mine = await get(teknisi.user.id, teknisi.signed);
    const others = await get(cs.user.id, teknisi.signed);
    const asCs = await get(teknisi.user.id, cs.signed);

    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ scope: 'assigned' });
    expect(others.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(others.json()).error.code).toBe('NOT_FOUND');
    expect(asCs.json()).toEqual({ scope: 'all' });
  });

  it('izin tambahan di handler: CS ditolak 403 + audit; Supervisor lolos', async () => {
    await withScopeRoutes();
    const cs = await signIn('cs');
    const supervisor = await signIn('supervisor');

    const denied = await call(
      harness.app,
      'GET',
      '/__tes/kirim-template-massal',
      undefined,
      as(cs.signed),
    );
    const allowed = await call(
      harness.app,
      'GET',
      '/__tes/kirim-template-massal',
      undefined,
      as(supervisor.signed),
    );

    expect(denied.statusCode).toBe(403);
    expect(allowed.json()).toEqual({ scope: 'all' });
    const [row] = await deniedRows(cs.user.id);
    expect(row?.metadata).toMatchObject({
      permission: 'broadcast.send',
      route: '/__tes/kirim-template-massal',
    });
  });
});
