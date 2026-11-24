import { describe, expect, it } from 'vitest';

import { buildComposedMime, stripBccHeader } from '../mail-client/compose-mime';
import {
  assembleMailBody,
  buildMailQuote,
  fillSignatureVariables,
  sanitizeComposerHtml,
} from './compose-html';
import {
  createMailComposeKeys,
  mailMessageIdHash,
  newMailVerificationCode,
  randomBase32,
} from './compose-keys';

const none = { allowedCids: new Set<string>() };

describe('sanitizeComposerHtml (profil editor 9B)', () => {
  it('membuang skrip, on*, <style>, class/id, gambar https:/data:, komentar & sisa Word', () => {
    const result = sanitizeComposerHtml(
      '<!--[if mso]>x<![endif]--><style>p{color:red}</style><p class="MsoNormal" id="a" onclick="x()" style="mso-line-height-rule:exactly;color:#ff0000;position:fixed;background:url(https://x.test/a)">Halo<script>alert(1)</script></p><img src="https://pelacak.test/p.gif"><img src="data:image/png;base64,AAAA">',
      none,
    );
    expect(result.html).toBe('<p style="color: #ff0000">Halo</p>');
    expect(result.changed).toBe(true);
    expect(result.removedImages).toBe(2);
  });

  it('cid: sah dipertahankan, cid lain dibuang; data-signature hanya di div', () => {
    const result = sanitizeComposerHtml(
      '<p><img src="cid:img-0a1b2c3d" alt="foto" width="120"><img src="cid:img-ffffffff"></p><div data-signature="0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0">TTD</div><span data-signature="0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0">x</span>',
      { allowedCids: new Set(['img-0a1b2c3d']) },
    );
    expect(result.html).toBe(
      '<p><img src="cid:img-0a1b2c3d" alt="foto" width="120" /></p><div data-signature="0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0">TTD</div><span>x</span>',
    );
  });

  it('tautan hanya http(s)/mailto/tel; javascript: dibuang', () => {
    const result = sanitizeComposerHtml(
      '<a href="javascript:alert(1)">a</a><a href="https://contoh.test">b</a><a href="mailto:x@contoh.test">c</a>',
      none,
    );
    expect(result.html).toBe(
      '<a>a</a><a href="https://contoh.test">b</a><a href="mailto:x@contoh.test">c</a>',
    );
  });

  it('tempelan bersarang sangat dalam → tooComplex (tidak diserahkan ke sanitize-html)', () => {
    const deep = `${'<div>'.repeat(5_000)}x${'</div>'.repeat(5_000)}`;
    expect(sanitizeComposerHtml(deep, none)).toMatchObject({ tooComplex: true, html: '' });
  });
});

describe('kutipan', () => {
  const base = {
    mode: 'reply' as const,
    from: { address: 'rina@pelanggan.test', name: 'Rina' },
    to: [{ address: 'cs@kantor.test', name: null }],
    cc: [],
    subject: 'Upgrade',
    sentAt: new Date('2026-11-20T03:00:00Z'),
    timeZone: 'Asia/Jakarta',
  };

  it('gambar dibuang (teks alt), tautan peringatan → teks, <style> dibuang', () => {
    const quote = buildMailQuote({
      ...base,
      html: '<style>p{color:red}</style><p>Halo <img src="balesin-remote:0" alt="logo"><img src="balesin-cid:a@b"> <a href="https://cs.contoh.test/email/tautan?ke=https%3A%2F%2Fjahat.test&tampil=bank.test">bank.test</a> <a href="https://baik.test">baik</a></p>',
      text: 'Halo',
    });
    expect(quote?.textOnly).toBe(false);
    expect(quote?.html).toContain('Rina &lt;rina@pelanggan.test&gt; menulis:');
    expect(quote?.html).toContain('[logo]');
    expect(quote?.html).toContain('[gambar]');
    expect(quote?.html).not.toMatch(/balesin-|<style|color:red|jahat\.test|\/email\/tautan/);
    expect(quote?.html).toContain('<span>bank.test</span>');
    expect(quote?.html).toContain('<a href="https://baik.test">baik</a>');
    expect(quote?.html).toContain('<blockquote type="cite">');
  });

  it('HTML > 192 KB → kutipan teks `> `; teks > 64 KB dipotong', () => {
    const big = `<p>${'a'.repeat(200 * 1024)}</p>`;
    const quote = buildMailQuote({ ...base, html: big, text: 'baris satu\nbaris dua' });
    expect(quote?.textOnly).toBe(true);
    expect(quote?.text).toContain('> baris satu\n> baris dua');
    const long = buildMailQuote({ ...base, html: null, text: 'x'.repeat(70 * 1024) });
    expect(long?.text).toContain('[kutipan dipotong]');
  });

  it('teruskan: blok "Email diteruskan" + Dari/Tanggal/Subjek/Kepada', () => {
    const quote = buildMailQuote({ ...base, mode: 'forward', html: null, text: 'isi' });
    expect(quote?.text).toMatch(
      /---------- Email diteruskan ----------\nDari: Rina <rina@pelanggan\.test>\nTanggal: .+\nSubjek: Upgrade\nKepada: cs@kantor\.test/,
    );
  });
});

describe('rakit isi akhir', () => {
  it('cid yatim dibuang, teks akhir menyertakan kutipan, ≤ 20.000 tag', () => {
    const quote = buildMailQuote({
      mode: 'reply',
      from: null,
      to: [],
      cc: [],
      subject: null,
      sentAt: null,
      html: null,
      text: 'asli',
      timeZone: 'Asia/Jakarta',
    });
    const result = assembleMailBody({
      format: 'html',
      bodyHtml: '<p>Halo <img src="cid:img-0a1b2c3d"><img src="cid:img-99999999"></p>',
      bodyText: null,
      quote,
      allowedCids: new Set(['img-0a1b2c3d']),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.cids).toEqual(['img-0a1b2c3d']);
    expect(result.html.startsWith('<div dir="auto">')).toBe(true);
    expect(result.text).toContain('> asli');
    const many = assembleMailBody({
      format: 'html',
      bodyHtml: '<b>x</b>'.repeat(20_001),
      bodyText: null,
      quote: null,
      allowedCids: new Set(),
    });
    expect(many).toEqual({ ok: false, reason: 'html_too_complex' });
  });

  it('mode teks → HTML di-escape tanpa <pre>', () => {
    const result = assembleMailBody({
      format: 'text',
      bodyHtml: null,
      bodyText: '<b>bukan tag</b>\nbaris 2',
      quote: null,
      allowedCids: new Set(),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain('&lt;b&gt;bukan tag&lt;/b&gt;<br />baris 2');
  });
});

describe('tanda tangan', () => {
  it('variabel di-escape; {{logo}} → cid logo', () => {
    const html = fillSignatureVariables(
      '<p>{{nama_agen}} — {{nama_organisasi}} {{logo}} {{lain}}</p>',
      {
        agentName: '<Dimas>',
        senderAddress: 'cs@kantor.test',
        organizationName: 'PT "Maju"',
        logo: { signatureId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', width: 200 },
      },
    );
    expect(html).toContain('&lt;Dimas&gt;');
    expect(html).toContain('src="cid:sig-logo-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"');
    expect(html).toContain('{{lain}}');
  });
});

describe('kunci & kode', () => {
  const keys = createMailComposeKeys(Buffer.alloc(32, 7));

  it('kode HMAC terikat identitas, perbandingan waktu-konstan', () => {
    const code = newMailVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
    const stored = keys.hashVerificationCode('id-1', code);
    expect(stored).not.toContain(code);
    expect(keys.verificationCodeMatches('id-1', code, stored)).toBe(true);
    expect(keys.verificationCodeMatches('id-2', code, stored)).toBe(false);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(keys.verificationCodeMatches('id-1', wrong, stored)).toBe(false);
  });

  it('threadKey opak, stabil, beda per akun; hash Message-ID tanpa <>', () => {
    const key = keys.threadKey('akun-a', 'akar@contoh.test');
    expect(key).toHaveLength(22);
    expect(key).not.toContain('akar');
    expect(keys.threadKey('akun-a', 'akar@contoh.test')).toBe(key);
    expect(keys.threadKey('akun-b', 'akar@contoh.test')).not.toBe(key);
    expect(mailMessageIdHash('<v.x@sistem.test>')).toBe(mailMessageIdHash('v.x@sistem.test'));
    expect(randomBase32()).toMatch(/^[a-z2-7]{26}$/);
  });
});

describe('MIME tulis', () => {
  const input = {
    from: { address: 'tagihan@kantor.test', name: 'Tim Tagihan' },
    replyTo: null,
    to: [{ address: 'rina@pelanggan.test', name: 'Rina' }],
    cc: [],
    bcc: [{ address: 'arsip@kantor.test', name: null }],
    subject: 'Tagihan',
    html: '<p>Halo</p>',
    text: 'Halo',
    messageId: 'abc@kantor.test',
    date: new Date('2026-11-23T00:00:00Z'),
    inReplyTo: 'asli@pelanggan.test',
    references: ['akar@pelanggan.test', 'jahat>\r\nBcc: x@y.test'],
    inline: [],
    attachments: [],
  };

  it('Bcc hanya di salinan; References tak sah dibuang; tanpa Auto-Submitted/X-Mailer', async () => {
    const mime = await buildComposedMime(input);
    const sending = mime.forSending.toString('utf8');
    const header = sending.slice(0, sending.indexOf('\r\n\r\n'));
    expect(mime.withBcc.toString('utf8')).toMatch(/^Bcc: arsip@kantor\.test/m);
    expect(header).not.toMatch(/^bcc:/im);
    expect(header).toContain('Message-ID: <abc@kantor.test>');
    expect(header).toContain('References: <akar@pelanggan.test>');
    expect(header).not.toContain('x@y.test');
    expect(header).not.toMatch(/auto-submitted|x-mailer/i);
  });

  it('header injection: subjek/nama dengan CRLF, U+2028, pengubah arah → ditolak', async () => {
    for (const subject of ['a\r\nBcc: x@y.test', 'a b', 'tagihan‮txt']) {
      await expect(buildComposedMime({ ...input, subject })).rejects.toThrow();
    }
    await expect(
      buildComposedMime({
        ...input,
        to: [{ address: 'rina@pelanggan.test', name: 'Rina\r\nBcc: x@y.test' }],
      }),
    ).rejects.toThrow();
  });

  it('stripBccHeader membuang baris lanjutan Bcc', () => {
    const raw = Buffer.from(
      'From: a@b.test\r\nBcc: x@y.test,\r\n z@y.test\r\nSubject: s\r\n\r\nBcc: bukan-header',
    );
    expect(stripBccHeader(raw).toString()).toBe(
      'From: a@b.test\r\nSubject: s\r\n\r\nBcc: bukan-header',
    );
  });
});
