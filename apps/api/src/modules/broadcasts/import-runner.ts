import { Worker } from 'node:worker_threads';

import { createConcurrencyGate } from '../messages/concurrency';
import { ImportError, type ImportResult, type ParsedTable } from './recipient-import';

/**
 * Parsing berkas impor CSV/XLSX TERISOLASI (review broadcast T1): dijalankan di `worker_threads` dengan
 * batas waktu parsing (bawaan 10 dtk, dihitung sejak thread siap) dan batas memori heap (256 MB), maks. 2
 * berjalan bersamaan per proses. Thread dipakai ulang (pool hangat); thread yang gagal/kelewat batas
 * dihentikan dan tidak dipakai lagi.
 * Berkas buatan yang lambat/rakus memori hanya mematikan thread-nya; event loop api (inbox, webhook
 * Meta, sesi) tetap jalan.
 *
 * DIPAKAI ULANG modul lain (impor kontak Fase 5): `parseTableIsolated` untuk tabel saja,
 * `parseRecipientsIsolated` untuk penerima ber-nomor. Galat selalu `ImportError` (pesan Indonesia).
 *
 * Kode sumber (dev/tes) → thread memuat `import-thread.ts` lewat loader `tsx`; build produksi →
 * `dist/import-thread.js` (entry tsup sendiri, lihat `tsup.config.ts`).
 */

export interface ImportThreadRequest {
  mode: 'table' | 'recipients';
  buffer: Uint8Array;
  phoneColumn?: string;
}

export type ImportThreadResponse =
  | {
      ok: true;
      table: ParsedTable;
      phoneColumn: string | null;
      result: ImportResult | null;
    }
  | { ok: false; message: string };

export interface ImportRunOptions {
  /** Batas waktu thread (ms). */
  timeoutMs?: number;
  /** Batas heap thread (MB). */
  maxHeapMb?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HEAP_MB = 256;
const gate = createConcurrencyGate({ global: 2, perUser: 1 });

export class ImportBusyError extends Error {
  constructor() {
    super('Impor lain sedang diproses');
    this.name = 'ImportBusyError';
  }
}

function threadUrl(): { url: URL; execArgv: string[] } {
  const self = import.meta.url;
  if (self.endsWith('.ts')) {
    return { url: new URL('./import-thread.ts', self), execArgv: ['--import', 'tsx'] };
  }
  return { url: new URL('./import-thread.js', self), execArgv: [] };
}

/** Lama muat thread (bukan dikendalikan isi berkas; dev/tes memuat sumber TS lewat `tsx`). */
const STARTUP_TIMEOUT_MS = 120_000;
/** Thread menganggur dihentikan setelah sekian lama (memori dikembalikan). */
const IDLE_MS = 5 * 60_000;

interface PooledThread {
  worker: Worker;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Thread hangat yang siap dipakai ulang (maks. sebanyak batas gerbang). */
const idle: PooledThread[] = [];

function spawn(heapMb: number): Promise<PooledThread> {
  const { url, execArgv } = threadUrl();
  const worker = new Worker(url, {
    execArgv,
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: heapMb,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  // Thread tidak menahan proses tetap hidup saat api ditutup.
  worker.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ImportError('Pemroses impor tidak bisa dimulai. Coba lagi sebentar lagi.'));
    }, STARTUP_TIMEOUT_MS);
    worker.once('message', () => {
      clearTimeout(timer);
      resolve({ worker, idleTimer: null });
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new ImportError('Pemroses impor tidak bisa dimulai. Coba lagi sebentar lagi.'));
    });
  });
}

function release(thread: PooledThread) {
  thread.idleTimer = setTimeout(() => {
    const index = idle.indexOf(thread);
    if (index >= 0) idle.splice(index, 1);
    void thread.worker.terminate();
  }, IDLE_MS);
  thread.idleTimer.unref();
  idle.push(thread);
}

async function runThread(
  request: ImportThreadRequest,
  options: ImportRunOptions,
): Promise<Extract<ImportThreadResponse, { ok: true }>> {
  const heapMb = options.maxHeapMb ?? DEFAULT_HEAP_MB;
  const reused = options.maxHeapMb === undefined ? idle.pop() : undefined;
  if (reused?.idleTimer) clearTimeout(reused.idleTimer);
  const thread = reused ?? (await spawn(heapMb));
  const { worker } = thread;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const fail = (error: ImportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Thread yang gagal/terlalu lama TIDAK dipakai ulang.
      void worker.terminate();
      reject(error);
    };
    const onMessage = (message: ImportThreadResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.maxHeapMb === undefined) release(thread);
      else void worker.terminate();
      if (message.ok) resolve(message);
      else reject(new ImportError(message.message));
    };
    const onError = (error: Error & { code?: string }) => {
      fail(
        new ImportError(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'Berkas terlalu besar untuk diproses.'
            : 'Berkas tidak bisa diproses.',
        ),
      );
    };
    const onExit = () => {
      fail(new ImportError('Berkas tidak bisa diproses.'));
    };
    // Batas waktu PARSING dihitung sejak thread siap (waktu muat thread tidak dikendalikan berkas).
    const timer = setTimeout(() => {
      fail(
        new ImportError(
          'Berkas terlalu rumit untuk diproses dalam batas waktu. Simpan ulang sebagai CSV lalu coba lagi.',
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(request);
  });
}

async function isolated(
  key: string,
  request: ImportThreadRequest,
  options: ImportRunOptions,
): Promise<Extract<ImportThreadResponse, { ok: true }>> {
  const release = gate.tryAcquire(key);
  if (!release) throw new ImportBusyError();
  try {
    return await runThread(request, options);
  } finally {
    release();
  }
}

/** Tabel (judul + baris) dari berkas CSV/XLSX, diproses di thread terpisah. */
export async function parseTableIsolated(
  key: string,
  buffer: Buffer,
  options: ImportRunOptions = {},
): Promise<ParsedTable> {
  return (await isolated(key, { mode: 'table', buffer }, options)).table;
}

/** Penerima ber-nomor (kolom nomor dideteksi bila tidak diberikan), diproses di thread terpisah. */
export async function parseRecipientsIsolated(
  key: string,
  buffer: Buffer,
  phoneColumn: string | undefined,
  options: ImportRunOptions = {},
): Promise<{ table: ParsedTable; phoneColumn: string; result: ImportResult }> {
  const response = await isolated(
    key,
    { mode: 'recipients', buffer, ...(phoneColumn ? { phoneColumn } : {}) },
    options,
  );
  if (!response.phoneColumn || !response.result) throw new ImportError('Berkas tidak bisa dibaca.');
  return { table: response.table, phoneColumn: response.phoneColumn, result: response.result };
}
