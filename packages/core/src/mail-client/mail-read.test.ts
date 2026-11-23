/**
 * Modul Email 9A bagian 2 — isi, tampilan, lampiran, aksi IMAP (KONTRAK-API-EMAIL §8–§9).
 * Sanitasi tampilan (penjaga kerumitan dulu), penanda gambar, tautan menipu, risiko lampiran dari
 * nama & isi, peringatan pengirim, dan adaptor imapflow terhadap server IMAP tiruan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../secret';
import { TEST_IMAP_CERT } from '../channels/testing/test-cert';
import type { ImapPolicy } from '../channels/email-imap';
import { parseMailBody, parseMailTextPart, rawHeaderBlock } from './body';
import {
  classifyMailAttachmentContent,
  decodeTransferEncoding,
  mailAttachmentParts,
  mailAttachmentRiskOf,
  mailSenderWarnings,
  sniffRasterImage,
} from './content';
import {
  domainShownInLinkText,
  MAIL_BLANK_IMAGE,
  renderMailViewDocument,
  sanitizeMailHtmlForDisplay,
} from './display-html';
import { openMailImapSession } from './imap-account';
import { startFakeMailImap, type FakeMailImapServer } from './testing/fake-mail-imap';

const options = {
  linkWarningHref: (target: string, shown: string) =>
    `https://app.test/email/tautan?ke=${encodeURIComponent(target)}&tampil=${encodeURIComponent(shown)}`,
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('sanitizeMailHtmlForDisplay', () => {
  it('membuang skrip, event, javascript:, iframe/form/svg/meta/base/link; gaya berbahaya dibuang', () => {
    const result = sanitizeMailHtmlForDisplay(
      [
        '<html><head><meta http-equiv="refresh" content="0;url=https://jahat.test"><base href="https://jahat.test/">',
        '<link rel="stylesheet" href="https://jahat.test/a.css">',
        '<style>@import url(https://jahat.test/x.css); .k{color:red;background:url(https://jahat.test/p.gif)} .f{position:fixed;top:0}</style></head>',
        '<body onload="alert(1)"><script>alert(1)</script><div class="k" style="color:blue;background-image:url(https://jahat.test/t.gif);position:fixed">Halo</div>',
        '<a href="javascript:alert(1)">klik</a><a href="https://bank.test/bayar">bayar</a>',
        '<iframe src="https://jahat.test"></iframe><form action="https://jahat.test"><input name="x"></form>',
        '<svg><script>alert(1)</script></svg><img src="x" onerror="alert(1)"><object data="x"></object>',
        '</body></html>',
      ].join(''),
      options,
    );
    expect(result.tooComplex).toBe(false);
    const html = result.html.toLowerCase();
    for (const bad of [
      '<script',
      'onload',
      'onerror',
      'javascript:',
      '<iframe',
      '<form',
      '<input',
      '<svg',
      '<meta',
      '<base',
      '<link',
      '<object',
      '@import',
      'url(',
      'position:fixed',
      'position: fixed',
    ]) {
      expect(html, bad).not.toContain(bad);
    }
    expect(result.html).toContain('class="k"');
    expect(result.html).toContain('style="color: blue"');
    expect(result.html).toContain('<style>');
    expect(result.html).toContain('href="https://bank.test/bayar"');
    expect(result.html).toContain('rel="noopener noreferrer nofollow"');
    expect(result.html).toContain('target="_blank"');
  });

  it('gambar https dicabut ke daftar proksi (penanda), cid & data raster dipertahankan, http dibuang', () => {
    const result = sanitizeMailHtmlForDisplay(
      [
        '<img src="https://cdn.pengirim.test/logo.png" alt="Logo">',
        '<img src="https://cdn.pengirim.test/logo.png">',
        '<img src="https://pelacak.test/p.gif?u=1">',
        '<img src="http://tidak-aman.test/a.png" alt="lama">',
        '<img src="cid:logo123@pengirim.test">',
        `<img src="data:image/png;base64,${PNG.toString('base64')}">`,
        '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
        '<img src="balesin-remote:0">',
        '<img src="https://user:pass@cdn.test/a.png">',
      ].join(''),
      options,
    );
    expect(result.remoteImages).toEqual([
      'https://cdn.pengirim.test/logo.png',
      'https://pelacak.test/p.gif?u=1',
    ]);
    expect(result.html.match(/balesin-remote:0/g)).toHaveLength(2);
    expect(result.html).toContain('src="balesin-remote:1"');
    expect(result.html).toContain('src="balesin-cid:logo123@pengirim.test"');
    expect(result.html).toContain('data:image/png;base64');
    expect(result.html).not.toContain('svg+xml');
    expect(result.html).not.toContain('http://tidak-aman.test');
    expect(result.html).not.toContain('user:pass');
    // Penanda buatan email sendiri tidak lolos (bukan https/cid/data).
    expect(result.html.match(/<img/g)).toHaveLength(5);
  });

  it('tautan menipu (teks domain lain) ditulis ulang ke halaman peringatan; tautan jujur tidak', () => {
    const result = sanitizeMailHtmlForDisplay(
      [
        '<p><a href="https://login-bank.jahat.test/masuk">https://www.bank.co.id/masuk</a></p>',
        '<p><a href="https://www.bank.co.id/promo">www.bank.co.id</a></p>',
        '<p><a href="https://promo.bank.co.id/x">bank.co.id</a></p>',
        '<p><a href="https://jahat.test">Klik di sini</a></p>',
        '<p><a href="mailto:cs@bank.co.id">cs@bank.co.id</a></p>',
      ].join(''),
      options,
    );
    expect(result.linkWarnings).toBe(1);
    expect(result.html).toContain(
      `href="https://app.test/email/tautan?ke=${encodeURIComponent('https://login-bank.jahat.test/masuk')}&amp;tampil=bank.co.id"`,
    );
    expect(result.html).toContain('href="https://www.bank.co.id/promo"');
    expect(result.html).toContain('href="https://jahat.test"');
    expect(domainShownInLinkText('Klik di sini')).toBeNull();
    expect(domainShownInLinkText('HTTPS://WWW.Bank.co.id/a?b=1')).toBe('bank.co.id');
  });

  it('penjaga kerumitan SEBELUM sanitasi: > 512 KB atau sarang > 200 → tooComplex, cepat', () => {
    const deep = '<div>'.repeat(5_000) + 'x';
    const started = Date.now();
    expect(sanitizeMailHtmlForDisplay(deep, options)).toMatchObject({ tooComplex: true, html: '' });
    expect(sanitizeMailHtmlForDisplay(`<p>${'a'.repeat(600 * 1024)}</p>`, options).tooComplex).toBe(
      true,
    );
    expect(sanitizeMailHtmlForDisplay('<b>'.repeat(25_000), options).tooComplex).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('dokumen tampilan: penanda diganti saat disajikan; gambar diblokir = GIF kosong; teks di-escape', () => {
    const { html } = sanitizeMailHtmlForDisplay(
      '<img src="https://cdn.test/a.png" alt="A"><img src="cid:c1@x.test"><img src="cid:hilang@x.test">',
      options,
    );
    const blocked = renderMailViewDocument({
      html,
      text: null,
      imagesBase: null,
      cidUrls: new Map([['c1@x.test', '/api/v1/mail/view/TOKEN/cid/ID1']]),
    });
    expect(blocked).toContain(MAIL_BLANK_IMAGE);
    expect(blocked).toContain('data-gambar-diblokir="1"');
    expect(blocked).toContain('src="/api/v1/mail/view/TOKEN/cid/ID1"');
    expect(blocked).not.toContain('cdn.test');
    const shown = renderMailViewDocument({
      html,
      text: null,
      imagesBase: '/api/v1/mail/view/TOKEN/images',
      cidUrls: new Map(),
    });
    expect(shown).toContain('src="/api/v1/mail/view/TOKEN/images/0"');
    const text = renderMailViewDocument({
      html: null,
      text: '<script>alert(1)</script> & halo',
      imagesBase: null,
      cidUrls: new Map(),
    });
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; halo');
    expect(text).not.toContain('<script>');
  });
});

describe('isi email', () => {
  const multipart = [
    'From: "NOC" <noc@mitra.test>',
    'To: cs@contoh.test',
    'Subject: Pemeliharaan',
    'Message-ID: <a1@mitra.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BATAS"',
    '',
    '--BATAS',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>Halo <img src=3D"cid:logo@mitra.test"> <img src=3D"https://cdn.mitra.test/a.png"></p>',
    '--REL',
    'Content-Type: image/png',
    'Content-ID: <logo@mitra.test>',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline',
    '',
    PNG.toString('base64'),
    '--REL--',
    '--BATAS',
    'Content-Type: application/pdf; name="jadwal.pdf"',
    'Content-Disposition: attachment; filename="jadwal.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 isi').toString('base64'),
    '--BATAS',
    'Content-Type: application/octet-stream; name="setup.exe"',
    'Content-Disposition: attachment; filename="setup.exe"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('MZ\x90\x00program').toString('base64'),
    '--BATAS--',
    '',
  ].join('\r\n');

  it('parseMailBody: HTML tampilan berpenanda, gambar inline raster, header mentah tanpa isi', async () => {
    const body = await parseMailBody(Buffer.from(multipart), options);
    expect(body.html).toContain('src="balesin-cid:logo@mitra.test"');
    expect(body.html).toContain('src="balesin-remote:0"');
    expect(body.remoteImages).toEqual(['https://cdn.mitra.test/a.png']);
    expect(body.inlineImages).toHaveLength(1);
    expect(body.inlineImages[0]).toMatchObject({
      contentId: 'logo@mitra.test',
      contentType: 'image/png',
    });
    expect(body.rawHeaders).toContain('Subject: Pemeliharaan');
    expect(body.rawHeaders).not.toContain('--BATAS');
    expect(rawHeaderBlock(Buffer.from('A: b\r\n\r\nisi'))).toBe('A: b');
  });

  it('HTML terlalu rumit → hanya teks + catatan', async () => {
    const raw = [
      'From: a@b.test',
      'Content-Type: text/html; charset=utf-8',
      '',
      `${'<div>'.repeat(400)}Isi penting`,
    ].join('\r\n');
    const body = await parseMailBody(Buffer.from(raw), options);
    expect(body.html).toBeNull();
    expect(body.htmlOmitted).toBe(true);
    expect(body.text).toContain('Isi penting');
    expect(body.text).toContain('Tampilan HTML email ini tidak tersedia');
  });

  it('bagian teks email besar: dekode QP/base64 + charset', () => {
    const part = parseMailTextPart(
      Buffer.from('Tagihan =E2=82=AC10=\r\n lunas'),
      { encoding: 'quoted-printable', charset: 'utf-8', html: false },
      options,
    );
    expect(part.text).toBe('Tagihan €10 lunas');
    expect(decodeTransferEncoding(Buffer.from('aGFsbw==\r\n'), 'base64').toString()).toBe('halo');
  });

  it('lampiran dari BODYSTRUCTURE, risiko dari nama/jenis dan dari ISI', () => {
    const parts = mailAttachmentParts({
      part: null,
      type: 'multipart/mixed',
      encoding: null,
      charset: null,
      size: 0,
      disposition: null,
      filename: null,
      id: null,
      childNodes: [
        {
          part: '1',
          type: 'text/plain',
          encoding: '7bit',
          charset: 'utf-8',
          size: 10,
          disposition: null,
          filename: null,
          id: null,
          childNodes: [],
        },
        {
          part: '2',
          type: 'image/png',
          encoding: 'base64',
          charset: null,
          size: 100,
          disposition: 'inline',
          filename: null,
          id: '<logo@x>',
          childNodes: [],
        },
        {
          part: '3',
          type: 'application/zip',
          encoding: 'base64',
          charset: null,
          size: 900,
          disposition: 'attachment',
          filename: 'data.zip',
          id: null,
          childNodes: [],
        },
      ],
    });
    expect(parts.map((part) => [part.partId, part.isInline, part.contentId])).toEqual([
      ['2', true, 'logo@x'],
      ['3', false, null],
    ]);
    expect(mailAttachmentRiskOf('faktur.pdf', 'application/pdf').risk).toBe('ok');
    expect(mailAttachmentRiskOf('data.zip', 'application/zip').risk).toBe('warn');
    for (const name of ['a.exe', 'a.html', 'a.svg', 'a.docm', 'a.lnk', 'a.iso', 'a.js', 'a.hta']) {
      expect(mailAttachmentRiskOf(name, 'application/octet-stream').risk, name).toBe('blocked');
    }
    expect(mailAttachmentRiskOf('foto', 'image/svg+xml').risk).toBe('blocked');
    expect(mailAttachmentRiskOf('halaman', 'text/html').risk).toBe('blocked');

    expect(classifyMailAttachmentContent(Buffer.from('MZ\x90\x00'), 'faktur.pdf').risk).toBe(
      'blocked',
    );
    expect(
      classifyMailAttachmentContent(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        'lama.doc',
      ).risk,
    ).toBe('blocked');
    expect(classifyMailAttachmentContent(Buffer.from('<html><script>'), 'faktur.pdf').risk).toBe(
      'blocked',
    );
    expect(
      classifyMailAttachmentContent(Buffer.from('<?xml version="1.0"?><svg>'), 'gambar.png').risk,
    ).toBe('blocked');
    expect(classifyMailAttachmentContent(Buffer.from('PK\x03\x04isi'), 'arsip.zip').risk).toBe(
      'warn',
    );
    expect(classifyMailAttachmentContent(PNG, 'foto.jpg')).toMatchObject({
      risk: 'ok',
      detectedType: 'image/png',
    });
    expect(classifyMailAttachmentContent(Buffer.from('%PDF-1.7'), 'a.pdf').detectedType).toBe(
      'application/pdf',
    );
    expect(sniffRasterImage(Buffer.from('<svg>'))).toBeNull();
  });

  it('peringatan pengirim: penyamaran nama & domain mirip; domain sendiri aman', () => {
    const context = {
      organizationDomains: ['skytech.net.id'],
      protectedNames: ['Putu Tobing', 'PT Sky Base Technology Digital'],
    };
    expect(
      mailSenderWarnings({ address: 'putu@gmail.test', name: 'Putu  tobing' }, context),
    ).toEqual(['impersonation']);
    expect(
      mailSenderWarnings({ address: 'billing@skytech-net.id', name: 'Billing' }, context),
    ).toContain('lookalike_sender');
    expect(mailSenderWarnings({ address: 'cs@skytehc.net.id', name: null }, context)).toEqual([
      'lookalike_sender',
    ]);
    expect(mailSenderWarnings({ address: 'cs@sky7ech.net.id', name: null }, context)).toEqual([
      'lookalike_sender',
    ]);
    expect(
      mailSenderWarnings({ address: 'putu@skytech.net.id', name: 'Putu Tobing' }, context),
    ).toEqual([]);
    expect(mailSenderWarnings({ address: 'noc@mitra.test', name: 'NOC Mitra' }, context)).toEqual(
      [],
    );
    expect(
      mailSenderWarnings({ address: 'a@luar.test', name: 'Admin admin@skytech.net.id' }, context),
    ).toEqual(['impersonation']);
  });
});

describe('adaptor IMAP: isi & aksi dua arah', () => {
  let server: FakeMailImapServer;
  let noMove: FakeMailImapServer;
  let policyFor: (port: number) => ImapPolicy;
  const config = (port: number) => ({
    host: 'imap.contoh.test',
    port,
    security: 'ssl' as const,
    username: 'cs@contoh.test',
    password: new Secret('rahasia-imap'),
  });

  beforeAll(async () => {
    server = await startFakeMailImap({ move: true });
    noMove = await startFakeMailImap({ move: false });
    policyFor = (port) => ({
      allowedPorts: [port],
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      testCa: TEST_IMAP_CERT,
      strict: { privateCidrs: [], allowLoopback: true },
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
    });
  });

  afterAll(async () => {
    await server.close();
    await noMove.close();
  });

  it('fetchSource & fetchPart per potongan; UID hilang → null', async () => {
    const big = `From: a@b.test\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(4 * 1024 * 1024)}`;
    const uid = server.add('INBOX', big);
    const partUid = server.add(
      'INBOX',
      [
        'From: a@b.test',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain',
        '',
        'teks',
        '--B',
        'Content-Type: application/pdf; name="a.pdf"',
        'Content-Disposition: attachment; filename="a.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-isi').toString('base64'),
        '--B--',
        '',
      ].join('\r\n'),
    );
    const session = await openMailImapSession(config(server.port), policyFor(server.port));
    try {
      await session.select('INBOX');
      const source = await session.fetchSource(uid, 25 * 1024 * 1024);
      expect(source?.truncated).toBe(false);
      expect(source?.bytes.length).toBe(Buffer.byteLength(big));
      const cut = await session.fetchSource(uid, 1024);
      expect(cut).toMatchObject({ truncated: true });
      expect(cut?.bytes.length).toBe(1024);
      const [message] = await session.fetchHeaders([partUid]);
      expect(message?.bodyStructure?.childNodes.map((node) => node.type)).toEqual([
        'text/plain',
        'application/pdf',
      ]);
      const part = await session.fetchPart(partUid, '2', 1024 * 1024);
      expect(decodeTransferEncoding(part?.bytes ?? Buffer.alloc(0), 'base64').toString()).toBe(
        '%PDF-isi',
      );
      expect(await session.fetchSource(9_999, 1024)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('bendera, MOVE (COPYUID), CREATE, hapus permanen UID EXPUNGE', async () => {
    const uid = server.add('INBOX', 'From: a@b.test\r\n\r\nhalo');
    const session = await openMailImapSession(config(server.port), policyFor(server.port));
    try {
      await session.openWritable('INBOX');
      expect(await session.storeFlags([uid], ['\\Seen', '\\Flagged'], [])).toBe(true);
      expect(server.folders.get('INBOX')?.messages.find((m) => m.uid === uid)?.flags).toEqual([
        '\\Seen',
        '\\Flagged',
      ]);
      expect(await session.storeFlags([uid], [], ['\\Flagged'])).toBe(true);
      expect(await session.createFolder('INBOX.Archive')).toBe(true);
      const moved = await session.move([uid], 'INBOX.Archive');
      expect(moved?.uidMap.get(uid)).toBe(1);
      expect(server.folders.get('INBOX')?.messages.some((m) => m.uid === uid)).toBe(false);
      expect(server.folders.get('INBOX.Archive')?.messages[0]?.flags).toEqual(['\\Seen']);
      expect(server.commands.some((command) => command.startsWith('UID MOVE'))).toBe(true);
      await session.openWritable('INBOX.Archive');
      expect(await session.expunge([1])).toBe(true);
      expect(server.folders.get('INBOX.Archive')?.messages).toHaveLength(0);
      expect(server.commands).not.toContain('EXPUNGE');
    } finally {
      await session.close();
    }
  });

  it('tanpa MOVE: UID COPY + \\Deleted + UID EXPUNGE (tidak pernah EXPUNGE biasa)', async () => {
    const keep = noMove.add('INBOX', 'From: a@b.test\r\n\r\nsudah ditandai hapus orang lain', {
      flags: ['\\Deleted'],
    });
    const uid = noMove.add('INBOX', 'From: a@b.test\r\n\r\npindah');
    const session = await openMailImapSession(config(noMove.port), policyFor(noMove.port));
    try {
      await session.openWritable('INBOX');
      const moved = await session.move([uid], 'INBOX.Trash');
      expect(moved?.uidMap.get(uid)).toBe(1);
      const inbox = noMove.folders.get('INBOX')?.messages ?? [];
      expect(inbox.map((m) => m.uid)).toEqual([keep]);
      expect(noMove.commands.some((command) => command.startsWith('UID COPY'))).toBe(true);
      expect(noMove.commands.some((command) => command.startsWith('UID EXPUNGE'))).toBe(true);
      expect(noMove.commands).not.toContain('EXPUNGE');
      expect(await session.move([uid], 'INBOX.TidakAda')).toBeNull();
    } finally {
      await session.close();
    }
  });
});
