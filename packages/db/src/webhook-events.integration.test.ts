import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, type Database } from './client';
import { newId } from './ids';
import { channels, webhookEvents, type NewWebhookEvent } from './schema';
import { insertOrganization, pgErrorOf } from './testing';

/**
 * Batasan tabel `webhook_events` (Fase 2 webhook masuk): idempotensi per channel, channel milik
 * organisasi yang sama (FK komposit), dan bentuk baris yang konsisten.
 */

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test' });
});

afterAll(async () => {
  await closeDb(db);
});

async function channelIn(organizationId: string, phoneNumberId = '106540352242922') {
  const id = newId();
  await db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS',
    waPhoneNumberId: phoneNumberId,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

function event(
  organizationId: string,
  channelId: string,
  overrides: Partial<NewWebhookEvent> = {},
): NewWebhookEvent {
  return {
    organizationId,
    channelId,
    source: 'whatsapp',
    kind: 'message',
    field: 'messages',
    dedupKey: 'm:wamid.ABC',
    externalId: 'wamid.ABC',
    payload: { message: { id: 'wamid.ABC' } },
    ...overrides,
  };
}

describe('webhook_events', () => {
  it('(channel_id, dedup_key) unik: kiriman ulang ditolak/diabaikan, channel lain boleh sama', async () => {
    const organization = await insertOrganization(db);
    const first = await channelIn(organization.id);
    const second = await channelIn(organization.id, '106540352249999');

    await db.insert(webhookEvents).values(event(organization.id, first));
    const duplicate = await pgErrorOf(
      db.insert(webhookEvents).values(event(organization.id, first)),
    );
    expect(duplicate.constraint).toBe('webhook_events_channel_id_dedup_key_unique');

    const ignored = await db
      .insert(webhookEvents)
      .values(event(organization.id, first))
      .onConflictDoNothing({ target: [webhookEvents.channelId, webhookEvents.dedupKey] })
      .returning();
    expect(ignored).toEqual([]);

    await db.insert(webhookEvents).values(event(organization.id, second));
    // Status berbeda untuk wamid yang sama = kejadian berbeda.
    await db
      .insert(webhookEvents)
      .values(event(organization.id, first, { kind: 'status', dedupKey: 's:wamid.ABC:read' }));
  });

  it('channel organisasi lain tidak bisa dirujuk (FK komposit)', async () => {
    const mine = await insertOrganization(db);
    const theirs = await insertOrganization(db);
    const foreignChannel = await channelIn(theirs.id);
    const error = await pgErrorOf(db.insert(webhookEvents).values(event(mine.id, foreignChannel)));
    expect(error.constraint).toBe('webhook_events_organization_id_channel_id_fk');
  });

  it('pesan/status wajib wamid; selesai wajib processed_at; field dan last_error dibatasi', async () => {
    const organization = await insertOrganization(db);
    const channelId = await channelIn(organization.id);
    const cases: [Partial<NewWebhookEvent>, string][] = [
      [{ externalId: null, dedupKey: 'm:x1' }, 'webhook_events_external_id_required'],
      [{ status: 'processed', dedupKey: 'm:x2' }, 'webhook_events_processed_at_matches_status'],
      [
        { status: 'pending', processedAt: new Date(), dedupKey: 'm:x3' },
        'webhook_events_processed_at_matches_status',
      ],
      [{ field: 'Messages; drop', dedupKey: 'm:x4' }, 'webhook_events_field_format'],
      [{ lastError: 'x'.repeat(201), dedupKey: 'm:x5' }, 'webhook_events_last_error_length'],
      [{ attempts: -1, dedupKey: 'm:x6' }, 'webhook_events_attempts_nonnegative'],
      [{ dedupKey: 'm' }, 'webhook_events_dedup_key_length'],
    ];
    for (const [overrides, constraint] of cases) {
      const error = await pgErrorOf(
        db.insert(webhookEvents).values(event(organization.id, channelId, overrides)),
      );
      expect(error.constraint, constraint).toBe(constraint);
    }
    // Field lain tanpa wamid, langsung "skipped".
    await db.insert(webhookEvents).values(
      event(organization.id, channelId, {
        kind: 'other',
        field: 'account_update',
        externalId: null,
        dedupKey: 'o:account_update:abc',
        status: 'skipped',
        processedAt: new Date(),
      }),
    );
  });
});
