#!/usr/bin/env node
// Hook PostToolUse (Edit/Write): format berkas yang baru diedit dengan Prettier,
// lalu typecheck paket pemiliknya. Error tipe dikembalikan ke Claude (exit 2)
// supaya langsung diperbaiki, bukan menumpuk sampai akhir tugas.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FORMATTABLE = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);
const TYPECHECKED = new Set(['.ts', '.tsx']);
const MAX_ERROR_LINES = 40;

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function bin(...segments) {
  return path.join(ROOT, 'node_modules', ...segments);
}

/**
 * tsconfig.json terdekat di atas berkas, berhenti di root repo.
 * Perbandingan lewat path.relative karena huruf drive Windows bisa beda kapital (c:\ vs C:\).
 */
function findProjectDir(file) {
  let dir = path.dirname(file);
  for (;;) {
    const rel = path.relative(ROOT, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const payload = readPayload();
const rawPath = payload?.tool_input?.file_path;
if (typeof rawPath !== 'string' || rawPath === '') process.exit(0);

const file = path.resolve(ROOT, rawPath);
const relative = path.relative(ROOT, file);
const outsideRepo = relative.startsWith('..') || path.isAbsolute(relative);
if (outsideRepo || relative.split(path.sep).includes('node_modules') || !existsSync(file)) {
  process.exit(0);
}

const ext = path.extname(file).toLowerCase();

// 1) Format. Prettier menghormati .prettierignore; kegagalan format tidak memblokir.
const prettier = bin('prettier', 'bin', 'prettier.cjs');
if (FORMATTABLE.has(ext) && existsSync(prettier)) {
  spawnSync(process.execPath, [prettier, '--write', '--ignore-unknown', file], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 20_000,
  });
}

// 2) Typecheck paket pemilik berkas (inkremental supaya cepat).
const tsc = bin('typescript', 'bin', 'tsc');
const projectDir = TYPECHECKED.has(ext) ? findProjectDir(file) : null;
if (projectDir && existsSync(tsc)) {
  const cacheDir = bin('.cache', 'tsc-hook');
  mkdirSync(cacheDir, { recursive: true });
  const cacheName = path.relative(ROOT, projectDir).replaceAll(path.sep, '_');
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      path.join(cacheDir, `${cacheName}.tsbuildinfo`),
      '--pretty',
      'false',
      '-p',
      projectDir,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 90_000 },
  );

  if (result.status !== 0 && result.status !== null) {
    const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/);
    const shown = lines.slice(0, MAX_ERROR_LINES).join('\n');
    const more =
      lines.length > MAX_ERROR_LINES ? `\n… ${lines.length - MAX_ERROR_LINES} baris lagi` : '';
    process.stderr.write(
      `Typecheck gagal di ${path.relative(ROOT, projectDir)} setelah mengedit ${relative}:\n${shown}${more}\n`,
    );
    process.exit(2);
  }
}

process.exit(0);
