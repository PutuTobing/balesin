import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  createSecretBox,
  deriveKey,
  hmacSha256,
  maskedSecret,
  randomToken,
  SecretDecryptionError,
  secretTail,
  sha256Hex,
} from './crypto';
import { Secret } from './secret';

const ORG_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ORG_B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const SMTP = { organizationId: ORG_A, purpose: 'email_settings.smtp_password' };

function box(key = randomBytes(32)) {
  return createSecretBox(new Secret(key));
}

describe('kotak rahasia AES-256-GCM', () => {
  it('membuka kembali apa yang dienkripsi, termasuk teks kosong dan non-ASCII', () => {
    const secretBox = box();

    for (const plaintext of [
      'app-password-16ch',
      '',
      'sandi dengan spasi & émoji 🔐',
      'x'.repeat(5_000),
    ]) {
      expect(secretBox.decrypt(secretBox.encrypt(plaintext, SMTP), SMTP)).toBe(plaintext);
    }
  });

  it('format v1.<nonce 96-bit>.<sandi+tag>, nonce acak — hasil selalu berbeda', () => {
    const secretBox = box();

    const first = secretBox.encrypt('rahasia-yang-sama', SMTP);
    const second = secretBox.encrypt('rahasia-yang-sama', SMTP);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('rahasia-yang-sama');
    expect(Buffer.from(first.split('.')[1] ?? '', 'base64url')).toHaveLength(12);
    // sandi = panjang teks + tag 16 byte
    expect(Buffer.from(first.split('.')[2] ?? '', 'base64url')).toHaveLength(17 + 16);
  });

  it('konteks ikut dikunci: organisasi lain atau kolom lain tidak bisa membuka', () => {
    const secretBox = box();
    const sealed = secretBox.encrypt('rahasia', SMTP);

    expect(() => secretBox.decrypt(sealed, { ...SMTP, organizationId: ORG_B })).toThrow(
      SecretDecryptionError,
    );
    expect(() =>
      secretBox.decrypt(sealed, { ...SMTP, purpose: 'channels.meta_access_token' }),
    ).toThrow(SecretDecryptionError);
  });

  it('subjectId ikut dikunci: rahasia milik satu baris tidak bisa dibuka untuk baris lain', () => {
    const secretBox = box();
    const totp = { organizationId: ORG_A, purpose: 'users.totp_secret' };
    const sealed = secretBox.encrypt('JBSWY3DPEHPK3PXP', { ...totp, subjectId: 'pengguna-a' });

    expect(secretBox.decrypt(sealed, { ...totp, subjectId: 'pengguna-a' })).toBe(
      'JBSWY3DPEHPK3PXP',
    );
    expect(() => secretBox.decrypt(sealed, { ...totp, subjectId: 'pengguna-b' })).toThrow(
      SecretDecryptionError,
    );
    expect(() => secretBox.decrypt(sealed, totp)).toThrow(SecretDecryptionError);
    // Tanpa subjectId, data lama (format sebelum subjectId ada) tetap terbuka seperti biasa.
    expect(() =>
      secretBox.decrypt(secretBox.encrypt('x', SMTP), { ...SMTP, subjectId: 'apa-saja' }),
    ).toThrow(SecretDecryptionError);
  });

  it('master key lain tidak bisa membuka', () => {
    const sealed = box().encrypt('rahasia', SMTP);

    expect(() => box().decrypt(sealed, SMTP)).toThrow(SecretDecryptionError);
  });

  it('data yang diubah satu bit saja ditolak (nonce, isi, maupun tag)', () => {
    const secretBox = box();
    const [version, nonce = '', sealed = ''] = secretBox
      .encrypt('rahasia-penting', SMTP)
      .split('.');
    const flip = (text: string, at: number) => {
      const bytes = Buffer.from(text, 'base64url');
      bytes[at] = (bytes[at] ?? 0) ^ 0x01;
      return bytes.toString('base64url');
    };
    const sealedLength = Buffer.from(sealed, 'base64url').length;

    for (const tampered of [
      `${version}.${flip(nonce, 0)}.${sealed}`,
      `${version}.${nonce}.${flip(sealed, 0)}`,
      `${version}.${nonce}.${flip(sealed, sealedLength - 1)}`,
    ]) {
      expect(() => secretBox.decrypt(tampered, SMTP)).toThrow(SecretDecryptionError);
    }
  });

  it('bentuk yang tidak dikenal ditolak tanpa membocorkan penyebabnya', () => {
    const secretBox = box();

    for (const payload of [
      '',
      'teks-polos',
      'v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA',
      'v1.pendek.AAAAAAAAAAAAAAAAAAAAAAAA',
      'v1.AAAAAAAAAAAAAAAA.pendek',
      'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA.lebih',
    ]) {
      const error = (() => {
        try {
          secretBox.decrypt(payload, SMTP);
        } catch (caught) {
          return caught as Error;
        }
        return undefined;
      })();
      expect(error, payload).toBeInstanceOf(SecretDecryptionError);
      expect(error?.message).not.toContain(payload || 'tidak-ada');
    }
  });

  it('menolak master key yang bukan 32 byte, dan tidak membocorkannya saat diperiksa', () => {
    expect(() => createSecretBox(new Secret(randomBytes(16)))).toThrow(/32 byte/);

    const key = randomBytes(32);
    const secretBox = box(key);
    expect(inspect(secretBox)).not.toContain(key.toString('hex'));
    expect(JSON.stringify(secretBox)).not.toContain(key.toString('base64'));
  });
});

describe('petunjuk tersamar', () => {
  it('membuka paling banyak 4 karakter terakhir, lebih sedikit untuk rahasia pendek', () => {
    expect(secretTail('abcdefghijkl1234')).toBe('1234');
    expect(secretTail('123456789012')).toBe('9012');
    expect(secretTail('12345678901')).toBe('01');
    expect(secretTail('12345678')).toBe('78');
    expect(secretTail('1234567')).toBeNull();
    expect(secretTail('')).toBeNull();
  });

  it('menampilkan ••••1234', () => {
    expect(maskedSecret('1234')).toBe('••••1234');
    expect(maskedSecret(null)).toBeNull();
  });
});

describe('token, hash, dan perbandingan', () => {
  it('randomToken: 256 bit dalam base64url, selalu berbeda', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));

    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('sha256Hex cocok dengan vektor uji baku', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('constantTimeEqual benar untuk panjang yang sama maupun berbeda', () => {
    expect(constantTimeEqual('token-setup-benar', 'token-setup-benar')).toBe(true);
    expect(constantTimeEqual('token-setup-benar', 'token-setup-benas')).toBe(false);
    expect(constantTimeEqual('token-setup-benar', 'token-setup')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });

  it('deriveKey: 32 byte, tetap untuk masukan sama, berbeda per tujuan', () => {
    const secret = 'rahasia-induk-minimal-32-karakter-xx';

    expect(deriveKey(secret, 'csrf')).toHaveLength(32);
    expect(deriveKey(secret, 'csrf').equals(deriveKey(secret, 'csrf'))).toBe(true);
    expect(deriveKey(secret, 'csrf').equals(deriveKey(secret, 'lainnya'))).toBe(false);
    expect(deriveKey(`${secret}!`, 'csrf').equals(deriveKey(secret, 'csrf'))).toBe(false);
  });

  it('hmacSha256 bergantung pada kunci dan pesan', () => {
    const key = deriveKey('rahasia', 'uji');

    expect(hmacSha256(key, 'pesan')).toBe(hmacSha256(key, 'pesan'));
    expect(hmacSha256(key, 'pesan')).not.toBe(hmacSha256(key, 'pesan!'));
    expect(hmacSha256(deriveKey('rahasia', 'lain'), 'pesan')).not.toBe(hmacSha256(key, 'pesan'));
    expect(hmacSha256(key, 'pesan')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
