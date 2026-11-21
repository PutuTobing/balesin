import { createLogCapture } from '@balesin/core/testing';
import { describe, expect, it } from 'vitest';

import { createForwardedForGuard, isPrivateAddress } from './forwarded-for-guard';

const FORWARDED = '203.0.113.50, 198.51.100.7';

function request(remoteAddress: string | undefined, forwardedFor?: string) {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  };
}

function guardWith(options: { isProduction: boolean; trustProxy: boolean | string[] }) {
  const logs = createLogCapture();
  const guard = createForwardedForGuard({
    ...options,
    logger: logs.logger,
  });
  return { guard, logs };
}

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.2', true],
    ['172.20.1.1', true],
    ['192.168.1.10', true],
    ['127.0.0.1', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1%eth0', true],
    ['::ffff:10.0.0.2', true],
    ['173.252.127.1', false],
    ['2a03:2880::1', false],
    ['::ffff:173.252.127.1', false],
    ['bukan-ip', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('createForwardedForGuard (review webhook S3)', () => {
  it('production + TRUST_PROXY=false + alamat privat + X-Forwarded-For → log error SEKALI tanpa isi header', () => {
    const { guard, logs } = guardWith({ isProduction: true, trustProxy: false });
    expect(guard).not.toBeNull();
    guard?.(request('10.0.0.2', FORWARDED));
    guard?.(request('10.0.0.2', FORWARDED));
    guard?.(request('192.168.1.1', FORWARDED));
    const text = logs.text();
    expect(text.match(/TRUST_PROXY=false/g)).toHaveLength(1);
    expect(text).toContain('10.0.0.2');
    expect(text).not.toContain('203.0.113.50');
    expect(text).not.toContain('198.51.100.7');
  });

  it('tanpa X-Forwarded-For, atau dari alamat publik → tidak ada log', () => {
    const { guard, logs } = guardWith({ isProduction: true, trustProxy: false });
    guard?.(request('10.0.0.2'));
    guard?.(request('173.252.127.1', FORWARDED));
    guard?.(request(undefined, FORWARDED));
    expect(logs.text()).not.toContain('TRUST_PROXY');
  });

  it('bukan production, atau TRUST_PROXY sudah diisi → tidak dipasang', () => {
    expect(guardWith({ isProduction: false, trustProxy: false }).guard).toBeNull();
    expect(guardWith({ isProduction: true, trustProxy: ['10.0.0.2'] }).guard).toBeNull();
  });
});
