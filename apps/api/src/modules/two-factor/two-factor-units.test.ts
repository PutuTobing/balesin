import {
  BACKUP_CODE_ALPHABET,
  BACKUP_CODE_COUNT,
  normalizeTwoFactorCode,
  twoFactorCodeKind,
} from '@balesin/shared';
import { describe, expect, it } from 'vitest';

import { Secret } from '@balesin/core';

import type { PasswordHasher } from '../auth/password-hasher';
import {
  createTrustedDevices,
  deviceIssueTime,
  trustedDeviceThreshold,
} from '../auth/trusted-device';
import { generateBackupCodes, randomBackupCode } from './backup-codes';

/** Hasher palsu yang cepat: tes ini menguji pembuatan kode, bukan argon2. */
const fakeHasher: PasswordHasher = {
  hash: (value) => Promise.resolve(`hash(${value})`),
  verify: (hash, value) => Promise.resolve(hash === `hash(${value})`),
  verifyDummy: () => Promise.resolve(),
  warmUp: () => Promise.resolve(),
  needsRehash: () => false,
};

describe('kode cadangan', () => {
  it('10 kode unik, bentuk xxxxx-xxxxx dari huruf/angka yang tidak mirip', async () => {
    const generated = await generateBackupCodes(fakeHasher);

    expect(generated.display).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(generated.display).size).toBe(BACKUP_CODE_COUNT);
    for (const code of generated.display) {
      expect(code).toMatch(
        /^[23456789abcdefghjkmnpqrstuvwxyz]{5}-[23456789abcdefghjkmnpqrstuvwxyz]{5}$/,
      );
      expect(code).not.toMatch(/[01ilo]/);
      // Bentuk yang diketik pengguna dikenali sebagai kode cadangan.
      expect(twoFactorCodeKind(normalizeTwoFactorCode(code.toUpperCase()))).toBe('backup_code');
    }
  });

  it('yang di-hash adalah bentuk baku (tanpa tanda hubung), urutannya sama dengan tampilan', async () => {
    const generated = await generateBackupCodes(fakeHasher);

    generated.display.forEach((code, index) => {
      expect(generated.hashes[index]).toBe(`hash(${code.replace('-', '')})`);
    });
  });

  it('karakter tersebar di seluruh alfabet (tanpa bias yang mencolok)', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 2_000; index += 1) {
      for (const character of randomBackupCode()) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    expect([...counts.keys()].sort().join('')).toBe([...BACKUP_CODE_ALPHABET].sort().join(''));
    // 20.000 karakter / 31 ≈ 645 per karakter.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(450);
      expect(count).toBeLessThan(850);
    }
  });
});

describe('cookie perangkat dikenal untuk langkah kedua (S1)', () => {
  const enabledAt = new Date('2026-11-14T03:00:00.300Z');

  it('ambang = waktu aktif 2FA dibulatkan ke atas ke detik berikutnya', () => {
    expect(trustedDeviceThreshold(enabledAt)).toBe(Date.parse('2026-11-14T03:00:01.000Z'));
    expect(trustedDeviceThreshold(new Date('2026-11-14T03:00:00.000Z'))).toBe(
      Date.parse('2026-11-14T03:00:00.000Z'),
    );
  });

  it('cookie "hanya password" di detik yang sama dengan aktivasi tidak lolos ambang', () => {
    const devices = createTrustedDevices(new Secret('rahasia-sesi-khusus-tes-minimal-32-karakter'));
    const sameSecond = devices.verify(
      devices.issue('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date('2026-11-14T03:00:00.900Z')),
      new Date('2026-11-14T03:00:02Z'),
    );
    const afterwards = devices.verify(
      devices.issue('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', deviceIssueTime(enabledAt, enabledAt)),
      new Date('2026-11-14T03:00:02Z'),
    );

    expect(sameSecond?.issuedAt.getTime()).toBeLessThan(trustedDeviceThreshold(enabledAt));
    expect(afterwards?.issuedAt.getTime()).toBeGreaterThanOrEqual(
      trustedDeviceThreshold(enabledAt),
    );
    expect(deviceIssueTime(null, enabledAt)).toEqual(enabledAt);
  });
});
