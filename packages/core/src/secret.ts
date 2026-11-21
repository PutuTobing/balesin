import { inspect } from 'node:util';

/** Teks pengganti untuk nilai rahasia di log dan keluaran lain. */
export const REDACTED = '[DISEMBUNYIKAN]';

/**
 * Pembungkus nilai rahasia (master key, token, password, connection string).
 *
 * Nilai asli hanya keluar lewat `reveal()`. Semua jalur "tidak sengaja" — `JSON.stringify`,
 * template string, `console.log`/`util.inspect`, logger — menghasilkan `[DISEMBUNYIKAN]`,
 * jadi rahasia tidak bocor walau objek konfigurasi ikut ter-log.
 */
export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Ambil nilai asli. Panggil sedekat mungkin dengan tempat pemakaiannya; jangan disimpan/di-log. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
