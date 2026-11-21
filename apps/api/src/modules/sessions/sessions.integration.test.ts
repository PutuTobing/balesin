/**
 * Sesi aktif milik sendiri (ROADMAP Fase 1 butir 6): daftar (perangkat ringkas, IP tersamar, sesi
 * ini), keluarkan satu sesi lain, keluarkan semua sesi lain dengan konfirmasi ulang identitas.
 */
import { auditLogs } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  activeSessionListResponseSchema,
  apiPath,
  errorEnvelopeSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER,
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  type CallOptions,
  type IntegrationHarness,
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

const routes = API_ROUTES.sessions;
const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});
const me = (signed: { cookie: string; csrf: string }) =>
  call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(signed));
const list = async (signed: { cookie: string; csrf: string }) =>
  activeSessionListResponseSchema.parse(
    (await call(harness.app, 'GET', routes.list, undefined, as(signed))).json(),
  );
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe('sesi aktif milik sendiri', () => {
  it('daftar: sesi ini ditandai, IP tersamar, perangkat ringkas, tanpa token', async () => {
    await completeSetup(harness.app);
    const laptop = await login(harness.app, OWNER, {
      ip: '2001:db8:85a3::8a2e:370:7334',
      headers: { 'user-agent': DESKTOP_UA },
    });
    const response = await call(harness.app, 'GET', routes.list, undefined, as(laptop));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/token|hash|8a2e/i);
    const { sessions } = activeSessionListResponseSchema.parse(response.json());
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const current = sessions.filter((session) => session.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      device: 'Chrome di Windows',
      ipAddress: '2001:db8:85a3:*',
      limited: false,
    });
  });

  it('keluarkan satu sesi lain; sesi ini sendiri → 409; sesi orang lain → 404', async () => {
    const owner = await completeSetup(harness.app);
    const phone = await login(harness.app, OWNER);
    const phoneRef = (await list(phone)).sessions.find((session) => session.current)?.id ?? '';
    const ownRef = (await list(owner)).sessions.find((session) => session.current)?.id ?? '';

    const self = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: ownRef }),
      undefined,
      as(owner),
    );
    expect(self.statusCode).toBe(409);

    const cs = await insertUser(harness.db, owner.session.organization.id, {
      role: 'cs',
      email: 'cs.sesi@majujaya.test',
      passwordHash: await hasher.hash('sandi-cs-sesi-uji-01'),
    });
    const csSigned = await login(harness.app, {
      email: cs.email,
      password: 'sandi-cs-sesi-uji-01',
    });
    const csRef = (await list(csSigned)).sessions[0]?.id ?? '';
    const foreign = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: csRef }),
      undefined,
      as(owner),
    );
    expect(foreign.statusCode).toBe(404);
    expect((await me(csSigned)).statusCode).toBe(200);

    // Sesi `phone` lebih BARU dari sesi `owner`: tanpa konfirmasi ditolak (review butir 6 R4).
    const listed = await list(owner);
    expect(listed.sessions.find((session) => session.id === phoneRef)?.confirmationRequired).toBe(
      true,
    );
    const unconfirmed = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: phoneRef }),
      undefined,
      as(owner),
    );
    expect(unconfirmed.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(unconfirmed.json()).error.details?.[0]?.field).toBe(
      'password',
    );
    expect((await me(phone)).statusCode).toBe(200);
    const revoked = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: phoneRef }),
      { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
      as(owner),
    );
    expect(revoked.statusCode).toBe(200);
    expect((await me(phone)).statusCode).toBe(401);
    expect((await me(owner)).statusCode).toBe(200);
    const again = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: phoneRef }),
      undefined,
      as(owner),
    );
    expect(again.statusCode).toBe(404);
  });

  it('sesi yang lebih LAMA dikeluarkan satu klik (pemilik yang masuk ulang mengusir cookie lama)', async () => {
    const old = await completeSetup(harness.app);
    const fresh = await login(harness.app, OWNER);
    const sessions = (await list(fresh)).sessions;
    const oldRef = sessions.find((session) => !session.current)?.id ?? '';
    expect(sessions.find((session) => session.id === oldRef)?.confirmationRequired).toBe(false);
    const revoked = await call(
      harness.app,
      'DELETE',
      apiPath(routes.revoke, { sessionId: oldRef }),
      undefined,
      as(fresh),
    );
    expect(revoked.statusCode).toBe(200);
    expect((await me(old)).statusCode).toBe(401);
    expect((await me(fresh)).statusCode).toBe(200);
  });

  it('keluarkan semua sesi lain butuh password + kode; sesi ini tetap hidup', async () => {
    const owner = await completeSetup(harness.app);
    const other = await login(harness.app, OWNER);

    const withoutCode = await call(
      harness.app,
      'POST',
      routes.revokeOthers,
      { password: OWNER.password },
      as(owner),
    );
    expect(withoutCode.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(withoutCode.json()).error.details?.[0]?.field).toBe('code');
    const wrongPassword = await call(
      harness.app,
      'POST',
      routes.revokeOthers,
      { password: 'bukan-password-yang-benar', code: await freshTotpCode(OWNER.email) },
      as(owner),
    );
    expect(wrongPassword.statusCode).toBe(400);
    expect((await me(other)).statusCode).toBe(200);

    const response = await call(
      harness.app,
      'POST',
      routes.revokeOthers,
      { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
      as(owner),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ revokedSessions: number }>().revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await me(other)).statusCode).toBe(401);
    expect((await me(owner)).statusCode).toBe(200);
    expect((await list(owner)).sessions).toHaveLength(1);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.sessions.revoked_all'));
    expect(audit?.metadata).toMatchObject({ by: 'self', keptCurrent: true, confirmedWith: 'totp' });
  });

  it('CS tanpa 2FA: cukup password untuk keluarkan semua sesi lain', async () => {
    const owner = await completeSetup(harness.app);
    const cs = await insertUser(harness.db, owner.session.organization.id, {
      role: 'cs',
      email: 'cs.tanpa2fa@majujaya.test',
      passwordHash: await hasher.hash('sandi-cs-tanpa-2fa-01'),
    });
    const first = await login(harness.app, { email: cs.email, password: 'sandi-cs-tanpa-2fa-01' });
    const second = await login(harness.app, { email: cs.email, password: 'sandi-cs-tanpa-2fa-01' });
    const response = await call(
      harness.app,
      'POST',
      routes.revokeOthers,
      { password: 'sandi-cs-tanpa-2fa-01' },
      as(second),
    );
    expect(response.json()).toEqual({ revokedSessions: 1 });
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
  });
});
