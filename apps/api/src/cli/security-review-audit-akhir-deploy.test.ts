import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Penjaga audit akhir keamanan, temuan devops A3–A5
 * (docs/audits/2026-11-25-audit-akhir/security.md).
 *
 * - A3: image pihak ketiga & base image dipin digest, dipantau Dependabot, dan dipindai CVE (Trivy)
 *   sebelum push di rilis.yml (gagal untuk CVE kritis yang sudah ada perbaikannya).
 * - A4: kewajiban `BALESIN_REQUIRE_SIGNATURE=1` tercatat di checklist rilis.
 * - A5: THIRD-PARTY-NOTICES (termasuk teks LGPL libvips) dibangkitkan saat build, ada di setiap
 *   image (/app/THIRD-PARTY-NOTICES) dan di aset rilis.
 *
 * Tanpa database: dijalankan `pnpm --filter @balesin/api test:deploy` (vitest.deploy.config.ts).
 */

const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const compose = read('deploy/docker-compose.yml');
const dockerfile = read('deploy/docker/Dockerfile');
const dependabot = read('.github/dependabot.yml');
const releaseWorkflow = read('.github/workflows/rilis.yml');
const ciWorkflow = read('.github/workflows/ci.yml');
const deployDoc = read('docs/DEPLOY.md');
const generator = join(root, 'deploy', 'docker', 'third-party-notices.mjs');

const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Blok satu stage Dockerfile (dari `FROM … AS <nama>` sampai FROM berikutnya). */
function stage(name: string): string {
  const stages = dockerfile.split(/^FROM /m);
  const found = stages.find((block) => new RegExp(`^\\S.* AS ${name}\\n`).test(block));
  if (!found) throw new Error(`stage ${name} tidak ada`);
  return found;
}

/** Blok satu langkah workflow berdasarkan `name:`. */
function step(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`langkah ${name} tidak ada`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/\n {6}- (name|uses):/);
  return workflow.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe('A3: image dipin digest, dipantau, dan dipindai CVE', () => {
  it('setiap image pihak ketiga di compose dipin tag@sha256 (image Balesin dipin di rilis.yml)', () => {
    const images = [...compose.matchAll(/^ +image: (.+)$/gm)].map((match) => match[1] ?? '');
    const thirdParty = images.filter((image) => !image.startsWith('${BALESIN_IMAGE_PREFIX'));
    expect(thirdParty).toHaveLength(4);
    for (const image of thirdParty) {
      expect(image, image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    }
  });

  it('base image Dockerfile (dan frontend syntax) dipin tag@sha256', () => {
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:[\d.]+@sha256:[0-9a-f]{64}$/m);
    const stageNames = new Set(
      [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gm)].map((match) => match[1]),
    );
    const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)]
      .map((match) => match[1] ?? '')
      .filter((image) => image !== 'scratch' && !stageNames.has(image));
    expect(bases.length).toBeGreaterThanOrEqual(4);
    for (const image of bases) expect(image, image).toMatch(DIGEST);
  });

  it('Dependabot memantau compose (/deploy) dan Dockerfile (/deploy/docker)', () => {
    expect(dependabot).toMatch(/package-ecosystem: docker-compose\n {4}directory: \/deploy\n/);
    expect(dependabot).toMatch(/package-ecosystem: docker\n {4}directory: \/deploy\/docker\n/);
  });

  it('rilis.yml memindai image dengan Trivy dipin digest SEBELUM login registry dan push', () => {
    const scan = step(releaseWorkflow, 'Pindai CVE image (Trivy)');
    expect(scan).toMatch(/TRIVY_IMAGE: docker\.io\/aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}\n/);
    // Gerbang: CVE KRITIS yang sudah ada perbaikannya menggagalkan job.
    expect(scan).toMatch(/--severity CRITICAL --ignore-unfixed --exit-code 1/);
    expect(scan).toMatch(/gagal=1/);
    expect(scan).toMatch(/exit "\$gagal"/);
    // Laporan HIGH/CRITICAL untuk image Balesin kedua arsitektur dan image pihak ketiga compose.
    expect(scan).toMatch(/--severity HIGH,CRITICAL --exit-code 0/);
    expect(scan).toMatch(/for target in api worker web/);
    expect(scan).toMatch(/for platform in \$\{PLATFORMS/);
    expect(scan).toMatch(/deploy\/docker-compose\.yml/);
    // Tanpa socket Docker untuk Trivy: image dibaca dari arsip, mount read-only.
    expect(scan).not.toMatch(/docker\.sock/);
    expect(scan).toMatch(/:\/pindai:ro/);
    const at = (text: string) => releaseWorkflow.indexOf(text);
    expect(at('- name: Pindai CVE image (Trivy)')).toBeGreaterThan(at('- name: Uji asap'));
    expect(at('- name: Pindai CVE image (Trivy)')).toBeLessThan(at('- name: Masuk ke GHCR'));
    expect(at('- name: Pindai CVE image (Trivy)')).toBeLessThan(at('--push'));
  });

  it('compose rilis menolak baris image mana pun yang belum terkunci digest', () => {
    const files = step(releaseWorkflow, 'Siapkan berkas rilis');
    expect(files).not.toMatch(/grep -c '@sha256:' rilis\/docker-compose\.yml\)" -eq 4/);
    expect(files).toMatch(/grep -cE '\^ \+image: \[\^ \$\]\+@sha256:\[0-9a-f\]\{64\}\$'/);
    expect(files).toMatch(/\[ "\$pinned" -ne "\$total" \]/);
  });

  it('CI job deploy ikut memindai (informasi) dengan Trivy dipin digest, shellcheck dipin digest', () => {
    const scan = step(ciWorkflow, 'Pindai CVE image (Trivy, informasi)');
    expect(scan).toMatch(/TRIVY_IMAGE: docker\.io\/aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}\n/);
    expect(scan).toMatch(/docker save -o/);
    expect(scan).not.toMatch(/docker\.sock/);
    expect(ciWorkflow).toMatch(/koalaman\/shellcheck:v[\d.]+@sha256:[0-9a-f]{64}/);
  });

  it('semua aksi GitHub dipin SHA commit (tidak ada aksi Trivy/pihak ketiga ber-tag)', () => {
    for (const workflow of [releaseWorkflow, ciWorkflow]) {
      for (const match of workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
        const ref = match[1] ?? '';
        if (ref.startsWith('./')) continue;
        expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

// Tindak lanjut A3: semua CVE HIGH image api/worker berasal dari npm bawaan image node yang tidak
// dipakai saat berjalan. Manajer paket dibuang dari stage runtime; tidak ada yang memanggilnya.
describe('A3 lanjutan: runtime api/worker tanpa npm/npx/corepack/yarn', () => {
  const packageManager = /\b(npm|npx|corepack|yarn|yarnpkg)\b/;

  it('stage node-runtime menghapus manajer paket dan memastikan sudah hilang', () => {
    const runtime = stage('node-runtime');
    expect(runtime).toMatch(
      /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/lib\/node_modules\/corepack \/opt\/yarn-v\*/,
    );
    for (const bin of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg']) {
      expect(runtime, bin).toMatch(new RegExp(`/usr/local/bin/${bin}\\b`));
    }
    for (const bin of ['npm', 'npx', 'corepack', 'yarn']) {
      expect(runtime, bin).toMatch(new RegExp(`! command -v ${bin}\\b`));
    }
    // api & worker mewarisi node-runtime (bukan image node mentah).
    expect(dockerfile).toMatch(/^FROM node-runtime AS api$/m);
    expect(dockerfile).toMatch(/^FROM node-runtime AS worker$/m);
  });

  it('CMD/HEALTHCHECK/ENTRYPOINT api & worker hanya memanggil node/tini', () => {
    for (const name of ['node-runtime', 'api', 'worker']) {
      const instructions = stage(name)
        .split('\n')
        .filter(
          (line) => /^\s*(CMD|ENTRYPOINT)\b|^\s+CMD \[/.test(line) || /^HEALTHCHECK/.test(line),
        );
      for (const line of instructions) expect(line, `${name}: ${line}`).not.toMatch(packageManager);
    }
  });

  it('compose, CLI balesin, installer, dan healthcheck worker tidak memanggil manajer paket', () => {
    const sources: Record<string, string> = {
      'deploy/docker-compose.yml': compose,
      'deploy/balesin': read('deploy/balesin'),
      'deploy/install.sh': read('deploy/install.sh'),
      'deploy/docker/worker-healthcheck.mjs': read('deploy/docker/worker-healthcheck.mjs'),
    };
    for (const [path, text] of Object.entries(sources)) {
      const lines = text.split('\n').filter((line) => !/^\s*(#|\/\/)/.test(line));
      const hits = lines.filter((line) => packageManager.test(line));
      expect(hits, path).toEqual([]);
    }
    // Perintah compose untuk image Balesin: migrate = node dist/migrate.js.
    expect(compose).toMatch(/command: \['node', 'dist\/migrate\.js'\]/);
  });
});

// Tindak lanjut A3: gerbang Trivy rilis menemukan CVE kritis nginx 1.30.6 & brotli 1.2.0 di image
// web sebelum image upstream dirilis ulang. Paket perbaikan dipasang di stage web, terverifikasi.
describe('A3 lanjutan: image web memasang paket perbaikan nginx/brotli dengan aman', () => {
  const web = () => stage('web');
  const run = () => {
    const block = web();
    const start = block.indexOf('RUN set -eu');
    return block.slice(start, block.indexOf('\nUSER 101', start));
  };

  it('nginx hanya dari repo resmi nginx.org (HTTPS, tanda tangan diverifikasi), minimal versi perbaikan', () => {
    const script = run();
    expect(script).toMatch(
      /apk add --no-cache --repositories-file \/dev\/null \\\n\s+--repository "https:\/\/nginx\.org\/packages\/alpine\/\$alpine\/main" \$nginx_pkgs/,
    );
    expect(script).not.toMatch(/--allow-untrusted|http:\/\//);
    const fix = /nginx_fix=(\d+)\.(\d+)\.(\d+)/.exec(script);
    expect(fix).not.toBeNull();
    const [, major, minor, patch] = (fix ?? []).map(Number);
    expect(major === 1 && (minor ?? 0) >= 30 && ((minor ?? 0) > 30 || (patch ?? 0) >= 7)).toBe(
      true,
    );
    expect(script).toMatch(/sed "s\/\\\$\/>=\$nginx_fix\/"/);
  });

  it('paket Alpine dinaikkan SEBELUM nginx.org (world masih mengunci nginx), brotli ≥ perbaikan', () => {
    const script = run();
    expect(script.indexOf('apk upgrade --no-cache')).toBeGreaterThan(-1);
    expect(script.indexOf('apk upgrade --no-cache')).toBeLessThan(script.indexOf('nginx.org'));
    expect(script).toMatch(/brotli_fix=1\.2\.1-r0/);
    expect(script).toMatch(/apk add --no-cache "brotli-libs>=\$brotli_fix"/);
  });

  it('build gagal bila versi terpasang di bawah perbaikan; versi dicetak; sisa konfigurasi dibuang', () => {
    const script = run();
    expect(script).toMatch(/apk version -t "\$v" "\$2"\)" != "<"/);
    expect(script).toMatch(/atleast nginx "\$nginx_fix"/);
    expect(script).toMatch(/atleast brotli-libs "\$brotli_fix"/);
    expect(script).toMatch(/atleast "\$pkg" "\$nginx_fix"/);
    expect(script).toMatch(/echo "terpasang: /);
    expect(script).toMatch(/nginx -v/);
    expect(script).toMatch(/rm -f \/etc\/nginx\/conf\.d\/default\.conf/);
    expect(script).toMatch(/test -z "\$\(find \/etc\/nginx -name '\*\.apk-new'/);
    // root hanya untuk langkah paket; kembali ke 101 sebelum berkas Balesin disalin.
    expect(web()).toMatch(/^USER root\n(?:#.*\n)*RUN set -eu/m);
    expect(web()).toMatch(/\nUSER 101\nCOPY deploy\/docker\/gateway\/nginx\.conf/);
  });
});

describe('A4: verifikasi tanda tangan rilis di checklist', () => {
  it('checklist rilis DEPLOY.md mewajibkan BALESIN_REQUIRE_SIGNATURE=1 pada rilis bertanda tangan pertama', () => {
    const checklist = deployDoc.slice(deployDoc.indexOf('### Checklist rilis'));
    expect(checklist).toMatch(/Rilis bertanda tangan pertama/);
    expect(checklist).toMatch(/BALESIN_REQUIRE_SIGNATURE/);
    expect(checklist).toMatch(/`balesin update` menyetel `BALESIN_REQUIRE_SIGNATURE=1`/);
    expect(read('docs/BUTUH-TOBING.md')).toMatch(
      /\| 18 \|.*ubah `BALESIN_REQUIRE_SIGNATURE` ke `1`/,
    );
  });
});

describe('A5: THIRD-PARTY-NOTICES di image dan rilis', () => {
  it('stage notices membangkitkan berkas dari pnpm licenses (kedua arsitektur) + penjaga LGPL', () => {
    const notices = stage('notices');
    expect(notices).toMatch(
      /supportedArchitectures:\\n {2}os: \[linux\]\\n {2}cpu: \[x64, arm64\]/,
    );
    expect(notices).toMatch(/--ignore-scripts/);
    expect(notices).toMatch(/pnpm licenses list --prod --json/);
    expect(notices).toMatch(
      /third-party-notices\.mjs \/tmp\/licenses\.json \/out\/THIRD-PARTY-NOTICES/,
    );
    expect(notices).toMatch(/grep -q 'GNU LESSER GENERAL PUBLIC LICENSE'/);
    expect(notices).toMatch(/sharp-libvips-linuxmusl-x64@/);
    expect(notices).toMatch(/sharp-libvips-linuxmusl-arm64@/);
  });

  it('image api, worker, web memuat /app/THIRD-PARTY-NOTICES', () => {
    for (const name of ['api', 'worker', 'web']) {
      expect(stage(name), name).toMatch(
        /^COPY --from=notices \/out\/THIRD-PARTY-NOTICES \/app\/THIRD-PARTY-NOTICES$/m,
      );
    }
  });

  it('teks GNU LGPL v3 dan GPL v3 tersedia untuk pembangkit (masuk konteks build)', () => {
    expect(read('deploy/docker/licenses/LGPL-3.0.txt')).toMatch(
      /^\s+GNU LESSER GENERAL PUBLIC LICENSE\n\s+Version 3, 29 June 2007/,
    );
    expect(read('deploy/docker/licenses/GPL-3.0.txt')).toMatch(
      /^\s+GNU GENERAL PUBLIC LICENSE\n\s+Version 3, 29 June 2007/,
    );
    // .dockerignore membuang deploy/* kecuali deploy/docker.
    expect(read('.dockerignore')).toMatch(/^deploy\/\*\n!deploy\/docker$/m);
  });

  it('rilis.yml mengambil berkas dari image, memastikan sama antar-arsitektur, dan menandatanganinya', () => {
    const smoke = step(releaseWorkflow, 'Uji asap tiap arsitektur');
    expect(smoke).toMatch(
      /--entrypoint cat "balesin-uji-api:\$arch" \\\n\s+\/app\/THIRD-PARTY-NOTICES/,
    );
    expect(smoke).toMatch(
      /cmp "\$RUNNER_TEMP\/notices-amd64\.txt" "\$RUNNER_TEMP\/notices-arm64\.txt"/,
    );
    const files = step(releaseWorkflow, 'Siapkan berkas rilis');
    expect(files).toMatch(/cp "\$RUNNER_TEMP\/notices-amd64\.txt" rilis\/THIRD-PARTY-NOTICES\.txt/);
    // Tercantum di SHA256SUMS (yang ditandatangani cosign).
    const sums = /sha256sum ([^>]+)> SHA256SUMS/.exec(files.replace(/\\\n\s+/g, ' '));
    expect(sums?.[1]).toMatch(/THIRD-PARTY-NOTICES\.txt/);
  });

  it('CI memeriksa berkas ada dan identik di ketiga image', () => {
    const check = step(ciWorkflow, 'THIRD-PARTY-NOTICES ada di setiap image');
    expect(check).toMatch(/for target in api worker web/);
    expect(check).toMatch(/\/app\/THIRD-PARTY-NOTICES/);
    expect(check).toMatch(/grep -q 'GNU LESSER GENERAL PUBLIC LICENSE'/);
    expect(check).toMatch(/cmp /);
  });

  describe('pembangkit third-party-notices.mjs', () => {
    const work = mkdtempSync(join(tmpdir(), 'balesin-notices-'));
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    let counter = 0;
    /** Paket tiruan di <work>/<n>/node_modules/<name> + laporan gaya `pnpm licenses list --json`. */
    function fixture(
      packages: {
        name: string;
        version: string;
        license: string;
        files?: Record<string, string>;
      }[],
    ) {
      const dir = join(work, String(counter++));
      const report: Record<string, unknown[]> = {};
      for (const pkg of packages) {
        const pkgDir = join(dir, 'node_modules', ...pkg.name.split('/'));
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
          join(pkgDir, 'package.json'),
          JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license }),
        );
        for (const [file, text] of Object.entries(pkg.files ?? {})) {
          writeFileSync(join(pkgDir, file), text);
        }
        (report[pkg.license] ??= []).push({
          name: pkg.name,
          versions: [pkg.version],
          paths: [pkgDir],
          license: pkg.license,
          homepage: `https://example.test/${pkg.name}`,
        });
      }
      // Paket workspace (bukan di node_modules) diabaikan.
      (report['MIT'] ??= []).push({
        name: '@balesin/shared',
        versions: ['0.0.0'],
        paths: [join(root, 'packages', 'shared')],
        license: 'MIT',
      });
      const input = join(dir, 'licenses.json');
      const output = join(dir, 'THIRD-PARTY-NOTICES');
      writeFileSync(input, JSON.stringify(report));
      const run = () =>
        spawnSync(process.execPath, [generator, input, output], { encoding: 'utf8' });
      return { run, output };
    }

    it('menulis teks lisensi tiap paket, bagian LGPL (sumber libvips) dan teks LGPL/GPL lengkap', () => {
      const { run, output } = fixture([
        {
          name: 'zeta-lib',
          version: '2.0.0',
          license: '(MIT OR EUPL-1.1+)',
          files: { 'LICENSE.md': 'Hak cipta zeta\r\n' },
        },
        {
          name: '@img/sharp-libvips-linuxmusl-x64',
          version: '1.3.4',
          license: 'LGPL-3.0-or-later',
          files: {
            'README.md': '| libvips | LGPLv3 |',
            'versions.json': JSON.stringify({ vips: '8.18.7', glib: '2.90.0' }),
          },
        },
        { name: 'alpha-lib', version: '1.0.0', license: 'MIT', files: { LICENSE: 'MIT alpha' } },
      ]);
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      const text = readFileSync(output, 'utf8');
      expect(text).toMatch(/Jumlah paket: 3\n/);
      expect(text).not.toMatch(/@balesin\/shared/);
      expect(text).toMatch(/BAGIAN 1 — Pustaka di bawah GNU LGPL v3/);
      expect(text).toMatch(
        /Sumber build: https:\/\/github\.com\/lovell\/sharp-libvips\/tree\/v1\.3\.4/,
      );
      expect(text).toMatch(
        /Sumber libvips: https:\/\/github\.com\/libvips\/libvips\/tree\/v8\.18\.7/,
      );
      expect(text).toMatch(/\| libvips \| LGPLv3 \|/);
      expect(text).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE\n\s+Version 3/);
      expect(text).toMatch(/GNU GENERAL PUBLIC LICENSE\n\s+Version 3/);
      expect(text).toMatch(/Hak cipta zeta\n/);
      expect(text).not.toMatch(/\r/);
      // Urut nama paket, deterministik (tanpa tanggal/path build).
      expect(text.indexOf('\nalpha-lib@1.0.0\n')).toBeLessThan(text.indexOf('\nzeta-lib@2.0.0\n'));
      expect(text).not.toContain(work);
      run();
      expect(readFileSync(output, 'utf8')).toBe(text);
    });

    it.each([
      ['GPL-3.0-only'],
      ['AGPL-3.0'],
      ['SSPL-1.0'],
      ['UNLICENSED'],
      ['Unknown'],
      ['MIT AND GPL-2.0'],
    ])('menolak lisensi %s tanpa alternatif permisif', (license) => {
      const { run } = fixture([{ name: 'bad-lib', version: '1.0.0', license }]);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/bad-lib@1\.0\.0: lisensi .* tidak diizinkan/);
    });

    it('menerima lisensi ganda dengan alternatif permisif dan LGPL (copyleft lemah)', () => {
      const { run } = fixture([
        { name: 'dual-lib', version: '1.0.0', license: '(MIT OR GPL-3.0-or-later)' },
        { name: 'img-lib', version: '1.0.0', license: 'Apache-2.0 AND LGPL-3.0-or-later' },
        { name: 'free-lib', version: '1.0.0', license: 'Unlicense' },
      ]);
      const result = run();
      expect(result.status, result.stderr).toBe(0);
    });
  });
});
