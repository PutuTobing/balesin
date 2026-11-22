import { EMAIL_TEMPLATE_PRESETS } from '@balesin/shared';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_QRIS_SCAN_TEXT,
  EMAIL_TEMPLATE_BUILTIN_VARIABLES,
  htmlToText,
  renderOutboundEmail,
  sanitizeOutboundEmailHtml,
  scanTemplateVariables,
  type RenderOutboundEmailInput,
} from './outbound-html';

const brand = { primaryColor: '#0f766e', logoSrc: 'cid:logo', footerText: 'Kaki email' };

function render(overrides: Partial<RenderOutboundEmailInput>) {
  return renderOutboundEmail({
    subject: 'Halo {{nama}}',
    html: '<p>Halo {{nama}}</p>',
    text: null,
    values: { nama: 'Budi' },
    organizationName: 'Maju Jaya',
    qrisImageSrc: null,
    layout: 'none',
    brand,
    ...overrides,
  });
}

describe('sanitizeOutboundEmailHtml', () => {
  it('membuang skrip, on*, javascript:, iframe, svg, form → forbidden', () => {
    for (const html of [
      '<p>a</p><script>alert(1)</script>',
      '<p onclick="x()">a</p>',
      '<a href="javascript:alert(1)">a</a>',
      '<a href="java&#x09;script:alert(1)">a</a>',
      '<iframe src="https://x.example"></iframe>',
      '<svg><circle r="1"/></svg>',
      '<form><input name="a"></form>',
    ]) {
      const result = sanitizeOutboundEmailHtml(html);
      expect(result.forbidden, html).toBe(true);
      expect(result.changed, html).toBe(true);
      expect(result.html, html).not.toMatch(/script|onclick|javascript|iframe|svg|form|input/i);
    }
    expect(sanitizeOutboundEmailHtml('<script>alert(1)</script>').warnings).toContain(
      'Skrip dibuang.',
    );
  });

  it('mempertahankan tabel, atribut tata letak, gaya aman, cid/https/data kecil', () => {
    const html =
      '<table width="100%" cellpadding="0" border="0" style="border-collapse: collapse"><tr><td align="right" style="color: #111; padding: 8px">Rp1</td></tr></table>' +
      '<img src="cid:qris" alt="QR"><img src="https://cdn.contoh.example/a.png" alt="A">' +
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="B"><a href="mailto:cs@contoh.example">CS</a>';
    const result = sanitizeOutboundEmailHtml(html);
    expect(result).toMatchObject({ changed: false, forbidden: false, warnings: [] });
    expect(result.html).toContain('cellpadding="0"');
    expect(result.html).toContain('style="color: #111; padding: 8px"');
    expect(result.html).toContain('src="cid:qris"');
    expect(result.html).toContain('src="https://cdn.contoh.example/a.png"');
    expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(result.html).toContain('target="_blank"');
    expect(result.html).toContain('rel="noopener noreferrer"');
  });

  it('membuang url()/expression/position fixed di style & <style>, @import', () => {
    const inline = sanitizeOutboundEmailHtml(
      '<p style="color: red; background: url(https://x.example/a.png); position: fixed; width: expression(1)">a</p>',
    );
    expect(inline.changed).toBe(true);
    expect(inline.forbidden).toBe(false);
    expect(inline.html).toContain('style="color: red"');
    const block = sanitizeOutboundEmailHtml(
      '<style>@import url(https://x.example/a.css); p { color: red; background: url(x) } .a { position: fixed; } .b { b\\61ckground: u\\72l(x) }</style><p>a</p>',
    );
    expect(block.changed).toBe(true);
    expect(block.html).not.toMatch(/@import|url\(|position|\\/i);
    expect(block.html).toContain('<style>');
    expect(block.html).toContain('color: red');
  });

  it('gambar http:, data: > 100 KB / bukan raster dibuang', () => {
    const big = `data:image/png;base64,${'A'.repeat(140_000)}`;
    for (const src of ['http://x.example/a.png', big, 'data:image/svg+xml;base64,PHN2Zz4=']) {
      const result = sanitizeOutboundEmailHtml(`<p>a</p><img src="${src}" alt="x">`);
      expect(result.changed, src.slice(0, 30)).toBe(true);
      expect(result.html).not.toContain('<img');
    }
    expect(sanitizeOutboundEmailHtml('<img src="http://x.example/a.png">').warnings).toContain(
      'Gambar dari alamat http:// dibuang.',
    );
  });

  it('placeholder di teks & href bertahan', () => {
    const result = sanitizeOutboundEmailHtml('<p>{{nama}}</p><a href="{{ tautan }}">Bayar</a>');
    expect(result.changed).toBe(false);
    expect(result.html).toContain('{{nama}}');
    expect(result.html).toContain('href="{{ tautan }}"');
  });

  it('pembungkus dokumen penuh dibuang tanpa dianggap perubahan', () => {
    const result = sanitizeOutboundEmailHtml(
      '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><p>Isi</p></body></html>',
    );
    expect(result.changed).toBe(false);
    expect(result.html).toBe('<p>Isi</p>');
  });
});

describe('scanTemplateVariables', () => {
  it('mengumpulkan variabel sah (termasuk bawaan) dan masalah konteks', () => {
    const scan = scanTemplateVariables({
      subject: 'Tagihan {{ periode }}',
      html: '<p title="{{judul}}">{{nama}} {{qris}}</p><a href="{{tautan}}">x</a><a href="https://x.example/{{id}}">y</a><p style="color: {{warna}}">z</p><p>{{Salah}}</p>',
      text: '{{nama_organisasi}}',
    });
    expect(scan.used).toEqual([
      'periode',
      'judul',
      'nama',
      'qris',
      'tautan',
      'id',
      'warna',
      'nama_organisasi',
    ]);
    expect(scan.problems).toEqual(
      expect.arrayContaining([
        { field: 'html', name: 'judul', reason: 'attribute_not_supported' },
        { field: 'html', name: 'id', reason: 'attribute_not_supported' },
        { field: 'html', name: 'warna', reason: 'attribute_not_supported' },
        { field: 'html', name: 'Salah', reason: 'invalid_name' },
      ]),
    );
    expect(scan.problems.some((problem) => problem.name === 'tautan')).toBe(false);
  });
});

describe('renderOutboundEmail', () => {
  it('nilai variabel selalu di-escape, baris baru → <br>', () => {
    const result = render({
      subject: 'Halo',
      values: { nama: '<script>alert(1)</script>\nBaris 2' },
    });
    if (!result.ok) throw new Error('gagal');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br />Baris 2');
    expect(result.html).not.toContain('<script>');
    expect(result.sanitized).toBe(false);
  });

  it('href hanya https:// lengkap', () => {
    const html = '<a href="{{tautan}}">Bayar</a>';
    const ok = render({ html, values: { tautan: 'https://bayar.contoh.example/a?b=1&c=2' } });
    if (!ok.ok) throw new Error('gagal');
    expect(ok.html).toContain('href="https://bayar.contoh.example/a?b=1&amp;c=2"');
    for (const tautan of ['http://x.example', 'javascript:alert(1)', '', 'bukan url']) {
      const bad = render({ html, values: { tautan } });
      expect(bad.ok, tautan).toBe(false);
      if (!bad.ok) {
        expect(bad.errors).toEqual([
          {
            field: 'html',
            reason: 'template_variable_invalid',
            name: 'tautan',
            message: 'Nilai {{tautan}} harus alamat https:// yang lengkap.',
          },
        ]);
      }
    }
  });

  it('subjek: baris baru / kosong / > 200 ditolak', () => {
    for (const nama of ['Budi\nBcc: x@y.example', 'B'.repeat(200)]) {
      const result = render({ values: { nama } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.reason).toBe('subject_invalid');
    }
    expect(render({ subject: '{{kosong}}' }).ok).toBe(false);
  });

  it('slot QRIS, bawaan nama_organisasi, cid yang dirujuk, versi teks', () => {
    const result = render({
      html: '<p>{{nama_organisasi}}</p><div>{{qris}}</div><img src="cid:stempel" alt="Lunas">',
      qrisImageSrc: 'cid:qris',
      layout: 'brand',
    });
    if (!result.ok) throw new Error('gagal');
    expect(result.html).toContain('alt="Kode QRIS"');
    expect(result.html).toContain('<!doctype html>');
    expect(result.html).toContain('#0f766e');
    expect(result.referencedCids.sort()).toEqual(['logo', 'qris', 'stempel']);
    expect(result.text).toContain('Maju Jaya');
    expect(result.text).toContain(EMAIL_QRIS_SCAN_TEXT);
    expect(result.text).toContain('Kaki email');
    const empty = render({ html: '<div>{{qris}}</div>', qrisImageSrc: null });
    if (!empty.ok) throw new Error('gagal');
    expect(empty.referencedCids).toEqual([]);
  });

  it('teks template memakai nilai mentah; HTML luar yang disanitasi ditandai', () => {
    const result = render({
      html: '<p>Hai</p><script>x</script>',
      text: 'Halo {{nama}} & {{qris}}',
      values: { nama: '<b>Budi</b>' },
      substituteVariables: true,
    });
    if (!result.ok) throw new Error('gagal');
    expect(result.text).toBe('Halo <b>Budi</b> & ');
    expect(result.sanitized).toBe(true);
    const external = render({
      html: '<p>{{nama}}</p>',
      substituteVariables: false,
      subject: 'Bukti {{x}}',
    });
    if (!external.ok) throw new Error('gagal');
    expect(external.html).toContain('{{nama}}');
    expect(external.subject).toBe('Bukti {{x}}');
  });

  it('warna merek tidak sah memakai cadangan; teks merek di-escape', () => {
    const result = render({
      layout: 'brand',
      organizationName: '<b>Org</b>',
      brand: { primaryColor: 'red;x', logoSrc: null, footerText: '<i>kaki</i>' },
    });
    if (!result.ok) throw new Error('gagal');
    expect(result.html).toContain('#2563eb');
    expect(result.html).toContain('&lt;b&gt;Org&lt;/b&gt;');
    expect(result.html).toContain('&lt;i&gt;kaki&lt;/i&gt;');
  });
});

describe('htmlToText', () => {
  it('tautan jadi teks (url), blok jadi baris, entitas didekode', () => {
    const text = htmlToText(
      '<style>p{color:red}</style><h1>Judul</h1><p>Halo &amp; selamat&nbsp;pagi</p><p><a href="https://x.example/a">Bayar</a> atau <a href="https://x.example/b">https://x.example/b</a></p><ul><li>Satu</li><li>Dua</li></ul><img alt="Kode QRIS" src="cid:qris">',
    );
    expect(text).toBe(
      `Judul\n\nHalo & selamat pagi\n\nBayar (https://x.example/a) atau https://x.example/b\n\n- Satu\n- Dua\n\n${EMAIL_QRIS_SCAN_TEXT}`,
    );
  });
});

describe('preset template ISP', () => {
  const builtins = new Set<string>(EMAIL_TEMPLATE_BUILTIN_VARIABLES);

  it('ada 6 preset', () => {
    expect(EMAIL_TEMPLATE_PRESETS.map((preset) => preset.key)).toHaveLength(6);
  });

  for (const preset of EMAIL_TEMPLATE_PRESETS) {
    it(`${preset.key}: lolos sanitasi, variabel cocok, render sukses`, () => {
      const sanitized = sanitizeOutboundEmailHtml(preset.html);
      expect(sanitized).toMatchObject({ forbidden: false, changed: false, warnings: [] });
      expect(preset.subject.length).toBeLessThanOrEqual(200);
      const scan = scanTemplateVariables(preset);
      expect(scan.problems).toEqual([]);
      expect(scan.used.filter((name) => !builtins.has(name)).sort()).toEqual(
        preset.variables.map((variable) => variable.name).sort(),
      );
      for (const variable of preset.variables) {
        expect(variable.label.length).toBeLessThanOrEqual(60);
        expect(variable.example.length).toBeLessThanOrEqual(200);
      }
      expect(preset.html).not.toMatch(/href="\{\{/);
      const result = renderOutboundEmail({
        subject: preset.subject,
        html: preset.html,
        text: preset.text,
        values: Object.fromEntries(preset.variables.map((item) => [item.name, item.example])),
        organizationName: 'Maju Jaya',
        qrisImageSrc: 'cid:qris',
        layout: preset.layout,
        brand: { primaryColor: '#2563eb', logoSrc: null, footerText: preset.footerText },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sanitized).toBe(false);
        expect(result.text).toContain('Maju Jaya');
        expect(result.html).not.toContain('{{');
      }
    });
  }
});

describe('kinerja kasus terburuk 512 KB (review 9.1 S1)', () => {
  const SIZE = 512 * 1024;
  const fill = (unit: string) => unit.repeat(Math.floor(SIZE / unit.length));
  const cases: [string, string][] = [
    ['href {{ + spasi', `<a href="{{${' '.repeat(SIZE - 20)}x">b</a>`],
    ['teks {{ + spasi', `<p>{{${' '.repeat(SIZE - 10)}x</p>`],
    ['<style> tanpa ; { }', `<style>${fill('a')}</style><p>x</p>`],
    ['banyak <style> tanpa penutup', fill('<style>')],
    ['<style> penuh @import tanpa ;', `<style>${fill('@import ')}</style>`],
    ['<style> url( tanpa penutup', `<style>${fill('url ( ')}</style>`],
    ['komentar CSS tak tertutup', `<style>${fill('/*')}</style>`],
    ['banyak {{ tanpa }}', `<p>${fill('{{')}</p>`],
    ['banyak < tanpa >', fill('<a ')],
    ['banyak <!--', fill('<!--')],
    ['banyak <a href tanpa penutup', fill('<a href="https://x.example">')],
  ];
  for (const [label, html] of cases) {
    it(`${label}: sanitasi, pemindai, dan render masing-masing < 1 dtk`, () => {
      const timed = (run: () => unknown) => {
        const started = performance.now();
        run();
        return performance.now() - started;
      };
      const render = (substituteVariables: boolean) =>
        renderOutboundEmail({
          subject: 'Tagihan',
          html,
          text: null,
          values: {},
          organizationName: 'Organisasi',
          qrisImageSrc: null,
          layout: substituteVariables ? 'brand' : 'none',
          brand: { primaryColor: '#2563eb', logoSrc: null, footerText: null },
          substituteVariables,
        });
      expect(timed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(1_000);
      expect(
        timed(() => scanTemplateVariables({ subject: 'Tagihan', html, text: html })),
      ).toBeLessThan(1_000);
      expect(timed(() => render(true))).toBeLessThan(1_000);
      expect(timed(() => render(false))).toBeLessThan(1_000);
    }, 30_000);
  }

  it('CSS berbahaya tetap dibuang (url, image-set, @import, position: fixed)', () => {
    const { html } = sanitizeOutboundEmailHtml(
      '<style>a{color:red;background:url(https://x.example/a.png)}b{background-image:image-set("https://x.example/b.png" 1x)} @import "x.css"; c{position: fixed;top:0}</style><p>x</p>',
    );
    expect(html).toContain('color:red');
    expect(html).not.toMatch(/url\s*\(|image-set|@import|position:\s*fixed/i);
    expect(html).toContain('top:0');
  });
});
