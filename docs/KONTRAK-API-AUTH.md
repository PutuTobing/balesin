# Kontrak API — Setup, Login, 2FA, Branding, Email pengirim (Fase 1)

Sumber kebenaran tipe: skema Zod di `packages/shared/src/auth.ts` dan konstanta path di
`packages/shared/src/api-routes.ts` (`API_ROUTES`). Dokumen ini menjelaskan perilaku yang
tidak terlihat dari skema. Semua path diawali `/api/v1`.

## Aturan umum
- Web memanggil lewat proxy `/api` di origin yang sama, selalu `credentials: 'include'`.
- Bentuk error: `{ error: { code, message, details?: [{ location, field, message }], requestId } }`.
  `field` memakai titik, mis. `owner.password`, `email.port`.
- Setiap POST/PUT/PATCH/DELETE yang butuh sesi wajib membawa header `X-CSRF-Token`
  (`CSRF_HEADER_NAME`) berisi `csrfToken` dari respons login, setup, atau `/auth/me`. Simpan di
  memori saja (bukan localStorage). Token tetap selama sesi hidup. Bila dapat 403 `CSRF_INVALID`,
  panggil ulang `/auth/me` lalu ulangi permintaan sekali.
- Permintaan pengubah data dengan `Origin` selain `APP_URL` → 403 `FORBIDDEN`.
- Tanpa sesi di rute terlindungi → 401 `UNAUTHENTICATED` (semua metode). Sesi kedaluwarsa/dicabut:
  cookie dihapus, pesan "Sesi kamu sudah berakhir…".
- Dengan sesi, metode salah → 405 + header `Allow`.
- 429 selalu membawa `Retry-After` (di-expose lewat CORS).
- Isian opsional kosong (mis. `replyTo`, `username`) dikirim `null`, bukan `""`.
- Cookie sesi: `__Host-balesin_session` (Secure) bila `APP_URL` https; `balesin_session` tanpa
  Secure bila `APP_URL` http (pengembangan lokal).

## Setup (publik; 409 `CONFLICT` setelah Owner dibuat; semua kecuali status wajib `setupToken` di body)

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/setup/status` | – | `setupStatusResponseSchema` `{needsSetup, setupTokenConfigured, canStoreSecrets}` |
| POST `/setup/verify-token` | `verifySetupTokenRequestSchema` | `{valid: true}` |
| POST `/setup/check-password` | `checkSetupPasswordRequestSchema` (`password`, opsional `email`/`name`/`organizationName`) | `{acceptable, message \| null}` |
| POST `/setup/email/detect-host` | `setupDetectEmailHostRequestSchema` (`emailAddress`) | `detectEmailHostResponseSchema` |
| POST `/setup/email/test-connection` | `{setupToken, settings: emailSettingsInputSchema}` | `emailTestResultSchema` `{ok, code, message, testedAt}` |
| POST `/setup/email/send-test` | `{setupToken, to, settings}` | `emailTestResultSchema` |
| POST `/setup/complete` | `completeSetupRequestSchema` | **201** `completeSetupResponseSchema` (sesi terbatas `two_factor_enrollment_required`) + Set-Cookie sesi saja |

Error setup:
- 400 `VALIDATION_ERROR`: field Zod, plus `owner.password` (kebijakan password),
  `email.port`/`email.password` (complete) atau `settings.port`/`settings.password` (tes),
  `branding.logo` (bukan PNG/JPG/WebP, isi tidak cocok jenisnya, atau > 256 KB).
- 403 `FORBIDDEN`: token salah, atau origin asing.
- 409: setup sudah selesai → arahkan ke halaman masuk.
- 429: token per IP 10×/15 menit (token benar tidak dihitung), 100 token salah/15 menit global;
  tes email 10×/5 menit per IP; deteksi host 30×/5 menit per IP.
- 503: `SETUP_TOKEN` belum diisi, atau langkah email dikirim padahal `BALESIN_MASTER_KEY` kosong.
- Hasil tes email yang gagal tetap 200 dengan `ok: false`; tampilkan `message` apa adanya
  (16 kode di `EMAIL_TEST_CODES`).

### Alur wizard
1. `GET /branding` dan `GET /setup/status`.
   - `needsSetup: false` → ke halaman masuk.
   - `setupTokenConfigured: false` → petunjuk mengisi `SETUP_TOKEN` di `.env` server.
   - `canStoreSecrets: false` → langkah Email dinonaktifkan dengan petunjuk (master key belum diisi).
2. **Token**: dari fragment URL `#token=…` atau isian, lalu `verify-token`. Token tidak boleh ada
   di path atau query.
3. **Organisasi**: nama, zona waktu (bawaan `Asia/Jakarta`).
4. **Owner**: nama, email, password (minimal 10 karakter, `PASSWORD_RULES_HINT`). Panggil
   `check-password` sebelum lanjut.
5. **Branding** (opsional): `productName`, `primaryColor` `#rrggbb`, logo
   `{contentType, dataBase64}` ≤ 256 KB (PNG/JPG/WebP; SVG ditolak).
6. **Email** (boleh dilewati): preset `SMTP_PRESETS`/`applySmtpPreset`; setelah alamat pengirim
   diisi panggil `detect-host` dan tampilkan sarannya; username bawaan = alamat pengirim; tombol
   "Tes koneksi" dan "Kirim email tes" (tujuan bawaan = email Owner); label keamanan
   `SMTP_SECURITY_LABELS`.
7. **Selesai**: `complete` 201 → Owner masuk dengan **sesi terbatas** dan wajib langsung mendaftarkan
   2FA (lihat bagian 2FA, "Wajib daftar"). Belum ada cookie perangkat dikenal. Error dipetakan ke langkah lewat awalan
   field (`owner.`, `organization.`, `branding.`, `email.`). 409 → halaman masuk.

## Auth
- POST `/auth/login` (publik, `loginRequestSchema`) → 200 `loginResponseSchema`. WAJIB periksa
  `status`: `authenticated` | `two_factor_required` | `two_factor_enrollment_required` (bagian 2FA).
  - 401 `INVALID_CREDENTIALS`: pesan sama untuk email tak terdaftar, password salah, akun
    nonaktif. Jangan diperlakukan seperti 401 sesi habis.
  - 429: per IP (20 gagal/15 menit, "…dari jaringanmu…") atau akun dikunci 15 menit setelah
    5 gagal.
  - 503: Redis mati / server sibuk. 400: validasi.
- POST `/auth/logout` (sesi + CSRF) → `{status: 'logged_out'}`, cookie dihapus.
- POST `/auth/logout` dan GET `/auth/me` juga berlaku untuk sesi terbatas.
- GET `/auth/me` (sesi) → `meResponseSchema` (`authenticated` | `two_factor_enrollment_required`) atau 401.

## Verifikasi dua langkah (2FA)

Skema di `packages/shared/src/two-factor.ts` dan `auth.ts`; path di `API_ROUTES.twoFactor`. TOTP
RFC 6238: SHA-1, 6 digit, 30 detik (Google Authenticator, Microsoft Authenticator, Authy, 1Password).
**Wajib** untuk Owner, Admin, Supervisor (`TWO_FACTOR_REQUIRED_ROLES`, `isTwoFactorRequired`); CS dan
Teknisi boleh mengaktifkannya sendiri. Setelah 2FA aktif, setiap login butuh langkah kedua.

### Tiga keadaan setelah password benar (`POST /auth/login`)

| `status` | Cookie | Arti / langkah web |
|---|---|---|
| `authenticated` | sesi + perangkat | Selesai (akun tanpa 2FA yang perannya tidak wajib). |
| `two_factor_required` | **tidak ada** | 2FA aktif. Body: `challengeToken`, `expiresAt` (5 menit), `attemptsRemaining` (3), `methods` (`totp`, plus `backup_code` bila masih ada kode cadangan). Tampilkan isian kode → `POST /auth/2fa/verify`. |
| `two_factor_enrollment_required` | sesi terbatas (30 menit) | Peran wajib 2FA tapi belum mendaftar. Bentuk body sama dengan sesi (`user`, `organization`, `csrfToken`, `session`). Arahkan ke layar pendaftaran 2FA. |

`GET /auth/me` dengan sesi terbatas mengembalikan `status: two_factor_enrollment_required` — web memakai
ini untuk memaksa layar pendaftaran (mis. setelah muat ulang). Sesi terbatas hanya boleh memanggil
`GET /auth/2fa`, `POST /auth/2fa/enroll`, `POST /auth/2fa/enroll/confirm`, `GET /auth/me`, dan
`POST /auth/logout`. Rute lain → **403 `TWO_FACTOR_ENROLLMENT_REQUIRED`** (ditegakkan di hook auth
server). Web: saat menerima kode ini dari rute mana pun, muat ulang `/auth/me` lalu arahkan ke layar
pendaftaran.

**Jenis sesi ditetapkan saat sesi dibuat.** Bila peran pengguna berubah sehingga jenis sesinya tidak
cocok lagi — sesi biasa milik pengguna yang perannya dinaikkan menjadi Owner/Admin/Supervisor (belum
ber-2FA), atau sesi terbatas milik pengguna yang perannya diturunkan — sesi itu **dicabut**: permintaan
berikutnya dijawab **401 `UNAUTHENTICATED`** "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan."
dan cookie dihapus (perlakuan sama dengan sesi habis). Setelah masuk ulang dengan password, pengguna
mendapat sesi yang sesuai. Hanya sesi terbatas yang boleh mulai mendaftar 2FA tanpa password.

### Langkah kedua: `POST /auth/2fa/verify` (publik, tanpa CSRF)

- Request `verifyTwoFactorRequestSchema`: `{ challengeToken, code }`. `code` = 6 digit TOTP **atau**
  kode cadangan; spasi, tanda hubung, dan huruf besar diabaikan (`normalizeTwoFactorCode`). Kirim dari
  browser yang sama (tantangan terikat user agent + jaringan saat password dimasukkan).
- 200 `verifyTwoFactorResponseSchema` = sesi penuh + `twoFactor: { method, backupCodesRemaining }`.
  503 bila data 2FA di server tidak bisa dibuka (master key berubah) — tampilkan pesannya.
  Memasang cookie sesi + cookie perangkat dikenal; sesi lama di browser itu dicabut (rotasi). Bila
  `method` = `backup_code`, tampilkan sisa kode dan sarankan membuat ulang bila tinggal sedikit.
- Simpan `challengeToken` di memori saja (bukan URL/localStorage). Sekali pakai.

| Kasus | Respons |
|---|---|
| Kode salah, kode TOTP yang sudah pernah dipakai (replay), atau kode cadangan terpakai | 400 `VALIDATION_ERROR`, `details[0].field = "code"`, pesan memuat "Sisa N percobaan." |
| Kode salah ke-3 pada tantangan yang sama | 401 `TWO_FACTOR_CHALLENGE_INVALID` "Kode salah 3 kali. Masuk lagi…" |
| Tantangan tidak dikenal, kedaluwarsa, sudah dipakai, dari browser/jaringan lain, atau akun dinonaktifkan | 401 `TWO_FACTOR_CHALLENGE_INVALID` → kembali ke langkah email + password dengan pesannya. **Bukan** sesi habis. |
| 5 kode salah per akun (dari tantangan mana pun) dalam 15 menit | 429 + `Retry-After` 900: langkah kedua dikunci 15 menit; `POST /auth/login` dengan password benar juga 429 selama kunci. Perangkat dikenal punya satu ember bersama per akun (hanya cookie perangkat yang terbit SETELAH 2FA aktif yang dihitung sebagai perangkat dikenal). Email pemberitahuan ke pemilik akun. |
| Lebih dari 30 permintaan verify per IP / 15 menit (yang berhasil tidak dihitung) | 429 |
| Kode bukan 6 digit dan bukan bentuk kode cadangan | 400 `VALIDATION_ERROR` (tidak dihitung sebagai percobaan) |

Toleransi jam ponsel ±1 langkah (±30 detik). Kode yang sama tidak bisa dipakai dua kali.

### Wajib daftar / mendaftar sendiri

1. (Opsional) `GET /auth/2fa` → `twoFactorStatusResponseSchema`
   `{ enabled, required, enabledAt, backupCodesRemaining, backupCodesGeneratedAt, enrollmentPending }`.
2. `POST /auth/2fa/enroll` (sesi + CSRF), body `startTwoFactorEnrollmentRequestSchema`:
   - dari sesi terbatas: `{}` (password baru saja dimasukkan saat masuk/setup);
   - dari sesi penuh (CS/Teknisi di halaman keamanan): `{ password }` **wajib** (400 field `password`
     bila kosong/salah).
   - 200 `startTwoFactorEnrollmentResponseSchema`: `otpauthUri`, `secret` (base32, 32 karakter),
     `secretGrouped` (per 4 karakter, untuk diketik manual), `issuer` (nama produk dari branding, atau
     nama organisasi), `accountName` (email), `expiresAt` (15 menit), `digits` 6, `periodSeconds` 30.
   - **Buat QR di browser dari `otpauthUri`** (pustaka QR lokal, jangan layanan luar); tampilkan juga
     `secretGrouped`. Jangan simpan rahasia di mana pun.
   - Memanggil lagi **dari sesi yang sama** selama rahasia tertunda masih berlaku (15 menit) =
     rahasia **yang sama** (aman untuk muat ulang layar; entri yang sudah dipindai tetap berlaku),
     dengan `expiresAt` baru 15 menit sejak saat itu. Setelah kedaluwarsa, atau dari sesi lain milik
     pengguna yang sama = rahasia baru (yang lama batal). Setiap panggilan tetap memakai jatah
     10×/15 menit.
   - 409 bila 2FA sudah aktif; 503 bila `BALESIN_MASTER_KEY` server kosong; 429 setelah 10 percobaan
     mulai/konfirmasi per 15 menit.
3. `POST /auth/2fa/enroll/confirm` (sesi + CSRF) `{ code }` (6 digit, `totpCodeSchema`):
   - 400 field `code` bila tidak cocok; 409 bila QR kedaluwarsa/belum dibuat, atau pendaftaran itu
     dimulai dari sesi lain ("Mulai lagi"). Konfirmasi hanya bisa dari sesi yang memulai pendaftaran.
   - 200 `confirmTwoFactorEnrollmentResponseSchema` = sesi penuh **baru** + `backupCodes:
     { codes: string[10] "xxxxx-xxxxx", generatedAt }`. Cookie sesi baru + cookie perangkat dikenal
     dipasang; **semua** sesi lama pengguna (termasuk sesi terbatas ini) dicabut — ganti `csrfToken`
     di memori dengan yang baru. Kode cadangan **hanya ditampilkan sekali**: tampilkan dengan tombol
     salin/unduh dan minta konfirmasi "sudah disimpan" sebelum lanjut ke aplikasi.

### Mengelola 2FA sendiri (sesi penuh + CSRF)

- `POST /auth/2fa/backup-codes` `twoFactorReauthRequestSchema` `{ password, code }` → 200
  `{ codes, generatedAt }` (10 kode baru, semua kode lama batal). `code` boleh TOTP atau kode cadangan.
- `POST /auth/2fa/disable` `{ password, code }` → 200 `{ status: "disabled" }`. Hanya peran yang tidak
  wajib; Owner/Admin/Supervisor → 403 `FORBIDDEN` ("Peranmu wajib memakai verifikasi dua langkah…").
- Error keduanya: 400 field `password` (password salah; kode tidak diperiksa) atau field `code`;
  409 bila 2FA belum aktif; 429 setelah 5 konfirmasi gagal per 15 menit per pengguna.
- Kode salah di sini dihitung di ember yang SAMA dengan langkah kedua saat masuk: kode salah ke-5
  (gabungan dengan percobaan masuk) → 429 "Terlalu banyak kode verifikasi yang salah…", langkah
  kedua akun dikunci 15 menit (login juga 429) dan email kunci dikirim.
- Mereset 2FA pengguna lain (Owner/Admin, mis. ponsel hilang) menyusul di manajemen pengguna.

### Email pemberitahuan (lewat worker, bila email pengirim sudah diatur)

2FA diaktifkan, 2FA dinonaktifkan, kode cadangan dipakai (dengan sisa kode), kode cadangan dibuat
ulang, dan kunci langkah kedua
(5 kode salah — tanda password-nya sudah diketahui orang lain). Email kunci tetap paling banyak satu
per jam per akun (berbagi jatah dengan kunci password).

### Catatan untuk tes E2E

Rahasia (`secret`) tampil di layar pendaftaran (teks untuk ketik manual). Tes bisa membacanya lalu
menghitung kode dengan `generateTotp(secret)` dari `@balesin/core` (atau HMAC-SHA1 RFC 6238 ±15 baris
di helper tes). Kode yang sama tidak bisa dipakai dua kali dalam 30 detik: untuk login berulang dalam
satu tes, pakai kode langkah berikutnya (`generateTotp(secret, Date.now() + 30_000)`), kode cadangan,
atau tunggu langkah berganti.

## Branding (publik)
- GET `/branding` → `brandingResponseSchema`.
- GET `/branding/logo?v=…` → berkas biner, atau 404 bila belum ada logo.

## Pengaturan → Email pengirim (khusus Owner untuk sementara; tulis butuh CSRF)
- GET `/settings/email` → `emailSettingsResponseSchema`: `source` database/env/none, `status`
  connected/failed/untested/not_configured, `lastTest`, `passwordHint`, `canStoreSecrets`.
- PUT `/settings/email` (`saveEmailSettingsRequestSchema`): `password` boleh tidak dikirim untuk
  memakai password tersimpan hanya bila host, port, keamanan, dan username tidak berubah; kalau
  berubah → 400 di field `password` ("Masukkan ulang password…"). 503 bila master key kosong.
- POST `/settings/email/detect-host` (30×/5 menit per pengguna).
- POST `/settings/email/test-connection` `{settings?}`: tanpa `settings` menguji pengaturan
  tersimpan dan mencatat status; dengan `settings` menguji draf form tanpa mengubah status.
- POST `/settings/email/send-test` `{to, settings?}`. Tes koneksi dan kirim tes berbagi jatah
  10×/5 menit per pengguna.

## Perubahan setelah review keamanan Fase 1 (path & bentuk tidak berubah)
- **Kunci login**: 429 muncul setelah 5 gagal untuk email yang sama **dari asal yang sama** (IP, atau /64
  untuk IPv6), atau setelah 50 gagal per jam dari banyak asal (hanya untuk perangkat yang belum dikenal).
  Perangkat yang pernah berhasil masuk hanya terkunci oleh 5 kegagalannya sendiri. Pesan dan
  `Retry-After` tidak berubah.
- **Cookie perangkat dikenal**: respons yang MENYELESAIKAN login (login akun tanpa 2FA,
  `POST /auth/2fa/verify`, `POST /auth/2fa/enroll/confirm`) memasang dua `Set-Cookie` — sesi dan
  `balesin_device` (http) / `__Host-balesin_device` (https), HttpOnly, `SameSite=Strict`, 90 hari.
  Sesi terbatas (setup, login peran wajib 2FA yang belum mendaftar) hanya memasang cookie sesi.
  Bukan kredensial; tidak dihapus saat logout. Web tidak perlu melakukan apa pun selain
  `credentials: "include"`.
- `GET /setup/status` setelah setup selesai → `{needsSetup: false, setupTokenConfigured: false,
  canStoreSecrets: false}`.
- **Email "Tanpa enkripsi" + login**: di production ditolak bila host di-resolve ke alamat internet —
  kode hasil tes `insecure_login`, dan error 400 di field `security` / `email.security` saat menyimpan.
  Form wajib menampilkan peringatan `SMTP_PLAINTEXT_LOGIN_WARNING` bila `isPlaintextSmtpLogin(input)`
  (dari `packages/shared/src/email-settings.ts`).
- API menolak start bila `SETUP_TOKEN`/`SESSION_SECRET` lemah; buat dengan
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Pengembangan lokal
- Mailpit (dari `pnpm db:up`) menangkap semua email: UI http://localhost:8025. Isian SMTP:
  host `localhost`, port `1025`, keamanan "Tanpa enkripsi", username/password `balesin`.

## Perubahan putaran kritikus/QA 2FA (path & bentuk tidak berubah)

- **Pesan 429 tanpa durasi** (web menampilkan hitung mundur dari `Retry-After`):
  - kunci langkah kedua: "Terlalu banyak kode verifikasi yang salah untuk akun ini."
  - konfirmasi ulang: "Terlalu banyak percobaan konfirmasi yang salah."
  - verify per IP: "Terlalu banyak percobaan verifikasi dari jaringanmu."
  - login, akun dikunci: "Akun ini dikunci sementara karena terlalu banyak percobaan masuk yang gagal."
  - login per IP: "Terlalu banyak percobaan masuk dari jaringanmu."
  - Pesan 429 lain (token setup, tes email, mulai/konfirmasi pendaftaran 2FA) tetap menyebut durasi.
- **Pendaftaran**: rahasia tertunda dipakai ulang di sesi yang sama (lihat langkah 2 bagian 2FA).
- **Email**: email kunci langkah kedua membedakan sumbernya (masuk vs konfirmasi ulang di Keamanan
  akun); email 2FA tidak lagi menyarankan fitur yang belum ada (ganti password, reset 2FA oleh
  Owner/Admin).
