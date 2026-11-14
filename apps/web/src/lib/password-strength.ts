import { PASSWORD_MIN_LENGTH } from '@balesin/shared';

/**
 * Perkiraan kekuatan password di browser, hanya sebagai umpan balik saat mengetik. Keputusan
 * akhir (daftar password umum, data pribadi) tetap di server: `/setup/check-password` saat setup,
 * dan saat dikirim untuk undangan dan atur ulang password.
 *
 * Sesuai kebijakan server (DECISIONS: tanpa aturan komposisi), panjang adalah faktor utama;
 * variasi karakter hanya menambah sedikit, dan pengulangan menguranginya.
 */
export type StrengthLevel = 0 | 1 | 2 | 3;

export interface PasswordStrength {
  level: StrengthLevel;
  /** Karakter yang masih kurang untuk batas minimal (0 bila sudah cukup). */
  missing: number;
}

export function estimatePasswordStrength(password: string): PasswordStrength {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) {
    return { level: 0, missing: PASSWORD_MIN_LENGTH - length };
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  const unique = new Set(Array.from(password.toLowerCase())).size;

  let score = 1;
  if (length >= 14) score += 1;
  if (length >= 18 || (length >= 12 && classes >= 3)) score += 1;
  // Banyak karakter berulang ("aaaaaaaaaa", "abababab…") = mudah ditebak.
  if (unique < Math.min(6, Math.ceil(length / 3))) score -= 1;

  return { level: Math.max(1, Math.min(3, score)) as StrengthLevel, missing: 0 };
}
