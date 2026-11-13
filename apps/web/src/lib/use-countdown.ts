import { useEffect, useState } from 'react';

export interface Deadline {
  /** Batas waktu (milidetik epoch). */
  until: number;
  /** Waktu saat batas ditetapkan (diambil di event handler, bukan saat render). */
  startedAt: number;
}

/**
 * Sisa detik sampai `deadline.until`, diperbarui tiap detik. `null` = tidak ada hitung mundur.
 * Mengembalikan 0 setelah waktunya lewat.
 */
export function useCountdown(deadline: Deadline | null): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTick(now);
      if (now >= deadline.until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  if (deadline === null) return 0;
  // Waktu terus maju: detak terakhir yang lebih tua dari batas baru diabaikan.
  const now = Math.max(deadline.startedAt, tick);
  return Math.max(0, Math.ceil((deadline.until - now) / 1000));
}
