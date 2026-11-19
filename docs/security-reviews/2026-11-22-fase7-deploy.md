# Review keamanan — Fase 7: Produk self-hosted (image, compose, gateway, installer, CLI, rilis)

- Commit: `9779996` (`feat(deploy): Fase 7 — compose produksi, image non-root, install.sh, CLI balesin, nginx vm, pemulihan Owner`),
  `2a09122` (bit eksekusi), CLI api dari `c53f52e` (`apps/api/src/cli/*`)
- Acuan: `docs/SECURITY.md` §3, §8, §9; `docs/ARCHITECTURE.md` (mode A/B/C); `docs/DEPLOY.md`;
  DECISIONS 2026-11-22 "Fase 7 — …" + catatan devops lama (TRUST_PROXY, pg_trgm, WS/Origin, sw.js, CSP,
  query string media, MEDIA_DIR); BUTUH-TOBING #18–#19
- Peninjau: subagent `security`
- Model ancaman: (1) akun CS curian yang ingin memakai nomor WhatsApp untuk spam/penipuan atau mencuri
  token Meta — di lapisan deploy berarti: memalsukan IP (lolos batas laju), membaca rahasia dari image/log,
  menyerang gateway; (2) host lain di LAN VM (mode A) yang menjangkau port aplikasi langsung;
  (3) pihak yang bisa menulis ke penyimpanan backup di luar server; (4) rantai pasok rilis (registry/tag,
  akun GitHub); (5) operator dengan akses shell/Docker (dianggap sudah memegang semua data).

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi. 4 Sedang, 4 Rendah, beberapa Info. Sedang wajib dijadwalkan sebelum
instalasi pelanggan pertama di luar Sky Tech (S3 sebaiknya sebelum deploy Sky Tech BUTUH-TOBING #19 —
cukup perubahan dokumen + satu aturan iptables).

---

## A. Yang diperiksa dan lolos (diuji di stack produksi lokal)

Stack uji: image dibangun dari snapshot `HEAD` bersih (`git archive`), `install.sh` mode A dijalankan
sungguhan di container runner (`docker:cli` + bash, soket Docker) — proyek `balesin-sec`, port
`127.0.0.1:28480`, subnet `172.31.250.0/24`. Container `balesin-dev-*` tidak disentuh.

| Area | Bukti | Hasil |
|---|---|---|
| Container aplikasi | `deploy/docker-compose.yml:27-32` (`x-hardened`), `docker inspect` | migrate/api/worker/web: user `node`/`101`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`; `/app` milik root (tulis ditolak), hanya `/data/media` (0700 node) dan tmpfs yang bisa ditulis; tanpa berkas SUID |
| Isi image | `deploy/docker/Dockerfile:44-52,67-101`, `docker history` | multi-stage; tanpa devDependencies (vitest/vite/picomatch/esbuild/typescript/drizzle-kit tidak ada di `/app/node_modules/.pnpm`, 167 paket); tidak ada ARG/ENV/layer berisi rahasia; web tanpa `.map` publik; base image dikunci tag lengkap (digest menyusul — lihat S4) |
| Jaringan | `deploy/docker-compose.yml:237-247`, uji dari dalam container | `data` `internal: true`: postgres tidak bisa ke internet ("Network unreachable"); gateway tidak bisa me-resolve `postgres`/`redis`; hanya `web` yang punya `PortBindings` (`127.0.0.1:28480`) |
| Rahasia | `install.sh:337-446`, `balesin:73-95`, log & `docker top` | `.env` 600 root, folder 750, `backups/`/`logs/` 700, compose/Caddyfile 600; CLI tidak pernah `source .env`; 7 nilai rahasia tidak muncul di log container mana pun maupun di log healthcheck; `docker top`: redis tampil `redis-server *:6379` (password tidak di argumen), passphrase backup lewat `-pass env:` |
| Idempoten | `install.sh` dijalankan ulang | hash 7 rahasia identik sebelum/sesudah; variabel tambahan admin dipertahankan; izin tetap 600 |
| XFF palsu & TRUST_PROXY | `install.sh:316-320`, `gateway/proxy-api.conf:181`, log api | `X-Forwarded-For: 6.6.6.6` + `X-Real-IP` palsu → api mencatat IP asli (`172.31.250.128`); TRUST_PROXY = `172.31.250.10,<proxy>` saja; `/0` ditolak di production (`apps/api/src/config.ts:89-104`); vm-nginx menimpa XFF dengan `$remote_addr` (`deploy/nginx/balesin.conf:101`); Caddy bawaan tidak memercayai XFF klien |
| Log tanpa query | `gateway/nginx.conf:39-42`, `nginx/balesin.conf:33-34,155-159` | `?sig=RAHASIA…` pada `/api/v1/…` dan `/api/public/media/…` tidak ada di log gateway maupun api (0 kemunculan); log memakai `$uri` |
| WebSocket | `gateway/nginx.conf:115-120`, `proxy-api.conf:186-188`, `nginx/balesin.conf:105-108` | Upgrade/Connection diteruskan, `Origin` tidak pernah ditimpa, `proxy_read_timeout 3600s` |
| Header web | `curl -I /` | CSP lengkap sekali, `X-Frame-Options DENY`, nosniff, Referrer-Policy, Permissions-Policy, COOP; HSTS hanya bila `X-Forwarded-Proto: https`; respons `/api` membawa header helmet sendiri (`default-src 'none'`). Mode A: HSTS dari belakang disembunyikan vm-nginx lalu dipasang sekali |
| CSP `style-src-elem 'unsafe-inline'` | `gateway/security-headers.conf:196-208` | Risiko diterima: skrip tetap `'self'` tanpa inline/eval; `img-src`/`font-src`/`connect-src` hanya origin sendiri (+`data:`/`blob:`) sehingga CSS sisipan tidak punya jalur kirim data ke luar; serangan CSS baru relevan bila ada injeksi HTML (React meng-escape; email HTML di iframe sandbox). Sisa risiko: tampilan palsu/overlay bila suatu saat ada injeksi HTML — tetap Info, nonce bisa menyusul |
| Batas body | `curl` tanpa sesi | unggah media 60 MB tanpa sesi → api memutus 401 setelah ±768 KB (tidak menampung 101 MB); webhook > 4 MiB → 413 di gateway |
| `/health` `/ready` | `curl` | `{"status":"ok"}` dan `{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}}` — tanpa versi/host/galat |
| Batas laju login (mode A) | `nginx/balesin.conf:26,127-132` | regex mencocokkan rute nyata (`auth/login`, `auth/2fa/verify`, `auth/password-reset/*`, `auth/invitation/accept`, `setup/verify-token|complete` — dicek terhadap `packages/shared/src/api-routes.ts`); 10/menit + burst 10, body 64k. Mode B/C mengandalkan batas laju aplikasi (per IP + per akun) |
| Peran DB | `apps/api/src/cli/db-roles.ts`, stack uji | `balesin_app`: bukan superuser/createrole/createdb/bypassrls; hak di 53/53 tabel; `audit_logs` hanya SELECT+INSERT; tanpa akses skema `drizzle`; nama peran/password divalidasi regex sebelum dirangkai ke SQL (tes injeksi ada); tidak ada fungsi `SECURITY DEFINER` |
| Pemulihan Owner | `owner-recovery.ts`, `reset-owner-password.ts`, `balesin:625-648` | konfirmasi `RESET` + TTY wajib; password via stdin (`printf` builtin, tidak di argumen/env); aturan password web; sesi dicabut + tantangan 2FA dibuang + kunci login dilepas; audit `via: cli`, pelaku `null`; 2FA tidak dimatikan; dijalankan dengan peran runtime (DML). Diuji lewat pty: sebelum setup → pesan "Wizard setup belum diselesaikan" |
| Unduhan rilis | `install.sh:460-470`, `balesin:339-354` | `curl --proto '=https' --tlsv1.2`, berkas diperiksa `SHA256SUMS`; versi target divalidasi regex; turun versi ditolak |
| CI | `.github/workflows/ci.yml`, `rilis.yml`, `.github/actions/*` | `permissions: contents: read` di tingkat workflow; rilis hanya `contents/packages: write` di job; semua action dipin SHA (checkout, upload-artifact, pnpm/action-setup, setup-node); `persist-credentials: false`; token ke `docker login --password-stdin`, nilai dari `env:` (bukan interpolasi `${{ }}` di skrip) |
| shellcheck | `koalaman/shellcheck:v0.11.0 -x install.sh balesin` | bersih |

---

## B. Temuan

### S1 (Sedang) — Redis berjalan sebagai root dengan capability bawaan Docker

- Bukti: `deploy/docker-compose.yml:91-94` — `command: [sh, -c, exec redis-server …]`. Entrypoint image
  redis hanya menurunkan hak ke pengguna `redis` bila argumen pertama `redis-server`; karena argumen
  pertama `sh`, penurunan hak dilewati. Di stack uji: `/proc/1/status` → `Uid: 0 0 0 0`,
  `CapEff: 00000000a80425fb` (CHOWN, DAC_OVERRIDE, SETUID, NET_RAW, MKNOD, …). Layanan `redis` dan
  `postgres` juga tanpa `cap_drop`/`read_only` (`:80-102`, `:55-78`).
- Dampak: bertentangan dengan SECURITY §9 dan klaim "image non-root". Redis hanya terjangkau dari api/worker
  (jaringan `data`, berpassword), jadi pemanfaatan butuh pijakan di api lebih dulu — tetapi celah Lua/
  modul Redis (kelas CVE-2025-49844) langsung memberi root di container dengan permukaan escape yang lebih
  besar.
- Perbaikan: tambahkan `user: redis` (uid 999; volume `/data` milik `redis` di image) — `sh -c` tetap
  boleh, password tetap dari env — plus `cap_drop: [ALL]` dan `read_only: true` + `tmpfs: /tmp` untuk
  redis. Untuk postgres: `cap_drop: [ALL]` + `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]`
  (dibutuhkan entrypoint saat init). Uji ulang `balesin start` + backup/restore.
- Tes: `it.fails` "S1: Redis berjalan sebagai pengguna non-root".

### S2 (Sedang) — Backup tidak diautentikasi: CBC tanpa MAC, `.sha256` tanpa kunci, arsip `.tar` polos diterima

- Bukti: `deploy/balesin:255-269` (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`, lalu `sha256sum`
  biasa), `:283-303` (`open_backup`).
  1. **Arsip polos diterima**: `*.tar)` di `:299` dipulihkan tanpa peringatan apa pun. Diuji: arsip `.tar`
     buatan sendiri + `.sha256` hasil hitungan sendiri → `balesin restore … --yes` → "Pemulihan selesai".
     Passphrase tidak berperan sama sekali.
  2. **`.sha256` bisa menunjuk berkas lain**: `sha256sum -c` memeriksa NAMA yang tertulis di dalam berkas
     `.sha256`. Diuji: berkas sampah `balesin-palsu.tar` + salinan `.sha256` milik backup sah → pemeriksaan
     lolos, restore lanjut sampai `tar` gagal.
  3. **CBC dapat diubah tanpa kunci**: 1 byte ciphertext diubah + `.sha256` dihitung ulang → `openssl enc -d`
     keluar 0, `tar -t` keluar 0, isi berbeda dari aslinya (hanya zlib di dalam `pg_dump` yang mungkin
     menangkapnya).
- Dampak: siapa pun yang bisa menulis ke penyimpanan backup di luar server (NAS/rsync — DEPLOY §5
  mewajibkan salinan di luar server) bisa menyiapkan "backup" yang, bila dipilih operator saat restore,
  memasang database pilihannya: akun Owner dengan password yang ia tahu (ambil alih aplikasi + nomor WA),
  atau arsip custom-format yang dijalankan `pg_restore` sebagai SUPERUSER (`COPY … TO PROGRAM` → eksekusi
  perintah di container postgres). Butuh operator memilih berkas itu + mengetik `PULIHKAN`, maka Sedang.
- Perbaikan:
  - Tambahkan MAC berkunci: mis. `openssl dgst -sha256 -mac HMAC -macopt hexkey:<kunci turunan
    BACKUP_PASSPHRASE>` atas berkas `.tar.enc` disimpan sebagai `.hmac`, diverifikasi SEBELUM dekripsi
    (atau ganti ke `age`/AEAD). `.sha256` boleh tetap untuk deteksi kerusakan.
  - `open_backup`: tolak `.tar` polos kecuali opsi eksplisit (`--izinkan-tanpa-enkripsi`) + peringatan besar;
    `do_backup` sebaiknya GAGAL (bukan hanya `warn`) bila `BACKUP_PASSPHRASE` kosong.
  - Periksa checksum dengan membandingkan hash `$file` sendiri (`sha256sum "$file"` lalu bandingkan
    dengan kolom pertama `.sha256`), bukan `sha256sum -c`.
  - Tampilkan manifest (tanggal, versi, ukuran, label) sebelum konfirmasi `PULIHKAN` (sudah sebagian).
- Tes: dua `it.fails` "S2: …".

### S3 (Sedang) — Mode A: contoh firewall `ufw` tidak membatasi port gateway (Docker melewati ufw)

- Bukti: `docs/DEPLOY.md:82-88` (`ufw allow from <IP-privat-vm-nginx> to any port 8080`), BUTUH-TOBING #19
  langkah (2), `install.sh:533` ("Firewall VM ini: port … hanya dari …"). Port yang dipublikasikan Docker
  di-DNAT di `PREROUTING` dan lewat rantai `FORWARD`/`DOCKER`, bukan `INPUT` milik ufw — aturan ufw itu
  tidak berpengaruh (perilaku Docker terdokumentasi: "Docker and ufw"). `install.sh:270-273` juga memakai
  IP pertama `hostname -I` sebagai bawaan bind (bisa IP publik bila VM punya) dan menerima `0.0.0.0`.
- Dampak: setiap host yang bisa menjangkau IP privat VM (LAN kantor/ISP) bisa memakai gateway langsung
  lewat HTTP polos: melewati TLS dan batas laju login vm-nginx (10/menit), dan bisa mengirim
  `X-Forwarded-Proto: https` (gateway meneruskan nilai klien, `gateway/nginx.conf:63-66`). Batas laju aplikasi
  tetap per IP asli (host LAN tidak dipercaya TRUST_PROXY), jadi tidak sampai pemalsuan IP. Tetapi syarat
  SECURITY §9 "hanya proxy (vm-nginx) yang boleh menjangkau port aplikasi" tidak terpenuhi, dan dokumen
  memberi rasa aman palsu.
- Perbaikan:
  - DEPLOY.md §3.1 + BUTUH-TOBING #19: ganti contoh dengan aturan rantai `DOCKER-USER` yang persisten, mis.
    `iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL ! -s <IP-vm-nginx> -j DROP`
    (simpan lewat `iptables-persistent`/unit systemd), lalu verifikasi dari host LAN lain (`curl` harus
    timeout). Alternatif: firewall Proxmox/VLAN di depan VM.
  - `install.sh`: peringatkan (atau tolak tanpa konfirmasi) bila `BIND_ADDRESS` = `0.0.0.0` atau bukan IP
    privat RFC1918; `balesin status` bisa menampilkan IP bind.
- Tes: `it.fails` "S3: DEPLOY.md membatasi port gateway lewat rantai DOCKER-USER".

### S4 (Sedang) — Rantai pasok rilis: tag image bisa ditimpa, tanpa tanda tangan; checksum dari kanal yang sama

- Bukti: `.github/workflows/rilis.yml:10,43,55` — dipicu tag `v*` dari commit mana pun (tidak dibatasi ke
  `main`), `docker push` ke tag versi yang bisa ditimpa (tag git dihapus+dibuat ulang → image versi yang sama
  diganti diam-diam), tanpa cosign/attestation/SBOM; `docker login` dilakukan sebelum build. Compose
  merujuk image dengan tag (`docker-compose.yml:108,125,153,174`), bukan digest. `install.sh:460-469` dan
  `balesin:345-353`: `SHA256SUMS` diunduh dari URL yang sama dengan berkas yang diperiksanya — hanya
  mendeteksi kerusakan, bukan pemalsuan. `install.sh` sendiri dijalankan `curl | bash` tanpa verifikasi
  (wajar, tapi tidak ada jalur alternatif terverifikasi).
- Dampak: token/akun GitHub dengan hak tulis (atau kolaborator yang mendorong tag) bisa mendorong image
  berbahaya ke semua instalasi pelanggan lewat `balesin update`/pemasangan baru; image itu memegang
  `BALESIN_MASTER_KEY` → semua token Meta pelanggan. Belum aktif karena kanal rilis belum dibuka
  (BUTUH-TOBING #18), maka Sedang — wajib sebelum kanal dibuka.
- Perbaikan (berurutan dari termurah):
  1. Ruleset GitHub: lindungi tag `v*` (hanya Tobing, tanpa hapus/timpa); job rilis memeriksa commit tag
     ada di `main` (`git merge-base --is-ancestor`) dan memakai `environment: rilis` dengan reviewer wajib.
  2. Tolak menimpa: sebelum `docker push`, gagal bila `docker manifest inspect $PREFIX-$target:$VERSI` sudah ada.
  3. Tulis digest image ke `docker-compose.yml` rilis (`image: …@sha256:…`), sehingga `SHA256SUMS`
     sekaligus mengunci isi image.
  4. Tanda tangan keyless: `cosign sign` (izin `id-token: write`) untuk image + `cosign sign-blob` untuk
     `SHA256SUMS`, verifikasi di `install.sh`/`balesin update` bila `cosign` tersedia; atau
     `actions/attest-build-provenance`.
  5. `docker login` dipindah setelah build, tepat sebelum push.
- Tes: `it.fails` "S4: rilis menandatangani image/berkas".

### R1 (Rendah) — `.dockerignore` hanya berlaku di akar: `.env`, kunci, dan media dev di `apps/*` masuk image

- Bukti: `.dockerignore:113-124` (`.env*`, `*.pem`, `*.key`, `media`, `data` — semuanya hanya cocok di akar
  konteks); `Dockerfile:41,47,69` (`COPY apps apps` → `pnpm deploy` menyalin isi folder paket ke `/app`).
  Diuji pada snapshot: `apps/api/.env` dan `apps/api/kunci-uji.pem` muncul sebagai `/app/.env` (izin 755,
  terbaca semua pengguna) dan `/app/kunci-uji.pem` di image api AKHIR. `.env.example:89` `MEDIA_DIR=./media`
  (relatif ke `apps/api`) → media percakapan dev ikut masuk.
- Dampak: image rilis dari CI aman (checkout bersih), tetapi DEPLOY.md:214-223 menyuruh build image dari
  folder repo kerja; image lokal itu bisa membawa rahasia/media pelanggan (UU PDP) bila disimpan/dibagikan.
- Perbaikan: `**/.env*` + `!**/.env.example`, `**/*.pem`, `**/*.key`, `**/media`, `**/data`,
  `**/playwright-report`, `**/test-results`; dan/atau field `"files"` di `apps/api|worker/package.json`
  supaya `pnpm deploy` hanya menyalin yang perlu.
- Tes: `it.fails` "R1: .dockerignore membuang .env, kunci, dan media di folder mana pun".

### R2 (Rendah) — Validasi masukan installer

- Bukti: `install.sh:282` `ACME_EMAIL` tanpa validasi lalu disubstitusi Caddy `{$ACME_EMAIL}` di blok global
  (`deploy/Caddyfile:183`; substitusi env Caddy terjadi sebelum parsing → nilai berisi `}`/spasi bisa
  menyisipkan direktif); `:275` `HTTP_PORT` tanpa validasi; `:113-121` `UPSTREAM_PROXY_IPS` menerima CIDR
  sampai `/8` → seluruh LAN dipercaya dan bisa memalsukan `X-Forwarded-For`; variabel lingkungan otomasi
  (`BALESIN_ACME_EMAIL`, `BALESIN_APP_URL`) bisa berisi baris baru yang menyisipkan baris `.env`.
- Dampak: hanya root yang mengisi, jadi bukan batas hak; tetapi salah ketik bisa diam-diam melemahkan
  TRUST_PROXY.
- Perbaikan: regex email sederhana (`^[^@\s{}]+@[^@\s{}]+$`), port 1–65535, tolak CR/LF di semua nilai yang
  ditulis ke `.env`, peringatkan CIDR lebih lebar dari `/29` untuk proxy.

### R3 (Rendah) — Update/restore: jendela kehilangan data & database dihapus sebelum restore terbukti berhasil

- Bukti: `deploy/balesin:554-616` — backup dibuat SAAT api lama masih menerima webhook; bila rollback
  memulihkan database, pesan masuk yang sudah dijawab 200 ke Meta selama jendela update hilang permanen (Meta
  tidak mengirim ulang). Sudah disebut di DEPLOY.md:163, tetapi tanpa mitigasi. `:315-322` `dropdb --force`
  dijalankan sebelum `pg_restore` — bila dump rusak, database kosong dan layanan berhenti (rollback update
  memakai jalur yang sama tanpa backup pengaman).
- Perbaikan: selama update/restore jawab `/webhooks/` dengan 503 (Meta mencoba ulang hingga berjam-jam) —
  mis. berkas penanda yang dibaca gateway, atau hentikan api sebelum backup pra-update; restore ke database
  baru (`balesin_restore`) lalu `ALTER DATABASE … RENAME` setelah `pg_restore` sukses.

### R4 (Rendah) — Pemulihan Owner tanpa pemberitahuan ke Owner

- Bukti: `apps/api/src/cli/owner-recovery.ts:213-245` — hanya audit log; tidak ada email/notifikasi.
- Dampak: operator server (atau siapa pun di grup `docker`, yang bisa memanggil
  `docker compose exec api node dist/reset-owner-password.js` langsung tanpa konfirmasi `RESET`) bisa
  mengganti password Owner; 2FA tetap menahan login, tetapi Owner tidak tahu ada percobaan.
- Perbaikan: bila email pengirim aktif, kirim email "password Anda diganti dari server" (tanpa tautan) dan
  tampilkan banner di aplikasi saat Owner masuk berikutnya. Model ancaman sudah benar: pemegang shell/Docker
  setara root dan memegang semua data — tidak perlu proteksi lebih.

---

## C. Info

1. **Gateway jaringan `edge` = `.128`**, bukan `.1` seperti di DECISIONS/DEPLOY: dengan `ip_range` `.128/25`
   Docker memberi gateway alamat pertama rentang itu (`docker network inspect` → `"Gateway":"172.31.250.128"`).
   Tetap tidak dipercaya TRUST_PROXY — hanya koreksi dokumen.
2. **`read -rs password` tanpa `IFS=`** (`deploy/balesin:638,641`) memotong spasi di awal/akhir: password
   `"  abc…  "` tersimpan `"abc…"` lalu login dengan password yang diketik gagal. Pakai `IFS= read -rs`.
3. **HSTS mode C**: gateway memasang HSTS; bila HSTS juga diaktifkan di dasbor Cloudflare, header jadi dua.
   Tambahkan catatan di DEPLOY.md (biarkan HSTS Cloudflare mati, atau samakan nilainya).
4. **`docker inspect` menampilkan semua rahasia** di env container (sifat Docker). Anggota grup `docker` =
   root; DEPLOY §8 sebaiknya menegaskan jangan menambahkan pengguna ke grup `docker`.
5. **Source map di image api** (`dist/*.map`, `--enable-source-maps`) — tidak disajikan HTTP; hanya
   memperjelas jejak galat. Diterima.
6. **`ALTER ROLE … PASSWORD '…'`** (`db-roles.ts:74`) bisa tercatat di log Postgres bila pernyataan itu
   sendiri gagal (log `STATEMENT:`). Kecil; bisa memakai `\password`-style (kirim hash SCRAM yang dihitung
   di klien) bila ingin bersih sepenuhnya.
7. **CSP**: `frame-src 'self'` dibutuhkan pratinjau `srcdoc`; nonce untuk `<style>` bisa menggantikan
   `style-src-elem 'unsafe-inline'` kelak. `z.config({ jitless: true })` di web menghilangkan laporan
   `script-src eval` (sudah dicatat DECISIONS).
8. **`pnpm audit`**: 3 temuan lama (picomatch high — rantai vitest/vite, tanpa versi perbaikan;
   esbuild & minimatch moderate — dev). Tidak ada di image produksi (diperiksa).

---

## D. Tes penjaga

Berkas baru: `apps/api/src/cli/security-review-fase7-deploy.test.ts` — membaca teks berkas deploy:
11 `it` (hardening compose, hanya gateway yang membuka port, jaringan `data` internal, peran DB runtime,
USER non-root di Dockerfile, tanpa rahasia ARG/ENV, log tanpa query string, `Origin` tidak ditimpa,
vm-nginx menimpa XFF + HSTS sekali, CSP skrip ketat + tanpa jalur keluar CSS, batas body webhook,
passphrase lewat `env:`) + 6 `it.fails` (S1, S2×2, S3, S4, R1).

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `shellcheck -x install.sh balesin` (v0.11.0) | bersih |
| `docker build` 3 target dari snapshot `HEAD` | berhasil |
| `install.sh` mode A (runner `docker:cli`, image lokal, port 28480) | semua layanan sehat; dijalankan ulang → rahasia identik |
| `balesin backup` / `restore` (+ uji S2) | backup 600 + `.sha256`; temuan S2 terbukti |
| `balesin reset-owner-password` (pty) sebelum setup | ditolak dengan pesan yang benar |
| `vitest run src/cli` (db-roles, owner-recovery) | 9/9 lulus |
| `vitest run src/cli/security-review-fase7-deploy.test.ts` | 11 lulus + 6 `it.fails` sesuai harapan; prettier & eslint bersih |
| `pnpm audit` | 3 temuan lama (1 high dev-only, 2 moderate dev); tidak ada yang baru |

Stack uji (`balesin-sec`), runner, volume, jaringan, dan image `balesin-sec/*` dihapus setelah review.

---

# Putaran 2 — verifikasi perbaikan (commit `4301bd7`)

## Putusan putaran 2: **AMAN** — S1–S4 dan R1–R4 tertutup

Tidak ada temuan Kritis/Tinggi/Sedang tersisa. 3 Rendah baru/sisa (P2-R1–R3), beberapa Info.
Langkah operasional S4 (ruleset tag, reviewer environment `rilis`, keputusan keyless) tetap menunggu
BUTUH-TOBING #18 — kodenya sudah siap.

Cara uji: image dibangun dari snapshot `HEAD` (`4301bd7`, `git archive`) **dengan berkas umpan**;
`install.sh` mode A sungguhan di runner (proyek `balesin-sec2`, port 28480); uji firewall di
docker-in-docker terpisah (jaringan LAN tiruan `192.168.77.0/24`). Semua dibersihkan; `balesin-dev-*`
tidak disentuh.

## A. Verifikasi per temuan

| Temuan | Bukti / uji | Hasil |
|---|---|---|
| **S1** Redis/Postgres root | `docker-compose.yml:55-118`; `/proc/1/status` di stack uji | redis `Uid 999`, postgres `Uid 70`, api/worker `1000`, web `101`; **`CapEff 0000000000000000` di kelima container**; redis & postgres `ReadonlyRootfs=true`; postgres `CapAdd` hanya CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID (dipakai entrypoint lalu dibuang saat turun ke `postgres`); `docker top` redis → `redis-server *:6379` (999). **Tertutup** |
| **S2** backup tanpa autentikasi | `deploy/balesin:220-345`; skrip uji 9 skenario | (a) backup sah → restore berhasil; (b) `.tar` polos → "Arsip polos ditolak"; (c) `.tar.enc` tanpa `.hmac` → ditolak; (d) `.hmac` milik backup lain → "HMAC backup TIDAK cocok"; (e) 1 byte ciphertext dibalik (XOR) + `.sha256` dihitung ulang → HMAC ditolak **sebelum dekripsi**; (f) `.sha256` palsu dengan `.hmac` sah → "Checksum … tidak cocok" (hash berkas itu sendiri, bukan nama di dalam `.sha256`); (g) arsip + HMAC sah dari passphrase LAIN (instalasi lain) → ditolak. KDF PBKDF2 600 000 iterasi; kunci HMAC = HKDF-SHA256 terpisah (label `hmac-v2`), dihitung di `docker run --network none --read-only --cap-drop ALL`, passphrase lewat env (argv host hanya memuat nama variabel); ekstraksi dibatasi 3 nama anggota tar; backup tidak dibuat bila passphrase kosong. **Tertutup** |
| **S3** ufw vs Docker | `docs/DEPLOY.md:80-110`; `install.sh:289-313`; uji dind | Skrip `DOCKER-USER` dari DEPLOY.md dijalankan apa adanya (IP diganti) di host Docker 29.10 (iptables-nft): **sebelum** aturan, proxy & host LAN sama-sama terjangkau; **sesudah**, proxy `TERJANGKAU`, dua host LAN lain `TIDAK-TERJANGKAU`; skrip idempoten (dijalankan 2×: satu lompatan, rantai di-flush ulang); container gateway dibuat ulang → aturan tetap berlaku (`--ctorigdstport` mencocokkan port host, bukan IP container). Installer: `0.0.0.0` → "Bind 0.0.0.0 ditolak", `8.8.8.8` → "bukan IP privat"; bawaan = IP privat pertama VM; `balesin status` menampilkan alamat bind. **Tertutup** (lihat P2-R1 untuk bug salin-tempel unit systemd) |
| **S4** rantai pasok | `.github/workflows/rilis.yml`; `install.sh:507-560`; `balesin:426-466` | cek ancestry `main`, `environment: rilis`, build sebelum `docker login`, tolak tag image yang sudah ada, `cosign sign` atas DIGEST, compose rilis `…@sha256:` (dicek 4 baris), `cosign sign-blob --bundle` atas `SHA256SUMS`, `gh release create --verify-tag`; cosign-installer dipin SHA; identitas penanda tangan dibatasi regex `…/rilis.yml@refs/tags/vX.Y.Z` + issuer OIDC GitHub. Diuji tanpa cosign: `BALESIN_REQUIRE_SIGNATURE=1` + rilis tanpa bundle → "Rilis tanpa tanda tangan … ditolak"; bundle ada tetapi cosign tidak terpasang → "cosign tidak terpasang …" (gagal tertutup). Bawaan `0` = hanya peringatan (P2-R2). **Tertutup di kode**; ruleset/reviewer menunggu #18 |
| **R1** `.dockerignore` | build dengan umpan `apps/api/.env`, `apps/api/umpan.pem`, `apps/worker/umpan.key`, `apps/web/.env.local`, `apps/api/media/inbound/umpan.jpg`, `apps/api/data/umpan.txt` | tidak satu pun ada di image api/worker/web (`find / -xdev`); `packages/core/src/media` tetap ikut build (stack sehat); tanpa `*.map` di ketiga image. **Tertutup** |
| **R2** validasi installer | `install.sh:113-145,289-355,412-418` | ditolak: bind `0.0.0.0`/`8.8.8.8`, proxy `10.0.0.0/8` (< /16), port `99999`, `APP_URL` berisi `$(id)`, email ACME `a@b.co } import x {`, `BALESIN_IMAGE_PREFIX` berisi baris baru `TRUST_PROXY=0.0.0.0/1` ("mengandung baris baru/karakter kendali"); CIDR < /29 → peringatan. **Tertutup** |
| **R3** restore/rollback | `deploy/balesin:349-405,611-616,730-733` | restore sah → database baru (oid 16384 → 18354), `balesin_sebelum_pulih` dihapus setelah sehat; dump rusak dengan HMAC sah → `pg_restore` gagal → "Database yang berjalan TIDAK diubah", oid tetap 22294, `_pulih` dibuang, `/ready` ok; media diekstrak ke `.pulih` dulu. Risiko webhook selama rollback didokumentasikan (DEPLOY §6) — diterima. **Tertutup** |
| **R4** pemberitahuan Owner | `owner-recovery.ts`, `reset-owner-password.ts`, `packages/core/src/mail/templates.ts` | email `password_changed_by_server` diantrekan (tanpa tautan, menyebut 2FA tetap aktif), audit `serverRecovery: true`; kegagalan antrean tidak membatalkan reset dan dilaporkan ke operator. Banner ditunda (DECISIONS) — **diterima**: email + audit sudah memberi jejak; banner tinggal memetakan `metadata.serverRecovery` (lihat Info P2-3). **Tertutup** |
| Info 2/5 | `balesin:754-757`, `Dockerfile:42-45,81,90` | `IFS= read -rs`; source map & metafile dibuang, `--enable-source-maps` hilang |
| Tes penjaga | `security-review-fase7-deploy.test.ts`, `vitest.deploy.config.ts`, `ci.yml` | 6 `it.fails` → `it`; asersi lama dipertahankan atau diperketat (mis. S2 kini juga memeriksa urutan HMAC < `openssl enc -d` dan tidak ada `sha256sum -c`; S4 memeriksa ancestry, tolak-timpa, digest, verifikasi di install & CLI); tidak ada yang dilonggarkan. `test:deploy` 20/20 lulus dan masuk CI |

## B. Temuan putaran 2

### P2-R1 (Rendah) — Contoh skrip firewall: baris komentar di atas shebang → unit systemd gagal

- Bukti: `docs/DEPLOY.md:87-88` — blok kode dimulai `# /usr/local/sbin/balesin-firewall.sh (ganti …)`
  lalu `#!/bin/sh` di baris KEDUA. Bila disalin utuh ke berkas, `ExecStart=/usr/local/sbin/balesin-firewall.sh`
  gagal `Exec format error` (systemd memakai `execve` tanpa jatuh ke `/bin/sh`), sehingga aturan tidak
  terpasang setelah reboot. `systemctl enable --now` langsung memperlihatkan kegagalan, dan langkah
  verifikasi dari host LAN akan menangkapnya — maka Rendah.
- Perbaikan: taruh `#!/bin/sh` di baris pertama blok (judul berkas di luar blok kode), atau
  `ExecStart=/bin/sh /usr/local/sbin/balesin-firewall.sh`. Pertimbangkan menyertakan skrip + unit sebagai
  berkas rilis (`balesin firewall --pasang <ip>`) supaya tidak bergantung salin-tempel.

### P2-R2 (Rendah) — Verifikasi tanda tangan rilis bawaan opsional (bisa dilucuti)

- Bukti: `install.sh:514-524`, `balesin:448-458` — `BALESIN_REQUIRE_SIGNATURE` bawaan `0`: tanpa
  `SHA256SUMS.sigstore.json` atau tanpa cosign hanya `warn`. Pihak yang bisa mengganti aset rilis cukup
  menghapus bundle.
- Dampak: perlindungan S4 di sisi server baru berlaku bila operator memasang cosign dan menyalakan wajib.
  Pengerasan di sisi workflow (main-only, reviewer, tag tak bisa ditimpa) tetap mengurangi risiko utama.
- Perbaikan: setelah rilis pertama bertanda tangan, jadikan `1` bawaan untuk instalasi baru dan pasang
  cosign oleh installer (biner versi terkunci + checksum di skrip), atau sematkan kunci publik cosign
  berkunci di `install.sh`.

### P2-R3 (Rendah) — `rilis.yml`: `git fetch origin main` tanpa kredensial di repo privat

- Bukti: `.github/workflows/rilis.yml:37-42` — `persist-credentials: false` lalu `git fetch --no-tags origin
  main`. Di repo privat fetch ini gagal autentikasi → langkah gagal → **rilis selalu berhenti** (gagal
  tertutup, bukan celah). `fetch-depth: 0` sudah mengambil `origin/main`, jadi fetch kedua tidak perlu.
- Perbaikan: hapus baris `git fetch`, atau beri `GH_TOKEN` hanya ke langkah itu
  (`git -c http.extraheader=…`). Uji dengan tag rilis-coba di fork/privat sebelum `v0.1.0`.

## C. Info putaran 2

1. **Replay backup lama**: backup sah lama yang diganti nama (`balesin-2999…`) tetap diterima — HMAC
   mengikat isi, bukan nama. Tanggal & versi dari manifest (di dalam data terautentikasi) ditampilkan
   sebelum konfirmasi `PULIHKAN`, jadi operator melihatnya. Diterima.
2. **TOCTOU HMAC → dekripsi**: berkas dibaca dua kali (HMAC lalu `openssl enc -d`). Relevan hanya bila
   restore langsung dari penyimpanan yang bisa ditulis pihak lain (NAS ter-mount). Saran: salin ke folder
   kerja 700 dulu, lalu verifikasi + dekripsi dari salinan. `backups/` lokal (700 root) aman.
3. **Banner Owner** (R4 sisa) — catat di ROADMAP supaya tidak hilang; jenis `owner_password_reset_server`.
4. **Password Redis di `docker inspect` `.Args`** (sekarang interpolasi compose) — setara paparan env
   (`REDISCLI_AUTH` sudah ada di env); `/proc/1/cmdline` di container hanya `redis-server *:6379`.
5. **`docker manifest inspect` gagal tertutup?** Tidak: galat jaringan/autentikasi dianggap "belum ada" →
   push berjalan. Dampak kecil (GHCR menolak tanpa login yang sudah dilakukan); bisa dibedakan dari
   "manifest unknown" bila ingin ketat.
6. `apps/api/vitest.deploy.config.ts` ikut `/app` di image api (salinan `pnpm deploy`) — tidak berbahaya;
   bisa ditambahkan ke daftar `rm` di Dockerfile.
7. Docker dengan backend firewall `nftables` (eksperimental di Docker 29) tidak memakai rantai
   `DOCKER-USER` — DEPLOY.md bisa menyebut "backend iptables (bawaan)".

## D. Hasil perintah putaran 2

| Perintah | Hasil |
|---|---|
| `shellcheck -x install.sh balesin` (v0.11.0) | bersih |
| `docker build` 3 target dari snapshot `4301bd7` + umpan | berhasil; tanpa umpan & `.map` di image |
| `install.sh` mode A (runner, port 28480) | semua layanan sehat; 7 kasus masukan negatif ditolak |
| Skrip uji S2/R3 (9 skenario) | sesuai tabel A |
| Firewall `DOCKER-USER` di dind (Docker 29.10, iptables-nft) | proxy terjangkau, LAN tidak; idempoten |
| `pnpm --filter @balesin/api test:deploy` | 20/20 lulus |
| `vitest run src/mail/mail.test.ts` (core, template `password_changed_by_server`) | 69/69 lulus |
| `vitest run src/cli/owner-recovery.integration.test.ts` | tidak selesai dalam 500 dtk di mesin review (globalSetup/teardown Postgres bersama sedang lambat) — hasil diambil dari putaran devops/qa |

Stack `balesin-sec2`, runner, dind, jaringan LAN tiruan, volume, image uji, dan snapshot dihapus.
