# Panduan Operasional Deploy — Balesin Self-Hosted

Untuk admin server yang memasang dan merawat Balesin. Keputusan di balik desain ini ada di
`docs/DECISIONS.md` (cari "Fase 7"); arsitektur umum di `docs/ARCHITECTURE.md` §5.

## 1. Gambaran

```
internet ─HTTPS─► [proxy depan]                         ─► web:8080 (gateway)  ─► api:3000
                  A: nginx perusahaan (mis. vm-nginx)       berkas PWA statis       REST + WebSocket
                  B: caddy bawaan (80/443, Let's Encrypt)   /api /webhooks           │
                  C: cloudflared (tanpa port terbuka)       /health /ready           ▼
                                                                         postgres, redis (jaringan
                                                         worker ─────────► internal, tanpa port)
                                                         (antrian: kirim pesan, email, webhook)
```

| Container | Image | Catatan |
|---|---|---|
| `web` | `<prefix>-web` | nginx tanpa root: berkas PWA + gateway ke api. **Satu-satunya port aplikasi** (`BALESIN_BIND_ADDRESS:BALESIN_HTTP_PORT`). Memasang CSP & header keamanan halaman |
| `api` | `<prefix>-api` | Fastify. Juga berisi perintah `migrate` dan `reset-owner-password` |
| `worker` | `<prefix>-worker` | BullMQ. Berbagi volume media dengan api |
| `migrate` | `<prefix>-api` | Sekali jalan sebelum api: migrasi + peran database runtime |
| `postgres` | `postgres:16.15-alpine3.24` | Volume `pgdata` |
| `redis` | `redis:7.4.12-alpine3.22` | Password, AOF, `noeviction` |
| `caddy` | `caddy:2.11.9-alpine` | Hanya mode B |
| `cloudflared` | `cloudflare/cloudflared:2026.11.0` | Hanya mode C |

Semua container aplikasi berjalan **non-root**, filesystem **hanya-baca** (+ `/tmp` tmpfs), tanpa
capability Linux, `no-new-privileges`. Postgres dan Redis hanya di jaringan Docker `data`
(`internal: true`): tidak bisa dijangkau dari host, LAN, maupun internet.

Folder instalasi `/opt/balesin`:

| Berkas | Isi |
|---|---|
| `.env` | **Semua** rahasia + konfigurasi infrastruktur (izin 600). Satu-satunya tempat rahasia |
| `docker-compose.yml`, `Caddyfile` | Dari rilis (jangan diedit; tertimpa saat update) |
| `balesin` | CLI (ditautkan ke `/usr/local/bin/balesin`) |
| `backups/` | Backup terenkripsi + `.sha256` (izin 700) |
| `logs/` | Log backup harian dan log update yang gagal |

## 2. Prasyarat server

- Ubuntu 24.04 LTS (disarankan; Debian juga), x86_64 atau arm64.
- Sky Tech: 4 vCPU, 8 GB RAM, 80 GB disk. Minimum produk: 2 vCPU, 2 GB RAM, 20 GB.
- Docker Engine + plugin Compose ≥ 2.24 (installer menawarkan memasangnya), `openssl`, `curl`.
- Mode A: IP privat cukup; reverse proxy perusahaan bisa menjangkau port Balesin.
  Mode B: IP publik, port 80/443 terbuka, DNS A record ke server. Mode C: domain di Cloudflare.

## 3. Instalasi

```bash
curl -fsSL <URL-rilis>/install.sh | sudo bash
```

Installer (bahasa Indonesia, 8 langkah) akan: memeriksa prasyarat → menyiapkan `/opt/balesin` →
menanyakan **mode jaringan** → membuat **rahasia acak** (`BALESIN_MASTER_KEY`, `SESSION_SECRET`,
`SETUP_TOKEN`, password Postgres pemilik + peran runtime, password Redis, `BACKUP_PASSPHRASE`) →
mengunduh berkas rilis (checksum diperiksa) → menarik image → menyalakan layanan (migrasi otomatis)
→ memasang backup harian 02:30 (`/etc/cron.d/balesin`) → menampilkan **URL wizard + token setup**.

Pertanyaan per mode:

| Mode | Ditanyakan | Diisi otomatis |
|---|---|---|
| A — reverse proxy | domain, **IP privat reverse proxy**, IP VM yang didengar, port (8080) | `TRUST_PROXY` = IP gateway + IP proxy |
| B — Caddy | domain, email Let's Encrypt (opsional) | port 80/443 di Caddy, `COMPOSE_PROFILES=caddy` |
| C — Cloudflare Tunnel | domain, token tunnel | `COMPOSE_PROFILES=tunnel` |

**Idempoten**: menjalankan ulang `install.sh` tidak pernah mengganti rahasia yang sudah ada dan
tidak menaikkan versi (pakai `balesin update`). Variabel tambahan yang diisi admin di `.env`
(mis. `SMTP_*` cadangan) dipertahankan. Ubah mode/IP proxy: `sudo bash install.sh --ubah-jaringan`.

Tanpa pertanyaan (otomasi): lihat kepala `install.sh` (`BALESIN_MODE`, `BALESIN_DOMAIN`,
`BALESIN_UPSTREAM_PROXY`, `BALESIN_ASSUME_YES=1`, …).

### 3.1 Mode A untuk Sky Tech (vm-nginx)

1. **VM Balesin** (IP privat, mis. `10.0.0.20`): jalankan installer, mode **A**, domain
   `balesin.skytech.net.id`, IP reverse proxy = IP privat vm-nginx, IP VM = `10.0.0.20`, port 8080.
2. **Firewall VM Balesin.** Port container yang dipublikasikan Docker di-DNAT sebelum rantai `INPUT`,
   jadi **aturan ufw TIDAK berlaku untuk port 8080**. Batasi lewat rantai `DOCKER-USER` (diperiksa
   Docker sebelum aturannya sendiri). Installer menolak bind `0.0.0.0`/IP publik di mode A; aturan
   di bawah memastikan hanya vm-nginx yang bisa menjangkau port itu walau dari LAN:
   ```bash
   # /usr/local/sbin/balesin-firewall.sh  (ganti 8080 dan IP vm-nginx)
   #!/bin/sh
   set -e
   PORT=8080; PROXY=<IP-privat-vm-nginx>
   iptables -N BALESIN-GATEWAY 2>/dev/null || iptables -F BALESIN-GATEWAY
   iptables -A BALESIN-GATEWAY -s "$PROXY" -j RETURN
   iptables -A BALESIN-GATEWAY -j DROP
   iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j BALESIN-GATEWAY 2>/dev/null ||
     iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j BALESIN-GATEWAY
   ```
   Jalankan otomatis setiap boot SETELAH Docker (unit systemd):
   ```ini
   # /etc/systemd/system/balesin-firewall.service
   [Unit]
   Description=Batasi port gateway Balesin ke reverse proxy
   After=docker.service
   Requires=docker.service
   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/balesin-firewall.sh
   RemainAfterExit=yes
   [Install]
   WantedBy=multi-user.target
   ```
   `chmod 700 /usr/local/sbin/balesin-firewall.sh && systemctl enable --now balesin-firewall`.
   **Verifikasi** dari host LAN lain (bukan vm-nginx): `curl -m 5 http://<IP-VM>:8080/health` harus
   *timeout*; dari vm-nginx harus `{"status":"ok"}`. SSH tetap dibatasi ufw seperti biasa
   (`ufw allow from <jaringan-manajemen> to any port 22 proto tcp`) — ufw berlaku untuk proses di host.
   Alternatif setara: firewall Proxmox/VLAN di depan VM.
3. **DNS** IDCloudHost: A record `balesin` → `198.15.25.13`.
4. **vm-nginx**: salin `deploy/nginx/balesin.conf` (rilis: `balesin-nginx.conf`) ke
   `/etc/nginx/conf.d/balesin.conf`, ganti `10.0.0.20:8080`. Ikuti urutan di kepala berkas: blok 443
   dikomentari dulu → `certbot certonly --webroot -w /var/www/certbot -d balesin.skytech.net.id` →
   aktifkan blok 443 → `nginx -t && systemctl reload nginx`. Perpanjangan otomatis certbot cukup
   memakai `--deploy-hook "systemctl reload nginx"`.
5. Periksa dari luar:
   ```bash
   curl -sI https://balesin.skytech.net.id/ | grep -iE 'strict-transport|content-security|x-frame'
   curl -s https://balesin.skytech.net.id/ready      # {"status":"ok",...}
   ```
6. Buka `https://balesin.skytech.net.id/setup`, masukkan token (`sudo balesin setup-token`).

Yang dilakukan contoh nginx: TLS 1.2/1.3 + HSTS 180 hari, `X-Forwarded-For` = alamat klien asli
(kiriman klien dibuang), `X-Forwarded-Proto`, WebSocket `/api/v1/inbox/stream` (timeout baca 1 jam,
`Origin` tidak disentuh), batas body (umum 8 MB, unggah media 101 MB dialirkan, webhook 4 MB),
batas laju (login/2FA/reset/setup 10/menit, webhook 50/dtk, API 30/dtk), log tanpa query string.
CSP & header keamanan lain datang dari gateway Balesin — **jangan** ditambahkan lagi di nginx.

### 3.2 Mode B (Caddy) dan C (Cloudflare Tunnel)

- **B**: DNS A record domain → IP publik server, buka port 80 & 443. Sertifikat dibuat otomatis saat
  container `caddy` pertama kali menerima domain itu. Log Caddy: `sudo balesin logs caddy`.
- **C**: di Cloudflare Zero Trust → Networks → Tunnels → buat tunnel (Cloudflared), salin token ke
  installer. Tambahkan **Public Hostname**: domain → Service `HTTP` → `web:8080`. Tidak ada port
  yang perlu dibuka. HSTS sudah dipasang gateway Balesin — biarkan HSTS di dasbor Cloudflare mati
  (atau samakan nilainya: `max-age=15552000; includeSubDomains`) supaya header tidak dobel.

## 4. Perintah `balesin`

| Perintah | Fungsi |
|---|---|
| `sudo balesin status` | Layanan + kesehatan + worker + peringatan setup/TRUST_PROXY + backup terakhir + disk |
| `sudo balesin logs [layanan] [-f]` | Log (200 baris terakhir; `BALESIN_LOG_TAIL=1000` untuk lebih) |
| `sudo balesin version` | Versi terpasang |
| `sudo balesin backup` | Backup database + media sekarang |
| `sudo balesin restore <berkas>` | Pulihkan (konfirmasi ketik `PULIHKAN`; backup pengaman otomatis dulu) |
| `sudo balesin update [versi]` | Update dengan backup + rollback otomatis |
| `sudo balesin reset-owner-password [email]` | Ganti password Owner dari server |
| `sudo balesin setup-token` | Tampilkan URL wizard + token setup |
| `sudo balesin start` / `stop` / `restart` | Nyalakan / hentikan / jalankan ulang |

Satu perintah pengubah (backup/restore/update/start/stop) berjalan dalam satu waktu (kunci
`flock`), jadi backup harian tidak bertabrakan dengan update.

## 5. Backup & restore

- Isi backup: `database.dump` (pg_dump format custom, termasuk audit log), `media.tar.gz` (volume
  media), `manifest.txt` (versi, waktu, jumlah migrasi).
- Format v2 (encrypt-then-MAC), tiga berkas per backup:
  - `….tar.enc` — dienkripsi `openssl enc -aes-256-cbc -pbkdf2 -iter 600000` dengan
    `BACKUP_PASSPHRASE` dari `.env` (passphrase lewat variabel lingkungan, tidak pernah di argumen);
  - `….tar.enc.hmac` — HMAC-SHA256 atas berkas terenkripsi, kunci diturunkan (HKDF) dari
    `BACKUP_PASSPHRASE`, dihitung di container api tanpa jaringan. **Restore memeriksa HMAC ini
    SEBELUM mendekripsi**: berkas yang diubah atau bukan buatan instalasi ini (passphrase lain)
    ditolak;
  - `….tar.enc.sha256` — hash biasa untuk mendeteksi kerusakan saat menyalin.
  Backup tidak dibuat sama sekali bila `BACKUP_PASSPHRASE` kosong; arsip `.tar` polos dan backup
  tanpa `.hmac` ditolak saat restore. Retensi `BACKUP_RETENTION_DAYS` (14 hari).
- Salin ketiga berkas bersama-sama ke penyimpanan luar server.
- **Wajib**: salin backup ke luar server (mis. `rsync` harian ke NAS/penyimpanan lain), dan simpan
  salinan `.env` di tempat aman terpisah (password manager). Tanpa `BALESIN_MASTER_KEY`, kredensial
  tersimpan (token Meta, SMTP) tidak bisa dibuka; tanpa `BACKUP_PASSPHRASE`, backup tidak bisa dibuka.
- **Uji restore** minimal sebulan sekali di server staging: pasang Balesin dengan `.env` yang sama
  (salin `.env` sebelum `install.sh`), lalu `sudo balesin restore <berkas>`.
- Restore: periksa HMAC → dekripsi → `pg_restore` (tanpa owner/ACL) ke database SEMENTARA
  `<db>_pulih` sementara layanan masih berjalan → bila berhasil, hentikan api/worker/web dan tukar
  nama (`<db>` → `<db>_sebelum_pulih`, `<db>_pulih` → `<db>`) → ganti isi volume media (diekstrak
  ke folder sementara dulu) → kosongkan Redis (antrian lama) → migrasi + hak peran runtime →
  nyalakan → cek sehat → baru `<db>_sebelum_pulih` dihapus. Dump rusak = database yang berjalan tidak
  tersentuh; layanan gagal sehat = database lama masih ada untuk ditukar balik. Backup dari versi
  lebih baru dari yang terpasang ditolak (update dulu ke versi itu).

## 6. Update & rollback

`sudo balesin update` (atau `update 0.2.0`):

1. Pemeriksaan awal (disk ≥ 2 GB, Postgres berjalan), unduh berkas rilis versi baru + checksum.
2. **Backup** penuh (`…-sebelum-update-v<versi>.tar.enc`).
3. Tarik image versi baru (gagal → berhenti, tidak ada yang berubah).
4. **Migrasi** sebagai pemilik tabel (semua migrasi tertunda dalam SATU transaksi: gagal → batal
   seluruhnya, versi lama tetap berjalan tanpa restart).
5. Jalankan versi baru, tunggu semua container sehat + `/ready` lewat gateway + worker tersambung.
6. Berhasil → `BALESIN_VERSION` di `.env`, compose & CLI baru disimpan.

Gagal di langkah 5 → **rollback otomatis**: log container disimpan ke
`/opt/balesin/logs/update-gagal-<versi>-<waktu>.log`; bila skema database sudah berubah, database
dipulihkan dari backup langkah 2 (lewat database sementara + tukar nama, seperti restore); media tidak
disentuh; versi lama dinyalakan dan diperiksa. Turun versi lewat `update` ditolak — pakai restore.

**Risiko yang perlu diketahui saat rollback memulihkan database**: semua data yang masuk SETELAH
backup langkah 2 hilang — termasuk pesan WhatsApp/Telegram yang webhook-nya sudah dijawab 200 oleh
versi baru sebelum dinyatakan tidak sehat (Meta tidak mengirim ulang webhook yang sudah sukses).
Jendelanya biasanya beberapa menit. Mitigasi: jalankan update di jam sepi; setelah rollback, cek
percakapan terbaru di inbox dan WhatsApp Business Manager, lalu minta pelanggan yang terdampak
mengirim ulang bila perlu. Selama api lama/baru tidak berjalan, gateway menjawab 502 sehingga Meta
mencoba ulang webhook itu sendiri (tidak hilang).

Rilis resmi ditandatangani (cosign keyless dari workflow `rilis.yml`) dan `docker-compose.yml` rilis
merujuk image dengan **digest**. Installer dan `balesin update` memverifikasi tanda tangan
`SHA256SUMS` bila `cosign` terpasang di server; isi `BALESIN_REQUIRE_SIGNATURE=1` di `.env` untuk
mewajibkannya (disarankan setelah kanal rilis dibuka, lihat BUTUH-TOBING #18).

Diuji (Fase 7): update berhasil, layanan baru tidak sehat setelah migrasi baru (rollback memulihkan
skema & data), dan migrasi gagal (dibatalkan tanpa restart).

## 7. Pemulihan Owner (lupa password tanpa SMTP)

```bash
sudo balesin reset-owner-password            # satu Owner
sudo balesin reset-owner-password owner@perusahaan.co.id   # bila Owner lebih dari satu
```

Konfirmasi dengan mengetik `RESET`, lalu password baru diketik dua kali (tidak ditampilkan, dikirim
lewat stdin — tidak terlihat di daftar proses). Aturan password sama dengan aplikasi. Efeknya: semua
sesi Owner dicabut, kunci login dilepas, tercatat di audit log (`Password diatur ulang`, metadata
`via: cli`, `serverRecovery: true`), dan Owner menerima email "Password diganti dari server" bila
email pengirim sudah diatur. **2FA tidak dimatikan** — Owner masuk dengan kode autentikator atau
kode cadangan.

## 8. Keamanan operasional

- `.env` = semua rahasia, izin 600 root. Jangan disalin ke tiket/chat. `BALESIN_MASTER_KEY` jangan
  pernah diganti setelah ada data.
- **Jangan menambahkan pengguna ke grup `docker`**: anggota grup itu setara root (bisa
  `docker inspect` semua rahasia di environment container, menjalankan perintah di container mana pun).
  Kelola server dengan `sudo`.
- **Hardening container**: api/worker/web/migrate non-root, read-only, tanpa capability; redis
  berjalan sebagai pengguna `redis`, read-only, tanpa capability; postgres read-only (+tmpfs) dengan
  capability minimal untuk entrypoint (CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID) lalu turun ke
  pengguna `postgres`. Image produksi tanpa source map.
- **Peran database**: `POSTGRES_USER` (pemilik tabel) hanya dipakai migrasi/backup/restore;
  api & worker memakai `APP_DB_USER` (hak SELECT/INSERT/UPDATE/DELETE saja, `audit_logs` hanya
  SELECT/INSERT) — tidak bisa mengubah skema atau mematikan trigger audit.
- **TRUST_PROXY** = IP tetap gateway (`.10` di subnet Docker) + proxy di depannya (mode A: IP
  reverse proxy, CIDR minimal /16 dan disarankan IP tunggal; B: caddy `.11`; C: cloudflared `.12`).
  Gateway bridge Docker (alamat pertama rentang dinamis, `.128`) dan klien LAN tidak dipercaya. Salah isi → semua pengunjung tampak ber-IP sama (batas login/webhook per IP keliru);
  `balesin status` memperingatkan bila mode A tanpa IP proxy.
- **Log**: gateway dan contoh nginx mencatat path tanpa query string; api mencatat path saja.
- **CSP halaman web** (gateway): `script-src 'self'` tanpa inline; lihat komentar di
  `deploy/docker/gateway/security-headers.conf`.
- Perbarui OS (`unattended-upgrades`) dan Balesin secara rutin; image dikunci versinya dan
  diperbarui lewat PR Dependabot.

## 9. Pemecahan masalah

| Gejala | Periksa |
|---|---|
| Installer berhenti di "Menyalakan" | `sudo balesin logs migrate api` — pesan bahasa Indonesia menyebut variabel yang salah |
| Halaman 502 dari nginx perusahaan | `curl http://<IP-VM>:8080/ready` dari vm-nginx; firewall VM; `BALESIN_BIND_ADDRESS` |
| WebSocket putus tiap ±60 dtk | `proxy_read_timeout` di nginx depan harus > 30 dtk (contoh: 3600s) |
| Webhook Meta 413 | `client_max_body_size` `/webhooks/` di nginx depan ≥ 3m |
| Semua login kena batas laju bersama | `TRUST_PROXY`/`UPSTREAM_PROXY_IPS` — jalankan `install.sh --ubah-jaringan` |
| Owner lupa password, SMTP belum diatur | `sudo balesin reset-owner-password` |
| Update gagal | Sudah di-rollback otomatis; kirim `/opt/balesin/logs/update-gagal-*.log` ke tim Balesin |

## 10. Untuk pengembang

```bash
# Build image dari akar repo
docker build -f deploy/docker/Dockerfile --target api    -t balesin-uji/balesin-api:0.1.0 .
docker build -f deploy/docker/Dockerfile --target worker -t balesin-uji/balesin-worker:0.1.0 .
docker build -f deploy/docker/Dockerfile --target web    -t balesin-uji/balesin-web:0.1.0 .

# Stack produksi uji di port lain (tidak bentrok dengan dev), image lokal, tanpa pertanyaan
sudo BALESIN_HOME=/tmp/balesin-uji BALESIN_MODE=A BALESIN_DOMAIN=balesin.uji.example \
  BALESIN_UPSTREAM_PROXY=192.0.2.10 BALESIN_BIND_ADDRESS=127.0.0.1 BALESIN_HTTP_PORT=18080 \
  BALESIN_APP_URL=http://localhost:18080 BALESIN_PROJECT_NAME=balesin-uji \
  BALESIN_IMAGE_PREFIX=balesin-uji/balesin BALESIN_VERSION=0.1.0 BALESIN_NO_PULL=1 \
  BALESIN_ASSUME_YES=1 BALESIN_SKIP_LINK=1 bash deploy/install.sh
# Bersihkan
sudo docker compose -p balesin-uji down -v
```

- Windows: jalankan skrip dari container Linux (`docker:cli` + `bash`) dengan socket Docker
  di-mount — Git Bash mengubah path berawalan `/`.
- CI (`.github/workflows/ci.yml` job `deploy`): shellcheck, build 3 image, `nginx -t`, install.sh
  sungguhan, cek header/kesehatan/wizard, backup → restore.
- **Rilis**: tag `vX.Y.Z` di `main` → `.github/workflows/rilis.yml` membangun & mendorong image ke
  GHCR dan membuat GitHub Release berisi `install.sh`, `docker-compose.yml`, `Caddyfile`, `balesin`,
  `balesin-nginx.conf`, `VERSION`, `SHA256SUMS`.

## 11. Catatan rilis

- **Migrasi 0007** (2FA wajib): Admin/Supervisor lama yang belum mendaftar 2FA lebih dari 72 jam
  langsung tertutup pendaftarannya setelah update — Owner membuka lagi lewat "Buka lagi pendaftaran
  2FA" di Tim.
- Production wajib `BALESIN_MASTER_KEY`, `SESSION_SECRET`, `APP_URL` https (installer mengisinya).
