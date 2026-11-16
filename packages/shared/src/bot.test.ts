import { describe, expect, it } from 'vitest';

import { botHoursSchema, channelBotSettingsSchema, isWithinBotHours } from './bot';
import { interactiveMessageSchema } from './interactive';

describe('jam kerja bot', () => {
  // Senin 16 Nov 2026, 08:30 WIB = 01:30 UTC.
  const mondayMorning = new Date('2026-11-16T01:30:00Z');
  const schedule = botHoursSchema.parse({
    mode: 'schedule',
    windows: [
      { day: 1, start: '08:00', end: '17:00' },
      { day: 2, start: '00:00', end: '24:00' },
    ],
  });

  it('24 jam selalu aktif; jadwal mengikuti zona waktu organisasi', () => {
    expect(isWithinBotHours({ mode: 'always' }, 'Asia/Jakarta', mondayMorning)).toBe(true);
    expect(isWithinBotHours(schedule, 'Asia/Jakarta', mondayMorning)).toBe(true);
    // Zona lain: 01:30 UTC = Minggu malam di New York → di luar jadwal.
    expect(isWithinBotHours(schedule, 'America/New_York', mondayMorning)).toBe(false);
    // 17:00 tepat = sudah selesai (batas atas eksklusif).
    expect(isWithinBotHours(schedule, 'Asia/Jakarta', new Date('2026-11-16T10:00:00Z'))).toBe(
      false,
    );
    // Zona tidak dikenal → Asia/Jakarta, tidak melempar.
    expect(isWithinBotHours(schedule, 'Bukan/Zona', mondayMorning)).toBe(true);
  });

  it('validasi: jam terbalik, format, batas waktu', () => {
    expect(
      botHoursSchema.safeParse({
        mode: 'schedule',
        windows: [{ day: 1, start: '17:00', end: '08:00' }],
      }).success,
    ).toBe(false);
    expect(
      botHoursSchema.safeParse({
        mode: 'schedule',
        windows: [{ day: 7, start: '08:00', end: '09:00' }],
      }).success,
    ).toBe(false);
    expect(
      botHoursSchema.safeParse({
        mode: 'schedule',
        windows: [{ day: 1, start: '8:00', end: '09:00' }],
      }).success,
    ).toBe(false);
    for (const timeoutMinutes of [0, 1441, 1.5]) {
      expect(
        channelBotSettingsSchema.safeParse({
          enabled: true,
          hours: { mode: 'always' },
          timeoutMinutes,
        }).success,
      ).toBe(false);
    }
  });
});

describe('pesan interaktif (batas Meta)', () => {
  it('tombol 1–3, judul ≤ 20, unik; daftar ≤ 10 baris, judul bagian wajib bila > 1 bagian', () => {
    const button = (titles: string[]) => ({
      kind: 'button',
      body: 'Pilih',
      buttons: titles.map((title, index) => ({ id: `b${String(index)}`, title })),
    });
    expect(interactiveMessageSchema.safeParse(button(['Ya', 'Tidak'])).success).toBe(true);
    expect(interactiveMessageSchema.safeParse(button(['A', 'B', 'C', 'D'])).success).toBe(false);
    expect(interactiveMessageSchema.safeParse(button(['x'.repeat(21)])).success).toBe(false);
    expect(interactiveMessageSchema.safeParse(button(['Ya', 'ya'])).success).toBe(false);
    const list = (sections: { title?: string; rows: number }[]) => ({
      kind: 'list',
      body: 'Pilih',
      buttonText: 'Lihat',
      sections: sections.map((section, s) => ({
        ...(section.title ? { title: section.title } : {}),
        rows: Array.from({ length: section.rows }, (_, r) => ({
          id: `${String(s)}-${String(r)}`,
          title: 'P',
        })),
      })),
    });
    expect(interactiveMessageSchema.safeParse(list([{ rows: 10 }])).success).toBe(true);
    expect(interactiveMessageSchema.safeParse(list([{ rows: 11 }])).success).toBe(false);
    expect(interactiveMessageSchema.safeParse(list([{ rows: 2 }, { rows: 2 }])).success).toBe(
      false,
    );
    expect(
      interactiveMessageSchema.safeParse(
        list([
          { title: 'A', rows: 6 },
          { title: 'B', rows: 4 },
        ]),
      ).success,
    ).toBe(true);
  });
});
