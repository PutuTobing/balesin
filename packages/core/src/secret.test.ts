import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { REDACTED, Secret } from './secret';

describe('Secret', () => {
  const secret = new Secret('token-rahasia-123');

  it('reveal() mengembalikan nilai asli', () => {
    expect(secret.reveal()).toBe('token-rahasia-123');
  });

  it('semua jalur tidak sengaja menghasilkan penanda, bukan nilai asli', () => {
    expect(String(secret)).toBe(REDACTED);
    expect(`${secret.toString()}`).toBe(REDACTED);
    expect([secret].join(',')).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect({ nested: { secret } }, { depth: 5 })).not.toContain('token-rahasia-123');
    expect(inspect(secret)).toBe(REDACTED);
  });

  it('nilai asli tidak terlihat lewat Object.keys, spread, atau JSON', () => {
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify({ ...secret })).toBe('{}');
    expect(JSON.stringify([secret])).not.toContain('token-rahasia-123');
  });

  it('membungkus nilai non-string (mis. objek) tanpa membocorkannya', () => {
    const wrapped = new Secret({ password: 'p4ss' });
    expect(wrapped.reveal().password).toBe('p4ss');
    expect(JSON.stringify(wrapped)).not.toContain('p4ss');
  });
});
