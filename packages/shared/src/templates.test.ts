import { describe, expect, it } from 'vitest';

import { TEMPLATE_PRESETS } from './template-presets';
import {
  fromMetaComponents,
  templateContentSchema,
  toMetaComponents,
  validateTemplate,
  type TemplateContentInput,
} from './templates';

const content = (
  input: Partial<TemplateContentInput> & { text: string; examples?: Record<string, string> },
) =>
  templateContentSchema.parse({
    ...input,
    body: { text: input.text, examples: input.examples ?? {} },
  });

describe('validasi template (aturan Meta)', () => {
  it('semua preset industri lolos validasi lokal dan tanpa nama perusahaan', () => {
    for (const preset of TEMPLATE_PRESETS) {
      expect(
        validateTemplate(preset.category, templateContentSchema.parse(preset.content)),
        preset.key,
      ).toEqual([]);
      expect(JSON.stringify(preset).toLowerCase()).not.toMatch(
        /sky ?tech|skybill|mobichat|lampung/,
      );
    }
  });

  it('variabel bernomor berurutan, contoh wajib, tidak di awal/akhir, tidak berdampingan', () => {
    const fields = (text: string, examples: Record<string, string> = {}) =>
      validateTemplate('UTILITY', content({ text, examples })).map((issue) => issue.field);
    expect(fields('Halo {{1}}, tagihan {{2}} ya.', { '1': 'Budi', '2': 'Rp1' })).toEqual([]);
    expect(fields('Halo {{1}}, tagihan {{3}} ya.', { '1': 'a', '3': 'b' })).toContain('body.text');
    expect(fields('Halo {{1}} ya.')).toContain('body.examples.1');
    expect(fields('{{1}} halo', { '1': 'a' })).toContain('body.text');
    expect(fields('Halo {{1}}{{2}} ya', { '1': 'a', '2': 'b' })).toContain('body.text');
    expect(fields('Halo {{nama}} ya', { nama: 'a' })).toContain('body.text');
    expect(
      validateTemplate(
        'UTILITY',
        content({ text: 'Halo {{nama}} ya', examples: { nama: 'Budi' }, parameterFormat: 'named' }),
      ),
    ).toEqual([]);
  });

  it('tombol: URL maks. 2, satu variabel di akhir + contoh, balasan cepat berkelompok', () => {
    const withButtons = (buttons: TemplateContentInput['buttons']) =>
      validateTemplate('MARKETING', content({ text: 'Halo kak, ada promo.', buttons })).map(
        (issue) => issue.message,
      );
    expect(
      withButtons([
        {
          type: 'URL',
          text: 'Buka',
          url: 'https://contoh.id/{{1}}',
          example: 'https://contoh.id/a',
        },
      ]),
    ).toEqual([]);
    expect(
      withButtons([{ type: 'URL', text: 'Buka', url: 'https://contoh.id/{{1}}' }]).join(),
    ).toContain('Contoh URL');
    expect(
      withButtons([
        { type: 'URL', text: 'Buka', url: 'https://contoh.id/{{1}}/x', example: 'x' },
      ]).join(),
    ).toContain('paling akhir');
    expect(
      withButtons([
        { type: 'QUICK_REPLY', text: 'Ya' },
        { type: 'URL', text: 'Buka', url: 'https://contoh.id' },
        { type: 'QUICK_REPLY', text: 'Tidak' },
      ]).join(),
    ).toContain('berkelompok');
  });

  it('komponen Meta bolak-balik tetap sama (bernomor & bernama, autentikasi)', () => {
    for (const preset of TEMPLATE_PRESETS) {
      const parsed = templateContentSchema.parse(preset.content);
      const back = fromMetaComponents(toMetaComponents(preset.category, parsed), 'POSITIONAL');
      if (preset.category === 'AUTHENTICATION') {
        expect(back.authentication).toEqual(parsed.authentication);
      } else {
        expect(back).toEqual(parsed);
      }
    }
    const named = content({
      text: 'Halo {{nama}}, kode {{kode}} ya.',
      examples: { nama: 'Budi', kode: 'X1' },
      parameterFormat: 'named',
    });
    expect(fromMetaComponents(toMetaComponents('UTILITY', named), 'NAMED')).toEqual(named);
    expect(fromMetaComponents('rusak')).toMatchObject({ body: { text: '' } });
  });
});
