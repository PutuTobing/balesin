/**
 * Review keamanan Fase 1 butir 6: manajemen pengguna, sesi aktif, audit log (commit 4141fcd).
 * Laporan: docs/security-reviews/2026-11-14-fase1-tim-audit.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka. Setelah celahnya diperbaiki, Vitest melaporkan tes
 * `it.fails` itu gagal: hapus `.fails`-nya, dan jangan melemahkan asersinya. Saat ini tidak ada
 * `it.fails` di berkas ini: T1–T5 sudah ditutup.
 *
 * Balapan dibuat DETERMINISTIK: tes memegang kunci baris (`FOR UPDATE`) di transaksi sendiri,
 * menunggu sampai permintaan API benar-benar menunggu kunci itu (`pg_stat_activity`), lalu
 * mengubah baris dan melepas kunci — persis "permintaan lain menang tipis".
 */
import { accountTokenDeliveryContext, createSecretBox, Secret } from '@balesin/core';
import { accountTokens, auditLogs, userSessions, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  activeSessionListResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  OWNER,
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  mailpitSettings,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-review-tim-audit-01';

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

const as = (signed: { cookie: string; csrf: string }) => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

interface Member extends SignedIn {
  id: string;
  email: string;
}

async function member(role: UserRole, name = `Pengguna ${role}`): Promise<Member> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    email,
    name,
    passwordHash: await hasher.hash(PASSWORD),
  });
  const signed = await login(harness.app, { email, password: PASSWORD });
  return { ...signed, id: user.id, email };
}

async function confirmationOf(email: string, password: string) {
  return { password, code: await freshTotpCode(email) };
}

async function userRow(id: string) {
  const [row] = await harness.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error('Pengguna tidak ada');
  return row;
}

/**
 * Menjalankan `request` sementara baris `users.id = lockedUserId` dikunci tes. Setelah permintaan
 * itu terbukti menunggu kunci baris, `meanwhile` dijalankan di transaksi yang memegang kunci, lalu
 * kunci dilepas (commit).
 */
async function whileRowLocked<T>(
  lockedUserId: string,
  request: () => Promise<T>,
  meanwhile: (tx: Parameters<Parameters<typeof harness.db.transaction>[0]>[0]) => Promise<void>,
): Promise<T> {
  let pending: Promise<T> | undefined;
  await harness.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${lockedUserId} for update`);
    pending = request();
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = await harness.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      const n = Number((waiting.rows as Array<{ n: number }>)[0]?.n ?? 0);
      if (n > 0) break;
      if (Date.now() > deadline)
        throw new Error('Permintaan API tidak pernah menunggu kunci baris');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await meanwhile(tx);
  });
  if (!pending) throw new Error('Permintaan tidak berjalan');
  return pending;
}

// ── Penjaga regresi ─────────────────────────────────────────────────────────

describe('penjaga: eskalasi & konfirmasi identitas', () => {
  it('Admin tidak bisa menaikkan siapa pun ke Admin/Owner, mengubah peran dirinya, atau menyentuh Admin lain', async () => {
    const admin = await member('admin');
    const otherAdmin = await member('admin', 'Admin Lain');
    const cs = await member('cs');
    const confirm = () => confirmationOf(admin.email, PASSWORD);

    const toAdmin = await call(
      harness.app,
      'PUT',
      apiPath(API_ROUTES.team.role, { userId: cs.id }),
      { role: 'admin', ...(await confirm()) },
      as(admin),
    );
    expect(toAdmin.statusCode).toBe(403);
    const toOwner = await call(
      harness.app,
      'PUT',
      apiPath(API_ROUTES.team.role, { userId: cs.id }),
      { role: 'owner', ...(await confirm()) },
      as(admin),
    );
    expect(toOwner.statusCode).toBe(400);
    const self = await call(
      harness.app,
      'PUT',
      apiPath(API_ROUTES.team.role, { userId: admin.id }),
      { role: 'supervisor', ...(await confirm()) },
      as(admin),
    );
    expect(self.statusCode).toBe(403);
    for (const route of [
      API_ROUTES.team.disable,
      API_ROUTES.team.resetTwoFactor,
      API_ROUTES.team.unlock,
      API_ROUTES.team.revokeAllSessions,
    ]) {
      const response = await call(
        harness.app,
        'POST',
        apiPath(route, { userId: otherAdmin.id }),
        await confirm(),
        as(admin),
      );
      expect(response.statusCode, route).toBe(403);
    }
    expect((await userRow(cs.id)).role).toBe('cs');
    expect((await userRow(otherAdmin.id)).disabledAt).toBeNull();
  });

  it('konfirmasi identitas memakai password + kode PELAKU — password/kode sasaran ditolak', async () => {
    const admin = await member('admin');
    const supervisor = await member('supervisor');
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.team.disable, { userId: supervisor.id }),
      { password: PASSWORD, code: await freshTotpCode(supervisor.email) },
      as(owner),
    );
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.field).toBe('password');
    // Kode pelaku lain (Admin) dengan password Owner juga ditolak.
    const mixed = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.team.disable, { userId: supervisor.id }),
      { password: OWNER.password, code: await freshTotpCode(admin.email) },
      as(owner),
    );
    expect(mixed.statusCode).toBe(400);
    expect((await userRow(supervisor.id)).disabledAt).toBeNull();
  });

  it('cookie Admin curian tanpa password: tebakan password konfirmasi dibatasi 5 lalu 429', async () => {
    const admin = await member('admin');
    const cs = await member('cs');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.team.disable, { userId: cs.id }),
        { password: `tebakan-salah-nomor-${i}`, code: '000000' },
        as(admin),
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);
    expect((await userRow(cs.id)).disabledAt).toBeNull();
  });
});

describe('penjaga: R3 tidak bisa dipotong lewat atur ulang password', () => {
  it('akun Admin yang batas pendaftarannya lewat: atur ulang password berhasil tetapi tetap tidak bisa masuk', async () => {
    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      await withConfirmation(owner, mailpitSettings()),
      as(owner),
    );
    expect(saved.statusCode).toBe(200);
    const email = `admin-r3-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
    const expired = await insertUser(harness.db, owner.session.organization.id, {
      role: 'admin',
      email,
      name: 'Admin Lewat Batas',
      passwordHash: await hasher.hash(PASSWORD),
      createdAt: new Date(Date.now() - 100 * 3600_000),
      twoFactorEnrollmentDueAt: new Date(Date.now() - 3600_000),
    });

    const requested = await call(harness.app, 'POST', API_ROUTES.passwordReset.request, { email });
    expect(requested.statusCode).toBe(202);
    await harness.app.backgroundTasks.drain();
    const [tokenRow] = await harness.db
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.userId, expired.id));
    if (!tokenRow?.deliveryTokenEncrypted) throw new Error('Tidak ada token');
    const token = createSecretBox(new Secret(TEST_MASTER_KEY)).decrypt(
      tokenRow.deliveryTokenEncrypted,
      accountTokenDeliveryContext(tokenRow.organizationId, tokenRow.id),
    );
    const newPassword = 'layang-layang-senja-merah';
    const completed = await call(harness.app, 'POST', API_ROUTES.passwordReset.complete, {
      token,
      password: newPassword,
    });
    expect(completed.statusCode).toBe(200);
    expect(String(completed.headers['set-cookie'] ?? '')).not.toMatch(/balesin.*sesi=[^;]/i);
    const sessions = await harness.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, expired.id), isNull(userSessions.revokedAt)));
    expect(sessions).toHaveLength(0);

    const loginAfter = await call(harness.app, 'POST', API_ROUTES.auth.login, {
      email,
      password: newPassword,
    });
    expect(loginAfter.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(loginAfter.json()).error.code).toBe(
      'TWO_FACTOR_ENROLLMENT_EXPIRED',
    );
  });
});

describe('penjaga: audit tidak bocor lintas organisasi & tidak memuat rahasia', () => {
  it('saringan userId/targetId ke pengguna organisasi lain → kosong; metadata bersandi tersensor', async () => {
    const otherOrg = '00000000-0000-4000-8000-00000000abcd';
    const list = await call(
      harness.app,
      'GET',
      `${API_ROUTES.audit.list}?userId=${otherOrg}`,
      undefined,
      as(owner),
    );
    expect(list.statusCode).toBe(200);
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(0);

    // Baris lama yang ditulis "penulis lupa" dengan kunci rahasia: tetap disensor saat dikirim.
    await harness.db.insert(auditLogs).values({
      organizationId: owner.session.organization.id,
      actorUserId: owner.session.user.id,
      action: 'settings.email.updated',
      targetType: 'email_settings',
      metadata: { password: 'rahasia-smtp-bocor', accessToken: 'EAAG-token-meta', host: 'smtp.x' },
    });
    const listed = await call(harness.app, 'GET', API_ROUTES.audit.list, undefined, as(owner));
    expect(listed.body).not.toContain('rahasia-smtp-bocor');
    expect(listed.body).not.toContain('EAAG-token-meta');
    const exported = await call(harness.app, 'GET', API_ROUTES.audit.export, undefined, as(owner));
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('rahasia-smtp-bocor');
    expect(exported.body).not.toContain('EAAG-token-meta');
  });
});

// ── Celah yang sudah ditutup (dulu it.fails T1–T5) ───────────────────────────────────────────────────────────

describe('ditutup: pemeriksaan ulang di dalam transaksi memakai keadaan basi', () => {
  it('T1: Supervisor dinaikkan ke Admin oleh Owner tepat saat Admin mengatur ulang 2FA-nya → aksi Admin tidak boleh berhasil', async () => {
    const admin = await member('admin');
    const supervisor = await member('supervisor');
    const confirmation = await confirmationOf(admin.email, PASSWORD);

    const response = await whileRowLocked(
      supervisor.id,
      () =>
        call(
          harness.app,
          'POST',
          apiPath(API_ROUTES.team.resetTwoFactor, { userId: supervisor.id }),
          confirmation,
          as(admin),
        ),
      async (tx) => {
        // "Permintaan Owner" yang menang tipis: Supervisor kini Admin.
        await tx.update(users).set({ role: 'admin' }).where(eq(users.id, supervisor.id));
      },
    );

    const after = await userRow(supervisor.id);
    expect(after.role).toBe('admin');
    // Matriks kelola: Admin tidak boleh mengatur ulang 2FA Admin lain.
    expect(response.statusCode).not.toBe(200);
    expect(after.totpEnabledAt).not.toBeNull();
  });

  it('T2: Owner yang diturunkan ke Admin tepat saat memberi peran Admin → peran Admin tidak boleh diberikan', async () => {
    const second = await member('owner', 'Owner Kedua');
    const cs = await member('cs');
    const confirmation = await confirmationOf(second.email, PASSWORD);

    const response = await whileRowLocked(
      second.id,
      () =>
        call(
          harness.app,
          'PUT',
          apiPath(API_ROUTES.team.role, { userId: cs.id }),
          { role: 'admin', ...confirmation },
          as(second),
        ),
      async (tx) => {
        // "Owner pertama" menurunkan Owner kedua menjadi Admin, menang tipis.
        await tx.update(users).set({ role: 'admin' }).where(eq(users.id, second.id));
      },
    );

    expect((await userRow(second.id)).role).toBe('admin');
    // Admin (peran pelaku SEKARANG) tidak boleh memberi peran Admin.
    expect(response.statusCode).not.toBe(200);
    expect((await userRow(cs.id)).role).toBe('cs');
  });
});

describe('ditutup: saling menurunkan Owner bersamaan', () => {
  it('T3: dua Owner saling menurunkan bersamaan → yang kalah mendapat 409/403 (bukan 500 deadlock)', async () => {
    const second = await member('owner', 'Owner Kedua');
    const [confirmA, confirmB] = [
      await confirmationOf(OWNER.email, OWNER.password),
      await confirmationOf(second.email, PASSWORD),
    ];
    let pending: Promise<Array<Awaited<ReturnType<typeof call>>>> | undefined;
    // Tes memegang advisory lock "perubahan Owner" organisasi ini, supaya kedua permintaan
    // pasti sudah mengunci baris pelakunya (`lockActor` FOR SHARE) sebelum salah satunya lanjut.
    await harness.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`team-owner|${owner.session.organization.id}`}, 0))`,
      );
      pending = Promise.all([
        call(
          harness.app,
          'PUT',
          apiPath(API_ROUTES.team.role, { userId: second.id }),
          { role: 'admin', ...confirmA },
          as(owner),
        ),
        call(
          harness.app,
          'PUT',
          apiPath(API_ROUTES.team.role, { userId: owner.session.user.id }),
          { role: 'admin', ...confirmB },
          as(second),
        ),
      ]);
      await waitForLockWaiters(2);
    });
    if (!pending) throw new Error('Permintaan tidak berjalan');
    const results = await pending;
    const statuses = results.map((response) => response.statusCode).sort();
    // Invarian tetap terjaga: tepat satu berhasil, Owner aktif tersisa satu.
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    const owners = await harness.db
      .select()
      .from(users)
      .where(and(eq(users.role, 'owner'), isNull(users.disabledAt)));
    expect(owners).toHaveLength(1);
    // Yang kalah seharusnya jawaban terkendali (409/403), bukan 500 karena deadlock.
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
  });
});

describe('ditutup: ekspor audit bisa dipicu lintas situs', () => {
  it('T4: navigasi tingkat atas dari situs lain (Sec-Fetch-Site: cross-site, tanpa Origin) tidak boleh mengunduh audit / memakai jatah ekspor', async () => {
    const response = await call(harness.app, 'GET', API_ROUTES.audit.export, undefined, {
      cookie: owner.cookie,
      origin: null,
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(response.statusCode).toBe(403);
    const exportedRows = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'audit.exported'));
    expect(exportedRows).toHaveLength(0);
  });
});

describe('ditutup: mengeluarkan sesi sendiri tanpa konfirmasi', () => {
  it('T5: cookie LAMA yang dicuri tidak boleh mengeluarkan sesi BARU pemilik (yang masuk ulang untuk mengusir pencuri) tanpa password', async () => {
    // Pencuri memegang cookie sesi lama milik CS (dicuri dari perangkatnya); tidak tahu password.
    const thief = await member('cs');
    // Pemilik masuk lagi dari perangkat lain (sesi lebih baru) — mis. untuk membuka "Sesi aktif".
    const owned = await login(harness.app, { email: thief.email, password: PASSWORD });
    const listed = activeSessionListResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.sessions.list, undefined, as(thief))).json(),
    );
    const newer = listed.sessions.find((session) => !session.current);
    if (!newer) throw new Error('Sesi baru pemilik tidak ada');
    expect(Date.parse(newer.createdAt)).toBeGreaterThanOrEqual(
      Date.parse(listed.sessions.find((session) => session.current)?.createdAt ?? ''),
    );
    const revoked = await call(
      harness.app,
      'DELETE',
      apiPath(API_ROUTES.sessions.revoke, { sessionId: newer.id }),
      undefined,
      as(thief),
    );
    // Usulan: mengeluarkan sesi yang LEBIH BARU dari sesi pemanggil butuh konfirmasi identitas.
    expect(revoked.statusCode).not.toBe(200);
    const ownerMe = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(owned));
    expect(ownerMe.statusCode).toBe(200);
  });
});

/** Menunggu sampai sedikitnya `count` koneksi di database tes ini menunggu kunci. */
async function waitForLockWaiters(count: number) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waiting = await harness.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number((waiting.rows as Array<{ n: number }>)[0]?.n ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Kurang dari ${count} permintaan menunggu kunci`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
