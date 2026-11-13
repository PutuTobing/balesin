import { describe, expect, it } from 'vitest';
import { formatClock } from './format';

describe('formatClock (sisa waktu hitung mundur)', () => {
  it.each([
    [900, '15:00'],
    [899, '14:59'],
    [65, '1:05'],
    [60, '1:00'],
    [45, '0:45'],
    [9, '0:09'],
    [0, '0:00'],
  ])('%i detik → %s', (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected);
  });

  it('memakai titik dua, bukan titik (15.00 terbaca sebagai jam)', () => {
    expect(formatClock(900)).not.toContain('.');
  });

  it('pecahan detik dibulatkan ke atas, nilai negatif jadi 0:00', () => {
    expect(formatClock(899.2)).toBe('15:00');
    expect(formatClock(0.4)).toBe('0:01');
    expect(formatClock(-3)).toBe('0:00');
  });
});
