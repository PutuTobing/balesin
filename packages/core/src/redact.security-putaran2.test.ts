/**
 * Tes keamanan dari review Fase 0, PUTARAN 2
 * (docs/security-reviews/2026-11-13-fase0-fondasi.md, bagian "Putaran 2").
 *
 * Cara membaca berkas ini:
 *  - Semua tes di sini penjaga regresi: perilakunya SUDAH aman dan harus tetap begitu. Tes
 *    berlabel N2, N3, N4, dan sisa R2 ditulis saat celahnya (tingkat Rendah) masih terbuka dan
 *    kini mengunci perbaikannya.
 *  - Pola untuk temuan baru: tulis tesnya sebagai `it.fails(...)` yang menyatakan perilaku yang
 *    BENAR; setelah celahnya ditutup, hapus `.fails`-nya. Saat ini tidak ada `it.fails` di sini.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_LOGGED_STRING_LENGTH,
  redactSecrets,
  scrubSecretsInJsonLine,
  scrubSecretsInText,
} from './redact';
import { createLogCapture } from './testing';

/** Teks pengisi tanpa pola rahasia, tepat `length` karakter. */
function filler(length: number): string {
  return 'x '.repeat(Math.ceil(length / 2)).slice(0, length);
}

describe('N2 — bentuk "kunci: nilai" di teks bebas', () => {
  const leaking: Array<[label: string, text: string]> = [
    ['hasil util.inspect', "{ access_token: 'nilai-RAHASIA', expires_in: 3600 }"],
    ['gaya YAML / prosa', 'password: nilai-RAHASIA'],
    ['header di luar daftar tetap', 'x-telegram-bot-api-secret-token: nilai-RAHASIA'],
    ['header X-Auth-Token', 'X-Auth-Token: nilai-RAHASIA'],
    ['array di bawah kunci rahasia (JSON berbentuk teks)', '{"password":["nilai-RAHASIA"]}'],
  ];

  for (const [label, text] of leaking) {
    it(`menyensor ${label}`, () => {
      expect(scrubSecretsInText(text)).not.toContain('nilai-RAHASIA');
    });
  }

  it('objek sungguhan dengan kunci yang sama tetap disensor (jalur nama kunci)', () => {
    const output = redactSecrets({
      access_token: 'nilai-RAHASIA',
      headers: {
        'x-telegram-bot-api-secret-token': 'nilai-RAHASIA',
        'X-Auth-Token': 'nilai-RAHASIA',
      },
      password: ['nilai-RAHASIA'],
    });

    expect(JSON.stringify(output)).not.toContain('nilai-RAHASIA');
  });
});

describe('N3 — kunci rahasia di ujung deretan karakter yang panjang', () => {
  it('`…token=` tetap dikenali walau didahului lebih dari 64 karakter kunci', () => {
    const text = `https://x.example/cb?${'a'.repeat(70)}_token=nilai-RAHASIA&x=1`;

    expect(scrubSecretsInText(text)).not.toContain('nilai-RAHASIA');
  });

  it('sampai 64 karakter kunci sudah tertangani', () => {
    const text = `https://x.example/cb?${'a'.repeat(58)}_token=nilai-RAHASIA&x=1`;

    expect(scrubSecretsInText(text)).not.toContain('nilai-RAHASIA');
  });
});

describe('N4 — rahasia yang terpotong tepat di batas panjang log', () => {
  const metaToken = `EAAG${'a1B2c3D4'.repeat(6)}`;

  it('awalan token Meta tidak lolos saat teks dipotong di tengah token', () => {
    // 22 karakter token tersisa sebelum batas: kurang dari panjang minimum polanya.
    const text = `${filler(MAX_LOGGED_STRING_LENGTH - 22)}${metaToken} ekor`;
    const capture = createLogCapture();

    capture.logger.info({ value: text }, 'dipotong');

    expect(capture.text()).not.toContain('EAAGa1B2');
  });

  it('token yang utuh sebelum batas tetap disensor, dan teks memang dipotong', () => {
    const text = `${filler(1_000)}${metaToken} ${filler(MAX_LOGGED_STRING_LENGTH)}`;
    const capture = createLogCapture();

    capture.logger.info({ value: text }, 'dipotong');

    expect(capture.text()).not.toContain('EAAGa1B2');
    expect(capture.text()).toContain('dipotong dari');
  });
});

describe('R2 (sisa) — error Postgres kelas 22 dengan nilai di AWAL pesan', () => {
  it('SQLSTATE 22003 "value … is out of range" tidak mengulang nilainya', () => {
    // Bentuk asli dari Postgres 16 (diverifikasi saat review putaran 2).
    const pgError = Object.assign(
      new Error('value "99999999999-nilai-RAHASIA" is out of range for type integer'),
      { severity: 'ERROR', code: '22003', routine: 'pg_strtoint32_safe' },
    );
    const capture = createLogCapture();

    capture.logger.error({ err: pgError }, 'gagal');

    expect(capture.text()).not.toContain('nilai-RAHASIA');
  });
});

describe('biaya sensor tetap linear untuk masukan yang menyasar kode perbaikan putaran 1', () => {
  // Batas longgar (mesin CI lambat); implementasi kuadratik butuh jauh di atas satu detik.
  const LIMIT_MS = 1_000;
  const SIZE = 400_000;
  const repeatTo = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));

  it.each([
    ['pasangan JSON terbuka', repeatTo('"password":"')],
    ['pasangan JSON + deretan garis miring terbalik', repeatTo(`"password":"${'\\'.repeat(50)}`)],
    ['kunci=nilai berkutip terbuka', repeatTo('token="')],
    ['skema://pengguna: tanpa @', repeatTo('a://b:')],
    ['banyak skema, satu deretan panjang', `${'a.b.c.d.e.f.g.h://'}${repeatTo('x')}`],
    ['nama header + spasi', `authorization${repeatTo(' ')}`],
    ['penanda params di depan', `\nparams: x ${repeatTo('Failed query: ')}`],
    ['campuran', repeatTo('"password":"\\"token=\\"cookie: a://b:c@ Failed query: \\nparams: ')],
  ])('%s', (_label, text) => {
    const startedAt = performance.now();
    scrubSecretsInText(text);
    scrubSecretsInJsonLine(JSON.stringify({ msg: text }));

    expect(performance.now() - startedAt).toBeLessThan(LIMIT_MS);
  });
});
