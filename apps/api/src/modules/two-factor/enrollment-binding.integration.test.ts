/**
 * Mitigasi review 2FA R7 + Info 17 (dibangun bersama undangan, ROADMAP Fase 1 butir 4):
 * - rahasia pendaftaran yang tertunda hanya dipakai ulang dari peramban + jaringan yang SAMA
 *   dengan saat sesi pendaftaran dibuat; dari tempat lain diputar (QR pemilik ditolak → ketahuan);
 * - batas mutlak sejak rahasia pertama dibuat (`totp_pending_issued_at`).
 */
import { generateTotp } from '@balesin/core';
import { auditLogs, users } from '@balesin/db';
import {
  API_ROUTES,
  meResponseSchema,
  startTwoFactorEnrollmentResponseSchema,
  twoFactorStatusResponseSchema,
} from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetupWithoutTwoFactor,
  createIntegrationHarness,
  sessionCookieOf,
  type CallOptions,
  type IntegrationHarness,
} from '../../testing/integration';

let harness: IntegrationHarness;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

const routes = API_ROUTES.twoFactor;

async function start(as: CallOptions) {
  const response = await call(harness.app, 'POST', routes.enroll, {}, as);
  if (response.statusCode !== 200) throw new Error(`Mulai daftar gagal: ${response.body}`);
  return startTwoFactorEnrollmentResponseSchema.parse(response.json()).secret;
}

describe('rahasia tertunda: pemakaian ulang terikat klien sesi (R7) dan berbatas mutlak (Info 17)', () => {
  it('klien yang sama memuat ulang → rahasia sama; waktu terbit pertama tidak bergeser', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = await start(as);
    const [before] = await harness.db
      .select()
      .from(users)
      .where(eq(users.id, owner.session.user.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await start(as)).toBe(first);
    const [after] = await harness.db
      .select()
      .from(users)
      .where(eq(users.id, owner.session.user.id));
    expect(after?.totpPendingIssuedAt).toEqual(before?.totpPendingIssuedAt);
    expect(after?.totpPendingCreatedAt?.getTime() ?? 0).toBeGreaterThan(
      before?.totpPendingCreatedAt?.getTime() ?? 0,
    );
  });

  it('cookie sesi pendaftaran dipakai dari peramban/jaringan lain → rahasia DIPUTAR, QR pemilik batal', async () => {
    const setup = await completeSetupWithoutTwoFactor(harness.app);
    const owner = { as: { cookie: setup.cookie, csrf: setup.csrf } };
    const ownerSecret = await start(owner.as);

    // Pencuri cookie dari IP lain / user agent lain tidak bisa membaca ulang rahasia pemilik.
    const thiefIp = await start({ ...owner.as, ip: '198.51.100.66' });
    expect(thiefIp).not.toBe(ownerSecret);
    const thiefAgent = await start({ ...owner.as, headers: { 'user-agent': 'Peramban-Lain/9' } });
    expect(thiefAgent).not.toBe(ownerSecret);
    expect(thiefAgent).not.toBe(thiefIp);

    // Pemilik tidak bisa mengonfirmasi QR lamanya (berisik, ketahuan).
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(ownerSecret) },
      owner.as,
    );
    expect(confirm.statusCode).toBe(400);
    const started = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.2fa.enrollment_started'));
    expect(started.map((row) => row.metadata.rotatedReason ?? null)).toEqual([
      null,
      'different_client',
      'different_client',
    ]);
  });

  it('IPv6 dalam /64 yang sama dianggap jaringan yang sama', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    // Sesi pendaftaran baru dari IPv6 lewat login ulang (sesi wizard dibuat dari 127.0.0.1).
    const login = await call(
      harness.app,
      'POST',
      API_ROUTES.auth.login,
      { email: owner.session.user.email, password: 'kopi-tubruk-gerimis-senja' },
      { ip: '2001:db8:1:2::10' },
    );
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookieOf(login);
    const csrf = meResponseSchema.parse(login.json()).csrfToken;
    const first = await start({ cookie, csrf, ip: '2001:db8:1:2::10' });
    expect(await start({ cookie, csrf, ip: '2001:db8:1:2:ffff::1' })).toBe(first);
    expect(await start({ cookie, csrf, ip: '2001:db8:1:3::10' })).not.toBe(first);
  });

  it('batas mutlak: rahasia yang pertama dibuat > 30 menit lalu tidak dipakai ulang lagi', async () => {
    const owner = await completeSetupWithoutTwoFactor(harness.app);
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const first = await start(as);
    await harness.db
      .update(users)
      .set({ totpPendingIssuedAt: sql`now() - interval '31 minutes'` })
      .where(eq(users.id, owner.session.user.id));
    const status = await call(harness.app, 'GET', routes.status, undefined, as);
    expect(twoFactorStatusResponseSchema.parse(status.json()).enrollmentPending).toBe(false);
    const confirm = await call(
      harness.app,
      'POST',
      routes.confirmEnrollment,
      { code: generateTotp(first) },
      as,
    );
    expect(confirm.statusCode).toBe(409);
    expect(await start(as)).not.toBe(first);
  });
});
