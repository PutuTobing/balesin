import { parentPort } from 'node:worker_threads';

import {
  ImportError,
  buildRecipients,
  detectPhoneColumn,
  parseSpreadsheet,
  toTable,
} from './recipient-import';
import type { ImportThreadRequest, ImportThreadResponse } from './import-runner';

/**
 * Titik masuk `worker_threads` untuk parsing berkas impor (review broadcast T1): event loop api tidak
 * pernah terblokir oleh berkas buatan. Thread dipakai ulang `import-runner.ts` (pool kecil): setelah
 * dimuat ia mengirim `{ ready: true }`, lalu menjawab setiap permintaan. Batas waktu/memori ditegakkan
 * induknya (thread yang melewati batas dihentikan). Pesan galat hanya teks Indonesia `ImportError`.
 */
function run(request: ImportThreadRequest): ImportThreadResponse {
  try {
    const buffer = Buffer.from(
      request.buffer.buffer,
      request.buffer.byteOffset,
      request.buffer.byteLength,
    );
    const table = toTable(parseSpreadsheet(buffer));
    if (request.mode === 'table') return { ok: true, table, phoneColumn: null, result: null };
    const column = request.phoneColumn ?? detectPhoneColumn(table);
    if (!column || !table.columns.includes(column)) {
      throw new ImportError(
        'Kolom nomor tidak ditemukan. Beri judul kolom "nomor" atau pilih kolom nomor saat mengunggah.',
      );
    }
    return { ok: true, table, phoneColumn: column, result: buildRecipients(table, column) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ImportError ? error.message : 'Berkas tidak bisa dibaca.',
    };
  }
}

parentPort?.on('message', (request: ImportThreadRequest) => {
  parentPort?.postMessage(run(request));
});
parentPort?.postMessage({ ready: true });
