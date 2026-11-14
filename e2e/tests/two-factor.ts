import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { OWNER_STATE_PATH } from '../stack/env';

/**
 * Verifikasi dua langkah di E2E (melawan API sungguhan).
 *
 * TOTP dihitung di sini (HMAC-SHA1, RFC 6238), bukan dengan `generateTotp` dari `@balesin/core`:
 * paket itu khusus server (mengimpor nodemailer, pino, ioredis lewat satu pintu `index.ts`) dan
 * tidak punya subpath `totp`. Algoritmanya baku dan pendek; kebenarannya diperiksa terhadap
 * vektor uji resmi RFC 6238 Lampiran B setiap kali modul ini dimuat (lihat `selfCheck`).
 *
 * Server menolak kode untuk langkah waktu yang sama atau lebih lama dari yang terakhir dipakai
 * (anti-replay), dan setiap kode salah dihitung menuju kunci 15 menit. Tes paralel (proyek
 * desktop dan HP) yang masuk ulang sebagai Owner karena itu mengambil kode lewat `withOwnerCode`:
 * kunci berkas lintas proses memastikan setiap langkah waktu dipakai paling banyak sekali dan
 * berurutan; bila langkah berikutnya belum tersedia, kode cadangan dipakai, baru kalau habis
 * menunggu langkah baru.
 */

const PERIOD_MS = 30_000;
const AUTH_DIR = path.dirname(OWNER_STATE_PATH);
const SECRET_PATH = path.join(AUTH_DIR, 'owner-2fa.json');
const USAGE_PATH = path.join(AUTH_DIR, 'owner-2fa-usage.json');
const LOCK_PATH = path.join(AUTH_DIR, 'owner-2fa.lock');

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Karakter base32 tidak valid: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(key: Buffer, counter: number, digits = 6, algorithm = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(at = Date.now()): number {
  return Math.floor(at / PERIOD_MS);
}

/** Kode 6 digit untuk rahasia base32 pada langkah waktu tertentu. */
export function totpAtStep(secret: string, step: number): string {
  return hotp(base32Decode(secret), step);
}

/** RFC 6238 Lampiran B (SHA-1, rahasia ASCII "12345678901234567890", 8 digit). */
function selfCheck(): void {
  const key = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [2000000000, '69279037'],
  ];
  for (const [seconds, expected] of vectors) {
    const actual = hotp(key, Math.floor(seconds / 30), 8);
    if (actual !== expected) throw new Error(`TOTP E2E salah: ${actual} ≠ ${expected}`);
  }
}
selfCheck();

/** Kode 6 digit yang PASTI salah sekarang (bukan kode langkah −1, 0, +1). */
export function wrongTotp(secret: string): string {
  const valid = new Set([-1, 0, 1].map((drift) => totpAtStep(secret, totpStep() + drift)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

// ── Berkas bersama antarproses ──────────────────────────────────────────────

interface OwnerTwoFactor {
  secret: string;
  /** Kode cadangan yang belum dipakai tes mana pun. */
  backupCodes: string[];
  /** Langkah TOTP terakhir yang sudah dipakai (server menolak langkah ≤ ini). */
  lastStep: number | null;
}

/** Dipanggil alur awal setelah Owner mendaftar 2FA (atau membuat ulang kode cadangan). */
export function saveOwnerTwoFactor(state: OwnerTwoFactor): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(SECRET_PATH, JSON.stringify({ secret: state.secret }));
  writeFileSync(
    USAGE_PATH,
    JSON.stringify({ backupCodes: state.backupCodes, lastStep: state.lastStep }),
  );
}

/** Ganti persediaan kode cadangan (setelah dibuat ulang); langkah TOTP terakhir tetap. */
export function replaceOwnerBackupCodes(codes: string[]): void {
  writeUsage({ ...readUsage(), backupCodes: codes });
}

export function ownerSecret(): string {
  return (JSON.parse(readFileSync(SECRET_PATH, 'utf8')) as { secret: string }).secret;
}

function readUsage(): Omit<OwnerTwoFactor, 'secret'> {
  return JSON.parse(readFileSync(USAGE_PATH, 'utf8')) as Omit<OwnerTwoFactor, 'secret'>;
}

function writeUsage(usage: Omit<OwnerTwoFactor, 'secret'>): void {
  writeFileSync(USAGE_PATH, JSON.stringify(usage));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH);
      break;
    } catch {
      // Kunci basi (proses tes mati di tengah jalan) dibuang setelah 90 detik.
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > 90_000)
          rmSync(LOCK_PATH, { force: true, recursive: true });
      } catch {
        // Kunci baru saja dilepas proses lain.
      }
      if (Date.now() > deadline) throw new Error('Kunci kode 2FA E2E tidak kunjung lepas.');
      await sleep(150);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(LOCK_PATH, { force: true, recursive: true });
  }
}

export type OwnerCode = { kind: 'totp' | 'backup_code'; code: string };

/**
 * Pakai satu kode Owner yang belum pernah dipakai. `use` dijalankan sampai server menerima kode
 * itu. TOTP: kunci dipegang selama `use` (urutan langkah ke server harus naik). Kode cadangan:
 * kunci langsung dilepas (tidak bergantung urutan).
 */
export async function withOwnerCode<T>(
  use: (code: OwnerCode) => Promise<T>,
  options: { allowBackup?: boolean } = {},
): Promise<T> {
  const secret = ownerSecret();
  let backup: string | null = null;
  const result = await withLock(async () => {
    const usage = readUsage();
    const now = totpStep();
    const next = Math.max(now, (usage.lastStep ?? -1) + 1);
    if (next > now + 1 && options.allowBackup !== false && usage.backupCodes.length > 0) {
      backup = usage.backupCodes.shift() ?? null;
      writeUsage(usage);
      return null;
    }
    // Tunggu sampai langkah `next` masuk jendela toleransi server (langkah sekarang ±1).
    const waitMs = (next - 1) * PERIOD_MS - Date.now() + 500;
    if (waitMs > 0) await sleep(waitMs);
    writeUsage({ ...usage, lastStep: next });
    return { value: await use({ kind: 'totp', code: totpAtStep(secret, next) }) };
  });
  if (result) return result.value;
  return use({ kind: 'backup_code', code: backup ?? '' });
}

/**
 * Langkah kedua halaman masuk (setelah password benar): isi kode Owner, kirim, dan lewati layar
 * "masuk dengan kode cadangan" bila kode cadangan yang terpakai.
 */
export async function completeTwoFactor(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
  ).toBeVisible();
  await withOwnerCode(async ({ kind, code }) => {
    if (kind === 'backup_code') {
      await page.getByRole('button', { name: 'Pakai kode cadangan' }).click();
      await page.getByLabel('Kode cadangan').fill(code);
    } else {
      await page.getByLabel('Kode verifikasi').fill(code);
    }
    await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    if (kind === 'backup_code') {
      await expect(
        page.getByRole('heading', { level: 1, name: 'Kamu masuk dengan kode cadangan' }),
      ).toBeVisible();
      await page.getByRole('button', { name: /^(Lanjut|Nanti saja)$/ }).click();
    }
    await expect(
      page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
    ).toBeHidden();
  });
}
