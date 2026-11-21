import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  hotp,
  matchTotp,
  sanitizeTotpLabelPart,
  totpStep,
  totpUri,
  type HotpAlgorithm,
} from './totp';

const RFC_SECRET_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRETS: Record<HotpAlgorithm, Buffer> = {
  sha1: RFC_SECRET_SHA1,
  sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
};

describe('base32 (RFC 4648 §10)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('"%s" ↔ "%s"', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('membuka huruf kecil, spasi, tanda hubung, dan padding; menolak karakter asing', () => {
    expect(base32Decode('mzxw 6ytb-oi======').toString('ascii')).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
    expect(() => base32Decode('MZXW8')).toThrow();
  });

  it('rahasia baru: 20 byte acak = 32 karakter base32, selalu berbeda', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(first)).toHaveLength(20);
    expect(first).not.toBe(second);
  });
});

describe('HOTP — vektor uji RFC 4226 Lampiran D', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('penghitung %i → %s', (counter, code) => {
    expect(hotp(RFC_SECRET_SHA1, counter)).toBe(code);
  });

  it('menolak penghitung negatif atau pecahan', () => {
    expect(() => hotp(RFC_SECRET_SHA1, -1)).toThrow();
    expect(() => hotp(RFC_SECRET_SHA1, 1.5)).toThrow();
  });
});

describe('TOTP — vektor uji RFC 6238 Lampiran B', () => {
  // Waktu (detik) → kode 8 digit untuk SHA-1, SHA-256, SHA-512.
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  it.each(vectors)('T = %i detik', (seconds, sha1, sha256, sha512) => {
    const step = totpStep(seconds * 1000);
    expect(hotp(RFC_SECRETS.sha1, step, { digits: 8, algorithm: 'sha1' })).toBe(sha1);
    expect(hotp(RFC_SECRETS.sha256, step, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(hotp(RFC_SECRETS.sha512, step, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });

  it('6 digit (parameter produksi) = 6 digit terakhir vektor SHA-1', () => {
    const secret = base32Encode(RFC_SECRET_SHA1);
    for (const [seconds, sha1] of vectors) {
      expect(generateTotp(secret, seconds * 1000)).toBe(sha1.slice(-6));
    }
  });
});

describe('matchTotp: jendela waktu, pergeseran jam, dan pemakaian ulang', () => {
  const secret = base32Encode(RFC_SECRET_SHA1);
  const now = 1_234_567_890_000;
  const step = totpStep(now);
  const codeAt = (offsetSteps: number) => generateTotp(secret, now + offsetSteps * 30_000);

  it('kode langkah sekarang cocok dan mengembalikan nomor langkahnya', () => {
    expect(matchTotp(secret, codeAt(0), { nowMs: now })).toBe(step);
  });

  it('jam ponsel tertinggal/terdahulu satu langkah (±30 detik) masih diterima', () => {
    expect(matchTotp(secret, codeAt(-1), { nowMs: now })).toBe(step - 1);
    expect(matchTotp(secret, codeAt(1), { nowMs: now })).toBe(step + 1);
  });

  it('lebih dari satu langkah ditolak', () => {
    expect(matchTotp(secret, codeAt(-2), { nowMs: now })).toBeNull();
    expect(matchTotp(secret, codeAt(2), { nowMs: now })).toBeNull();
  });

  it('kode yang sama tidak bisa dipakai ulang; kode langkah lebih lama juga ditolak', () => {
    const used = matchTotp(secret, codeAt(0), { nowMs: now });
    expect(used).toBe(step);
    expect(matchTotp(secret, codeAt(0), { nowMs: now, lastUsedStep: used })).toBeNull();
    expect(matchTotp(secret, codeAt(-1), { nowMs: now, lastUsedStep: used })).toBeNull();
    // Kode langkah berikutnya tetap bisa dipakai.
    expect(matchTotp(secret, codeAt(1), { nowMs: now, lastUsedStep: used })).toBe(step + 1);
  });

  it('bentuk selain tepat 6 digit langsung ditolak', () => {
    for (const code of ['', '12345', '1234567', '12 345', 'abcdef', `${codeAt(0)} `]) {
      expect(matchTotp(secret, code, { nowMs: now })).toBeNull();
    }
  });

  it('rahasia lain tidak cocok', () => {
    expect(matchTotp(generateTotpSecret(), codeAt(0), { nowMs: now })).toBeNull();
  });
});

describe('URI otpauth://', () => {
  it('memuat penerbit, akun, rahasia, dan parameter yang dipahami aplikasi autentikator', () => {
    const uri = totpUri({
      issuer: 'PT Maju Jaya',
      accountName: 'sari@majujaya.test',
      secretBase32: 'JBSWY3DPEHPK3PXP',
    });
    expect(uri).toBe(
      'otpauth://totp/PT%20Maju%20Jaya:sari%40majujaya.test?secret=JBSWY3DPEHPK3PXP&issuer=PT%20Maju%20Jaya&algorithm=SHA1&digits=6&period=30',
    );
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('issuer')).toBe('PT Maju Jaya');
  });

  it('titik dua (pemisah label) dibuang; teks kosong diganti; panjang dibatasi', () => {
    expect(sanitizeTotpLabelPart('Toko: Cabang  Utama ', 'x')).toBe('Toko Cabang Utama');
    expect(sanitizeTotpLabelPart(' :: ', 'Akun')).toBe('Akun');
    expect(sanitizeTotpLabelPart('a'.repeat(100), 'x')).toHaveLength(64);
    const uri = totpUri({ issuer: 'A:B', accountName: 'x@y.test', secretBase32: 'AAAA' });
    expect(uri.startsWith('otpauth://totp/A%20B:x%40y.test?')).toBe(true);
  });
});
