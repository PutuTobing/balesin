#!/usr/bin/env node
// Aturan keras CLAUDE.md: hanya WhatsApp Cloud API resmi Meta.
// ESLint memblokir impor statis; skrip ini menggagalkan CI bila library tidak resmi
// masuk lewat jalur lain (import() dinamis, dependensi transitif, package.json saja).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORBIDDEN = [
  /baileys/i,
  /^whatsapp-web\.js$/i,
  /wppconnect/i,
  /^venom(-bot)?$/i,
  /open-wa/i,
  /^wa-automate/i,
  /^wa-multi-session$/i,
];

/** Nama paket dari kunci lockfile pnpm, mis. "@scope/nama@1.2.3(peer@1)" → "@scope/nama". */
function packageName(key) {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}

const lockfile = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const names = new Set();
let inPackages = false;
for (const line of lockfile.split(/\r?\n/)) {
  if (/^\S/.test(line)) inPackages = line === 'packages:' || line === 'snapshots:';
  if (!inPackages) continue;
  const match = /^ {2}'?([^\s':][^':]*)'?:\s*$/.exec(line);
  if (match?.[1]) names.add(packageName(match[1]));
}

if (names.size === 0) {
  process.stderr.write('Tidak ada paket terbaca dari pnpm-lock.yaml; format lockfile berubah?\n');
  process.exit(1);
}

const found = [...names].filter((name) => {
  const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return FORBIDDEN.some((pattern) => pattern.test(name) || pattern.test(bare));
});

if (found.length > 0) {
  process.stderr.write(
    `Library WhatsApp tidak resmi ditemukan di pnpm-lock.yaml: ${found.join(', ')}\n` +
      'Hanya WhatsApp Cloud API resmi Meta yang boleh dipakai (CLAUDE.md).\n',
  );
  process.exit(1);
}

process.stdout.write(`Dependensi bersih: ${names.size} paket diperiksa.\n`);
