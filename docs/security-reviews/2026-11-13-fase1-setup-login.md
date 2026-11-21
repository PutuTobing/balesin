# Review keamanan — Fase 1 butir 1–2 (setup Owner, login/logout, sesi, CSRF, batas laju, kunci akun, email pengirim)

- **Tanggal:** 2026-11-13
- **Cakupan:** commit `dff0fbb` (`git diff 0cb0190..dff0fbb`, branch `dev`): `apps/api` (modul
  `setup`, `auth`, `audit`, `branding`, `email-settings`, `installation`, `http/rate-limit.ts`,
  `http/cookies.ts`, `http/route-access.ts`, `http/client-info.ts`, `queues/`), `apps/worker`
  (antrian email), `packages/core` (`crypto.ts`, `mail/`), `packages/db` (skema, migrasi `0001`,
  `0002`), `packages/shared` (`auth.ts`, `api-routes.ts`, `email-settings.ts`, `branding.ts`,
  `setup.ts`, `fields.ts`), `.env.example`, compose dev dan infra CI (Mailpit). Dokumen
  `docs/KONTRAK-API-AUTH.md` (commit `157d4e5`) dipakai sebagai daftar perilaku yang diklaim.
- **Acuan:** `docs/SECURITY.md`, `docs/PENGATURAN-UI.md`, aturan keras `CLAUDE.md`, keputusan
  2026-11-13 di `docs/DECISIONS.md`, catatan F dan N1 di
  `docs/security-reviews/2026-11-13-fase0-fondasi.md`.
- **Model ancaman:** penyerang memegang satu akun CS yang dibobol dan ingin memakai nomor
  WhatsApp perusahaan untuk spam/penipuan atau mencuri token Meta. Di butir ini belum ada channel
  WhatsApp, jadi yang dinilai: apakah akun CS bisa naik wewenang, mengambil rahasia (password
  SMTP sebagai pendahulu token Meta), memakai server sebagai alat SSRF/relay, atau menghalangi
  Owner/Admin bertindak.
- **Cara uji:** kode dibaca baris demi baris, lalu dibuktikan dengan menjalankan — `app.inject()`
  di atas Postgres 16 dan Redis 7 lokal (database sementara `balesin_test_tmp_*`, Redis DB 15
  dengan awalan acak) dan Mailpit lokal. Tidak ada server di luar mesin ini yang dihubungi.
  Database dev `balesin` tidak disentuh. Kode produk dan konfigurasi tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis maupun Tinggi. Satu temuan **Sedang** (S1, penguncian akun bisa dipakai
untuk mengunci Owner/Admin) sebaiknya diperbaiki sebelum produksi, tetapi tidak memblokir butir
ini. Semua catatan Fase 1 dari review Fase 0 (F.1–F.4, F.6–F.16, N1) terpenuhi untuk lingkup
butir ini.

| Level  | Jumlah | Kode                       |
| ------ | ------ | -------------------------- |
| Kritis | 0      | —                          |
| Tinggi | 0      | —                          |
| Sedang | 1      | S1                         |
| Rendah | 8      | R1–R8                      |
| Info   | 9      | I1–I9                      |

---

## A. Harus diperbaiki sekarang (memblokir)

Tidak ada.

## B. Sebaiknya diperbaiki sebelum produksi (tidak memblokir butir ini)

### S1 — Sedang — Kunci akun bisa dipakai siapa pun untuk mengunci Owner/Admin tanpa batas waktu

**Bukti**

- `apps/api/src/modules/auth/login-rules.ts:28` — hitungan gagal per **email saja**, tanpa
  memandang asal permintaan.
- `apps/api/src/modules/auth/auth.service.ts:186-195` — selama penanda kunci ada, permintaan
  ditolak 429 **sebelum** password diperiksa, jadi password yang benar pun ditolak.
- `auth.service.ts:218-221` dan `:114` — percobaan gagal ke-5 memasang kunci 15 menit dan
  mengantre email pemberitahuan ke korban.
- Dibuktikan: 5 percobaan salah dari `203.0.113.66` → Owner yang masuk dari `198.51.100.20`
  dengan password benar mendapat **429** (tes `S1` di `apps/api/src/security-review-fase1.test.ts`).

**Dampak.** Cukup tahu email korban (di butir berikutnya email anggota tim akan terlihat oleh
akun CS di daftar tim/assign). Lima permintaan tiap 15 menit membuat Owner/Admin tidak bisa
masuk sama sekali. Dalam model ancaman ini justru itu yang diinginkan penyerang: akun CS yang
dibobol tetap dipakai, sementara orang yang bisa menonaktifkannya terkunci di luar. Batas per IP
(20/15 menit) hanya memperlambat: satu IP cukup untuk mengunci 4 akun terus-menerus, dan IPv6
memberi banyak /64. Efek samping: korban menerima ±96 email "akun dikunci" per hari.

**Perbaikan (konkret):**

1. Ganti kunci 5-gagal/15-menit menjadi per **(email, asal)**: `accountKey` di
   `auth.service.ts:155` menjadi `sha256Hex(\`login|${input.email}|${ipRateLimitKey(client)}\`)`.
   Pemilik akun dari jaringan lain tidak ikut terkunci.
2. Tambah aturan kedua per **email saja** dengan ambang jauh lebih tinggi untuk serangan tersebar
   (mis. `login-akun-global`: 50 gagal / 1 jam → kunci 15 menit + email + audit). Ini tetap
   memenuhi `SECURITY.md` §1 ("per IP & per akun"), dan menghentikan tebakan dari banyak IP.
3. (Lebih kuat, bisa bersama 2FA) "perangkat dikenal" ala OWASP: setelah login berhasil pasang
   cookie HMAC berisi `userId` + waktu; percobaan yang membawa cookie sah dihitung di ember
   terpisah dan tidak terkena kunci per-akun.
4. Kirim email "akun dikunci" paling banyak sekali per jam per pengguna.
5. Catat perubahan aturan di `docs/DECISIONS.md` (teks `SECURITY.md` §1 "kunci 15 menit setelah
   5 gagal" ditafsirkan per email+asal).

Setelah diperbaiki, tes `S1` akan lulus — hapus `.fails`-nya, dan sesuaikan tes
`auth.integration.test.ts:449` ("5 kali gagal → akun dikunci 15 menit, termasuk untuk password
yang benar") supaya percobaan berasal dari IP yang sama.

---

## C. Temuan Rendah

### R1 — Rendah — Keberadaan akun terbuka bila penanda Redis hilang, dan lewat selisih waktu pada percobaan ke-5

**Bukti:** `auth.service.ts:188-191` (`lockedFor = max(flagTtl, user.lockedForSeconds)`) — kolom
`users.locked_until` hanya ada untuk akun sungguhan; `auth.service.ts:117-134` — percobaan ke-5
untuk akun sungguhan menjalankan transaksi DB + audit, untuk email tak terdaftar hanya Redis.
Dibuktikan: setelah kedua email dikunci lalu penanda Redis dihapus, akun sungguhan dijawab
**429**, email tak terdaftar **401** (tes `R1`). Redis dev/CI berjalan `--appendonly no`.

**Dampak:** enumerasi email terdaftar, hanya dalam jendela ≤15 menit setelah Redis dijalankan
ulang tanpa persistensi, atau lewat satu sampel waktu per 15 menit per email (beberapa ms di
tengah jitter argon2). Rendah.

**Perbaikan:** (a) aktifkan persistensi Redis (AOF) di compose produksi (Fase 7) sehingga penanda
selamat dari restart; (b) bila `locked_until` masih berlaku tetapi penanda Redis tidak ada, pasang
ulang penanda dari nilai DB **tanpa** langsung menjawab 429 untuk permintaan itu (perlakukan
sebagai percobaan biasa yang dihitung), atau pakai `locked_until` hanya untuk tampilan admin;
(c) pindahkan transaksi `lockUser` + audit ke luar jalur respons (seperti pengantre notifikasi),
atau jalankan transaksi tiruan setara untuk email tak terdaftar.

### R2 — Rendah — Penjaga SSRF SMTP tidak mengenali IPv6 yang membawa alamat IPv4 (NAT64, 6to4, SIIT, Teredo)

**Bukti:** `packages/core/src/mail/host-guard.ts:21-35` hanya membuka bentuk `::ffff:a.b.c.d`
(dan `BlockList` Node menangani `::ffff:` heksadesimal). Tidak diblokir:
`64:ff9b::a9fe:a9fe`, `64:ff9b:1::a9fe:a9fe`, `2002:a9fe:a9fe::1`, `::ffff:0:a9fe:a9fe`
(tes `R2`, 4 kasus). Skema host (`packages/shared/src/email-settings.ts`, `isValidSmtpHost`)
menerima literal IPv6 apa pun.

**Dampak:** hanya di jaringan yang punya gateway NAT64/6to4: Owner atau pemegang token setup bisa
menjangkau 169.254.169.254 dan alamat IPv4 terblokir lain, terbatas pada port 25/465/587/2525,
dengan hasil berupa kode tetap. Rendah.

**Perbaikan:** di `isBlockedMailAddress`, untuk alamat IPv6 ambil IPv4 tertanam dari
`64:ff9b::/96` (32 bit terakhir), `64:ff9b:1::/48` (32 bit terakhir), `2002::/16` (bit 16–47),
`::ffff:0:0:0/96` (32 bit terakhir), lalu periksa IPv4 itu dengan daftar IPv4. Tambahkan juga
`2001::/32` (Teredo) dan `::/96` kecuali `::1` ke daftar blokir.

### R3 — Rendah — `SETUP_TOKEN` hanya diperiksa panjangnya

**Bukti:** `apps/api/src/config.ts:123` → `packages/core/src/env.ts:162-165` (`raw.length >= 16`).
`SETUP_TOKEN=aaaaaaaaaaaaaaaa` diterima di production (tes `R3`).

**Dampak:** operator yang mengetik token sendiri (bukan dari installer) bisa memakai token mudah
ditebak; batas global 100 tebakan salah/15 menit tidak menolong untuk token kamus. Hanya berlaku
sampai Owner dibuat.

**Perbaikan:** `SETUP_TOKEN` wajib ≥ 32 karakter dari alfabet base64url dan ≥ 16 karakter berbeda
(tolak pengulangan/deret), pesan error menyarankan perintah pembuatnya. Lakukan hal yang sama
untuk `SESSION_SECRET`.

### R4 — Rendah — "Tanpa enkripsi" + login diterima untuk host publik: password SMTP terkirim polos

**Bukti:** `packages/core/src/mail/smtp.ts:234-238` (`ignoreTLS` + `auth`), skema
`emailSettingsInputSchema` (`packages/shared/src/email-settings.ts`) tidak membatasi kombinasi
`security: 'none'` + `username/password`.

**Dampak:** salah pilih di UI (port 25 "Tanpa enkripsi") ke server email publik membuat password
akun email organisasi (sering = password kotak surat) lewat jaringan tanpa enkripsi; MITM di jalur
mana pun bisa membacanya. Butuh kesalahan Owner, jadi Rendah.

**Perbaikan:** di production tolak `security: 'none'` dengan username/password bila host
di-resolve ke alamat publik (pesan: "Tanpa enkripsi hanya untuk server email di jaringan lokal");
di UI tampilkan peringatan untuk kombinasi ini.

### R5 — Rendah — Permukaan SSRF ke jaringan privat/loopback lewat tes SMTP (risiko diakui backend)

**Bukti:** `host-guard.ts` mengizinkan privat & loopback (keputusan 2026-11-13); hasil
`connection_refused` vs `connection_timeout` vs `tls_failed` vs `auth_failed` dibedakan
(`smtp.ts:135-207`).

**Penilaian:** hanya Owner (`email-settings.routes.ts:30`) atau pemegang token setup; port dikunci
4 nilai; batas 10 tes/5 menit; balasan server tidak diteruskan; batas waktu tiap tahap. Yang
tersisa: peta "host LAN mana membuka port SMTP", dan relay tanpa login di LAN (mis. Postfix
`mynetworks`) bisa dipakai Owner mengirim email tes ke alamat mana pun. Ini menyimpang dari
`SECURITY.md` §6 ("privat/loopback diblokir kecuali allowlist") — penyimpangannya tercatat di
DECISIONS, jadi Rendah.

**Perbaikan (saat Fase 4 membangun allowlist UI):** di production izinkan privat/loopback hanya
bila masuk `OUTBOUND_PRIVATE_ALLOWLIST` (sama dengan webhook keluar); sampai saat itu cukup.

### R6 — Rendah — Login bisa dibuat 503 untuk semua orang oleh penyerang dengan banyak alamat IPv6

**Bukti:** `apps/api/src/modules/auth/password-hasher.ts:47-58` (4 hash bersamaan, antrean 64,
lebih dari itu 503), `http/client-info.ts:36-53` (ember per /64), batas IP 20/15 menit.

**Dampak:** satu /48 = 65.536 ember /64 × 20 percobaan. Penyerang yang memegang blok IPv6 bisa
memenuhi antrean argon2 (email acak tidak terkena kunci akun) sehingga login sah dijawab "server
sibuk". Ketersediaan saja; Rendah.

**Perbaikan:** tambah ember kedua per /48 untuk IPv6 (mis. 200/15 menit), dan anggaran global
percobaan gagal per menit yang, bila terlewati, memperketat ember per IP.

### R7 — Rendah — Audit "hanya-tambah" bisa dimatikan oleh peran database aplikasi itu sendiri

**Bukti:** `packages/db/drizzle/0002_audit_log_hanya_tambah.sql` memasang trigger; API dan worker
tersambung dengan peran yang sama dengan pemilik tabel (`DATABASE_URL`), yang boleh
`ALTER TABLE … DISABLE TRIGGER` (dibuktikan sendiri oleh util tes `packages/db/src/testing/index.ts`
yang memakai perintah itu — util tersebut terbatas pada database sementara dan aman).

**Dampak:** trigger melindungi dari bug aplikasi, bukan dari penyerang yang mendapat eksekusi SQL
lewat koneksi aplikasi. Rendah untuk sekarang.

**Perbaikan (Fase 7, installer):** pisahkan peran migrasi (pemilik skema) dari peran runtime;
runtime hanya `INSERT, SELECT` pada `audit_logs` dan bukan pemilik tabel.

### R8 — Rendah — Percobaan akses yang ditolak (403 peran / CSRF) tidak tercatat di audit

**Bukti:** `apps/api/src/modules/auth/auth.hook.ts:85-95` melempar `CSRF_INVALID`/`FORBIDDEN`
tanpa jejak audit; batas IP login juga menolak sebelum `recordFailure`
(`auth.service.ts:157-162`).

**Dampak:** akun CS yang dibobol dan sedang memetakan endpoint Admin/Owner tidak meninggalkan
jejak yang bisa dipantau Owner. Tidak membuka akses apa pun.

**Perbaikan (bersama butir RBAC):** di hook, untuk penolakan peran pada pengguna yang sudah masuk,
catat `auth.access.denied` (metode + pola rute, bukan URL lengkap) dengan pembatas (mis. maks 1
entri/menit/pengguna/rute supaya audit tidak bisa dibanjiri).

---

## D. Info (tidak perlu tindakan sekarang)

- **I1 — `/setup/status` publik tetap memuat `setupTokenConfigured` dan `canStoreSecrets` setelah
  setup selesai** (`setup.service.ts:155-161`). Membuka apakah operator masih menyimpan
  `SETUP_TOKEN` di `.env`; di production master key wajib, jadi `canStoreSecrets` selalu `true`.
  Usul murah: setelah selesai kembalikan `false/false` (web tidak memakainya lagi saat
  `needsSetup: false`).
- **I2 — CSRF login hanya `Origin`.** Ditambah: parser body hanya JSON (form/`text/plain` → 415),
  CORS menolak preflight origin asing, `Origin: null` ditolak. Dibuktikan dengan tes. Cukup.
- **I3 — `send-test` ke alamat mana pun.** Hanya Owner/token setup, 10/5 menit, isi template
  tetap; satu-satunya teks bebas adalah `fromName` (≤100 karakter, tanpa baris baru, di-escape
  di HTML). Cukup.
- **I4 — Memo hasil tes wizard di Redis.** Kunci = HMAC (kunci HKDF terpisah dari
  `SESSION_SECRET`) atas host/port/keamanan/username/password; nilai hanya kode + waktu, TTL 2 jam,
  kegagalan Redis tidak menggagalkan wizard. Tidak membuka password tanpa `SESSION_SECRET`.
- **I5 — Port cadangan `.env` dipercaya** (`email-settings.service.ts:358-365`, worker
  `email.ts:102-108`). Ditentukan operator server, bukan pengguna aplikasi. Cukup.
- **I6 — Logo publik.** Diverifikasi: tipe dari pemeriksaan isi, `nosniff`,
  `content-security-policy: default-src 'none'…`, CORP, `content-disposition: inline` dengan nama
  tetap; PNG+HTML polyglot tetap disajikan `image/png` dan tidak bisa dieksekusi. `?v=` bernilai
  apa pun mendapat cache `immutable`, tetapi isinya selalu logo yang sama — tidak bisa diracuni.
- **I7 — Trigger audit dimatikan util reset tes.** Hanya untuk database sementara yang lolos
  `assertTestDatabaseUrl`; tidak ada jalur dari kode produk.
- **I8 — `password_tail` (4 karakter terakhir) disimpan polos** sesuai `SECURITY.md` §3; panjang
  < 8 tidak diberi petunjuk. Mengurangi entropi sedikit bila DB bocor. Diterima.
- **I9 — Mailpit di compose dev dan CI** terikat `127.0.0.1`, kredensial dev bukan rahasia; image
  dipatok tag (bukan digest) — cukup untuk dev, catatan F.19 tetap berlaku untuk image produksi.

### Penilaian risiko yang diakui agent backend

| Risiko yang diakui | Level dari review ini |
| --- | --- |
| Host SMTP privat & loopback diizinkan; pemindaian port SMTP LAN; NAT64/6to4 tidak diblokir | R5 (Rendah) + R2 (Rendah) |
| Siapa pun bisa mengunci email apa pun 15 menit dengan 5 percobaan salah | **S1 (Sedang)** — dalam model ancaman ini dipakai untuk menahan Owner/Admin |
| Selisih waktu pada percobaan ke-5; `locked_until` membuka keberadaan akun bila penanda Redis hilang | R1 (Rendah) |
| `/setup/status` publik menampilkan `setupTokenConfigured` dan `canStoreSecrets` | I1 (Info) |
| CSRF login hanya mengandalkan cek `Origin` | I2 (Info) |
| Memo hasil tes email wizard di Redis dengan kunci HMAC | I4 (Info) |
| `send-test` bisa mengirim ke alamat mana pun | I3 (Info) |
| Trigger audit bisa dimatikan pemilik DB; util reset tes mematikannya sementara | R7 (Rendah) + I7 (Info) |
| Port SMTP dari cadangan `.env` dipercaya tanpa daftar izin | I5 (Info) |
| Header pada logo publik | I6 (Info) — diverifikasi aman |

---

## E. Status catatan Fase 1 dari review Fase 0

| Catatan | Status | Bukti |
| --- | --- | --- |
| F.1 cookie `__Host-`, HttpOnly, Secure, Lax, Path=/; token 32 byte; SHA-256 disimpan | **Terpenuhi** | `http/cookies.ts:15-58`, `session.service.ts:86-88`; tes cookie `__Host-` dan tes baru (tanpa `Domain`) |
| F.2 sesi sah hanya bila belum dicabut, kedua batas waktu, `disabled_at is null` | **Terpenuhi** | `session.repo.ts:41-75`; tes "dinonaktifkan di tengah sesi → 401 + cookie dihapus" |
| F.3 batas panjang `user_agent` 512 | **Terpenuhi** | `http/client-info.ts:16-27`, `audit.ts:51` |
| F.4 CSRF terikat sesi (HMAC kunci turunan) + cek `Origin` | **Terpenuhi** | `auth/csrf.ts`, `auth.hook.ts:82-91`; token sesi lain/sesi lama ditolak |
| F.5 WebSocket memeriksa `Origin` | Belum relevan (Fase 2) | — |
| F.6 S3 (`TRUST_PROXY`) | **Terpenuhi** (Fase 0) | tes baru: `X-Forwarded-For`/`X-Real-IP` tidak memberi jatah baru |
| F.7 `request.ip` divalidasi `isIP` | **Terpenuhi** | `client-info.ts:18-27`, ember `ip-tidak-sah` |
| F.8 tautan dari `config.appUrl` | Belum ada tautan (email kunci akun tanpa tautan) | — |
| F.9 otorisasi bawaan tolak, gagal saat registrasi | **Terpenuhi** | `route-access.ts:82-120`, `auth.hook.ts:66-67`; HEAD otomatis ikut terjaga (tes baru). Matriks peran × endpoint baru ada untuk email pengirim (tes baru) |
| F.10 skema respons wajib | **Terpenuhi** | `route-access.ts:100-106`; pengecualian hanya `rawResponse` (logo, 405) |
| F.11 repo menerima `organizationId`; FK komposit | **Terpenuhi** | semua repo baru; `email_settings` FK komposit `updated_by_user_id`. RLS belum (usul tetap) |
| F.12 `SETUP_TOKEN` wajib, waktu-konstan, kunci transaksi | **Terpenuhi** (lihat R3) | `setup.service.ts:110-138`, `:199-204`; tes setup bersamaan |
| F.13 AES-256-GCM: nonce 96 bit acak, AAD org+kolom, versi, HKDF, tolak tanpa master key | **Terpenuhi** | `packages/core/src/crypto.ts:85-147`, `email-settings.service.ts:264-268` |
| F.14 token tidak di path/query | **Terpenuhi** | `shared/src/setup.ts:13-26`; tes "token tidak lewat query" |
| F.15 payload job hanya ID | **Terpenuhi** | `core/src/queues.ts:60-65` (`strictObject`), `failedReason` hanya kode (`apps/worker/src/queues/email.ts:140`) |
| F.16 audit lewat satu helper + `redactSecrets` + trigger | **Terpenuhi** (lihat R7) | `audit.ts:42-53`, migrasi `0002` |
| N1 rute pelengkap 405 ikut hook auth | **Tertutup** | `method-not-allowed.ts:37-81`, hook di root; tes "401 untuk semua metode" |

---

## F. Yang diperiksa dan dinilai aman

- **Sesi:** token `randomBytes(32)`; hanya SHA-256 di DB; rotasi saat login (sesi lama di cookie
  dicabut, `auth.service.ts:78-83`) dan setup; idle 12 jam digeser maks sekali/menit dan tidak
  pernah melewati batas mutlak 30 hari (jam DB); logout mencabut di DB; cookie ganda ditolak;
  bentuk token divalidasi regex sebelum query.
- **CSRF:** HMAC-SHA256 dengan kunci HKDF `balesin/csrf/v1` atas hash token sesi, banding
  waktu-konstan, batas 128 karakter; `Origin` wajib = origin aplikasi untuk rute bersesi, dan
  bila ada harus cocok untuk rute publik. Semua rute pengubah data bersesi melewati hook yang sama.
- **Hook bawaan tolak:** tidak ada rute yang lolos tanpa deklarasi — aplikasi menolak start;
  saat permintaan, rute tanpa `access` → 403; HEAD otomatis mewarisi `access`; rute 405
  pelengkap menuntut sesi bila alamatnya terlindungi. Peran dibaca dari DB setiap permintaan.
- **Setup:** sekali jalan (advisory lock + PK satu baris + cek ulang di transaksi; tes bersamaan),
  token dibanding lewat SHA-256 + `timingSafeEqual` (tidak bocor panjang), batas per IP + global,
  token benar mengembalikan jatah, token salah hanya mencatat IP; 409 untuk semua rute setelah
  selesai; field tambahan (mis. `role`) dibuang Zod.
- **Password:** argon2id m=19456 t=2 p=1 dengan batas konkurensi; daftar umum ±49 ribu + kata
  Indonesia + leet + hiasan angka; data pribadi; panjang dihitung per karakter; batas 128 (baru)
  dan 1024 (login) sebelum hashing. Respons login identik untuk email tak terdaftar, password
  salah, dan akun nonaktif (status, kode, pesan, header); dummy hash disiapkan saat `onReady`.
- **Batas laju & kunci akun:** penghitung atomik (Lua), dihitung sebelum pemeriksaan password
  (serbuan bersamaan tetap 5 pemeriksaan), Redis mati → 503 (gagal tertutup). Variasi huruf
  besar/spasi/tab memetakan ke akun yang sama; email non-ASCII ditolak validasi; `+alias` adalah
  alamat lain yang tidak cocok dengan akun mana pun; `X-Forwarded-For` diabaikan tanpa
  `TRUST_PROXY` (semua dibuktikan dengan tes).
- **Kotak rahasia:** AES-256-GCM, nonce acak 12 byte per enkripsi, tag 16 byte, kunci per tujuan
  (HKDF), AAD versi+organisasi+tujuan, error dekripsi tanpa rincian; tanpa master key penyimpanan
  ditolak 503 (tidak jatuh ke polos); password tidak pernah dikirim balik (hanya `••••1234`).
- **Password SMTP tersimpan tidak bisa dibelokkan:** simpan, tes koneksi, maupun kirim tes atas
  isi form yang mengubah host, port, keamanan, atau username tanpa mengetik ulang password → 400
  sebelum ada sambungan (tes baru, 4 variasi × 2 endpoint).
- **SSRF SMTP:** port daftar izin sebelum DNS; resolve sekali lalu sambung ke IP (rebinding
  tertutup); satu saja alamat terblokir di jawaban DNS → ditolak; bentuk desimal/oktal/heksadesimal
  IPv4 diperiksa setelah resolve; `::ffff:` dalam bentuk apa pun terblokir; verifikasi sertifikat
  memakai nama host asli (`servername`), TLS ≥ 1.2; batas waktu DNS/sambung/sapaan/soket/total;
  balasan server tidak pernah diteruskan (kode tetap; `command` nodemailer hanya nama perintah,
  diperiksa di sumber nodemailer 10.5.0); `disableFileAccess/UrlAccess`.
- **Header injection email:** alamat lewat `z.email` (tanpa CR/LF), `fromName` satu baris tanpa
  karakter kendali, subjek dibersihkan spasi, nilai di HTML di-escape.
- **Antrian email:** payload `strictObject` berisi UUID + waktu; worker mengambil alamat dan
  pengaturan dari DB dengan filter organisasi; penerima nonaktif dilewati; `failedReason` hanya kode.
- **Audit:** setup, login berhasil/gagal (termasuk karena terkunci), kunci akun, logout, simpan
  dan tes email pengirim; metadata tanpa password, email login gagal disamarkan; trigger menolak
  UPDATE/DELETE/TRUNCATE.
- **Isolasi organisasi:** semua query sesi, pengguna, email pengirim, logo memakai
  `organization_id`; organisasi untuk permintaan tanpa sesi berasal dari tabel `installation`
  (satu baris), bukan dari input klien.
- **Rahasia di log/URL:** token setup, password, cookie, `x-csrf-token` tidak muncul di log
  (dibuktikan untuk tebakan token setup); tidak ada token di path/query.

## G. Hasil `pnpm audit`

- `pnpm audit`: **2 sedang** di dependensi dev, tidak berubah dari Fase 0 — `esbuild` 0.18.20
  (lewat `drizzle-kit`) dan `minimatch` (lewat `eslint`). 0 tinggi/kritis.
- `pnpm audit --prod`: **bersih**.
- Dependensi baru di commit ini: `@node-rs/argon2` 2.2.2 (biner bawaan lewat optional
  dependency, tanpa skrip install), `@zxcvbn-ts/language-common` 3.0.4 (data saja, dimuat malas),
  `nodemailer` 10.5.0 (tanpa dependensi turunan). Tidak ada advisory untuk ketiganya; versi
  dikunci persis.

## H. Tes

Berkas baru: `apps/api/src/security-review-fase1.test.ts` (integrasi, Postgres + Redis + Mailpit
lokal). `it(...)` = penjaga regresi; `it.fails(...)` = celah terbuka (isi tes menyatakan perilaku
yang benar). Setiap `it.fails` sudah dipastikan gagal karena alasan yang dimaksud (dijalankan
tanpa `.fails`: S1 `expected 429 to be 200`, R1 `expected 429 to be 401`, R2 `expected false to
be true` ×4, R3 `expected function to throw`).

| Kelompok | Isi |
| --- | --- |
| RBAC email pengirim | Admin/Supervisor/CS/Teknisi dengan sesi + CSRF sah → 403 di 5 endpoint, tanpa audit "updated/tested"; HEAD otomatis: tanpa sesi 401, CS 403 |
| Password SMTP tersimpan | Tes koneksi & kirim tes atas isi form dengan host/port/keamanan/username lain tanpa password → 400 `settings.password`; tujuan sama persis boleh |
| Login lintas situs | form/`text/plain`: 403 dari origin asing, 415 tanpa Origin; `Origin: null` 403; atribut cookie |
| Kunci akun | variasi huruf besar/spasi/tab satu hitungan; email unicode tidak lolos; `X-Forwarded-For` diabaikan |
| Penjaga lain | `::ffff:` heksadesimal/panjang penuh terblokir; akun dinonaktifkan → 401 + cookie dihapus; CSRF sesi lama tidak berlaku; header logo + polyglot; tebakan token setup tidak di log |
| `it.fails` | S1, R1, R2 (4 kasus), R3 |

Hasil (Postgres 16 + Redis 7 + Mailpit lokal):

| Paket | Lulus | Diharapkan gagal (celah terbuka) |
| --- | --- | --- |
| `apps/api` | 285 | 7 (S1 ×1, R1 ×1, R2 ×4, R3 ×1) |
| `packages/core` | 337 | 0 |
| `apps/worker` | 28 | 0 |
| `packages/db` | 84 | 0 |
| `packages/shared` | 41 | 0 |

ESLint, Prettier, dan `tsc --noEmit` bersih untuk berkas tes baru. Perubahan agent backend pada
`security-review.test.ts` dan `security-review-putaran2.test.ts` diperiksa: asersi diperketat
(origin asing kini 403), penolakan 415 tetap diuji untuk permintaan tanpa Origin — tidak ada
yang dilemahkan. Tes `apps/web` dan E2E tidak dijalankan (milik agent frontend).

---

## I. Catatan untuk butir berikutnya (wajib saat dibangun)

**2FA TOTP (Owner/Admin/Supervisor)**

1. Setelah password benar, jangan buat sesi. Buat "tantangan 2FA" sisi server: token acak 32 byte,
   disimpan ter-hash, umur ≤ 5 menit, sekali pakai, terikat `userId` + hash IP/UA; kirim di body
   (bukan cookie sesi). `completeLogin` sudah dipisah untuk ini (`auth.service.ts:72`).
2. Batasi percobaan kode per pengguna (mis. 5/15 menit, terpisah dari batas password) dan per
   tantangan (3 kali lalu tantangan hangus). Simpan langkah waktu TOTP terakhir yang dipakai untuk
   mencegah pemakaian ulang kode dalam jendela 30 detik.
3. Rahasia TOTP di kotak rahasia dengan `purpose` sendiri (`users.totp_secret`); kode cadangan
   di-hash, sekali pakai, dibanding waktu-konstan; audit aktivasi/nonaktivasi/pemakaian cadangan.
4. Menonaktifkan 2FA atau membuat ulang kode cadangan butuh password + kode saat ini.
5. Pertimbangkan cookie "perangkat dikenal" (S1 butir 3) di sini.

**Undangan**

6. Token `randomToken(32)`, simpan SHA-256, sekali pakai (update bersyarat `used_at is null`
   dalam transaksi), 72 jam, terikat email; token di fragment/body (F.14); tautan dari
   `config.appUrl` (F.8).
7. Peran diambil dari baris undangan, bukan dari body saat menerima; Admin tidak boleh mengundang
   Owner/Admin bila matriks PRD melarang; password baru lewat `checkPassword` dengan konteks
   nama/email/organisasi; undangan bisa dicabut; audit kirim/terima/cabut.

**Reset password**

8. Respons dan waktu sama untuk email terdaftar/tidak: lakukan pencarian + antre di belakang
   (job berisi ID saja), jawab segera dengan pesan tetap. Batasi per IP dan per email.
9. Token ter-hash, sekali pakai, 30 menit; setelah reset: `revokeAllForUser` (sudah ada,
   `session.repo.ts:173`), hapus `locked_until` dan penanda Redis kunci akun, kirim email
   pemberitahuan, audit.

**RBAC**

10. Tes matriks peran × SEMUA endpoint dibangkitkan dari `app.routeDeclarations` (bukan daftar
    manual) supaya rute baru otomatis ikut teruji.
11. Ganti peran / nonaktifkan → cabut sesi pengguna itu (`SECURITY.md` §1 "rotasi saat ganti
    peran").
12. Admin yang diizinkan mengubah email pengirim (PENGATURAN-UI) tidak boleh bisa mengubah
    email/password Owner atau menaikkan peran sendiri; catat penolakan akses (R8).
13. Pertimbangkan RLS Postgres sebagai lapis kedua isolasi organisasi (F.11).

**Lain-lain**

14. Sebelum Fase 2 menyimpan token Meta: tambahkan ID kunci di format kotak rahasia
    (`v1.<kid>.<nonce>.<sandi>`) dan perintah re-enkripsi untuk rotasi `BALESIN_MASTER_KEY`;
    sekarang hanya ada awalan versi skema.
15. Web: jangan memanggil `/auth/me` secara berkala di latar belakang — setiap GET menggeser batas
    idle sehingga sesi tab yang terbuka tidak pernah kedaluwarsa karena diam.
16. Pertimbangkan daftar sesi aktif + "keluar dari semua perangkat" untuk pengguna (dibutuhkan
    juga untuk respons insiden akun CS dibobol).
