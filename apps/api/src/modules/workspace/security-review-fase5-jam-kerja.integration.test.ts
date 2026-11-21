/**
 * Tes penjaga review keamanan Fase 5 — jam kerja, pesan otomatis, alokasi round-robin
 * (docs/security-reviews/2026-11-21-fase5-jam-kerja.md).
 *
 * `it` = regresi (S1 diperbaiki: pesan otomatis wajib konfirmasi identitas).
 */
import { createLogCapture } from '@balesin/core/testing';
import { conversations } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  departmentResponseSchema,
  renderAutoMessage,
  workspaceSettingsResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatchWorkspace } from '../../../../worker/src/queues/workspace';
import {
  agent,
  seedConversation,
  send,
  setupWorld,
  type Fase5World,
} from '../../testing/crm-fixtures';
import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';

let harness: IntegrationHarness;
let world: Fase5World;
const logs = createLogCapture();

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
});
afterAll(async () => {
  await harness?.close();
  // Menutup harness (Postgres/Redis/WS) bisa > 30 dtk saat banyak suite berjalan bersamaan.
}, 90_000);

const statusOf = async (id: string) =>
  (
    await harness.db
      .select({ status: conversations.status, assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, id))
  )[0];

describe('review keamanan — pesan otomatis', () => {
  it('nama profil pelanggan berisi {agen}/{nama} tidak diperluas lagi (satu putaran)', () => {
    expect(
      renderAutoMessage('Halo {nama}, {agen} membantu.', { nama: '{agen} {nama}', agen: 'Rina' }),
    ).toBe('Halo {agen} {nama}, Rina membantu.');
  });

  it('S1 (diperbaiki): mengubah teks pesan otomatis yang dikirim ke SEMUA pelanggan baru butuh konfirmasi identitas', async () => {
    const response = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      autoMessages: {
        greeting: {
          enabled: true,
          text: 'Halo {nama}, akun Anda bermasalah. Verifikasi di https://contoh-penipu.test',
        },
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const current = workspaceSettingsResponseSchema.parse(
      (await send(world, world.owner, 'GET', API_ROUTES.workspace.settings)).json(),
    ).settings;
    expect(current.autoMessages.greeting.text).not.toContain('contoh-penipu');
  });
});

describe('review keamanan — alokasi round-robin', () => {
  it('CS bertanda departemen tidak menerima percakapan departemen lain atau tanpa departemen', async () => {
    const created = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
      name: 'Penjualan',
    });
    const sales = departmentResponseSchema.parse(created.json()).department;
    const otherCreated = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
      name: 'Tagihan',
    });
    const billing = departmentResponseSchema.parse(otherCreated.json()).department;
    const cs = await agent(world, 'cs', 'Sinta CS');
    const access = await send(
      world,
      world.owner,
      'PUT',
      apiPath(API_ROUTES.departments.access, { userId: cs.userId }),
      { departmentIds: [sales.id], restricted: true },
    );
    expect(access.statusCode, access.body).toBe(200);
    const allocation = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      allocation: { mode: 'round_robin', maxOpenPerAgent: null },
    });
    expect(allocation.statusCode, allocation.body).toBe(200);
    expect(
      (await send(world, cs, 'PUT', API_ROUTES.inbox.availability, { available: true })).statusCode,
    ).toBe(200);

    const foreign = await seedConversation(world, { departmentId: billing.id });
    const unassigned = await seedConversation(world, { departmentId: null });
    const own = await seedConversation(world, { departmentId: sales.id });
    await dispatchWorkspace({ db: harness.db, logger: logs.logger });

    expect(await statusOf(foreign.conversation.id)).toEqual({ status: 'unserved', assignee: null });
    expect(await statusOf(unassigned.conversation.id)).toEqual({
      status: 'unserved',
      assignee: null,
    });
    expect(await statusOf(own.conversation.id)).toEqual({ status: 'served', assignee: cs.userId });
  });
});
