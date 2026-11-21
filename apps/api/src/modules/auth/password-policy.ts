import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@balesin/shared';

import { commonPasswords } from './common-passwords';

/**
 * Aturan password baru (SECURITY.md §1): minimal 10 karakter, tidak ada di daftar password
 * umum, tidak mudah ditebak dari data pemiliknya. Sengaja TANPA aturan komposisi ("harus ada
 * huruf besar, angka, simbol"): aturan seperti itu mendorong pola `Password1!` dan tidak
 * menambah keamanan — panjang + bukan password umum jauh lebih berarti.
 */

export interface PasswordContext {
  email?: string;
  name?: string;
  organizationName?: string;
  productName?: string;
}

export type PasswordRejection = 'too_short' | 'too_long' | 'repetitive' | 'common' | 'personal';

export type PasswordVerdict =
  { acceptable: true } | { acceptable: false; reason: PasswordRejection; message: string };

const MESSAGES: Record<PasswordRejection, string> = {
  too_short: `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`,
  too_long: `Password maksimal ${PASSWORD_MAX_LENGTH} karakter.`,
  repetitive:
    'Password ini terlalu mudah ditebak karena berisi karakter yang berulang atau berurutan. Pakai gabungan beberapa kata acak yang tidak berhubungan.',
  common:
    'Password ini terlalu umum dan mudah ditebak. Pakai gabungan beberapa kata acak yang tidak berhubungan, misalnya tiga atau empat kata.',
  personal:
    'Password tidak boleh memuat nama, email, atau nama perusahaanmu. Pakai gabungan kata lain yang hanya kamu yang tahu.',
};

function reject(reason: PasswordRejection): PasswordVerdict {
  return { acceptable: false, reason, message: MESSAGES[reason] };
}

/** Pengganti huruf yang lazim ("p@ssw0rd" → "password"). */
const LEET: Record<string, string> = {
  '@': 'a',
  '4': 'a',
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  $: 's',
  '5': 's',
  '7': 't',
};

function unleet(text: string): string {
  return Array.from(text, (character) => LEET[character] ?? character).join('');
}

/** Tambahan di depan/belakang kata umum sependek ini tidak membuatnya aman ("password2024!"). */
const MAX_DECORATION_LENGTH = 6;

function isCommon(lowered: string): boolean {
  const common = commonPasswords();
  if (common.has(lowered) || common.has(unleet(lowered))) return true;

  // Kata umum + hiasan pendek berupa angka/simbol di depan atau belakang.
  const core = lowered.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
  const decoration = lowered.length - core.length;
  if (core.length >= 4 && decoration > 0 && decoration <= MAX_DECORATION_LENGTH) {
    if (common.has(core)) return true;
  }
  // Sama, setelah pengganti huruf dikembalikan ("p@ssw0rd123").
  const plain = unleet(lowered.replace(/\d+$/, ''));
  const trailingDigits = lowered.length - lowered.replace(/\d+$/, '').length;
  if (plain.length >= 4 && trailingDigits <= MAX_DECORATION_LENGTH && common.has(plain))
    return true;

  // Kata umum yang sekadar diulang ("qwertyqwerty", "adminadmin").
  for (let size = 3; size <= lowered.length / 2; size += 1) {
    if (lowered.length % size !== 0) continue;
    const unit = lowered.slice(0, size);
    if (unit.repeat(lowered.length / size) === lowered && (common.has(unit) || size <= 4))
      return true;
  }
  return false;
}

/** Semua karakter membentuk satu deret naik/turun ("abcdefghij", "9876543210"). */
function isSequence(text: string): boolean {
  if (text.length < 2) return false;
  const step = text.charCodeAt(1) - text.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let index = 2; index < text.length; index += 1) {
    if (text.charCodeAt(index) - text.charCodeAt(index - 1) !== step) return false;
  }
  return true;
}

function isRepetitive(lowered: string): boolean {
  return new Set(lowered).size < 4 || isSequence(lowered);
}

/** Potongan data pribadi (≥4 karakter) yang tidak boleh muncul di dalam password. */
function personalFragments(context: PasswordContext): string[] {
  const fragments = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const lowered = value.toLowerCase();
    for (const word of lowered.split(/[^a-z0-9]+/)) {
      if (word.length >= 4) fragments.add(word);
    }
    const joined = lowered.replace(/[^a-z0-9]+/g, '');
    if (joined.length >= 4) fragments.add(joined);
  };

  const [localPart, domain] = (context.email ?? '').toLowerCase().split('@');
  add(localPart);
  // Dari domain hanya label pertamanya ("contoh" dari contoh.co.id); "gmail" dsb. sudah tercakup daftar umum.
  add(domain?.split('.')[0]);
  add(context.name);
  add(context.organizationName);
  add(context.productName);
  return [...fragments];
}

/**
 * Menilai password baru. `context` berisi data pemilik akun supaya password seperti
 * `budisantoso2024` atau `majujaya123` ikut ditolak.
 */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordVerdict {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) return reject('too_short');
  if (length > PASSWORD_MAX_LENGTH) return reject('too_long');

  const lowered = password.toLowerCase();
  if (isRepetitive(lowered)) return reject('repetitive');
  if (isCommon(lowered)) return reject('common');

  const compact = lowered.replace(/[^a-z0-9]+/g, '');
  const plain = unleet(lowered).replace(/[^a-z0-9]+/g, '');
  for (const fragment of personalFragments(context)) {
    if (compact.includes(fragment) || plain.includes(fragment)) return reject('personal');
  }
  return { acceptable: true };
}
