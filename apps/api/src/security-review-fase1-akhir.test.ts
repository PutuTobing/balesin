/**
 * Review keamanan AKHIR Fase 1 (lintas fitur: undangan + email pengirim + sesi + ringkasan keamanan).
 * Laporan: docs/security-reviews/2026-11-15-fase1-akhir.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka. Setelah celahnya diperbaiki, Vitest melaporkan tes
 * `it.fails` itu gagal: hapus `.fails`-nya, dan jangan melemahkan asersinya.
 *
 * T1 dan T2 sudah ditutup (undangan & email pengirim wajib konfirmasi identitas untuk semua peran;
 * anggota baru dan perubahan jalur kirim oleh Owner tampil di ringkasan keamanan). Tes yang dulu
 * "BUKTI T1" (rantai serangan yang masih berhasil) kini PENJAGA: rantai yang sama terbukti gagal.
 * Aksi SAH di tes ini (oleh pemilik akun yang tahu password + kode) menyertakan `confirmation`.
 *
 * Model penyerang: cookie sesi Owner/Admin CURIAN (sesi penuh, token CSRF bisa dibaca dari
 * `GET /auth/me` oleh pemegang cookie) — TANPA password dan TANPA kode 2FA korban. Keputusan
 * 2026-11-14 (DECISIONS.md): "Cookie Owner/Admin curian tidak cukup untuk mengambil alih tim".
 */
import { auditLogs, emailSettings, userInvitations, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  invitationIssuedResponseSchema,
  readTokenFromFragment,
  securitySummaryResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  confirmationOf,
  mailpitSettings,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-review-fase1-akhir-01';
const ATTACKER_PASSWORD = 'gerimis-ladang-pinus-kelabu-07';

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

/** Hanya yang dipegang pencuri cookie: cookie + token CSRF (tanpa password/kode). */
const stolen = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

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

async function invitationsFor(email: string) {
  return harness.db.select().from(userInvitations).where(eq(userInvitations.email, email));
}

async function securitySummary() {
  const response = await call(
    harness.app,
    'GET',
    API_ROUTES.audit.securitySummary,
    undefined,
    stolen(owner),
  );
  expect(response.statusCode).toBe(200);
  return securitySummaryResponseSchema.parse(response.json());
}

describe('T1 — undangan dari cookie curian menjadi akun berwewenang yang menetap', () => {
  it('cookie Owner curian (tanpa password/kode) tidak bisa mengundang Admin baru', async () => {
    const email = 'admin-bayangan@penyerang.test';
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      { email, role: 'admin' },
      stolen(owner),
    );

    // Celah: 201 + tautan undangan (email pengirim belum diatur) atau email ke kotak masuk
    // penyerang. Seharusnya: wajib konfirmasi ulang identitas seperti aksi kelola pengguna lain.
    expect(response.statusCode).not.toBe(201);
    expect(await invitationsFor(email)).toEqual([]);
  });

  it('cookie Admin curian (tanpa password/kode) tidak bisa mengundang Supervisor baru', async () => {
    const admin = await member('admin');
    const email = 'supervisor-bayangan@penyerang.test';
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      { email, role: 'supervisor' },
      stolen(admin),
    );

    expect(response.statusCode).not.toBe(201);
    expect(await invitationsFor(email)).toEqual([]);
  });

  it('penjaga (dulu BUKTI T1): rantai "cookie Owner curian → Admin bayangan yang menetap" kini gagal', async () => {
    // Langkah 2 rantai lama: undangan dari cookie curian saja → ditolak, tidak ada yang tersimpan.
    const email = 'admin-bayangan@penyerang.test';
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      { email, role: 'admin' },
      stolen(owner),
    );
    expect(created.statusCode).toBe(400);
    expect(JSON.stringify(created.json())).toContain('confirmation.password');
    expect(await invitationsFor(email)).toEqual([]);

    // Lapis kedua: undangan yang SEMPAT terbit dari sebuah sesi ikut batal begitu pemilik akun
    // "mengeluarkan sesi lain" dari perangkat lain — tidak ada akses menetap yang tersisa.
    const issued = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      await withConfirmation(owner, { email, role: 'admin' }),
      stolen(owner),
    );
    expect(issued.statusCode).toBe(201);
    const { link } = invitationIssuedResponseSchema.parse(issued.json());
    const token = readTokenFromFragment(new URL(link ?? 'http://x.invalid').hash);
    const recovery = await login(harness.app);
    const revoked = await call(
      harness.app,
      'POST',
      API_ROUTES.sessions.revokeOthers,
      await confirmationOf(recovery),
      stolen(recovery),
    );
    expect(revoked.statusCode).toBe(200);
    const [row] = await invitationsFor(email);
    expect(row?.revokedAt).not.toBeNull();

    const accepted = await call(harness.app, 'POST', API_ROUTES.invitations.accept, {
      token,
      name: 'Admin Bayangan',
      password: ATTACKER_PASSWORD,
    });
    expect(accepted.statusCode).not.toBe(201);
    expect(
      await harness.db.select({ id: users.id }).from(users).where(eq(users.email, email)),
    ).toEqual([]);
  });

  it('anggota baru dari undangan (pembuat bukan Owner) muncul di ringkasan keamanan Owner', async () => {
    const admin = await member('admin');
    const email = 'cs-bayangan@penyerang.test';
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      await withConfirmation(admin, { email, role: 'cs' }),
      stolen(admin),
    );
    expect(created.statusCode).toBe(201);
    const { link } = invitationIssuedResponseSchema.parse(created.json());
    const token = readTokenFromFragment(new URL(link ?? 'http://x.invalid').hash);
    const accepted = await call(harness.app, 'POST', API_ROUTES.invitations.accept, {
      token,
      name: 'CS Bayangan',
      password: ATTACKER_PASSWORD,
    });
    expect(accepted.statusCode).toBe(201);

    // Celah: tidak ada jenis kejadian untuk "undangan dibuat/diterima" — banner Owner diam,
    // dan untuk peran tanpa 2FA wajib (CS/Teknisi) Owner juga tidak menerima email apa pun.
    const summary = await securitySummary();
    expect(summary.events.length).toBeGreaterThan(0);
  });
});

describe('T2 — cookie Owner curian membelokkan email pengirim diam-diam', () => {
  /** `confirmed`: pemilik akun sah (password + kode); tanpa itu = pemegang cookie curian. */
  async function saveAs(
    signed: SignedIn,
    overrides: Parameters<typeof mailpitSettings>[0] = {},
    confirmed = false,
  ) {
    const body = mailpitSettings(overrides);
    return call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      confirmed ? await withConfirmation(signed, body) : body,
      stolen(signed),
    );
  }

  it('mengganti server email pengirim wajib konfirmasi ulang identitas (juga Owner)', async () => {
    expect((await saveAs(owner, {}, true)).statusCode).toBe(200);

    const response = await saveAs(owner, { host: '127.0.0.2', password: 'sandi-smtp-penyerang' });

    // Celah: 200. Setelah ini SEMUA email (tautan undangan, tautan reset CS/Teknisi tanpa 2FA,
    // pemberitahuan keamanan untuk Owner) lewat server penyerang.
    expect(response.statusCode).not.toBe(200);
    const [stored] = await harness.db
      .select({ host: emailSettings.host })
      .from(emailSettings)
      .where(eq(emailSettings.organizationId, owner.session.organization.id));
    expect(stored?.host).not.toBe('127.0.0.2');
  });

  it('perubahan server email oleh Owner tetap tercatat di ringkasan keamanan', async () => {
    expect((await saveAs(owner, {}, true)).statusCode).toBe(200);
    expect((await saveAs(owner, { host: '127.0.0.2' }, true)).statusCode).toBe(200);

    // Celah: `email_sender_changed` hanya untuk pelaku selain Owner; tidak ada email ke Owner
    // (lain) juga. Pencuri cookie Owner tidak meninggalkan jejak di banner.
    const summary = await securitySummary();
    expect(summary.events.map((event) => event.kind)).toContain('email_sender_changed');
  });

  it('penjaga: perubahan oleh Admin tetap diberitahukan ke Owner lewat pengaturan LAMA', async () => {
    expect((await saveAs(owner, {}, true)).statusCode).toBe(200);
    const admin = await member('admin');
    harness.emailSettingsNotices.length = 0;

    expect((await saveAs(admin, { host: '127.0.0.2' }, true)).statusCode).toBe(200);

    expect(harness.emailSettingsNotices).toHaveLength(1);
    const summary = await securitySummary();
    expect(summary.events.map((event) => event.kind)).toContain('email_sender_changed');
  });
});

describe('penjaga lintas fitur yang sudah benar', () => {
  it('pencabutan wewenang Admin (turun jadi CS) membatalkan undangan terbitannya yang masih terbuka', async () => {
    const admin = await member('admin');
    const email = 'teknisi-baru@majujaya.test';
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      await withConfirmation(admin, { email, role: 'teknisi' }),
      stolen(admin),
    );
    expect(created.statusCode).toBe(201);
    const { link } = invitationIssuedResponseSchema.parse(created.json());
    const token = readTokenFromFragment(new URL(link ?? 'http://x.invalid').hash);

    // Diturunkan langsung di DB (jalur API sudah diuji team.integration): penerbit tidak lagi
    // berhak mengundang → undangan tidak bisa diterima (invitationIssuerAuthorized).
    await harness.db
      .update(users)
      .set({ role: 'cs' })
      .where(and(eq(users.organizationId, owner.session.organization.id), eq(users.id, admin.id)));

    const accepted = await call(harness.app, 'POST', API_ROUTES.invitations.accept, {
      token,
      name: 'Teknisi Baru',
      password: ATTACKER_PASSWORD,
    });
    expect(accepted.statusCode).not.toBe(201);
    expect(
      await harness.db.select({ id: users.id }).from(users).where(eq(users.email, email)),
    ).toEqual([]);
  });

  it('cookie CS curian: semua rute pengaturan/tim/audit ditolak dan penolakannya diaudit', async () => {
    const cs = await member('cs');
    const attempts = [
      call(harness.app, 'PUT', API_ROUTES.settings.email, mailpitSettings(), stolen(cs)),
      call(
        harness.app,
        'POST',
        API_ROUTES.invitations.collection,
        { email: 'x@penyerang.test', role: 'cs' },
        stolen(cs),
      ),
      call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, stolen(cs)),
    ];
    for (const response of await Promise.all(attempts)) expect(response.statusCode).toBe(403);
    const denied = await harness.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'auth.access.denied'), eq(auditLogs.actorUserId, cs.id)));
    expect(denied.length).toBeGreaterThan(0);
  });
});
