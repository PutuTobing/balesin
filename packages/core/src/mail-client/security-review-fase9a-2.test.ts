/**
 * Review keamanan 9A bagian 2 (docs/security-reviews/2026-11-23-fase9a-2.md) — sanitasi tampilan &
 * risiko lampiran.
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import { describe, expect, it } from 'vitest';

import { classifyMailAttachmentContent, mailAttachmentRiskOf } from './content';
import { renderMailViewDocument, sanitizeMailHtmlForDisplay } from './display-html';

const options = {
  linkWarningHref: (target: string, shown: string) =>
    `https://app.test/email/tautan?ke=${encodeURIComponent(target)}&tampil=${encodeURIComponent(shown)}`,
};
const clean = (html: string) => sanitizeMailHtmlForDisplay(html, options);

describe('review 9A-2 — sanitasi dokumen tampilan (regresi)', () => {
  it('penanda gambar hanya bisa dibuat sanitizer: src berbentuk penanda dari email dibuang', () => {
    const result = clean(
      '<img src="balesin-remote:0"><img src="balesin-cid:x@y"><img src="BALESIN-REMOTE:1"><p>ok</p>',
    );
    expect(result.html).not.toMatch(/<img/i);
    expect(result.remoteImages).toEqual([]);
  });

  it('teks berbentuk penanda tidak menjadi elemen gambar saat disajikan', () => {
    const result = clean('<p>src="balesin-remote:0" &lt;img src="balesin-remote:0"&gt;</p>');
    const doc = renderMailViewDocument({
      html: result.html,
      text: null,
      imagesBase: '/api/v1/mail/view/TOKEN/images',
      cidUrls: new Map(),
    });
    // Hanya elemen <img> asli yang boleh ada — di sini tidak ada sama sekali.
    expect(doc).not.toMatch(/<img/i);
  });

  it('blok <style> tidak bisa ditutup dari dalam (</style> dibuang), tanpa url()/@import/expression', () => {
    const result = clean(
      '<style>p{color:red}</style ><style>a{x:1}</style><img src=x onerror=alert(1)>' +
        '<style>@import "https://jahat.test/a.css"; b{background:url(https://jahat.test/x)} ' +
        'i{width:expression(alert(1))} s{position:fixed}</style><p>isi</p>',
    );
    expect(result.html).not.toMatch(/onerror|@import|url\(|expression\(|position\s*:\s*fixed/i);
    const styles = result.html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
    for (const block of styles) expect(block.slice(7, -8)).not.toMatch(/[<>]/);
  });

  it('elemen yang bisa menavigasi/memuat (meta refresh, base, link, form, iframe, svg, math) dibuang', () => {
    const result = clean(
      '<meta http-equiv="refresh" content="0;url=https://jahat.test"><base href="https://jahat.test/">' +
        '<link rel="stylesheet" href="https://jahat.test/a.css"><form action="https://jahat.test"><input name=p></form>' +
        '<iframe src="https://jahat.test"></iframe><svg><a href="javascript:alert(1)"><text>x</text></a></svg>' +
        '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>' +
        '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript><p>isi</p>',
    );
    expect(result.html).not.toMatch(/<(meta|base|link|form|input|iframe|svg|math|noscript|img)\b/i);
    // Isi <style> dari dalam <math> ikut diekstrak sebagai CSS (tanpa `<`/`>`) — teks CSS mati, bukan
    // elemen. Di luar blok gaya tidak boleh ada sisa atribut event/javascript:.
    const outsideStyles = result.html.replace(/<style>[^<]*<\/style>/g, '');
    expect(outsideStyles).not.toMatch(/onerror|javascript:/i);
  });

  it('tautan javascript:/data: (juga ber-entitas & berspasi) dibuang; tautan lain target _blank + noopener', () => {
    const result = clean(
      '<a href="java&#x09;script:alert(1)">a</a><a href="&#106;avascript:alert(1)">b</a>' +
        '<a href="data:text/html;base64,PHNjcmlwdD4=">c</a><a href="https://baik.test/">d</a>',
    );
    expect(result.html).not.toMatch(/javascript|data:text/i);
    expect(result.html).toContain('href="https://baik.test/"');
    expect(result.html).toMatch(/rel="noopener noreferrer nofollow"/);
  });

  it('tautan menipu (teks bank.co.id → domain lain) diarahkan ke halaman peringatan', () => {
    const result = clean(
      '<a href="https://bank-co-id.jahat.test/masuk">https://bank.co.id/masuk</a>',
    );
    expect(result.linkWarnings).toBe(1);
    expect(result.html).toContain('https://app.test/email/tautan?ke=');
  });
});

describe('review 9A-2 — risiko lampiran', () => {
  it('regresi: isi program (MZ/ELF/shebang), CFB, HTML/SVG diblokir apa pun namanya', () => {
    for (const [bytes, name] of [
      [Buffer.from('MZ\x90\x00'), 'faktur.pdf'],
      [Buffer.from('\x7fELF'), 'foto.jpg'],
      [Buffer.from('#!/bin/sh\nrm -rf ~'), 'catatan.txt'],
      [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'laporan.pdf'],
      [Buffer.from('<!doctype html><script>x</script>'), 'struk.txt'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), 'logo.png'],
    ] as const) {
      expect(classifyMailAttachmentContent(bytes, name).risk, name).toBe('blocked');
    }
  });

  // R7: titik/spasi di akhir nama melewati pemeriksaan ekstensi; Windows/Firefox membuangnya saat
  // menyimpan → `tagihan.js` dijalankan Windows Script Host saat dibuka.
  it.fails('nama berakhiran titik (`tagihan.pdf.js.`) tetap diblokir seperti `.js`', () => {
    expect(mailAttachmentRiskOf('tagihan.pdf.js.', 'application/octet-stream').risk).toBe(
      'blocked',
    );
    expect(
      classifyMailAttachmentContent(
        Buffer.from('var s = new ActiveXObject("WScript.Shell");'),
        'tagihan.pdf.js.',
      ).risk,
    ).toBe('blocked');
  });

  it('regresi: pintasan internet `.url` diblokir walau isinya teks biasa', () => {
    expect(
      classifyMailAttachmentContent(
        Buffer.from('[InternetShortcut]\r\nURL=file://192.0.2.1/share/x.exe\r\n'),
        'jadwal.url',
      ).risk,
    ).toBe('blocked');
  });

  // R7: skrip Windows Script Host `.ws`/`.vb` dan konektor pencarian `.searchconnector-ms`/`.search-ms`
  // (dipakai kampanye phishing untuk membuka berbagi WebDAV) tidak ada di daftar; isinya teks → `ok`.
  it.fails('skrip WSH `.ws`/`.vb` dan `.searchconnector-ms`/`.search-ms` diblokir', () => {
    for (const name of [
      'jadwal.ws',
      'jadwal.vb',
      'jadwal.searchconnector-ms',
      'jadwal.search-ms',
    ]) {
      expect(
        classifyMailAttachmentContent(Buffer.from('CreateObject("WScript.Shell").Run "x"'), name)
          .risk,
        name,
      ).toBe('blocked');
    }
  });
});
