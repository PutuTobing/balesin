# Audit akhir sebelum rilis 1.0 — Keamanan

- Tanggal review: 2026-11-21 (berkas audit bertanggal 2026-11-25, Fase 7 butir 6)
- Yang dinilai: branch `dev` commit **`ab1335f`** (snapshot bersih di worktree terpisah; perubahan belum
  di-commit di working tree utama diabaikan). Commit susulan **`6e0127e`** (perbaikan bot P4) dibaca
  diff-nya dan ikut dinilai (bagian E).
- Model ancaman: penyerang memegang satu akun CS yang dibobol dan ingin memakai nomor WhatsApp
  perusahaan untuk spam/penipuan, atau mencuri token Meta. Ditambah: orang dalam Admin, cookie curian,
  dan rantai pasok rilis.
- Cakupan: seluruh `docs/SECURITY.md` (setiap butir), 41 review per fitur di `docs/security-reviews/`,
  dan celah lintas modul.

## Putusan: **AMAN** (tidak ada Kritis/Tinggi)

Ada **1 temuan Sedang** baru dari jalur lintas modul (A1). Sebaiknya diperbaiki sebelum `v1.0.0`,
karena perbaikannya kecil dan menutup jalur spam dari akun CS. A1 dikunci dengan `it.fails` di
`apps/api/src/security-review-audit-akhir.integration.test.ts`. Selain itu ada 5 temuan Rendah dan
beberapa Info. Semua tes keamanan yang ada lulus, dan tidak ada `it.fails` lama yang tertinggal.

| ID | Level | Ringkas | Agen |
|---|---|---|---|
| A1 | **Sedang** | CS bisa mengirim template (termasuk MARKETING, variabel teks bebas) ke **semua** percakapan `resolved`, termasuk yang dibuat broadcast/API billing. Ini broadcast terselubung yang melewati maksud `inbox.initiate` | backend |
| A2 | Rendah | Pembersih sel CSV broadcast/laporan lebih lemah daripada milik audit/kontak (injeksi rumus) | backend |
| A3 | Rendah | Image pihak ketiga di compose dipin tag (bukan digest), tidak dipantau Dependabot, dan tidak ada pemindaian CVE image/biner native | devops |
| A4 | Rendah | `BALESIN_REQUIRE_SIGNATURE` masih bawaan `0`. Keputusan 2026-11-22 mewajibkan `1` saat rilis bertanda tangan pertama | devops |
| A5 | Rendah | Kewajiban lisensi LGPL-3.0 (libvips di `@img/sharp-libvips-*`) belum ada berkas pemberitahuan pihak ketiga di image/rilis | devops |
| A6 | Rendah | Channel tanpa jendela (Email/Telegram): CS bisa mengirim teks bebas kapan saja ke percakapan `resolved` mana pun (varian A1) | backend |

---

## A. Kepatuhan `docs/SECURITY.md` butir per butir

Bukti merujuk ke HEAD `ab1335f`. ✅ = patuh, ⚠️ = patuh dengan catatan/temuan.

### §1 Autentikasi

| Butir | Status | Bukti |
|---|---|---|
| argon2id, min. 10 karakter, daftar password umum | ✅ | `apps/api/src/modules/auth/password-hasher.ts:3,17-18` (`@node-rs/argon2`, m=19456 t=2); `packages/shared/src/password.ts:8`; `apps/api/src/modules/auth/common-passwords.ts`, `password-policy.ts` |
| Cookie `HttpOnly; Secure; SameSite=Lax`, ID 256-bit ter-hash, rotasi, idle 12 jam / absolut 30 hari | ✅ | `apps/api/src/http/cookies.ts` (`__Host-`, token 43 karakter b64url = 32 byte, cookie ganda ditolak); `apps/api/src/modules/auth/session.repo.ts:23-26`; lookup lewat `sha256Hex` (`auth.hook.ts`) |
| CSRF untuk semua request pengubah data | ✅ (varian) | `apps/api/src/modules/auth/auth.hook.ts:145-171`: Origin wajib sama dan token CSRF terikat sesi (HMAC, lebih kuat dari double-submit), plus GET ber-efek-samping `requireCsrf` (`route-access.ts`). Rute publik POST ditolak bila `Origin` asing (`auth.hook.ts:103-114`) |
| 2FA TOTP wajib Owner/Admin/Supervisor, kode cadangan ter-hash | ✅ | `route-access.ts` `AUTHENTICATED_OR_ENROLLING`; `auth.hook.ts:174-176`; review `2026-11-14-fase1-2fa.md` (2 putaran AMAN) |
| Rate limit login per IP & akun, kunci 15 menit setelah 5 gagal, email | ✅ | `packages/shared/src/auth.ts:24-25`; `apps/api/src/modules/auth/login-rules.ts:28-72`; email `account_locked` (`packages/core/src/mail/templates.ts:423-439`) |
| Undangan: acak, ter-hash, sekali pakai, 72 jam, terikat email | ✅ | `apps/api/src/modules/invitations/invitations.service.ts:76,205`; review undangan-reset + akhir Fase 1 (T1 tertutup) |
| Reset password: ter-hash, sekali pakai, 30 menit, respons seragam, cabut sesi | ✅ | `password-reset.service.ts`; tes `security-review-fase1-undangan-reset.test.ts` lulus |
| Tanpa pendaftaran publik; setup sekali + token installer | ✅ | `deploy/install.sh:405,479` (`SETUP_TOKEN` acak); `setup.routes.ts` 409 setelah selesai; matriks: hanya rute setup/login/reset/undangan yang publik |

### §2 Otorisasi

| Butir | Status | Bukti |
|---|---|---|
| RBAC di server per endpoint + tes per peran × endpoint | ✅ | Bawaan tolak: `apps/api/src/http/route-access.ts` `enforceRouteDeclarations` (start gagal bila rute tanpa `access`/skema respons) + `auth.hook.ts` root. `apps/api/src/rbac-matrix.integration.test.ts` mendaftar SEMUA rute (statis) dan memanggil tiap rute sebagai 5 peran + tanpa sesi + sesi 2FA-terbatas (dinamis). **Lulus.** Rute `PUBLIC` (35, di 12 berkas) semuanya wajar: health, setup, login/2FA, branding halaman masuk, reset/undangan/verifikasi email, webhook masuk (HMAC), dokumen API, media MobiChat bertanda tangan |
| Query difilter `organization_id` | ✅ | `permission-grant.ts` membawa `organizationId`; tes isolasi `packages/db/src/isolation.integration.test.ts`; FK komposit (review real-time, diterima tanpa RLS) |
| Teknisi hanya percakapan di-assign/terkait tiket | ✅ | `packages/shared/src/permissions.ts:207-218` (`assigned`/`own`), `isWithinScope` `:331-351`; review Fase 5 S1 tertutup |
| (lintas modul) Matriks `inbox.initiate` vs kirim template | ⚠️ **A1** | lihat B |

### §3 Rahasia

| Butir | Status | Bukti |
|---|---|---|
| Token Meta, App Secret, SMTP/IMAP, Telegram dienkripsi AES-256-GCM dari `BALESIN_MASTER_KEY` | ✅ | `packages/core/src/crypto.ts:123` (`aes-256-gcm`, kunci per tujuan); `packages/core/src/secret.ts` (`Secret.reveal()` eksplisit) |
| Tidak dikirim ke frontend (hanya 4 karakter terakhir) | ✅ | Skema respons wajib (Zod membuang kunci di luar kontrak); rahasia hanya muncul sebagai `…Tail`/`tokenTail` (`packages/shared/src/broadcasts.ts:786,955`). Sengaja ditampilkan: `verifyToken` webhook (perlu ditempel di Meta), API key & `whsec_` **sekali** saat dibuat (`api-keys.ts:140`, `outgoing-webhooks.ts:247-250`) |
| Tidak ada rahasia di log/error/repo | ✅ | `packages/core/src/logger.ts:53-68` (URL tanpa query), `redact.ts` (sensor nama kunci + teks); token Meta hanya di header `Authorization` ke host Meta (`graph-client.ts:334-354,551-567`). `git grep` pola token Meta/`blsn_live_`/kunci privat/token Telegram/GitHub/AWS di HEAD: **bersih** (hanya contoh di dokumen). `.gitignore:9-10` `.env*` kecuali `.env.example` |
| API key `blsn_…`, hash saja, cabut, scope, kedaluwarsa, terakhir dipakai | ✅ | `packages/shared/src/api-keys.ts:10-36`; `api-key-auth.ts:46-162` |
| Pengalihan kredensial (ganti host/URL tanpa ketik ulang rahasia) | ✅ | konektor broadcast `broadcast-settings.service.ts:459-471`; IMAP/SMTP channel `connections.service.ts:960-1021`; email pengirim `email-settings.service.ts:238,519`; webhook keluar `outgoing-webhooks.service.ts:324`. Semuanya mewajibkan rahasia ulang atau konfirmasi identitas |

### §4 Webhook masuk

| Butir | Status | Bukti |
|---|---|---|
| `X-Hub-Signature-256` atas raw body, waktu-konstan, tolak tanpa tanda tangan | ✅ | `packages/core/src/meta/webhook-signature.ts:1,16`; parser buffer `channel-webhooks.routes.ts:60-66` |
| `hub.verify_token` acak per channel | ✅ | `crypto.ts:35` `constantTimeEqual`; rotasi `channel.webhook_verify_token_rotated` |
| Idempotensi, batas body, proses di worker | ✅ | `whatsapp-webhook.service.ts:34-50`; gateway `nginx.conf:123-125` 4 MiB, api 3 MiB, Telegram 1 MiB (`channel-webhooks.service.ts:40`) |
| Anjuran "Require App Secret Proof" | ✅ | `docs/SETUP-META.md:26`; UI `apps/web/src/i18n/id.ts:3267-3269`; `appsecret_proof` selalu dikirim (`graph-client.ts:334`) |

### §5 Penyalahgunaan pengiriman

| Butir | Status | Bukti |
|---|---|---|
| CS tidak bisa broadcast | ✅ | `permissions.ts:202-203` |
| Broadcast > ambang 50 wajib disetujui | ✅ | `packages/shared/src/broadcasts.ts:659`; review broadcast S1 (pecah kampanye) tertutup |
| Batas harian per pengguna & organisasi | ✅ | `packages/shared/src/sending-limits.ts:20-22` (500 / 5 000 / 20 per percakapan per menit); email ke Owner saat batas tercapai |
| Rem darurat (N× rata-rata 7 hari / batas mutlak) + alarm + butuh Admin | ✅ (catatan) | `apps/worker/src/queues/broadcast.ts:905-960`; bawaan `spikeMinPerMinute` 120, `×10`, mutlak 400/menit (`broadcasts.ts:664-666`). **Catatan**: penyalahgunaan pelan (≤ 120/menit, ≤ 500/hari) tidak memicu rem. Penahannya tinggal batas harian (lihat A1) |
| Semua pesan keluar tercatat | ✅ | `messages.sender_user_id`/`api_key_id`/`template_id` (`outbound.service.ts:775-790`) |
| API key bot bisa dibatasi tanpa memulai percakapan baru | ✅ (catatan) | scope `messages:initiate` terpisah (`api-keys.ts:31`); key `messages:send` tetap bisa mengirim template ke percakapan `resolved` (varian A1) |
| CS memulai percakapan ke nomor baru | ⚠️ **A1** | `/conversations/start` benar ditolak (`templates.routes.ts:258`), tetapi jalur `POST /conversations/:id/messages` membuka hal yang setara |

### §6 Webhook keluar & SSRF

Semua klien HTTP/jaringan keluar diinventarisasi (`fetch(`, `node:http(s)`, nodemailer, imapflow,
web-push):

| Klien | Penjaga | Status |
|---|---|---|
| Webhook keluar (+ format MobiChat), konektor broadcast, unduh `media_url` MobiChat | `packages/core/src/net/outgoing-webhook.ts:76` `classifyAddress` + DNS sekali + port dibatasi + tanpa redirect + allowlist privat per organisasi; `connector-source.ts:1-15` | ✅ |
| Tanda tangan `X-Balesin-Signature: t=,v1=` + retry | `outgoing-webhook.ts:223` | ✅ |
| SMTP (email pengirim, channel Email) | `packages/core/src/mail/smtp.ts` `resolveMailHost` + port allowlist | ✅ |
| IMAP channel Email | `packages/core/src/channels/email-imap.ts:174-216` (port allowlist, `resolveMailHost` tolak host terlarang, TLS ≥1.2 `rejectUnauthorized`) | ✅ |
| Graph API Meta & unduh media | host tetap; media hanya `META_MEDIA_HOSTS` https, `redirect: 'manual'` (`graph-client.ts:551-569`); base URL tiruan hanya loopback di dev/test | ✅ |
| CDN lampiran Messenger/IG | `packages/core/src/channels/meta-social.ts:358-374` (akhiran ber-titik, https, tanpa port/kredensial), `redirect: 'error'` (`outbound.service.ts:687`) | ✅ |
| Telegram Bot API | host tetap `api.telegram.org` (`net/telegram.ts`, `telegramSafeBaseUrl`) | ✅ |
| Web Push | origin layanan push dikenal (`push/web-push.ts`; override hanya tes) | ✅ |

### §7 Upload & media

| Butir | Status | Bukti |
|---|---|---|
| Sniffing isi, batas ukuran | ✅ | `packages/core/src/meta/media-sniff.ts`; gateway `nginx.conf:105-111` (101 MB, dialirkan); logo: hanya PNG/JPEG/WebP lewat sniffing sebelum `sharp` (review merek 11-24); impor XLSX di thread terisolasi (`parseTableIsolated`) |
| `Content-Disposition` aman, `nosniff`, SVG tidak inline | ✅ | `outbound.routes.ts:209-221` (inline hanya daftar MIME aman, `CSP default-src 'none'; sandbox`, CORP same-origin); `media-store.ts` `contentDisposition` |
| Nama disanitasi, disimpan acak | ✅ | `packages/core/src/media/store.ts:1,21` (`randomUUID` storage key) |

### §8 Web

| Butir | Status | Bukti |
|---|---|---|
| CSP ketat tanpa inline script, HSTS, XFO DENY, Referrer-Policy, Permissions-Policy | ✅ (catatan) | `deploy/docker/gateway/security-headers.conf:16-23` (`script-src 'self'`; `style-src-elem 'unsafe-inline'` sudah diterima di review Fase 7); API `apps/api/src/http/security.ts` (CSP `default-src 'none'`, COOP, CORP same-site, `no-store`); `/api/docs` CSP sendiri tanpa inline (`api-docs.routes.ts:24-25`) |
| Escape konten pesan; tautan `noopener noreferrer` | ✅ | Tidak ada `dangerouslySetInnerHTML`/`innerHTML` di `apps/web/src`; tautan pesan tidak dirender sebagai anchor; semua `target="_blank"` ber-`rel="noopener noreferrer"`; HTML email hanya di `<iframe sandbox="">` (`EmailMessage.tsx:118-120`, `EmailTemplatePreview.tsx:98-100`), dan CSP induk memblokir gambar pelacak |
| Validasi Zod di server | ✅ | `fastify-type-provider-zod` di semua rute |
| CORS hanya origin aplikasi | ✅ | `security.ts:77-110` (persis sama `appOrigin`, preflight asing 403) |
| WebSocket | ✅ | `inbox-stream.routes.ts:38-66`: sesi + `inbox.view` + Origin wajib + batas koneksi per pengguna; `maxPayload: 1024` (`app.ts`); validasi ulang sesi berkala |

### §9 Infrastruktur

| Butir | Status | Bukti |
|---|---|---|
| Hanya proxy yang menjangkau port aplikasi | ✅ | `deploy/docker-compose.yml:197` (bind IP privat/127.0.0.1), firewall `DOCKER-USER` (`install.sh`, panduan bab 1); installer menolak `0.0.0.0` |
| Postgres/Redis tidak terekspos; Redis berpassword | ✅ | jaringan `data` `internal: true` (`docker-compose.yml:260`); `REDIS_URL` dengan password (`:41,101`) |
| Container non-root, FS read-only | ✅ | `Dockerfile` `USER node`/`101`; compose `read_only`, `cap_drop: [ALL]`, `no-new-privileges` (`:29-31,60-63,92-95`); CI uji asap `getuid() !== 0` (`rilis.yml`) |
| Backup harian terenkripsi + uji restore, retensi 14 hari | ✅ (catatan) | cron `install.sh:637-639`; encrypt-then-MAC `deploy/balesin` (review Fase 7 P2); retensi `balesin:307-309`; uji restore bulanan didokumentasikan (`docs/panduan/08-pemeliharaan.md:78`). Info: belum ada salinan off-site bawaan |
| Update image rutin, `pnpm audit`/Dependabot di CI, kunci versi | ⚠️ A3 | `ci.yml:58-72` (gagal pada high), `.github/dependabot.yml` (npm, actions, docker `deploy/docker`); semua dependensi dipin persis; `pnpm-workspace.yaml` `minimumReleaseAge: 1440`, `allowBuilds` allowlist |

### §10 Privasi data

| Butir | Status | Bukti |
|---|---|---|
| Akses dibatasi peran, audit, ekspor/hapus per kontak, retensi media | ✅ | `contacts.export`/`contacts.delete` (`permissions.ts:214-215`); ekspor & hapus dengan konfirmasi identitas + audit; `MEDIA_RETENTION_DAYS` 1–365 (`packages/shared/src/outbound.ts:53`, worker `channel-mailboxes.ts:121-126`); `audit_logs` hanya-tambah, hak UPDATE/DELETE dicabut dari peran runtime (`apps/api/src/cli/db-roles.ts:27,85`) |

---

## B. Temuan

### A1 (Sedang): CS mengirim template ke semua percakapan `resolved` (broadcast terselubung)

**Bukti**
- `inbox.initiate` didefinisikan sebagai *"mengirim template ke nomor yang belum punya percakapan
  terbuka … supaya akun CS yang dibobol tidak bisa mengirim template satu per satu ke ribuan nomor"*
  (`packages/shared/src/permissions.ts:101-107`; DECISIONS 2026-11-14; review RBAC S2). CS tidak
  memegangnya (`:209`).
- Rute kirim pesan hanya meminta `inbox.reply` (CS = `all`) (`apps/api/src/modules/messages/outbound.routes.ts:64,105-128`).
  `sendAs` (`outbound.service.ts:707-760`) tidak memeriksa status percakapan maupun `inbox.initiate`
  untuk `type: 'template'`, dan `assertWindowOpen` melewatkan template (`:307-317`).
- Percakapan `resolved` dibuat massal oleh modul lain: setiap notifikasi API v1 `messages:initiate`
  (`outbound.service.ts:1163-1164`) dan setiap penerima broadcast (`apps/worker/src/queues/broadcast.ts:601-627`;
  DECISIONS 2026-11-20). Untuk ISP, itu berarti seluruh pelanggan yang pernah menerima tagihan.
- Diuji (Postgres/Redis lokal): notifikasi billing → percakapan `resolved` → CS login → `POST
  /conversations/:id/messages` template **MARKETING** dengan `{{1}}` = `"Budi. Klaim hadiah di https://contoh-phishing.test"`
  → **202**, pesan `pending` diantrekan dengan teks *"Halo Budi. Klaim hadiah di https://contoh-phishing.test, ada promo untuk Anda."*

**Dampak.** Akun CS yang dibobol bisa mengirim template berbayar dari nomor resmi ke setiap kontak
historis, satu per satu. Variabelnya teks bebas, jadi isinya bisa tautan phishing (cukup tanpa baris
baru). Penahannya hanya batas harian 500 per pengguna dan 5 000 per organisasi. Rem otomatis tidak
terpicu di bawah 120 pesan/menit (`broadcasts.ts:665`). Owner baru diberi tahu saat batas harian
tercapai, setelah ±500 pelanggan menerima pesan. Ada risiko rating kualitas nomor turun atau nomor
diblokir Meta. Ini persis "broadcast terselubung" yang hendak ditutup S2 RBAC. Celahnya muncul dari
gabungan dua modul: percakapan `resolved` dari broadcast/API dan aturan kirim template inbox.

**Perbaikan (backend).** Di `sendAs`, untuk `type === 'template'` lewat **sesi pengguna**: bila
percakapan `resolved`, wajibkan `inbox.initiate`. Selain itu 403 `FORBIDDEN` dengan pesan *"Mengirim
template ke percakapan yang sudah selesai butuh izin memulai percakapan."*, dan berlakukan jatah
`mulai-percakapan` (200/24 jam) yang sama. Pertimbangkan juga mewajibkan `inbox.initiate` untuk
template di luar jendela 24 jam meski percakapan masih terbuka. Untuk API key, samakan: `messages:send`
ke percakapan `resolved` dengan template butuh `messages:initiate`. Bila dibatasi, sesuaikan
kontrak MobiChat/bot. Perbarui `KONTRAK-API-TEMPLATE.md` "Kirim → Ke percakapan" dan web (tombol
template di percakapan selesai disembunyikan/diberi penjelasan untuk CS).

**Tes:** `apps/api/src/security-review-audit-akhir.integration.test.ts`:
- `it` prasyarat: billing API v1 menghasilkan percakapan `resolved` yang terlihat CS;
- `it.fails` **A1**: CS → template MARKETING ke percakapan `resolved` → diharapkan 403 dan tidak ada
  pesan. Sekarang gagal dengan `expected 202 to be 403`, alasan yang dimaksud, sudah dipastikan dengan
  menjalankannya sebagai `it` biasa;
- `it` regresi: Owner (memegang `inbox.initiate`) tetap 202.

### A2 (Rendah): Pembersih CSV broadcast & laporan lebih lemah

- Bukti: `apps/api/src/modules/broadcasts/broadcasts.service.ts:123-128`, dipakai juga
  `reports.service.ts:37,533-535`. Fungsi ini hanya memeriksa karakter **pertama** `[=+\-@\t\r]` dan
  tidak membuang karakter kendali. Bandingkan `audit/audit-view.ts:70-76`, yang juga memeriksa setelah
  spasi/kutip di depan (`/^[\s"']*[=+\-@\t\r]/`), selalu mengutip, dan membuang karakter kendali.
  Nama kontak di CSV broadcast berasal dari profil WhatsApp pelanggan, jadi dikendalikan pihak luar.
- Dampak: nilai seperti `" =HYPERLINK(...)"` atau kendali tersembunyi bisa lolos di sebagian spreadsheet
  yang memangkas spasi saat impor. Dibutuhkan pengguna berhak ekspor yang membuka berkasnya.
- Perbaikan: satu `csvCell` bersama (pakai yang di `audit-view.ts`) untuk broadcast & laporan. Tambahkan
  kasus `" =1+1"`, `"\u0000=1"`, `'"=1'` ke `recipient-import.test.ts`.

### A3 (Rendah): Image pihak ketiga & biner native tidak dipantau

- Bukti: `deploy/docker-compose.yml:56,89,211,240` memakai `postgres:16.15-alpine3.24`,
  `redis:7.4.12-alpine3.22`, `caddy:2.11.9-alpine`, `cloudflare/cloudflared:2026.11.0`. Keempatnya
  dipin **tag** (bisa ditimpa), tidak dipin digest. Hanya image Balesin di compose rilis yang merujuk
  `@sha256`. `.github/dependabot.yml` ekosistem `docker` hanya `directory: /deploy/docker`, jadi compose
  tidak dipantau. Tidak ada pemindai CVE image (Trivy/Grype) di `ci.yml`/`rilis.yml`. `pnpm audit` tidak
  melihat libvips/libpng/libwebp di `@img/sharp-*` (Info 1 review merek). Redis memakai Alpine 3.22,
  sedangkan yang lain 3.24.
- Dampak: perbaikan keamanan Postgres/Redis/Caddy tidak sampai otomatis. Pengganti tag di registry
  pihak ketiga ikut terpasang tanpa ketahuan.
- Perbaikan (devops): pin `image@sha256:` di compose rilis (dibuat `rilis.yml` saat menyiapkan
  berkas), tambah ekosistem Dependabot `docker-compose` untuk `/deploy`, dan tambah langkah
  `trivy image --severity HIGH,CRITICAL` (aksi dipin SHA) atas 3 image di `ci.yml` (informasi) dan
  `rilis.yml` (menggagalkan).

### A4 (Rendah): Verifikasi tanda tangan rilis masih opsional

- Bukti: `deploy/install.sh:446` `BALESIN_REQUIRE_SIGNATURE` bawaan `0`; `deploy/balesin:449`.
  DECISIONS 2026-11-22: *"jadi bawaan `1` setelah rilis bertanda tangan pertama"*. Installer kini
  memasang cosign terverifikasi checksum (`install.sh:512-544`), jadi syarat teknisnya sudah ada.
- Dampak: bila aset rilis diganti, `balesin update` di server yang sudah terpasang hanya memberi
  peringatan. `install.sh` sendiri diunduh dari kanal yang sama, jadi perlindungan ini terutama
  berlaku untuk jalur update.
- Perbaikan (devops): bersamaan dengan tag `v1.0.0` (atau rilis bertanda tangan pertama), ubah bawaan
  menjadi `1` di `install.sh`, dan buat `balesin update` menyetel `1` bila belum ada. Ini butir
  checklist rilis (BUTUH-TOBING #18: ruleset tag + reviewer environment).

### A5 (Rendah, kepatuhan): Lisensi LGPL-3.0 libvips belum diberitahukan

- Bukti: `pnpm -r licenses list --prod`: 215 MIT, sisanya Apache/BSD/ISC/OFL/0BSD/MIT-0,
  `@zone-eu/mailsplit` (MIT OR EUPL, pilih MIT), `isbot` (Unlicense), dan `@img/sharp-*`
  **Apache-2.0 AND LGPL-3.0-or-later** (libvips, ditaut dinamis). Tidak ada GPL/AGPL/SSPL. Tidak ada
  berkas `THIRD-PARTY-NOTICES` di repo, rilis, maupun image.
- Dampak: produk dijual white-label dan mendistribusikan image. LGPL mewajibkan teks lisensi dan
  informasi cara mengganti pustaka (sumber libvips). Ini risiko hukum, bukan celah keamanan.
- Perbaikan (devops): bangkitkan `THIRD-PARTY-NOTICES.txt` dari `pnpm licenses list --prod --long`
  saat build, salin ke `/app` di image + aset rilis, dan sebut sumber libvips
  (github.com/lovell/sharp-libvips) di panduan.

### A6 (Rendah): Email/Telegram tanpa jendela: CS mengirim teks bebas ke semua percakapan selesai

- Bukti: `outbound.service.ts:313` (`!channelHasCustomerWindow(channel.type)` → selalu boleh);
  DECISIONS 2026-11-16 ("membalas di percakapan `resolved` diizinkan selama jendela terbuka"). Untuk
  Email/Telegram, jendela itu tidak pernah tertutup.
- Dampak: varian A1 tanpa biaya Meta. Akun CS dibobol bisa mengirim email/pesan Telegram phishing dari
  alamat/bot resmi ke setiap kontak historis, dibatasi 500/hari.
- Perbaikan (backend): untuk channel tanpa jendela, kirim oleh pengguna tanpa `inbox.initiate` ke
  percakapan `resolved` hanya boleh dalam N hari (mis. 7 hari) sejak pesan masuk terakhir. Bisa juga
  memakai aturan yang sama dengan A1. Putuskan bersama A1 dan catat di DECISIONS.

---

## C. Info

1. **`pnpm audit`**: `--prod` **0 kerentanan**. Total ada 2 moderate dev-only: esbuild
   GHSA-67mh-4wv8-2f99 (lewat `drizzle-kit`, server dev esbuild tidak dipakai) dan minimatch
   GHSA-g3hv-75wg-m249 (eslint). Temuan picomatch high dari review Fase 7 sudah hilang. Tidak ada di
   image produksi.
2. **Paket native**: `sharp` 0.35.5 dan `@node-rs/argon2` prebuilt per platform. Penjaga Dockerfile
   memastikan hanya `linuxmusl-<arch target>` (`Dockerfile:76-79`), uji asap amd64/arm64 sebagai
   non-root (`rilis.yml`), dan `msgpackr-extract` tanpa skrip build (`allowBuilds: false`). Sesuai.
3. **CI/rilis**: semua aksi pihak ketiga dipin SHA (checkout, setup-node, pnpm, upload-artifact,
   qemu, buildx, cosign-installer), `permissions: contents: read` bawaan, `persist-credentials: false`,
   tanpa `pull_request_target`. Image layanan CI (`postgres:16-alpine`, `redis:7-alpine`) tanpa pin,
   hanya untuk tes, jadi diterima. Rilis: ancestry `main`, `environment: rilis`, build sebelum login,
   tolak timpa tag, `cosign sign --recursive` atas digest indeks multi-arsitektur, `SHA256SUMS`
   bertanda tangan. Perubahan `c5c3614`/`b0a3468` setelah review Fase 7 putaran 2 sudah dibaca. P2-R3
   (fetch tanpa kredensial) tertutup, dan instalasi cosign memakai checksum dipin.
4. **Penerimaan lama ditinjau ulang**: masih wajar.
   - `style-src-elem 'unsafe-inline'` tetap aman: skrip `'self'` dan tanpa jalur keluar.
   - Verify token terlihat Admin tetap wajar.
   - Tanpa RLS tetap wajar untuk satu instalasi per perusahaan. **Wajib ditinjau ulang** bila ada SaaS
     multi-tenant.
   - Nama pelanggan di layar kunci push dan webhook MobiChat `http://` di LAN dengan peringatan tetap
     wajar.
   - Kunci gagal API key per IP tetap wajar.
   - Satu-satunya penerimaan yang kini **tidak** wajar adalah klaim RBAC S2 *"CS & Teknisi hanya
     membalas percakapan yang sudah ada"*. Klaim itu benar secara harfiah, tetapi broadcast/API v1
     (Fase 4) membuat "percakapan yang sudah ada" untuk semua pelanggan. Lihat A1.
5. **`/api/docs` publik bawaan aktif** (`organizations.api_docs_enabled` default `true`) tanpa rahasia
   atau data organisasi, dan bisa dimatikan. Diterima.
6. **`/ready` publik** menyebut status dependensi (`ok`/`unavailable`) tanpa versi/alamat. Diterima.
7. **`SETUP_TOKEN` tetap di env api setelah setup**. Tidak berguna karena setup terkunci (409).
   Diterima.
8. **Backup** disimpan di disk yang sama dengan `BACKUP_PASSPHRASE` di `.env`. Panduan sebaiknya
   menegaskan salinan off-site (rsync/rclone ke lokasi lain, passphrase disimpan terpisah).
9. **Permissions-Policy `microphone=()`/`camera=()`** cocok karena web tidak memakai `getUserMedia`.
   Bila kelak ada rekam pesan suara, ubah menjadi `microphone=(self)`.

---

## D. Tes & perintah

| Perintah (worktree bersih `ab1335f`) | Hasil |
|---|---|
| `apps/api: vitest run security-review rbac-matrix rbac.integration` | **34 berkas, 303 tes lulus** (termasuk matriks semua rute × peran) |
| `apps/api: vitest run --config vitest.deploy.config.ts` | 28/28 lulus |
| `apps/worker: vitest run security-review` | 2 berkas, 9 tes lulus |
| `packages/core`, `packages/shared`, `apps/web`: `vitest run security` | 84, 4, dan 122 tes lulus |
| `apps/api: vitest run src/security-review-audit-akhir` | 2 lulus + **1 expected fail (A1)**; dijalankan sebagai `it` → `expected 202 to be 403` |
| `tsc --noEmit` (api), `eslint`, `prettier --check` berkas tes baru | bersih |
| grep `it.fails(`/`test.fails(` di `apps`, `packages`, `e2e` | **0** sebelum audit ini (yang tersisa hanya komentar "dulu it.fails"); `.skip` hanya pembagian proyek HP/desktop di E2E, tanpa `.only` |
| `pnpm audit --prod` / `pnpm audit` | 0 / 2 moderate dev-only |
| `pnpm -r licenses list --prod` | lihat A5 |
| `git grep` pola rahasia di HEAD | bersih |

## E. Commit susulan `6e0127e` (bot P4)

`storedEmailSenderVerification` / `emailSenderTrustedForBot` (`packages/shared/src/inbox.ts`) menyatukan
penafsiran yang sebelumnya terduplikasi di `assignment.service.ts:152`, `inbox-view.ts`, dan
`webhooks-out.ts`. Nilai asing di jsonb dianggap `fail` (gagal ke arah aman), dan data lama tanpa nilai
dianggap `unverified`/`fail`, tidak pernah `pass`. `DETAIL_KEYS.bot_enabled` menambah
`requireVerifiedSender`/`previousRequireVerifiedSender`: hanya boolean, bukan data pelanggan. Tidak ada
temuan. Catatan kecil: `assignment.service.ts` tetap menganggap pesan tanpa `extras.email` "tepercaya".
Itu benar untuk channel non-Email, tetapi bergantung pada worker yang selalu mengisi `extras.email` untuk
pesan Email masuk. Pertimbangkan memeriksa `channel.type === 'email'` secara eksplisit (Info).

Worktree uji di scratchpad bukan bagian repo. Berkas baru dari audit ini: dokumen ini dan
`apps/api/src/security-review-audit-akhir.integration.test.ts`. Tidak ada kode produk yang diubah dan
tidak ada commit.

---

# Putaran 2: verifikasi perbaikan (HEAD `9727cdb`)

Commit yang dinilai: `584f040` (A1/A6/A2), `9727cdb` (sisa A1 lewat "Buka lagi"), `0486386` +
`7e501f5` + `50dc195` (A3/A5), dan checklist A4 di `docs/DEPLOY.md` §10. Perubahan web yang belum
di-commit di working tree tidak dinilai.

## Putusan putaran 2: **AMAN**. A1, A2, A3, A5, A6 tertutup; A4 menjadi butir checklist rilis

Tidak ada temuan Kritis, Tinggi, atau Sedang baru. Ada 2 Rendah baru (P2-R1, P2-R2) dan 3 Info.

## A. Verifikasi per temuan

| Temuan | Bukti | Hasil |
|---|---|---|
| **A1** template ke `resolved` | `apps/api/src/modules/messages/outbound.service.ts:189` `isConversationInitiation`, `:801` (403 bila tanpa izin; jatah `mulai-percakapan` dipotong hanya untuk pesan baru yang lolos); `outbound.routes.ts` (`hasPermission(role, 'inbox.initiate')` + `INITIATE_USER_RULE` 200/24 jam, sama dengan `/conversations/start`) | `it.fails` A1 → `it` tanpa perubahan asersi; tes baru `initiation.integration.test.ts` (9) lulus. **Tertutup** |
| A1 lewat API key | `sendAsApiKey` → `apiKeyHasScope(scopes, 'messages:initiate')`; `scopes` diteruskan dari API v1 dan MobiChat | key `messages:send` saja → 403; key + `messages:initiate` → 202; billing `/public/messages/template` tetap 202. **Tertutup** |
| A1 lewat "Buka lagi" | `apps/api/src/modules/inbox/assignment.service.ts:531-563`: tanpa `inbox.initiate` hanya bila jendela 24 jam terbuka (Meta) atau pesan masuk < 24 jam (Email/Telegram); penolakan diaudit `inbox.reopen.stale` | CS → 403, tetap `resolved`, template tetap ditolak; Owner → 200; CS dalam jendela tetap boleh. **Tertutup** |
| A1 lewat perubahan status lain | `assignment.service.ts`: `claim` hanya `unserved`/`bot`; `assign`/`unassign`/transfer/`setBot` pada `resolved` → 409 (`heldBy`); MobiChat `POST conversation-status` hanya `bot→unserved` atau `→resolved`; `handoff` API v1 tidak membuka `resolved` | tidak ada jalur lain yang membuat `resolved` kembali terbuka. **Tertutup** |
| **A6** Email/Telegram | `isConversationInitiation`: `resolved` + channel tanpa jendela = memulai, jenis pesan apa pun | teks Telegram ke `resolved` → 403 (CS dan key). **Tertutup** |
| **A2** CSV | `apps/api/src/http/csv.ts` satu-satunya `csvCell`/`csvRow` (grep: tidak ada salinan lain), dipakai audit, kontak, broadcast, laporan | tes `recipient-import`/`audit` lulus. **Tertutup** |
| **A3** image & CVE | compose: postgres/redis/caddy/cloudflared `tag@sha256` (`deploy/docker-compose.yml:61,94,216,245`); base image Dockerfile ber-digest; Dependabot `docker-compose` untuk `/deploy`; Trivy 0.76.2 ber-digest di `ci.yml` (informasi) dan `rilis.yml` (CRITICAL yang sudah ada perbaikannya → gagal, sebelum login registry); npm/npx/corepack/yarn dibuang dari runtime api/worker; image web: `apk upgrade` + nginx ≥ 1.30.7 hanya dari repo nginx.org (`--repositories-file /dev/null`, tanda tangan paket diverifikasi), build gagal bila versi kurang | **Tertutup** (Info P2-1, P2-2) |
| **A4** tanda tangan wajib | `docs/DEPLOY.md` §10 "Checklist rilis" butir 4; `deploy/install.sh:446` masih `0` | Diterima sebagai butir checklist rilis bertanda tangan pertama (BUTUH-TOBING #18). **Tetap terbuka sampai tag `v1.0.0`** |
| **A5** lisensi | stage `notices` + `deploy/docker/third-party-notices.mjs` (gagal pada lisensi copyleft kuat atau tidak dikenal), teks LGPL/GPL v3, sumber sharp-libvips; `/app/THIRD-PARTY-NOTICES` di ketiga image + aset rilis, dicek sama antar-arsitektur | **Tertutup** |

## B. Jalur lain yang dicari

| Jalur | Hasil |
|---|---|
| Broadcast oleh CS | `broadcast.send` = Owner/Admin/Supervisor (`packages/shared/src/permissions.ts:202`); matriks lulus. Aman |
| Bot / API v1 / MobiChat | semua pengiriman lewat `sendAsApiKey` (`public-api.routes.ts:399`, `mobichat.service.ts:349`); mulai percakapan lewat `startWithTemplate` (`messages:initiate`). Aman |
| Tiket | modul tiket tidak mengirim pesan ke pelanggan (tidak ada pemanggil outbound). Aman |
| Balasan cepat | hanya teks yang diisikan ke composer, lalu tetap lewat `sendAs`. Aman |
| Pesan otomatis jam kerja / CSAT | worker `workspace.ts`/`csat.ts`, isinya diatur Owner/Admin. Bukan jalur CS |
| Kunci idempotensi | `byIdempotencyKey` mengembalikan pesan lama tanpa membuat pesan baru. Aman |
| **Kirim ulang pesan gagal** | lihat P2-R1 |
| **Percakapan terbuka yang sudah lama** | lihat P2-R2 |

## C. Temuan putaran 2

### P2-R1 (Rendah): "Kirim ulang" tidak memeriksa aturan mulai-percakapan

- Bukti: `outbound.service.ts:1280-1333` (`retry`) hanya memeriksa cakupan, jendela (`:1300`, template
  lolos), dan batas kirim. Tidak ada `isConversationInitiation`, tidak ada pengecualian untuk pesan
  broadcast, dan status kampanye tidak dicek (worker `messages.ts` juga tidak). Probe lokal: Owner
  mengirim template ke percakapan `resolved` dengan jendela tertutup, pesan diubah jadi
  `failed`/`meta_rejected`, lalu CS memanggil `POST /messages/:id/retry` → **202**.
- Dampak: CS bisa mengirim ulang (maks. 5 percobaan per pesan) template gagal milik
  Owner/Supervisor/API key ke percakapan selesai. Kemungkinan besar juga pesan broadcast yang gagal
  dari kampanye yang sudah dibatalkan Admin. Isi dan penerimanya sudah diotorisasi pihak lain, jadi
  jalur ini tidak bisa dipakai untuk phishing baru maupun nomor baru. Karena itu Rendah.
- Perbaikan (backend): di `retry`, terapkan `isConversationInitiation(conversation.status,
  channel.type, message.type)` dengan izin yang sama seperti `send`. Tolak pesan ber-`broadcast_id`:
  kirim ulang hanya lewat kampanye, dan hanya bila kampanye belum `cancelled`.

### P2-R2 (Rendah): Percakapan terbuka yang lama tidak dianggap "memulai"

- Bukti: predikat A1 berbasis status (`isConversationInitiation` hanya untuk `resolved`). Probe lokal:
  - percakapan `unserved` dengan pesan masuk terakhir 60 hari lalu dan jendela tertutup: CS mengirim
    template → **202**;
  - percakapan Email `unserved` dengan pesan masuk terakhir 60 hari lalu: CS mengirim teks bebas →
    **202**.

  Tidak ada penyelesaian otomatis untuk percakapan yang menganggur. Bandingkan dengan `reopen` di
  `9727cdb`, yang sudah memakai aturan "pelanggan menghubungi < 24 jam".
- Dampak: sasarannya hanya percakapan yang tidak pernah diselesaikan. Percakapan itu terlihat di tab
  "Belum dilayani"/"Bot", dan batas harian tetap berlaku. Template susulan di percakapan terbuka juga
  alur kerja yang sah. Risikonya membesar bila organisasi membiarkan banyak percakapan terbuka, misalnya
  bot yang tidak pernah menyelesaikan percakapan.
- Perbaikan (backend, pilih salah satu dan catat di DECISIONS):
  1. Samakan dengan aturan `reopen`. Tanpa `inbox.initiate`, template di luar jendela (atau pesan
     Email/Telegram) hanya boleh bila pelanggan menghubungi dalam N hari (mis. 7) ATAU percakapan
     dipegang pengirim sendiri.
  2. Tambahkan penyelesaian otomatis untuk percakapan yang menganggur (mis. 30 hari tanpa aktivitas,
     bisa diatur Owner).

## D. Info putaran 2

1. **P2-1 Gerbang Trivy** menggagalkan rilis hanya untuk CRITICAL yang sudah ada perbaikannya. HIGH
   dan image pihak ketiga hanya dilaporkan (`.github/workflows/rilis.yml:144-172`). Ini kompromi wajar
   supaya rilis tidak terblokir CVE tanpa perbaikan, dan checklist §10 butir 2–3 meminta peninjauan
   manual. Pertimbangkan `.trivyignore` bertanggal untuk HIGH yang dinilai tidak relevan, lalu naikkan
   gerbang ke HIGH.
2. **P2-2 Langkah nginx.org di image web** mengunduh paket saat build dengan `>=`. Pin versi persis
   supaya build ulang dari tag yang sama menghasilkan isi yang sama. Hapus langkah ini setelah base
   image upstream memuat perbaikan (sudah dicatat di komentar Dockerfile).
3. **P2-3** `csvCell` memberi awalan `'` pada teks nomor seperti `+62812…` di ekspor. Itu kosmetik dan
   memang aman. Pastikan impor kontak menerima kembali nilai `'+62…` bila CSV ekspor diimpor ulang.

## E. Tes & perintah putaran 2

| Perintah (HEAD `9727cdb`) | Hasil |
|---|---|
| `vitest run src/security-review-audit-akhir src/modules/messages/initiation src/rbac-matrix src/modules/broadcasts/recipient-import src/modules/audit` | 7 berkas, 60 tes lulus |
| `vitest run security-review initiation rbac` (seluruh tes keamanan api) | 346 tes lulus |
| `vitest run --config vitest.deploy.config.ts` (termasuk `security-review-audit-akhir-deploy.test.ts`) | 55/55 lulus |
| Probe sementara P2-R1/P2-R2 (berkas uji dihapus setelah dijalankan) | kirim ulang 202; template ke `unserved` 60 hari 202; teks Email 60 hari 202 |
| grep `it.fails(`/`test.fails(` | **0**: tidak ada temuan Sedang+ yang terbuka |
| `pnpm audit --prod` | 0 kerentanan |

Putaran 2 tidak mengubah kode produk dan tidak membuat commit.
