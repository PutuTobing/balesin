import { hash } from '@node-rs/argon2';
import { AppError, Secret, sha256Hex } from '@balesin/core';
import { describe, expect, it } from 'vitest';

import { maskEmail } from '../audit/audit';
import { sniffImageType, validateLogoUpload } from '../branding/logo';
import { commonPasswords } from './common-passwords';
import { createCsrfProtection } from './csrf';
import { createPasswordHasher } from './password-hasher';
import { checkPassword } from './password-policy';

describe('aturan password', () => {
  const context = {
    email: 'budi.santoso@majujaya.co.id',
    name: 'Budi Santoso',
    organizationName: 'PT Maju Jaya Abadi',
    productName: 'Balesin',
  };
  const reasonOf = (password: string) => {
    const verdict = checkPassword(password, context);
    return verdict.acceptable ? 'ok' : verdict.reason;
  };

  it('daftar password umum termuat (puluhan ribu entri) dan mencakup kata Indonesia', () => {
    const list = commonPasswords();

    expect(list.size).toBeGreaterThan(40_000);
    for (const entry of [
      'password',
      '123456789',
      'qwertyuiop',
      'bismillah',
      'indonesia',
      'rahasia',
    ]) {
      expect(list.has(entry), entry).toBe(true);
    }
  });

  it.each([
    ['kopi-tubruk-gerimis-senja', 'ok'],
    ['Tr0ub4dor&3xyzzy', 'ok'],
    ['lemari biru di teras belakang', 'ok'],
    ['q7#Lm2!vZp9$', 'ok'],
    ['pendek123', 'too_short'],
    ['a'.repeat(129), 'too_long'],
    ['aaaaaaaaaaaa', 'repetitive'],
    ['abababababab', 'repetitive'],
    ['abcdefghijkl', 'repetitive'],
    ['9876543210', 'repetitive'],
    ['password123', 'common'],
    ['PASSWORD123', 'common'],
    ['1234567890', 'common'],
    ['qwertyuiop', 'common'],
    ['p@ssw0rd123', 'common'],
    ['Password2024!', 'common'],
    ['bismillah123', 'common'],
    ['Indonesia2024', 'common'],
    ['qwertyqwerty', 'common'],
    ['rahasiarahasia', 'common'],
    ['budisantoso2024', 'personal'],
    ['Santoso-keren-sekali', 'personal'],
    ['majujaya-nomor-satu', 'personal'],
    ['saya-suka-balesin-99', 'personal'],
    ['b4l3s1n-juara-dunia', 'personal'],
  ])('%s → %s', (password, expected) => {
    expect(reasonOf(password)).toBe(expected);
  });

  it('pesan penolakan berbahasa Indonesia, menyarankan solusi, dan tidak mengulang passwordnya', () => {
    for (const password of ['pendek123', 'password123', 'aaaaaaaaaaaa', 'budisantoso2024']) {
      const verdict = checkPassword(password, context);
      if (verdict.acceptable) throw new Error('seharusnya ditolak');
      expect(verdict.message).not.toContain(password);
      expect(verdict.message).not.toMatch(/\bAnda\b/i);
      expect(verdict.message.endsWith('.')).toBe(true);
    }
  });

  it('tanpa konteks tetap menilai panjang dan keumuman', () => {
    expect(checkPassword('kopi-tubruk-gerimis-senja')).toEqual({ acceptable: true });
    expect(checkPassword('password123').acceptable).toBe(false);
  });

  it('batas panjang dihitung per karakter, bukan per byte', () => {
    // 10 karakter non-ASCII beragam = sah walau >10 byte.
    expect(reasonOf('ñandú-çöğüş')).toBe('ok');
    expect(reasonOf('🔐🔑🗝️🛡️')).toBe('too_short');
  });
});

describe('hash password (argon2id)', () => {
  const hasher = createPasswordHasher();

  it('menghasilkan hash argon2id dengan parameter yang ditetapkan, berbeda tiap kali', async () => {
    const first = await hasher.hash('kopi-tubruk-gerimis-senja');
    const second = await hasher.hash('kopi-tubruk-gerimis-senja');

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('kopi-tubruk');
    expect(hasher.needsRehash(first)).toBe(false);
  });

  it('verifikasi benar/salah; hash rusak dianggap salah, tidak melempar', async () => {
    const stored = await hasher.hash('kopi-tubruk-gerimis-senja');

    expect(await hasher.verify(stored, 'kopi-tubruk-gerimis-senja')).toBe(true);
    expect(await hasher.verify(stored, 'kopi-tubruk-gerimis-senjA')).toBe(false);
    expect(await hasher.verify(stored, '')).toBe(false);
    expect(await hasher.verify('$argon2id$tes-bukan-hash-sungguhan', 'apa-saja')).toBe(false);
    expect(await hasher.verify('', 'apa-saja')).toBe(false);
    expect(await hasher.verify('teks-polos', 'teks-polos')).toBe(false);
  });

  it('hash berparameter lama atau algoritma lain ditandai perlu diperbarui', async () => {
    const weak = await hash('kopi-tubruk-gerimis-senja', {
      algorithm: 2,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    const argon2i = await hash('kopi-tubruk-gerimis-senja', { algorithm: 1 });

    expect(hasher.needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(argon2i)).toBe(true);
    expect(await hasher.verify(weak, 'kopi-tubruk-gerimis-senja')).toBe(true);
  });

  it('verifyDummy menghabiskan waktu setara verifikasi sungguhan dan tidak pernah melempar', async () => {
    const stored = await hasher.hash('kopi-tubruk-gerimis-senja');
    await hasher.verifyDummy('pemanasan');
    const time = async (work: () => Promise<unknown>) => {
      const started = performance.now();
      for (let round = 0; round < 5; round += 1) await work();
      return performance.now() - started;
    };

    const real = await time(() => hasher.verify(stored, 'password-yang-salah'));
    const dummy = await time(() => hasher.verifyDummy('password-yang-salah'));

    // Bukan pengukuran presisi — cukup memastikan jalur "email tidak terdaftar" memang
    // menjalankan argon2, bukan langsung kembali.
    expect(dummy).toBeGreaterThan(real * 0.3);
    expect(dummy).toBeLessThan(real * 3 + 50);
  });

  it('jumlah hash bersamaan dibatasi; antrean yang penuh ditolak 503', async () => {
    const limited = createPasswordHasher({ concurrency: 1, maxQueue: 2 });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_unused, index) => limited.hash(`password-ke-${index}-panjang`)),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(AppError);
      expect(result.reason).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    // Setelah antrean kosong, hasher kembali normal.
    await expect(limited.hash('password-setelah-antre')).resolves.toMatch(/^\$argon2id\$/);
  });
});

describe('token CSRF terikat sesi', () => {
  const csrf = createCsrfProtection(new Secret('rahasia-sesi-uji-minimal-32-karakter!'));
  const sessionA = sha256Hex('token-sesi-a');
  const sessionB = sha256Hex('token-sesi-b');

  it('token tetap untuk sesi yang sama dan berbeda untuk sesi lain', () => {
    expect(csrf.tokenFor(sessionA)).toBe(csrf.tokenFor(sessionA));
    expect(csrf.tokenFor(sessionA)).not.toBe(csrf.tokenFor(sessionB));
    expect(csrf.tokenFor(sessionA)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf.tokenFor(sessionA)).not.toContain(sessionA);
  });

  it('hanya token milik sesi itu yang lolos', () => {
    const token = csrf.tokenFor(sessionA);

    expect(csrf.verify(sessionA, token)).toBe(true);
    expect(csrf.verify(sessionB, token)).toBe(false);
    expect(csrf.verify(sessionA, `${token}x`)).toBe(false);
    expect(csrf.verify(sessionA, token.slice(0, -1))).toBe(false);
    for (const presented of [undefined, null, '', 42, [token], { token }, 'x'.repeat(10_000)]) {
      expect(csrf.verify(sessionA, presented)).toBe(false);
    }
  });

  it('SESSION_SECRET lain menghasilkan token lain (token lama tidak berlaku)', () => {
    const other = createCsrfProtection(new Secret('rahasia-sesi-lain-minimal-32-karakter'));

    expect(other.tokenFor(sessionA)).not.toBe(csrf.tokenFor(sessionA));
    expect(other.verify(sessionA, csrf.tokenFor(sessionA))).toBe(false);
  });
});

describe('pemeriksaan logo', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

  it('mengenali PNG, JPEG, dan WebP dari byte pembukanya', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('menolak SVG, HTML, GIF, berkas kosong, dan RIFF yang bukan WebP', () => {
    for (const data of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('<?xml version="1.0"?><svg/>'),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('GIF89a'),
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]),
      Buffer.alloc(0),
      Buffer.from([0x89, 0x50]),
    ]) {
      expect(sniffImageType(data)).toBeUndefined();
    }
  });

  it('validateLogoUpload: tipe dari isi, harus cocok dengan pengakuan klien', () => {
    const valid = validateLogoUpload(
      { contentType: 'image/png', dataBase64: png.toString('base64') },
      'branding.logo',
    );
    expect(valid.contentType).toBe('image/png');
    expect(valid.data.equals(png)).toBe(true);
    expect(valid.sha256).toBe(sha256Hex(png));

    const mismatch = () =>
      validateLogoUpload(
        { contentType: 'image/jpeg', dataBase64: png.toString('base64') },
        'branding.logo',
      );
    expect(mismatch).toThrow(AppError);
    try {
      mismatch();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ location: 'body', field: 'branding.logo' }],
      });
    }
  });
});

describe('penyamaran email di audit log', () => {
  it('menyisakan huruf pertama dan domain', () => {
    expect(maskEmail('budi.santoso@contoh.co.id')).toBe('b***@contoh.co.id');
    expect(maskEmail('a@b.c')).toBe('a***@b.c');
    expect(maskEmail('tanpa-at')).toBe('***');
    expect(maskEmail('@domain.test')).toBe('***');
  });
});
