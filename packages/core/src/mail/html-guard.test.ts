/**
 * Review 9.1 putaran 2 S3 (Tinggi): penjaga kerumitan HTML sebelum sanitize-html (super-linear
 * terhadap kedalaman tag) + versi teks darurat linear. Tes kinerja memakai masukan terburuk di batas
 * ukuran (512 KB API, email masuk 5 MB) dengan anggaran waktu longgar untuk CI.
 */
import { describe, expect, it } from 'vitest';

import { parseInboundEmail, sanitizeEmailHtml } from '../channels/email-message';
import {
  EMAIL_HTML_MAX_DEPTH,
  EMAIL_HTML_MAX_TAGS,
  measureHtmlComplexity,
  plainTextFromUntrustedHtml,
} from './html-guard';
import {
  EMAIL_HTML_MAX_BYTES,
  renderOutboundEmail,
  sanitizeOutboundEmailHtml,
  scanTemplateVariables,
} from './outbound-html';

const KB = 1024;
const nested = (depth: number, inner = 'x') =>
  '<div>'.repeat(depth) + inner + '</div>'.repeat(depth);

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

const render = (html: string, substituteVariables = false, values: Record<string, string> = {}) =>
  renderOutboundEmail({
    subject: 'Tagihan',
    html,
    text: null,
    values,
    organizationName: 'Organisasi',
    qrisImageSrc: null,
    layout: 'brand',
    brand: { primaryColor: '#112233', logoSrc: null, footerText: null },
    substituteVariables,
  });

describe('measureHtmlComplexity', () => {
  it('menghitung tag pembuka dan kedalaman sarang', () => {
    expect(measureHtmlComplexity('<p>Halo <b>Budi</b></p><div><span>x</span></div>')).toEqual({
      ok: true,
      tags: 4,
      maxDepth: 2,
    });
    expect(measureHtmlComplexity('teks saja')).toEqual({ ok: true, tags: 0, maxDepth: 0 });
  });

  it('tag void & self-closing tidak menumpuk kedalaman', () => {
    const result = measureHtmlComplexity(
      `<div>${'<br><img src="cid:a"><hr/>'.repeat(1_000)}</div>`,
    );
    expect(result).toMatchObject({ ok: true, maxDepth: 2 });
    expect(measureHtmlComplexity(`<svg>${'<path/>'.repeat(500)}</svg>`)).toMatchObject({
      ok: true,
      maxDepth: 2,
    });
  });

  it('penutupan tersirat (<p>, <li>, <td>) mengikuti parser — daftar panjang tanpa penutup tetap dangkal', () => {
    expect(measureHtmlComplexity(`<ul>${'<li>butir'.repeat(1_000)}</ul>`)).toMatchObject({
      ok: true,
      maxDepth: 2,
    });
    expect(measureHtmlComplexity('<p>satu'.repeat(1_000))).toMatchObject({ ok: true, maxDepth: 1 });
    expect(measureHtmlComplexity(`<table>${'<tr><td>a<td>b'.repeat(500)}</table>`)).toMatchObject({
      ok: true,
    });
  });

  it('isi komentar, <script>, <style>, <textarea>, <title> tidak dihitung sebagai tag', () => {
    const hidden = '<div>'.repeat(5_000);
    for (const html of [
      `<!--${hidden}-->`,
      `<script>${hidden}</script>`,
      `<style>${hidden}</style>`,
      `<textarea>${hidden}</textarea>`,
      `<title>${hidden}</title>`,
    ]) {
      expect(measureHtmlComplexity(html), html.slice(0, 12)).toMatchObject({ ok: true });
    }
  });

  it('komentar yang ditutup lebih awal oleh parser tidak menyembunyikan tag (<!--> dan --!>)', () => {
    for (const html of [
      `<!-->${'<div>'.repeat(300)}`,
      `<!--->${'<div>'.repeat(300)}`,
      `<!-- a --!>${'<div>'.repeat(300)}`,
    ]) {
      expect(measureHtmlComplexity(html), html.slice(0, 12)).toMatchObject({
        ok: false,
        reason: 'depth',
      });
    }
  });

  it('tag penutup tanpa pasangan tidak mengurangi kedalaman', () => {
    expect(measureHtmlComplexity('<div><div></i></b></span>'.repeat(150))).toMatchObject({
      ok: false,
      reason: 'depth',
    });
  });

  it('kedalaman tepat 200 lolos; 201 ditolak', () => {
    expect(measureHtmlComplexity(nested(EMAIL_HTML_MAX_DEPTH))).toMatchObject({
      ok: true,
      maxDepth: EMAIL_HTML_MAX_DEPTH,
    });
    expect(measureHtmlComplexity(nested(EMAIL_HTML_MAX_DEPTH + 1))).toMatchObject({
      ok: false,
      reason: 'depth',
    });
  });

  it('20.000 tag lolos; 20.001 ditolak', () => {
    expect(measureHtmlComplexity('<b>x</b>'.repeat(EMAIL_HTML_MAX_TAGS))).toMatchObject({
      ok: true,
      tags: EMAIL_HTML_MAX_TAGS,
    });
    expect(measureHtmlComplexity('<b>x</b>'.repeat(EMAIL_HTML_MAX_TAGS + 1))).toMatchObject({
      ok: false,
      reason: 'tags',
    });
  });

  it('berhenti di batas: 5 MB <div> bersarang / datar diukur < 500 ms', () => {
    for (const html of [
      '<div>'.repeat(1_000_000),
      '<b>'.repeat(1_700_000),
      '<br>'.repeat(1_200_000),
    ]) {
      const { value, ms } = timed(() => measureHtmlComplexity(html));
      expect(value.ok).toBe(false);
      expect(ms).toBeLessThan(500);
    }
  });
});

describe('sanitasi & render HTML keluar di batas (S3)', () => {
  it('sanitizeOutboundEmailHtml: HTML terlalu rumit tidak disanitasi → tooComplex, html kosong', () => {
    const result = sanitizeOutboundEmailHtml(nested(EMAIL_HTML_MAX_DEPTH + 1));
    expect(result).toMatchObject({ html: '', tooComplex: true, forbidden: false });
    expect(result.warnings.join(' ')).toContain('terlalu rumit');
    expect(sanitizeOutboundEmailHtml('<p>Halo</p>').tooComplex).toBe(false);
  });

  it('renderOutboundEmail: 512 KB <div> bersarang → galat html_too_complex < 1 dtk', () => {
    const html = '<div>'.repeat(Math.floor(EMAIL_HTML_MAX_BYTES / 5));
    const { value, ms } = timed(() => render(html));
    expect(ms).toBeLessThan(1_000);
    expect(value).toEqual({
      ok: false,
      errors: [expect.objectContaining({ field: 'html', reason: 'html_too_complex' })],
    });
  });

  it('renderOutboundEmail: galat subjek tetap dilaporkan bersama html_too_complex', () => {
    const result = renderOutboundEmail({
      subject: '',
      html: nested(500),
      text: null,
      values: {},
      organizationName: 'Organisasi',
      qrisImageSrc: null,
      layout: 'none',
      brand: { primaryColor: '#112233', logoSrc: null, footerText: null },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.reason).sort()).toEqual([
      'html_too_complex',
      'subject_invalid',
    ]);
  });

  it('nilai variabel yang menambah > 20.000 <br> → html_too_complex (sanitasi kedua ikut dijaga)', () => {
    const result = render('<p>{{catatan}}</p>', true, {
      catatan: '\n'.repeat(EMAIL_HTML_MAX_TAGS + 5),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.reason).toBe('html_too_complex');
  });

  it('di dalam batas tetap dirender: kedalaman 200 + teks ~500 KB < 2 dtk', () => {
    const filler = 'Rincian tagihan pelanggan. '.repeat(Math.floor((500 * KB) / 27));
    const { value, ms } = timed(() => render(nested(EMAIL_HTML_MAX_DEPTH, filler)));
    expect(value.ok).toBe(true);
    expect(ms).toBeLessThan(2_000);
  });

  it('di dalam batas: 20.000 tag datar beratribut (~510 KB) dirender < 2 dtk', () => {
    const row = '<td style="padding:4px">Rp10.000</td>';
    const html = `<table>${`<tr>${row}</tr>`.repeat(EMAIL_HTML_MAX_TAGS / 2 - 1)}</table>`;
    expect(html.length).toBeLessThan(EMAIL_HTML_MAX_BYTES);
    const { value, ms } = timed(() => render(html));
    expect(value.ok).toBe(true);
    expect(ms).toBeLessThan(2_000);
  });

  it('di dalam batas: 198 tingkat + 18.000 cabang (≈ 18.200 tag) disanitasi < 2 dtk', () => {
    const html = `${'<div>'.repeat(EMAIL_HTML_MAX_DEPTH - 2)}${'<span><b>a</b></span>'.repeat(9_000)}`;
    expect(measureHtmlComplexity(html).ok).toBe(true);
    const { ms } = timed(() => sanitizeOutboundEmailHtml(html));
    expect(ms).toBeLessThan(2_000);
  });

  it('scanTemplateVariables memakai hasil sanitasi yang diberikan (tanpa sanitasi ulang)', () => {
    const html = '<p>Halo {{nama}}</p><a href="{{tautan}}">bayar</a>';
    const sanitized = sanitizeOutboundEmailHtml(html).html;
    expect(
      scanTemplateVariables({ subject: 'x', html, text: null, sanitizedHtml: sanitized }),
    ).toEqual(scanTemplateVariables({ subject: 'x', html, text: null }));
  });

  it('render isi luar tanpa variabel = hasil sanitasi pertama (tanpa sanitasi kedua) — sama dengan sebelumnya', () => {
    const html =
      '<p style="color:red" onclick="x()">Halo <a href="https://contoh.example">tautan</a></p>';
    const once = sanitizeOutboundEmailHtml(html).html;
    expect(sanitizeOutboundEmailHtml(once).html).toBe(once);
    const result = render(html);
    expect(result.ok && result.html?.includes(once)).toBe(true);
  });
});

describe('sanitizeEmailHtml (profil masuk) dijaga', () => {
  it('HTML jauh di atas batas → string kosong, cepat', () => {
    const { value, ms } = timed(() => sanitizeEmailHtml('<div>'.repeat(100_000)));
    expect(value).toBe('');
    expect(ms).toBeLessThan(500);
  });

  it('dokumen email keluar berbingkai (kedalaman isi 200 + bingkai merek) tetap disanitasi untuk Inbox', () => {
    const result = render(nested(EMAIL_HTML_MAX_DEPTH, 'Isi tagihan'));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.html) return;
    expect(sanitizeEmailHtml(result.html)).toContain('Isi tagihan');
  });
});

describe('plainTextFromUntrustedHtml (versi teks darurat, linear)', () => {
  it('tag dibuang, blok jadi baris, script/style/head dilewati, entitas dasar didekode', () => {
    const html =
      '<html><head><title>Judul</title><style>p{color:red}</style></head><body>' +
      '<p>Halo&nbsp;Budi &amp; tim</p><script>alert(1)</script><div>Tagihan &#8364;10 &lt;lunas&gt;</div>' +
      '<!-- komentar --><table><tr><td>a</td><td>b</td></tr></table></body></html>';
    expect(plainTextFromUntrustedHtml(html)).toBe('Halo Budi & tim\n\nTagihan €10 <lunas>\n\na b');
  });

  it('dibatasi panjangnya', () => {
    expect(plainTextFromUntrustedHtml('a'.repeat(200_000), 1_000)).toHaveLength(1_000);
  });

  it('5 MB masukan terburuk (<, <!--, <script tanpa penutup, sarang) < 1 dtk', () => {
    const size = 5 * KB * KB;
    for (const html of [
      '<'.repeat(size),
      '<!--'.repeat(size / 4),
      '<script>'.repeat(size / 8),
      '<div>'.repeat(size / 5),
      '<a b="'.repeat(size / 6),
      '&#'.repeat(size / 2),
    ]) {
      const { ms } = timed(() => plainTextFromUntrustedHtml(html));
      expect(ms, html.slice(0, 8)).toBeLessThan(1_000);
    }
  });
});

describe('email MASUK (worker, tanpa autentikasi)', () => {
  const crlf = '\r\n';
  const message = (contentType: string, body: string, extraHeaders: string[] = []) =>
    Buffer.from(
      [
        'From: Luar <luar@contoh.example>',
        'To: cs@perusahaan.example',
        'Subject: Halo',
        'Message-ID: <uji-s3@contoh.example>',
        'Date: Mon, 23 Nov 2026 00:00:00 +0700',
        'MIME-Version: 1.0',
        ...extraHeaders,
        `Content-Type: ${contentType}`,
      ].join(crlf) +
        crlf +
        crlf +
        body +
        crlf,
    );
  const parse = async (raw: Buffer) => {
    const result = await parseInboundEmail(raw, ['cs@perusahaan.example'], []);
    if (!result.ok) throw new Error(result.reason);
    return result.email;
  };

  it('5 MB HTML bersarang: diurai < 3 dtk, HTML dibuang, versi teks + catatan', async () => {
    const start = performance.now();
    const email = await parse(
      message('text/html; charset=utf-8', `<p>Halo tim</p>${'<div>'.repeat(1_000_000)}`),
    );
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(email.html).toBeNull();
    expect(email.text).toContain('Halo tim');
    expect(email.text).toContain('Tampilan HTML email ini tidak tersedia');
  }, 60_000);

  it('5 MB tag datar (base64, multipart dengan bagian teks): bagian teks dipakai + catatan', async () => {
    const boundary = 'batas-uji';
    const html = Buffer.from('<b>x</b>'.repeat(650_000)).toString('base64');
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Versi teks asli',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      html.replace(/.{76}/g, (line) => line + crlf),
      `--${boundary}--`,
    ].join(crlf);
    const start = performance.now();
    const email = await parse(message(`multipart/alternative; boundary="${boundary}"`, body));
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(email.html).toBeNull();
    expect(email.text).toBe(
      'Versi teks asli\n\n(Tampilan HTML email ini tidak tersedia karena terlalu besar atau terlalu rumit. Yang tampil hanya versi teksnya.)',
    );
  }, 60_000);

  it('HTML < 512 KB tetapi sarang 300 tingkat: HTML dibuang SEBELUM sanitasi, teks dari HTML', async () => {
    const email = await parse(message('text/html; charset=utf-8', nested(300, 'Isi penting')));
    expect(email.html).toBeNull();
    expect(email.text?.startsWith('Isi penting')).toBe(true);
    expect(email.text).toContain('tidak tersedia');
  });

  it('HTML wajar tetap tersanitasi & tampil (tanpa catatan)', async () => {
    const email = await parse(
      message(
        'text/html; charset=utf-8',
        `${nested(EMAIL_HTML_MAX_DEPTH, 'Halo')}<script>x()</script>`,
      ),
    );
    expect(email.html).toContain('Halo');
    expect(email.html).not.toContain('script');
    expect(email.text ?? '').not.toContain('tidak tersedia');
  });
});
