/**
 * Audit log (ROADMAP Fase 1 butir 6): daftar bersaring + paginasi kursor (termasuk baris dengan
 * waktu sama persis), isolasi organisasi, metadata disaring lagi di respons, ekspor CSV aman dari
 * formula injection, batas laju ekspor, dan ringkasan kejadian keamanan 7 hari.
 */
import { auditLogs, type NewAuditLog } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  auditLogListResponseSchema,
  securitySummaryResponseSchema,
  type AuditLogEntry,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  mailpitSettings,
  type CallOptions,
  type IntegrationHarness,
  type SignedIn,
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

const routes = API_ROUTES.audit;
const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

async function page(signed: SignedIn, params: Record<string, string | number | undefined> = {}) {
  const response = await call(
    harness.app,
    'GET',
    `${routes.list}?${query(params)}`,
    undefined,
    as(signed),
  );
  if (response.statusCode !== 200) throw new Error(`Daftar audit gagal: ${response.body}`);
  return auditLogListResponseSchema.parse(response.json());
}

async function allPages(signed: SignedIn, params: Record<string, string | number | undefined>) {
  const entries: AuditLogEntry[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const body = await page(signed, { ...params, cursor });
    entries.push(...body.entries);
    if (!body.nextCursor) return entries;
    cursor = body.nextCursor;
  }
  throw new Error('Kursor tidak pernah habis');
}

/** Baris audit mentah (melewati `recordAudit`) — untuk menguji penyaringan di sisi baca. */
async function rawAudit(rows: Array<Partial<NewAuditLog> & { organizationId: string }>) {
  await harness.db
    .insert(auditLogs)
    .values(rows.map((row) => ({ action: 'auth.logout', metadata: {}, ...row })));
}

describe('daftar audit', () => {
  it('paginasi kursor: semua baris tepat sekali, termasuk yang waktunya sama persis', async () => {
    const owner = await completeSetup(harness.app);
    const organizationId = owner.session.organization.id;
    const at = new Date('2026-11-10T08:00:00.123Z');
    // 9 baris dengan created_at IDENTIK + 4 baris berbeda mikrodetik.
    await rawAudit(
      Array.from({ length: 9 }, () => ({
        organizationId,
        action: 'user.invitation.created',
        createdAt: at,
      })),
    );
    await rawAudit(
      [1, 2, 3, 4].map((offset) => ({
        organizationId,
        action: 'user.invitation.created',
        createdAt: new Date(at.getTime() + offset),
      })),
    );

    const entries = await allPages(owner, { action: 'user.invitation.created', limit: 4 });
    expect(entries).toHaveLength(13);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(13);
    const times = entries.map((entry) => Date.parse(entry.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('saringan pelaku, pengguna (pelaku atau target), aksi, rentang waktu; input salah → 400', async () => {
    const owner = await completeSetup(harness.app);
    const organizationId = owner.session.organization.id;
    const cs = await insertUser(harness.db, organizationId, { role: 'cs', name: 'Budi CS' });
    await rawAudit([
      { organizationId, actorUserId: cs.id, action: 'auth.logout' },
      {
        organizationId,
        actorUserId: owner.session.user.id,
        action: 'user.disabled',
        targetType: 'user',
        targetId: cs.id,
      },
      {
        organizationId,
        action: 'auth.login.failed',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const byActor = await page(owner, { actorUserId: cs.id });
    expect(byActor.entries.map((entry) => entry.action)).toEqual(['auth.logout']);
    expect(byActor.entries[0]?.actor).toMatchObject({ id: cs.id, name: 'Budi CS', role: 'cs' });

    const aboutCs = await page(owner, { userId: cs.id });
    expect(aboutCs.entries.map((entry) => entry.action).sort()).toEqual([
      'auth.logout',
      'user.disabled',
    ]);
    const disabled = aboutCs.entries.find((entry) => entry.action === 'user.disabled');
    expect(disabled?.target).toEqual({ type: 'user', id: cs.id, name: 'Budi CS' });

    const old = await page(owner, { to: '2026-02-01T00:00:00Z' });
    expect(old.entries.map((entry) => entry.action)).toEqual(['auth.login.failed']);
    const recent = await page(owner, { from: '2026-02-01T00:00:00Z', action: 'auth.login.failed' });
    expect(recent.entries).toHaveLength(0);

    for (const bad of [
      { cursor: 'bukan-kursor' },
      { limit: 500 },
      { action: 'drop table' },
      { actorUserId: 'bukan-uuid' },
      { from: '2026-03-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
    ]) {
      const response = await call(
        harness.app,
        'GET',
        `${routes.list}?${query(bad)}`,
        undefined,
        as(owner),
      );
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('organisasi lain tidak pernah terlihat, juga lewat saringan ID', async () => {
    const owner = await completeSetup(harness.app);
    const other = await insertOrganization(harness.db);
    const stranger = await insertUser(harness.db, other.id, { role: 'owner', name: 'Orang Lain' });
    await rawAudit([
      { organizationId: other.id, actorUserId: stranger.id, action: 'auth.logout' },
      {
        organizationId: other.id,
        action: 'user.disabled',
        targetType: 'user',
        targetId: stranger.id,
      },
    ]);
    // Baris organisasi INI yang menunjuk pengguna organisasi lain sebagai target (tidak mungkin
    // lewat aplikasi): namanya tidak boleh terbaca.
    await rawAudit([
      {
        organizationId: owner.session.organization.id,
        action: 'user.disabled',
        targetType: 'user',
        targetId: stranger.id,
      },
    ]);

    const everything = await allPages(owner, {});
    expect(everything.map((entry) => entry.actor?.id)).not.toContain(stranger.id);
    expect(JSON.stringify(everything)).not.toContain('Orang Lain');
    expect((await page(owner, { actorUserId: stranger.id })).entries).toHaveLength(0);
    const targeted = await page(owner, { userId: stranger.id });
    expect(targeted.entries).toHaveLength(1);
    expect(targeted.entries[0]?.target?.name).toBeNull();
  });

  it('metadata disaring lagi saat dikirim: rahasia tidak pernah sampai ke browser', async () => {
    const owner = await completeSetup(harness.app);
    await rawAudit([
      {
        organizationId: owner.session.organization.id,
        action: 'settings.email.updated',
        metadata: {
          host: 'smtp.contoh.test',
          password: 'sandi-smtp-bocor',
          nested: { apiToken: 'token-bocor-123', depth: { secret: 'rahasia-dalam' } },
          list: ['a', 'b'],
        },
      },
    ]);
    const response = await call(
      harness.app,
      'GET',
      `${routes.list}?action=settings.email.updated`,
      undefined,
      as(owner),
    );
    expect(response.body).not.toMatch(/sandi-smtp-bocor|token-bocor-123|rahasia-dalam/);
    const [entry] = auditLogListResponseSchema.parse(response.json()).entries;
    expect(entry?.metadata.host).toBe('smtp.contoh.test');
    expect(typeof entry?.metadata.nested).toBe('string');
    expect(entry?.metadata.list).toBe('["a","b"]');
  });
});

describe('ekspor CSV', () => {
  it('CSV ber-BOM, terunduh, aman dari formula injection, dan ekspornya diaudit', async () => {
    const owner = await completeSetup(harness.app);
    const organizationId = owner.session.organization.id;
    const attacker = await insertUser(harness.db, organizationId, {
      role: 'cs',
      name: '=HYPERLINK("http://jahat.example","klik")',
      email: 'cs.csv@majujaya.test',
    });
    await rawAudit([
      {
        organizationId,
        actorUserId: attacker.id,
        action: 'auth.logout',
        userAgent: '+cmd|/C calc!A0',
        metadata: { note: '@SUM(1+1)', quote: 'kata "kutip"' },
      },
    ]);

    const response = await call(
      harness.app,
      'GET',
      `${routes.export}?actorUserId=${attacker.id}`,
      undefined,
      as(owner),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-log-\d{8}\.csv"$/,
    );
    expect(response.headers['x-export-rows']).toBe('1');
    const text = response.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toContain('"Waktu (UTC)","Waktu setempat","Aksi"');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://jahat.example"",""klik"")"`);
    expect(lines[1]).toContain('"Keluar","auth.logout"');
    // Tidak ada sel yang diawali karakter rumus tanpa awalan kutip.
    for (const cell of lines[1]?.split('","') ?? []) {
      expect(cell.replace(/^"/, '')).not.toMatch(/^[=+\-@]/);
    }
    expect(lines[1]).toContain('kata ""kutip""');

    const [exported] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'audit.exported'));
    expect(exported).toMatchObject({ actorUserId: owner.session.user.id, targetType: 'audit_log' });
    expect(exported?.metadata).toMatchObject({
      rows: 1,
      truncated: false,
      actorUserId: attacker.id,
    });
  });

  it('dibatasi 10 ekspor per jam per pengguna', async () => {
    const owner = await completeSetup(harness.app);
    for (let index = 0; index < 10; index += 1) {
      const ok = await call(harness.app, 'GET', routes.export, undefined, as(owner));
      expect(ok.statusCode).toBe(200);
    }
    const limited = await call(harness.app, 'GET', routes.export, undefined, as(owner));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('ringkasan kejadian keamanan (banner)', () => {
  it('email pengirim diubah Admin + 2FA diatur ulang + kunci akun muncul; yang lama dan yang biasa tidak', async () => {
    const owner = await completeSetup(harness.app);
    const organizationId = owner.session.organization.id;
    const password = 'sandi-admin-ringkasan-01';
    const adminUser = await insertUser(harness.db, organizationId, {
      role: 'admin',
      email: 'admin.ringkasan@majujaya.test',
      name: 'Admin Ringkasan',
      passwordHash: await hasher.hash(password),
    });
    const admin = await login(harness.app, { email: adminUser.email, password });
    const supervisorUser = await insertUser(harness.db, organizationId, {
      role: 'supervisor',
      email: 'spv.ringkasan@majujaya.test',
      name: 'Supervisor Ringkasan',
      passwordHash: await hasher.hash(password),
    });
    await login(harness.app, { email: supervisorUser.email, password });

    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings(),
      as(admin),
    );
    expect(saved.statusCode).toBe(200);
    const reset = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.team.resetTwoFactor, { userId: supervisorUser.id }),
      { password, code: await freshTotpCode(adminUser.email) },
      as(admin),
    );
    expect(reset.statusCode).toBe(200);
    await rawAudit([
      {
        organizationId,
        action: 'user.2fa.reset',
        targetType: 'user',
        targetId: supervisorUser.id,
        createdAt: new Date(Date.now() - 8 * 24 * 3600_000),
      },
      {
        organizationId,
        action: 'auth.account.locked',
        targetType: 'user',
        targetId: adminUser.id,
        metadata: { scope: 'source', lockRef: 'abc', lockedUntil: new Date().toISOString() },
      },
    ]);
    // Perubahan oleh Owner tidak memicu peringatan.
    await call(
      harness.app,
      'PUT',
      API_ROUTES.settings.email,
      mailpitSettings({ port: 2525 }),
      as(owner),
    );

    const response = await call(harness.app, 'GET', routes.securitySummary, undefined, as(owner));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('lockRef');
    const summary = securitySummaryResponseSchema.parse(response.json());
    expect(summary.counts).toMatchObject({
      email_sender_changed: 1,
      two_factor_reset: 1,
      account_locked: 1,
      role_changed: 0,
    });
    const kinds = summary.events.map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['email_sender_changed', 'two_factor_reset', 'account_locked']),
    );
    const sender = summary.events.find((event) => event.kind === 'email_sender_changed');
    expect(sender).toMatchObject({
      severity: 'warning',
      actor: { id: adminUser.id, role: 'admin' },
      details: { host: mailpitSettings().host },
    });
    const resetEvent = summary.events.find((event) => event.kind === 'two_factor_reset');
    expect(resetEvent?.subject).toEqual({
      id: supervisorUser.id,
      name: 'Supervisor Ringkasan',
      role: 'supervisor',
    });
    expect(summary.latestWarningAt).not.toBeNull();
    expect(Date.parse(summary.since)).toBeLessThan(Date.now() - 6 * 24 * 3600_000);

    // Admin juga boleh melihat (izin `audit.view`).
    const asAdmin = await call(harness.app, 'GET', routes.securitySummary, undefined, as(admin));
    expect(asAdmin.statusCode).toBe(200);
  });

  it('tanpa kejadian: daftar kosong dan hitungan nol', async () => {
    const owner = await completeSetup(harness.app);
    const response = await call(harness.app, 'GET', routes.securitySummary, undefined, as(owner));
    const summary = securitySummaryResponseSchema.parse(response.json());
    expect(summary.events).toEqual([]);
    expect(Object.values(summary.counts).every((count) => count === 0)).toBe(true);
    expect(summary.latestWarningAt).toBeNull();
  });
});
