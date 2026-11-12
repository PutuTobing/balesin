import { ERROR_MESSAGES, ERROR_STATUS, type ErrorCode, type ErrorDetail } from '@balesin/shared';

export interface AppErrorOptions {
  /** Pesan untuk pengguna (bahasa Indonesia). Bawaan: pesan standar untuk `code`. */
  message?: string;
  /** Status HTTP. Bawaan: status standar untuk `code`. */
  statusCode?: number;
  /** Rincian per isian (biasanya untuk error validasi). */
  details?: ErrorDetail[];
  /** Penyebab asli — hanya masuk log, tidak pernah dikirim ke klien. */
  cause?: unknown;
}

/**
 * Error yang AMAN ditampilkan ke klien: `code`, `message`, dan `details` dikirim apa adanya
 * dalam amplop error. Jangan pernah menaruh rahasia atau pesan error internal di sini;
 * taruh penyebab asli di `cause`.
 *
 * Error lain (bukan `AppError`) selalu dijawab 500 dengan pesan umum.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? ERROR_MESSAGES[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? ERROR_STATUS[code];
    if (options.details) this.details = options.details;
  }
}
