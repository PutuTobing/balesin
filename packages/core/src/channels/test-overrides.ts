import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { cleanEnvSource, isProductionLike, type EnvSource } from '../env';

/**
 * Pengganti KHUSUS non-produksi untuk channel Telegram & Email (stack E2E, `e2e/stack/`): server Bot
 * API Telegram tiruan dan server IMAP tiruan ber-TLS sertifikat tes, di mesin ini saja.
 *
 *  - `BALESIN_TEST_TELEGRAM_BASE_URL` — alamat server Bot API tiruan (`http://127.0.0.1:<port>`).
 *  - `BALESIN_TEST_IMAP_PORTS` — port IMAP TAMBAHAN yang boleh dituju (mis. `46993`), dipisah koma.
 *  - `BALESIN_TEST_IMAP_CA_FILE` — berkas PEM CA tambahan untuk sertifikat IMAP tiruan.
 *
 * Di lingkungan seperti produksi (NODE_ENV bukan `development`/`test`) variabel ini DITOLAK (proses
 * gagal start) — tidak pernah diam-diam dipakai. Alamat Telegram hanya boleh loopback.
 */

export interface ChannelTestOverrides {
  telegramBaseUrl?: string;
  imap?: { allowedPorts?: readonly number[]; testCa?: string };
}

export const CHANNEL_TEST_OVERRIDE_VARIABLES = [
  'BALESIN_TEST_TELEGRAM_BASE_URL',
  'BALESIN_TEST_IMAP_PORTS',
  'BALESIN_TEST_IMAP_CA_FILE',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class ChannelTestOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelTestOverrideError';
  }
}

export function channelTestOverridesFromEnv(
  source: EnvSource,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ChannelTestOverrides {
  const env = cleanEnvSource(source);
  const present = CHANNEL_TEST_OVERRIDE_VARIABLES.filter((name) => env[name] !== undefined);
  if (present.length === 0) return {};
  if (isProductionLike(source)) {
    throw new ChannelTestOverrideError(
      `${present.join(', ')} hanya untuk pengembangan/tes dan tidak boleh diisi di produksi.`,
    );
  }
  const overrides: ChannelTestOverrides = {};

  const telegram = env.BALESIN_TEST_TELEGRAM_BASE_URL;
  if (telegram !== undefined) {
    let url: URL;
    try {
      url = new URL(telegram);
    } catch {
      throw new ChannelTestOverrideError('BALESIN_TEST_TELEGRAM_BASE_URL bukan URL yang sah.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !(LOOPBACK_HOSTS.has(host) || (isIP(host) !== 0 && host.startsWith('127.')))
    ) {
      throw new ChannelTestOverrideError(
        'BALESIN_TEST_TELEGRAM_BASE_URL harus server tiruan di mesin ini (http://127.0.0.1:<port>).',
      );
    }
    overrides.telegramBaseUrl = url.origin;
  }

  const ports = env.BALESIN_TEST_IMAP_PORTS;
  const caFile = env.BALESIN_TEST_IMAP_CA_FILE;
  if (ports !== undefined || caFile !== undefined) {
    const imap: { allowedPorts?: number[]; testCa?: string } = {};
    if (ports !== undefined) {
      const parsed = ports.split(',').map((part) => Number(part.trim()));
      if (parsed.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)) {
        throw new ChannelTestOverrideError(
          'BALESIN_TEST_IMAP_PORTS harus daftar port 1024–65535 dipisah koma.',
        );
      }
      imap.allowedPorts = parsed;
    }
    if (caFile !== undefined) {
      let pem: string;
      try {
        pem = readFile(caFile);
      } catch {
        throw new ChannelTestOverrideError('BALESIN_TEST_IMAP_CA_FILE tidak bisa dibaca.');
      }
      if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
        throw new ChannelTestOverrideError('BALESIN_TEST_IMAP_CA_FILE bukan sertifikat PEM.');
      }
      imap.testCa = pem;
    }
    overrides.imap = imap;
  }
  return overrides;
}
