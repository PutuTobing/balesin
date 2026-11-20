import { describe, expect, it } from 'vitest';

import { emailSenderTrustedForBot, storedEmailSenderVerification } from './inbox';

describe('penafsiran verifikasi pengirim email tersimpan (review bot P4-I2)', () => {
  it('nilai dikenal apa adanya', () => {
    for (const value of ['pass', 'fail', 'unverified'] as const) {
      expect(storedEmailSenderVerification({ senderVerification: value })).toBe(value);
      expect(storedEmailSenderVerification({ senderVerification: value, authWarning: true })).toBe(
        value,
      );
    }
  });

  it('data lama tanpa hasil: fail bila diperingatkan, selain itu unverified (tidak pernah pass)', () => {
    expect(storedEmailSenderVerification({ authWarning: true })).toBe('fail');
    expect(storedEmailSenderVerification({ senderVerification: null, authWarning: true })).toBe(
      'fail',
    );
    expect(storedEmailSenderVerification({})).toBe('unverified');
    expect(storedEmailSenderVerification({ authWarning: 'true' })).toBe('unverified');
  });

  it('nilai asing = fail', () => {
    for (const value of ['PASS', 'lolos', '', 1, true, {}, ['pass']]) {
      expect(
        storedEmailSenderVerification({ senderVerification: value }),
        JSON.stringify(value),
      ).toBe('fail');
    }
  });

  it('boleh dilayani bot: pass selalu, fail tidak pernah, unverified tergantung pengaturan', () => {
    expect(emailSenderTrustedForBot('pass', true)).toBe(true);
    expect(emailSenderTrustedForBot('pass', false)).toBe(true);
    expect(emailSenderTrustedForBot('fail', false)).toBe(false);
    expect(emailSenderTrustedForBot('fail', true)).toBe(false);
    expect(emailSenderTrustedForBot('unverified', false)).toBe(true);
    expect(emailSenderTrustedForBot('unverified', true)).toBe(false);
  });
});
