/**
 * Undangan (ROADMAP Fase 1 butir 4) di atas Postgres + Redis sungguhan: matriks peran, token
 * (hash saja, sekali pakai, 72 jam, terikat email, kirim ulang membatalkan yang lama), tanpa SMTP
 * (tautan disalin sekali + audit), penerimaan (peran dari undangan, kebijakan password, peran wajib
 * 2FA → sesi terbatas), batas laju, dan penyalahgunaan.
 */
import {
  createSecretBox,
  generateTotp,
  invitationDeliveryContext,
  Secret,
  sha256Hex,
} from '@balesin/core';
import { auditLogs, userInvitations, userSessions, users, type UserInvitation } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  inspectInvitationResponseSchema,
  invitationIssuedResponseSchema,
  invitationListResponseSchema,
  meResponseSchema,
  readTokenFromFragment,
  startTwoFactorEnrollmentResponseSchema,
  type ErrorEnvelope,
  type InvitableRole,
  type UserRole,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  deviceCookieOf,
  login,
  mailpitSettings,
  sessionCookieOf,
  TEST_MASTER_KEY,
  type CallOptions,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';
import { revokeInvitationsIssuedBy } from './invitations.repo';

let harness: IntegrationHarness;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

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
const routes = API_ROUTES.invitations;
const STRONG_PASSWORD = 'gerimis-pagi-di-pelabuhan';

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

function invite(signed: SignedIn, email: string, role: InvitableRole, options: CallOptions = {}) {
  return call(
    harness.app,
    'POST',
    routes.collection,
    { email, role },
    { ...as(signed), ...options },
  );
}

async function invited(signed: SignedIn, email: string, role: InvitableRole) {
  const response = await invite(signed, email, role);
  if (response.statusCode !== 201) throw new Error(`Undangan gagal: ${response.body}`);
  return invitationIssuedResponseSchema.parse(response.json());
}

/** Token mentah: dari tautan (tanpa SMTP), atau dibuka dari salinan untuk worker (dengan SMTP). */
async function tokenOf(invitationId: string): Promise<string> {
  const [row] = await harness.db
    .select()
    .from(userInvitations)
    .where(eq(userInvitations.id, invitationId));
  if (!row?.deliveryTokenEncrypted) throw new Error('Tidak ada salinan token');
  return box.decrypt(
    row.deliveryTokenEncrypted,
    invitationDeliveryContext(row.organizationId, row.id, row.sendCount),
  );
}

function tokenFromLink(link: string | null): string {
  if (!link) throw new Error('Tidak ada tautan');
  const token = readTokenFromFragment(new URL(link).hash);
  if (!token) throw new Error('Tautan tanpa token');
  return token;
}

const inspect = (token: string, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.inspect, { token }, options);
const accept = (body: Record<string, unknown>, options: CallOptions = {}) =>
  call(harness.app, 'POST', routes.accept, body, options);

async function invitationRow(id: string): Promise<UserInvitation> {
  const [row] = await harness.db.select().from(userInvitations).where(eq(userInvitations.id, id));
  if (!row) throw new Error('Undangan tidak ada');
  return row;
}

async function auditOf(action: string) {
  return harness.db.select().from(auditLogs).where(eq(auditLogs.action, action));
}

async function configureEmail(owner: SignedIn) {
  const saved = await call(
    harness.app,
    'PUT',
    API_ROUTES.settings.email,
    mailpitSettings(),
    as(owner),
  );
  if (saved.statusCode !== 200) throw new Error(`Simpan email gagal: ${saved.body}`);
}

/** Admin dengan sesi penuh (2FA didaftarkan lewat helper). */
async function adminSession(owner: SignedIn): Promise<SignedIn> {
  const password = 'sandi-admin-undangan-01';
  const admin = await insertUser(harness.db, owner.session.organization.id, {
    role: 'admin',
    email: `admin-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: 'Admin Tes',
    passwordHash: await hasher.hash(password),
  });
  return login(harness.app, { email: admin.email, password });
}

async function sessionFor(owner: SignedIn, role: UserRole): Promise<SignedIn> {
  const password = `sandi-${role}-undangan-01`;
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
  });
  return login(harness.app, { email: user.email, password });
}

describe('membuat undangan tanpa email pengirim (tautan disalin)', () => {
  it('Owner mengundang CS: tautan dari APP_URL ditampilkan sekali, hanya hash yang tersimpan, dicatat audit', async () => {
    const owner = await completeSetup(harness.app);
    const response = await invite(owner, '  Budi.CS@MajuJaya.test ', 'cs', {
      headers: { host: 'jahat.example', 'x-forwarded-host': 'jahat.example' },
    });

    expect(response.statusCode).toBe(201);
    const body = invitationIssuedResponseSchema.parse(response.json());
    expect(body.invitation).toMatchObject({
      email: 'budi.cs@majujaya.test',
      role: 'cs',
      status: 'pending',
      sendCount: 1,
      deliveryStatus: 'link',
      canManage: true,
      invitedBy: { id: owner.session.user.id, name: owner.session.user.name },
    });
    // Tautan SELALU dari APP_URL (bukan header Host), token di fragment.
    expect(body.link).toMatch(new RegExp(`^${TEST_APP_ORIGIN}/undangan#token=[A-Za-z0-9_-]{43}$`));
    const token = tokenFromLink(body.link);
    expect(response.headers['cache-control']).toBe('no-store');

    const row = await invitationRow(body.invitation.id);
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(row.deliveryTokenEncrypted).toBeNull();
    const expiresInHours = (row.expiresAt.getTime() - row.tokenIssuedAt.getTime()) / 3_600_000;
    expect(expiresInHours).toBeCloseTo(72, 5);

    // Tidak ada antrean email; tautan ditampilkan dicatat audit (tanpa token).
    expect(harness.invitationJobs).toEqual([]);
    const [created] = await auditOf('user.invitation.created');
    expect(created?.metadata).toMatchObject({ role: 'cs', delivery: 'link' });
    expect(await auditOf('user.invitation.link_shown')).toHaveLength(1);
    const everything = `${harness.logs.text()}${JSON.stringify(await harness.db.select().from(auditLogs))}${JSON.stringify(row)}`;
    expect(everything).not.toContain(token);

    // Daftar: tautan tidak pernah bisa diambil lagi.
    const list = await call(harness.app, 'GET', routes.collection, undefined, as(owner));
    expect(list.statusCode).toBe(200);
    const listed = invitationListResponseSchema.parse(list.json());
    expect(listed.emailDelivery).toBe(false);
    expect(listed.invitableRoles).toEqual(['admin', 'supervisor', 'cs', 'teknisi']);
    expect(list.body).not.toContain(token);
  });

  it('dengan email pengirim: diantrekan ke worker (payload ID saja), tautan tidak ditampilkan', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);

    const body = await invited(owner, 'sari.spv@majujaya.test', 'supervisor');

    expect(body.link).toBeNull();
    expect(body.invitation.deliveryStatus).toBe('queued');
    expect(harness.invitationJobs).toEqual([
      {
        organizationId: owner.session.organization.id,
        invitationId: body.invitation.id,
        sendCount: 1,
      },
    ]);
    // Salinan untuk worker terenkripsi dan terikat ke baris + generasi token.
    const token = await tokenOf(body.invitation.id);
    expect((await invitationRow(body.invitation.id)).tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(harness.invitationJobs)).not.toContain(token);
    expect(await auditOf('user.invitation.link_shown')).toHaveLength(0);
    const list = invitationListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.collection, undefined, as(owner))).json(),
    );
    expect(list.emailDelivery).toBe(true);
  });

  it('pengantre email mati: undangan tetap dibuat dan ditandai gagal (bisa dikirim ulang)', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    await harness.rebuild({
      notifier: {
        accountLocked: () => Promise.resolve(),
        securityNotice: () => Promise.resolve(),
        securityNoticeAdmin: () => Promise.resolve(),
        invitation: () => Promise.reject(new Error('antrian mati')),
        accountToken: () => Promise.resolve(),
        emailSettingsChanged: () => Promise.resolve(),
        channelChanged: () => Promise.resolve(),
      },
    });
    const body = await invited(owner, 'tono@majujaya.test', 'teknisi');
    expect(body.invitation.deliveryStatus).toBe('failed');
    expect((await invitationRow(body.invitation.id)).deliveryTokenEncrypted).toBeNull();
    await harness.rebuild();
  });
});

describe('siapa boleh mengundang siapa', () => {
  it('Owner: semua peran kecuali Owner (Owner hanya lewat wizard setup)', async () => {
    const owner = await completeSetup(harness.app);
    for (const role of ['admin', 'supervisor', 'cs', 'teknisi'] as const) {
      expect((await invite(owner, `${role}@majujaya.test`, role)).statusCode).toBe(201);
    }
    const asOwner = await invite(owner, 'owner2@majujaya.test', 'owner' as InvitableRole);
    expect(asOwner.statusCode).toBe(400);
    expect(errorOf(asOwner).details?.[0]?.field).toBe('role');
    // Database ikut menolak undangan Owner.
    await expect(
      harness.db.insert(userInvitations).values({
        organizationId: owner.session.organization.id,
        email: 'owner3@majujaya.test',
        role: 'owner',
        tokenHash: sha256Hex('x'),
        expiresAt: new Date(Date.now() + 1000),
        deliveryStatus: 'link',
        invitedByUserId: owner.session.user.id,
        lastSentByUserId: owner.session.user.id,
      }),
    ).rejects.toThrow();
  });

  it('Admin: Supervisor/CS/Teknisi saja; undangan Admin tampil tetapi tidak bisa dikelolanya', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await adminSession(owner);
    const byOwner = await invited(owner, 'admin2@majujaya.test', 'admin');

    const adminInvitesAdmin = await invite(admin, 'admin3@majujaya.test', 'admin');
    expect(adminInvitesAdmin.statusCode).toBe(403);
    expect(errorOf(adminInvitesAdmin).message).toContain('hanya bisa dibuat Owner');
    const adminInvitesOwner = await invite(admin, 'o@majujaya.test', 'owner' as InvitableRole);
    expect(adminInvitesOwner.statusCode).toBe(400);
    expect((await invite(admin, 'cs1@majujaya.test', 'cs')).statusCode).toBe(201);

    const list = invitationListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.collection, undefined, as(admin))).json(),
    );
    expect(list.invitableRoles).toEqual(['supervisor', 'cs', 'teknisi']);
    expect(list.invitations.find((item) => item.id === byOwner.invitation.id)?.canManage).toBe(
      false,
    );

    const id = byOwner.invitation.id;
    const resend = await call(
      harness.app,
      'POST',
      apiPath(routes.resend, { invitationId: id }),
      undefined,
      as(admin),
    );
    expect(resend.statusCode).toBe(403);
    const revoke = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { invitationId: id }),
      undefined,
      as(admin),
    );
    expect(revoke.statusCode).toBe(403);
    expect((await invitationRow(id)).revokedAt).toBeNull();
  });

  it('Supervisor, CS, Teknisi: 403 di semua rute undangan; tanpa sesi 401; sesi terbatas 403 wajib 2FA', async () => {
    const owner = await completeSetup(harness.app);
    const pending = await invited(owner, 'calon@majujaya.test', 'cs');
    const id = pending.invitation.id;
    for (const role of ['supervisor', 'cs', 'teknisi'] as const) {
      const signed = await sessionFor(owner, role);
      const results = [
        await call(harness.app, 'GET', routes.collection, undefined, as(signed)),
        await invite(signed, `x-${role}@majujaya.test`, 'cs'),
        await call(
          harness.app,
          'POST',
          apiPath(routes.resend, { invitationId: id }),
          undefined,
          as(signed),
        ),
        await call(
          harness.app,
          'DELETE',
          apiPath(routes.revoke, { invitationId: id }),
          undefined,
          as(signed),
        ),
      ];
      expect(
        results.map((result) => result.statusCode),
        role,
      ).toEqual([403, 403, 403, 403]);
    }
    expect(
      (await call(harness.app, 'GET', routes.collection, undefined, { origin: null })).statusCode,
    ).toBe(401);
    expect((await invitationRow(id)).sendCount).toBe(1);
  });

  it('Owner yang belum mendaftar 2FA (sesi terbatas) tidak bisa mengundang', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const response = await call(
      harness.app,
      'POST',
      routes.collection,
      { email: 'a@majujaya.test', role: 'cs' },
      as(owner),
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });

  it('wajib CSRF + Origin aplikasi', async () => {
    const owner = await completeSetup(harness.app);
    const body = { email: 'csrf@majujaya.test', role: 'cs' };
    expect(
      (await call(harness.app, 'POST', routes.collection, body, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(harness.app, 'POST', routes.collection, body, {
          ...as(owner),
          origin: 'https://jahat.example',
        })
      ).statusCode,
    ).toBe(403);
    expect(await harness.db.select().from(userInvitations)).toEqual([]);
  });
});

describe('email bentrok, kirim ulang, batalkan', () => {
  it('email yang sudah terdaftar atau masih punya undangan berlaku → 409 di isian email', async () => {
    const owner = await completeSetup(harness.app);
    const registered = await invite(owner, owner.session.user.email.toUpperCase(), 'cs');
    expect(registered.statusCode).toBe(409);
    expect(errorOf(registered).details?.[0]).toMatchObject({ field: 'email' });
    expect(errorOf(registered).message).toContain('sudah terdaftar');

    await invited(owner, 'dua@majujaya.test', 'cs');
    const again = await invite(owner, 'dua@majujaya.test', 'teknisi');
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).message).toContain('masih berlaku');
  });

  it('undangan kedaluwarsa untuk email yang sama digantikan undangan baru', async () => {
    const owner = await completeSetup(harness.app);
    const first = await invited(owner, 'lama@majujaya.test', 'cs');
    await harness.db
      .update(userInvitations)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(userInvitations.id, first.invitation.id));
    const list = invitationListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.collection, undefined, as(owner))).json(),
    );
    expect(list.invitations[0]?.status).toBe('expired');

    const second = await invited(owner, 'lama@majujaya.test', 'teknisi');
    expect(second.invitation.role).toBe('teknisi');
    expect((await invitationRow(first.invitation.id)).revokedAt).toBeInstanceOf(Date);
    const [revoked] = await auditOf('user.invitation.revoked');
    expect(revoked?.metadata).toMatchObject({ reason: 'replaced_expired' });
  });

  it('kirim ulang: token baru, token lama langsung batal, berlaku 72 jam lagi', async () => {
    const owner = await completeSetup(harness.app);
    const first = await invited(owner, 'ulang@majujaya.test', 'cs');
    const oldToken = tokenFromLink(first.link);
    await harness.db
      .update(userInvitations)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(userInvitations.id, first.invitation.id));

    const response = await call(
      harness.app,
      'POST',
      apiPath(routes.resend, { invitationId: first.invitation.id }),
      undefined,
      as(owner),
    );
    expect(response.statusCode).toBe(200);
    const body = invitationIssuedResponseSchema.parse(response.json());
    expect(body.invitation).toMatchObject({ status: 'pending', sendCount: 2 });
    const newToken = tokenFromLink(body.link);
    expect(newToken).not.toBe(oldToken);

    const old = await inspect(oldToken);
    expect(old.statusCode).toBe(410);
    expect(errorOf(old).code).toBe('TOKEN_INVALID');
    expect((await inspect(newToken)).statusCode).toBe(200);
    const [resent] = await auditOf('user.invitation.resent');
    expect(resent?.metadata).toMatchObject({ sendCount: 2, wasExpired: true });
  });

  it('batalkan: tautan tidak berlaku lagi, hilang dari daftar; undangan organisasi lain 404', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'batal@majujaya.test', 'cs');
    const token = tokenFromLink(body.link);
    const url = apiPath(routes.revoke, { invitationId: body.invitation.id });

    const revoked = await call(harness.app, 'DELETE', url, undefined, as(owner));
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ status: 'revoked' });
    expect((await call(harness.app, 'DELETE', url, undefined, as(owner))).statusCode).toBe(404);
    expect((await inspect(token)).statusCode).toBe(410);
    const list = invitationListResponseSchema.parse(
      (await call(harness.app, 'GET', routes.collection, undefined, as(owner))).json(),
    );
    expect(list.invitations).toEqual([]);

    // Undangan milik organisasi lain tidak terlihat (filter organization_id).
    const other = await insertOrganization(harness.db, { name: 'PT Lain' });
    const otherOwner = await insertUser(harness.db, other.id, { role: 'owner' });
    const [foreign] = await harness.db
      .insert(userInvitations)
      .values({
        organizationId: other.id,
        email: 'asing@lain.test',
        role: 'cs',
        tokenHash: sha256Hex('asing'),
        expiresAt: new Date(Date.now() + 3_600_000),
        deliveryStatus: 'link',
        invitedByUserId: otherOwner.id,
        lastSentByUserId: otherOwner.id,
      })
      .returning();
    if (!foreign) throw new Error('gagal');
    const foreignUrl = apiPath(routes.resend, { invitationId: foreign.id });
    expect((await call(harness.app, 'POST', foreignUrl, undefined, as(owner))).statusCode).toBe(
      404,
    );
    expect(
      (
        await call(
          harness.app,
          'DELETE',
          apiPath(routes.revoke, { invitationId: foreign.id }),
          undefined,
          as(owner),
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('membuka dan menerima undangan', () => {
  it('CS: isi undangan hanya untuk token sah; menerima → akun peran dari undangan + sesi penuh', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'rudi@majujaya.test', 'cs');
    const token = tokenFromLink(body.link);

    const opened = await inspect(token);
    expect(opened.statusCode).toBe(200);
    expect(inspectInvitationResponseSchema.parse(opened.json())).toEqual({
      email: 'rudi@majujaya.test',
      role: 'cs',
      organizationName: 'PT Maju Jaya Abadi',
      productName: 'Balesin',
      invitedByName: owner.session.user.name,
      expiresAt: body.invitation.expiresAt,
      twoFactorRequired: false,
    });

    // Peran/email dari body diabaikan: diambil dari undangan.
    const response = await accept({
      token,
      name: 'Rudi Hartono',
      password: STRONG_PASSWORD,
      role: 'owner',
      email: 'penyusup@jahat.test',
    });
    expect(response.statusCode).toBe(201);
    const session = meResponseSchema.parse(response.json());
    expect(session.status).toBe('authenticated');
    expect(session.user).toMatchObject({
      email: 'rudi@majujaya.test',
      role: 'cs',
      name: 'Rudi Hartono',
    });
    expect(sessionCookieOf(response)).toBeTruthy();
    expect(deviceCookieOf(response)).toBeTruthy();

    const [user] = await harness.db
      .select()
      .from(users)
      .where(eq(users.email, 'rudi@majujaya.test'));
    expect(user?.role).toBe('cs');
    // Tautan disalin manual (tanpa email) tidak membuktikan alamat email.
    expect(user?.emailVerifiedAt).toBeNull();
    expect(await hasher.verify(user?.passwordHash ?? '', STRONG_PASSWORD)).toBe(true);
    const row = await invitationRow(body.invitation.id);
    expect(row.acceptedUserId).toBe(user?.id);
    const [accepted] = await auditOf('user.invitation.accepted');
    expect(accepted?.metadata).toMatchObject({ role: 'cs', emailVerified: false });

    // Sekali pakai.
    const reused = await accept({ token, name: 'Lagi', password: STRONG_PASSWORD });
    expect(reused.statusCode).toBe(410);
    expect(errorOf(reused).message).toContain('sudah dipakai');
    expect((await inspect(token)).statusCode).toBe(410);

    // Bisa masuk dengan password baru.
    const signed = await login(harness.app, {
      email: 'rudi@majujaya.test',
      password: STRONG_PASSWORD,
    });
    expect(signed.session.user.role).toBe('cs');
  });

  it('tautan yang terkirim lewat email: email akun dianggap terverifikasi', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const body = await invited(owner, 'verif@majujaya.test', 'teknisi');
    const token = await tokenOf(body.invitation.id);
    // Seperti worker setelah email diterima server SMTP.
    await harness.db
      .update(userInvitations)
      .set({ deliveryStatus: 'sent', deliveryTokenEncrypted: null })
      .where(eq(userInvitations.id, body.invitation.id));

    const response = await accept({ token, name: 'Tono Teknisi', password: STRONG_PASSWORD });
    expect(response.statusCode).toBe(201);
    const [user] = await harness.db
      .select()
      .from(users)
      .where(eq(users.email, 'verif@majujaya.test'));
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('Admin (wajib 2FA): sesi TERBATAS sampai 2FA aktif; 2FA aktif → email ke Owner dengan audit (IP/perangkat)', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'admin.baru@majujaya.test', 'admin');
    const token = tokenFromLink(body.link);
    const opened = inspectInvitationResponseSchema.parse((await inspect(token)).json());
    expect(opened.twoFactorRequired).toBe(true);

    const client = {
      ip: '203.0.113.44',
      headers: { 'user-agent': 'Peramban-Tes/1.0 (Windows NT 10.0)' },
    };
    const response = await accept({ token, name: 'Admin Baru', password: STRONG_PASSWORD }, client);
    expect(response.statusCode).toBe(201);
    const session = meResponseSchema.parse(response.json());
    expect(session.status).toBe('two_factor_enrollment_required');
    // Tanpa cookie perangkat dikenal sebelum 2FA aktif.
    expect(response.headers['set-cookie']).toHaveLength(1);
    const limited = { cookie: sessionCookieOf(response), csrf: session.csrfToken, ...client };
    const blocked = await call(harness.app, 'GET', routes.collection, undefined, limited);
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');

    // Mendaftar 2FA langsung dari sesi undangan (tanpa password lagi).
    const start = await call(harness.app, 'POST', API_ROUTES.twoFactor.enroll, {}, limited);
    expect(start.statusCode).toBe(200);
    const { secret } = startTwoFactorEnrollmentResponseSchema.parse(start.json());
    const confirm = await call(
      harness.app,
      'POST',
      API_ROUTES.twoFactor.confirmEnrollment,
      { code: generateTotp(secret) },
      limited,
    );
    expect(confirm.statusCode).toBe(200);

    const [user] = await harness.db
      .select()
      .from(users)
      .where(eq(users.email, 'admin.baru@majujaya.test'));
    const enabledAudit = (await auditOf('auth.2fa.enabled')).find(
      (row) => row.actorUserId === user?.id,
    );
    expect(enabledAudit?.ipAddress).toBe('203.0.113.44');
    expect(harness.securityNotices.at(-1)).toMatchObject({
      event: 'two_factor_enabled',
      userId: user?.id,
      auditLogId: enabledAudit?.id,
    });
    await expect.poll(() => harness.adminNotices.length).toBe(1);
    expect(harness.adminNotices[0]).toMatchObject({
      recipientUserId: owner.session.user.id,
      subjectUserId: user?.id,
      event: 'two_factor_enabled',
      auditLogId: enabledAudit?.id,
    });
  });

  it('CS yang mengaktifkan 2FA sendiri: tidak ada email ke Owner/Admin (bukan peran wajib)', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await sessionFor(owner, 'cs');
    const start = await call(
      harness.app,
      'POST',
      API_ROUTES.twoFactor.enroll,
      { password: 'sandi-cs-undangan-01' },
      as(cs),
    );
    const { secret } = startTwoFactorEnrollmentResponseSchema.parse(start.json());
    const confirm = await call(
      harness.app,
      'POST',
      API_ROUTES.twoFactor.confirmEnrollment,
      { code: generateTotp(secret) },
      as(cs),
    );
    expect(confirm.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.adminNotices).toEqual([]);
  });

  it('token salah, kedaluwarsa, dibatalkan: 410 dengan pesan yang membantu; tidak ada akun dibuat', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'kedaluwarsa@majujaya.test', 'cs');
    const token = tokenFromLink(body.link);
    await harness.db
      .update(userInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(userInvitations.id, body.invitation.id));

    const expired = await accept({ token, name: 'Telat', password: STRONG_PASSWORD });
    expect(expired.statusCode).toBe(410);
    expect(errorOf(expired).message).toContain('kedaluwarsa');
    const unknown = await inspect('A'.repeat(43));
    expect(unknown.statusCode).toBe(410);
    expect(errorOf(unknown).message).toContain('tidak berlaku');
    const malformed = await inspect('bukan token!');
    expect(malformed.statusCode).toBe(400);
    expect(
      await harness.db.select().from(users).where(eq(users.email, 'kedaluwarsa@majujaya.test')),
    ).toEqual([]);
    const [rejected] = await auditOf('user.invitation.rejected');
    expect(rejected?.metadata).toEqual({ reason: 'expired' });
  });

  it('kebijakan password sama dengan setup; nama/password dengan baris baru ditolak', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'budi.santoso@majujaya.test', 'cs');
    const token = tokenFromLink(body.link);

    const short = await accept({ token, name: 'Budi Santoso', password: 'pendek' });
    expect(short.statusCode).toBe(400);
    expect(errorOf(short).details?.[0]?.field).toBe('password');
    const common = await accept({ token, name: 'Budi Santoso', password: 'password123' });
    expect(common.statusCode).toBe(400);
    const personal = await accept({
      token,
      name: 'Budi Santoso',
      password: 'budisantoso-majujaya',
    });
    expect(personal.statusCode).toBe(400);
    expect(errorOf(personal).message).toContain('tidak boleh memuat nama');
    const injected = await accept({
      token,
      name: 'Budi\r\nBcc: korban@contoh.test',
      password: STRONG_PASSWORD,
    });
    expect(injected.statusCode).toBe(400);
    expect(errorOf(injected).details?.[0]?.field).toBe('name');
    const badEmail = await invite(owner, 'a@b.test\r\nBcc: korban@contoh.test', 'cs');
    expect(badEmail.statusCode).toBe(400);

    // Token tetap berlaku setelah isian salah.
    expect(
      (await accept({ token, name: 'Budi Santoso', password: STRONG_PASSWORD })).statusCode,
    ).toBe(201);
  });

  it('dua permintaan menerima bersamaan: hanya satu akun', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'balapan@majujaya.test', 'cs');
    const token = tokenFromLink(body.link);
    const results = await Promise.all([
      accept({ token, name: 'Satu Orang', password: STRONG_PASSWORD }),
      accept({ token, name: 'Dua Orang', password: STRONG_PASSWORD }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 410]);
    expect(
      await harness.db.select().from(users).where(eq(users.email, 'balapan@majujaya.test')),
    ).toHaveLength(1);
  });

  it('menerima undangan di browser yang sedang masuk: sesi lama dicabut (rotasi)', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'rotasi@majujaya.test', 'cs');
    const response = await accept(
      { token: tokenFromLink(body.link), name: 'Rina Rotasi', password: STRONG_PASSWORD },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(201);
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, {
      cookie: owner.cookie,
    });
    expect(me.statusCode).toBe(401);
    const ownerSessions = await harness.db
      .select()
      .from(userSessions)
      .where(
        and(eq(userSessions.userId, owner.session.user.id), sql`${userSessions.revokedAt} is null`),
      );
    expect(ownerSessions).toEqual([]);
  });
});

describe('batas laju', () => {
  it('per email tujuan: 5 kali (buat + kirim ulang) per jam', async () => {
    const owner = await completeSetup(harness.app);
    const body = await invited(owner, 'banjir@majujaya.test', 'cs');
    const url = apiPath(routes.resend, { invitationId: body.invitation.id });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await call(harness.app, 'POST', url, undefined, as(owner))).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    const limited = await call(harness.app, 'POST', url, undefined, as(owner));
    expect(limited.headers['retry-after']).toBeDefined();
    // Undangan lain tidak ikut terhambat.
    expect((await invite(owner, 'lain@majujaya.test', 'cs')).statusCode).toBe(201);
  });

  it('per pengundang: 20 undangan per jam', async () => {
    const owner = await completeSetup(harness.app);
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      statuses.push((await invite(owner, `massal-${index}@majujaya.test`, 'cs')).statusCode);
    }
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('token tidak dikenal per IP: 30 per 15 menit, lalu 429 (token sah tidak dihitung)', async () => {
    const owner = await completeSetup(harness.app);
    const valid = tokenFromLink((await invited(owner, 'sah@majujaya.test', 'cs')).link);
    const ip = { ip: '198.51.100.77' };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await inspect(valid, ip)).statusCode).toBe(200);
    }
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push(
        (await inspect(`${'B'.repeat(40)}${attempt.toString().padStart(3, '0')}`, ip)).statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 410)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Jaringan lain tidak terpengaruh.
    expect((await inspect(valid, { ip: '198.51.100.78' })).statusCode).toBe(200);
  });
});

describe('penerbit token undangan harus tetap berhak (review R2)', () => {
  it('pembuat dinonaktifkan → 410 + audit; Owner mengirim ulang → tautan baru berlaku lagi', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await adminSession(owner);
    const body = await invited(admin, 'kenalan@majujaya.test', 'supervisor');
    const token = tokenFromLink(body.link);
    await harness.db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, admin.session.user.id));

    const rejected = await inspect(token);
    expect(rejected.statusCode).toBe(410);
    expect(errorOf(rejected).message).toContain('tidak berlaku');
    const [audit] = await auditOf('user.invitation.rejected');
    expect(audit?.metadata).toEqual({ reason: 'inviter_unavailable' });

    const resent = await call(
      harness.app,
      'POST',
      apiPath(routes.resend, { invitationId: body.invitation.id }),
      undefined,
      as(owner),
    );
    expect(resent.statusCode).toBe(200);
    const fresh = tokenFromLink(invitationIssuedResponseSchema.parse(resent.json()).link);
    expect((await inspect(token)).statusCode).toBe(410);
    expect((await inspect(fresh)).statusCode).toBe(200);
  });

  it('peran pengirim diturunkan (Admin → CS): undangan Supervisor-nya tidak bisa diterima', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await adminSession(owner);
    const body = await invited(admin, 'turun@majujaya.test', 'cs');
    await harness.db.update(users).set({ role: 'cs' }).where(eq(users.id, admin.session.user.id));
    const response = await accept({
      token: tokenFromLink(body.link),
      name: 'Calon Pengguna',
      password: STRONG_PASSWORD,
    });
    expect(response.statusCode).toBe(410);
    expect(
      await harness.db.select().from(users).where(eq(users.email, 'turun@majujaya.test')),
    ).toEqual([]);
  });

  it('revokeInvitationsIssuedBy (untuk butir 6) membatalkan undangan terbuka buatan/kiriman pengguna itu saja', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await adminSession(owner);
    const byAdmin = await invited(admin, 'a1@majujaya.test', 'cs');
    const byOwner = await invited(owner, 'a2@majujaya.test', 'cs');
    const revoked = await revokeInvitationsIssuedBy(
      harness.db,
      owner.session.organization.id,
      admin.session.user.id,
      owner.session.user.id,
    );
    expect(revoked.map((row) => row.id)).toEqual([byAdmin.invitation.id]);
    expect((await invitationRow(byAdmin.invitation.id)).revokedByUserId).toBe(
      owner.session.user.id,
    );
    expect((await invitationRow(byOwner.invitation.id)).revokedAt).toBeNull();
  });
});

describe('membuat undangan tidak bisa menggantikan undangan yang tidak boleh dikelola (review R1)', () => {
  it('Admin + undangan Admin (masih berlaku atau kedaluwarsa) untuk email yang sama → 403, kuota tidak terpakai', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await adminSession(owner);
    const ownerInvite = await invited(owner, 'calon@majujaya.test', 'admin');
    expect((await invite(admin, 'calon@majujaya.test', 'cs')).statusCode).toBe(403);
    await harness.db
      .update(userInvitations)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(userInvitations.id, ownerInvite.invitation.id));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await invite(admin, 'calon@majujaya.test', 'cs')).statusCode).toBe(403);
    }
    expect((await invitationRow(ownerInvite.invitation.id)).revokedAt).toBeNull();
    // Kuota per email tujuan tidak terpakai oleh penolakan: Owner masih bisa mengirim ulang.
    const resend = await call(
      harness.app,
      'POST',
      apiPath(routes.resend, { invitationId: ownerInvite.invitation.id }),
      undefined,
      as(owner),
    );
    expect(resend.statusCode).toBe(200);
  });
});
