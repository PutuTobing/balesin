# Kontrak API — Setup, Login, 2FA, Undangan, Atur ulang password, Verifikasi email, Branding, Email pengirim (Fase 1)

Sumber kebenaran tipe: skema Zod di `packages/shared/src/` (`auth.ts`, `two-factor.ts`, `invitations.ts`,
`password-reset.ts`, `email-verification.ts`, `email-templates.ts`, `links.ts`) dan konstanta path di
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

## Tautan email bertoken (undangan, atur ulang password, verifikasi email)

Berlaku untuk ketiga alur di bawah. Skema: `packages/shared/src/{links,invitations,password-reset,email-verification}.ts`.

- Bentuk tautan (disusun server dari `APP_URL`, **tidak pernah** dari header `Host`):
  `APP_URL + EMAIL_LINK_PATHS[jenis] + "#token=" + token` → `/undangan#token=…`,
  `/atur-ulang-password#token=…`, `/verifikasi-email#token=…`. Halaman "lupa password":
  `FORGOT_PASSWORD_PATH` = `/lupa-password`.
- **Token di fragment** (`#`), bukan path/query: fragment tidak dikirim browser ke server (tidak ada di log
  akses web/proxy/API — sensor log tidak menangkap rahasia di segmen path) dan tidak ikut `Referer`.
  Fragment tetap tersimpan di riwayat browser, jadi web WAJIB:
  1. membaca token dengan `readTokenFromFragment(location.hash)` saat halaman dibuka;
  2. **langsung** `history.replaceState(null, '', location.pathname)` (buang fragment);
  3. menyimpan token di memori komponen saja (bukan URL, storage, cache Query, atau log error);
  4. mengirim token di **body** `{ token }`.
- Token: 43 karakter base64url (256-bit). `linkTokenSchema` hanya memeriksa bentuk kasar; karakter lain →
  400 `VALIDATION_ERROR` field `token`.
- Token tidak berlaku (tidak dikenal, kedaluwarsa, sudah dipakai, dibatalkan, diganti tautan yang lebih
  baru) → **410 `TOKEN_INVALID`** dengan `message` khusus per kasus — tampilkan apa adanya beserta
  tombol ke langkah berikutnya (halaman masuk / minta tautan baru). Bukan sesi habis.
- Token tidak berlaku dari satu jaringan: 30 per 15 menit (`tautan-ip`, dipakai bersama ketiga alur;
  token sah tidak dihitung) → 429 "Terlalu banyak percobaan membuka tautan dari jaringanmu."
- Rute publik bertoken tidak butuh CSRF, tetapi `Origin` selain `APP_URL` → 403.

## Undangan

Tidak ada pendaftaran publik: pengguna selain Owner hanya lewat undangan. Owner hanya dibuat wizard setup.

### Siapa boleh mengundang (`INVITE_PERMISSIONS`, `canInviteRole`)

| Pengundang | Admin | Supervisor | CS | Teknisi | Owner |
|---|:-:|:-:|:-:|:-:|:-:|
| Owner | ✅ | ✅ | ✅ | ✅ | – |
| Admin | – | ✅ | ✅ | ✅ | – |
| Supervisor, CS, Teknisi | – | – | – | – | – |

Sama untuk kirim ulang dan batalkan: Admin melihat undangan Admin buatan Owner di daftar (`canManage: false`)
tetapi tidak bisa mengirim ulang/membatalkannya. Owner/Admin/Supervisor yang belum mendaftar 2FA (sesi
terbatas) → 403 `TWO_FACTOR_ENROLLMENT_REQUIRED`.

### Endpoint

| Metode & path | Akses | Request | Respons 2xx |
|---|---|---|---|
| GET `/invitations` | Owner/Admin | – | `invitationListResponseSchema` `{ invitations, invitableRoles, emailDelivery }` |
| POST `/invitations` | Owner/Admin + CSRF | `createInvitationRequestSchema` `{ email, role }` | **201** `invitationIssuedResponseSchema` `{ invitation, link }` |
| POST `/invitations/:invitationId/resend` | Owner/Admin + CSRF | – | 200 `invitationIssuedResponseSchema` |
| DELETE `/invitations/:invitationId` | Owner/Admin + CSRF | – | 200 `{ status: "revoked" }` |
| POST `/auth/invitation/inspect` | publik | `{ token }` | 200 `inspectInvitationResponseSchema` |
| POST `/auth/invitation/accept` | publik | `acceptInvitationRequestSchema` `{ token, name, password }` | **201** `acceptInvitationResponseSchema` (= `meResponseSchema`) + cookie |

Path ber-parameter disusun dengan `apiPath(API_ROUTES.invitations.resend, { invitationId })`.

`invitation` (`invitationSchema`): `id, email, role, status ("pending" | "expired"), invitedBy {id, name},
createdAt, lastSentAt, expiresAt, sendCount, deliveryStatus, canManage`. `deliveryStatus`
(`EMAIL_DELIVERY_LABELS`): `queued` "Sedang dikirim", `sent` "Email terkirim", `failed` "Email gagal
terkirim" (periksa Pengaturan → Email pengirim, lalu kirim ulang), `skipped` "Email tidak dikirim" (email
pengirim belum diatur saat worker memprosesnya — kirim ulang), `link` "Tautan disalin manual". Daftar hanya
memuat undangan terbuka (belum diterima/dibatalkan), terbaru dulu, maks. 200. Muat ulang daftar beberapa
detik setelah membuat undangan untuk melihat `queued` → `sent`.

### Tanpa email pengirim (`emailDelivery: false`)

Undangan tetap dibuat, tetapi tidak ada email: respons buat/kirim ulang membawa `link` (tautan lengkap).
- Tampilkan **sekali** dengan tombol "Salin" + teks "Kirim tautan ini sendiri ke {email} lewat jalur yang
  aman. Tautan hanya ditampilkan sekarang dan berlaku 72 jam." Jangan simpan di cache Query/storage, jangan
  tampilkan lagi setelah dialog ditutup (server tidak menyimpan token; untuk tautan baru → kirim ulang,
  yang membatalkan tautan sebelumnya). Setiap tampilan tercatat di audit (`user.invitation.link_shown`).
- Akun dari tautan yang disalin manual **tidak** dianggap email-terverifikasi (lihat Verifikasi email).
- Bila email pengirim sudah diatur, `link` selalu `null`.

### Alur Owner/Admin (Pengaturan → Tim / Pengguna)
1. `GET /invitations` → daftar + pilihan peran dari `invitableRoles` (label `USER_ROLE_LABELS`) + mode
   `emailDelivery` (beri tahu di form: "Undangan dikirim ke email" vs "Tautan undangan akan ditampilkan
   untuk kamu salin").
2. Form email + peran → `POST /invitations`. 201 → tambahkan ke daftar; bila `link` ≠ `null` buka dialog
   salin tautan.
3. Per baris: "Kirim ulang" (`POST …/resend`; tautan lama langsung batal, 72 jam lagi) dan "Batalkan"
   (`DELETE`, minta konfirmasi). Sembunyikan keduanya bila `canManage: false`. Status `expired` → tampilkan
   "Kedaluwarsa" + "Kirim ulang".

Error membuat/mengirim ulang/membatalkan:

| Kasus | Respons |
|---|---|
| Email tidak valid / memuat baris baru, peran bukan Admin/Supervisor/CS/Teknisi (termasuk `owner`) | 400 `VALIDATION_ERROR` field `email` / `role` |
| Admin mengundang/mengelola undangan Admin — termasuk membuat undangan untuk email yang masih punya undangan Admin terbuka (berlaku atau kedaluwarsa) | 403 `FORBIDDEN` "Admin hanya bisa mengundang dan mengelola undangan Supervisor, CS, dan Teknisi…" (tidak memakai kuota) |
| Supervisor/CS/Teknisi | 403 `FORBIDDEN` (deklarasi rute) |
| Email sudah dipakai pengguna organisasi (aktif atau nonaktif) | 409 `CONFLICT` field `email` "Email ini sudah terdaftar sebagai pengguna di organisasimu." |
| Masih ada undangan berlaku untuk email itu | 409 `CONFLICT` field `email` "…Kirim ulang dari daftar undangan bila perlu." (Undangan yang sudah kedaluwarsa otomatis diganti yang baru.) |
| Undangan tidak ada / sudah diterima / dibatalkan / milik organisasi lain | 404 `NOT_FOUND` |
| Dua kirim ulang bersamaan | 409 `CONFLICT` "Undangan ini baru saja berubah…" |
| Batas laju: 20/jam per pengundang, 50/jam per organisasi, 5/jam per email tujuan (buat + kirim ulang) | 429 + `Retry-After` |

### Alur penerima (`/undangan#token=…`)
1. Baca + buang fragment (aturan di atas). Bila browser sedang masuk (`GET /auth/me` 200), tampilkan
   "Kamu sedang masuk sebagai {nama}. Menerima undangan akan mengeluarkanmu dari akun itu." — menerima
   undangan mencabut sesi yang ada di browser itu (rotasi).
2. `POST /auth/invitation/inspect {token}` → tampilkan nama organisasi, `productName`, `invitedByName`,
   email (tidak bisa diubah), peran, `expiresAt`. `twoFactorRequired: true` → beri tahu "Peran {peran} wajib
   verifikasi dua langkah. Siapkan aplikasi autentikator; kamu langsung diminta mendaftarkannya."
3. Form nama + password (`PASSWORD_RULES_HINT`, aturan sama dengan setup: min 10, bukan password umum,
   tidak memuat nama/email/nama organisasi/nama produk) → `POST /auth/invitation/accept`.
4. 201 — periksa `status`:
   - `authenticated` (CS/Teknisi): sesi penuh + cookie perangkat dikenal → masuk ke aplikasi.
   - `two_factor_enrollment_required` (Admin/Supervisor): sesi TERBATAS 30 menit, hanya cookie sesi →
     langsung ke layar pendaftaran 2FA yang sudah ada (`POST /auth/2fa/enroll` dengan body `{}`, lalu
     `enroll/confirm`; lihat bagian 2FA). Pengguna tidak mendapat sesi penuh sebelum 2FA aktif. Bila sesi
     terbatas habis, pengguna masuk lagi dengan email + password → sesi terbatas baru.

Error penerima:

| Kasus | Respons |
|---|---|
| Token tidak dikenal / sudah diganti kirim ulang / undangan dibatalkan / penerbit tautannya (pembuat atau pengirim ulang terakhir) sudah dinonaktifkan atau perannya tidak lagi boleh mengundang peran itu | 410 `TOKEN_INVALID` "Tautan undangan ini tidak berlaku. Buka tautan dari email undangan terbaru…" (kirim ulang oleh Owner/Admin yang berhak membuat tautan baru yang berlaku) |
| Kedaluwarsa (72 jam) | 410 `TOKEN_INVALID` "Undangan ini sudah kedaluwarsa. Minta Owner atau Admin … mengirim ulang…" |
| Sudah dipakai / email sudah punya akun | 410 `TOKEN_INVALID` "…Masuk dengan email dan password-mu." → tombol ke halaman masuk |
| Nama kosong/terlalu pendek/memuat baris baru | 400 field `name` |
| Password melanggar kebijakan | 400 field `password` (pesan dari server; token tetap berlaku, boleh dicoba lagi) |
| `role`/`email` dikirim di body | diabaikan — peran & email selalu dari undangan |
| Token tidak berlaku 30×/15 menit dari satu jaringan | 429 |

## Atur ulang password

Semua publik. Rute: `API_ROUTES.passwordReset`. Tautan berlaku **30 menit**, sekali pakai; meminta tautan
baru membatalkan yang lama; tautan batal bila email akun berubah.

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/auth/password-reset` | – | `{ available }` — `false` bila email pengirim instalasi belum diatur |
| POST `/auth/password-reset/request` | `{ email }` | **202** `{ status: "accepted", validMinutes: 30 }` |
| POST `/auth/password-reset/inspect` | `{ token }` | 200 `{ email, expiresAt, twoFactorRequired, methods }` |
| POST `/auth/password-reset/complete` | `{ token, password, code? }` | 200 `{ status: "password_reset" }` (tanpa sesi baru) |

### Alur
1. Halaman masuk: tautan "Lupa password?" → `/lupa-password`. Panggil `GET /auth/password-reset`:
   - `available: false` → JANGAN tampilkan form. Tampilkan: "Atur ulang password lewat email belum tersedia
     karena email pengirim belum diatur. Minta Owner atau Admin di tempatmu untuk membantu." (Ini keadaan
     instalasi, sama untuk semua orang — tidak membuka apakah suatu akun ada.)
   - `available: true` → form email.
2. `POST …/request` → 202 SELALU sama untuk email terdaftar, tidak terdaftar, maupun akun nonaktif (waktu
   jawabannya juga sama: pencarian akun dikerjakan setelah menjawab). Tampilkan: "Kalau {email} terdaftar,
   tautan atur ulang password sudah dikirim. Periksa kotak masuk dan folder spam. Tautan berlaku 30 menit.
   Kalau ada beberapa email, pakai yang terbaru."
   Jangan menulis "email terkirim".
3. Tautan email → `/atur-ulang-password#token=…` → baca + buang fragment → `POST …/inspect`.
4. Form password baru (`PASSWORD_RULES_HINT`); bila `twoFactorRequired`, juga isian kode
   (`TWO_FACTOR_CODE_HINT`; `methods` memuat `backup_code` bila masih ada kode cadangan).
5. `POST …/complete` → 200: tampilkan "Password sudah diganti. Semua perangkat sudah dikeluarkan." + tombol
   masuk. Buang data sesi di memori web (sesi akun itu di browser ini sudah dicabut; permintaan berikutnya
   dengan cookie lama → 401 seperti biasa).

Yang terjadi di server saat selesai: semua sesi akun dicabut, tantangan 2FA dibuang, **cookie perangkat
dikenal yang lama tidak diakui lagi**, kunci login akibat tebakan password dilepas (kunci 50-gagal-dari-banyak-
jaringan + kunci asal dari jaringan yang menyelesaikan reset; kunci langkah kedua 2FA TIDAK dilepas), email
dianggap terverifikasi, email "Password sudah diganti" (waktu, IP, perangkat) dikirim. Login berikutnya
tetap butuh kode 2FA bila aktif.

| Kasus | Respons |
|---|---|
| Email pengirim belum diatur (`request`) | 503 `SERVICE_UNAVAILABLE` (pesan sama untuk email apa pun) |
| Email tidak valid | 400 field `email` |
| > 3 permintaan/jam untuk email yang sama **dari jaringan yang sama** (IP, atau /64 IPv6; terdaftar atau tidak, sama), > 10/15 menit per jaringan | 429 + `Retry-After` — pesan "…untuk email ini dari jaringanmu." Permintaan dari jaringan lain untuk email yang sama tidak terkena. |
| > 5 permintaan / 30 menit untuk email yang sama dari mana pun | **tetap 202 yang sama** (tidak terlihat): tidak ada tautan baru yang dibuat/dikirim, tautan terakhir tetap berlaku. Mencegah kotak masuk dibanjiri tanpa membuat pemilik akun terkunci. |
| Token tidak dikenal / dibatalkan / email akun berubah / akun nonaktif | 410 `TOKEN_INVALID` "Tautan atur ulang password ini tidak berlaku. Minta tautan baru…" |
| Kedaluwarsa | 410 `TOKEN_INVALID` "…sudah kedaluwarsa (berlaku 30 menit)…" |
| Sudah dipakai | 410 `TOKEN_INVALID` "Tautan ini sudah dipakai…" |
| Password melanggar kebijakan | 400 field `password` — diperiksa SEBELUM kode, jadi kode tidak terpakai |
| Akun ber-2FA tanpa `code` | 400 field `code` |
| Kode salah | 400 field `code` "…Sisa N percobaan." |
| Kode salah ke-3 pada tautan yang sama | 410 `TOKEN_INVALID` "Kode salah 3 kali. Tautan ini tidak berlaku lagi — minta tautan…" |
| 5 kode salah per akun / 15 menit (gabungan dengan langkah kedua saat masuk dan konfirmasi ulang) | 429 + `Retry-After`; langkah kedua akun dikunci 15 menit (login juga 429), email kunci (sumber "atur ulang password") |

## Verifikasi email

| Metode & path | Akses | Request | Respons 2xx |
|---|---|---|---|
| GET `/auth/email/verification` | sesi penuh | – | `{ email, verified, verifiedAt, canSend }` |
| POST `/auth/email/verification` | sesi penuh + CSRF | `{}` | **202** `{ status: "queued", expiresAt }` |
| POST `/auth/email/verify` | publik | `{ token }` | 200 `{ status: "verified", email }` |

- Lingkup sekarang: verifikasi email akun SENDIRI. Siapa yang belum terverifikasi: Owner hasil wizard
  setup (selalu), dan akun dari undangan yang tautannya disalin manual. Akun dari undangan yang terkirim
  lewat email, dan akun yang pernah menyelesaikan atur ulang password, otomatis terverifikasi.
- Status ini **tidak membatasi** apa pun (tidak ada fitur yang diblokir) — hanya petunjuk. Saran tampilan:
  di Pengaturan → Akun/Keamanan, "Email belum diverifikasi" + tombol "Kirim email verifikasi" (sembunyikan
  bila `canSend: false`, ganti dengan "Atur email pengirim dulu" untuk Owner).
- Tautan berlaku 24 jam, sekali pakai; meminta lagi membatalkan yang lama. Halaman `/verifikasi-email`:
  baca + buang fragment → `POST /auth/email/verify` → "Email {email} sudah terverifikasi." (tidak perlu
  sedang masuk).
- Ubah email di profil belum ada; tokennya sudah memakai kolom alamat tujuan sehingga nanti tinggal dipakai.

| Kasus | Respons |
|---|---|
| Sudah terverifikasi (`POST …/verification`) | 409 `CONFLICT` |
| Email pengirim belum diatur | 503 `SERVICE_UNAVAILABLE` |
| > 3 kali per jam per pengguna | 429 + `Retry-After` |
| Sesi terbatas (wajib 2FA) | 403 `TWO_FACTOR_ENROLLMENT_REQUIRED` |
| Token tidak dikenal/dibatalkan, kedaluwarsa, sudah dipakai, email akun sudah berubah | 410 `TOKEN_INVALID` (pesan per kasus) |

## Pratinjau template email (Pengaturan → Email pengirim; khusus Owner, sama dengan modul itu)

- GET `/settings/email/templates/:template/preview` (`apiPath(API_ROUTES.settings.emailTemplatePreview,
  { template })`), `template` ∈ `EMAIL_TEMPLATE_IDS` (label `EMAIL_TEMPLATE_LABELS`): `invitation`,
  `password_reset`, `email_verification`, `password_changed`, `two_factor_enabled`,
  `two_factor_enabled_admin`, `account_locked`. Template lain → 400.
- 200 `emailTemplatePreviewResponseSchema` `{ template, subject, text, html }`: template yang sama dengan
  email sungguhan, branding organisasi (nama produk, logo PNG/JPEG, warna utama bila kontrasnya cukup, nama
  organisasi), data contoh dan tautan contoh `…#token=CONTOH-TAUTAN-PRATINJAU` (bukan token sungguhan).
- `html` adalah dokumen lengkap dengan `style=` inline dan logo `data:` URI. Tampilkan di
  `<iframe sandbox="" srcdoc={html} title="Pratinjau email">` (tanpa `allow-scripts`/`allow-same-origin`).
  Catatan CSP: iframe `srcdoc` mewarisi CSP halaman induk; bila nanti `style-src` tanpa `'unsafe-inline'`
  diterapkan di web, pratinjau akan tampil tanpa gaya — pilihan: render `text` sebagai cadangan, atau
  keputusan CSP khusus untuk iframe ini. Jangan pernah memakai `dangerouslySetInnerHTML` untuk `html`.

## Email sistem bermerek (semua email)

Undangan, atur ulang password, verifikasi, password diganti, 2FA aktif/nonaktif, kode cadangan, kunci
percobaan masuk, dan email tes memakai satu kerangka: logo (PNG/JPEG inline; WebP diganti nama produk),
nama produk, nama organisasi, warna tombol dari warna utama organisasi bila kontras ≥ 4,5:1, versi HTML +
teks polos, sapaan "kamu", semua nilai pengguna di-escape. Email keamanan memuat waktu, alamat IP, dan
perkiraan perangkat ("Chrome di Windows") dari audit log.

## Perubahan setelah review keamanan butir 4 (path & bentuk tidak berubah)

- **Undangan (R2):** tautan undangan kini 410 `TOKEN_INVALID` (pesan umum "tidak berlaku") bila yang
  menerbitkan tautan itu — pembuat, atau pengirim ulang terakhir — sudah dinonaktifkan atau perannya tidak
  lagi boleh mengundang peran tersebut. Email undangan semacam itu juga tidak dikirim (status `skipped`).
  Undangan tetap tampil di daftar; Owner/Admin yang berhak bisa "Kirim ulang" untuk tautan baru yang berlaku.
- **Undangan (R1):** membuat undangan untuk email yang masih punya undangan terbuka yang tidak boleh dikelola
  pemanggil (Admin + undangan Admin, berlaku atau kedaluwarsa) → 403, bukan menggantikannya.
- **Minta atur ulang password (R4):** 429 per email hanya untuk peminta dari jaringan yang sama (3/jam). Plafon
  5 email / 30 menit per email berlaku diam-diam (jawaban tetap 202).
- **Selesai atur ulang password (R5):** bila Redis bermasalah sesudah password berganti, jawabannya tetap 200
  dan email "Password sudah diganti" tetap diantrekan (sebelumnya bisa 503).

## Perubahan pada bagian yang sudah ada (Fase 1 butir 4)

- **Kode error baru `TOKEN_INVALID` (410)** — tautan email tidak berlaku. Ditangani seperti error isian
  halaman, bukan sesi habis.
- **2FA aktif untuk peran wajib → email juga ke semua Owner/Admin aktif lain** (nama, email, peran, waktu,
  IP, perangkat). Email "2FA aktif" ke pemilik akun juga kini memuat IP + perangkat.
- **Rahasia pendaftaran 2FA tertunda** (langkah 2 "Wajib daftar"): dipakai ulang hanya bila permintaan
  datang dari peramban (user agent) + jaringan (IP, atau /64 IPv6) yang sama dengan saat sesi dibuat, dan
  paling lama 30 menit sejak rahasia itu pertama dibuat. Selain itu rahasia baru dibuat (QR lama batal —
  konfirmasi dengan kode dari QR lama → 400). Bentuk respons tidak berubah.
- **Cookie perangkat dikenal** yang terbit sebelum password diatur ulang tidak diakui lagi.
- **Login**: tidak ada perubahan bentuk. Akun dari undangan masuk seperti biasa.
- Worker kini WAJIB `APP_URL` (sumber tautan email) — sudah ada di `.env.example` dan env E2E.

## Catatan untuk tes E2E

- Mailpit menangkap semua email. Tautan ada di teks/HTML email; ambil token dari `#token=…`.
- Tanpa email pengirim, tautan undangan ada di respons `POST /invitations` (`link`) dan di dialog salin.
- Tes "lupa password" harus mengatur email pengirim dulu (`available: false` tanpa itu).
- Akun Admin/Supervisor dari undangan langsung ke layar pendaftaran 2FA; pakai `generateTotp(secret)`.
