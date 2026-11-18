import { describe, expect, it } from 'vitest';

import {
  classifyEmailAttachment,
  emailExternalId,
  normalizeMessageId,
  parseInboundEmail,
  replySubject,
  sanitizeEmailHtml,
  stripQuotedReply,
} from './email-message';
import { testEmail } from './testing/fake-imap';

const OWN = ['cs@contoh.test'];

function multipart(parts: { headers: string[]; body: string }[], headers: string[] = []): string {
  const boundary = 'BATAS-TES';
  return [
    'From: "Budi Santoso" <Budi@Pelanggan.Test>',
    'To: cs@contoh.test',
    'Subject: Re: Tagihan bulan ini',
    'Message-ID: <abc123@pelanggan.test>',
    'In-Reply-To: <keluar-1@contoh.test>',
    'References: <awal@pelanggan.test> <keluar-1@contoh.test>',
    'MIME-Version: 1.0',
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts.flatMap((part) => [`--${boundary}`, ...part.headers, '', part.body]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

describe('parseInboundEmail', () => {
  it('pengirim, utas, subjek, teks (kutipan lama dipotong), HTML disanitasi, lampiran aman', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF').toString('base64');
    const exe = Buffer.from('MZ\x90\x00jahat').toString('base64');
    const raw = multipart([
      {
        headers: ['Content-Type: text/plain; charset=utf-8'],
        body: 'Sudah saya bayar ya.\r\n\r\nPada Sel, 17 Nov 2026 pukul 10.00, CS menulis:\r\n> Tagihan Rp150.000',
      },
      {
        headers: ['Content-Type: text/html; charset=utf-8'],
        body:
          '<p onclick="x()">Sudah <b>saya</b> bayar</p><script>alert(1)</script><img src="https://pelacak.test/p.gif">' +
          '<a href="javascript:alert(1)">klik</a><a href="https://bank.test/bukti">bukti</a><style>p{}</style>',
      },
      {
        headers: [
          'Content-Type: application/pdf; name="bukti.pdf"',
          'Content-Disposition: attachment; filename="bukti.pdf"',
          'Content-Transfer-Encoding: base64',
        ],
        body: pdf,
      },
      {
        headers: [
          'Content-Type: application/octet-stream; name="hadiah.exe"',
          'Content-Disposition: attachment; filename="hadiah.exe"',
          'Content-Transfer-Encoding: base64',
        ],
        body: exe,
      },
    ]);
    const result = await parseInboundEmail(Buffer.from(raw), OWN);
    if (!result.ok) throw new Error('harus lolos');
    const { email } = result;
    expect(email.from).toEqual({ address: 'budi@pelanggan.test', name: 'Budi Santoso' });
    expect(email.messageId).toBe('abc123@pelanggan.test');
    expect(email.inReplyTo).toBe('keluar-1@contoh.test');
    expect(email.references).toEqual(['awal@pelanggan.test', 'keluar-1@contoh.test']);
    expect(email.subject).toBe('Re: Tagihan bulan ini');
    expect(email.text).toBe('Sudah saya bayar ya.');
    expect(email.html).not.toMatch(/script|onclick|<img|javascript:|<style|pelacak/i);
    expect(email.html).toContain('<b>saya</b>');
    expect(email.html).toContain('href="https://bank.test/bukti"');
    expect(email.html).toContain('rel="noopener noreferrer nofollow"');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      filename: 'bukti.pdf',
      kind: 'document',
      mimeType: 'application/pdf',
    });
    expect(email.skippedAttachments).toBe(1);
    expect(email.authWarning).toBe(false);
  });

  it.each([
    ['Auto-Submitted: auto-replied', 'auto_reply'],
    ['Precedence: bulk', 'auto_reply'],
    ['X-Autoreply: yes', 'auto_reply'],
    ['Return-Path: <>', 'bounce'],
  ])('balasan otomatis / bounce dilewati: %s', async (header, reason) => {
    const [key = '', value = ''] = header.split(': ');
    const raw = testEmail({ from: 'budi@pelanggan.test', headers: { [key]: value } });
    expect(await parseInboundEmail(Buffer.from(raw), OWN)).toEqual({ ok: false, reason });
  });

  it('MAILER-DAEMON & email dari alamat channel sendiri dilewati (anti-loop)', async () => {
    expect(
      await parseInboundEmail(Buffer.from(testEmail({ from: 'MAILER-DAEMON@mail.test' })), OWN),
    ).toEqual({ ok: false, reason: 'bounce' });
    expect(
      await parseInboundEmail(Buffer.from(testEmail({ from: 'CS@contoh.test' })), OWN),
    ).toEqual({
      ok: false,
      reason: 'own_address',
    });
  });

  it('Authentication-Results DMARC gagal → authWarning', async () => {
    const raw = testEmail({
      from: 'bos@bank.test',
      headers: {
        'Authentication-Results': 'mx.contoh.test; spf=fail smtp.mailfrom=bank.test; dmarc=fail',
      },
    });
    const result = await parseInboundEmail(Buffer.from(raw), OWN);
    expect(result.ok && result.email.authWarning).toBe(true);
  });

  it('tanpa Message-ID → ID sintetis yang unik', async () => {
    const raw = testEmail({ from: 'a@b.test' }).replace(/Message-ID: <[^>]+>\r\n/, '');
    const result = await parseInboundEmail(Buffer.from(raw), OWN);
    expect(result.ok && result.email.messageId).toMatch(/^tanpa-id\..+@balesin\.invalid$/);
  });
});

describe('sanitizeEmailHtml', () => {
  it.each([
    '<svg><script>alert(1)</script></svg>',
    '<iframe src="https://x.test"></iframe>',
    '<form action="https://x.test"><input name="p"></form>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<div style="background:url(https://x.test)">x</div>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  ])('membuang konten berbahaya: %s', (html) => {
    const clean = sanitizeEmailHtml(html);
    expect(clean).not.toMatch(/<script|<iframe|<form|<input|data:|style=|javascript:|<svg|<math/i);
  });
});

describe('utilitas email', () => {
  it('stripQuotedReply hanya memotong bila ada balasan di atasnya', () => {
    expect(stripQuotedReply('Oke\n\nOn Mon, 1 Jan 2026, CS wrote:\n> lama')).toBe('Oke');
    expect(stripQuotedReply('> semua kutipan')).toBe('> semua kutipan');
    expect(stripQuotedReply('Baris 1\n-----Original Message-----\nlama')).toBe('Baris 1');
  });

  it('Message-ID dinormalisasi; yang panjang di-hash supaya muat 256', () => {
    expect(normalizeMessageId('<a@b>')).toBe('a@b');
    expect(normalizeMessageId('<a b@c>')).toBeNull();
    expect(emailExternalId('x'.repeat(300))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('subjek balasan tidak menumpuk Re:', () => {
    expect(replySubject('Re: RE: Bls: Tagihan')).toBe('Re: Tagihan');
    expect(replySubject(null)).toBe('Re: (tanpa subjek)');
  });

  it('lampiran: makro Office & berkas eksekusi ditolak; jenis tak dikenal jadi biner', () => {
    expect(classifyEmailAttachment(Buffer.from('apa saja'), 'laporan.docm')).toBeNull();
    expect(classifyEmailAttachment(Buffer.from('<html>'), 'halaman.html')).toBeNull();
    expect(classifyEmailAttachment(Buffer.from('PK\x03\x04rusak'), 'surat.docx')).toBeNull();
    expect(classifyEmailAttachment(Buffer.from('GIF89a....'), 'gambar.gif')).toEqual({
      kind: 'document',
      mimeType: 'application/octet-stream',
    });
  });
});
