import { randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { AppError } from '@balesin/core';

/**
 * Hash password dengan argon2id (SECURITY.md §1).
 *
 * Parameter mengikuti rekomendasi dasar OWASP: memori 19 MiB, 2 iterasi, 1 lajur. Jumlah hash
 * yang berjalan bersamaan dibatasi, karena tiap hash memakai 19 MiB — tanpa batas, serbuan
 * permintaan login bisa menghabiskan memori server.
 */
export const ARGON2_PARAMS = {
  /** 2 = Argon2id (enum `Algorithm` paket ini tidak bisa diimpor dengan `isolatedModules`). */
  algorithm: 2,
  /** KiB */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const CURRENT_PREFIX = `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** `false` untuk password salah MAUPUN hash yang rusak/tidak dikenal. Tidak pernah melempar karena isi hash. */
  verify(passwordHash: string, password: string): Promise<boolean>;
  /**
   * Menghabiskan waktu yang sama dengan `verify` tanpa akun sungguhan — dipakai saat email
   * tidak terdaftar, supaya lama respons tidak membuka ada/tidaknya akun.
   */
  verifyDummy(password: string): Promise<void>;
  /** Menyiapkan hash pembanding `verifyDummy` (dipanggil sekali saat aplikasi start). */
  warmUp(): Promise<void>;
  /** `true` bila hash dibuat dengan parameter lama dan perlu diperbarui saat login berhasil. */
  needsRehash(passwordHash: string): boolean;
}

export interface PasswordHasherOptions {
  /** Jumlah hash/verifikasi bersamaan. Bawaan 4. */
  concurrency?: number;
  /** Antrean maksimal; lebih dari ini ditolak 503. Bawaan 64. */
  maxQueue?: number;
}

export function createPasswordHasher(options: PasswordHasherOptions = {}): PasswordHasher {
  const concurrency = options.concurrency ?? 4;
  const maxQueue = options.maxQueue ?? 64;
  let running = 0;
  const waiting: Array<() => void> = [];
  let dummyHash: Promise<string> | undefined;

  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (running >= concurrency) {
      if (waiting.length >= maxQueue) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: 'Server sedang sibuk. Coba lagi beberapa saat lagi.',
        });
      }
      // Jatah diserahkan langsung oleh pekerjaan yang selesai (lihat `finally`), jadi `running`
      // tidak pernah melewati batas walau ada pemanggil baru yang datang di sela-selanya.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  }

  const hashPassword = (password: string) => limited(() => hash(password, ARGON2_PARAMS));
  const dummy = (): Promise<string> => {
    dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
    return dummyHash;
  };

  return {
    hash: hashPassword,

    verify: (passwordHash, password) =>
      limited(async () => {
        try {
          return await verify(passwordHash, password);
        } catch {
          return false;
        }
      }),

    async verifyDummy(password) {
      const target = await dummy();
      await limited(() => verify(target, password).catch(() => false));
    },

    async warmUp() {
      await dummy();
    },

    needsRehash: (passwordHash) => !passwordHash.startsWith(CURRENT_PREFIX),
  };
}
