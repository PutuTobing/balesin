import { describe, expect, it } from 'vitest';

import {
  composeSubjectFor,
  mailDisplayNameValid,
  mailHeaderTextSafe,
  mailMessageIdTokenValid,
  mailThreadRootOf,
  replyReferencesFor,
  replyRecipientsFor,
  unknownSignatureVariables,
  updateMailDraftRequestSchema,
} from './mail-compose';

const source = {
  from: { address: 'Rina@Pelanggan.test', name: 'Rina' },
  to: [
    { address: 'cs@kantor.test', name: null },
    { address: 'tagihan@kantor.test', name: null },
    { address: 'budi@pelanggan.test', name: 'Budi' },
  ],
  cc: [
    { address: 'RINA@pelanggan.test', name: null },
    { address: 'dina@pelanggan.test', name: null },
    { address: 'budi@pelanggan.test', name: null },
  ],
  replyTo: [] as { address: string; name: string | null }[],
  folderRole: 'inbox' as const,
};
const own = ['cs@kantor.test', 'tagihan@kantor.test'];

describe('penerima balasan', () => {
  it('Balas → From; Reply-To didahulukan', () => {
    expect(replyRecipientsFor('reply', source, own).to).toEqual([
      { address: 'rina@pelanggan.test', name: 'Rina' },
    ]);
    const withReplyTo = { ...source, replyTo: [{ address: 'billing@pelanggan.test', name: null }] };
    expect(replyRecipientsFor('reply', withReplyTo, own).to[0]?.address).toBe(
      'billing@pelanggan.test',
    );
  });

  it('Balas semua: identitas sendiri (utama & alias) dibuang, duplikat tanpa beda huruf, Kepada tidak diulang di Cc', () => {
    const result = replyRecipientsFor('reply_all', source, own);
    expect(result.to.map((item) => item.address)).toEqual(['rina@pelanggan.test']);
    expect(result.cc.map((item) => item.address)).toEqual([
      'budi@pelanggan.test',
      'dina@pelanggan.test',
    ]);
  });

  it('email asli dari Terkirim → Kepada = To asli; Bcc asli tidak pernah ikut', () => {
    const sent = {
      ...source,
      folderRole: 'sent' as const,
      to: [{ address: 'rina@pelanggan.test', name: null }],
      cc: [],
    };
    expect(replyRecipientsFor('reply_all', sent, own)).toEqual({
      to: [{ address: 'rina@pelanggan.test', name: null }],
      cc: [],
    });
    expect(Object.keys(replyRecipientsFor('reply_all', source, own))).toEqual(['to', 'cc']);
    expect(replyRecipientsFor('forward', source, own)).toEqual({ to: [], cc: [] });
  });
});

describe('awalan subjek', () => {
  it.each([
    ['reply', 'Tagihan', 'Re: Tagihan'],
    ['reply', 'RE: Tagihan', 'RE: Tagihan'],
    ['reply_all', 'Aw: Tagihan', 'Aw: Tagihan'],
    ['reply', 'Bls: Tagihan', 'Bls: Tagihan'],
    ['forward', 'Tagihan', 'Fwd: Tagihan'],
    ['forward', 'FW: Tagihan', 'FW: Tagihan'],
    ['forward', 'Re: Tagihan', 'Fwd: Re: Tagihan'],
  ] as const)('%s "%s" → "%s"', (mode, original, expected) => {
    expect(composeSubjectFor(mode, original)).toBe(expected);
  });
});

describe('References & akar utas', () => {
  it('akar + 19 terakhir; ID tak sah (CRLF, spasi, `>` ganda) dibuang', () => {
    const chain = Array.from({ length: 30 }, (_, index) => `id${String(index)}@a.test`);
    const result = replyReferencesFor(
      [...chain, 'jahat\r\nBcc: x@y.test', 'spasi ada@a.test', 'a>b@a.test'],
      'asli@a.test',
    );
    expect(result).toHaveLength(20);
    expect(result[0]).toBe('id0@a.test');
    expect(result.at(-1)).toBe('asli@a.test');
    expect(result.some((id) => !mailMessageIdTokenValid(id))).toBe(false);
  });

  it('thread_root: references[1] → in_reply_to → message_id → id:', () => {
    expect(
      mailThreadRootOf({
        references: ['a@x', 'b@x'],
        inReplyTo: 'b@x',
        messageIdHeader: 'c@x',
        id: '1',
      }),
    ).toBe('a@x');
    expect(
      mailThreadRootOf({ references: [], inReplyTo: 'b@x', messageIdHeader: 'c@x', id: '1' }),
    ).toBe('b@x');
    expect(
      mailThreadRootOf({ references: [], inReplyTo: null, messageIdHeader: 'c@x', id: '1' }),
    ).toBe('c@x');
    expect(
      mailThreadRootOf({ references: [], inReplyTo: null, messageIdHeader: null, id: '1' }),
    ).toBe('id:1');
  });
});

describe('teks header', () => {
  it('CR/LF, U+2028/2029, pengubah arah, kendali → tidak aman', () => {
    for (const value of ['a\r\nb', 'a\nb', 'a b', 'a b', 'a‮b', 'a⁦b', 'a\u0000b']) {
      expect(mailHeaderTextSafe(value)).toBe(false);
    }
    expect(mailHeaderTextSafe('Re: Tagihan 😊')).toBe(true);
    expect(mailDisplayNameValid('Tim <Tagihan>')).toBe(false);
    expect(mailDisplayNameValid('Tim Tagihan')).toBe(true);
  });

  it('variabel tanda tangan di luar daftar izin dilaporkan', () => {
    expect(unknownSignatureVariables('{{nama_agen}} {{qris}} {{ logo }} {{rahasia}}')).toEqual([
      'qris',
      'rahasia',
    ]);
  });

  it('PUT draf: baseVersion wajib, isian lain opsional', () => {
    expect(updateMailDraftRequestSchema.safeParse({ subject: 'x' }).success).toBe(false);
    expect(updateMailDraftRequestSchema.safeParse({ baseVersion: 1 }).success).toBe(true);
  });
});
