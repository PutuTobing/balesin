/**
 * Gerbang laporan yang BERJALAN bersamaan (review Fase 5 Info 5; audit akhir QA S1). Tiap query laporan
 * bisa memegang satu koneksi pool hingga `statement_timeout` 8 dtk, jadi jumlah yang berjalan dibatasi
 * per proses (melindungi pool), per organisasi, dan per pengguna. Bedanya dengan gerbang lama
 * (2/organisasi, langsung 429): permintaan yang belum dapat slot MENUNGGU sebentar (antrean FIFO,
 * dibatasi panjangnya) — beberapa supervisor membuka Laporan bersamaan, atau beberapa kartu per halaman,
 * tidak pernah melihat 429. Ditolak hanya bila antrean penuh atau waktu tunggu habis.
 */
export interface ReportGateLimits {
  /** Laporan berjalan per proses api (koneksi pool). */
  global: number;
  perOrganization: number;
  perUser: number;
  /** Panjang antrean tunggu per proses (memori). Penuh → ditolak segera. */
  maxWaiting: number;
  /** Lama menunggu slot sebelum ditolak. */
  waitMs: number;
}

export interface ReportGate {
  /** Pelepas slot, atau `null` bila antrean penuh / waktu tunggu habis. */
  acquire(organizationId: string, userId: string): Promise<(() => void) | null>;
  readonly running: number;
  readonly waiting: number;
}

interface Waiter {
  organizationId: string;
  userId: string;
  resolve: (release: (() => void) | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createReportGate(limits: ReportGateLimits): ReportGate {
  let running = 0;
  const byOrganization = new Map<string, number>();
  const byUser = new Map<string, number>();
  const waiters: Waiter[] = [];

  const bump = (map: Map<string, number>, key: string, delta: number) => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const canRun = (organizationId: string, userId: string) =>
    running < limits.global &&
    (byOrganization.get(organizationId) ?? 0) < limits.perOrganization &&
    (byUser.get(userId) ?? 0) < limits.perUser;

  function take(organizationId: string, userId: string): () => void {
    running += 1;
    bump(byOrganization, organizationId, 1);
    bump(byUser, userId, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running -= 1;
      bump(byOrganization, organizationId, -1);
      bump(byUser, userId, -1);
      pump();
    };
  }

  /** Beri slot ke penunggu terlama yang batasnya sudah longgar (FIFO, melewati yang masih penuh). */
  function pump(): void {
    for (let index = 0; index < waiters.length && running < limits.global;) {
      const waiter = waiters[index]!;
      if (canRun(waiter.organizationId, waiter.userId)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(take(waiter.organizationId, waiter.userId));
      } else {
        index += 1;
      }
    }
  }

  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiters.length;
    },
    acquire(organizationId, userId) {
      if (waiters.length === 0 && canRun(organizationId, userId)) {
        return Promise.resolve(take(organizationId, userId));
      }
      if (waiters.length >= limits.maxWaiting) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter: Waiter = {
          organizationId,
          userId,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            resolve(null);
          }, limits.waitMs),
        };
        waiters.push(waiter);
        // Penunggu di depan mungkin terhalang batas organisasi/pengguna-nya sendiri.
        pump();
      });
    },
  };
}
