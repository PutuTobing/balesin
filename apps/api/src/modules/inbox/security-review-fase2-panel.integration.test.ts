/**
 * Review keamanan Fase 2 butir 8–9 — panel detail & quick reply
 * (docs/security-reviews/2026-11-18-fase2-panel-quick-reply.md). Penjaga regresi: atribut kontak
 * tidak bisa mencemari prototipe, riwayat kontak tanpa nilai data pelanggan, moderator tidak bisa
 * "menulis atas nama" rekan, variabel quick reply tidak diproses ulang dari nama pelanggan.
 * Postgres + Redis sungguhan.
 */
import {
  channels,
  contactEvents,
  contacts,
  conversationNotes,
  conversations,
  newId,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  contactResponseSchema,
  quickReplyResponseSchema,
  useQuickReplyResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-review-panel-qr-4';
const SECRET_EMAIL = 'rahasia.pelanggan.7712@contoh.test';
const SECRET_NOTE = 'CATATAN-KONTAK-RAHASIA-7712';

type Agent = SignedIn & { userId: string; name: string };

let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

async function agent(role: 'cs' | 'teknisi' | 'supervisor', name: string): Promise<Agent> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    name,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return {
    ...(await login(harness.app, { email: user.email, password: PASSWORD })),
    userId: user.id,
    name,
  };
}

async function conversation(profileName: string | null = 'Budi WA') {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      profileName,
    })
    .returning();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
    })
    .returning();
  return row!;
}

function send(signed: SignedIn, method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  return call(harness.app, method, url, body, { cookie: signed.cookie, csrf: signed.csrf });
}

beforeAll(async () => {
  harness = await createIntegrationHarness({
    overrides: { inboxStream: { heartbeatMs: 3_600_000, revalidateMs: 3_600_000 } },
  });
});
beforeEach(async () => {
  await harness.reset();
  const signed = await completeSetup(harness.app);
  organizationId = signed.session.organization.id;
  owner = { ...signed, userId: signed.session.user.id, name: signed.session.user.name };
  channelId = newId();
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
});

describe('ubah kontak', () => {
  it('atribut `__proto__` ditolak; `constructor` hanya teks dalam daftar (tanpa pencemaran prototipe)', async () => {
    const row = await conversation();
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId });
    const proto = await send(owner, 'PATCH', url, {
      attributes: [{ key: '__proto__', value: 'x' }],
    });
    expect(proto.statusCode).toBe(400);

    const ok = await send(owner, 'PATCH', url, {
      attributes: [
        { key: 'constructor', value: 'tercemar' },
        { key: 'ID Pelanggan', value: 'SKY-001' },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const { contact } = contactResponseSchema.parse(ok.json());
    expect(contact.attributes).toEqual([
      { key: 'constructor', value: 'tercemar' },
      { key: 'ID Pelanggan', value: 'SKY-001' },
    ]);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it('riwayat kontak hanya nama isian — nilai email/catatan/atribut tidak tersimpan di contact_events', async () => {
    const row = await conversation();
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId });
    const response = await send(owner, 'PATCH', url, {
      email: SECRET_EMAIL,
      notes: SECRET_NOTE,
      attributes: [{ key: 'Alamat', value: SECRET_NOTE }],
    });
    expect(response.statusCode, response.body).toBe(200);
    const events = await harness.db
      .select()
      .from(contactEvents)
      .where(eq(contactEvents.contactId, row.contactId));
    expect(events).toHaveLength(1);
    const stored = JSON.stringify(events);
    expect(stored).not.toContain(SECRET_EMAIL);
    expect(stored).not.toContain(SECRET_NOTE);
  });

  it('Teknisi (bahkan pada percakapannya) tidak bisa mengubah kontak atau memasang tag (403)', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const row = await conversation();
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, row.id));
    const patch = await send(
      teknisi,
      'PATCH',
      apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId }),
      {
        name: 'Diubah Teknisi',
      },
    );
    expect(patch.statusCode).toBe(403);
    const tag = await send(
      teknisi,
      'POST',
      apiPath(API_ROUTES.inbox.contactTags, { contactId: row.contactId }),
      { tagId: newId() },
    );
    expect(tag.statusCode).toBe(403);
  });
});

describe('catatan sesi', () => {
  it('Owner (moderator) boleh menghapus tetapi TIDAK boleh mengubah catatan CS', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const row = await conversation();
    const notesUrl = apiPath(API_ROUTES.inbox.notes, { conversationId: row.id });
    const created = await send(cs, 'POST', notesUrl, { body: 'Pelanggan minta dihubungi sore.' });
    expect(created.statusCode, created.body).toBe(201);
    const [note] = await harness.db.select().from(conversationNotes);
    const noteUrl = apiPath(API_ROUTES.inbox.note, { conversationId: row.id, noteId: note!.id });

    const edit = await send(owner, 'PATCH', noteUrl, { body: 'Ditulis ulang oleh Owner' });
    expect(edit.statusCode).toBe(403);
    const [after] = await harness.db.select().from(conversationNotes);
    expect(after?.body).toBe('Pelanggan minta dihubungi sore.');

    const editByOtherCs = await send(await agent('cs', 'Dewi CS'), 'DELETE', noteUrl);
    expect(editByOtherCs.statusCode).toBe(403);
    expect((await send(owner, 'DELETE', noteUrl)).statusCode).toBe(200);
  });
});

describe('quick reply', () => {
  it('nama pelanggan berisi `{agen}` tidak diproses ulang (satu putaran pengisian)', async () => {
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const row = await conversation('{agen} {nama} Budi');
    const created = await send(supervisor, 'POST', API_ROUTES.quickReplies.list, {
      shortcut: 'salam',
      title: 'Salam',
      body: 'Halo {nama}, saya {agen}.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { quickReply } = quickReplyResponseSchema.parse(created.json());
    const used = await send(
      supervisor,
      'POST',
      apiPath(API_ROUTES.quickReplies.use, { quickReplyId: quickReply.id }),
      { conversationId: row.id },
    );
    expect(used.statusCode, used.body).toBe(200);
    expect(useQuickReplyResponseSchema.parse(used.json()).text).toBe(
      'Halo {agen} {nama} Budi, saya Rina Supervisor.',
    );
  });
});
