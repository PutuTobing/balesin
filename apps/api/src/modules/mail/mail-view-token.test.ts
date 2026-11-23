import { describe, expect, it } from 'vitest';

import { createMailViewTokens } from './mail-view-token';

const MESSAGE = '01a20588-a894-765e-8285-91629906521f';
const SESSION = '01a20588-a925-70ee-af10-be1703269998';

describe('token dokumen tampilan email', () => {
  const tokens = createMailViewTokens('kunci-rahasia-uji-yang-cukup-panjang');
  const now = new Date('2026-11-23T10:00:00Z');

  it('72 karakter base64url, isi kembali utuh, tanpa data pribadi di URL', () => {
    const { token, expiresAt } = tokens.issue(
      { messageId: MESSAGE, sessionRef: SESSION, images: true },
      now,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{72}$/);
    expect(expiresAt.toISOString()).toBe('2026-11-23T10:10:00.000Z');
    expect(tokens.verify(token, now)).toEqual({
      messageId: MESSAGE,
      sessionRef: SESSION,
      images: true,
      expiresAt,
    });
  });

  it('kedaluwarsa, diubah satu karakter, kunci lain, atau rusak → null', () => {
    const { token } = tokens.issue({ messageId: MESSAGE, sessionRef: SESSION, images: false }, now);
    expect(tokens.verify(token, new Date(now.getTime() + 10 * 60 * 1000))).toBeNull();
    const flipped = `${token.slice(0, 5)}${token[5] === 'A' ? 'B' : 'A'}${token.slice(6)}`;
    expect(tokens.verify(flipped, now)).toBeNull();
    expect(createMailViewTokens('kunci-lain').verify(token, now)).toBeNull();
    expect(tokens.verify('pendek', now)).toBeNull();
    expect(tokens.verify(`${token}A`, now)).toBeNull();
    expect(tokens.verify('x'.repeat(200), now)).toBeNull();
  });
});
