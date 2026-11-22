import { emailAttachmentHostAllowed, maskEmailAddress } from '@balesin/shared';
import { describe, expect, it } from 'vitest';

import { normalizeAttachmentHost } from './attachment-hosts';
import {
  normalizeRecipientAddress,
  normalizeRecipients,
  parseSchedule,
  requestHashOf,
  templateValues,
  validateMetadata,
} from './email-content';
import { fromAliasesOf } from './senders';

const reasonOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { details?: { reason?: string; field?: string }[] }).details?.[0];
  }
  return undefined;
};

describe('alamat penerima (§3.6)', () => {
  it('huruf kecil, IDN → punycode, tolak yang cacat', () => {
    expect(normalizeRecipientAddress(' Budi.Santoso@Contoh.Example ')).toBe(
      'budi.santoso@contoh.example',
    );
    expect(normalizeRecipientAddress('sari@bücher.example')).toBe('sari@xn--bcher-kva.example');
    for (const bad of [
      'tanpa-at',
      '@contoh.example',
      'a@b',
      'a..b@contoh.example',
      '.a@contoh.example',
      'a b@contoh.example',
      'ä@contoh.example',
      `${'a'.repeat(65)}@contoh.example`,
      'a@-contoh.example',
      'a@contoh.123',
    ]) {
      expect(normalizeRecipientAddress(bad), bad).toBeNull();
    }
  });

  it('digabung tanpa beda huruf (Kepada > Cc > Bcc), field galat menunjuk posisi, total ≤ 50', () => {
    const result = normalizeRecipients({
      to: [{ email: 'A@contoh.example', name: 'A' }],
      cc: [{ email: 'a@contoh.example' }, { email: 'b@contoh.example' }],
      bcc: [{ email: 'B@contoh.example' }, { email: 'c@contoh.example' }],
    });
    expect(result.to.map((item) => item.email)).toEqual(['a@contoh.example']);
    expect(result.cc.map((item) => item.email)).toEqual(['b@contoh.example']);
    expect(result.bcc.map((item) => item.email)).toEqual(['c@contoh.example']);
    expect(
      reasonOf(() =>
        normalizeRecipients({
          to: [{ email: 'a@contoh.example' }],
          cc: [{ email: 'b@contoh.example' }, { email: 'b@contoh.example' }, { email: 'rusak' }],
        }),
      ),
    ).toMatchObject({ field: 'cc.2.email', reason: 'recipient_invalid' });
    expect(
      reasonOf(() =>
        normalizeRecipients({
          to: Array.from({ length: 51 }, (_, index) => ({
            email: `o${String(index)}@contoh.example`,
          })),
        }),
      )?.reason,
    ).toBe('too_many_recipients');
    expect(
      reasonOf(() =>
        normalizeRecipients({ to: [{ email: 'a@contoh.example', name: 'x <y@z.id>' }] }),
      )?.reason,
    ).toBe('recipient_invalid');
  });

  it('alias "Dari" hanya se-domain + SMTP custom', () => {
    expect(
      fromAliasesOf(
        'billing@perusahaan.example',
        ['Tagihan@perusahaan.example', 'promo@lain.example', 'billing@perusahaan.example'],
        'custom',
      ),
    ).toEqual(['tagihan@perusahaan.example']);
    expect(
      fromAliasesOf('billing@perusahaan.example', ['tagihan@perusahaan.example'], 'system'),
    ).toEqual([]);
  });
});

describe('metadata, jadwal, variabel, idempotensi', () => {
  it('metadata ≤ 20 kunci, nilai skalar pendek, ≤ 2 KB', () => {
    expect(
      validateMetadata({ invoice_id: 'INV-1', jumlah: 3, lunas: false, catatan: null }),
    ).toEqual({
      invoice_id: 'INV-1',
      jumlah: 3,
      lunas: false,
      catatan: null,
    });
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, i]));
    for (const bad of [
      tooMany,
      { 'kunci spasi': 1 },
      { k: 'x'.repeat(201) },
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i)}`, 'x'.repeat(150)])),
    ]) {
      expect(reasonOf(() => validateMetadata(bad))?.reason).toBe('metadata_invalid');
    }
  });

  it('scheduledAt: lampau = segera (null), > 30 hari / bukan ISO → 400', () => {
    const now = new Date('2026-11-22T00:00:00Z');
    expect(parseSchedule('2026-11-21T00:00:00Z', now)).toBeNull();
    expect(parseSchedule('2026-11-23T00:00:00+07:00', now)?.toISOString()).toBe(
      '2026-11-22T17:00:00.000Z',
    );
    expect(reasonOf(() => parseSchedule('besok', now))?.reason).toBe('scheduled_at_invalid');
    expect(reasonOf(() => parseSchedule('2027-01-01T00:00:00Z', now))?.reason).toBe(
      'scheduled_at_invalid',
    );
  });

  it('variabel: wajib hilang per variabel, angka/boolean → teks, kendali ditolak, kunci asing diabaikan', () => {
    const declared = [
      { name: 'nama', label: 'Nama', required: true, example: 'Budi' },
      { name: 'total', label: 'Total', required: true, example: 'Rp1' },
      { name: 'kode_va', label: 'VA', required: false, example: '' },
    ];
    expect(templateValues(declared, { nama: 'Budi', total: 185000, asing: 'x' })).toEqual({
      nama: 'Budi',
      total: '185000',
      kode_va: '',
    });
    try {
      templateValues(declared, { kode_va: '1' });
      expect.unreachable();
    } catch (error) {
      expect((error as { details: { reason: string }[] }).details.map((d) => d.reason)).toEqual([
        'template_variable_missing',
        'template_variable_missing',
      ]);
    }
    expect(reasonOf(() => templateValues(declared, { nama: 'A B', total: '1' }))?.reason).toBe(
      'template_variable_invalid',
    );
    expect(templateValues(declared, { nama: 'Baris\r\nbaru', total: '1' }).nama).toBe(
      'Baris\nbaru',
    );
  });

  it('hash permintaan tidak bergantung urutan kunci, tetapi berubah bila isi berubah', () => {
    expect(requestHashOf({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      requestHashOf({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(requestHashOf({ a: 1 })).not.toBe(requestHashOf({ a: 2 }));
  });
});

describe('allowlist host lampiran (§2)', () => {
  it('normalisasi: huruf kecil, IDN, wildcard satu tingkat, IP; tolak TLD saja', () => {
    expect(normalizeAttachmentHost('Billing.Perusahaan.Example.')).toBe(
      'billing.perusahaan.example',
    );
    expect(normalizeAttachmentHost('*.bücher.example')).toBe('*.xn--bcher-kva.example');
    expect(normalizeAttachmentHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeAttachmentHost('*.example')).toBeNull();
    expect(normalizeAttachmentHost('a.*.example')).toBeNull();
    expect(normalizeAttachmentHost('host_salah.example')).toBeNull();
  });

  it('wildcard = semua subdomain, BUKAN domain induknya', () => {
    const allow = ['*.perusahaan.example', 'files.lain.example', '10.0.0.5'];
    expect(emailAttachmentHostAllowed('billing.perusahaan.example', allow)).toBe(true);
    expect(emailAttachmentHostAllowed('a.b.perusahaan.example', allow)).toBe(true);
    expect(emailAttachmentHostAllowed('perusahaan.example', allow)).toBe(false);
    expect(emailAttachmentHostAllowed('evilperusahaan.example', allow)).toBe(false);
    expect(emailAttachmentHostAllowed('FILES.lain.example', allow)).toBe(true);
    expect(emailAttachmentHostAllowed('x.files.lain.example', allow)).toBe(false);
    expect(emailAttachmentHostAllowed('10.0.0.5', allow)).toBe(true);
    expect(emailAttachmentHostAllowed('anything.example', [])).toBe(false);
  });

  it('penerima tersamar untuk riwayat', () => {
    expect(maskEmailAddress('budi.santoso@contoh.example')).toBe('bu***@co***.example');
    expect(maskEmailAddress('a@b.co.id')).toBe('a***@b***.co.id');
  });
});
