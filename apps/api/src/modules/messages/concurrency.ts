/**
 * Batas pekerjaan media yang BERJALAN bersamaan (review ruang chat S1): per proses api dan per
 * pengguna. Melewati batas = ditolak segera (pemanggil menjawab 429 "coba lagi"), bukan diantre —
 * antrean di memori juga memakan memori.
 */
export interface ConcurrencyGate {
  /** Fungsi pelepas, atau `null` bila batas sudah penuh. */
  tryAcquire(userId: string): (() => void) | null;
  readonly running: number;
}

export function createConcurrencyGate(limits: {
  global: number;
  perUser: number;
}): ConcurrencyGate {
  let running = 0;
  const byUser = new Map<string, number>();
  return {
    get running() {
      return running;
    },
    tryAcquire(userId) {
      const mine = byUser.get(userId) ?? 0;
      if (running >= limits.global || mine >= limits.perUser) return null;
      running += 1;
      byUser.set(userId, mine + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running -= 1;
        const left = (byUser.get(userId) ?? 1) - 1;
        if (left <= 0) byUser.delete(userId);
        else byUser.set(userId, left);
      };
    },
  };
}
