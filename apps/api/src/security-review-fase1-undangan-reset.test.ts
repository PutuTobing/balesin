/**
 * Review keamanan Fase 1 butir 4 — undangan, atur ulang password, verifikasi email, template email
 * bermerek (commit 5affb46). Laporan: docs/security-reviews/2026-11-14-fase1-undangan-reset.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka. Setelah celahnya diperbaiki, Vitest melaporkan tes
 * `it.fails` itu gagal — hapus `.fails`-nya. Saat ini tidak ada `it.fails` di berkas ini: R1 dan R2
 * sudah ditutup (asersinya tidak diubah).
 */
import {
  accountTokenDeliveryContext,
  createSecretBox,
  renderInvitationEmail,
  Secret,
} from '@balesin/core';
import { accountTokens, auditLogs, organizations, userInvitations, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  emailTemplatePreviewResponseSchema,
  invitationIssuedResponseSchema,
  meResponseSchema,
  readTokenFromFragment,
  type InvitableRole,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import { TEST_APP_ORIGIN } from './testing/build-test-app';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  mailpitSettings,
  TEST_MASTER_KEY,
  type CallOptions,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

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
const inv = API_ROUTES.invitations;
const reset = API_ROUTES.passwordReset;
const STRONG_PASSWORD = 'gerimis-pagi-di-pelabuhan';

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

async function invited(signed: SignedIn, email: string, role: InvitableRole) {
  const response = await call(
    harness.app,
    'POST',
    inv.collection,
    await withConfirmation(signed, { email, role }),
    as(signed),
  );
  if (response.statusCode !== 201) throw new Error(`Undangan gagal: ${response.body}`);
  return invitationIssuedResponseSchema.parse(response.json());
}

function tokenFromLink(link: string | null): string {
  if (!link) throw new Error('Tidak ada tautan');
  const token = readTokenFromFragment(new URL(link).hash);
  if (!token) throw new Error('Tautan tanpa token');
  return token;
}

async function userWithRole(owner: SignedIn, role: UserRole, password: string) {
  return insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(password),
  });
}

async function sessionFor(owner: SignedIn, role: UserRole): Promise<SignedIn> {
  const password = `sandi-${role}-review-b4-01`;
  const user = await userWithRole(owner, role, password);
  return login(harness.app, { email: user.email, password });
}

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

/** Minta tautan atur ulang lalu ambil tokennya dari salinan untuk worker (seperti isi email). */
async function resetTokenFor(email: string, options: CallOptions = {}): Promise<string> {
  const response = await call(harness.app, 'POST', reset.request, { email }, options);
  if (response.statusCode !== 202) throw new Error(`Minta reset gagal: ${response.body}`);
  await harness.app.backgroundTasks.drain();
  const [row] = await harness.db
    .select()
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.email, email),
        isNull(accountTokens.usedAt),
        isNull(accountTokens.revokedAt),
      ),
    );
  if (!row?.deliveryTokenEncrypted) throw new Error('Tidak ada token');
  return box.decrypt(
    row.deliveryTokenEncrypted,
    accountTokenDeliveryContext(row.organizationId, row.id),
  );
}

// ── Celah yang masih terbuka ────────────────────────────────────────────────

describe('celah yang sudah ditutup (dulu it.fails)', () => {
  it('R1: Admin tidak bisa membatalkan undangan Admin buatan Owner dengan membuat undangan baru untuk email yang sama', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await sessionFor(owner, 'admin');
    const ownerInvite = await invited(owner, 'calon-admin@majujaya.test', 'admin');
    await harness.db
      .update(userInvitations)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(userInvitations.id, ownerInvite.invitation.id));

    // Admin tidak boleh "mengelola" undangan Admin (kirim ulang/batalkan → 403)…
    const resend = await call(
      harness.app,
      'POST',
      apiPath(inv.resend, { invitationId: ownerInvite.invitation.id }),
      await withConfirmation(admin, {}),
      as(admin),
    );
    expect(resend.statusCode).toBe(403);

    // …dan membuat undangan CS untuk email yang sama juga tidak boleh diam-diam membatalkan
    // undangan Owner itu (dulu bisa).
    const replace = await call(
      harness.app,
      'POST',
      inv.collection,
      await withConfirmation(admin, { email: 'calon-admin@majujaya.test', role: 'cs' }),
      as(admin),
    );
    const [row] = await harness.db
      .select({ revokedAt: userInvitations.revokedAt })
      .from(userInvitations)
      .where(eq(userInvitations.id, ownerInvite.invitation.id));
    expect(row?.revokedAt).toBeNull();
    expect(replace.statusCode).toBe(403);
  });

  it('R2: undangan dari pengundang yang sudah dinonaktifkan tidak bisa dibuka/diterima', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await sessionFor(owner, 'admin');
    const issued = await invited(admin, 'kenalan-admin@majujaya.test', 'supervisor');
    const token = tokenFromLink(issued.link);

    // Akun Admin yang membuat undangan dinonaktifkan (mis. ketahuan dibobol).
    await harness.db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, admin.session.user.id));

    const accepted = await call(harness.app, 'POST', inv.accept, {
      token,
      name: 'Kenalan Penyerang',
      password: STRONG_PASSWORD,
    });
    expect(accepted.statusCode).toBe(410);
  });
});

// ── Penjaga regresi ─────────────────────────────────────────────────────────

describe('eskalasi peran lewat undangan', () => {
  it('Admin: undangan Admin 403, Owner 400; kirim ulang dengan body peran lain tidak mengubah peran; body terima tidak menentukan peran/email', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await sessionFor(owner, 'admin');

    const asAdmin = await call(
      harness.app,
      'POST',
      inv.collection,
      await withConfirmation(admin, { email: 'x1@majujaya.test', role: 'admin' }),
      as(admin),
    );
    expect(asAdmin.statusCode).toBe(403);
    for (const signed of [owner, admin]) {
      const asOwner = await call(
        harness.app,
        'POST',
        inv.collection,
        await withConfirmation(signed, { email: 'x2@majujaya.test', role: 'owner' }),
        as(signed),
      );
      expect(asOwner.statusCode).toBe(400);
    }

    const cs = await invited(admin, 'cs-baru@majujaya.test', 'cs');
    const resent = await call(
      harness.app,
      'POST',
      apiPath(inv.resend, { invitationId: cs.invitation.id }),
      await withConfirmation(admin, { role: 'admin', email: 'lain@majujaya.test' }),
      as(admin),
    );
    expect(resent.statusCode).toBe(200);
    const reissued = invitationIssuedResponseSchema.parse(resent.json());
    expect(reissued.invitation.role).toBe('cs');
    expect(reissued.invitation.email).toBe('cs-baru@majujaya.test');

    const accepted = await call(harness.app, 'POST', inv.accept, {
      token: tokenFromLink(reissued.link),
      name: 'CS Baru',
      password: STRONG_PASSWORD,
      role: 'owner',
      email: 'owner-palsu@majujaya.test',
    });
    expect(accepted.statusCode).toBe(201);
    const me = meResponseSchema.parse(accepted.json());
    expect(me.user.role).toBe('cs');
    expect(me.user.email).toBe('cs-baru@majujaya.test');
    const owners = await harness.db.select().from(users).where(eq(users.role, 'owner'));
    expect(owners).toHaveLength(1);
  });

  it('undangan Owner ditolak juga di database (CHECK)', async () => {
    const owner = await completeSetup(harness.app);
    const issued = await invited(owner, 'cek@majujaya.test', 'cs');
    await expect(
      harness.db
        .update(userInvitations)
        .set({ role: 'owner' })
        .where(eq(userInvitations.id, issued.invitation.id)),
    ).rejects.toThrow();
  });
});

describe('pengambilalihan akun lewat undangan', () => {
  it('menerima undangan untuk email yang (sekarang) sudah punya akun → 410, akun lama tidak berubah', async () => {
    const owner = await completeSetup(harness.app);
    const issued = await invited(owner, 'budi@majujaya.test', 'cs');
    // Akun dengan email itu muncul setelah undangan dibuat (mis. lewat undangan lain/impor).
    const existing = await insertUser(harness.db, owner.session.organization.id, {
      role: 'cs',
      email: 'budi@majujaya.test',
      name: 'Budi Asli',
      passwordHash: await hasher.hash('sandi-budi-asli-0001'),
    });
    const accepted = await call(harness.app, 'POST', inv.accept, {
      token: tokenFromLink(issued.link),
      name: 'Penyerang',
      password: STRONG_PASSWORD,
    });
    expect(accepted.statusCode).toBe(410);
    const [after] = await harness.db.select().from(users).where(eq(users.id, existing.id));
    expect(after?.passwordHash).toBe(existing.passwordHash);
    expect(after?.name).toBe('Budi Asli');
  });

  it('email beda huruf/spasi dianggap alamat yang sama; huruf non-ASCII ditolak', async () => {
    const owner = await completeSetup(harness.app);
    const upper = await call(
      harness.app,
      'POST',
      inv.collection,
      await withConfirmation(owner, { email: '  SARI@MajuJaya.TEST ', role: 'cs' }),
      as(owner),
    );
    // Email Owner (sari@majujaya.test) sudah terdaftar.
    expect(upper.statusCode).toBe(409);
    for (const email of ['sarі@majujaya.test', 'ADMİN@majujaya.test', 'budi@majujaya.test​']) {
      const response = await call(
        harness.app,
        'POST',
        inv.collection,
        await withConfirmation(owner, { email, role: 'cs' }),
        as(owner),
      );
      expect(response.statusCode, email).toBe(400);
    }
  });

  it('8 permintaan terima serentak dengan satu token → tepat satu akun', async () => {
    const owner = await completeSetup(harness.app);
    const issued = await invited(owner, 'balapan@majujaya.test', 'teknisi');
    const token = tokenFromLink(issued.link);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        call(
          harness.app,
          'POST',
          inv.accept,
          { token, name: `Pembalap ${index}`, password: `${STRONG_PASSWORD}-${index}` },
          { ip: `198.51.100.${index + 1}` },
        ),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 410)).toHaveLength(7);
    const created = await harness.db
      .select()
      .from(users)
      .where(eq(users.email, 'balapan@majujaya.test'));
    expect(created).toHaveLength(1);
  });
});

describe('atur ulang password', () => {
  it('enumerasi: status, body, dan nama header jawaban sama untuk email terdaftar, tidak terdaftar, dan nonaktif — juga saat 429', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const disabled = await userWithRole(owner, 'cs', 'sandi-cs-nonaktif-01');
    await harness.db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, disabled.id));

    const shape = (response: Response) => ({
      status: response.statusCode,
      // `requestId` berbeda per permintaan; selebihnya harus identik.
      body: response.body.replace(/"requestId":"[^"]*"/, '"requestId":"-"'),
      headers: Object.keys(response.headers)
        .filter((name) => !['date', 'x-request-id', 'content-length'].includes(name))
        .sort(),
      retryAfter: response.headers['retry-after'] !== undefined,
    });
    const emails = ['sari@majujaya.test', 'tidak-ada@majujaya.test', disabled.email];
    const rounds: Array<Array<ReturnType<typeof shape>>> = [];
    for (let round = 0; round < 4; round += 1) {
      rounds.push(
        await Promise.all(
          emails.map(async (email, index) =>
            shape(
              await call(
                harness.app,
                'POST',
                reset.request,
                { email },
                { ip: `203.0.113.${index + 1}` },
              ),
            ),
          ),
        ),
      );
    }
    await harness.app.backgroundTasks.drain();
    for (const round of rounds) {
      expect(round[1]).toEqual(round[0]);
      expect(round[2]).toEqual(round[0]);
    }
    expect(rounds[0]?.[0]?.status).toBe(202);
    expect(rounds[3]?.[0]?.status).toBe(429);
    // Hanya akun aktif yang mendapat token.
    const tokens = await harness.db.select().from(accountTokens);
    expect([...new Set(tokens.map((row) => row.email))]).toEqual(['sari@majujaya.test']);
  });

  it('6 permintaan selesai serentak dengan satu token (akun tanpa 2FA) → tepat satu berhasil', async () => {
    const owner = await completeSetup(harness.app);
    await configureEmail(owner);
    const cs = await userWithRole(owner, 'cs', 'sandi-cs-lama-0001');
    const token = await resetTokenFor(cs.email);
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(
          harness.app,
          'POST',
          reset.complete,
          { token, password: `${STRONG_PASSWORD}-${index}` },
          { ip: `198.51.100.${index + 20}` },
        ),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 410)).toHaveLength(5);
    const completed = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.password_reset.completed'));
    expect(completed).toHaveLength(1);
  });

  it('token salah tujuan: token reset di verifikasi email, token undangan di reset/verifikasi, dan sebaliknya → 410', async () => {
    const owner = await completeSetup(harness.app);
    const issued = await invited(owner, 'tujuan@majujaya.test', 'cs');
    const invitationToken = tokenFromLink(issued.link);
    await configureEmail(owner);
    const cs = await userWithRole(owner, 'cs', 'sandi-cs-tujuan-01');
    const resetToken = await resetTokenFor(cs.email);

    const verifyWithReset = await call(harness.app, 'POST', API_ROUTES.emailVerification.verify, {
      token: resetToken,
    });
    expect(verifyWithReset.statusCode).toBe(410);
    const acceptWithReset = await call(harness.app, 'POST', inv.accept, {
      token: resetToken,
      name: 'Salah Tujuan',
      password: STRONG_PASSWORD,
    });
    expect(acceptWithReset.statusCode).toBe(410);
    for (const url of [reset.inspect, API_ROUTES.emailVerification.verify]) {
      const response = await call(harness.app, 'POST', url, { token: invitationToken });
      expect(response.statusCode, url).toBe(410);
    }
    const completeWithInvite = await call(harness.app, 'POST', reset.complete, {
      token: invitationToken,
      password: STRONG_PASSWORD,
    });
    expect(completeWithInvite.statusCode).toBe(410);
    // Token reset tetap utuh (percobaan salah tujuan tidak menghabiskannya).
    const inspected = await call(harness.app, 'POST', reset.inspect, { token: resetToken });
    expect(inspected.statusCode).toBe(200);
  });
});

describe('kebocoran token dan tautan', () => {
  it('token undangan/reset tidak ada di log, audit, payload antrean, header, atau error; tautan selalu dari APP_URL', async () => {
    const owner = await completeSetup(harness.app);
    const spoofed: CallOptions = {
      ...as(owner),
      headers: {
        host: 'penyerang.contoh',
        'x-forwarded-host': 'penyerang.contoh',
        'x-forwarded-proto': 'http',
      },
    };
    const created = await call(
      harness.app,
      'POST',
      inv.collection,
      await withConfirmation(owner, { email: 'bocor@majujaya.test', role: 'cs' }),
      spoofed,
    );
    expect(created.statusCode).toBe(201);
    const issued = invitationIssuedResponseSchema.parse(created.json());
    expect(issued.link?.startsWith(`${TEST_APP_ORIGIN}/undangan#token=`)).toBe(true);
    expect(issued.link).not.toContain('penyerang');
    const invitationToken = tokenFromLink(issued.link);
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(created.headers)).not.toContain(invitationToken);

    const wrong = await call(harness.app, 'POST', inv.accept, {
      token: invitationToken,
      name: 'Bocor',
      password: 'pendek',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).not.toContain(invitationToken);
    const accepted = await call(harness.app, 'POST', inv.accept, {
      token: invitationToken,
      name: 'Bocor',
      password: STRONG_PASSWORD,
    });
    expect(accepted.statusCode).toBe(201);
    const reused = await call(harness.app, 'POST', inv.accept, {
      token: invitationToken,
      name: 'Bocor',
      password: STRONG_PASSWORD,
    });
    expect(reused.statusCode).toBe(410);
    expect(reused.body).not.toContain(invitationToken);

    await configureEmail(owner);
    const resetToken = await resetTokenFor('bocor@majujaya.test');
    const done = await call(harness.app, 'POST', reset.complete, {
      token: resetToken,
      password: `${STRONG_PASSWORD}-baru`,
    });
    expect(done.statusCode).toBe(200);
    const [row] = await harness.db.select().from(accountTokens);
    expect(row?.deliveryTokenEncrypted).toBeNull();

    const audit = JSON.stringify(await harness.db.select().from(auditLogs));
    const jobs = JSON.stringify([harness.invitationJobs, harness.accountTokenJobs]);
    for (const token of [invitationToken, resetToken]) {
      expect(harness.logs.text()).not.toContain(token);
      expect(audit).not.toContain(token);
      expect(jobs).not.toContain(token);
    }
    // Hanya hash yang tersimpan; salinan undangan untuk worker sudah dibuang.
    const [invitation] = await harness.db.select().from(userInvitations);
    expect(invitation?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation?.deliveryTokenEncrypted).toBeNull();
  });
});

describe('template email', () => {
  it('nama organisasi/produk/pengundang berisi HTML dan baris baru: di-escape, subjek satu baris (email & pratinjau)', async () => {
    const owner = await completeSetup(harness.app);
    const evil = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
    await harness.db
      .update(organizations)
      .set({ name: `PT ${evil}\r\nBcc: korban@contoh.test`, productName: `Produk ${evil}` })
      .where(eq(organizations.id, owner.session.organization.id));
    await harness.db
      .update(users)
      .set({ name: `Sari ${evil}` })
      .where(eq(users.id, owner.session.user.id));
    // Sesi menyimpan nama lama; masuk ulang supaya pratinjau memakai nama baru.
    const fresh = await login(harness.app);

    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.settings.emailTemplatePreview, { template: 'invitation' }),
      undefined,
      as(fresh),
    );
    expect(response.statusCode).toBe(200);
    const preview = emailTemplatePreviewResponseSchema.parse(response.json());

    const direct = renderInvitationEmail({
      brand: {
        productName: `Produk ${evil}`,
        organizationName: `PT ${evil}\r\nBcc: korban@contoh.test`,
        logoSrc: 'javascript:alert(3)',
        primaryColor: 'red;background:url(https://contoh.test/x)',
      },
      timeZone: 'Asia/Jakarta',
      inviterName: `Sari ${evil}`,
      role: 'cs',
      email: 'target@contoh.test',
      link: 'https://balesin.contoh.test/undangan#token=abc',
      expiresAt: new Date(),
      twoFactorRequired: false,
    });
    for (const mail of [preview, { ...direct, html: direct.html ?? '' }]) {
      expect(mail.html).not.toMatch(/<script/i);
      expect(mail.html).not.toMatch(/<img src=x/i);
      expect(mail.html).not.toContain('javascript:');
      expect(mail.html).not.toContain('url(');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.html).toContain('&lt;script&gt;');
    }
  });
});
