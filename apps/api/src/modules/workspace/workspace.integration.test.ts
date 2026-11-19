/**
 * Pengaturan kerja tim (Fase 5): jam kerja + hari libur, pesan otomatis (variabel per jenis), mode
 * alokasi + kapasitas, agen (tersedia/dikecualikan), ketersediaan diri sendiri, jam kerja departemen.
 * Izin: pengaturan = `settings.workspace.manage` (Owner/Admin), ketersediaan = `inbox.reply`.
 */
import { auditLogs } from '@balesin/db';
import {
  API_ROUTES,
  AUTO_MESSAGE_DEFAULT_TEXTS,
  allocationAgentListResponseSchema,
  allocationAgentResponseSchema,
  apiPath,
  availabilityResponseSchema,
  departmentResponseSchema,
  securitySummaryResponseSchema,
  workspaceSettingsResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agent, send, setupWorld, type Fase5World } from '../../testing/crm-fixtures';
import {
  confirmationFor,
  confirmationOf,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';

let harness: IntegrationHarness;
let world: Fase5World;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
});
afterAll(async () => {
  await harness?.close();
});

describe('pengaturan kerja tim', () => {
  it('bawaan; ubah sebagian; variabel per jenis divalidasi; audit tanpa teks; CS 403', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    expect((await send(world, cs, 'GET', API_ROUTES.workspace.settings)).statusCode).toBe(403);
    const initial = workspaceSettingsResponseSchema.parse(
      (await send(world, world.owner, 'GET', API_ROUTES.workspace.settings)).json(),
    ).settings;
    expect(initial).toMatchObject({
      timezone: 'Asia/Jakarta',
      teamHours: { mode: 'always' },
      holidays: [],
      withinTeamHoursNow: true,
      allocation: { mode: 'manual', maxOpenPerAgent: null },
      autoMessages: { greeting: { enabled: false }, assigned: { enabled: false } },
    });

    const badVariable = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      autoMessages: { greeting: { enabled: true, text: 'Halo {nama}, {agen} di sini' } },
    });
    expect(badVariable.statusCode).toBe(400);
    expect(badVariable.body).toContain('{agen}');
    const badWindow = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      teamHours: { mode: 'schedule', windows: [{ day: 1, start: '17:00', end: '08:00' }] },
    });
    expect(badWindow.statusCode).toBe(400);

    const body = {
      teamHours: { mode: 'schedule', windows: [{ day: 1, start: '08:00', end: '17:00' }] },
      holidays: [{ date: '2026-12-25', name: 'Natal' }],
      allocation: { mode: 'round_robin', maxOpenPerAgent: 15 },
      autoMessages: {
        assigned: { enabled: true, text: 'Halo {nama}, {agen} akan membantumu.' },
      },
    };
    // Review jam kerja S1: mengaktifkan / mengubah teks pesan otomatis wajib konfirmasi identitas.
    const unconfirmed = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, body);
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.body).toContain('confirmation.password');
    const updated = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      ...body,
      confirmation: await confirmationFor(),
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(workspaceSettingsResponseSchema.parse(updated.json()).settings).toMatchObject({
      allocation: { mode: 'round_robin', maxOpenPerAgent: 15 },
      holidays: [{ date: '2026-12-25', name: 'Natal' }],
      autoMessages: {
        assigned: { enabled: true, text: 'Halo {nama}, {agen} akan membantumu.' },
        greeting: { enabled: false },
      },
    });
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'settings.workspace.updated'));
    expect(audit?.metadata).toMatchObject({
      changedFields: expect.arrayContaining([
        'teamHours',
        'holidays',
        'allocationMode',
        'maxOpenPerAgent',
        'assignedEnabled',
        'assignedText',
      ]) as unknown,
    });
    // Teks lama → baru tercatat (isi pengaturan, bukan data pelanggan).
    expect(audit?.metadata).toMatchObject({
      actorRole: 'owner',
      autoMessageTexts: {
        assigned: {
          previous: AUTO_MESSAGE_DEFAULT_TEXTS.assigned,
          next: 'Halo {nama}, {agen} akan membantumu.',
        },
      },
    });
    expect(audit?.metadata).not.toHaveProperty('risky');
    // Mematikan (arah aman) & mengubah jam kerja tidak butuh konfirmasi.
    const off = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      autoMessages: { assigned: { enabled: false, text: 'Halo {nama}, {agen} akan membantumu.' } },
      holidays: [],
    });
    expect(off.statusCode, off.body).toBe(200);
  });

  it('teks pesan otomatis bertautan/nomor panjang → kejadian keamanan auto_message_risky (warning)', async () => {
    const admin = await agent(world, 'admin', 'Andi Admin');
    const risky = await send(world, admin, 'PUT', API_ROUTES.workspace.settings, {
      autoMessages: {
        greeting: {
          enabled: true,
          text: 'Halo {nama}, bayar di https://contoh-bayar.test atau rekening 1234567890.',
        },
      },
      confirmation: await confirmationOf(admin),
    });
    expect(risky.statusCode, risky.body).toBe(200);
    const summary = securitySummaryResponseSchema.parse(
      (await send(world, world.owner, 'GET', API_ROUTES.audit.securitySummary)).json(),
    );
    expect(summary.counts.auto_message_risky).toBe(1);
    expect(summary.events.find((event) => event.kind === 'auto_message_risky')).toMatchObject({
      severity: 'warning',
      details: { addedLinks: 1, addedNumbers: 1, actorRole: 'admin' },
    });
  });

  it('agen: daftar (Owner/Admin dikecualikan bawaan, Teknisi tidak ikut); ubah; ketersediaan diri sendiri', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const list = allocationAgentListResponseSchema.parse(
      (await send(world, world.owner, 'GET', API_ROUTES.workspace.agents)).json(),
    ).agents;
    expect(list.map((item) => [item.name, item.excluded, item.available])).toEqual(
      expect.arrayContaining([
        [world.owner.name, true, true],
        ['Sinta CS', false, true],
      ]),
    );
    expect(list.some((item) => item.userId === teknisi.userId)).toBe(false);

    const patched = await send(
      world,
      world.owner,
      'PATCH',
      apiPath(API_ROUTES.workspace.agent, { userId: world.owner.userId }),
      { excluded: false },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(allocationAgentResponseSchema.parse(patched.json()).agent.excluded).toBe(false);
    expect(
      (
        await send(
          world,
          world.owner,
          'PATCH',
          apiPath(API_ROUTES.workspace.agent, { userId: teknisi.userId }),
          { excluded: false },
        )
      ).statusCode,
    ).toBe(404);

    const own = await send(world, cs, 'PUT', API_ROUTES.inbox.availability, { available: false });
    expect(own.statusCode, own.body).toBe(200);
    expect(availabilityResponseSchema.parse(own.json()).availability).toEqual({
      available: false,
      excluded: false,
      mode: 'manual',
    });
    // Teknisi tidak ikut pembagian otomatis.
    expect(
      (await send(world, teknisi, 'PUT', API_ROUTES.inbox.availability, { available: true }))
        .statusCode,
    ).toBe(409);
    const actions = (await harness.db.select({ action: auditLogs.action }).from(auditLogs)).map(
      (row) => row.action,
    );
    expect(actions).toContain('settings.workspace.agent_updated');
  });

  it('jam kerja departemen (null = ikut organisasi)', async () => {
    const created = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
      name: 'Teknik',
    });
    const department = departmentResponseSchema.parse(created.json()).department;
    expect(department.teamHours).toBeNull();
    // Langsung saat membuat (tanpa POST lalu PATCH).
    const withHours = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
      name: 'Lapangan',
      teamHours: { mode: 'schedule', windows: [{ day: 1, start: '07:00', end: '15:00' }] },
    });
    expect(withHours.statusCode, withHours.body).toBe(201);
    expect(departmentResponseSchema.parse(withHours.json()).department.teamHours).toEqual({
      mode: 'schedule',
      windows: [{ day: 1, start: '07:00', end: '15:00' }],
    });
    const url = apiPath(API_ROUTES.departments.department, { departmentId: department.id });
    const hours = { mode: 'schedule', windows: [{ day: 6, start: '08:00', end: '12:00' }] };
    const updated = await send(world, world.owner, 'PATCH', url, { teamHours: hours });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(departmentResponseSchema.parse(updated.json()).department.teamHours).toEqual(hours);
    const cleared = await send(world, world.owner, 'PATCH', url, { teamHours: null });
    expect(departmentResponseSchema.parse(cleared.json()).department.teamHours).toBeNull();
  });
});
