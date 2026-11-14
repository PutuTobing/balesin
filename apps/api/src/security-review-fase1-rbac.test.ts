/**
 * Review keamanan Fase 1 butir 5: RBAC 5 peran + penegakan bawaan-tolak (commit a6a76b4).
 * Laporan: docs/security-reviews/2026-11-14-fase1-rbac.md.
 *
 * Pola: `it(...)` = penjaga regresi (perilaku aman yang sudah benar dan harus tetap benar);
 * `it.fails(...)` = celah yang masih terbuka. Setelah celahnya diperbaiki, Vitest melaporkan tes
 * `it.fails` itu gagal: hapus `.fails`-nya, dan jangan melemahkan asersinya.
 */
import { auditLogs, emailSettings, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  errorEnvelopeSchema,
  hasPermission,
  meResponseSchema,
  permissionScope,
  permissionsForRole,
  USER_ROLES,
  type EmailSettingsInput,
  type Permission,
  type UserRole,
} from '@balesin/shared';
import { and, eq, like, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { requirePermission, type RouteAccess } from './http/route-access';
import { createPasswordHasher } from './modules/auth/password-hasher';
import { TEST_APP_ORIGIN } from './testing/build-test-app';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  mailpitSettings,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-review-rbac-01';

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.rebuild();
  await harness.reset();
  owner = await completeSetup(harness.app);
});
afterAll(async () => {
  await harness?.close();
});

async function signIn(role: UserRole) {
  const user = await insertUser(harness.db, owner.session.organization.id, {
    role,
    email: `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  const signed = await login(harness.app, { email: user.email, password: PASSWORD });
  return { user, signed };
}

const as = (signed: { cookie: string; csrf: string }) => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

const okReply = { 200: z.object({ ok: z.boolean() }) };

// ── Penegakan bawaan-tolak ──────────────────────────────────────────────────

describe('bawaan tolak: celah pendaftaran rute', () => {
  it('rute di plugin anak tanpa deklarasi akses: aplikasi menolak start', async () => {
    await harness.rebuild();
    await harness.app.register((child, _options, done) => {
      child.get('/__tes/lupa-akses', { schema: { response: okReply } }, () => ({ ok: true }));
      done();
    });
    await expect(harness.app.ready()).rejects.toThrow(/belum menyatakan akses/);
  });

  it('izin yang bukan anggota PERMISSIONS (mis. "toString"): aplikasi menolak start', async () => {
    await harness.rebuild();
    harness.app.get(
      '/__tes/izin-asing',
      {
        config: {
          access: { kind: 'permission', permission: 'toString' } as unknown as RouteAccess,
        },
        schema: { response: okReply },
      },
      () => ({ ok: true }),
    );
    await expect(harness.app.ready()).rejects.toThrow(/akses yang tidak dikenal/);
  });

  // Info 1 ditutup: rute modul yang menerima OPTIONS kini membuat aplikasi MENOLAK START (lebih kuat
  // dari "handler tidak pernah jalan" yang sebelumnya bergantung pada plugin CORS). Asersi lama tidak
  // bisa dipertahankan karena `inject` pertama sudah gagal di `ready()`.
  it('rute modul yang juga menerima OPTIONS: aplikasi menolak start, handler tidak pernah jalan', async () => {
    let handled = 0;
    await harness.rebuild();
    harness.app.route({
      method: ['GET', 'OPTIONS'],
      url: '/__tes/opsi',
      config: { access: requirePermission('settings.email.manage') },
      schema: { response: okReply },
      handler: () => {
        handled += 1;
        return { ok: true };
      },
    });
    await expect(
      harness.app.inject({
        method: 'OPTIONS',
        url: '/__tes/opsi',
        headers: { origin: TEST_APP_ORIGIN, 'access-control-request-method': 'GET' },
      }),
    ).rejects.toThrow(/menerima OPTIONS/);
    expect(handled).toBe(0);
  });
});

describe('matriks: pencarian izin tidak boleh tertipu kunci prototipe', () => {
  it('peran tanpa izin: false untuk semua izin yang tidak ada di barisnya', () => {
    for (const role of USER_ROLES) {
      const held = new Set(permissionsForRole(role));
      expect(hasPermission(role, 'broadcast.send')).toBe(held.has('broadcast.send'));
    }
    expect(hasPermission('cs', 'broadcast.send')).toBe(false);
    expect(hasPermission('teknisi', 'inbox.assign')).toBe(false);
  });

  // R2: `ROLE_PERMISSIONS[role]` adalah objek biasa (`{}`), jadi kunci warisan Object.prototype
  // dianggap izin yang dipegang. Hanya terjangkau bila string di luar PERMISSIONS lolos ke
  // `hasPermission`/`permissionScope` (mis. `as Permission`, JSON, atau kode JS polos).
  it('hasPermission/permissionScope: kunci prototipe ("toString", "constructor") = tidak boleh', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(hasPermission('cs', key as Permission), key).toBe(false);
      expect(permissionScope('teknisi', key as Permission), key).toBeNull();
    }
  });
});

// ── Sesi & perubahan peran ──────────────────────────────────────────────────

describe('peran dibaca dari database setiap permintaan', () => {
  it('Admin diturunkan menjadi CS: permintaan berikutnya 403 dan `permissions` ikut berubah', async () => {
    const admin = await signIn('admin');
    const before = await call(
      harness.app,
      'GET',
      API_ROUTES.settings.email,
      undefined,
      as(admin.signed),
    );
    expect(before.statusCode).toBe(200);

    await harness.db.update(users).set({ role: 'cs' }).where(eq(users.id, admin.user.id));

    const after = await call(
      harness.app,
      'GET',
      API_ROUTES.settings.email,
      undefined,
      as(admin.signed),
    );
    expect(after.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(after.json()).error.code).toBe('FORBIDDEN');
    const me = await call(harness.app, 'GET', API_ROUTES.auth.me, undefined, as(admin.signed));
    expect(meResponseSchema.parse(me.json()).permissions).toEqual(permissionsForRole('cs'));
  });
});

// ── Admin + email pengirim ──────────────────────────────────────────────────

function withoutPassword(settings: EmailSettingsInput): EmailSettingsInput {
  const { password: _omitted, ...rest } = settings;
  return rest;
}

describe('Admin dan email pengirim (settings.email.manage)', () => {
  it('Admin tidak bisa membawa password SMTP tersimpan ke host lain (tes koneksi maupun simpan)', async () => {
    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings(),
      as(owner),
    );
    expect(saved.statusCode).toBe(200);
    const [stored] = await harness.db.select().from(emailSettings);
    const admin = await signIn('admin');

    const attacker = withoutPassword(mailpitSettings({ host: 'smtp.penyerang.test' }));
    const tested = await call(
      harness.app,
      'POST',
      API_ROUTES.settings.testEmailConnection,
      { settings: attacker },
      as(admin.signed),
    );
    expect(tested.statusCode).toBe(400);
    expect(JSON.stringify(tested.json())).toContain('settings.password');

    const put = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      attacker,
      as(admin.signed),
    );
    expect(put.statusCode).toBe(400);
    const [unchanged] = await harness.db.select().from(emailSettings);
    expect(unchanged?.host).toBe(stored?.host);
    expect(unchanged?.passwordEncrypted).toBe(stored?.passwordEncrypted);
  });

  // S1: Admin mengganti server SMTP → semua email keamanan (atur ulang password CS/Teknisi,
  // undangan Admin buatan Owner, pemberitahuan 2FA/kode cadangan ke Owner) lewat server miliknya,
  // tanpa Owner tahu. Minimal: Owner diberi tahu setiap kali sambungan/pengirim diubah orang lain.
  // Bila perbaikannya memakai jenis job baru, sesuaikan sumber yang diperiksa — bukan intinya.
  it('Admin mengubah sambungan SMTP: Owner menerima pemberitahuan', async () => {
    const first = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings(),
      as(owner),
    );
    expect(first.statusCode).toBe(200);
    const admin = await signIn('admin');
    await harness.app.backgroundTasks.drain();
    harness.securityNotices.length = 0;
    harness.adminNotices.length = 0;

    const changed = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings({ username: 'pengirim-lain', password: 'sandi-smtp-baru-1234' }),
      as(admin.signed),
    );
    expect(changed.statusCode).toBe(200);

    await harness.app.backgroundTasks.drain();
    // Pemberitahuan "2FA Admin aktif" dari login Admin di atas tidak dihitung.
    // Perbaikan S1 memakai job baru `email-settings-changed` (satu per Owner) → sumbernya ditambah.
    const notices = JSON.stringify([
      ...harness.emailSettingsNotices,
      ...harness.securityNotices,
      ...harness.adminNotices.filter((notice) => notice.event !== 'two_factor_enabled'),
    ]);
    expect(notices).toContain(owner.session.user.id);
  });
});

// ── Audit penolakan di tingkat service ──────────────────────────────────────

describe('audit penolakan (R8)', () => {
  // R1: penolakan aturan rinci modul (Admin mencoba membuat undangan Admin = upaya menaikkan
  // wewenang) tidak meninggalkan jejak; penolakan izin rute meninggalkan `auth.access.denied`.
  it('Admin mencoba mengundang Admin: 403 DAN tercatat di audit', async () => {
    const admin = await signIn('admin');
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.invitations.collection,
      { email: 'admin-kedua@majujaya.test', role: 'admin' },
      as(admin.signed),
    );
    expect(response.statusCode).toBe(403);

    const rows = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, admin.user.id),
          or(like(auditLogs.action, '%denied%'), like(auditLogs.action, '%rejected%')),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });
});
