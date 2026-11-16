import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

import type { Secret } from '@balesin/core';
import {
  API_KEY_ID_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
} from '@balesin/shared';

/**
 * Bentuk & verifikasi API key (Fase 3, DECISIONS 2026-11-18).
 *
 * `blsn_live_<id>_<rahasia>`: `id` = 8 byte acak (16 hex) untuk pencarian; rahasia = 32 byte acak
 * (43 base64url, 256 bit). Yang disimpan: HMAC-SHA256(pepper, "<id>.<rahasia>") — BUKAN argon2:
 * rahasianya sudah berentropi penuh (tidak bisa ditebak dengan kamus), jadi peregangan tidak menambah
 * apa pun, sementara verifikasi harus cepat di SETIAP permintaan. Pepper diturunkan dari
 * `BALESIN_MASTER_KEY` (HKDF), jadi bocornya isi database saja tidak cukup untuk memeriksa tebakan.
 */

export interface ParsedApiKey {
  lookupKey: string;
  secret: string;
}

export function apiKeyPepper(masterKey: Secret<Buffer>): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey.reveal(), Buffer.alloc(0), 'balesin/api-key/v1', 32),
  );
}

export function hashApiKeySecret(pepper: Buffer, lookupKey: string, secret: string): string {
  return createHmac('sha256', pepper).update(`${lookupKey}.${secret}`).digest('hex');
}

/** Kunci baru (nilai utuh hanya untuk ditampilkan sekali). */
export function generateApiKey(pepper: Buffer): {
  token: string;
  lookupKey: string;
  secretHash: string;
} {
  const lookupKey = randomBytes(API_KEY_ID_LENGTH / 2).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  if (secret.length !== API_KEY_SECRET_LENGTH)
    throw new Error('Panjang rahasia API key tak terduga');
  return {
    token: `${API_KEY_PREFIX}${lookupKey}_${secret}`,
    lookupKey,
    secretHash: hashApiKeySecret(pepper, lookupKey, secret),
  };
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(token);
  if (!match?.[1] || !match[2]) return null;
  return { lookupKey: match[1], secret: match[2] };
}

/** Perbandingan waktu-konstan hash tersimpan vs hash rahasia yang diberikan. */
export function secretMatches(pepper: Buffer, parsed: ParsedApiKey, storedHash: string): boolean {
  const given = Buffer.from(hashApiKeySecret(pepper, parsed.lookupKey, parsed.secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** Awalan aman untuk ditampilkan (`blsn_live_<id>_…`). */
export function displayPrefix(lookupKey: string): string {
  return `${API_KEY_PREFIX}${lookupKey}_…`;
}

/**
 * IP tunggal / CIDR yang sah dalam bentuk baku, atau `null`. Prefiks di luar rentang (IPv4 > 32,
 * IPv6 > 128) dan alamat tak sah ditolak.
 */
export function normalizeIpRule(value: string): string | null {
  const [address, prefixText, ...rest] = value.trim().split('/');
  if (!address || rest.length > 0) return null;
  const family = isIP(address);
  if (family === 0) return null;
  if (prefixText === undefined) return address.toLowerCase();
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return `${address.toLowerCase()}/${String(prefix)}`;
}

/** `true` bila `ip` termasuk salah satu aturan (`null`/kosong = semua IP boleh). */
export function ipAllowed(ip: string | null, rules: readonly string[] | null): boolean {
  if (!rules || rules.length === 0) return true;
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const rule of rules) {
    const [address, prefix] = rule.split('/');
    if (!address) continue;
    const ruleFamily = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, ruleFamily);
    else list.addSubnet(address, Number(prefix), ruleFamily);
  }
  // IPv4 yang datang sebagai IPv4-mapped IPv6 (`::ffff:1.2.3.4`) dicocokkan sebagai IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return list.check(mapped, 'ipv4');
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}
