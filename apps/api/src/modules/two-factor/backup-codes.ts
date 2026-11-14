import { randomInt } from 'node:crypto';

import {
  BACKUP_CODE_ALPHABET,
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  formatBackupCode,
} from '@balesin/shared';

import type { PasswordHasher } from '../auth/password-hasher';

/**
 * Kode cadangan 2FA (SECURITY.md §1): `BACKUP_CODE_COUNT` kode acak sekali pakai.
 *
 * - 10 karakter dari 31 huruf/angka yang tidak mirip satu sama lain (tanpa 0/o, 1/l/i) ≈ 49,5 bit
 *   per kode; ditampilkan `xxxxx-xxxxx` supaya mudah dibaca dan diketik. Huruf besar/kecil, spasi,
 *   dan tanda hubung diabaikan saat diperiksa (`normalizeTwoFactorCode`).
 * - Disimpan sebagai hash argon2id (sama dengan password): ruang tebakannya cukup kecil sehingga
 *   SHA-256 biasa masih bisa dibongkar dari salinan database yang bocor.
 * - Diambil dengan `crypto.randomInt` (seragam, tanpa bias modulo).
 */

export interface GeneratedBackupCodes {
  /** Bentuk tampilan `xxxxx-xxxxx` — hanya dikirim ke pengguna sekali ini. */
  display: string[];
  /** Hash argon2id untuk disimpan. */
  hashes: string[];
}

export function randomBackupCode(): string {
  let code = '';
  for (let index = 0; index < BACKUP_CODE_LENGTH; index += 1) {
    code += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
  }
  return code;
}

export async function generateBackupCodes(hasher: PasswordHasher): Promise<GeneratedBackupCodes> {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) codes.add(randomBackupCode());
  const plain = [...codes];
  const hashes = await Promise.all(plain.map((code) => hasher.hash(code)));
  return { display: plain.map(formatBackupCode), hashes };
}
