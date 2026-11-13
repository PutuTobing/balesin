import type * as argon2 from '@node-rs/argon2';
import { hash } from '@node-rs/argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPasswordHasher } from './password-hasher';

// `hash` dibungkus mata-mata supaya bisa dihitung, tanpa mengubah perilakunya.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof argon2>();
  return { ...actual, hash: vi.fn(actual.hash) };
});

describe('hash pembanding untuk email tidak terdaftar', () => {
  beforeEach(() => {
    vi.mocked(hash).mockClear();
  });

  it('warmUp membuatnya sekali; verifyDummy sesudahnya tidak membuat hash baru', async () => {
    const hasher = createPasswordHasher();

    await hasher.warmUp();
    await hasher.warmUp();
    expect(hash).toHaveBeenCalledTimes(1);

    vi.mocked(hash).mockClear();
    await hasher.verifyDummy('password-yang-salah');
    await hasher.verifyDummy('password-lain-yang-salah');
    // Panggilan pertama sama lamanya dengan verifikasi akun sungguhan (hanya `verify`).
    expect(hash).not.toHaveBeenCalled();
  });

  it('tanpa warmUp, panggilan pertama yang membuatnya (dan hanya sekali)', async () => {
    const hasher = createPasswordHasher();

    await Promise.all([hasher.verifyDummy('a-1234567890'), hasher.verifyDummy('b-1234567890')]);

    expect(hash).toHaveBeenCalledTimes(1);
  });
});
