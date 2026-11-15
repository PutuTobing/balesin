import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Penjaga pola wajib (review RBAC R1): 403 karena WEWENANG di service dilempar lewat
 * `forbidByRule` (`access-denied.ts`) supaya selalu diaudit. `new AppError('FORBIDDEN'` langsung
 * hanya boleh di berkas berikut — masing-masing BUKAN aturan wewenang yang perlu diaudit sebagai
 * penolakan akses. Menambah berkas ke daftar ini harus disengaja dan direview `security`.
 */
const ALLOWED: Record<string, string> = {
  'http/security.ts': 'Origin/preflight asing — sebelum sesi dibaca, pelaku tidak pasti',
  'modules/auth/auth.hook.ts': 'Origin asing / tanpa deklarasi akses; izin rute diaudit di sini',
  'modules/auth/access-denied.ts': 'forbidByRule itu sendiri',
  'modules/auth/actor-check.ts':
    'wewenang berubah DI TENGAH permintaan (review akhir R3): ditolak di transaksi yang dibatalkan; perubahan peran/nonaktifnya sudah diaudit',
  'modules/auth/permission-grant.ts': 'izin tambahan di handler — diaudit lewat record()',
  'modules/setup/setup.service.ts': 'token setup salah (publik, tanpa pengguna)',
  'modules/two-factor/two-factor.service.ts':
    'kebijakan 2FA (peran wajib tidak boleh menonaktifkan 2FA miliknya), bukan wewenang atas data lain',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('403 FORBIDDEN langsung hanya di tempat yang disetujui', () => {
  it('berkas lain wajib memakai forbidByRule (audit otomatis)', () => {
    const root = join(import.meta.dirname, '..', '..');
    const offenders = sourceFiles(root)
      .filter((path) => readFileSync(path, 'utf8').includes("AppError('FORBIDDEN'"))
      .map((path) => relative(root, path).replaceAll('\\', '/'))
      .sort();
    expect(offenders).toEqual(Object.keys(ALLOWED).sort());
  });
});
