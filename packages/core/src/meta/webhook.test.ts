import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Secret } from '../secret';
import {
  isStatusAdvance,
  normalizeInboundMessage,
  normalizeStatusUpdate,
  normalizeWebhookFailure,
  parseWebhookJson,
  splitWhatsAppWebhook,
  WebhookPayloadError,
  type WhatsAppWebhookItem,
} from './webhook-payload';
import {
  parseWebhookHandshake,
  signMetaWebhook,
  verifyMetaWebhookSignature,
} from './webhook-signature';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const WABA = '102290129340398';
const PHONE = '106540352242922';
const WAMID = 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=';

const hmac = (body: string | Buffer, secret = APP_SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

/** Contoh resmi Meta (pesan teks), nilai diganti data fiktif. */
function textNotification(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281100001111', phone_number_id: PHONE },
              contacts: [
                {
                  profile: { name: 'Budi Santoso' },
                  wa_id: '6281234567890',
                  user_id: 'ID.13491208655302741918',
                },
              ],
              messages: [
                {
                  from: '6281234567890',
                  from_user_id: 'ID.13491208655302741918',
                  id: WAMID,
                  timestamp: '1763190000',
                  type: 'text',
                  text: { body: 'Halo kak, internet mati.' },
                  ...overrides,
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function statusNotification(statuses: Record<string, unknown>[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281100001111', phone_number_id: PHONE },
              statuses,
            },
          },
        ],
      },
    ],
  };
}

describe('verifyMetaWebhookSignature', () => {
  const body = Buffer.from(JSON.stringify(textNotification()));

  it('menerima tanda tangan HMAC-SHA256 yang benar (huruf kecil maupun besar)', () => {
    expect(verifyMetaWebhookSignature(body, `sha256=${hmac(body)}`, APP_SECRET)).toBe('valid');
    expect(verifyMetaWebhookSignature(body, `sha256=${hmac(body).toUpperCase()}`, APP_SECRET)).toBe(
      'valid',
    );
    expect(
      verifyMetaWebhookSignature(body, signMetaWebhook(body, APP_SECRET), new Secret(APP_SECRET)),
    ).toBe('valid');
  });

  it('menolak tanpa header, format salah, header ganda, dan App Secret lain', () => {
    expect(verifyMetaWebhookSignature(body, undefined, APP_SECRET)).toBe('missing');
    expect(verifyMetaWebhookSignature(body, '', APP_SECRET)).toBe('missing');
    expect(verifyMetaWebhookSignature(body, hmac(body), APP_SECRET)).toBe('malformed');
    expect(verifyMetaWebhookSignature(body, `sha1=${hmac(body)}`, APP_SECRET)).toBe('malformed');
    expect(verifyMetaWebhookSignature(body, `sha256=${hmac(body).slice(0, 63)}`, APP_SECRET)).toBe(
      'malformed',
    );
    expect(verifyMetaWebhookSignature(body, `sha256=${hmac(body)}00`, APP_SECRET)).toBe(
      'malformed',
    );
    expect(
      verifyMetaWebhookSignature(
        body,
        [`sha256=${hmac(body)}`, `sha256=${hmac(body)}`],
        APP_SECRET,
      ),
    ).toBe('malformed');
    expect(
      verifyMetaWebhookSignature(body, `sha256=${hmac(body)}, sha256=${hmac(body)}`, APP_SECRET),
    ).toBe('malformed');
    expect(
      verifyMetaWebhookSignature(body, `sha256=${hmac(body, 'rahasia-lain')}`, APP_SECRET),
    ).toBe('mismatch');
  });

  it('satu byte body berubah = tidak cocok (dihitung atas byte mentah, bukan JSON tafsiran)', () => {
    const signature = `sha256=${hmac(body)}`;
    const tampered = Buffer.from(body);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 1;
    expect(verifyMetaWebhookSignature(tampered, signature, APP_SECRET)).toBe('mismatch');

    // JSON yang SETARA tetapi byte-nya beda (spasi / escape Unicode) juga ditolak: tanda tangan
    // selalu atas byte persis kiriman Meta.
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyMetaWebhookSignature(reformatted, signature, APP_SECRET)).toBe('mismatch');
    const escaped = Buffer.from('{"a":"\\u00e9"}');
    expect(verifyMetaWebhookSignature(escaped, `sha256=${hmac('{"a":"é"}')}`, APP_SECRET)).toBe(
      'mismatch',
    );
    expect(verifyMetaWebhookSignature(escaped, `sha256=${hmac(escaped)}`, APP_SECRET)).toBe(
      'valid',
    );
  });

  it('body kosong tetap diperiksa (tidak melempar)', () => {
    expect(verifyMetaWebhookSignature(Buffer.alloc(0), `sha256=${hmac('')}`, APP_SECRET)).toBe(
      'valid',
    );
  });
});

describe('parseWebhookHandshake', () => {
  const query = (overrides: Record<string, unknown> = {}) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'token-verifikasi-acak',
    'hub.challenge': '1158201444',
    ...overrides,
  });

  it('jabat tangan sah', () => {
    expect(parseWebhookHandshake(query())).toEqual({
      ok: true,
      verifyToken: 'token-verifikasi-acak',
      challenge: '1158201444',
    });
    expect(parseWebhookHandshake(query({ 'hub.challenge': 'abc_DEF-123' })).ok).toBe(true);
  });

  it.each([
    ['mode lain', { 'hub.mode': 'unsubscribe' }, 'mode'],
    ['tanpa mode', { 'hub.mode': undefined }, 'mode'],
    ['tanpa token', { 'hub.verify_token': undefined }, 'token_missing'],
    ['token ganda', { 'hub.verify_token': ['a', 'b'] }, 'token_missing'],
    ['challenge markup', { 'hub.challenge': '<script>alert(1)</script>' }, 'challenge_invalid'],
    ['challenge spasi', { 'hub.challenge': '12 34' }, 'challenge_invalid'],
    ['challenge kosong', { 'hub.challenge': '' }, 'challenge_invalid'],
    ['challenge terlalu panjang', { 'hub.challenge': 'a'.repeat(129) }, 'challenge_invalid'],
    ['challenge ganda', { 'hub.challenge': ['1', '2'] }, 'challenge_invalid'],
  ])('%s → ditolak', (_label, overrides, reason) => {
    expect(parseWebhookHandshake(query(overrides))).toEqual({ ok: false, reason });
  });

  it('query bukan objek → ditolak', () => {
    expect(parseWebhookHandshake(undefined).ok).toBe(false);
    expect(parseWebhookHandshake('hub.mode=subscribe').ok).toBe(false);
  });
});

describe('parseWebhookJson', () => {
  it('membuang __proto__/constructor dan mengembalikan undefined untuk bukan JSON', () => {
    const parsed = parseWebhookJson(
      Buffer.from(
        '{"a":1,"__proto__":{"polluted":true},"b":{"constructor":{"prototype":{"x":1}}}}',
      ),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, b: {} });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseWebhookJson(Buffer.from('bukan json'))).toBeUndefined();
    expect(parseWebhookJson(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('splitWhatsAppWebhook', () => {
  const only = (items: WhatsAppWebhookItem[]) => {
    expect(items).toHaveLength(1);
    return items[0]!;
  };

  it('pesan teks → satu kejadian message dengan kunci idempotensi m:<wamid>', () => {
    const split = splitWhatsAppWebhook(textNotification());
    expect(split).toMatchObject({ recognized: true, invalid: 0 });
    const item = only(split.items);
    expect(item).toMatchObject({
      kind: 'message',
      field: 'messages',
      wabaId: WABA,
      phoneNumberId: PHONE,
      externalId: WAMID,
      dedupKey: `m:${WAMID}`,
      occurredAt: new Date(1763190000 * 1000),
    });
    expect(item.kind === 'message' && item.payload.contact?.profile?.name).toBe('Budi Santoso');
  });

  it('status → s:<wamid>:<status>; status sama = kunci sama, status beda = kunci beda', () => {
    const split = splitWhatsAppWebhook(
      statusNotification(
        ['sent', 'delivered', 'read', 'failed', 'delivered'].map((status) => ({
          id: WAMID,
          status,
          timestamp: '1763190000',
          recipient_id: '6281234567890',
        })),
      ),
    );
    expect(split.items.map((item) => item.dedupKey)).toEqual([
      `s:${WAMID}:sent`,
      `s:${WAMID}:delivered`,
      `s:${WAMID}:read`,
      `s:${WAMID}:failed`,
      `s:${WAMID}:delivered`,
    ]);
  });

  it('error tingkat sistem dan field lain: kunci dari hash isi (kiriman ulang = kunci sama)', () => {
    const errors = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE },
                errors: [{ code: 130429, title: 'Rate limit hit', message: 'Rate limit hit' }],
              },
            },
            {
              field: 'message_template_status_update',
              value: { event: 'APPROVED', message_template_id: 1 },
            },
          ],
        },
      ],
    };
    const first = splitWhatsAppWebhook(errors).items;
    const again = splitWhatsAppWebhook(structuredClone(errors)).items;
    expect(first.map((item) => item.kind)).toEqual(['error', 'other']);
    expect(first[0]?.dedupKey).toMatch(/^e:[0-9a-f]{40}$/);
    expect(first[1]?.dedupKey).toMatch(/^o:message_template_status_update:[0-9a-f]{40}$/);
    expect(again.map((item) => item.dedupKey)).toEqual(first.map((item) => item.dedupKey));
  });

  it('toleran: isian tambahan dipertahankan, bagian rusak dibuang tanpa menggagalkan yang lain', () => {
    const notification = textNotification({ isian_baru_meta: { a: 1 } });
    const value = notification.entry[0]!.changes[0]!.value as Record<string, unknown>;
    value.messages = [
      ...(value.messages as unknown[]),
      { from: '628', timestamp: '1', type: 'text' }, // tanpa id
      { id: 'wamid.x', timestamp: '1', type: 'text' }, // tanpa pengenal pengirim
      { id: 'wamid.y', from: '628', timestamp: 'kemarin', type: 'text' }, // timestamp rusak
      'bukan objek',
    ];
    value.statuses = 'bukan array';
    const split = splitWhatsAppWebhook(notification);
    expect(split.invalid).toBe(5);
    const item = only(split.items);
    expect(item.kind === 'message' && item.payload.message.isian_baru_meta).toEqual({ a: 1 });
  });

  it('pelanggan dengan username tanpa nomor (hanya BSUID) tetap diterima', () => {
    const notification = textNotification({ from: undefined });
    const split = splitWhatsAppWebhook(JSON.parse(JSON.stringify(notification)));
    const normalized = normalizeInboundMessage(only(split.items).payload);
    expect(normalized.sender).toMatchObject({
      waId: '6281234567890', // dari contacts[].wa_id
      userId: 'ID.13491208655302741918',
    });
  });

  it('bukan notifikasi WhatsApp Business Account → tidak dikenali', () => {
    expect(splitWhatsAppWebhook({ object: 'page', entry: [] }).recognized).toBe(false);
    expect(splitWhatsAppWebhook(undefined).recognized).toBe(false);
    expect(splitWhatsAppWebhook([]).recognized).toBe(false);
  });

  it('metadata.phone_number_id bukan angka → bagian itu dibuang', () => {
    const notification = textNotification();
    (notification.entry[0]!.changes[0]!.value.metadata as Record<string, unknown>).phone_number_id =
      '../evil';
    expect(splitWhatsAppWebhook(notification)).toMatchObject({ items: [], invalid: 1 });
  });
});

describe('normalisasi ke bentuk internal', () => {
  const payloadOf = (message: Record<string, unknown>) => {
    const items = splitWhatsAppWebhook(textNotification(message)).items;
    return items[0]!.payload;
  };

  it('teks', () => {
    expect(normalizeInboundMessage(payloadOf({}))).toMatchObject({
      wamid: WAMID,
      wabaId: WABA,
      phoneNumberId: PHONE,
      type: 'text',
      rawType: 'text',
      text: 'Halo kak, internet mati.',
      media: null,
      sender: {
        waId: '6281234567890',
        userId: 'ID.13491208655302741918',
        profileName: 'Budi Santoso',
        username: null,
      },
      sentAt: new Date(1763190000 * 1000),
      context: null,
      errors: [],
    });
  });

  it('gambar + keterangan, balasan (context), diteruskan', () => {
    const normalized = normalizeInboundMessage(
      payloadOf({
        type: 'image',
        text: undefined,
        image: {
          caption: 'Bukti transfer',
          mime_type: 'image/jpeg',
          sha256: 'abc=',
          id: '1003383421387256',
        },
        context: { id: 'wamid.asal', forwarded: true },
      }),
    );
    expect(normalized).toMatchObject({
      type: 'image',
      text: 'Bukti transfer',
      media: {
        kind: 'image',
        id: '1003383421387256',
        mimeType: 'image/jpeg',
        caption: 'Bukti transfer',
        voice: false,
      },
      context: { messageId: 'wamid.asal', forwarded: true, frequentlyForwarded: false },
    });
  });

  it('pesan suara, lokasi, reaksi, tombol, daftar, tidak didukung, jenis baru', () => {
    expect(
      normalizeInboundMessage(
        payloadOf({ type: 'audio', audio: { id: '55', mime_type: 'audio/ogg', voice: true } }),
      ).media,
    ).toMatchObject({ kind: 'audio', voice: true });
    expect(
      normalizeInboundMessage(
        payloadOf({
          type: 'location',
          location: { latitude: -8.65, longitude: 115.2, name: 'Rumah' },
        }),
      ).location,
    ).toEqual({ latitude: -8.65, longitude: 115.2, name: 'Rumah', address: null });
    expect(
      normalizeInboundMessage(
        payloadOf({ type: 'reaction', reaction: { message_id: 'wamid.k', emoji: '👍' } }),
      ).reaction,
    ).toEqual({ messageId: 'wamid.k', emoji: '👍' });
    expect(
      normalizeInboundMessage(payloadOf({ type: 'button', button: { payload: 'YA', text: 'Ya' } })),
    ).toMatchObject({ text: 'Ya', reply: { kind: 'button', id: 'YA', title: 'Ya' } });
    expect(
      normalizeInboundMessage(
        payloadOf({
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: 'paket-20', title: 'Paket 20 Mbps' },
          },
        }),
      ).reply,
    ).toEqual({ kind: 'list_reply', id: 'paket-20', title: 'Paket 20 Mbps', description: null });
    const unsupported = normalizeInboundMessage(
      payloadOf({
        type: 'unsupported',
        unsupported: { type: 'edit' },
        errors: [{ code: 131051, title: 'Message type unknown', error_data: { details: 'x' } }],
      }),
    );
    expect(unsupported).toMatchObject({
      type: 'unsupported',
      errors: [{ code: 131051, title: 'Message type unknown', message: null, details: 'x' }],
    });
    expect(normalizeInboundMessage(payloadOf({ type: 'poll_update' }))).toMatchObject({
      type: 'unknown',
      rawType: 'poll_update',
      text: null,
    });
  });

  it('status (termasuk gagal dengan errors, dan nilai baru dari Meta)', () => {
    const [sent, failed, novel] = splitWhatsAppWebhook(
      statusNotification([
        {
          id: WAMID,
          status: 'sent',
          timestamp: '1763190000',
          recipient_id: '6281234567890',
          conversation: {
            id: 'c1',
            expiration_timestamp: '1763276400',
            origin: { type: 'service' },
          },
          pricing: {
            billable: false,
            pricing_model: 'PMP',
            category: 'service',
            type: 'free_customer_service',
          },
        },
        {
          id: WAMID,
          status: 'failed',
          timestamp: '1763190001',
          errors: [{ code: 131049, title: 'Tidak terkirim', error_data: { details: 'rincian' } }],
        },
        { id: WAMID, status: 'deleted', timestamp: '1763190002' },
      ]),
    ).items;
    expect(normalizeStatusUpdate(sent!.payload)).toMatchObject({
      status: 'sent',
      recipient: { waId: '6281234567890', userId: null },
      conversation: { id: 'c1', originType: 'service', expiresAt: new Date(1763276400 * 1000) },
      pricing: {
        billable: false,
        model: 'PMP',
        category: 'service',
        type: 'free_customer_service',
      },
    });
    expect(normalizeStatusUpdate(failed!.payload)).toMatchObject({
      status: 'failed',
      errors: [{ code: 131049, title: 'Tidak terkirim', details: 'rincian' }],
      conversation: null,
    });
    expect(normalizeStatusUpdate(novel!.payload)).toMatchObject({
      status: 'unknown',
      rawStatus: 'deleted',
    });
  });

  it('error tingkat sistem', () => {
    expect(
      normalizeWebhookFailure({
        wabaId: WABA,
        phoneNumberId: PHONE,
        error: { code: 130429, title: 'Rate limit hit' },
      }),
    ).toEqual({
      wabaId: WABA,
      phoneNumberId: PHONE,
      error: { code: 130429, title: 'Rate limit hit', message: null, details: null },
    });
  });

  it('payload tersimpan rusak → WebhookPayloadError (gagal permanen, tidak diulang)', () => {
    expect(() => normalizeInboundMessage({})).toThrow(WebhookPayloadError);
    expect(() => normalizeStatusUpdate({ wabaId: WABA, phoneNumberId: PHONE })).toThrow(
      WebhookPayloadError,
    );
    expect(() => normalizeWebhookFailure(null)).toThrow(WebhookPayloadError);
  });
});

describe('isStatusAdvance', () => {
  it('status hanya maju; failed tidak menimpa read; unknown tidak pernah menimpa', () => {
    expect(isStatusAdvance(null, 'sent')).toBe(true);
    expect(isStatusAdvance('sent', 'delivered')).toBe(true);
    expect(isStatusAdvance('delivered', 'read')).toBe(true);
    expect(isStatusAdvance('read', 'delivered')).toBe(false);
    expect(isStatusAdvance('read', 'read')).toBe(false);
    expect(isStatusAdvance('delivered', 'failed')).toBe(true);
    expect(isStatusAdvance('read', 'failed')).toBe(false);
    expect(isStatusAdvance('failed', 'delivered')).toBe(false);
    expect(isStatusAdvance('sent', 'unknown')).toBe(false);
  });
});
