import type { FastifyBaseLogger } from 'fastify';

/**
 * Pekerjaan yang sengaja dijalankan SETELAH jawaban HTTP dikirim, supaya lama jawabannya tidak
 * bergantung pada hasilnya. Dipakai "minta atur ulang password": pencarian akun, pembuatan token,
 * dan pengantrean email untuk email terdaftar TIDAK boleh membuat jawabannya lebih lambat
 * daripada untuk email tak terdaftar (cegah enumerasi lewat waktu, SECURITY.md §1).
 *
 * Kegagalan dicatat di log level `error` (pemanggil sudah mendapat jawaban). Pekerjaan yang bisa
 * bertabrakan dengan dirinya sendiri harus menyerialkan diri (mis. `lockAccountTokens` untuk
 * penerbitan token akun), bukan mengandalkan log ini. Saat aplikasi ditutup, pekerjaan yang masih
 * berjalan ditunggu sampai selesai.
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
          // `err` lewat serializer logger bersama (@balesin/core): parameter query Drizzle,
          // `detail`/`where` Postgres, dan pola rahasia disensor — termasuk di rantai `cause`.
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
