/**
 * Verifikasi email akun sendiri (ROADMAP Fase 1 butir 4): token ter-hash, sekali pakai, 24 jam,
 * terikat alamat; tanpa email pengirim = tidak bisa dikirim.
 */
import { accountTokenDeliveryContext, createSecretBox, Secret, sha256Hex } from '@balesin/core';
import { accountTokens, auditLogs, users } from '@balesin/db';
import {
  API_ROUTES,
  emailVerificationStatusResponseSchema,
  errorEnvelopeSchema,
  sendEmailVerificationResponseSchema,
  type ErrorEnvelope,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  mailpitSettings,
  TEST_MASTER_KEY,
  type CallOptions,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

let harness: IntegrationHarness;
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
const routes = API_ROUTES.emailVerification;

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

async function configureEmail(owner: SignedIn) {
  const saved = await call(
    harness.app,
    'PUT',
    API_ROUTES.settings.email,
    await withConfirmation(owner, mailpitSettings()),
    as(owner),
  );
  if (saved.statusCode !== 200) throw new Error(`Simpan email gagal: ${saved.body}`);
}

async function latestToken(): Promise<string> {
  const rows = await harness.db
    .select()
    .from(accountTokens)
    .where(eq(accountTokens.purpose, 'email_verification'));
  const row = rows.find((candidate) => candidate.deliveryTokenEncrypted !== null);
  if (!row?.deliveryTokenEncrypted) throw new Error('Tidak ada token verifikasi');
  return box.decrypt(
    row.deliveryTokenEncrypted,
    accountTokenDeliveryContext(row.organizationId, row.id),
  );
}

const verify = (token: string) => call(harness.app, 'POST', routes.verify, { token });

describe('verifikasi email akun sendiri', () => {
  it('Owner hasil setup: belum terverifikasi; tanpa email pengirim tidak bisa dikirim (503)', async () => {
    const owner = await completeSetup(harness.app);
    const status = await call(harness.app, 'GET', routes.status, undefined, as(owner));
    expect(status.statusCode).toBe(200);
    expect(emailVerificationStatusResponseSchema.parse(status.json())).toEqual({
      email: owner.session.user.email,
      verified: false,
      verifiedAt: null,
      canSend: false,
    });
    const send = await call(harness.app, 'POST', routes.status, {}, as(owner));
    expect(send.statusCode).toBe(503);
    expect(errorOf(send).message).toContain('email pengirim belum diatur');
  });

  it('kirim → tautan (payload ID saja) → verifikasi → terverifikasi; sekali pakai; kirim lagi 409', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const send = await call(harness.app, 'POST', routes.status, {}, as(owner));
    expect(send.statusCode).toBe(202);
    expect(sendEmailVerificationResponseSchema.parse(send.json()).status).toBe('queued');
    const token = await latestToken();
    expect(harness.accountTokenJobs).toHaveLength(1);
    expect(JSON.stringify(harness.accountTokenJobs)).not.toContain(token);
    const [row] = await harness.db
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.tokenHash, sha256Hex(token)));
    const hours = ((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)) / 3_600_000;
    expect(hours).toBeCloseTo(24, 3);

    const verified = await verify(token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ status: 'verified', email: owner.session.user.email });
    const status = emailVerificationStatusResponseSchema.parse(
      (await call(harness.app, 'GET', routes.status, undefined, as(owner))).json(),
    );
    expect(status.verified).toBe(true);

    const reused = await verify(token);
    expect(reused.statusCode).toBe(410);
    expect(errorOf(reused).message).toContain('sudah dipakai');
    expect((await call(harness.app, 'POST', routes.status, {}, as(owner))).statusCode).toBe(409);
    const actions = (await harness.db.select().from(auditLogs)).map((entry) => entry.action);
    expect(actions).toContain('auth.email.verification_sent');
    expect(actions).toContain('auth.email.verified');
    expect(JSON.stringify(await harness.db.select().from(auditLogs))).not.toContain(token);
  });

  it('meminta lagi membatalkan tautan lama; batas 3 per jam per pengguna', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const statuses: number[] = [];
    const tokens: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await call(harness.app, 'POST', routes.status, {}, as(owner));
      statuses.push(response.statusCode);
      if (response.statusCode === 202) tokens.push(await latestToken());
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await verify(tokens[0] ?? '')).statusCode).toBe(410);
    expect((await verify(tokens[2] ?? '')).statusCode).toBe(200);
  });

  it('kedaluwarsa atau alamat akun sudah berubah → 410, email tidak ditandai', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    await call(harness.app, 'POST', routes.status, {}, as(owner));
    const token = await latestToken();
    await harness.db
      .update(accountTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(accountTokens.tokenHash, sha256Hex(token)));
    const expired = await verify(token);
    expect(expired.statusCode).toBe(410);
    expect(errorOf(expired).message).toContain('kedaluwarsa');

    await call(harness.app, 'POST', routes.status, {}, as(owner));
    const second = await latestToken();
    await harness.db
      .update(users)
      .set({ email: 'alamat.baru@majujaya.test' })
      .where(eq(users.id, owner.session.user.id));
    const changed = await verify(second);
    expect(changed.statusCode).toBe(410);
    expect(errorOf(changed).message).toContain('sudah berubah');
    const [user] = await harness.db.select().from(users).where(eq(users.id, owner.session.user.id));
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it('butuh sesi penuh: tanpa sesi 401, sesi terbatas 403; verifikasi tanpa CSRF tetap publik', async () => {
    const limited = await completeSetupWithoutTwoFactor(harness.app);
    expect(
      (await call(harness.app, 'GET', routes.status, undefined, { origin: null })).statusCode,
    ).toBe(401);
    const blocked = await call(harness.app, 'GET', routes.status, undefined, as(limited));
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked).code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
    expect((await verify('D'.repeat(43))).statusCode).toBe(410);
  });
});
