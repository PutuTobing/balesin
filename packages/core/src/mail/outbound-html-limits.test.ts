/**
 * Review 9.1 putaran 3: S4 (batas kemunculan `{{…}}` + ukuran hasil render), R10 (indeks huruf kecil
 * khusus ASCII), dan Info lampiran email masuk Office lama (CFB).
 */
import { describe, expect, it } from 'vitest';

import { classifyEmailAttachment } from '../channels/email-message';
import {
  EMAIL_HTML_MAX_BYTES,
  EMAIL_TEMPLATE_PLACEHOLDERS_MAX,
  renderOutboundEmail,
  sanitizeOutboundEmailHtml,
  templatePlaceholderOverflow,
  type RenderOutboundEmailInput,
} from './outbound-html';

const base: RenderOutboundEmailInput = {
  subject: 'Tagihan',
  html: '<p>Halo</p>',
  text: null,
  values: {},
  organizationName: 'Organisasi',
  qrisImageSrc: null,
  layout: 'brand',
  brand: { primaryColor: '#112233', logoSrc: null, footerText: null },
};

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

const reasons = (result: ReturnType<typeof renderOutboundEmail>) =>
  result.ok ? [] : result.errors.map((error) => `${error.field}:${error.reason}`);

describe('S4 — batas kemunculan {{…}}', () => {
  it('200 kemunculan lolos; 201 ditolak (subjek + HTML + teks digabung)', () => {
    const html200 = `<p>${'{{a}}'.repeat(EMAIL_TEMPLATE_PLACEHOLDERS_MAX)}</p>`;
    expect(templatePlaceholderOverflow({ subject: 'x', html: html200, text: null })).toBeNull();
    expect(templatePlaceholderOverflow({ subject: 'Halo {{a}}', html: html200, text: null })).toBe(
      'html',
    );
    expect(
      templatePlaceholderOverflow({
        subject: '{{a}}',
        html: '<p>{{a}}</p>'.repeat(EMAIL_TEMPLATE_PLACEHOLDERS_MAX - 1),
        text: '{{a}}',
      }),
    ).toBe('text');
    // Nama tidak sah ikut dihitung (konservatif).
    expect(
      templatePlaceholderOverflow({ subject: '', html: '{{ A-B }}'.repeat(201), text: null }),
    ).toBe('html');
  });

  it('render template > 200 kemunculan → template_placeholders_too_many, cepat', () => {
    const { value, ms } = timed(() =>
      renderOutboundEmail({
        ...base,
        html: `<p>${'{{a}}'.repeat(50_000)}</p>`,
        values: { a: '&'.repeat(1_000) },
      }),
    );
    expect(ms).toBeLessThan(500);
    expect(reasons(value)).toEqual(['html:template_placeholders_too_many']);
  });

  it('isi luar (bukan template) tidak dibatasi jumlah {{…}} — tidak pernah diisi', () => {
    const result = renderOutboundEmail({
      ...base,
      html: `<p>${'{{a}}'.repeat(5_000)}</p>`,
      substituteVariables: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe('S4 — ukuran hasil render dibatasi bertahap', () => {
  it('200 × nilai 1.000 "&" (≈ 1 MB setelah escape) → html content_too_large < 300 ms', () => {
    const { value, ms } = timed(() =>
      renderOutboundEmail({
        ...base,
        html: `<p>${'{{a}}'.repeat(EMAIL_TEMPLATE_PLACEHOLDERS_MAX)}</p>`,
        values: { a: '&'.repeat(1_000) },
      }),
    );
    expect(ms).toBeLessThan(300);
    expect(reasons(value)).toEqual(['html:content_too_large']);
  });

  it('satu nilai 10 MB → content_too_large (HTML maupun teks)', () => {
    const huge = 'x'.repeat(10 * 1024 * 1024);
    expect(
      reasons(renderOutboundEmail({ ...base, html: '<p>{{a}}</p>', values: { a: huge } })),
    ).toEqual(['html:content_too_large']);
    expect(
      reasons(
        renderOutboundEmail({ ...base, html: null, text: 'Halo {{a}}', values: { a: huge } }),
      ),
    ).toEqual(['text:content_too_large']);
  });

  it('versi teks: 200 × 2.000 karakter (≈ 400 KB) → text content_too_large', () => {
    const result = renderOutboundEmail({
      ...base,
      html: null,
      text: '{{a}}\n'.repeat(EMAIL_TEMPLATE_PLACEHOLDERS_MAX),
      values: { a: 'b'.repeat(2_000) },
    });
    expect(reasons(result)).toEqual(['text:content_too_large']);
  });

  it('subjek berisi nilai raksasa → subject_invalid (tanpa membangun string besar)', () => {
    const result = renderOutboundEmail({
      ...base,
      subject: 'Tagihan {{a}}',
      values: { a: 'x'.repeat(5 * 1024 * 1024) },
    });
    expect(reasons(result)).toEqual(['subject:subject_invalid']);
  });

  it('di dalam batas tetap dirender: 200 × nilai 1.000 huruf (≈ 200 KB)', () => {
    const result = renderOutboundEmail({
      ...base,
      html: `<p>${'{{a}} '.repeat(EMAIL_TEMPLATE_PLACEHOLDERS_MAX)}</p>`,
      values: { a: 'b'.repeat(1_000) },
    });
    expect(result.ok).toBe(true);
  });

  it('HTML template tanpa variabel yang setelah sanitasi sedikit > 512 KB tetap lolos (tidak ada regresi)', () => {
    // `&` → `&amp;` oleh sanitasi: hasil sanitasi > 512 KB, tetapi tidak ada isian yang membesarkannya.
    const html = `<p>${'a&'.repeat(Math.floor(EMAIL_HTML_MAX_BYTES / 2) - 10)}</p>`;
    expect(Buffer.byteLength(sanitizeOutboundEmailHtml(html).html)).toBeGreaterThan(
      EMAIL_HTML_MAX_BYTES,
    );
    expect(renderOutboundEmail({ ...base, html }).ok).toBe(true);
  });
});

describe('R10 — indeks huruf kecil khusus ASCII (karakter yang memanjang saat toLowerCase)', () => {
  const dotted = 'İ'.repeat(40);

  it('blok <style> dan isi badan tidak bergeser oleh "İ" sebelum/di dalam <style>', () => {
    const html = `<p>${dotted}</p><STYLE>.k{color:red}</STYLE><style>.${dotted}{color:blue}</style><p>Halo {{nama}}</p><a href="{{tautan}}">bayar</a>`;
    const sanitized = sanitizeOutboundEmailHtml(html).html;
    expect(sanitized).toBe(
      `<style>.k{color:red}</style><style>.${dotted}{color:blue}</style><p>${dotted}</p><p>Halo {{nama}}</p><a href="{{tautan}}" target="_blank" rel="noopener noreferrer">bayar</a>`,
    );
    const rendered = renderOutboundEmail({
      ...base,
      html,
      values: { nama: 'Budi', tautan: 'https://bayar.contoh.example/1' },
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.html).toContain('<p>Halo Budi</p>');
    expect(rendered.html).toContain('href="https://bayar.contoh.example/1"');
    expect(rendered.html).toContain(`<p>${dotted}</p>`);
  });
});

describe('Info putaran 3 — lampiran email MASUK Office lama (CFB) dilewati', () => {
  const cfb = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(1_024),
  ]);

  it.each(['surat.doc', 'data.xls', 'slide.ppt', 'pesan.msg', 'berkas.bin', 'tanpa-ekstensi'])(
    '%s berisi CFB → null (dilewati)',
    (name) => {
      expect(classifyEmailAttachment(cfb, name)).toBeNull();
    },
  );
});
