import { describe, expect, it } from 'vitest';

import { ChannelTestOverrideError, channelTestOverridesFromEnv } from './test-overrides';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const read = (path: string) => {
  if (path === '/tmp/ca.pem') return PEM;
  throw new Error('tidak ada');
};

describe('channelTestOverridesFromEnv', () => {
  it('kosong → tanpa pengganti (juga di produksi)', () => {
    expect(channelTestOverridesFromEnv({ NODE_ENV: 'production' })).toEqual({});
    expect(channelTestOverridesFromEnv({ NODE_ENV: 'test', BALESIN_TEST_IMAP_PORTS: ' ' })).toEqual(
      {},
    );
  });

  it('non-produksi: Telegram loopback, port IMAP tambahan, CA dari berkas', () => {
    expect(
      channelTestOverridesFromEnv(
        {
          NODE_ENV: 'test',
          BALESIN_TEST_TELEGRAM_BASE_URL: 'http://127.0.0.1:45000/',
          BALESIN_TEST_IMAP_PORTS: '46993, 46143',
          BALESIN_TEST_IMAP_CA_FILE: '/tmp/ca.pem',
          BALESIN_TEST_MAIL_SMTP_PORTS: '46465',
        },
        read,
      ),
    ).toEqual({
      telegramBaseUrl: 'http://127.0.0.1:45000',
      imap: { allowedPorts: [46993, 46143], testCa: PEM },
      mailSmtp: { allowedPorts: [46465] },
    });
  });

  it('ditolak: produksi, Telegram bukan loopback, port/CA tidak sah', () => {
    const bad = (env: Record<string, string>) => () =>
      channelTestOverridesFromEnv({ NODE_ENV: 'development', ...env }, read);
    expect(() =>
      channelTestOverridesFromEnv({
        NODE_ENV: 'production',
        BALESIN_TEST_TELEGRAM_BASE_URL: 'http://127.0.0.1:1',
      }),
    ).toThrow(ChannelTestOverrideError);
    expect(() => channelTestOverridesFromEnv({ BALESIN_TEST_IMAP_PORTS: '46993' })).toThrow(
      /produksi/,
    );
    expect(bad({ BALESIN_TEST_TELEGRAM_BASE_URL: 'https://api.telegram.org' })).toThrow(
      /mesin ini/,
    );
    expect(bad({ BALESIN_TEST_TELEGRAM_BASE_URL: 'bukan url' })).toThrow(/URL/);
    expect(bad({ BALESIN_TEST_IMAP_PORTS: '993' })).toThrow(/1024/);
    expect(bad({ BALESIN_TEST_MAIL_SMTP_PORTS: '465' })).toThrow(/1024/);
    expect(() =>
      channelTestOverridesFromEnv({
        NODE_ENV: 'production',
        BALESIN_TEST_MAIL_SMTP_PORTS: '46465',
      }),
    ).toThrow(/produksi/);
    expect(bad({ BALESIN_TEST_IMAP_CA_FILE: '/tidak/ada.pem' })).toThrow(/dibaca/);
  });
});
