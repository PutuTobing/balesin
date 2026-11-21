import { useCallback, useState } from 'react';
import { useCountdown, type Deadline } from './use-countdown';

export interface Lock {
  /** Masih terkunci (sisa waktu > 0). */
  locked: boolean;
  /** Pernah dikunci dan waktunya sudah lewat (untuk pengumuman "sudah bisa dicoba lagi"). */
  unlocked: boolean;
  secondsLeft: number;
  /** Kunci selama sekian detik (dari `Retry-After`). Dipanggil di event handler. */
  lockFor: (seconds: number) => void;
  clear: () => void;
}

/**
 * Kunci sementara setelah 429 (pola yang sudah lolos kritikus di halaman masuk): tombol kirim
 * nonaktif dengan sisa waktu `m:ss` di labelnya, lalu aktif lagi sendiri.
 */
export function useLock(): Lock {
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const secondsLeft = useCountdown(deadline);
  const lockFor = useCallback((seconds: number) => {
    const startedAt = Date.now();
    setDeadline({ until: startedAt + seconds * 1000, startedAt });
  }, []);
  const clear = useCallback(() => setDeadline(null), []);
  return {
    locked: deadline !== null && secondsLeft > 0,
    unlocked: deadline !== null && secondsLeft === 0,
    secondsLeft,
    lockFor,
    clear,
  };
}
