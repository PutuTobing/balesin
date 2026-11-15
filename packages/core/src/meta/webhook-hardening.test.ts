/**
 * Pengerasan pemecah payload webhook setelah review keamanan Fase 2 butir 3
 * (docs/security-reviews/2026-11-16-fase2-webhook.md): S2 (teks/cap waktu "beracun"), R2 (batas
 * kejadian & nomor per notifikasi), Info 3 (`Object.hasOwn`).
 */
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_MAX_EVENTS_PER_NOTIFICATION,
  WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION,
  WEBHOOK_MAX_UNIX_SECONDS,
  normalizeInboundMessage,
  parseWebhookJson,
  splitWhatsAppWebhook,
  toStorableText,
} from './webhook-payload';

const WABA = '102290129340398';
const PHONE = '106540352242922';

function change(phoneNumberId: string, value: Record<string, unknown>) {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: phoneNumberId },
      ...value,
    },
  };
}

function notification(changes: unknown[]) {
  return { object: 'whatsapp_business_account', entry: [{ id: WABA, changes }] };
}

const textMessage = (overrides: Record<string, unknown> = {}) => ({
  from: '6281234567890',
  id: `wamid.${Math.random().toString(36).slice(2)}`,
  timestamp: '1763190000',
  type: 'text',
  text: { body: 'halo' },
  ...overrides,
});

const status = (index: number) => ({
  id: `wamid.s${index}`,
  status: 'delivered',
  timestamp: '1763190000',
});

/** Teks yang ditolak Postgres `jsonb`: NUL atau surrogate tunggal (dalam bentuk escape JSON). */
const hasPoison = (value: unknown) => /\\u0000|\\ud[89ab][0-9a-f]{2}/i.test(JSON.stringify(value));

describe('toStorableText', () => {
  it('membuang NUL dan mengganti surrogate tunggal dengan U+FFFD; teks sah tidak berubah', () => {
    expect(toStorableText('halo\u0000kak')).toBe('halokak');
    expect(toStorableText('halo\ud800kak')).toBe('halo�kak');
    expect(toStorableText('akhir\udc00')).toBe('akhir�');
    expect(toStorableText('emoji 😀 utuh')).toBe('emoji 😀 utuh');
    expect(toStorableText('')).toBe('');
  });
});

describe('parseWebhookJson membersihkan teks untuk jsonb (S2)', () => {
  it('nilai DAN kunci objek dibersihkan, di kedalaman berapa pun', () => {
    const raw = String.raw`{"a":"x\u0000y","b":["\ud800",{"k\u0000ey":"emoji \ud83d"}],"c\udc00":1}`;
    const parsed = parseWebhookJson(Buffer.from(raw));
    expect(parsed).toEqual({ a: 'xy', b: ['�', { key: 'emoji �' }], 'c�': 1 });
    expect(hasPoison(parsed)).toBe(false);
  });

  it('kunci yang baru menjadi __proto__/constructor setelah dibersihkan ikut dibuang', () => {
    const raw = String.raw`{"__pro\u0000to__":{"tercemar":true},"constr\u0000uctor":1,"ok":true}`;
    const parsed = parseWebhookJson(Buffer.from(raw)) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).tercemar).toBeUndefined();
  });

  it('bersarang terlalu dalam → undefined (diabaikan), bukan melempar', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(parseWebhookJson(Buffer.from(deep))).toBeUndefined();
  });
});

describe('cap waktu di luar rentang (S2)', () => {
  it('angka/teks di atas tahun 2100 → bagian itu tidak sah; batas atas sendiri diterima', () => {
    const split = splitWhatsAppWebhook(
      notification([
        change(PHONE, {
          messages: [
            textMessage({ timestamp: 9_007_199_254_740_991 }),
            textMessage({ timestamp: '999999999999' }),
            textMessage({ timestamp: String(WEBHOOK_MAX_UNIX_SECONDS) }),
          ],
          statuses: [{ id: 'wamid.s', status: 'read', timestamp: 9_007_199_254_740_991 }],
        }),
      ]),
    );
    expect(split.invalid).toBe(3);
    expect(split.items).toHaveLength(1);
    expect(split.items[0]?.occurredAt?.getTime()).toBe(WEBHOOK_MAX_UNIX_SECONDS * 1000);
  });
});

describe('batas per notifikasi (R2)', () => {
  it(`lebih dari ${WEBHOOK_MAX_EVENTS_PER_NOTIFICATION} kejadian → sisanya dibuang (overLimit)`, () => {
    const extra = 7;
    const statuses = Array.from(
      { length: WEBHOOK_MAX_EVENTS_PER_NOTIFICATION + extra },
      (_, index) => status(index),
    );
    const split = splitWhatsAppWebhook(
      notification([
        change(PHONE, { statuses }),
        { field: 'account_update', value: { event: 'X' } },
      ]),
    );
    expect(split.items).toHaveLength(WEBHOOK_MAX_EVENTS_PER_NOTIFICATION);
    expect(split.overLimit).toBe(extra + 1);
    expect(split.invalid).toBe(0);
  });

  it(`lebih dari ${WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION} nomor berbeda → perubahan nomor berikutnya dibuang`, () => {
    const phones = Array.from(
      { length: WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION + 5 },
      (_, index) => String(100_000_000_000 + index),
    );
    const changes = [
      ...phones.map((phone) => change(phone, { messages: [textMessage()] })),
      // Nomor yang SUDAH terlihat tetap diterima walau batas tercapai.
      change(phones[0]!, { messages: [textMessage()] }),
    ];
    const split = splitWhatsAppWebhook(notification(changes));
    expect(new Set(split.items.map((item) => item.phoneNumberId)).size).toBe(
      WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION,
    );
    expect(split.items).toHaveLength(WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION + 1);
    expect(split.overLimit).toBe(5);
  });

  it('notifikasi normal tidak pernah kena batas', () => {
    const split = splitWhatsAppWebhook(
      notification([change(PHONE, { messages: [textMessage()] })]),
    );
    expect(split).toMatchObject({ overLimit: 0, invalid: 0 });
  });
});

describe('normalisasi tidak membaca isian warisan prototipe (Info 3)', () => {
  it.each(['constructor', '__proto__'])(
    'type "%s" → unknown tanpa teks, tidak melempar',
    (type) => {
      const [item] = splitWhatsAppWebhook(
        notification([change(PHONE, { messages: [textMessage({ type, text: undefined })] })]),
      ).items;
      const normalized = normalizeInboundMessage(item!.payload);
      expect(normalized).toMatchObject({ type: 'unknown', rawType: type, text: null });
    },
  );

  it('interaktif dengan sub-jenis yang tidak ada sebagai isian sendiri → balasan kosong', () => {
    const [item] = splitWhatsAppWebhook(
      notification([
        change(PHONE, {
          messages: [
            textMessage({ type: 'interactive', text: undefined, interactive: { type: 'valueOf' } }),
          ],
        }),
      ]),
    ).items;
    expect(normalizeInboundMessage(item!.payload).reply).toEqual({
      kind: 'other',
      id: null,
      title: null,
      description: null,
    });
  });
});
