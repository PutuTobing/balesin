import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  configureZodLocale,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  errorEnvelopeSchema,
  healthResponseSchema,
  normalizeEmail,
  readyResponseSchema,
  USER_ROLE_LABELS,
  USER_ROLES,
  userRoleSchema,
} from './index';

describe('peran pengguna', () => {
  it('tepat lima peran sesuai PRD §4, masing-masing punya label', () => {
    expect(USER_ROLES).toEqual(['owner', 'admin', 'supervisor', 'cs', 'teknisi']);
    expect(Object.keys(USER_ROLE_LABELS).sort()).toEqual([...USER_ROLES].sort());
  });

  it('skema menolak peran lain', () => {
    expect(userRoleSchema.safeParse('teknisi').success).toBe(true);
    expect(userRoleSchema.safeParse('superadmin').success).toBe(false);
    expect(userRoleSchema.safeParse('Owner').success).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('memangkas spasi dan mengecilkan huruf', () => {
    expect(normalizeEmail('  Budi.Santoso@Contoh.CO.ID ')).toBe('budi.santoso@contoh.co.id');
    expect(normalizeEmail('budi@contoh.com')).toBe('budi@contoh.com');
  });
});

describe('amplop error', () => {
  it('setiap kode punya status HTTP dan pesan bahasa Indonesia', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(600);
      expect(ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('pesan memakai sapaan "kamu" atau tanpa kata ganti — tidak pernah "Anda" (DESIGN.md §4)', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code], code).not.toMatch(/\banda\b/i);
      expect(ERROR_MESSAGES[code], code).toMatch(/\.$/);
    }
    expect(ERROR_MESSAGES.FORBIDDEN).toBe('Kamu tidak punya izin untuk melakukan tindakan ini.');
    expect(ERROR_MESSAGES.UNAUTHENTICATED).toBe('Masuk dulu untuk melanjutkan.');
    expect(ERROR_STATUS.METHOD_NOT_ALLOWED).toBe(405);
  });

  it('menerima amplop dengan dan tanpa rincian', () => {
    const base = { code: 'NOT_FOUND', message: 'Tidak ditemukan.', requestId: 'req-1' };

    expect(errorEnvelopeSchema.parse({ error: base })).toEqual({ error: base });
    expect(
      errorEnvelopeSchema.parse({
        error: {
          ...base,
          code: 'VALIDATION_ERROR',
          details: [{ location: 'body', field: 'email', message: 'Email tidak valid.' }],
        },
      }).error.details,
    ).toHaveLength(1);
  });

  it('tetap bisa membaca kode yang belum dikenal klien lama', () => {
    const parsed = errorEnvelopeSchema.safeParse({
      error: { code: 'KODE_BARU', message: 'Pesan.', requestId: 'req-2' },
    });
    expect(parsed.success).toBe(true);
  });

  it('menolak amplop tanpa requestId atau dengan lokasi rincian yang salah', () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'X', message: 'Y' } }).success).toBe(
      false,
    );
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: 'X',
          message: 'Y',
          requestId: 'r',
          details: [{ location: 'cookie', field: 'a', message: 'b' }],
        },
      }).success,
    ).toBe(false);
  });
});

describe('configureZodLocale', () => {
  it('pesan validasi bawaan berbahasa Indonesia; isian yang tidak dikirim = "Wajib diisi."', () => {
    configureZodLocale();
    const schema = z.object({ nama: z.string(), email: z.email(), umur: z.number().min(17) });

    const result = schema.safeParse({ email: 'bukan-email', umur: 3 });

    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['nama', 'Wajib diisi.'],
      ['email', 'alamat email tidak valid'],
      ['umur', 'Terlalu kecil: diharapkan number menjadi >=17'],
    ]);
  });

  it('pesan khusus di skema tetap diutamakan', () => {
    configureZodLocale();
    const schema = z.object({ nama: z.string({ error: 'Nama wajib diisi.' }) });

    expect(schema.safeParse({}).error?.issues[0]?.message).toBe('Nama wajib diisi.');
  });
});

describe('respons health/ready', () => {
  it('health hanya menerima status ok', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: 'down' }).success).toBe(false);
  });

  it('ready memuat status tiap dependensi', () => {
    expect(
      readyResponseSchema.parse({
        status: 'unavailable',
        dependencies: { postgres: 'ok', redis: 'down' },
      }),
    ).toEqual({ status: 'unavailable', dependencies: { postgres: 'ok', redis: 'down' } });
    expect(
      readyResponseSchema.safeParse({ status: 'ok', dependencies: { postgres: 'ok' } }).success,
    ).toBe(false);
    expect(
      readyResponseSchema.safeParse({
        status: 'ok',
        dependencies: { postgres: 'ok', redis: 'ECONNREFUSED 10.0.0.5:6379' },
      }).success,
    ).toBe(false);
  });
});
