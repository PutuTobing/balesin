import { describe, expect, it } from 'vitest';

import {
  autoMessageName,
  invalidAutoMessageVariables,
  isWithinTeamHours,
  renderAutoMessage,
  updateWorkspaceSettingsRequestSchema,
} from './workspace';

describe('pesan otomatis', () => {
  it('{nama} tanpa tautan (nama profil pelanggan = teks bebas); kosong → cadangan', () => {
    expect(autoMessageName('Budi https://jahat.test/x', 'Kak')).toBe('Budi');
    expect(autoMessageName('promo www.contoh.com', 'Kak')).toBe('promo');
    expect(autoMessageName('klik bayar.id sekarang', 'Kak')).toBe('klik sekarang');
    expect(autoMessageName('Siti.Indah', 'Kak')).toBe('Siti.Indah');
    expect(autoMessageName('https://hanya-tautan.test', 'Kak')).toBe('Kak');
    expect(autoMessageName(null, 'Kak')).toBe('Kak');
    expect(Array.from(autoMessageName('A'.repeat(100), 'Kak'))).toHaveLength(60);
  });

  it('variabel per jenis; pengganti tidak diperluas ulang', () => {
    expect(invalidAutoMessageVariables('greeting', 'Halo {nama} dari {agen}')).toEqual(['agen']);
    expect(invalidAutoMessageVariables('assigned', 'Halo {nama} dari {agen}')).toEqual([]);
    expect(renderAutoMessage('Halo {nama}', { nama: '{agen}', agen: 'X' })).toBe('Halo {agen}');
  });

  it('permintaan: konfirmasi saja tidak dihitung sebagai perubahan', () => {
    expect(
      updateWorkspaceSettingsRequestSchema.safeParse({ confirmation: { password: 'x' } }).success,
    ).toBe(false);
  });
});

describe('jam kerja tim', () => {
  // Selasa 17 Nov 2026 10:00 WIB.
  const at = new Date('2026-11-17T03:00:00Z');
  const hours = { mode: 'schedule' as const, windows: [{ day: 2, start: '08:00', end: '17:00' }] };

  it('jadwal di zona organisasi; hari libur = di luar jam kerja', () => {
    expect(isWithinTeamHours(hours, [], 'Asia/Jakarta', at)).toBe(true);
    expect(isWithinTeamHours(hours, [], 'Asia/Jayapura', new Date('2026-11-17T09:00:00Z'))).toBe(
      false,
    );
    expect(
      isWithinTeamHours(
        { mode: 'always' },
        [{ date: '2026-11-17', name: 'Libur' }],
        'Asia/Jakarta',
        at,
      ),
    ).toBe(false);
  });
});
