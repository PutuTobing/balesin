import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, type Database } from './client';
import { PG_ERROR_CODES } from './errors';
import { newId } from './ids';
import {
  channels,
  contacts,
  conversations,
  messages,
  organizations,
  webhookEvents,
  type NewConversationRow,
  type NewMessageRow,
} from './schema';
import { insertOrganization, insertUser, pgErrorOf, uniqueSuffix } from './testing';

/**
 * Batasan tabel inbox (Fase 2 butir 4): identitas kontak unik per organisasi, satu percakapan
 * terbuka per kontak × channel, FK komposit organisasi, dan bentuk baris pesan yang konsisten.
 */

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test' });
});

afterAll(async () => {
  await closeDb(db);
});

let phoneCounter = 0;

async function channelIn(organizationId: string) {
  const id = newId();
  await db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS',
    waPhoneNumberId: `${String(Date.now())}${String((phoneCounter += 1))}`,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

async function contactIn(
  organizationId: string,
  overrides: Partial<typeof contacts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${uniqueSuffix()}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('kontak tidak dibuat');
  return row;
}

function conversation(
  organizationId: string,
  contactId: string,
  channelId: string,
  overrides: Partial<NewConversationRow> = {},
): NewConversationRow {
  return {
    organizationId,
    contactId,
    channelId,
    status: 'unserved',
    lastMessageAt: new Date(),
    ...overrides,
  };
}

async function setup() {
  const organization = await insertOrganization(db);
  const channelId = await channelIn(organization.id);
  const contact = await contactIn(organization.id);
  const [open] = await db
    .insert(conversations)
    .values(conversation(organization.id, contact.id, channelId))
    .returning();
  if (!open) throw new Error('percakapan tidak dibuat');
  return { organizationId: organization.id, channelId, contact, conversation: open };
}

function inbound(
  base: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<NewMessageRow> = {},
): NewMessageRow {
  return {
    organizationId: base.organizationId,
    conversationId: base.conversation.id,
    contactId: base.contact.id,
    channelId: base.channelId,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    wamid: `wamid.${uniqueSuffix()}`,
    text: 'halo',
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('contacts', () => {
  it('BSUID dan nomor masing-masing unik per organisasi; organisasi lain boleh sama', async () => {
    const orgA = await insertOrganization(db);
    const orgB = await insertOrganization(db);
    const bsuid = `ID.${uniqueSuffix()}`;
    await contactIn(orgA.id, { waBsuid: bsuid, phone: '+6281234567890' });
    await contactIn(orgB.id, { waBsuid: bsuid, phone: '+6281234567890' });

    const sameBsuid = await pgErrorOf(contactIn(orgA.id, { waBsuid: bsuid }));
    expect(sameBsuid).toMatchObject({
      code: PG_ERROR_CODES.uniqueViolation,
      constraint: 'contacts_organization_id_channel_type_wa_bsuid_unique',
    });
    const samePhone = await pgErrorOf(
      contactIn(orgA.id, { waBsuid: null, phone: '+6281234567890' }),
    );
    expect(samePhone.constraint).toBe('contacts_organization_id_channel_type_phone_unique');
  });

  it('kontak WhatsApp wajib punya BSUID atau nomor; nomor wajib E.164', async () => {
    const organization = await insertOrganization(db);
    expect(
      (await pgErrorOf(contactIn(organization.id, { waBsuid: null, phone: null }))).constraint,
    ).toBe('contacts_whatsapp_identity_required');
    for (const phone of ['6281234567890', '+0812345678', '+62 812', '+12']) {
      expect((await pgErrorOf(contactIn(organization.id, { phone }))).constraint).toBe(
        'contacts_phone_e164',
      );
    }
    expect(
      (await pgErrorOf(contactIn(organization.id, { waBsuid: 'ID 1; drop' }))).constraint,
    ).toBe('contacts_wa_bsuid_format');
    // Hanya nomor (tanpa BSUID) dan hanya BSUID sama-sama sah.
    await contactIn(organization.id, { waBsuid: null, phone: '+6281111111111' });
    await contactIn(organization.id, { phone: null });
  });

  it('nomor publik berurutan dibuat database dan unik', async () => {
    const organization = await insertOrganization(db);
    const first = await contactIn(organization.id);
    const second = await contactIn(organization.id);
    expect(second.number).toBeGreaterThan(first.number);
  });
});

describe('conversations', () => {
  it('paling banyak satu percakapan terbuka per kontak × channel; yang selesai boleh banyak', async () => {
    const base = await setup();
    const duplicate = await pgErrorOf(
      db
        .insert(conversations)
        .values(conversation(base.organizationId, base.contact.id, base.channelId)),
    );
    expect(duplicate).toMatchObject({
      code: PG_ERROR_CODES.uniqueViolation,
      constraint: 'conversations_open_contact_channel_unique',
    });

    const resolved = (at: Date) =>
      conversation(base.organizationId, base.contact.id, base.channelId, {
        status: 'resolved',
        resolvedAt: at,
      });
    await db.insert(conversations).values([resolved(new Date()), resolved(new Date())]);
  });

  it('status selesai ⇔ resolved_at; jendela 24 jam ⇔ pesan masuk terakhir', async () => {
    const base = await setup();
    const other = await contactIn(base.organizationId);
    expect(
      (
        await pgErrorOf(
          db
            .insert(conversations)
            .values(
              conversation(base.organizationId, other.id, base.channelId, { status: 'resolved' }),
            ),
        )
      ).constraint,
    ).toBe('conversations_resolved_at_matches_status');
    expect(
      (
        await pgErrorOf(
          db.insert(conversations).values(
            conversation(base.organizationId, other.id, base.channelId, {
              windowExpiresAt: new Date(),
            }),
          ),
        )
      ).constraint,
    ).toBe('conversations_window_requires_inbound');
  });

  it('kontak, channel, dan agen harus dari organisasi yang sama (FK komposit)', async () => {
    const base = await setup();
    const foreign = await insertOrganization(db);
    const foreignContact = await contactIn(foreign.id);
    const foreignUser = await insertUser(db, foreign.id);

    expect(
      (
        await pgErrorOf(
          db
            .insert(conversations)
            .values(conversation(base.organizationId, foreignContact.id, base.channelId)),
        )
      ).constraint,
    ).toBe('conversations_organization_id_contact_id_fk');
    const own = await contactIn(base.organizationId);
    expect(
      (
        await pgErrorOf(
          db.insert(conversations).values(
            conversation(base.organizationId, own.id, base.channelId, {
              assigneeUserId: foreignUser.id,
            }),
          ),
        )
      ).constraint,
    ).toBe('conversations_organization_id_assignee_user_id_fk');
  });
});

describe('messages', () => {
  it('wamid unik per channel; channel lain boleh sama; pesan keluar tanpa wamid boleh banyak', async () => {
    const base = await setup();
    const wamid = `wamid.${uniqueSuffix()}`;
    await db.insert(messages).values(inbound(base, { wamid }));
    expect((await pgErrorOf(db.insert(messages).values(inbound(base, { wamid })))).constraint).toBe(
      'messages_channel_id_wamid_unique',
    );

    const otherChannel = await channelIn(base.organizationId);
    const [otherConversation] = await db
      .insert(conversations)
      .values(conversation(base.organizationId, base.contact.id, otherChannel))
      .returning();
    await db
      .insert(messages)
      .values(
        inbound(base, { wamid, channelId: otherChannel, conversationId: otherConversation!.id }),
      );

    const outbound = (): NewMessageRow =>
      inbound(base, {
        direction: 'outbound',
        senderKind: 'agent',
        wamid: null,
        status: 'pending',
      });
    await db.insert(messages).values([outbound(), outbound()]);
  });

  it('pesan masuk tanpa status & dari pelanggan; pesan keluar wajib berstatus', async () => {
    const base = await setup();
    expect(
      (await pgErrorOf(db.insert(messages).values(inbound(base, { status: 'sent' })))).constraint,
    ).toBe('messages_inbound_has_no_status');
    expect(
      (
        await pgErrorOf(
          db
            .insert(messages)
            .values(inbound(base, { direction: 'outbound', senderKind: 'agent', status: null })),
        )
      ).constraint,
    ).toBe('messages_outbound_has_status');
  });

  it('pesan merujuk percakapan organisasi yang sama', async () => {
    const base = await setup();
    const foreign = await setup();
    const error = await pgErrorOf(
      db.insert(messages).values(inbound(base, { conversationId: foreign.conversation.id })),
    );
    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });
});

describe('pencarian kontak (review kontak R3)', () => {
  it('ekstensi pg_trgm terpasang dan indeks trigram ada di kolom yang dicari', async () => {
    const extension = await db.execute(
      sql`select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(extension.rows).toHaveLength(1);
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where tablename = 'contacts' and indexname like '%trgm%' order by indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'contacts_channel_handle_trgm_idx',
      'contacts_name_trgm_idx',
      'contacts_phone_trgm_idx',
      'contacts_profile_name_trgm_idx',
      'contacts_wa_username_trgm_idx',
    ]);
    for (const row of indexes.rows) expect(row.indexdef).toContain('gin_trgm_ops');
  });
});

describe('retensi & kaitan kontak', () => {
  it('retensi payload organisasi 1–90 hari, bawaan 8', async () => {
    const organization = await insertOrganization(db);
    expect(organization.webhookPayloadRetentionDays).toBe(8);
    for (const days of [0, 91]) {
      const error = await pgErrorOf(
        db.insert(organizations).values({ name: 'x', webhookPayloadRetentionDays: days }),
      );
      expect(error.constraint).toBe('organizations_webhook_payload_retention_days_range');
    }
  });

  it('webhook_events.contact_id hanya kontak organisasi yang sama', async () => {
    const base = await setup();
    const foreign = await insertOrganization(db);
    const foreignContact = await contactIn(foreign.id);
    const error = await pgErrorOf(
      db.insert(webhookEvents).values({
        organizationId: base.organizationId,
        channelId: base.channelId,
        source: 'whatsapp',
        kind: 'message',
        field: 'messages',
        dedupKey: `m:wamid.${uniqueSuffix()}`,
        externalId: 'wamid.x',
        payload: {},
        contactId: foreignContact.id,
      }),
    );
    expect(error.constraint).toBe('webhook_events_organization_id_contact_id_fk');
  });
});
