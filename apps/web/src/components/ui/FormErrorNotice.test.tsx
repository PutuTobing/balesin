import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { ApiError } from '../../lib/api/client';
import type { Lock } from '../../lib/use-lock';
import { FormErrorNotice } from './FormErrorNotice';

const lock = (state: Partial<Lock>): Lock => ({
  locked: false,
  unlocked: false,
  secondsLeft: 0,
  lockFor: vi.fn(),
  clear: vi.fn(),
  ...state,
});

const limited = new ApiError({
  status: 429,
  code: 'RATE_LIMITED',
  message: 'Terlalu banyak percobaan konfirmasi yang salah.',
  retryAfterSeconds: 900,
});

describe('FormErrorNotice: satu pola pesan di bawah tombol', () => {
  it('terkunci: kotak kuning berjudul dengan pesan server', () => {
    render(<FormErrorNotice error={limited} lock={lock({ locked: true })} lockedTitle="Dikunci" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Dikunci');
    expect(alert).toHaveTextContent(limited.message);
    expect(alert.className).toMatch(/warning/);
  });

  it('hitung mundur habis: pesan basi diganti "Sudah bisa dicoba lagi." (info, bukan merah)', () => {
    render(
      <FormErrorNotice error={limited} lock={lock({ unlocked: true })} lockedTitle="Dikunci" />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(t.api.unlocked);
    expect(status).not.toHaveTextContent(limited.message);
    expect(status.className).toMatch(/info/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gagal lain: kotak merah tanpa judul; tanpa error tidak ada apa-apa', () => {
    const failed = new ApiError({
      status: 500,
      code: 'INTERNAL',
      message: 'Ada kendala di server.',
    });
    const { rerender } = render(
      <FormErrorNotice error={failed} lock={lock({ unlocked: true })} lockedTitle="Dikunci" />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Ada kendala di server.');
    expect(alert).not.toHaveTextContent('Dikunci');
    expect(alert.className).toMatch(/danger/);
    rerender(<FormErrorNotice error={null} lock={lock({})} lockedTitle="Dikunci" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
