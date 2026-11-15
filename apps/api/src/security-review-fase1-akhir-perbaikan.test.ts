/**
 * Perbaikan temuan review keamanan AKHIR Fase 1 (docs/security-reviews/2026-11-15-fase1-akhir.md)
 * yang tidak tercakup berkas pengunci `security-review-fase1-akhir.test.ts`:
 *  - T1: konfirmasi wajib untuk Owner juga (buat + kirim ulang), `member_joined` + email ke semua
 *    Owner, undangan batal saat sesi penerbitnya dikeluarkan (tetapi tidak saat keluar biasa);
 *  - R3: pelaku diperiksa ulang di transaksi tulis terakhir (`assertActorStillAuthorized`);
 *  - R5: atur ulang password untuk banyak akun → `password_reset_burst` + email ke Owner, sekali.
 */
import { AppError } from '@balesin/core';
import { auditLogs, userInvitations, userSessions, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  apiPath,
  errorEnvelopeSchema,
  invitationIssuedResponseSchema,
  readTokenFromFragment,
  securitySummaryResponseSchema,
} from '@balesin/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertActorStillAuthorized } from './modules/auth/actor-check';
import { createPasswordHasher } from './modules/auth/password-hasher';
import type { AuthContext } from './modules/auth/session.service';
import {
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  mailpitSettings,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const routes = API_ROUTES.invitations;
const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
});
afterAll(async () => {
  await harness?.close();
});

async function invite(signed: SignedIn, email: string, role: 'admin' | 'cs' = 'cs') {
  const response = await call(
    harness.app,
    'POST',
    routes.collection,
    await withConfirmation(signed, { email, role }),
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(201);
  return invitationIssuedResponseSchema.parse(response.json());
}

function tokenOf(link: string | null): string {
  const token = readTokenFromFragment(new URL(link ?? 'http://x.invalid').hash);
  if (!token) throw new Error('Tautan tanpa token');
  return token;
}

async function invitationRow(email: string) {
  const [row] = await harness.db
    .select()
    .from(userInvitations)
    .where(eq(userInvitations.email, email));
  return row;
}

describe('T1 — undangan wajib konfirmasi identitas, juga untuk Owner', () => {
  it('buat & kirim ulang tanpa konfirmasi → 400 confirmation.password; kuota tidak terpakai', async () => {
    const created = await call(
      harness.app,
      'POST',
      routes.collection,
      { email: 'cs.baru@majujaya.test', role: 'cs' },
      as(owner),
    );
    expect(created.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(created.json()).error.details?.[0]?.field).toBe(
      'confirmation.password',
    );
    const wrong = await call(
      harness.app,
      'POST',
      routes.collection,
      {
        email: 'cs.baru@majujaya.test',
        role: 'cs',
        confirmation: { password: 'bukan-password-owner', code: '000000' },
      },
      as(owner),
    );
    expect(wrong.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(wrong.json()).error.details?.[0]?.field).toMatch(
      /^confirmation\./,
    );
    expect(await invitationRow('cs.baru@majujaya.test')).toBeUndefined();

    const issued = await invite(owner, 'cs.baru@majujaya.test');
    const url = apiPath(routes.resend, { invitationId: issued.invitation.id });
    for (const body of [undefined, {}]) {
      const resent = await call(harness.app, 'POST', url, body, as(owner));
      expect(resent.statusCode).toBe(400);
      expect(errorEnvelopeSchema.parse(resent.json()).error.details?.[0]?.field).toBe(
        'confirmation.password',
      );
    }
    expect((await invitationRow('cs.baru@majujaya.test'))?.sendCount).toBe(1);
    const resent = await call(
      harness.app,
      'POST',
      url,
      await withConfirmation(owner, {}),
      as(owner),
    );
    expect(resent.statusCode, resent.body).toBe(200);
  });

  it('undangan diterima → member_joined (warning) + email ke SEMUA Owner aktif, juga bila Owner yang mengundang', async () => {
    const secondOwner = await insertUser(harness.db, owner.session.organization.id, {
      role: 'owner',
      email: 'owner.dua@majujaya.test',
    });
    const { link } = await invite(owner, 'cs.gabung@majujaya.test');
    const accepted = await call(harness.app, 'POST', routes.accept, {
      token: tokenOf(link),
      name: 'CS Gabung',
      password: 'gerimis-ladang-pinus-kelabu-07',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);

    const [joined] = await harness.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'cs.gabung@majujaya.test'));
    await expect
      .poll(() => harness.adminNotices.filter((notice) => notice.event === 'member_joined').length)
      .toBe(2);
    const notices = harness.adminNotices.filter((notice) => notice.event === 'member_joined');
    expect(notices.map((notice) => notice.recipientUserId).sort()).toEqual(
      [owner.session.user.id, secondOwner.id].sort(),
    );
    for (const notice of notices) {
      expect(notice).toMatchObject({
        subjectUserId: joined?.id,
        actorUserId: owner.session.user.id,
      });
    }

    const summary = securitySummaryResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, as(owner))
      ).json(),
    );
    const event = summary.events.find((entry) => entry.kind === 'member_joined');
    expect(event).toMatchObject({
      severity: 'warning',
      actor: { id: joined?.id },
      details: { role: 'cs', issuerRole: 'owner' },
    });
    expect(summary.counts.member_joined).toBe(1);
  });

  it('"keluarkan sesi lain" membatalkan undangan dari sesi lain — juga yang sudah keluar; keluar biasa sendiri tidak', async () => {
    // Sesi A menerbitkan dua undangan; sesi B (pemilik akun di perangkat lain) memulihkan akun.
    await invite(owner, 'dari.sesi.a@majujaya.test');
    const other = await login(harness.app);
    await invite(other, 'dari.sesi.b@majujaya.test');

    // Keluar biasa dari sesi B: undangannya tetap berlaku.
    const loggedOut = await call(harness.app, 'POST', API_ROUTES.auth.logout, {}, as(other));
    expect(loggedOut.statusCode).toBeLessThan(300);
    expect((await invitationRow('dari.sesi.b@majujaya.test'))?.revokedAt).toBeNull();

    const recovery = await login(harness.app);
    const revoked = await call(
      harness.app,
      'POST',
      API_ROUTES.sessions.revokeOthers,
      await confirmationOf(recovery),
      as(recovery),
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    // Semua undangan terbitannya selain dari sesi pemulih batal — juga dari sesi B yang sudah keluar
    // lebih dulu (review akhir Fase 1 putaran 2 N2).
    expect((await invitationRow('dari.sesi.a@majujaya.test'))?.revokedAt).not.toBeNull();
    expect((await invitationRow('dari.sesi.b@majujaya.test'))?.revokedAt).not.toBeNull();
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.invitationRevoked));
    expect(audits.map((row) => row.metadata.reason)).toEqual([
      'issuer_session_revoked',
      'issuer_session_revoked',
    ]);

    // Undangan dari sesi pemulih sendiri tetap berlaku.
    await invite(recovery, 'dari.sesi.pemulih@majujaya.test');
    const again = await call(
      harness.app,
      'POST',
      API_ROUTES.sessions.revokeOthers,
      await confirmationOf(recovery),
      as(recovery),
    );
    expect(again.statusCode, again.body).toBe(200);
    expect((await invitationRow('dari.sesi.pemulih@majujaya.test'))?.revokedAt).toBeNull();
  });
});

describe('R3 — pelaku diperiksa ulang di transaksi tulis terakhir', () => {
  async function authOf(signed: SignedIn): Promise<AuthContext> {
    const [session] = await harness.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, signed.session.user.id))
      .orderBy(desc(userSessions.createdAt))
      .limit(1);
    if (!session) throw new Error('Sesi tidak ada');
    return {
      sessionRef: session.id,
      organizationId: signed.session.organization.id,
      user: { ...signed.session.user },
      organization: { ...signed.session.organization },
    } as unknown as AuthContext;
  }

  const warnings: Array<Record<string, unknown>> = [];
  const log = { warn: (object: Record<string, unknown>) => warnings.push(object) };
  const check = (auth: AuthContext) =>
    harness.db.transaction((tx) => assertActorStillAuthorized(tx, auth, 'channels.manage', log));

  it('masih berhak → peran terbaru; diturunkan → 403; sesi dicabut / akun nonaktif → 401', async () => {
    const password = 'sandi-uji-r3-admin-01';
    const admin = await insertUser(harness.db, owner.session.organization.id, {
      role: 'admin',
      email: 'admin.r3@majujaya.test',
      passwordHash: await hasher.hash(password),
    });
    const signed = await login(harness.app, { email: admin.email, password });
    const auth = await authOf(signed);
    await expect(check(auth)).resolves.toEqual({ role: 'admin' });

    const statusOf = async () => {
      try {
        await check(auth);
        return 'lolos';
      } catch (error) {
        return error instanceof AppError ? error.code : 'lain';
      }
    };
    const scope = and(
      eq(users.organizationId, owner.session.organization.id),
      eq(users.id, admin.id),
    );
    await harness.db.update(users).set({ role: 'cs' }).where(scope);
    expect(await statusOf()).toBe('FORBIDDEN');
    await harness.db.update(users).set({ role: 'admin' }).where(scope);
    await harness.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.id, auth.sessionRef));
    expect(await statusOf()).toBe('UNAUTHENTICATED');
    await harness.db
      .update(userSessions)
      .set({ revokedAt: null })
      .where(eq(userSessions.id, auth.sessionRef));
    await harness.db.update(users).set({ disabledAt: new Date() }).where(scope);
    expect(await statusOf()).toBe('UNAUTHENTICATED');
    // Setiap penolakan dicatat `warn` dengan ID + alasan saja (tanpa email/nama).
    expect(warnings.map((entry) => entry.reason ?? entry.role)).toEqual(['cs', 'session', 'user']);
    expect(JSON.stringify(warnings)).not.toContain(admin.email);
  });
});

describe('R5 — atur ulang password untuk banyak akun dalam waktu singkat', () => {
  it('3 akun berbeda dalam satu jam → satu kejadian password_reset_burst + email ke Owner (sekali)', async () => {
    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      await withConfirmation(owner, mailpitSettings()),
      as(owner),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const emails: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      const user = await insertUser(harness.db, owner.session.organization.id, {
        role: 'cs',
        email: `cs.reset${String(index)}@majujaya.test`,
      });
      emails.push(user.email);
    }
    for (const [index, email] of emails.entries()) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.passwordReset.request,
        { email },
        {
          ip: `203.0.113.${String(60 + index)}`,
        },
      );
      expect(response.statusCode, response.body).toBe(202);
      await harness.app.backgroundTasks.drain();
    }

    const bursts = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.password_reset.burst'));
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.metadata).toMatchObject({ accounts: 3, windowMinutes: 60 });
    const notices = harness.adminNotices.filter(
      (notice) => notice.event === 'password_reset_burst',
    );
    expect(notices).toEqual([
      expect.objectContaining({
        recipientUserId: owner.session.user.id,
        auditLogId: bursts[0]?.id,
      }),
    ]);
    const summary = securitySummaryResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, as(owner))
      ).json(),
    );
    expect(summary.events.find((event) => event.kind === 'password_reset_burst')).toMatchObject({
      severity: 'warning',
      details: { accounts: 3, windowMinutes: 60 },
    });
  });
});
