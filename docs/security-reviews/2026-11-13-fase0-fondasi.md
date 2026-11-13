# Review keamanan — Fase 0 (Fondasi)

- **Tanggal:** 2026-11-13
- **Cakupan:** `git diff 1f4e119..c6ed37f` (branch `dev`). Commit `c6ed37f` (revisi web) masuk
  saat review berjalan dan ikut diperiksa.
- **Acuan:** `docs/SECURITY.md`, aturan keras `CLAUDE.md`, `docs/ARCHITECTURE.md`,
  `docs/PENGATURAN-UI.md`.
- **Model ancaman:** penyerang memegang satu akun CS dan ingin memakai nomor WhatsApp
  perusahaan atau mencuri token Meta. Fase 0 belum punya auth/RBAC, jadi yang dinilai adalah
  fondasi yang diwarisi semua fase: redaksi log, error handler, header/CORS, konfigurasi,
  skema sesi, util tes, dan rantai pasok.
- **Cara uji:** baca kode, lalu dibuktikan dengan menjalankan — terhadap Postgres 16 dan
  Redis 7 lokal (Docker dev), server HTTP di port acak `127.0.0.1`, dan `app.inject()`. Tidak ada
  sistem di luar mesin ini yang disentuh. Kode produk dan konfigurasi tidak diubah.

## Putusan: PERBAIKI

Satu temuan **Tinggi** (T1). Tidak ada temuan Kritis. Perbaikan T1 kecil (satu berkas) dan
tesnya sudah tersedia.

| Level  | Jumlah | Kode           |
| ------ | ------ | -------------- |
| Kritis | 0      | —              |
| Tinggi | 1      | T1             |
| Sedang | 3      | S1, S2, S3     |
| Rendah | 12     | R1–R12         |
| Info   | 6      | I1–I6          |

---

## A. Harus diperbaiki sekarang (memblokir)

### T1 — Tinggi — Error balasan Redis menulis argumen perintah ke log, termasuk password `REDIS_URL`

**Bukti**

- `packages/core/src/redact.ts:186-192` — `walkError` meneruskan semua properti milik error.
  Yang dikecualikan hanya `params`/`parameters`/`detail`/`where` (`redact.ts:52`).
- ioredis menempelkan `err.command = { name, args }` pada setiap error balasan. `args` bukan
  nama kunci rahasia, jadi isinya lolos apa adanya.
- Jalur yang sudah ada hari ini: `packages/core/src/redis.ts:52-58` (listener `error`),
  `apps/worker/src/runtime.ts:27-39` (worker BullMQ), `apps/api/src/http/error-handler.ts:141`
  (semua 500), `apps/api/src/modules/health/health.service.ts:55`.

**Dibuktikan dengan menjalankan** (Redis 7 dev, ioredis 6.0.0):

- Sambungan dengan password yang ditolak → baris log `warn` "Koneksi Redis bermasalah" memuat
  password dari URL di `err.command.args` (argumen perintah autentikasi yang ditolak).
- Perintah biasa yang gagal (`INCRBY kunci nilai`) → nama kunci dan nilainya ikut ter-log.

**Dampak**

- Password Redis tertulis jelas di log pada gangguan operasional biasa: password di server
  berubah lebih dulu/lebih lambat daripada `.env`, ACL diubah, salah ketik satu karakter. Tidak
  perlu penyerang.
- Mulai Fase 1 argumennya jauh lebih sensitif: kunci sesi/rate limit, dan isi job BullMQ
  (skrip Lua `addJob` membawa seluruh payload: nomor dan isi pesan pelanggan). Error seperti
  `MISCONF` (disk penuh), `OOM`, `LOADING`, `READONLY` membuat setiap perintah gagal, jadi
  semuanya mengalir ke log.
- Melanggar `SECURITY.md` §3 ("Tidak ada rahasia di log") dan aturan keras `CLAUDE.md`.
  Eksploitasi butuh akses ke log, tetapi log produk self-hosted lazim dikirim ke pihak lain
  saat minta bantuan. Dinilai Tinggi karena rahasianya nyata, pemicunya kejadian biasa, dan
  fondasi ini dipakai semua fase.

**Perbaikan** — `packages/core/src/redact.ts`, fungsi `walkError`:

- Properti `command` berbentuk objek ditulis hanya `{ name }` (buang `args`). Bila berupa
  string (nodemailer: `"AUTH PLAIN"`), biarkan lewat `walk` seperti sekarang.
- Tambahkan `args` ke `ERROR_DATA_PROPS` sebagai jaring kedua.
- Setelah itu hapus `.fails` pada tiga tes T1 di `packages/core/src/redact.security.test.ts`.

---

## B. Sebaiknya diperbaiki sekarang (tidak memblokir putusan; murah dan diwarisi semua fase)

### S1 — Sedang — Sensor berbasis nama kunci tidak berlaku untuk objek di argumen format dan JSON di dalam string

**Bukti:** `packages/core/src/logger.ts:158-163` (argumen format hanya melewati
`streamWrite`), `packages/core/src/redact.ts:54-68` (pola teks hanya mengenal `kunci=nilai`).

- `logger.info('payload %j', { password, token })` → nilai tertulis utuh.
- `logger.info({ raw: '{"password":"…","access_token":"…"}' })` atau pesan berisi body mentah
  balasan upstream → nilai tertulis utuh (token Meta `EAA…` tetap tertangkap pola sendiri;
  App Secret, password, token undangan/reset tidak).

**Dampak:** satu baris log debugging yang wajar di Fase 2 (balasan Graph API, body webhook)
cukup untuk membocorkan rahasia.

**Perbaikan** — `packages/core`:

- `redact.ts`: tambah pola teks untuk pasangan JSON `"kunci":"nilai"` dengan kunci sensitif,
  dalam dua bentuk (mentah dan ter-escape `\"kunci\":\"nilai\"`), dipakai kedua fungsi scrub.
- `logger.ts` `hooks.logMethod`: jalankan `redactSecrets` pada argumen format bertipe objek
  sebelum pino menyusun pesan.

### S2 — Sedang — Regex sensor parameter Drizzle berjalan kuadratik (ReDoS pada setiap baris log)

**Bukti:** `packages/core/src/redact.ts:77-78`, dipakai di `redact.ts:97` dan `:105`, dipasang
pada semua baris log lewat `logger.ts:162`.

Terukur di mesin ini untuk teks `"Failed query: "` berulang:

| Ukuran teks | `scrubSecretsInText` | `scrubSecretsInJsonLine` |
| ----------- | -------------------- | ------------------------ |
| 42 KB       | 13 ms                | 405 ms                   |
| 168 KB      | 218 ms               | 3,4 detik                |
| 336 KB      | 872 ms               | 12,3 detik               |

Batas body 1 MiB berarti satu baris log bisa menahan event loop lebih dari satu menit.

**Terjangkau sekarang?** Tidak. Sudah diperiksa: path URL mentah tidak bisa memuat spasi
(ditolak parser HTTP), error 4xx tidak menulis masukan klien ke log, dan header dibatasi 16 KB.
Menjadi terjangkau begitu teks dari luar ikut ter-log — isi pesan pelanggan, badan email,
payload webhook (Fase 2), oleh pihak yang tidak perlu login.

**Perbaikan** — `packages/core/src/redact.ts`: ganti kedua regex dengan pemindaian linear
(`indexOf('Failed query: ')` lalu `indexOf` penanda `params: ` setelahnya; potong sampai akhir
teks, atau sampai tanda kutip penutup untuk bentuk JSON). Tambahan berlapis: potong string
yang lebih panjang dari ±16 KB di `walk` sebelum disensor.

### S3 — Sedang — `TRUST_PROXY=true` diterima di production: IP klien bisa dipalsukan

**Bukti:** `apps/api/src/config.ts:68-70` dan `:88-92`, diteruskan ke Fastify di
`apps/api/src/app.ts:55`; `.env.example:14-15` menganjurkan "Isi true".

Dengan `true`, Fastify mengambil nilai paling kiri `X-Forwarded-For`, yaitu yang dikirim klien
sendiri (nginx dengan `$proxy_add_x_forwarded_for` hanya menambah di kanan). Terbukti:
`X-Forwarded-For: 6.6.6.6, 203.0.113.9` → `request.ip = 6.6.6.6`. Dengan daftar IP proxy,
hasilnya `203.0.113.9` (benar). Selain itu `TRUST_PROXY=1` dibaca sebagai `true`, padahal di
Fastify angka berarti "jumlah hop".

**Dampak (Fase 1):** batas login per IP dan kunci 15 menit bisa dilewati dengan mengganti
header; IP di audit log dan daftar sesi bisa dipalsukan.

**Perbaikan** — `apps/api/src/config.ts` dan `.env.example`:

- Di production tolak `true`/`1`; wajibkan daftar IP/CIDR proxy (mode A: IP privat vm-nginx;
  mode C: subnet container cloudflared).
- Perbarui komentar `.env.example` dengan contoh daftar IP.
- Hapus `.fails` pada tes S3 di `apps/api/src/security-review.test.ts`.

### R1 — Rendah — Pola rahasia di teks bebas punya celah

**Bukti:** `packages/core/src/redact.ts:56-67`.

- Nama parameter berawalan tidak tertangkap: `reset_token=`, `invite_token=`,
  `page_access_token=`, `new_password=` (lookbehind di `:61` hanya menerima nama persis).
- Password berisi `@` di URL koneksi: ekornya bocor
  (`postgres://[DISEMBUNYIKAN]@ss-ekor@db…`); password berisi tanda kutip tidak disensor sama
  sekali (`:56`).
- Tidak ada pola untuk token bot Telegram di path (`/bot<id>:<token>/`), `code=` OAuth, nilai
  cookie di teks (`cookie: sid=…`), dan `sha256=<tanda tangan>`.

**Perbaikan:** izinkan awalan `[A-Za-z0-9_.-]*` sebelum `token|secret|password|…` ; untuk URL
ambil sampai `@` TERAKHIR sebelum `/`, `?`, `#`, atau spasi; tambah pola token Telegram
sebelum channel Telegram dibangun.

### R2 — Rendah — Pesan error Postgres yang mengulang nilai ikut ter-log

**Bukti:** `packages/core/src/redact.ts:201-207`. Terbukti di Postgres 16: SQLSTATE `22P02`
menulis `invalid input syntax for type uuid: "<nilai>"` di `cause.message`, dan itu lolos.

**Dampak:** nilai yang salah kolom (mis. token sesi dikirim ke kolom `uuid`) atau data pribadi
masuk log. **Perbaikan:** untuk error ber-`severity` + `code` SQLSTATE kelas `22`, buang
bagian pesan setelah `: "`.

### R3 — Rendah — Nama kunci rahasia yang belum dikenali

**Bukti:** `packages/core/src/redact.ts:18-43`. Tidak disensor: `accessKey`, `licenseKey`,
`sessionId`, `sid`, `passcode`, `jwt`. **Perbaikan:** tambahkan `accesskey`, `licensekey`,
`sessionid`, `passcode`, `jwt` ke daftar potongan dan `sid` ke daftar persis. `code` dan `key`
sengaja tidak — terlalu umum (kode SQLSTATE, nama kunci Redis).

### R4 — Rendah — Error non-Fastify ber-`statusCode` 4xx menentukan status respons dan penyebabnya tidak tercatat

**Bukti:** `apps/api/src/http/error-handler.ts:105-112` dan `:142-149`. Error klien HTTP pihak
ketiga dengan `statusCode: 401` (mis. Graph API menolak token) dijawab ke browser sebagai 401
"perlu masuk", dan log hanya berisi `errorCode` — pesan aslinya hilang.

**Dampak:** insiden token Meta kedaluwarsa tidak terlacak; web bisa mengeluarkan pengguna.
Pesan asli memang tidak sampai ke klien (sudah benar). **Perbaikan:** hormati `statusCode`
hanya untuk error Fastify (`code` berawalan `FST_`) dan `AppError`; selebihnya 500 + log `err`.

### R5 — Rendah — Parser body `text/plain` bawaan Fastify masih aktif

**Bukti:** `apps/api/src/app.ts:46-61` (tidak ada `removeContentTypeParser`). `POST` lintas
situs ber-`text/plain` tidak memicu preflight dan sampai ke handler dengan body string
(terbukti: 200). Form urlencoded/multipart sudah ditolak 415.

**Dampak:** kecil — skema Zod menolak string. Pertahanan CSRF yang sebenarnya ada di Fase 1.
**Perbaikan:** `app.removeContentTypeParser('text/plain')` di `buildApp`.

### R6 — Rendah — Respons error tingkat framework tanpa header keamanan

**Bukti:** `apps/api/src/app.ts:58-60`; header dipasang di hook (`security.ts:53-63`) yang
tidak berjalan untuk `frameworkErrors`. `/%zz` (400) dan parameter rute > 100 karakter (414)
dijawab tanpa `nosniff`, CSP, `cache-control: no-store`, `x-request-id`, dan CORS.

**Dampak:** rendah — isinya amplop JSON statis, tidak memantulkan masukan (dijaga tes).
**Perbaikan:** di `frameworkErrors`, pasang `x-content-type-options`, `cache-control: no-store`,
dan `x-request-id` sebelum memanggil `handleError`.

### R7 — Rendah — `Permissions-Policy` belum dikirim

**Bukti:** `apps/api/src/http/security.ts:23-41`; helmet tidak memasangnya, padahal tercantum
di `SECURITY.md` §8. Untuk API JSON dampaknya nyaris nol. **Perbaikan:** tambahkan di hook
`onRequest`, dan wajib ada di konfigurasi server statis web (Fase 7).

### R8 — Rendah — Util tes yang menghapus database tidak menjaga dirinya sendiri

**Bukti:** `packages/db/src/testing/index.ts:90-110`.

- `dropStaleTemporaryDatabases` dan `assertTestDatabaseReachable` diekspor tanpa memeriksa
  akhiran `_test`; pengamannya hanya di pemanggil (`global-setup.ts:27`).
- `index.ts:105`: umur database dibaca dengan `parseInt(…, 36)`, yang menerima hampir semua
  kata. Terbukti: database `balesin_test_tmp_arsip_<acak>` dianggap "sisa tes lama" dan
  dihapus paksa.

**Jawaban atas pertanyaan orkestrator:** lewat jalur yang dipakai sekarang, database non-tes
tidak bisa terhapus — nama wajib berakhiran `_test`, yang dihapus hanya berawalan
`<nama>_test_tmp_`, dan `drop()` hanya mengenai nama buatannya sendiri. Sisa risikonya dua hal
di atas. **Perbaikan:** panggil `resolveTestDatabaseUrl` di dalam kedua fungsi; cocokkan nama
dengan pola penuh `^<nama>_tmp_[0-9a-z]{8,9}_[0-9a-f]{8}$` sebelum menghapus.

### R9 — Rendah — Blokir library WhatsApp tidak resmi hanya mencocokkan nama persis

**Bukti:** `eslint.config.js:13-22` dan `:67-76`. Tidak mencakup sub-path (`baileys/lib/…`),
`import()` dinamis, paket lain (`@wppconnect/wa-js`, `wa-multi-session`, `venom`,
`@builderbot/provider-baileys`), atau paket yang hanya ditambahkan ke `package.json`.

Keadaan sekarang bersih: 547 paket di lockfile diperiksa, tidak ada library WhatsApp tidak
resmi. **Perbaikan:** pakai `patterns` (`baileys*`, `*baileys*`, `whatsapp-web.js*`,
`*wppconnect*`, `venom*`, `*open-wa*`, `wa-automate*`) dan tambah langkah CI yang menggagalkan
bila nama itu muncul di `pnpm-lock.yaml`.

### R10 — Rendah — Kebijakan umur rilis tidak tertulis di konfigurasi

**Bukti:** `pnpm-workspace.yaml:22-25` hanya berisi `allowBuilds`; `docs/DECISIONS.md:19`
mengandalkan bawaan pnpm 12. `pnpm config get minimumReleaseAge` mengembalikan `undefined`,
jadi nilai efektifnya tidak bisa saya pastikan dari konfigurasi. **Perbaikan:** tulis
`minimumReleaseAge` secara eksplisit (≥ 1440 menit) supaya tidak bergantung versi pnpm.

### R11 — Rendah — `pnpm db:migrate` mencetak pesan error mentah

**Bukti:** `packages/db/src/migrate.ts:20-26`. Connection string tidak ikut (sudah benar),
tetapi pesan Drizzle memuat baris `params:` tanpa sensor. Sekarang isinya hanya hash migrasi.
**Perbaikan:** cetak pesan `cause` (error Postgres) dan kode SQLSTATE saja.

### R12 — Rendah — `.gitignore` hanya menyebut tiga nama `.env`

**Bukti:** `.gitignore:8-11`. `.env.staging`, `.env.backup`, `.env.test` tidak diabaikan.
**Perbaikan:** `.env*` + `!.env.example`; tambah `*.pem`, `*.key`, dan folder cadangan saat
Fase 7.

---

## C. Info (tidak perlu tindakan sekarang)

- **I1 — `pnpm audit`:** 2 temuan sedang, 0 tinggi/kritis; `pnpm audit --prod` bersih. Rincian
  di bagian E.
- **I2 — Fakta dari QA, sudah diverifikasi:**
  - Metode salah di `/health`/`/ready` dijawab 404, bukan 405 — tidak ada risiko.
  - Preflight dari origin tak diizinkan dijawab **204 tanpa `access-control-allow-origin`**
    (browser memblokir). Jawaban 400 `text/plain` muncul bila `OPTIONS` tanpa `Origin` atau
    `Access-Control-Request-Method`; isinya teks statis.
  - `access-control-allow-credentials: true` tanpa `allow-origin` tidak memberi izin apa pun.
  - `/%zz` → lihat R6.
- **I3 — CORS:** hanya origin persis `APP_URL` yang mendapat izin; `null` dan
  `http://localhost:5173.jahat.example` ditolak; `vary: Origin` terpasang.
- **I4 — `/ready` publik** membuka status `ok`/`down` Postgres/Redis. Jangan diteruskan proxy
  publik (Fase 7).
- **I5 — Kekuatan kunci:** `BALESIN_MASTER_KEY` diperiksa panjangnya (32 byte), `SESSION_SECRET`
  minimal 32 karakter; nilai berentropi rendah (`AAAA…`) tetap lolos. Installer harus membuat
  keduanya secara acak.
- **I6 — Di luar cakupan diff:** `docs/reference/n8n/ulan-workflow.json` (commit awal) sudah
  dipindai — token sudah diganti penanda, tidak ada kredensial; tetapi memuat IP internal dan
  alur bisnis Sky Tech. Screenshot `docs/reference/mobichat/` tidak saya periksa.

## D. Yang diperiksa dan dinilai aman

- **Redaksi log:** header sensitif, objek bersarang sampai kedalaman 8, `Secret`, data biner,
  referensi melingkar, `cause`/`AggregateError`, binding child logger, `log.error(err)` tanpa
  pesan, parameter dan `detail`/`where` error Postgres/Drizzle, stack. Baris log tetap JSON sah
  untuk masukan yang dirancang merusak. Password Postgres tidak bocor untuk password salah
  maupun URL ganjil (diuji ke Postgres sungguhan).
- **Log request:** hanya method, path tanpa query, IP, status. Header dan body tidak pernah
  ditulis. ID request dibuat server.
- **Error handler:** lemparan non-Error (string/objek) → 500 pesan umum; 404 tidak memantulkan
  alamat; respons disaring skema Zod; `__proto__` di JSON ditolak 400.
- **Env/master key:** pesan validasi hanya memuat nama variabel; rahasia dibungkus `Secret`;
  error start disensor; NODE_ENV kosong/salah = seketat production; https wajib di production.
- **Header:** CSP `default-src 'none'`, HSTS (production), `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer`, COOP, CORP `same-site`, `cache-control: no-store`.
- **Skema:** sesi menyimpan hash token (unik), kedaluwarsa idle dan absolut (dengan CHECK),
  `revoked_at`; FK komposit `(organization_id, user_id)` mencegah baris anak menunjuk
  organisasi lain; email unik per organisasi dan wajib bentuk baku.
- **Worker:** payload divalidasi `z.strictObject`; job tak dikenal gagal permanen; isi job tidak
  ditulis ke log.
- **Web:** tidak ada inline script (`theme-init.js` eksternal, nilainya dibatasi
  `light`/`dark`); tidak ada `dangerouslySetInnerHTML`, `innerHTML`, `eval`, URL luar, atau
  `target="_blank"`; `localStorage` hanya untuk preferensi tampilan; rute pratinjau hanya di
  mode dev; `c6ed37f` tidak menambah hal berisiko.
- **Rantai pasok/CI:** semua resolusi lockfile dari registry npm dengan `sha512`; tidak ada
  nama mirip typosquat; skrip install hanya `esbuild`; keempat action di-pin ke SHA yang cocok
  dengan tag yang ditulis (dicek dengan `git ls-remote`); `permissions: contents: read`,
  `persist-credentials: false`, pemicu `pull_request` (bukan `pull_request_target`).
- **Dev infra:** port Postgres/Redis hanya di `127.0.0.1`; Redis ber-password.
- **Hook `after-edit.mjs`:** `spawnSync` tanpa shell, path dibatasi di dalam repo.
- **Rahasia/Sky Tech di kode:** tidak ada kredensial sungguhan ter-commit; `.env` tidak pernah
  ada di riwayat; tidak ada hal khusus Sky Tech di `apps/`, `packages/`, `deploy/`, `.github/`.

## E. Hasil `pnpm audit`

| Paket | Advisory | Jalur | Terjangkau di produksi? | Tindakan |
| --- | --- | --- | --- | --- |
| `esbuild` 0.18.20 | GHSA-67mh-4wv8-2f99 (sedang) | `@balesin/db` › `drizzle-kit` (dev) › `@esbuild-kit/esm-loader` › `@esbuild-kit/core-utils` | Tidak. Hanya dipakai `pnpm db:generate`; celahnya di dev server esbuild, yang tidak pernah dijalankan drizzle-kit. | Terima. Jangan di-override (esbuild-kit dikunci ke API 0.18). Hilang saat drizzle-kit melepas `@esbuild-kit`. |
| `minimatch` 10.2.6 | GHSA-g3hv-75wg-m249 (sedang) | `eslint`, `typescript-eslint` (dev) | Tidak. Pola glob berasal dari konfigurasi sendiri. | Terima; naik lewat Dependabot. Override ke 11.x tidak disarankan (lompat versi mayor). |

Job CI `audit` sudah menggagalkan temuan tinggi/kritis.

## F. Catatan untuk Fase 1+ (wajib ada saat auth dibangun)

**Sesi dan cookie**

1. Cookie sesi berawalan `__Host-`, `HttpOnly; Secure; SameSite=Lax; Path=/`. Token
   `randomBytes(32)`, simpan SHA-256-nya, cari berdasarkan hash.
2. Sesi sah hanya bila `revoked_at is null`, kedua batas waktu belum lewat, DAN
   `users.disabled_at is null` (join) — menonaktifkan akun harus langsung mematikan sesinya.
3. Batasi panjang `user_agent` (mis. 512) sebelum disimpan ke `user_sessions`/`audit_logs`.

**CSRF dan lintas situs**

4. `SameSite=Lax` tidak melindungi dari subdomain satu "site" (CORP sudah `same-site`).
   Token CSRF harus terikat sesi (HMAC dengan `SESSION_SECRET`), ditambah pemeriksaan `Origin`
   pada semua permintaan yang mengubah data.
5. WebSocket inbox (Fase 2): periksa `Origin` saat upgrade; CORS tidak berlaku untuk WebSocket.

**IP klien, rate limit, tautan**

6. Perbaiki S3 sebelum rate limit login dibuat.
7. `request.ip` bisa bukan alamat IP (terbukti: `X-Forwarded-For: bukan-alamat-ip` lewat proxy
   tepercaya). Validasi dengan `net.isIP` sebelum masuk kolom `inet` atau kunci rate limit —
   kalau tidak, insert audit/sesi gagal (22P02).
8. Jangan menyusun tautan (reset password, undangan) dari `request.host`/`request.protocol`;
   keduanya mengikuti `X-Forwarded-*`. Selalu dari `config.appUrl`.

**Otorisasi dan respons**

9. RBAC di satu `preHandler`, bawaan tolak: rute tanpa deklarasi izin gagal saat registrasi.
   Tes matriks peran × endpoint.
10. Setiap rute wajib punya skema respons (paksa lewat hook `onRoute`) supaya `password_hash`
    dan `token_hash` tidak mungkin ikut terkirim.
11. Semua fungsi repo menerima `organizationId`; tabel anak baru memakai FK komposit seperti
    `user_sessions`. Pertimbangkan RLS Postgres sebagai lapis kedua.

**Rahasia**

12. Wizard setup: wajibkan `SETUP_TOKEN` di production selama belum ada Owner; bandingkan
    dengan `timingSafeEqual`; kunci di tingkat transaksi setelah Owner dibuat.
13. AES-256-GCM: nonce acak 96-bit per enkripsi, AAD berisi organisasi + nama kolom, awalan
    versi kunci. Turunkan sub-kunci dengan HKDF. Bila `masterKey` kosong (dev), TOLAK
    menyimpan kredensial — jangan pernah menyimpan polos.
14. Token jangan diletakkan di segmen path (path ikut ter-log): token undangan/reset di body
    atau fragment.
15. Payload job dan nama kunci Redis jangan memuat rahasia. BullMQ menyimpan payload,
    `failedReason`, dan stack di Redis (ter-persist). Kirim ID, dekripsi di worker.

**Audit log**

16. Tulis lewat satu helper yang melewatkan `metadata` ke `redactSecrets`. Jadikan
    hanya-tambah di tingkat database (trigger penolak `UPDATE`/`DELETE`) — sekarang baru
    konvensi (`packages/db/src/schema/audit-logs.ts:11`).

**Fase berikutnya**

17. Webhook Meta (Fase 2): raw body dan `bodyLimit` per rute; HMAC waktu-konstan.
18. SSRF (Fase 4): `OUTBOUND_PRIVATE_ALLOWLIST` sekarang menerima `0.0.0.0/0`; beri batas
    prefix minimum dan selalu blokir link-local/metadata.
19. Produk (Fase 7): keluarkan `docs/reference/` dan `docs/KONTEKS-SKYTECH.md` dari image dan
    installer. CSP web `script-src 'self'` sudah bisa (tanpa inline script); Radix dan
    `react-remove-scroll` menyisipkan `<style>`, jadi `style-src` perlu nonce atau
    `'unsafe-inline'`. Pin image dengan digest.

## G. Tes

Pola di ketiga berkas: `it(...)` = penjaga regresi; `it.fails(...)` = celah yang masih terbuka
(isi tes menyatakan perilaku yang benar). Setelah celah diperbaiki, Vitest melaporkan tes itu
gagal — saat itu hapus `.fails`-nya. Setiap `it.fails` sudah dipastikan gagal karena alasan
yang dimaksud.

| Berkas | Asal | Isi |
| --- | --- | --- |
| `packages/core/src/redact.security.test.ts` | Sisa review sebelumnya; dinilai benar, dipertahankan dengan perubahan | T1 (server Redis palsu di `127.0.0.1`), S1, S2, R1, R2, keabsahan JSON. Ditambah R3; satu pemeriksaan yang bergantung versi ioredis dilonggarkan. |
| `apps/api/src/security-review.test.ts` | Sisa review sebelumnya; dinilai benar, dipertahankan dengan perubahan | S3, error handler, R4, R5. Ditambah R6 dan fakta `request.ip`/`host` lewat proxy. |
| `packages/db/src/testing/guard.security.test.ts` | Baru | R8. |

Hasil setelah perubahan (Postgres + Redis lokal):

| Paket | Lulus | Diharapkan gagal (celah terbuka) |
| --- | --- | --- |
| `packages/core` | 135 | 19 (T1 ×3, S1 ×2, S2 ×1, R1 ×6, R2 ×1, R3 ×6) |
| `apps/api` | 57 | 5 (S3 ×1, R4 ×2, R5 ×1, R6 ×1) |
| `packages/db` | 51 | 3 (R8 ×3) |
| `apps/worker` | 16 | 0 |
| `packages/shared` | 11 | 0 |

ESLint, Prettier, dan `tsc --noEmit` bersih untuk ketiga berkas tes. Tes `apps/web` dan E2E
tidak dijalankan ulang (milik agent frontend; dev server sedang dipakai).
