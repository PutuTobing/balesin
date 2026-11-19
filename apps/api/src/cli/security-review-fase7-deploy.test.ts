import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Penjaga review keamanan Fase 7 — produk self-hosted
 * (docs/security-reviews/2026-11-22-fase7-deploy.md).
 *
 * Berkas deploy (compose, nginx, Dockerfile, CLI Bash) tidak punya tes unit sendiri; tes ini
 * membaca teksnya dan mengunci sifat keamanan yang sudah benar supaya tidak mundur diam-diam.
 * Temuan S1–S4 dan R1 sudah diperbaiki (putaran 2) — tesnya kini `it` biasa.
 *
 * Tes ini tidak butuh database: `pnpm --filter @balesin/api test:deploy` menjalankannya tanpa
 * globalSetup Postgres (vitest.deploy.config.ts).
 */

const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const compose = read('deploy/docker-compose.yml');
const gateway = read('deploy/docker/gateway/nginx.conf');
const proxyApi = read('deploy/docker/gateway/proxy-api.conf');
const headers = read('deploy/docker/gateway/security-headers.conf');
const vmNginx = read('deploy/nginx/balesin.conf');
const dockerfile = read('deploy/docker/Dockerfile');
const cli = read('deploy/balesin');
const deployDoc = read('docs/DEPLOY.md');
const releaseWorkflow = read('.github/workflows/rilis.yml');

/** Blok satu layanan compose (indentasi 2 spasi di bawah `services:`). */
function service(name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`layanan ${name} tidak ada`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** Baris tanpa komentar (`#` di awal setelah spasi). */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('compose produksi', () => {
  it('container aplikasi non-root, read-only, tanpa capability, no-new-privileges', () => {
    const hardened = compose.slice(compose.indexOf('x-hardened:'), compose.indexOf('x-app-env:'));
    expect(hardened).toMatch(/read_only: true/);
    expect(hardened).toMatch(/cap_drop: \[ALL\]/);
    expect(hardened).toMatch(/no-new-privileges:true/);
    for (const name of ['migrate', 'api', 'worker', 'web']) {
      expect(service(name), name).toMatch(/<<: \*hardened/);
    }
  });

  it('hanya gateway (dan caddy mode B) yang membuka port; Postgres/Redis hanya di jaringan internal', () => {
    for (const name of ['postgres', 'redis', 'migrate', 'api', 'worker', 'cloudflared']) {
      expect(service(name), name).not.toMatch(/^\s+ports:/m);
    }
    expect(service('postgres')).toMatch(/networks: \[data\]/);
    expect(service('redis')).toMatch(/networks: \[data\]/);
    expect(compose).toMatch(/ {2}data:\n {4}internal: true/);
    // Bawaan bind gateway = loopback (mode B/C); mode A diisi IP privat oleh installer.
    expect(service('web')).toMatch(/\$\{BALESIN_BIND_ADDRESS:-127\.0\.0\.1\}/);
  });

  it('api/worker memakai peran DB runtime, bukan pemilik tabel', () => {
    expect(compose).toMatch(/DATABASE_URL: postgres:\/\/\$\{APP_DB_USER:\?\}/);
    expect(service('migrate')).toMatch(/DATABASE_URL: postgres:\/\/\$\{POSTGRES_USER/);
  });

  // S1: redis sebagai pengguna `redis` sejak awal (entrypoint resmi, tanpa `sh -c`), tanpa
  // capability, read-only; postgres hanya capability yang dibutuhkan entrypoint-nya.
  it('S1: Redis berjalan sebagai pengguna non-root (user: di compose)', () => {
    const redis = service('redis');
    expect(redis).toMatch(/^\s+user:\s*redis$/m);
    expect(redis).toMatch(/cap_drop: \[ALL\]/);
    expect(redis).toMatch(/read_only: true/);
    expect(redis).not.toMatch(/- sh\n\s+- -c/);
    expect(redis).toMatch(/command:\n\s+- redis-server/);
  });

  it('S1: Postgres tanpa capability bawaan Docker, read-only + tmpfs', () => {
    const postgres = service('postgres');
    expect(postgres).toMatch(/cap_drop: \[ALL\]/);
    expect(postgres).toMatch(/cap_add: \[CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID\]/);
    expect(postgres).toMatch(/read_only: true/);
    expect(postgres).toMatch(/\/var\/run\/postgresql/);
  });
});

describe('image', () => {
  it('stage akhir api/worker/web berjalan sebagai non-root', () => {
    const stages = dockerfile.split(/^FROM /m);
    const nodeRuntime = stages.find((stage) => stage.includes('AS node-runtime'));
    const web = stages.find((stage) => stage.includes('AS web'));
    expect(nodeRuntime).toMatch(/^USER node$/m);
    // Baris USER terakhir di stage web harus 101 (nginx-unprivileged).
    const webUsers = [...(web ?? '').matchAll(/^USER (\S+)$/gm)].map((match) => match[1]);
    expect(webUsers.at(-1)).toBe('101');
  });

  it('tidak ada rahasia sebagai ARG/ENV di Dockerfile', () => {
    expect(code(dockerfile)).not.toMatch(
      /^(ARG|ENV)\s+\S*(SECRET|PASSWORD|TOKEN|MASTER_KEY|PASSPHRASE)/im,
    );
  });

  // R1: pola .dockerignore hanya berlaku di AKAR konteks. `apps/api/.env`, `apps/api/*.pem`, dan
  // folder media dev (`MEDIA_DIR=./media` → apps/api/media) ikut `COPY apps apps` dan disalin
  // `pnpm deploy` ke /app di image akhir (diuji: /app/.env terbaca di image api).
  it('R1: .dockerignore membuang .env, kunci, dan media di folder mana pun', () => {
    const ignore = read('.dockerignore');
    expect(ignore).toMatch(/^\*\*\/\.env\*$/m);
    expect(ignore).toMatch(/^\*\*\/\*\.pem$/m);
    expect(ignore).toMatch(/^\*\*\/\*\.key$/m);
    expect(ignore).toMatch(/^\*\*\/media$/m);
    // Tidak ada pengecualian yang memasukkan kembali berkas .env apa pun.
    expect(ignore).not.toMatch(/^!.*\.env/m);
    // Kode sumber bernama `media` (packages/core/src/media) tetap ikut build.
    expect(ignore).toMatch(/^!\*\*\/src\/media$/m);
  });

  it('Info 5: source map tidak masuk image produksi', () => {
    expect(dockerfile).toMatch(/rm -f apps\/api\/dist\/\*\.map apps\/worker\/dist\/\*\.map/);
    expect(code(dockerfile)).not.toMatch(/--enable-source-maps/);
  });
});

describe('gateway & contoh nginx', () => {
  it('log akses tanpa query string (URL media bertanda tangan tidak tercatat)', () => {
    for (const [name, conf] of [
      ['gateway', gateway],
      ['vm-nginx', vmNginx],
    ] as const) {
      const formats = code(conf).match(/log_format[\s\S]*?;/g) ?? [];
      expect(formats.length, name).toBeGreaterThan(0);
      for (const format of formats) {
        expect(format, name).not.toMatch(/\$(request\b|request_uri|args|query_string|arg_)/);
      }
    }
  });

  it('header Origin tidak pernah ditimpa (pertahanan CSWSH WebSocket)', () => {
    for (const conf of [gateway, proxyApi, vmNginx]) {
      expect(code(conf)).not.toMatch(/proxy_set_header\s+Origin/i);
    }
  });

  it('proxy terdepan (vm-nginx) membuang X-Forwarded-For kiriman klien dan memasang HSTS sekali', () => {
    expect(code(vmNginx)).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(code(vmNginx)).toMatch(/proxy_hide_header Strict-Transport-Security;/);
  });

  it('CSP: skrip hanya dari origin sendiri, tanpa inline/eval; tidak bisa dibingkai', () => {
    const csp = /Content-Security-Policy "([^"]+)"/.exec(headers)?.[1] ?? '';
    const directive = (name: string) =>
      csp
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `)) ?? '';
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    // CSS sisipan (style-src-elem 'unsafe-inline') tidak punya jalur keluar: gambar/font/koneksi
    // hanya origin sendiri.
    expect(directive('img-src')).toBe("img-src 'self' data: blob:");
    expect(directive('font-src')).toBe("font-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });

  it('batas body: webhook ≤ 4 MiB di gateway dan vm-nginx', () => {
    for (const conf of [gateway, vmNginx]) {
      const block = /location \/webhooks\/ \{[\s\S]*?\}/.exec(code(conf))?.[0] ?? '';
      expect(block).toMatch(/client_max_body_size 4m;/);
    }
  });
});

describe('CLI balesin: backup & restore', () => {
  it('passphrase backup lewat variabel lingkungan openssl, bukan argumen proses', () => {
    expect(cli).toMatch(/-pass env:BACKUP_PASSPHRASE/);
    expect(cli).not.toMatch(/-pass pass:/);
    expect(cli).not.toMatch(/-k "\$/);
  });

  // S2: encrypt-then-MAC — HMAC-SHA256 berkunci (HKDF dari BACKUP_PASSPHRASE) diverifikasi SEBELUM
  // dekripsi; hash `.sha256` dibandingkan dengan hash berkas itu sendiri; arsip polos ditolak.
  it('S2: keutuhan backup diperiksa dengan kunci (HMAC/AEAD) sebelum dibuka', () => {
    expect(cli).toMatch(/createHmac\("sha256"/);
    expect(cli).toMatch(/hkdfSync\("sha256"/);
    const open = cli.slice(cli.indexOf('open_backup() {'), cli.indexOf('manifest_get()'));
    const macAt = open.indexOf('backup_mac "$file"');
    expect(macAt).toBeGreaterThan(0);
    expect(macAt).toBeLessThan(open.indexOf('openssl enc -d'));
    expect(open).not.toMatch(/sha256sum -c/);
    expect(cli).toMatch(/BACKUP_KDF_ITER=600000/);
  });

  it('S2: restore menolak arsip .tar tanpa enkripsi (kecuali opsi eksplisit)', () => {
    expect(cli).not.toMatch(/\*\.tar\) tar -C "\$work" -xf "\$file"/);
    expect(cli).toMatch(/Arsip polos ditolak/);
    // Backup tanpa passphrase tidak dibuat sama sekali.
    expect(cli).toMatch(/backup tanpa enkripsi tidak dibuat/);
  });

  it('R3: restore ke database sementara lalu ditukar (tidak dropdb database aktif lebih dulu)', () => {
    const restore = cli.slice(
      cli.indexOf('restore_data() {'),
      cli.indexOf('drop_previous_database() {'),
    );
    expect(restore).toMatch(/_pulih/);
    expect(restore.indexOf('pg_restore')).toBeLessThan(restore.indexOf('rename to'));
    expect(restore).not.toMatch(/dropdb[^\n]*--if-exists "\$POSTGRES_DB"/);
  });
});

describe('dokumentasi firewall & rilis', () => {
  // S3: port yang dipublikasikan Docker melewati aturan ufw (DNAT sebelum rantai INPUT); contoh
  // `ufw allow from <vm-nginx> to any port 8080` tidak membatasi apa pun.
  it('S3: DEPLOY.md membatasi port gateway lewat rantai DOCKER-USER', () => {
    expect(deployDoc).toMatch(/DOCKER-USER/);
    expect(deployDoc).not.toMatch(/ufw allow from <IP-privat-vm-nginx>/);
    const installer = read('deploy/install.sh');
    expect(installer).toMatch(/Bind 0\.0\.0\.0 ditolak/);
    expect(installer).toMatch(/is_private_ipv4 "\$BIND_ADDRESS"/);
  });

  // S4: image dirujuk dengan tag yang bisa ditimpa, tanpa tanda tangan/attestation; SHA256SUMS
  // diunduh dari kanal yang sama dengan berkasnya.
  it('S4: rilis menandatangani image/berkas (cosign/attestation) untuk diverifikasi', () => {
    expect(releaseWorkflow).toMatch(/cosign sign --yes/);
    expect(releaseWorkflow).toMatch(/cosign sign-blob --yes --bundle/);
    expect(releaseWorkflow).toMatch(/id-token: write/);
    // Hanya dari main, tag versi tidak boleh ditimpa, compose rilis terkunci digest.
    expect(releaseWorkflow).toMatch(
      /git merge-base --is-ancestor "\$GITHUB_SHA" (refs\/remotes\/)?origin\/main/,
    );
    expect(releaseWorkflow).toMatch(/docker manifest inspect/);
    expect(releaseWorkflow).toMatch(/@sha256:/);
    // install.sh dan CLI memverifikasi tanda tangan bila cosign terpasang.
    expect(cli).toMatch(/cosign verify-blob/);
    expect(read('deploy/install.sh')).toMatch(/cosign verify-blob/);
  });

  // P2-R3: repo privat + persist-credentials: false → `git fetch` di job rilis gagal autentikasi.
  it('P2-R3: job rilis tidak mengambil ulang dari remote (cukup fetch-depth: 0)', () => {
    expect(code(releaseWorkflow)).not.toMatch(/git fetch/);
    expect(releaseWorkflow).toMatch(/fetch-depth: 0/);
  });

  // P2-R1: shebang harus baris pertama skrip firewall; unit systemd memanggil lewat /bin/sh.
  it('P2-R1: contoh skrip firewall diawali shebang dan unit memakai /bin/sh', () => {
    const block = /```bash\n {3}#!\/bin\/sh\n {3}# \/usr\/local\/sbin\/balesin-firewall\.sh/.exec(
      deployDoc,
    );
    expect(block).not.toBeNull();
    expect(deployDoc).toMatch(/ExecStart=\/bin\/sh \/usr\/local\/sbin\/balesin-firewall\.sh/);
    expect(deployDoc).toMatch(/nftables/);
  });

  // P2-R2: installer memasang cosign versi dipin dengan checksum.
  it('P2-R2: installer memasang cosign versi dipin + checksum', () => {
    const installer = read('deploy/install.sh');
    expect(installer).toMatch(/^readonly COSIGN_VERSION="v\d+\.\d+\.\d+"$/m);
    expect(installer).toMatch(/^readonly COSIGN_SHA256_AMD64="[0-9a-f]{64}"$/m);
    expect(installer).toMatch(/^readonly COSIGN_SHA256_ARM64="[0-9a-f]{64}"$/m);
    expect(installer).toMatch(/sha256sum "\$tmp"/);
  });

  it('Info: konfigurasi vitest tidak ikut image', () => {
    expect(read('.dockerignore')).toMatch(/^\*\*\/vitest\*\.config\.ts$/m);
  });
});
