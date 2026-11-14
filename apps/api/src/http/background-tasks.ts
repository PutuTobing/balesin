import type { FastifyBaseLogger } from 'fastify';

/**
 * Pekerjaan yang sengaja dijalankan SETELAH jawaban HTTP dikirim, supaya lama jawabannya tidak
 * bergantung pada hasilnya. Dipakai "minta atur ulang password": pencarian akun, pembuatan token,
 * dan pengantrean email untuk email terdaftar TIDAK boleh membuat jawabannya lebih lambat
 * daripada untuk email tak terdaftar (cegah enumerasi lewat waktu, SECURITY.md §1).
 *
 * Kegagalan hanya dicatat di log (pemanggil sudah mendapat jawaban). Saat aplikasi ditutup,
 * pekerjaan yang masih berjalan ditunggu sampai selesai.
 */
export interface BackgroundTasks {
  run(name: string, task: () => Promise<void>, log: FastifyBaseLogger): void;
  /** Menunggu semua pekerjaan yang sedang berjalan (penutupan aplikasi, tes). */
  drain(): Promise<void>;
}

export function createBackgroundTasks(): BackgroundTasks {
  const running = new Set<Promise<void>>();
  return {
    run(name, task, log) {
      const promise: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
        .then(task)
        .catch((err: unknown) => {
          log.error({ err, task: name }, 'Pekerjaan latar belakang gagal');
        })
        .finally(() => running.delete(promise));
      running.add(promise);
    },
    async drain() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
