/**
 * Review keamanan AKHIR Fase 1 — putaran 2 (perbaikan commit 1843905).
 * Laporan: docs/security-reviews/2026-11-15-fase1-akhir.md bagian "Putaran 2".
 *
 * Pola: `it(...)` = penjaga regresi; `it.fails(...)` = celah yang masih terbuka (hapus `.fails`
 * setelah diperbaiki, jangan melemahkan asersinya).
 *
 * Fokus: lapis kedua T1 — undangan terbuka dibatalkan bila sesi penerbitnya dicabut untuk
 * pemulihan (`issued_session_id`, migrasi 0009). Prasyarat penyerang di sini lebih berat daripada
 * T1 putaran 1: ia sempat memegang password + satu kode 2FA korban (mis. kode cadangan yang
 * dicuri) sehingga bisa lolos konfirmasi identitas saat mengundang.
 */
import { userInvitations } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, type UserRole } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  login,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-review-akhir-putaran2-01';

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

const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

async function member(role: UserRole): Promise<SignedIn & { id: string; email: string }> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    email,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { ...(await login(harness.app, { email, password: PASSWORD })), id: user.id, email };
}

async function invite(signed: SignedIn, email: string, role: UserRole) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.invitations.collection,
    await withConfirmation(signed, { email, role }),
    as(signed),
  );
  expect(response.statusCode).toBe(201);
}

async function revokedAtOf(email: string) {
  const [row] = await harness.db
    .select({ revokedAt: userInvitations.revokedAt })
    .from(userInvitations)
    .where(eq(userInvitations.email, email));
  if (!row) throw new Error('Undangan tidak ada');
  return row.revokedAt;
}

describe('N2 — pembatalan undangan saat pemulihan hanya mengenai sesi yang MASIH hidup', () => {
  it('penjaga: sesi penerbit yang masih hidup dikeluarkan → undangannya batal', async () => {
    const intruder = await login(harness.app); // sesi kedua milik Owner (dipegang penyerang)
    await invite(intruder, 'bayangan-1@penyerang.test', 'admin');

    const revoked = await call(
      harness.app,
      'POST',
      API_ROUTES.sessions.revokeOthers,
      await confirmationOf(owner),
      as(owner),
    );
    expect(revoked.statusCode).toBe(200);
    expect(await revokedAtOf('bayangan-1@penyerang.test')).not.toBeNull();
  });

  it.fails(
    'penyerang KELUAR dulu setelah mengundang → "keluarkan sesi lain" korban tetap membatalkan undangannya',
    async () => {
      const intruder = await login(harness.app);
      await invite(intruder, 'bayangan-2@penyerang.test', 'admin');
      // Penyerang menutup jejak: sesinya dicabut lewat keluar biasa (atau dibiarkan kedaluwarsa).
      const logout = await call(harness.app, 'POST', API_ROUTES.auth.logout, {}, as(intruder));
      expect(logout.statusCode).toBeLessThan(300);

      const revoked = await call(
        harness.app,
        'POST',
        API_ROUTES.sessions.revokeOthers,
        await confirmationOf(owner),
        as(owner),
      );
      expect(revoked.statusCode).toBe(200);

      // Celah: hanya sesi yang dicabut OLEH pemulihan ini yang dihitung; sesi penerbit sudah mati,
      // jadi undangan Admin buatan penyerang tetap terbuka dan bisa diterima.
      expect(await revokedAtOf('bayangan-2@penyerang.test')).not.toBeNull();
    },
  );

  it.fails(
    'Owner mengeluarkan semua sesi Admin yang dicurigai → undangan yang diterbitkan sesi-sesi itu batal',
    async () => {
      const admin = await member('admin');
      await invite(admin, 'bayangan-3@penyerang.test', 'supervisor');

      const response = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.team.revokeAllSessions, { userId: admin.id }),
        await confirmationOf(owner),
        as(owner),
      );
      expect(response.statusCode).toBe(200);

      // Celah: `signOutEverywhere` (team) tidak memakai `cancelIssuedInvitations`, padahal ini
      // langkah pemulihan yang paling mungkin dilakukan Owner sebelum (atau tanpa) menonaktifkan.
      expect(await revokedAtOf('bayangan-3@penyerang.test')).not.toBeNull();
    },
  );
});
