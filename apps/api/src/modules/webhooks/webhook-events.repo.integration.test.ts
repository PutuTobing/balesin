/**
 * Jaring pengaman penyimpanan kejadian webhook (review webhook S2) dan pemuatan channel saudara
 * dengan satu query (R2), di atas Postgres sungguhan. Baris disusun langsung — melewati pembersihan
 * `parseWebhookJson` — supaya penolakan database benar-benar terjadi.
 */
import { channels, newId, webhookEvents, type NewWebhookEvent } from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';
import {
  findLiveChannelsByPhoneNumberIds,
  insertWebhookEvents,
  rowDataErrorCode,
} from './webhook-events.repo';

const WABA = '102290129340398';

let harness: IntegrationHarness;
let organizationId: string;
let channelId: string;

async function insertChannel(
  phoneNumberId: string,
  extra: { organizationId?: string; deleted?: boolean } = {},
) {
  const id = newId();
  await harness.db.insert(channels).values({
    id,
    organizationId: extra.organizationId ?? organizationId,
    type: 'whatsapp',
    name: `CS ${phoneNumberId}`,
    waPhoneNumberId: phoneNumberId,
    waBusinessAccountId: WABA,
    ...(extra.deleted
      ? { deletedAt: new Date() }
      : {
          // Repo tidak membuka rahasia; nilai tiruan cukup memenuhi CHECK database.
          waAccessTokenEncrypted: 'tiruan',
          waAppSecretEncrypted: 'tiruan',
          waVerifyTokenEncrypted: 'tiruan',
          waVerifyTokenRotatedAt: new Date(),
        }),
  });
  return id;
}

function row(
  dedup: string,
  payload: Record<string, unknown>,
  extra: Partial<NewWebhookEvent> = {},
) {
  return {
    organizationId,
    channelId,
    source: 'whatsapp',
    kind: 'message',
    field: 'messages',
    dedupKey: `m:${dedup}`,
    externalId: dedup,
    payload,
    occurredAt: new Date(),
    status: 'pending',
    ...extra,
  } satisfies NewWebhookEvent;
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  organizationId = (await insertOrganization(harness.db)).id;
  channelId = await insertChannel('106540352242922');
});
afterAll(async () => {
  await harness?.close();
});

describe('insertWebhookEvents: baris yang ditolak database karena datanya (S2)', () => {
  it('NUL / surrogate tunggal / Invalid Date dilewati per baris; baris lain tetap tersimpan', async () => {
    const result = await insertWebhookEvents(harness.db, [
      row('wamid.baik-1', { text: 'pesan biasa' }),
      row('wamid.nul', { text: 'halo\u0000kak' }),
      row('wamid.surrogate', { text: 'halo\ud800kak' }),
      row('wamid.tanggal', { text: 'x' }, { occurredAt: new Date(Number.NaN) }),
      row('wamid.baik-2', { text: 'pesan biasa juga' }),
    ]);
    expect(result.inserted).toHaveLength(2);
    expect(result.rejectedCodes).toHaveLength(3);
    for (const code of result.rejectedCodes) expect(code).toMatch(/^(22[0-9A-Z]{3}|RangeError)$/);
    expect(result.duplicates).toBe(0);

    const stored = await harness.db
      .select({ externalId: webhookEvents.externalId })
      .from(webhookEvents)
      .where(eq(webhookEvents.channelId, channelId));
    expect(stored.map((event) => event.externalId).sort()).toEqual([
      'wamid.baik-1',
      'wamid.baik-2',
    ]);
  });

  it('kiriman ulang setelah jalur per baris tetap terdeteksi duplikat (dan pending diantre ulang)', async () => {
    const rows = [row('wamid.a', { text: 'a' }), row('wamid.racun', { text: '\u0000' })];
    expect((await insertWebhookEvents(harness.db, rows)).inserted).toHaveLength(1);
    const again = await insertWebhookEvents(harness.db, rows);
    expect(again).toMatchObject({ inserted: [], duplicates: 1 });
    expect(again.pendingDuplicates).toHaveLength(1);
    expect(again.rejectedCodes).toHaveLength(1);
  });

  it('error yang bukan soal data baris (mis. FK channel tidak ada) tetap dilempar → 503 di pemanggil', async () => {
    await expect(
      insertWebhookEvents(harness.db, [row('wamid.x', { text: 'x' }, { channelId: newId() })]),
    ).rejects.toThrow();
  });
});

describe('rowDataErrorCode', () => {
  const pg = (code: string) => Object.assign(new Error('query gagal'), { code, severity: 'ERROR' });

  it('kelas 22 dan CHECK = data baris; koneksi/kunci/kapasitas = sementara', () => {
    expect(rowDataErrorCode(pg('22P05'))).toBe('22P05');
    expect(rowDataErrorCode(new Error('dibungkus', { cause: pg('22P02') }))).toBe('22P02');
    expect(rowDataErrorCode(pg('23514'))).toBe('23514');
    expect(rowDataErrorCode(new RangeError('Invalid time value'))).toBe('RangeError');
    expect(rowDataErrorCode(new Error('dibungkus', { cause: new RangeError('x') }))).toBe(
      'RangeError',
    );
    for (const temporary of ['57P01', '53300', '40001', '40P01', '23503', '23505']) {
      expect(rowDataErrorCode(pg(temporary)), temporary).toBeNull();
    }
    expect(
      rowDataErrorCode(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ).toBeNull();
    expect(rowDataErrorCode('bukan error')).toBeNull();
  });
});

describe('findLiveChannelsByPhoneNumberIds (R2)', () => {
  it('satu query untuk banyak nomor: hanya channel hidup di organisasi ini', async () => {
    const second = await insertChannel('106540352249999');
    await insertChannel('106540352240000', { deleted: true });
    const otherOrganization = await insertOrganization(harness.db);
    await insertChannel('106540352241111', { organizationId: otherOrganization.id });

    const found = await findLiveChannelsByPhoneNumberIds(harness.db, organizationId, [
      '106540352242922',
      '106540352249999',
      '106540352240000',
      '106540352241111',
      '999999999999999',
    ]);
    expect([...found.keys()].sort()).toEqual(['106540352242922', '106540352249999']);
    expect(found.get('106540352249999')?.id).toBe(second);
    expect((await findLiveChannelsByPhoneNumberIds(harness.db, organizationId, [])).size).toBe(0);
  });
});
