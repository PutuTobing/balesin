import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { cleanEnvSource, isProductionLike, type EnvSource } from '../env';

/**
 * Pengganti KHUSUS non-produksi untuk channel Telegram & Email (stack E2E, `e2e/stack/`): server Bot
 * API Telegram tiruan dan server IMAP tiruan ber-TLS sertifikat tes, di mesin ini saja.
 *
 *  - `BALESIN_TEST_TELEGRAM_BASE_URL` — alamat server Bot API tiruan (`http://127.0.0.1:<port>`).
 *  - `BALESIN_TEST_IMAP_PORTS` — port IMAP TAMBAHAN yang boleh dituju (mis. `46993`), dipisah koma.
 *  - `BALESIN_TEST_IMAP_CA_FILE` — berkas PEM CA tambahan untuk sertifikat IMAP tiruan (juga dipakai
 *    SMTP tiruan modul Email: sertifikat tes yang sama).
 *  - `BALESIN_TEST_MAIL_SMTP_PORTS` — port SMTP TAMBAHAN modul Email (Fase 9) yang boleh dituju server
 *    SMTP tiruan ber-TLS di loopback (mis. `46465`), dipisah koma. Hanya modul Email; Email pengirim
 *    sistem & Channel Email tetap memakai daftar port bawaan.
 *
 * Di lingkungan seperti produksi (NODE_ENV bukan `development`/`test`) variabel ini DITOLAK (proses
 * gagal start) — tidak pernah diam-diam dipakai. Alamat Telegram hanya boleh loopback.
 */

export interface ChannelTestOverrides {
  telegramBaseUrl?: string;
  imap?: { allowedPorts?: readonly number[]; testCa?: string };
  /** SMTP tiruan modul Email (Fase 9). */
  mailSmtp?: { allowedPorts: readonly number[] };
}

export const CHANNEL_TEST_OVERRIDE_VARIABLES = [
  'BALESIN_TEST_TELEGRAM_BASE_URL',
  'BALESIN_TEST_IMAP_PORTS',
  'BALESIN_TEST_IMAP_CA_FILE',
  'BALESIN_TEST_MAIL_SMTP_PORTS',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class ChannelTestOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelTestOverrideError';
  }
}

function parsePorts(name: string, value: string): number[] {
  const parsed = value.split(',').map((part) => Number(part.trim()));
  if (parsed.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)) {
    throw new ChannelTestOverrideError(`${name} harus daftar port 1024–65535 dipisah koma.`);
  }
  return parsed;
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
    if (ports !== undefined) imap.allowedPorts = parsePorts('BALESIN_TEST_IMAP_PORTS', ports);
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

  const mailSmtpPorts = env.BALESIN_TEST_MAIL_SMTP_PORTS;
  if (mailSmtpPorts !== undefined) {
    overrides.mailSmtp = {
      allowedPorts: parsePorts('BALESIN_TEST_MAIL_SMTP_PORTS', mailSmtpPorts),
    };
  }
  return overrides;
}
