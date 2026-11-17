/**
 * Tes penjaga review keamanan Fase 5 — cakupan departemen & "terkait tiket"
 * (docs/security-reviews/2026-11-21-fase5-backend.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import {
  API_ROUTES,
  apiPath,
  conversationListResponseSchema,
  departmentResponseSchema,
  ticketBoardResponseSchema,
} from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agent,
  seedConversation,
  send,
  setupWorld,
  type Agent,
  type Fase5World,
} from '../../testing/crm-fixtures';
import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';

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

async function department(name: string) {
  const response = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
    name,
  });
  expect(response.statusCode, response.body).toBe(201);
  return departmentResponseSchema.parse(response.json()).department;
}

async function restrict(target: Agent, departmentIds: string[]) {
  const response = await send(
    world,
    world.owner,
    'PUT',
    apiPath(API_ROUTES.departments.access, { userId: target.userId }),
    { departmentIds, restricted: true },
  );
  expect(response.statusCode, response.body).toBe(200);
}

async function board(name: string, departmentId: string) {
  const response = await send(world, world.owner, 'POST', API_ROUTES.tickets.boards, {
    name,
    departmentId,
  });
  expect(response.statusCode, response.body).toBe(201);
  return ticketBoardResponseSchema.parse(response.json()).board;
}

async function visible(signed: Agent): Promise<string[]> {
  const response = await send(world, signed, 'GET', API_ROUTES.inbox.conversations);
  expect(response.statusCode, response.body).toBe(200);
  return conversationListResponseSchema.parse(response.json()).conversations.map((item) => item.id);
}

describe('review keamanan — batas departemen', () => {
  it('CS bertanda tidak melihat percakapan departemen lain (detail 404, daftar kosong)', async () => {
    const sales = await department('Penjualan');
    const billing = await department('Tagihan');
    const cs = await agent(world, 'cs', 'Sinta CS');
    await restrict(cs, [sales.id]);
    const { conversation } = await seedConversation(world, { departmentId: billing.id });
    expect(await visible(cs)).not.toContain(conversation.id);
    const detail = await send(
      world,
      cs,
      'GET',
      apiPath(API_ROUTES.inbox.conversation, { conversationId: conversation.id }),
    );
    expect(detail.statusCode).toBe(404);
  });

  it.fails(
    'S1: CS bertanda tidak bisa membuka percakapan departemen lain dengan membuat tiket miliknya yang menaut kontak itu',
    async () => {
      const sales = await department('Penjualan');
      const billing = await department('Tagihan');
      const cs = await agent(world, 'cs', 'Sinta CS');
      await restrict(cs, [sales.id]);
      const salesBoard = await board('Keluhan Penjualan', sales.id);
      const { contact, conversation } = await seedConversation(world, {
        departmentId: billing.id,
        status: 'resolved',
      });
      expect(await visible(cs)).not.toContain(conversation.id);

      // Kontak tidak dibatasi departemen (CRM lintas departemen) → CS bisa menautkannya ke tiket
      // di board departemennya sendiri, dipegang dirinya sendiri.
      await send(world, cs, 'POST', API_ROUTES.tickets.list, {
        boardId: salesBoard.id,
        title: 'Cek riwayat',
        assigneeUserId: cs.userId,
        contactId: contact.id,
      });
      const detail = await send(
        world,
        cs,
        'GET',
        apiPath(API_ROUTES.inbox.conversation, { conversationId: conversation.id }),
      );
      expect(detail.statusCode).toBe(404);
      const history = await send(
        world,
        cs,
        'GET',
        apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
      );
      expect(history.statusCode).toBe(404);
    },
  );
});
