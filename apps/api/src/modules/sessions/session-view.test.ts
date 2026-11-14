import { describe, expect, it } from 'vitest';

import { maskIpAddress, toActiveSession } from './session-view';

describe('maskIpAddress', () => {
  it.each([
    ['203.0.113.45', '203.0.113.*'],
    ['203.0.113.45/32', '203.0.113.*'],
    ['::ffff:198.51.100.7', '198.51.100.*'],
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3:*'],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8:0:*'],
    ['::1', '0:0:0:*'],
    ['bukan-ip', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(maskIpAddress(input)).toBe(expected);
  });
});

describe('toActiveSession', () => {
  it('meringkas perangkat, menandai sesi ini, dan tidak membawa data lain', () => {
    const session = toActiveSession(
      {
        id: '01a1d8ac-69cc-7042-9f9d-2c9d642d2ae5',
        userId: '01a1d8ac-69cc-7042-9f9d-2c9d642d2ae6',
        kind: 'two_factor_enrollment',
        ipAddress: '198.51.100.9',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/605.1',
        createdAt: new Date('2026-11-14T01:00:00Z'),
        lastSeenAt: new Date('2026-11-14T02:00:00Z'),
      },
      '01a1d8ac-69cc-7042-9f9d-2c9d642d2ae5',
    );
    expect(session).toEqual({
      id: '01a1d8ac-69cc-7042-9f9d-2c9d642d2ae5',
      device: 'Safari di iPhone',
      ipAddress: '198.51.100.*',
      createdAt: '2026-11-14T01:00:00.000Z',
      lastSeenAt: '2026-11-14T02:00:00.000Z',
      current: true,
      limited: true,
    });
  });
});
