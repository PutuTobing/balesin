import { randomBytes } from 'node:crypto';

import { Secret } from '@balesin/core';
import { apiKeyHasScope } from '@balesin/shared';
import { describe, expect, it } from 'vitest';

import {
  apiKeyPepper,
  generateApiKey,
  ipAllowed,
  normalizeIpRule,
  parseApiKey,
  secretMatches,
} from './api-key-token';

const pepper = apiKeyPepper(new Secret(randomBytes(32)));

describe('bentuk & verifikasi API key', () => {
  it('kunci baru bisa diurai dan cocok dengan hash-nya; pepper lain / rahasia lain tidak', () => {
    const key = generateApiKey(pepper);
    const parsed = parseApiKey(key.token);
    expect(parsed?.lookupKey).toBe(key.lookupKey);
    expect(secretMatches(pepper, parsed!, key.secretHash)).toBe(true);
    const otherPepper = apiKeyPepper(new Secret(randomBytes(32)));
    expect(secretMatches(otherPepper, parsed!, key.secretHash)).toBe(false);
    expect(secretMatches(pepper, { ...parsed!, secret: 'x'.repeat(43) }, key.secretHash)).toBe(
      false,
    );
    for (const bad of ['', 'Bearer x', ['blsn', 'live', 'zz', 'a'].join('_'), key.token + 'x']) {
      expect(parseApiKey(bad), bad).toBeNull();
    }
  });

  it('scope bertingkat', () => {
    expect(apiKeyHasScope(['messages:send'], 'messages:read')).toBe(true);
    expect(apiKeyHasScope(['messages:send'], 'conversations:read')).toBe(true);
    expect(apiKeyHasScope(['messages:read'], 'messages:send')).toBe(false);
    expect(apiKeyHasScope(['contacts:write'], 'contacts:read')).toBe(true);
    expect(apiKeyHasScope(['contacts:read'], 'messages:read')).toBe(false);
    expect(apiKeyHasScope(['toString'], 'contacts:read')).toBe(false);
  });
});

describe('daftar IP', () => {
  it('aturan dinormalkan; prefiks di luar rentang ditolak', () => {
    expect(normalizeIpRule(' 10.0.0.0/8 ')).toBe('10.0.0.0/8');
    expect(normalizeIpRule('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(normalizeIpRule('203.0.113.5')).toBe('203.0.113.5');
    for (const bad of [
      '10.0.0.0/33',
      '::/129',
      '999.1.1.1',
      'a.b.c.d',
      '10.0.0.0/8/1',
      '1.2.3.4/x',
    ]) {
      expect(normalizeIpRule(bad), bad).toBeNull();
    }
  });

  it('cocok IPv4/IPv6/CIDR; IPv4-mapped; tanpa aturan = semua; tanpa IP = tolak bila berdaftar', () => {
    const rules = ['10.0.0.0/8', '203.0.113.5', '2001:db8::/32'];
    expect(ipAllowed('10.2.3.4', rules)).toBe(true);
    expect(ipAllowed('::ffff:10.2.3.4', rules)).toBe(true);
    expect(ipAllowed('203.0.113.5', rules)).toBe(true);
    expect(ipAllowed('203.0.113.6', rules)).toBe(false);
    expect(ipAllowed('2001:db8::1', rules)).toBe(true);
    expect(ipAllowed('2001:db9::1', rules)).toBe(false);
    expect(ipAllowed(null, rules)).toBe(false);
    expect(ipAllowed('1.2.3.4', null)).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
  });
});
