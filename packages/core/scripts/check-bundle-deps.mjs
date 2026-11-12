#!/usr/bin/env node
// Dijalankan setelah `tsup` di apps/api dan apps/worker (lihat skrip `build`).
//
// Bundle produksi memuat kode paket internal `@balesin/*`, tetapi paket pihak ketiga tetap
// diambil dari `node_modules` aplikasi saat jalan. Kalau paket internal memakai paket pihak
// ketiga yang TIDAK terdaftar di `dependencies` aplikasi, dev (tsx) tetap jalan tetapi image
// produksi gagal start ("Cannot find package"). Skrip ini menangkapnya saat build.
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const appDir = process.cwd();
const metafilePath = path.join(appDir, 'dist', 'metafile-esm.json');

/** `@scope/nama/sub/path` → `@scope/nama`; `nama/sub` → `nama` */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const manifest = readJson(path.join(appDir, 'package.json'));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));
const builtins = new Set(builtinModules);

let metafile;
try {
  metafile = readJson(metafilePath);
} catch {
  console.error(`Tidak menemukan ${metafilePath}. Jalankan tsup dengan \`metafile: true\`.`);
  process.exit(1);
}

const missing = new Set();
const bundledThirdParty = new Set();

for (const output of Object.values(metafile.outputs)) {
  for (const imported of output.imports ?? []) {
    if (!imported.external) continue;
    const specifier = imported.path;
    if (specifier.startsWith('node:') || specifier.startsWith('.') || path.isAbsolute(specifier)) {
      continue;
    }
    const name = packageNameOf(specifier);
    if (builtins.has(name) || declared.has(name)) continue;
    missing.add(name);
  }
  for (const input of Object.keys(output.inputs ?? {})) {
    // Paket workspace di-symlink, jadi sumbernya tampil sebagai packages/…, bukan node_modules.
    if (input.split('/').includes('node_modules')) bundledThirdParty.add(input);
  }
}

if (bundledThirdParty.size > 0) {
  console.error('Paket pihak ketiga ikut ter-bundle (seharusnya tetap eksternal):');
  for (const input of [...bundledThirdParty].sort()) console.error(`  - ${input}`);
  process.exit(1);
}

if (missing.size > 0) {
  console.error(
    `Bundle ${manifest.name} memakai paket yang belum ada di "dependencies" package.json-nya:`,
  );
  for (const name of [...missing].sort()) console.error(`  - ${name}`);
  console.error(
    'Tambahkan dengan `pnpm add --filter ' +
      manifest.name +
      ' <paket>@<versi>` ' +
      '(pakai versi yang sama dengan paket @balesin/* yang memakainya).',
  );
  process.exit(1);
}

console.log(`Dependensi bundle ${manifest.name} lengkap.`);
