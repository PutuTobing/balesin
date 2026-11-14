/**
 * Manajemen pengguna (ROADMAP Fase 1 butir 6) di atas Postgres + Redis sungguhan: daftar & detail,
 * matriks kelola (Owner/Admin × peran sasaran, diri sendiri, Owner terakhir), ubah peran (sesi
 * dicabut, wajib 2FA saat masuk lagi, undangan terbitannya dibatalkan — R2.2), nonaktifkan/aktifkan,
 * atur ulang 2FA (konfirmasi ulang identitas + email ke sasaran & Owner lain), buka kunci, sesi
 * pengguna lain, batas waktu pendaftaran 2FA 72 jam (R3, dengan jam yang digeser), dan IDOR lintas
 * organisasi.
 */
import { accountTokenDeliveryContext, createSecretBox, Secret } from '@balesin/core';
import { accountTokens, auditLogs, userInvitations, userSessions, users } from '@balesin/db';
import { insertOrganization, insertUser, insertUserSession } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  meResponseSchema,
  teamUserActionResponseSchema,
  teamUserListResponseSchema,
  teamUserResponseSchema,
  securitySummaryResponseSchema,
  activeSessionListResponseSchema,
  invitationIssuedResponseSchema,
  type ErrorEnvelope,
  type InvitableRole,
  type UserRole,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER,
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  freshTotpCode,
  login,
  mailpitSettings,
  startLogin,
  TEST_MASTER_KEY,
  type CallOptions,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

type Response = Awaited<ReturnType<typeof call>>;
const routes = API_ROUTES.team;
const PASSWORD = 'sandi-anggota-tim-uji-01';

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

interface Member extends SignedIn {
  email: string;
  password: string;
  id: string;
}

/** Pengguna baru dengan sesi penuh (peran wajib 2FA: 2FA didaftarkan lewat helper). */
async function member(owner: SignedIn, role: UserRole, name = `Pengguna ${role}`): Promise<Member> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    email,
    name,
    passwordHash: await hasher.hash(PASSWORD),
  });
  const signed = await login(harness.app, { email, password: PASSWORD });
  return { ...signed, email, password: PASSWORD, id: user.id };
}

/** Konfirmasi ulang identitas pelaku: password + kode TOTP saat ini. */
async function confirmation(actor: { email: string }, password: string) {
  return { password, code: await freshTotpCode(actor.email) };
}

const ownerConfirmation = () => confirmation({ email: OWNER.email }, OWNER.password);

function path(template: string, params: Record<string, string>) {
  return apiPath(template, params);
}

async function act(
  actor: SignedIn,
  route: keyof typeof routes,
  userId: string,
  body: Record<string, unknown>,
) {
  const method = route === 'role' ? 'PUT' : 'POST';
  return call(harness.app, method, path(routes[route], { userId }), body, as(actor));
}

async function me(signed: { cookie: string; csrf: string }) {
  return call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(signed));
}

async function userRow(id: string) {
  const [row] = await harness.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error('Pengguna tidak ada');
  return row;
}

async function auditOf(action: string) {
  return harness.db.select().from(auditLogs).where(eq(auditLogs.action, action));
}

async function ruleDenials(actorId: string) {
  const rows = await harness.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, 'auth.access.denied'),
        eq(auditLogs.actorUserId, actorId),
        eq(auditLogs.targetType, 'rule'),
      ),
    );
  return rows.map((row) => row.targetId);
}

async function invitationBy(signed: SignedIn, role: InvitableRole) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.invitations.collection,
    { email: `undangan-${Math.random().toString(36).slice(2, 8)}@majujaya.test`, role },
    as(signed),
  );
  if (response.statusCode !== 201) throw new Error(`Undangan gagal: ${response.body}`);
  return invitationIssuedResponseSchema.parse(response.json());
}

async function invitationRevoked(id: string): Promise<boolean> {
  const [row] = await harness.db.select().from(userInvitations).where(eq(userInvitations.id, id));
  return row?.revokedAt !== null && row?.revokedAt !== undefined;
}

describe('daftar & detail pengguna', () => {
  it('Owner melihat semua pengguna dengan status, 2FA, verifikasi email — tanpa rahasia', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs', 'Budi CS');
    const disabled = await insertUser(harness.db, owner.session.organization.id, {
      role: 'teknisi',
      name: 'Teknisi Lama',
      disabledAt: new Date(),
    });

    const response = await call(harness.app, 'GET', routes.users, undefined, as(owner));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/password|totp|token|hash|argon/i);
    const body = teamUserListResponseSchema.parse(response.json());
    expect(body.manageableRoles).toEqual(['owner', 'admin', 'supervisor', 'cs', 'teknisi']);
    expect(body.users.map((user) => user.name)).toEqual([OWNER.name, 'Budi CS', 'Teknisi Lama']);
    const [self, csView, disabledView] = body.users;
    expect(self).toMatchObject({
      role: 'owner',
      status: 'active',
      isSelf: true,
      canManage: false,
      assignableRoles: [],
      twoFactor: { enabled: true, required: true, enrollmentDueAt: null, enrollmentExpired: false },
    });
    expect(self?.activeSessions).toBeGreaterThanOrEqual(1);
    expect(csView).toMatchObject({
      id: cs.id,
      status: 'active',
      emailVerified: false,
      canManage: true,
      assignableRoles: ['admin', 'supervisor', 'cs', 'teknisi'],
      twoFactor: { enabled: false, required: false },
      activeSessions: 1,
    });
    expect(csView?.lastLoginAt).not.toBeNull();
    expect(disabledView).toMatchObject({ id: disabled.id, status: 'disabled', activeSessions: 0 });

    const detail = await call(
      harness.app,
      'GET',
      path(routes.user, { userId: cs.id }),
      undefined,
      as(owner),
    );
    expect(teamUserResponseSchema.parse(detail.json()).user.id).toBe(cs.id);
  });

  it('Admin melihat Owner di daftar tetapi tidak bisa mengelolanya; pilihan peran tanpa Admin', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const otherAdmin = await member(owner, 'admin');
    const response = await call(harness.app, 'GET', routes.users, undefined, as(admin));
    const body = teamUserListResponseSchema.parse(response.json());
    expect(body.manageableRoles).toEqual(['supervisor', 'cs', 'teknisi']);
    const byId = new Map(body.users.map((user) => [user.id, user]));
    expect(byId.get(owner.session.user.id)).toMatchObject({
      canManage: false,
      assignableRoles: [],
    });
    expect(byId.get(otherAdmin.id)).toMatchObject({ canManage: false });
    const supervisor = await member(owner, 'supervisor');
    const again = teamUserListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.users, undefined, as(admin))).json(),
    );
    expect(again.users.find((user) => user.id === supervisor.id)).toMatchObject({
      canManage: true,
      assignableRoles: ['supervisor', 'cs', 'teknisi'],
    });
  });

  it('pengguna organisasi lain tidak ditemukan (404) untuk lihat, kelola, maupun sesi', async () => {
    const owner = await completeSetup(harness.app);
    const other = await insertOrganization(harness.db);
    const stranger = await insertUser(harness.db, other.id, { role: 'cs' });
    await insertUserSession(harness.db, stranger);

    for (const response of [
      await call(
        harness.app,
        'GET',
        path(routes.user, { userId: stranger.id }),
        undefined,
        as(owner),
      ),
      await call(
        harness.app,
        'GET',
        path(routes.sessions, { userId: stranger.id }),
        undefined,
        as(owner),
      ),
      await act(owner, 'disable', stranger.id, await ownerConfirmation()),
      await act(owner, 'role', stranger.id, { role: 'admin', ...(await ownerConfirmation()) }),
    ]) {
      expect(response.statusCode).toBe(404);
    }
    const list = teamUserListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.users, undefined, as(owner))).json(),
    );
    expect(list.users.map((user) => user.id)).not.toContain(stranger.id);
    expect((await userRow(stranger.id)).disabledAt).toBeNull();
  });
});

describe('matriks kelola', () => {
  it('Admin tidak bisa mengelola Owner atau Admin lain: 403 dengan pesan khusus + audit aturan', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const otherAdmin = await member(owner, 'admin');
    const adminConfirm = () => confirmation(admin, PASSWORD);

    for (const target of [owner.session.user.id, otherAdmin.id]) {
      for (const response of [
        await act(admin, 'disable', target, await adminConfirm()),
        await act(admin, 'role', target, { role: 'cs', ...(await adminConfirm()) }),
        await act(admin, 'resetTwoFactor', target, await adminConfirm()),
        await act(admin, 'unlock', target, await adminConfirm()),
        await call(
          harness.app,
          'GET',
          path(routes.sessions, { userId: target }),
          undefined,
          as(admin),
        ),
      ]) {
        expect(response.statusCode).toBe(403);
        expect(errorOf(response).message).toContain('Admin hanya bisa mengelola Supervisor');
      }
    }
    expect((await userRow(owner.session.user.id)).disabledAt).toBeNull();
    expect((await userRow(otherAdmin.id)).role).toBe('admin');
    expect(await ruleDenials(admin.id)).toContain('team.manage.role');
    // Sesi Owner tetap berlaku.
    expect((await me(owner)).statusCode).toBe(200);
  });

  it('Admin tidak bisa memberi peran Admin; tidak ada yang bisa menjadikan orang Owner', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const cs = await member(owner, 'cs');

    const promote = await act(admin, 'role', cs.id, {
      role: 'admin',
      ...(await confirmation(admin, PASSWORD)),
    });
    expect(promote.statusCode).toBe(403);
    expect(errorOf(promote).message).toContain('Admin hanya bisa memberi peran');
    expect(await ruleDenials(admin.id)).toContain('team.manage.assign_role');

    const toOwner = await act(owner, 'role', cs.id, {
      role: 'owner',
      ...(await ownerConfirmation()),
    });
    expect(toOwner.statusCode).toBe(400);
    expect(errorOf(toOwner).details?.[0]?.field).toBe('role');
    expect((await userRow(cs.id)).role).toBe('cs');
  });

  it('diri sendiri tidak bisa dikelola lewat halaman Tim (ubah peran, nonaktifkan, sesi)', async () => {
    const owner = await completeSetup(harness.app);
    const selfId = owner.session.user.id;
    for (const response of [
      await act(owner, 'role', selfId, { role: 'admin', ...(await ownerConfirmation()) }),
      await act(owner, 'disable', selfId, await ownerConfirmation()),
      await act(owner, 'resetTwoFactor', selfId, await ownerConfirmation()),
      await call(
        harness.app,
        'GET',
        path(routes.sessions, { userId: selfId }),
        undefined,
        as(owner),
      ),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).message).toContain('Akunmu sendiri');
    }
    const row = await userRow(selfId);
    expect(row.role).toBe('owner');
    expect(row.disabledAt).toBeNull();
    expect(await ruleDenials(selfId)).toContain('team.manage.self');
  });

  it('Owner bisa menurunkan Owner lain; organisasi tetap punya Owner aktif (serentak pun)', async () => {
    const owner = await completeSetup(harness.app);
    const second = await member(owner, 'owner', 'Owner Kedua');

    // Saling menurunkan BERSAMAAN: paling banyak satu yang berhasil.
    const [a, b] = await Promise.all([
      act(owner, 'role', second.id, { role: 'admin', ...(await ownerConfirmation()) }),
      act(second, 'role', owner.session.user.id, {
        role: 'admin',
        ...(await confirmation(second, PASSWORD)),
      }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(200);
    // Yang kalah: jawaban terkendali (403 peran baru / 409), bukan 500 deadlock (review butir 6 R2).
    expect([403, 409]).toContain(statuses[1]);
    const owners = await harness.db
      .select()
      .from(users)
      .where(and(eq(users.role, 'owner'), sql`${users.disabledAt} is null`));
    expect(owners).toHaveLength(1);
  });
});

describe('ubah peran', () => {
  it('CS → Supervisor: semua sesi dicabut, masuk lagi wajib daftar 2FA dengan batas 72 jam', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs');
    const extra = await login(harness.app, { email: cs.email, password: PASSWORD });

    const response = await act(owner, 'role', cs.id, {
      role: 'supervisor',
      ...(await ownerConfirmation()),
    });
    expect(response.statusCode).toBe(200);
    const body = teamUserActionResponseSchema.parse(response.json());
    expect(body.revokedSessions).toBe(2);
    expect(body.user).toMatchObject({
      role: 'supervisor',
      activeSessions: 0,
      twoFactor: { enabled: false, required: true, enrollmentExpired: false },
    });
    const dueAt = Date.parse(body.user.twoFactor.enrollmentDueAt ?? '');
    expect(dueAt - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect(dueAt - Date.now()).toBeLessThan(73 * 3600_000);

    // Sesi lama (cookie curian) tidak bisa dipakai lagi — termasuk untuk mendaftar 2FA.
    expect((await me(cs)).statusCode).toBe(401);
    expect((await me(extra)).statusCode).toBe(401);
    const again = await startLogin(harness.app, { email: cs.email, password: PASSWORD });
    expect(again.body.status).toBe('two_factor_enrollment_required');

    const [audit] = await auditOf('user.role_changed');
    expect(audit).toMatchObject({ actorUserId: owner.session.user.id, targetId: cs.id });
    expect(audit?.metadata).toMatchObject({
      from: 'cs',
      to: 'supervisor',
      revokedSessions: 2,
      twoFactorEnrollmentRequired: true,
      confirmedWith: 'totp',
    });
  });

  it('peran sama → 409; pengguna yang diturunkan kehilangan izin di sesi baru', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const same = await act(owner, 'role', admin.id, {
      role: 'admin',
      ...(await ownerConfirmation()),
    });
    expect(same.statusCode).toBe(409);

    const down = await act(owner, 'role', admin.id, { role: 'cs', ...(await ownerConfirmation()) });
    expect(down.statusCode).toBe(200);
    expect(teamUserActionResponseSchema.parse(down.json()).user.twoFactor).toMatchObject({
      enabled: true,
      required: false,
      enrollmentDueAt: null,
    });
    const relogin = await login(harness.app, { email: admin.email, password: PASSWORD });
    expect(relogin.session.permissions).not.toContain('team.manage');
    const denied = await call(harness.app, 'GET', routes.users, undefined, as(relogin));
    expect(denied.statusCode).toBe(403);
  });

  it('R2.2: undangan terbitan pengguna yang tak berhak lagi dibatalkan; yang masih berhak tetap', async () => {
    const owner = await completeSetup(harness.app);
    const second = await member(owner, 'owner', 'Owner Kedua');
    const adminInvite = await invitationBy(second, 'admin');
    const csInvite = await invitationBy(second, 'cs');

    const toAdmin = await act(owner, 'role', second.id, {
      role: 'admin',
      ...(await ownerConfirmation()),
    });
    expect(teamUserActionResponseSchema.parse(toAdmin.json()).revokedInvitations).toBe(1);
    expect(await invitationRevoked(adminInvite.invitation.id)).toBe(true);
    expect(await invitationRevoked(csInvite.invitation.id)).toBe(false);

    const toCs = await act(owner, 'role', second.id, {
      role: 'cs',
      ...(await ownerConfirmation()),
    });
    expect(teamUserActionResponseSchema.parse(toCs.json()).revokedInvitations).toBe(1);
    expect(await invitationRevoked(csInvite.invitation.id)).toBe(true);
    const revokedAudit = (await auditOf('user.invitation.revoked')).map((row) => row.metadata);
    expect(revokedAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'issuer_role_changed', role: 'admin' }),
        expect.objectContaining({ reason: 'issuer_role_changed', role: 'cs' }),
      ]),
    );
  });
});

describe('konfirmasi ulang identitas pelaku', () => {
  it('tanpa kode / password salah / kode salah → 400, tidak ada perubahan', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs');

    const noCode = await act(owner, 'disable', cs.id, { password: OWNER.password });
    expect(noCode.statusCode).toBe(400);
    expect(errorOf(noCode).details?.[0]?.field).toBe('code');

    const wrongPassword = await act(owner, 'disable', cs.id, {
      password: 'bukan-password-owner-ini',
      code: await freshTotpCode(OWNER.email),
    });
    expect(wrongPassword.statusCode).toBe(400);
    expect(errorOf(wrongPassword).details?.[0]?.field).toBe('password');

    const wrongCode = await act(owner, 'disable', cs.id, {
      password: OWNER.password,
      code: '000000',
    });
    expect(wrongCode.statusCode).toBe(400);
    expect(errorOf(wrongCode).details?.[0]?.field).toBe('code');

    const empty = await act(owner, 'resetTwoFactor', cs.id, {});
    expect(empty.statusCode).toBe(400);
    expect((await userRow(cs.id)).disabledAt).toBeNull();
    expect((await me(cs)).statusCode).toBe(200);
  });
});

describe('nonaktifkan & aktifkan kembali', () => {
  it('nonaktifkan: sesi, undangan terbitannya, dan tautan akun dicabut; masuk ditolak; aktifkan memulihkan', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const invitation = await invitationBy(admin, 'cs');
    await harness.db.insert(accountTokens).values({
      organizationId: owner.session.organization.id,
      userId: admin.id,
      purpose: 'password_reset',
      tokenHash: `hash-uji-${Math.random()}`,
      email: admin.email,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    const response = await act(owner, 'disable', admin.id, await ownerConfirmation());
    expect(response.statusCode).toBe(200);
    const body = teamUserActionResponseSchema.parse(response.json());
    expect(body).toMatchObject({ revokedSessions: 1, revokedInvitations: 1 });
    expect(body.user.status).toBe('disabled');
    expect((await me(admin)).statusCode).toBe(401);
    expect(await invitationRevoked(invitation.invitation.id)).toBe(true);
    const liveTokens = await harness.db
      .select()
      .from(accountTokens)
      .where(and(eq(accountTokens.userId, admin.id), sql`${accountTokens.revokedAt} is null`));
    expect(liveTokens).toHaveLength(0);
    const blocked = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: admin.email,
      password: PASSWORD,
    });
    expect(blocked.statusCode).toBe(401);
    expect(errorOf(blocked).code).toBe('INVALID_CREDENTIALS');
    expect((await act(owner, 'disable', admin.id, await ownerConfirmation())).statusCode).toBe(409);

    const enabled = await act(owner, 'enable', admin.id, await ownerConfirmation());
    expect(enabled.statusCode).toBe(200);
    expect(teamUserActionResponseSchema.parse(enabled.json()).user.status).toBe('active');
    const back = await login(harness.app, { email: admin.email, password: PASSWORD });
    expect(back.session.user.role).toBe('admin');
    expect((await auditOf('user.disabled'))[0]?.metadata).toMatchObject({
      revokedSessions: 1,
      revokedInvitations: 1,
      revokedAccountLinks: 1,
    });
    expect(await auditOf('user.enabled')).toHaveLength(1);
  });

  it('Admin menonaktifkan CS: berhasil; Admin menonaktifkan Owner: 403', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const cs = await member(owner, 'cs');
    const ok = await act(admin, 'disable', cs.id, await confirmation(admin, PASSWORD));
    expect(ok.statusCode).toBe(200);
    const denied = await act(
      admin,
      'disable',
      owner.session.user.id,
      await confirmation(admin, PASSWORD),
    );
    expect(denied.statusCode).toBe(403);
  });

  it('pelaku yang baru saja diturunkan tidak bisa menyelesaikan aksi dengan sesi lama', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const cs = await member(owner, 'cs');
    // Peran Admin diturunkan langsung di database (sesi Admin belum sempat dicabut).
    await harness.db.update(users).set({ role: 'supervisor' }).where(eq(users.id, admin.id));
    const response = await act(admin, 'disable', cs.id, await confirmation(admin, PASSWORD));
    expect(response.statusCode).toBe(403);
    expect((await userRow(cs.id)).disabledAt).toBeNull();
  });
});

describe('atur ulang 2FA pengguna lain', () => {
  it('Owner mengatur ulang 2FA Admin: autentikator & kode cadangan dibuang, sesi dicabut, email ke sasaran dan Owner lain', async () => {
    const owner = await completeSetup(harness.app);
    const secondOwner = await member(owner, 'owner', 'Owner Kedua');
    const admin = await member(owner, 'admin', 'Admin Rina');
    harness.securityNotices.length = 0;
    harness.adminNotices.length = 0;

    const response = await act(owner, 'resetTwoFactor', admin.id, await ownerConfirmation());
    expect(response.statusCode).toBe(200);
    const body = teamUserActionResponseSchema.parse(response.json());
    expect(body.revokedSessions).toBe(1);
    expect(body.user.twoFactor).toMatchObject({ enabled: false, required: true });
    expect(body.user.twoFactor.enrollmentDueAt).not.toBeNull();

    const row = await userRow(admin.id);
    expect(row.totpSecretEncrypted).toBeNull();
    expect(row.totpEnabledAt).toBeNull();
    const codes = await harness.db.execute(
      sql`select count(*)::int as n from user_backup_codes where user_id = ${admin.id}`,
    );
    expect(codes.rows[0]).toMatchObject({ n: 0 });
    expect((await me(admin)).statusCode).toBe(401);
    const relogin = await startLogin(harness.app, { email: admin.email, password: PASSWORD });
    expect(relogin.body.status).toBe('two_factor_enrollment_required');

    const [audit] = await auditOf('user.2fa.reset');
    expect(audit).toMatchObject({ actorUserId: owner.session.user.id, targetId: admin.id });
    expect(harness.securityNotices).toEqual([
      expect.objectContaining({
        userId: admin.id,
        event: 'two_factor_reset',
        actorUserId: owner.session.user.id,
        auditLogId: audit?.id,
      }),
    ]);
    // Hanya Owner LAIN (bukan pelaku, bukan Admin).
    expect(harness.adminNotices.filter((notice) => notice.event === 'two_factor_reset')).toEqual([
      expect.objectContaining({
        recipientUserId: secondOwner.id,
        subjectUserId: admin.id,
        event: 'two_factor_reset',
        actorUserId: owner.session.user.id,
      }),
    ]);
  });

  it('Admin mengatur ulang 2FA Supervisor; bukan Owner; sasaran tanpa 2FA → 409', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const supervisor = await member(owner, 'supervisor');
    const cs = await member(owner, 'cs');

    const ok = await act(
      admin,
      'resetTwoFactor',
      supervisor.id,
      await confirmation(admin, PASSWORD),
    );
    expect(ok.statusCode).toBe(200);
    const ownerReset = await act(
      admin,
      'resetTwoFactor',
      owner.session.user.id,
      await confirmation(admin, PASSWORD),
    );
    expect(ownerReset.statusCode).toBe(403);
    expect((await userRow(owner.session.user.id)).totpEnabledAt).not.toBeNull();
    const noTwoFactor = await act(
      admin,
      'resetTwoFactor',
      cs.id,
      await confirmation(admin, PASSWORD),
    );
    expect(noTwoFactor.statusCode).toBe(409);
  });
});

describe('R3: batas waktu pendaftaran 2FA 72 jam (jam digeser)', () => {
  /** Admin hasil "undangan" yang belum mendaftar 2FA, batas waktunya `hoursAgo` jam lalu. */
  async function pendingAdmin(owner: SignedIn, dueHoursFromNow: number) {
    const email = `admin-r3-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
    const user = await insertUser(harness.db, owner.session.organization.id, {
      role: 'admin',
      email,
      name: 'Admin Belum Daftar',
      passwordHash: await hasher.hash(PASSWORD),
      createdAt: new Date(Date.now() - (72 - dueHoursFromNow) * 3600_000),
      twoFactorEnrollmentDueAt: new Date(Date.now() + dueHoursFromNow * 3600_000),
    });
    return { ...user, email };
  }

  it('lewat 72 jam: masuk ditolak 403 TWO_FACTOR_ENROLLMENT_EXPIRED (+ audit); Owner membuka lagi → bisa mendaftar', async () => {
    const owner = await completeSetup(harness.app);
    const fresh = await pendingAdmin(owner, 1);
    expect(
      (await startLogin(harness.app, { email: fresh.email, password: PASSWORD })).body.status,
    ).toBe('two_factor_enrollment_required');

    const expired = await pendingAdmin(owner, -1);
    const blocked = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: expired.email,
      password: PASSWORD,
    });
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked).code).toBe('TWO_FACTOR_ENROLLMENT_EXPIRED');
    expect(blocked.headers['set-cookie']).toBeUndefined();
    expect((await auditOf('auth.2fa.enrollment_expired'))[0]).toMatchObject({
      targetId: expired.id,
      metadata: { usage: 'login' },
    });
    // Password salah tetap jawaban biasa (tidak membuka keadaan akun).
    const wrong = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: expired.email,
      password: 'password-salah-sekali-ini',
    });
    expect(errorOf(wrong).code).toBe('INVALID_CREDENTIALS');

    const list = teamUserListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.users, undefined, as(owner))).json(),
    );
    expect(list.users.find((user) => user.id === expired.id)?.twoFactor.enrollmentExpired).toBe(
      true,
    );

    const reopened = await act(
      owner,
      'reopenTwoFactorEnrollment',
      expired.id,
      await ownerConfirmation(),
    );
    expect(reopened.statusCode).toBe(200);
    expect(
      teamUserActionResponseSchema.parse(reopened.json()).user.twoFactor.enrollmentExpired,
    ).toBe(false);
    const now = await login(harness.app, { email: expired.email, password: PASSWORD });
    expect(now.session.user.role).toBe('admin');
    expect((await userRow(expired.id)).twoFactorEnrollmentDueAt).toBeNull();
    expect(await auditOf('user.2fa.enrollment_reopened')).toHaveLength(1);
  });

  it('sesi pendaftaran yang terbit sebelum batas tidak bisa memulai pendaftaran setelah batas lewat', async () => {
    const owner = await completeSetup(harness.app);
    const pending = await pendingAdmin(owner, 1);
    const { response, body } = await startLogin(harness.app, {
      email: pending.email,
      password: PASSWORD,
    });
    if (body.status !== 'two_factor_enrollment_required') throw new Error('bukan sesi terbatas');
    const cookie = (response.headers['set-cookie'] as string[])
      .find((value) => value.startsWith('balesin_session='))
      ?.split(';')[0];
    await harness.db
      .update(users)
      .set({ twoFactorEnrollmentDueAt: new Date(Date.now() - 60_000) })
      .where(eq(users.id, pending.id));
    const start = await call(
      harness.app,
      'POST',
      API_ROUTES.twoFactor.enroll,
      {},
      {
        cookie: cookie ?? '',
        csrf: body.csrfToken,
      },
    );
    expect(start.statusCode).toBe(403);
    expect(errorOf(start).code).toBe('TWO_FACTOR_ENROLLMENT_EXPIRED');
  });

  it('Owner hasil setup yang belum sempat mendaftar tidak pernah terkunci (tanpa batas waktu)', async () => {
    await completeSetupWithoutTwoFactor(harness.app);
    // Seolah setup selesai 10 hari lalu.
    await harness.db
      .update(users)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 3600_000) })
      .where(eq(users.email, OWNER.email));
    expect(
      (await userRow((await harness.db.select().from(users))[0]!.id)).twoFactorEnrollmentDueAt,
    ).toBeNull();
    const again = await startLogin(harness.app, OWNER);
    expect(again.body.status).toBe('two_factor_enrollment_required');
  });

  it('batas Owner hanya berlaku bila ada Owner lain ber-2FA yang bisa membukanya', async () => {
    const owner = await completeSetup(harness.app);
    const second = await insertUser(harness.db, owner.session.organization.id, {
      role: 'owner',
      email: 'owner-kedua@majujaya.test',
      name: 'Owner Kedua',
      passwordHash: await hasher.hash(PASSWORD),
      twoFactorEnrollmentDueAt: new Date(Date.now() - 3600_000),
    });
    const blocked = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: second.email,
      password: PASSWORD,
    });
    expect(errorOf(blocked).code).toBe('TWO_FACTOR_ENROLLMENT_EXPIRED');
    // Owner pertama dinonaktifkan → tidak ada yang bisa membukakan → Owner kedua tidak dikunci.
    await harness.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, owner.session.user.id));
    const allowed = await startLogin(harness.app, { email: second.email, password: PASSWORD });
    expect(allowed.body.status).toBe('two_factor_enrollment_required');
  });

  it('undangan yang diterima memberi batas 72 jam untuk peran wajib, tidak untuk CS', async () => {
    const owner = await completeSetup(harness.app);
    for (const [role, expectDue] of [
      ['supervisor', true],
      ['cs', false],
    ] as const) {
      const issued = await invitationBy(owner, role);
      const token = new URL(issued.link ?? '').hash.replace('#token=', '');
      const accepted = await call(harness.app, 'POST', API_ROUTES.invitations.accept, {
        token,
        name: `Penerima ${role}`,
        password: 'gerimis-pagi-di-pelabuhan',
      });
      expect(accepted.statusCode).toBe(201);
      const session = meResponseSchema.parse(accepted.json());
      const due = (await userRow(session.user.id)).twoFactorEnrollmentDueAt;
      if (expectDue) {
        expect(due?.getTime() ?? 0).toBeGreaterThan(Date.now() + 71 * 3600_000);
      } else {
        expect(due).toBeNull();
      }
    }
  });

  it('atur ulang password akun peran wajib yang belum daftar 2FA → Owner/Admin diberi tahu', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings(),
      as(owner),
    );
    expect(saved.statusCode).toBe(200);
    const pending = await pendingAdmin(owner, 10);
    harness.adminNotices.length = 0;

    const requested = await call(harness.app, 'POST', API_ROUTES.passwordReset.request, {
      email: pending.email,
    });
    expect(requested.statusCode).toBe(202);
    await harness.app.backgroundTasks.drain();
    const [tokenRow] = await harness.db
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.userId, pending.id));
    if (!tokenRow?.deliveryTokenEncrypted) throw new Error('Tidak ada token');
    const token = createSecretBox(new Secret(TEST_MASTER_KEY)).decrypt(
      tokenRow.deliveryTokenEncrypted,
      accountTokenDeliveryContext(tokenRow.organizationId, tokenRow.id),
    );
    const completed = await call(harness.app, 'POST', API_ROUTES.passwordReset.complete, {
      token,
      password: 'layang-layang-senja-merah',
    });
    expect(completed.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const notices = harness.adminNotices.filter(
      (notice) => notice.event === 'password_reset_without_two_factor',
    );
    expect(notices.map((notice) => notice.recipientUserId).sort()).toEqual(
      [owner.session.user.id, admin.id].sort(),
    );
    expect(notices.every((notice) => notice.subjectUserId === pending.id)).toBe(true);
    const [audit] = await auditOf('auth.password_reset.completed');
    expect(audit?.metadata).toMatchObject({ twoFactorEnrollmentPending: true });
  });

  it('buka lagi: hanya untuk peran wajib yang belum mendaftar', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs');
    const admin = await member(owner, 'admin');
    expect(
      (await act(owner, 'reopenTwoFactorEnrollment', cs.id, await ownerConfirmation())).statusCode,
    ).toBe(409);
    expect(
      (await act(owner, 'reopenTwoFactorEnrollment', admin.id, await ownerConfirmation()))
        .statusCode,
    ).toBe(409);
  });
});

describe('buka kunci', () => {
  it('kunci asal jaringan karena 5 password salah: tampil "terkunci", Admin membuka, pengguna bisa masuk lagi', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const cs = await member(owner, 'cs');
    const ip = '198.51.100.23';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(
        harness.app,
        'POST',
        API_ROUTES.auth.login,
        { email: cs.email, password: 'tebakan-salah-berulang' },
        { ip },
      );
    }
    const locked = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: PASSWORD },
      { ip },
    );
    expect(locked.statusCode).toBe(429);

    const listed = teamUserListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.users, undefined, as(admin))).json(),
    );
    const csView = listed.users.find((user) => user.id === cs.id);
    expect(csView?.status).toBe('locked');
    expect(Date.parse(csView?.lockedUntil ?? '')).toBeGreaterThan(Date.now());
    // Audit kunci tidak memuat email/hash untuk akun ini selain rujukan ember.
    const [lockAudit] = await auditOf('auth.account.locked');
    expect(typeof lockAudit?.metadata.lockRef).toBe('string');

    const unlocked = await act(admin, 'unlock', cs.id, await confirmation(admin, PASSWORD));
    expect(unlocked.statusCode).toBe(200);
    expect(teamUserActionResponseSchema.parse(unlocked.json()).user.status).toBe('active');
    const back = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: cs.email, password: PASSWORD },
      { ip },
    );
    expect(back.statusCode).toBe(200);
    expect((await auditOf('user.unlocked'))[0]?.metadata).toMatchObject({
      cleared: 'akun-asal-terkunci',
    });
  });

  it('kunci langkah kedua (5 kode 2FA salah) dibuka Owner', async () => {
    const owner = await completeSetup(harness.app);
    const supervisor = await member(owner, 'supervisor');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { body } = await startLogin(harness.app, {
        email: supervisor.email,
        password: PASSWORD,
      });
      if (body.status !== 'two_factor_required') break;
      await call(harness.app, 'POST', API_ROUTES.twoFactor.verify, {
        challengeToken: body.challengeToken,
        code: '000000',
      });
    }
    const stillLocked = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: supervisor.email,
      password: PASSWORD,
    });
    expect(stillLocked.statusCode).toBe(429);
    const view = teamUserResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          path(routes.user, { userId: supervisor.id }),
          undefined,
          as(owner),
        )
      ).json(),
    );
    expect(view.user.status).toBe('locked');

    expect((await act(owner, 'unlock', supervisor.id, await ownerConfirmation())).statusCode).toBe(
      200,
    );
    const signed = await login(harness.app, { email: supervisor.email, password: PASSWORD });
    expect(signed.session.user.id).toBe(supervisor.id);
  });
});

describe('perubahan tim oleh selain Owner (review butir 6 Info 6)', () => {
  it('Admin mengubah peran / menonaktifkan → email ke Owner + kejadian warning; oleh Owner → info tanpa email', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin', 'Admin Rudi');
    const cs = await member(owner, 'cs', 'Budi CS');
    const teknisi = await member(owner, 'teknisi', 'Tono Teknisi');
    harness.adminNotices.length = 0;

    expect(
      (
        await act(admin, 'role', cs.id, {
          role: 'supervisor',
          ...(await confirmation(admin, PASSWORD)),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await act(admin, 'disable', teknisi.id, await confirmation(admin, PASSWORD))).statusCode,
    ).toBe(200);
    const byOwner = await member(owner, 'cs', 'CS Lain');
    expect((await act(owner, 'disable', byOwner.id, await ownerConfirmation())).statusCode).toBe(
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const notices = harness.adminNotices.filter(
      (notice) => notice.event === 'role_changed' || notice.event === 'user_disabled',
    );
    expect(notices).toEqual([
      expect.objectContaining({
        event: 'role_changed',
        recipientUserId: owner.session.user.id,
        subjectUserId: cs.id,
        actorUserId: admin.id,
      }),
      expect.objectContaining({
        event: 'user_disabled',
        recipientUserId: owner.session.user.id,
        subjectUserId: teknisi.id,
        actorUserId: admin.id,
      }),
    ]);

    const summary = securitySummaryResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, as(owner))
      ).json(),
    );
    const severityOf = (subjectId: string) =>
      summary.events.find((event) => event.subject?.id === subjectId)?.severity;
    expect(severityOf(cs.id)).toBe('warning');
    expect(severityOf(teknisi.id)).toBe('warning');
    expect(severityOf(byOwner.id)).toBe('info');
    expect(summary.latestWarningAt).not.toBeNull();
  });
});

describe('hitungan kode 2FA salah 24 jam (review butir 6 Info 2)', () => {
  it('20 kode salah dari perangkat tak dikenal: tetap terkunci walau dibuka Owner; atur ulang 2FA melepasnya', async () => {
    const owner = await completeSetup(harness.app);
    const supervisor = await member(owner, 'supervisor');
    let failures = 0;
    for (let round = 0; round < 60 && failures < 20; round += 1) {
      const started = await call(harness.app, 'POST', API_ROUTES.auth.login, {
        email: supervisor.email,
        password: PASSWORD,
      });
      if (started.statusCode === 429) {
        expect(
          (await act(owner, 'unlock', supervisor.id, await ownerConfirmation())).statusCode,
        ).toBe(200);
        continue;
      }
      const { challengeToken } = started.json<{ challengeToken: string }>();
      const verified = await call(harness.app, 'POST', API_ROUTES.twoFactor.verify, {
        challengeToken,
        code: '000000',
      });
      expect([400, 429]).toContain(verified.statusCode);
      failures += 1;
    }
    expect(failures).toBe(20);

    // Buka kunci oleh Owner tidak melepas kunci harian.
    expect((await act(owner, 'unlock', supervisor.id, await ownerConfirmation())).statusCode).toBe(
      200,
    );
    const blocked = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email: supervisor.email,
      password: PASSWORD,
    });
    expect(blocked.statusCode).toBe(429);
    const view = teamUserResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          path(routes.user, { userId: supervisor.id }),
          undefined,
          as(owner),
        )
      ).json(),
    );
    expect(view.user.status).toBe('locked');
    expect(Date.parse(view.user.lockedUntil ?? '')).toBeGreaterThan(Date.now() + 20 * 3600_000);
    const dailyAudit = (await auditOf('auth.account.locked')).find(
      (row) => row.metadata.daily === true,
    );
    expect(dailyAudit?.targetId).toBe(supervisor.id);

    // Atur ulang 2FA (autentikator baru) melepasnya: masuk → wajib daftar ulang.
    expect(
      (await act(owner, 'resetTwoFactor', supervisor.id, await ownerConfirmation())).statusCode,
    ).toBe(200);
    const after = await startLogin(harness.app, { email: supervisor.email, password: PASSWORD });
    expect(after.body.status).toBe('two_factor_enrollment_required');
  }, 60_000);
});

describe('sesi pengguna lain', () => {
  it('Owner melihat sesi CS (IP tersamar), mengeluarkan satu, lalu semua dengan konfirmasi', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs');
    const second = await login(
      harness.app,
      { email: cs.email, password: PASSWORD },
      {
        ip: '203.0.113.77',
        headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile' },
      },
    );

    const listed = activeSessionListResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          path(routes.sessions, { userId: cs.id }),
          undefined,
          as(owner),
        )
      ).json(),
    );
    expect(listed.sessions).toHaveLength(2);
    const android = listed.sessions.find((session) => session.device === 'Chrome di Android');
    expect(android).toMatchObject({ ipAddress: '203.0.113.*', current: false, limited: false });
    expect(JSON.stringify(listed)).not.toContain('203.0.113.77');

    const revoked = await call(
      harness.app,
      'DELETE',
      path(routes.revokeSession, { userId: cs.id, sessionId: android?.id ?? '' }),
      undefined,
      as(owner),
    );
    expect(revoked.statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(cs)).statusCode).toBe(200);

    const noConfirm = await call(
      harness.app,
      'POST',
      path(routes.revokeAllSessions, { userId: cs.id }),
      { password: OWNER.password },
      as(owner),
    );
    expect(noConfirm.statusCode).toBe(400);
    const all = await call(
      harness.app,
      'POST',
      path(routes.revokeAllSessions, { userId: cs.id }),
      await ownerConfirmation(),
      as(owner),
    );
    expect(all.json()).toEqual({ revokedSessions: 1 });
    expect((await me(cs)).statusCode).toBe(401);
    expect((await auditOf('auth.sessions.revoked_all'))[0]?.metadata).toMatchObject({
      by: 'administrator',
      revokedSessions: 1,
    });
  });

  it('sesi milik pengguna lain lewat alamat pengguna yang salah → 404 (sesi tetap hidup)', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await member(owner, 'cs');
    const teknisi = await member(owner, 'teknisi');
    const [csSession] = await harness.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, cs.id));
    const response = await call(
      harness.app,
      'DELETE',
      path(routes.revokeSession, { userId: teknisi.id, sessionId: csSession?.id ?? '' }),
      undefined,
      as(owner),
    );
    expect(response.statusCode).toBe(404);
    expect((await me(cs)).statusCode).toBe(200);
  });
});
