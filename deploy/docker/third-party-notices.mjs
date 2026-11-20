// Pembangkit THIRD-PARTY-NOTICES (audit akhir A5, kepatuhan lisensi). Dipanggil stage `notices` di
// deploy/docker/Dockerfile; hasilnya disalin ke /app/THIRD-PARTY-NOTICES di image api, worker, web,
// dan menjadi aset rilis THIRD-PARTY-NOTICES.txt (rilis.yml).
//
//   node third-party-notices.mjs <licenses.json> <berkas-keluaran>
//
// <licenses.json> = keluaran `pnpm licenses list --prod --json` (objek: ekspresi lisensi → daftar
// paket {name, versions[], paths[], license, homepage}). Teks lisensi dibaca dari folder paket
// yang terpasang (LICENSE*, COPYING*, NOTICE*). Paket LGPL (libvips & pustaka native bawaan sharp)
// mendapat bagian khusus: pemberitahuan pemakaian, cara mengganti pustaka, cara memperoleh kode
// sumber, ditambah teks lengkap GNU LGPL v3 + GNU GPL v3 (LGPL v3 §4b mewajibkan keduanya).
//
// Gagal (exit 1) bila: ada paket berlisensi copyleft kuat/proprietary/tidak diketahui tanpa
// alternatif permisif, atau paket LGPL ada tetapi teks lisensinya tidak tersedia. Keluaran
// deterministik (tanpa tanggal/path build) supaya identik di setiap arsitektur dan rilis.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Pemakaian: node third-party-notices.mjs <licenses.json> <berkas-keluaran>');
  process.exit(2);
}

/** Lisensi yang tidak boleh masuk produk white-label tanpa alternatif lain (ekspresi SPDX). */
const FORBIDDEN =
  /(^|[^L])GPL|AGPL|SSPL|EUPL|OSL-|CPAL|RPL-|BUSL|Commons-Clause|CC-BY-NC|UNLICENSED|^Unknown$|SEE LICENSE/i;
const WEAK_COPYLEFT = /LGPL/i;
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.\-_].*)?$/i;

const clean = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

/** Satu alternatif (dipisah OR) boleh bila tidak ada bagian (dipisah AND) yang terlarang. */
function allowed(expression) {
  const alternatives = expression.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  return alternatives.some((alternative) =>
    alternative
      .split(/\s+AND\s+/i)
      .map((part) => part.trim())
      .every((part) => part !== '' && (WEAK_COPYLEFT.test(part) || !FORBIDDEN.test(part))),
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function repositoryUrl(manifest, fallback) {
  const repo = manifest.repository;
  let url = typeof repo === 'string' ? repo : (repo?.url ?? '');
  url = url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://');
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url || fallback || '';
}

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: clean(readFileSync(join(dir, name), 'utf8')) }));
}

// ── Kumpulkan paket ──────────────────────────────────────────────────────────────────────────
const report = JSON.parse(readFileSync(input, 'utf8'));
const packages = new Map();
const problems = [];
for (const [group, entries] of Object.entries(report)) {
  for (const entry of entries) {
    entry.versions.forEach((version, index) => {
      const dir = entry.paths[index] ?? entry.paths[0];
      // Paket workspace (@balesin/*) bukan pihak ketiga: hanya yang terpasang di node_modules.
      if (!dir || !/node_modules/.test(dir)) return;
      const key = `${entry.name}@${version}`;
      if (packages.has(key)) return;
      const manifest = readJson(join(dir, 'package.json'));
      const license = String(entry.license || manifest.license || group || 'Unknown');
      if (!allowed(license)) problems.push(`${key}: lisensi "${license}" tidak diizinkan`);
      packages.set(key, {
        name: entry.name,
        version,
        dir,
        license,
        url: repositoryUrl(manifest, entry.homepage),
        files: licenseFiles(dir),
        lgpl: WEAK_COPYLEFT.test(license),
      });
    });
  }
}

const sorted = [...packages.values()].sort(
  (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
);
const lgpl = sorted.filter((pkg) => pkg.lgpl);
const gnuTexts = ['LGPL-3.0.txt', 'GPL-3.0.txt'].map((name) => join(here, 'licenses', name));
if (lgpl.length > 0) {
  for (const path of gnuTexts) {
    if (!existsSync(path)) problems.push(`teks lisensi ${path} tidak ada (wajib untuk paket LGPL)`);
  }
}
if (sorted.length === 0) problems.push('tidak ada paket pihak ketiga terbaca dari laporan pnpm');
if (problems.length > 0) {
  console.error(`THIRD-PARTY-NOTICES gagal dibuat:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// ── Tulis berkas ─────────────────────────────────────────────────────────────────────────────
const rule = '='.repeat(100);
const thin = '-'.repeat(100);
const out = [];
const counts = new Map();
for (const pkg of sorted) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);

out.push(
  rule,
  'PEMBERITAHUAN PIHAK KETIGA (THIRD-PARTY NOTICES) — Balesin',
  rule,
  '',
  'Balesin memakai perangkat lunak sumber terbuka di bawah ini. Berkas ini dibangkitkan otomatis saat',
  'build image dari dependensi produksi api, worker, dan web (`pnpm licenses list --prod`), untuk',
  'semua arsitektur rilis (linux/amd64 dan linux/arm64). Setiap paket disertai teks lisensi dan',
  'pemberitahuan hak cipta dari paket aslinya.',
  '',
  `Jumlah paket: ${sorted.length}`,
  ...[...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
    .map(([license, count]) => `  ${license}: ${count}`),
  '',
);

if (lgpl.length > 0) {
  out.push(
    rule,
    'BAGIAN 1 — Pustaka di bawah GNU LGPL v3 (libvips dan pustaka native yang dibundel sharp)',
    rule,
    '',
    'Pengolahan gambar memakai sharp, yang menyertakan biner prebuilt libvips beserta pustaka',
    'pendukungnya (glib, pango, librsvg, libheif, libexif, fribidi, proxy-libintl, cairo, dll.).',
    'Sebagian pustaka itu berlisensi GNU Lesser General Public License v3 (atau versi setelahnya).',
    'Rincian lisensi tiap pustaka ada di README paket di bawah.',
    '',
    '- Cara pakai: pustaka ditaut DINAMIS (berkas .so terpisah yang dimuat saat proses berjalan), tidak',
    '  digabung ke kode Balesin. Lokasinya di image api/worker:',
    '    /app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-<arsitektur>@<versi>/node_modules/',
    '      @img/sharp-libvips-linuxmusl-<arsitektur>/lib/',
    '- Mengganti pustaka: Anda berhak memakai versi libvips/pustaka lain yang kompatibel antarmuka,',
    '  misalnya dengan image turunan (`FROM <image-balesin>` lalu menyalin berkas .so pengganti ke',
    '  lokasi di atas). Syarat lisensi Balesin tidak melarang modifikasi pustaka ini maupun rekayasa',
    '  balik untuk men-debug modifikasi tersebut (LGPL v3 §4).',
    '- Kode sumber: kode sumber lengkap untuk versi persis yang terpasang tersedia bebas biaya di',
    '  tautan per paket di bawah (skrip build sharp-libvips + versi sumber upstream di versions.json).',
    '  Bila tautan itu tidak lagi tersedia, minta salinan kode sumbernya kepada penyedia distribusi',
    '  Balesin Anda; salinan diberikan tanpa biaya selain ongkos penyalinan, sedikitnya selama tiga',
    '  tahun sejak versi ini didistribusikan.',
    '- Teks lengkap GNU LGPL v3 dan GNU GPL v3 ada di BAGIAN 3.',
    '',
  );
  for (const pkg of lgpl) {
    const versions = readJson(join(pkg.dir, 'versions.json'));
    out.push(thin, `${pkg.name}@${pkg.version} — ${pkg.license}`, thin);
    if (/^@img\/sharp-libvips-/.test(pkg.name)) {
      out.push(`Sumber build: https://github.com/lovell/sharp-libvips/tree/v${pkg.version}`);
    } else if (pkg.url) {
      out.push(`Sumber: ${pkg.url}`);
    }
    if (typeof versions.vips === 'string') {
      out.push(`Sumber libvips: https://github.com/libvips/libvips/tree/v${versions.vips}`);
    }
    const listed = Object.entries(versions);
    if (listed.length > 0) {
      out.push('Versi pustaka yang dibundel (versions.json):');
      for (const [library, version] of listed) out.push(`  ${library} ${String(version)}`);
    }
    const readme = join(pkg.dir, 'README.md');
    if (existsSync(readme)) out.push('', clean(readFileSync(readme, 'utf8')));
    out.push('');
  }
}

out.push(rule, 'BAGIAN 2 — Daftar paket dan teks lisensi', rule, '');
for (const pkg of sorted) {
  out.push(thin, `${pkg.name}@${pkg.version}`, `Lisensi: ${pkg.license}`);
  if (pkg.url) out.push(`Sumber: ${pkg.url}`);
  out.push(thin);
  if (pkg.files.length === 0) {
    out.push(`(Paket tidak menyertakan berkas lisensi; berlaku teks standar ${pkg.license}.)`);
  }
  for (const file of pkg.files) {
    if (pkg.files.length > 1) out.push(`[${file.name}]`);
    out.push(file.text, '');
  }
  out.push('');
}

if (lgpl.length > 0) {
  out.push(rule, 'BAGIAN 3 — Teks lengkap GNU LGPL v3 dan GNU GPL v3', rule, '');
  for (const path of gnuTexts) out.push(clean(readFileSync(path, 'utf8')), '', thin, '');
}

out.push(
  rule,
  `BAGIAN ${lgpl.length > 0 ? 4 : 3} — Komponen image dasar`,
  rule,
  '',
  'Image juga memuat Alpine Linux, Node.js (image api/worker), dan nginx (image web) dari image',
  'resmi upstream. Lisensinya mengikuti distribusi masing-masing: daftar paket sistem dan',
  'lisensinya dapat dilihat dengan `apk info -a` / berkas /lib/apk/db/installed di dalam image;',
  'lisensi Node.js: https://github.com/nodejs/node/blob/main/LICENSE; nginx: https://nginx.org/LICENSE.',
  '',
);

writeFileSync(output, `${out.join('\n').trimEnd()}\n`);
console.log(
  `THIRD-PARTY-NOTICES: ${sorted.length} paket, ${lgpl.length} paket LGPL, ${output} ditulis.`,
);
