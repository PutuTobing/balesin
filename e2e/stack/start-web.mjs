// @ts-check
/**
 * Menyalakan web E2E (Vite dev, proxy `/api` ke API E2E) lalu MEMANASKANNYA sebelum tes mulai
 * (dipanggil `webServer` Playwright, lihat `viewports.ts`). Audit QA akhir D1: pada worktree/checkout
 * CI baru, cache Vite kosong; dokumen pertama menunggu optimasi dependensi + transformasi ratusan
 * modul (pernah 218 dtk di mesin sibuk) sehingga tes pertama (`alur-awal`) habis waktu.
 *
 * Pemanasan = menelusuri graf modul seperti browser: `index.html` → skrip modul → setiap impor
 * statis & dinamis (`/src/…`, `/node_modules/.vite/deps/…`, `/@…`), berulang sampai tidak ada
 * modul baru. Hasilnya: optimasi dependensi selesai dan semua modul (termasuk halaman yang dimuat
 * malas dan rute pratinjau khusus dev) sudah ditransformasi di memori Vite. Penelusuran diulang bila
 * Vite mengoptimasi ulang dependensi di tengah jalan (versi `?v=` berubah / 504 "Outdated Optimize
 * Dep"), supaya browser tidak dimuat ulang paksa di tengah tes.
 *
 * Tetap Vite dev (bukan `vite build` + `preview`): foto kritikus memakai rute pratinjau yang hanya
 * ada di mode dev (`router.ts`), dan perilaku tes selama ini diuji melawan dev.
 *
 * Baris `BALESIN_E2E_WEB_SIAP` di stdout = siap (Playwright `webServer.wait.stdout`). Proses ini
 * hidup selama Vite hidup; bila Vite mati, proses ini ikut keluar.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sama dengan `webServer.wait.stdout` di viewports.ts. */
const READY_LINE = 'BALESIN_E2E_WEB_SIAP';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';
const port = Number(process.env.E2E_WEB_PORT ?? 5180);
const base = `http://localhost:${String(port)}`;
const CONCURRENCY = 6;
const MAX_PASSES = 5;

function log(message) {
  process.stdout.write(`[e2e-web] ${message}\n`);
}

// ── Vite ────────────────────────────────────────────────────────────────────────────────────
// Windows: pnpm = berkas .cmd yang hanya bisa dijalankan lewat shell; argumennya teks tetap.
const args = ['--filter', '@balesin/web', 'exec', 'vite', '--port', String(port), '--strictPort'];
const options = {
  cwd: root,
  env: { ...process.env, BALESIN_DEV_NO_HMR: '1' },
  stdio: /** @type {const} */ (['ignore', 'inherit', 'inherit']),
};
const vite = isWindows
  ? spawn(`pnpm ${args.join(' ')}`, { ...options, shell: true })
  : spawn('pnpm', args, options);

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (vite.exitCode === null && vite.pid) {
    if (isWindows) spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    else vite.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
vite.on('exit', (code) => {
  log(`Vite berhenti (kode ${String(code)}); web E2E dimatikan`);
  shutdown(code ?? 1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ── Pemanasan ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForVite() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      if (response.ok) return;
    } catch {
      // belum mendengarkan
    }
    await sleep(300);
  }
  throw new Error(`Vite tidak menjawab di ${base} dalam 120 dtk`);
}

/** Spesifier impor (statis, dinamis, re-ekspor) yang menunjuk modul di server Vite yang sama. */
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /<script[^>]*\bsrc=["']([^"']+)["']/g,
];

function localSpecifiers(text) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = (match[1] ?? '').split('#')[0] ?? '';
      if (specifier.startsWith('/') && !specifier.startsWith('//')) found.add(specifier);
    }
  }
  return found;
}

/** Satu putaran penelusuran. Mengembalikan URL dependensi teroptimasi + jumlah 504. */
async function crawl() {
  const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
  const seen = new Set();
  const queue = [...localSpecifiers(html)];
  const deps = new Set();
  let outdated = 0;
  let failed = 0;

  async function visit(url) {
    const response = await fetch(`${base}${url}`, { headers: { accept: '*/*' } });
    if (response.status === 504) {
      outdated += 1;
      return;
    }
    if (!response.ok) {
      failed += 1;
      return;
    }
    if (url.startsWith('/node_modules/.vite/deps/')) deps.add(url);
    const type = response.headers.get('content-type') ?? '';
    if (!/javascript|typescript/.test(type)) {
      await response.arrayBuffer();
      return;
    }
    for (const next of localSpecifiers(await response.text())) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY).filter((url) => !seen.has(url));
    for (const url of batch) seen.add(url);
    await Promise.all(batch.map((url) => visit(url)));
  }
  return { modules: seen.size, deps, outdated, failed };
}

const same = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));

try {
  await waitForVite();
  const started = Date.now();
  let previous = new Set();
  let stable = false;
  for (let pass = 1; pass <= MAX_PASSES && !stable; pass += 1) {
    const result = await crawl();
    log(
      `pemanasan putaran ${String(pass)}: ${String(result.modules)} modul, ` +
        `${String(result.deps.size)} dependensi teroptimasi, ${String(result.outdated)} usang, ` +
        `${String(result.failed)} gagal (${String(Math.round((Date.now() - started) / 1000))} dtk)`,
    );
    stable = result.outdated === 0 && pass > 1 && same(previous, result.deps);
    previous = result.deps;
  }
  if (!stable) log('peringatan: dependensi Vite belum stabil setelah pemanasan; tes tetap dimulai');
  process.stdout.write(`${READY_LINE}\n`);
} catch (error) {
  log(`pemanasan gagal: ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}
