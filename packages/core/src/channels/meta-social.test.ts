import { describe, expect, it } from 'vitest';

import { channelInboundEventSchema } from './inbound';
import { isMetaSocialCdnUrl, splitMetaSocialWebhook } from './meta-social';

const PAGE = '1122334455';
const PSID = '9988776655';

function notification(messaging: unknown[], object = 'page', entryId = PAGE) {
  return { object, entry: [{ id: entryId, time: 1_794_900_000_000, messaging }] };
}

describe('splitMetaSocialWebhook', () => {
  it('teks, lampiran CDN Meta, quick reply, postback → kejadian pesan netral yang lolos skema', () => {
    const split = splitMetaSocialWebhook(
      notification([
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 1_794_900_000_000,
          message: { mid: 'm.1', text: 'Halo' },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 1_794_900_000_100,
          message: {
            mid: 'm.2',
            attachments: [
              {
                type: 'image',
                payload: { url: 'https://scontent.xx.fbcdn.net/v/t1/abc.jpg?oh=1' },
              },
            ],
          },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          message: { mid: 'm.3', text: 'Paket A', quick_reply: { payload: 'PAKET_A' } },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          postback: { mid: 'm.4', title: 'Mulai', payload: 'START' },
        },
      ]),
      'messenger',
      PAGE,
    );
    expect(split.recognized).toBe(true);
    expect(split.items.map((item) => [item.kind, item.externalId, item.dedupKey])).toEqual([
      ['message', 'm.1', 'm:m.1'],
      ['message', 'm.2', 'm:m.2'],
      ['message', 'm.3', 'm:m.3'],
      ['message', 'm.4', 'm:m.4'],
    ]);
    for (const item of split.items)
      expect(channelInboundEventSchema.safeParse(item.event).success).toBe(true);
    expect(split.items[1]?.event).toMatchObject({
      type: 'image',
      media: { ref: expect.stringContaining('fbcdn.net') as string },
    });
    expect(split.items[2]?.event).toMatchObject({ type: 'interactive', reply: { id: 'PAKET_A' } });
    expect(split.items[3]?.event).toMatchObject({
      type: 'interactive',
      rawType: 'postback',
      reply: { id: 'START' },
    });
  });

  it('URL lampiran di luar CDN Meta tidak disimpan (SSRF) → pesan "belum didukung"', () => {
    const split = splitMetaSocialWebhook(
      notification([
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          message: {
            mid: 'm.5',
            attachments: [{ type: 'file', payload: { url: 'http://169.254.169.254/latest' } }],
          },
        },
      ]),
      'messenger',
      PAGE,
    );
    expect(split.items[0]?.event).toMatchObject({ type: 'unsupported', media: null });
  });

  it('echo pesan sendiri diabaikan; entri Halaman lain dibuang; delivery/read jadi status', () => {
    const split = splitMetaSocialWebhook(
      {
        object: 'page',
        entry: [
          {
            id: PAGE,
            messaging: [
              {
                sender: { id: PAGE },
                recipient: { id: PSID },
                message: { mid: 'm.6', text: 'balasan', is_echo: true },
              },
              {
                sender: { id: PSID },
                recipient: { id: PAGE },
                delivery: { mids: ['m.out.1'], watermark: 1_794_900_000_000 },
              },
              {
                sender: { id: PSID },
                recipient: { id: PAGE },
                read: { watermark: 1_794_900_000_500 },
              },
            ],
          },
          {
            id: '5555555555',
            messaging: [
              {
                sender: { id: PSID },
                recipient: { id: '5555555555' },
                message: { mid: 'x', text: 'y' },
              },
            ],
          },
        ],
      },
      'messenger',
      PAGE,
    );
    expect(split.ignored).toBe(1);
    expect(split.misrouted).toBe(1);
    expect(split.items.map((item) => item.event)).toMatchObject([
      {
        kind: 'status',
        status: 'delivered',
        externalIds: ['m.out.1'],
        recipientExternalUserId: PSID,
      },
      { kind: 'status', status: 'read', externalIds: [], recipientExternalUserId: PSID },
    ]);
  });

  it('objek Instagram hanya untuk channel Instagram (akun IG sebagai pemilik)', () => {
    const body = notification(
      [{ sender: { id: PSID }, recipient: { id: '1777' }, message: { mid: 'ig.1', text: 'hai' } }],
      'instagram',
      '17841400000',
    );
    expect(splitMetaSocialWebhook(body, 'messenger', PAGE).recognized).toBe(false);
    expect(splitMetaSocialWebhook(body, 'instagram', '17841400000').items).toHaveLength(1);
  });
});

describe('isMetaSocialCdnUrl', () => {
  it.each([
    ['https://scontent.xx.fbcdn.net/a.jpg', true],
    ['https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', true],
    ['https://scontent.cdninstagram.com/v/x', true],
    ['http://scontent.xx.fbcdn.net/a.jpg', false],
    ['https://fbcdn.net.penyerang.test/a.jpg', false],
    ['https://user:pass@scontent.xx.fbcdn.net/a.jpg', false],
    ['https://scontent.xx.fbcdn.net:8443/a.jpg', false],
  ])('%s → %s', (url, expected) => {
    expect(isMetaSocialCdnUrl(url)).toBe(expected);
  });
});
