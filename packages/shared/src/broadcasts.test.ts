import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BROADCAST_RATES,
  alarmText,
  broadcastRateFor,
  broadcastRequiredVariables,
  normalizeBroadcastPhone,
  renderBroadcastParameters,
  updateBroadcastSettingsRequestSchema,
  DEFAULT_BROADCAST_SETTINGS,
} from './broadcasts';
import { templateContentSchema } from './templates';

describe('normalizeBroadcastPhone', () => {
  it.each([
    ['081234567890', '+6281234567890'],
    ['0812-3456-7890', '+6281234567890'],
    ['(0812) 3456 7890', '+6281234567890'],
    ['6281234567890', '+6281234567890'],
    ['+62 812 3456 7890', '+6281234567890'],
    ['81234567890', '+6281234567890'],
    ['0062812345678', '+62812345678'],
    ['+6591234567', '+6591234567'],
  ])('%s → %s', (raw, phone) => {
    expect(normalizeBroadcastPhone(raw)).toEqual({ ok: true, phone });
  });

  it.each([
    ['', 'phone_missing'],
    ['   ', 'phone_missing'],
    ['6,28123E+12', 'phone_scientific'],
    ['6.28E12', 'phone_scientific'],
    ['12345', 'phone_invalid'],
    ['abc', 'phone_invalid'],
    ['0812abc', 'phone_invalid'],
    ['620812345678', 'phone_invalid'],
    ['6591234567', 'phone_invalid'],
    ['+62123', 'phone_invalid'],
  ])('%s ditolak (%s)', (raw, issue) => {
    expect(normalizeBroadcastPhone(raw)).toEqual({ ok: false, issue });
  });
});

const content = templateContentSchema.parse({
  header: { format: 'TEXT', text: 'Tagihan {{1}}', example: 'November' },
  body: {
    text: 'Halo {{1}}, tagihan {{2}} jatuh tempo.',
    examples: { '1': 'Budi', '2': 'Rp150.000' },
  },
  buttons: [
    { type: 'QUICK_REPLY', text: 'Sudah bayar' },
    {
      type: 'URL',
      text: 'Bayar',
      url: 'https://bayar.contoh.id/{{1}}',
      example: 'https://bayar.contoh.id/A1',
    },
  ],
});

describe('pemetaan variabel', () => {
  it('daftar variabel wajib: body, judul teks, tombol URL ber-variabel', () => {
    expect(broadcastRequiredVariables(content)).toEqual({
      body: ['1', '2'],
      header: true,
      buttons: ['1'],
    });
  });

  it('kolom & teks tetap diisi; kosong/aturan Meta dilaporkan', () => {
    const mapping = {
      body: {
        '1': { kind: 'column' as const, column: 'nama' },
        '2': { kind: 'column' as const, column: 'tagihan' },
      },
      header: { kind: 'text' as const, value: 'November' },
      buttons: { '1': { kind: 'column' as const, column: 'id' } },
    };
    const ok = renderBroadcastParameters(content, mapping, {
      nama: 'Sari',
      tagihan: 'Rp200.000',
      id: 'X9',
    });
    expect(ok).toMatchObject({
      parameters: {
        body: { '1': 'Sari', '2': 'Rp200.000' },
        header: { text: 'November' },
        buttons: { '1': 'X9' },
      },
      preview: 'Halo Sari, tagihan Rp200.000 jatuh tempo.',
      missing: [],
      invalid: [],
    });
    const bad = renderBroadcastParameters(content, mapping, {
      nama: 'Sari      Wulan',
      tagihan: '',
    });
    expect(bad.missing).toEqual(['body.2', 'buttons.1']);
    expect(bad.invalid).toEqual(['body.1']);
    const unmapped = renderBroadcastParameters(
      content,
      { body: {}, header: null, buttons: {} },
      {},
    );
    expect(unmapped.missing).toEqual(['body.1', 'body.2', 'buttons.1', 'header']);
  });
});

describe('tarif & alarm', () => {
  it('tarif per kategori dari kode panggil terpanjang; negara tanpa tarif = null', () => {
    expect(broadcastRateFor(DEFAULT_BROADCAST_RATES, '+6281234567890', 'MARKETING')).toBe(593);
    expect(broadcastRateFor(DEFAULT_BROADCAST_RATES, '+6281234567890', 'UTILITY')).toBe(363);
    expect(broadcastRateFor(DEFAULT_BROADCAST_RATES, '+6591234567', 'UTILITY')).toBeNull();
    const rates = {
      ...DEFAULT_BROADCAST_RATES,
      rates: [
        ...DEFAULT_BROADCAST_RATES.rates,
        { country: 'XX', callingCode: '628', marketing: 1, utility: 2, authentication: 3 },
      ],
    };
    expect(broadcastRateFor(rates, '+6281234567890', 'UTILITY')).toBe(2);
  });

  it('teks alarm tanpa data pelanggan, alasan dalam bahasa Indonesia', () => {
    const text = alarmText('Balesin Tes', 'broadcast_auto_paused', {
      campaign: 'Tagihan November',
      reason: 'failure_spike',
      sent: 40,
      failed: 25,
    });
    expect(text).toContain('[Balesin Tes] Broadcast dijeda otomatis');
    expect(text).toContain('Kampanye: Tagihan November');
    expect(text).toContain('terlalu banyak pesan gagal');
    expect(text).toContain('Gagal: 25');
  });

  it('pengaturan bawaan lolos skema', () => {
    expect(updateBroadcastSettingsRequestSchema.safeParse(DEFAULT_BROADCAST_SETTINGS).success).toBe(
      true,
    );
  });
});
