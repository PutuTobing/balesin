import type { Logger } from './logger';

/** Satu langkah penutupan, mis. server HTTP, pool Postgres, koneksi Redis. */
export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Dijalankan berurutan. Urutkan dari "pintu masuk" (server/worker) ke dependensi (DB, Redis). */
  steps: readonly ShutdownStep[];
  /** Batas waktu total sebelum keluar paksa. Bawaan 15 detik. */
  timeoutMs?: number;
  /** Bawaan `process.exit`; bisa diganti untuk tes. */
  exit?: (code: number) => void;
}

export type Shutdown = (reason: string, exitCode?: number) => Promise<void>;

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Membuat fungsi penutupan rapi: menjalankan tiap langkah berurutan, lalu keluar.
 * Aman dipanggil berkali-kali (sinyal ganda) — penutupan hanya berjalan sekali.
 * Langkah yang gagal dicatat dan tidak menghentikan langkah berikutnya.
 */
export function createShutdown(options: ShutdownOptions): Shutdown {
  const { logger, steps } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;

  async function run(reason: string, exitCode: number): Promise<void> {
    logger.info({ reason }, 'Menutup layanan dengan rapi');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'Penutupan melewati batas waktu, keluar paksa');
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        failed = true;
        logger.error({ err, step: step.name }, 'Gagal menutup salah satu komponen');
      }
    }

    clearTimeout(forceExit);
    logger.info('Layanan berhenti');
    exit(failed && exitCode === 0 ? 1 : exitCode);
  }

  return (reason, exitCode = 0) => {
    running ??= run(reason, exitCode);
    return running;
  };
}

/** SIGTERM (Docker/systemd) dan SIGINT (Ctrl+C) memicu penutupan rapi. */
export function registerShutdownSignals(shutdown: Shutdown, source: EventSource = process): void {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    source.on(signal, () => void shutdown(signal));
  }
}

/**
 * Galat yang lolos tanpa tertangani dicatat lewat logger (yang menyensor rahasia), lalu proses
 * ditutup dengan kode 1. Tanpa ini Node mencetak objek error mentah ke stderr.
 */
export function registerCrashHandlers(
  logger: Logger,
  shutdown: Shutdown,
  source: EventSource = process,
): void {
  source.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Galat tidak tertangani (uncaughtException)');
    void shutdown('uncaughtException', 1);
  });
  source.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Promise ditolak tanpa penanganan (unhandledRejection)');
    void shutdown('unhandledRejection', 1);
  });
}
