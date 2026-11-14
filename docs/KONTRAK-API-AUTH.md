# Kontrak API — Setup, Login, 2FA, Undangan, Atur ulang password, Verifikasi email, Branding, Email pengirim, Peran & izin, Manajemen pengguna, Sesi aktif, Audit log (Fase 1)

Sumber kebenaran tipe: skema Zod di `packages/shared/src/` (`auth.ts`, `two-factor.ts`, `invitations.ts`,
`password-reset.ts`, `email-verification.ts`, `email-templates.ts`, `links.ts`, `permissions.ts`, `team.ts`,
`audit.ts`) dan konstanta path di
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
  - 429: per IP (20 **gagal**/15 menit, "…dari jaringanmu…") atau akun dikunci 15 menit setelah
    5 gagal. Hanya percobaan gagal (termasuk yang ditolak karena terkunci) yang menghabiskan jatah
    per IP — login berhasil tidak pernah menyentuhnya, jadi banyak anggota tim yang masuk serentak
    dari satu IP kantor (NAT) tidak kena 429. Pemeriksaan password yang berjalan bersamaan dari satu
    IP dibatasi 30 (pesan 429 yang sama); dalam pemakaian wajar tidak pernah tercapai.
  - 503: Redis mati / server sibuk. 400: validasi.
- POST `/auth/logout` (sesi + CSRF) → `{status: 'logged_out'}`, cookie dihapus.
- POST `/auth/logout` dan GET `/auth/me` juga berlaku untuk sesi terbatas.
- GET `/auth/me` (sesi) → `meResponseSchema` (`authenticated` | `two_factor_enrollment_required`) atau 401.
- Semua respons yang membawa sesi (login `authenticated`/`two_factor_enrollment_required`, `/auth/me`,
  `/auth/2fa/verify`, `/auth/2fa/enroll/confirm`, `/setup/complete`, `/auth/invitation/accept`) memuat
  `permissions` — lihat bagian **Peran & izin (RBAC)**.

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

## Pengaturan → Email pengirim (izin `settings.email.manage` = Owner/Admin; tulis butuh CSRF)
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
| GET `/invitations` | `team.invite` (Owner/Admin) | – | `invitationListResponseSchema` `{ invitations, invitableRoles, emailDelivery }` |
| POST `/invitations` | `team.invite` + CSRF | `createInvitationRequestSchema` `{ email, role }` | **201** `invitationIssuedResponseSchema` `{ invitation, link }` |
| POST `/invitations/:invitationId/resend` | `team.invite` + CSRF | – | 200 `invitationIssuedResponseSchema` |
| DELETE `/invitations/:invitationId` | `team.invite` + CSRF | – | 200 `{ status: "revoked" }` |
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
| Supervisor/CS/Teknisi | 403 `FORBIDDEN` pesan bawaan (izin `team.invite`, dicatat `auth.access.denied`) |
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
  bila `canSend: false`, ganti dengan "Atur email pengirim dulu" untuk pengguna yang memegang izin
  `settings.email.manage`).
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

## Pratinjau template email (Pengaturan → Email pengirim; izin `settings.email.manage`, sama dengan modul itu)

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

## Peran & izin (RBAC, Fase 1 butir 5)

Sumber tunggal: `packages/shared/src/permissions.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`,
`hasPermission`, `permissionScope`, `PERMISSION_LABELS`, `PERMISSION_SCOPE_LABELS`). Server menegakkan
setiap permintaan; web hanya menyembunyikan menu/tombol.

### Field baru `permissions` di respons sesi (tambahan, bentuk lain tidak berubah)

- `permissions: Permission[]` — izin pengguna untuk sesi INI, berurutan seperti `PERMISSIONS`.
  Sesi terbatas `two_factor_enrollment_required` selalu `[]`.
- Server selalu mengirimnya. Di skema Zod field ini **opsional** hanya supaya klien lama tetap
  terkompilasi; perlakukan "tidak ada" sebagai `[]`. Saat menyimpan sesi di memori/cache, **ikut simpan
  `permissions`** (jangan disaring keluar).
- Cara pakai di web: `session.permissions.includes('team.invite')` → tampilkan menu Undang anggota.
  Untuk izin bercakupan, cakupan: `permissionScope(session.user.role, 'inbox.view')` (`all` | `assigned` |
  `own`), label `PERMISSION_SCOPE_LABELS`. Jangan menulis ulang matriks di web.
- Izin bisa berubah saat peran berubah; setelah 403 `FORBIDDEN` yang tidak diduga, muat ulang `/auth/me`.

### Matriks (PRD §4)

| Izin | Owner | Admin | Supervisor | CS | Teknisi | Dipakai |
|---|:-:|:-:|:-:|:-:|:-:|---|
| `organization.manage` | ✅ | – | – | – | – | Fase 7/Pengaturan Organisasi |
| `backup.manage` | ✅ | – | – | – | – | Fase 7 |
| `channels.manage` | ✅ | ✅ | – | – | – | Fase 2 |
| `settings.email.manage` | ✅ | ✅ | – | – | – | **sekarang**: `/settings/email*` |
| `settings.workspace.manage` | ✅ | ✅ | – | – | – | Fase 5 (departemen, jam kerja, alokasi, tag, pesan otomatis, CSAT) |
| `sending.limits.manage` | ✅ | ✅ | – | – | – | Fase 4 (ambang persetujuan, batas harian, rem darurat, alarm biaya; wajib audit + beri tahu Owner) |
| `api_keys.manage` | ✅ | ✅ | – | – | – | Fase 3 |
| `integrations.manage` | ✅ | ✅ | – | – | – | Fase 3–4 |
| `team.invite` | ✅ | ✅ | – | – | – | **sekarang**: `/invitations*` |
| `team.manage` | ✅ | ✅ | – | – | – | Fase 1 butir 6 (manajemen pengguna) |
| `audit.view` | ✅ | ✅ | – | – | – | Fase 1 butir 6 |
| `broadcast.send` | ✅ | ✅ | ✅ | – | – | Fase 4 |
| `broadcast.approve` | ✅ | ✅ | – | – | – | Fase 4 |
| `sending.resume` | ✅ | ✅ | – | – | – | Fase 4 (rem darurat) |
| `templates.manage` | ✅ | ✅ | ✅ | – | – | Fase 4 |
| `quick_replies.manage` | ✅ | ✅ | ✅ | – | – | Fase 2 |
| `inbox.view` | ✅ | ✅ | ✅ | ✅ | di-assign/tiketnya | Fase 2 |
| `inbox.reply` | ✅ | ✅ | ✅ | ✅ | di-assign/tiketnya | Fase 2 — hanya percakapan yang SUDAH ADA |
| `inbox.initiate` | ✅ | ✅ | ✅ | – | – | Fase 2 — mulai percakapan / kirim template ke nomor baru (batas harian per pengguna) |
| `inbox.assign` | ✅ | ✅ | ✅ | ✅ | – | Fase 2 |
| `contacts.view` | ✅ | ✅ | ✅ | ✅ | di-assign/tiketnya | Fase 2/5 |
| `contacts.manage` | ✅ | ✅ | ✅ | ✅ | – | Fase 5 |
| `contacts.export` | ✅ | ✅ | ✅ | – | – | Fase 5 |
| `contacts.delete` | ✅ | ✅ | – | – | – | Fase 5 |
| `tickets.manage` | ✅ | ✅ | ✅ | ✅ | miliknya | Fase 5 |
| `tickets.configure` | ✅ | ✅ | ✅ | – | – | Fase 5 |
| `reports.view` | ✅ | ✅ | ✅ | milik sendiri | milik sendiri | Fase 5 |

Rute yang cukup dengan sesi (data milik sendiri, tanpa izin): `/auth/me`, `/auth/logout`, `/auth/2fa*`,
`/auth/email/verification`, `/auth/sessions*` (butir 6).

### Perilaku

- Peran tanpa izin rute → **403 `FORBIDDEN`** dengan pesan bawaan "Kamu tidak punya izin untuk melakukan
  tindakan ini." (403 dari aturan rinci modul, mis. Admin mengelola undangan Admin, memakai pesan khusus).
  Diperiksa SETELAH sesi (401) dan CSRF/Origin (403 `CSRF_INVALID`/`FORBIDDEN`), dan setelah sesi
  terbatas 2FA (403 `TWO_FACTOR_ENROLLMENT_REQUIRED`).
- Data di luar cakupan (mis. Teknisi membuka percakapan yang tidak di-assign kepadanya) → **404
  `NOT_FOUND`**, bukan 403; daftar hanya memuat data dalam cakupan.
- Metode salah (405): rute pelengkap di alamat yang semua rutenya butuh izin yang sama kini juga butuh
  izin itu — peran tanpa izin mendapat 403, bukan 405 + `Allow` (mis. CS `DELETE /settings/email`).
- Setiap penolakan izin dicatat di audit log `auth.access.denied` (izin, metode, pola rute, peran, sesi,
  `fetchSite` = header `Sec-Fetch-Site` bila ada; tanpa body/query/parameter), paling banyak satu entri per
  pengguna × izin per menit. Penolakan **aturan turunan** di modul (mis. Admin mengundang/mengirim ulang/
  membatalkan undangan Admin) juga dicatat dengan aksi yang sama (`targetType: "rule"`, `targetId:
  "team.invite.role"`), satu entri per pengguna × aturan per menit; jawabannya tidak berubah (403 dengan
  pesan khusus).
- Rute aplikasi yang menerima `OPTIONS` membuat API menolak start (preflight hanya milik CORS).

### Perubahan perilaku pada bagian yang sudah ada

- **Pengaturan → Email pengirim + pratinjau template**: kini **Owner dan Admin** (sebelumnya khusus Owner;
  `PENGATURAN-UI.md` menyebut Owner/Admin). Supervisor/CS/Teknisi tetap 403.
- Penerima email "2FA aktif" peran wajib = pemegang `team.manage` (tetap Owner/Admin).

### Perubahan setelah review keamanan RBAC (bentuk respons tidak berubah)

- **Izin baru** di `PERMISSIONS` (ikut muncul di `permissions` sesi Owner/Admin/Supervisor sesuai matriks):
  `sending.limits.manage` (setelah `settings.workspace.manage`) dan `inbox.initiate` (setelah
  `inbox.reply`). Label: "Atur batas kirim, ambang persetujuan, dan alarm biaya", "Mulai percakapan ke
  nomor baru"; label `inbox.reply` kini "Balas percakapan yang sudah ada".
- **PUT `/settings/email` oleh selain Owner** (Admin) yang mengubah server, port, keamanan, username,
  password, alamat pengirim, atau balas-ke → setiap Owner aktif mendapat email "Email pengirim diubah oleh
  …" yang **dikirim lewat pengaturan SEBELUM perubahan** (salinannya disimpan di
  `email_settings_change_notices`; jatuh ke pengaturan baru hanya bila yang lama gagal permanen/percobaan
  terakhir). Bila pemberitahuan tidak bisa diantrekan, perubahan **batal** dan jawabannya **503
  `SERVICE_UNAVAILABLE`** "Perubahan email pengirim belum disimpan karena pemberitahuan ke Owner tidak bisa
  dikirim sekarang…" — tampilkan pesannya, isian form tetap. Perubahan nama pengirim saja, atau perubahan
  oleh Owner, tidak memicu pemberitahuan. Audit `settings.email.updated` kini memuat `previousHost` dan
  `ownersNotified`. Saran teks di form untuk Admin: "Owner akan diberi tahu lewat email bila server atau
  alamat pengirim diubah." 

## Manajemen pengguna, sesi aktif & audit log (Fase 1 butir 6)

Skema: `packages/shared/src/team.ts` (pengguna, sesi, konfirmasi identitas, `MANAGE_PERMISSIONS`,
`TWO_FACTOR_ENROLLMENT_WINDOW_HOURS`) dan `packages/shared/src/audit.ts` (aksi + label, saringan, entri,
ringkasan kejadian keamanan). Path: `API_ROUTES.team`, `API_ROUTES.sessions`, `API_ROUTES.audit`; path
ber-parameter disusun dengan `apiPath(API_ROUTES.team.role, { userId })`.

### Matriks kelola (`MANAGE_PERMISSIONS`, `canManageRole`, `assignableRoles`)

Izin rute: `team.manage` (Owner, Admin). Di atasnya, per peran SASARAN:

| Pelaku ↓ / sasaran → | Owner lain | Admin | Supervisor | CS | Teknisi | Diri sendiri |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Owner | ✅ | ✅ | ✅ | ✅ | ✅ | – (halaman Keamanan akun) |
| Admin | – | – (termasuk Admin lain) | ✅ | ✅ | ✅ | – |
| Supervisor, CS, Teknisi | – | – | – | – | – | – |

"Kelola" = ubah peran, nonaktifkan/aktifkan, atur ulang 2FA, buka lagi pendaftaran 2FA, buka kunci, lihat &
keluarkan sesi. Melihat daftar/detail boleh untuk semua pengguna organisasi (Admin melihat Owner dengan
`canManage: false`). Peran yang boleh **diberikan** lewat ubah peran = `assignableRoles(pelaku)` =
`INVITE_PERMISSIONS` (Owner → Admin/Supervisor/CS/Teknisi; Admin → Supervisor/CS/Teknisi). **Tidak ada yang
bisa menjadikan orang Owner** lewat ubah peran (Zod menolak `role: "owner"` → 400); pemindahan kepemilikan
belum ada. Organisasi selalu punya ≥ 1 Owner aktif.

### Konfirmasi ulang identitas pelaku (`identityConfirmationSchema`)

Body `{ password, code }` — password **pelaku** + kode autentikator / kode cadangan **pelaku** (`code` wajib
bila 2FA pelaku aktif; Owner/Admin selalu). Wajib untuk: ubah peran, nonaktifkan, aktifkan, atur ulang 2FA,
buka lagi pendaftaran 2FA, buka kunci, keluarkan SEMUA sesi (pengguna lain maupun "semua sesi lain" milik
sendiri). Tidak perlu untuk keluarkan SATU sesi.

| Kasus | Respons |
|---|---|
| `password` kosong/tidak ada | 400 `VALIDATION_ERROR` field `password` |
| 2FA pelaku aktif tapi `code` tidak ada | 400 field `code` "Masukkan kode dari aplikasi autentikator…" |
| Password salah | 400 field `password` "Password salah…" |
| Kode salah | 400 field `code` (ember sama dengan langkah kedua masuk: kode salah ke-5 mengunci langkah kedua akun pelaku 15 menit + email) |
| 5 konfirmasi gagal / 15 menit, atau langkah kedua pelaku terkunci | 429 + `Retry-After` |

Web: dialog konfirmasi dengan isian password + kode (seperti "Buat ulang kode cadangan"); isian tidak disimpan
di cache/storage; kosongkan setelah selesai.

### Endpoint pengguna (semua `team.manage`; tulis butuh CSRF)

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/users` | – | `teamUserListResponseSchema` `{ users, manageableRoles }` |
| GET `/users/:userId` | – | `teamUserResponseSchema` `{ user }` |
| PUT `/users/:userId/role` | `changeUserRoleRequestSchema` `{ role, password, code }` | `teamUserActionResponseSchema` `{ user, revokedSessions, revokedInvitations }` |
| POST `/users/:userId/disable` | `{ password, code }` | `teamUserActionResponseSchema` |
| POST `/users/:userId/enable` | `{ password, code }` | `teamUserActionResponseSchema` |
| POST `/users/:userId/2fa/reset` | `{ password, code }` | `teamUserActionResponseSchema` |
| POST `/users/:userId/2fa/enrollment-window` | `{ password, code }` | `teamUserActionResponseSchema` |
| POST `/users/:userId/unlock` | `{ password, code }` | `teamUserActionResponseSchema` |
| GET `/users/:userId/sessions` | – | `activeSessionListResponseSchema` `{ sessions }` |
| DELETE `/users/:userId/sessions/:sessionId` | – | `{ status: "revoked" }` |
| POST `/users/:userId/sessions/revoke-all` | `{ password, code }` | `{ revokedSessions }` |

`user` (`teamUserSchema`): `id, name, email, role, status ("active" | "locked" | "disabled",
`TEAM_USER_STATUS_LABELS`), disabledAt, lockedUntil, emailVerified, lastLoginAt, createdAt, twoFactor
{ enabled, required, enabledAt, enrollmentDueAt, enrollmentExpired }, activeSessions, isSelf, canManage,
assignableRoles`. Daftar: aktif dulu, lalu urut peran (Owner → Teknisi), lalu nama; maks. 1000. Tidak pernah
memuat hash/rahasia. `emailVerified: false` → tampilkan "Email belum diverifikasi" (mis. undangan yang
tautannya disalin manual; atur ulang password tetap dikirim ke alamat itu). `status: "locked"` = aktif tetapi
masuk/langkah kedua sedang dikunci sementara sampai `lockedUntil` → tombol "Buka kunci".

Efek tiap aksi (semua tercatat di audit):
- **Ubah peran** (`user.role_changed` {from, to, revokedSessions, revokedInvitations,
  twoFactorEnrollmentRequired}): SEMUA sesi + tantangan 2FA sasaran dicabut (ia harus masuk lagi; web-nya
  mendapat 401 lalu halaman masuk). Naik ke peran wajib 2FA tanpa 2FA → login berikutnya =
  `two_factor_enrollment_required` dengan batas 72 jam. Undangan terbuka terbitan sasaran yang tidak lagi boleh
  ia terbitkan dibatalkan (`user.invitation.revoked` reason `issuer_role_changed`), mis. Owner → Admin:
  undangan Admin batal, undangan Supervisor/CS/Teknisi tetap.
- **Nonaktifkan** (`user.disabled`): sesi + tantangan dicabut, tautan atur ulang password/verifikasi email
  yang masih hidup batal, SEMUA undangan terbuka terbitannya batal (reason `issuer_disabled`). Masuk →
  401 `INVALID_CREDENTIALS` (sama dengan password salah). Pengguna tidak pernah dihapus.
- **Aktifkan** (`user.enabled`): bisa masuk lagi; peran wajib tanpa 2FA mendapat batas pendaftaran 72 jam baru.
- **Atur ulang 2FA** (`user.2fa.reset`): autentikator + kode cadangan dibuang, sesi + tantangan dicabut, kunci
  langkah kedua lama dilepas. Peran wajib → login berikutnya wajib mendaftar ulang (batas 72 jam). Email ke
  sasaran ("…diatur ulang oleh {nama} ({peran})") dan ke **Owner lain** (bukan pelaku, bukan sasaran).
- **Buka lagi pendaftaran 2FA** (`user.2fa.enrollment_reopened`): hanya peran wajib yang belum mendaftar;
  batas baru = 72 jam dari sekarang.
- **Buka kunci** (`user.unlocked` {cleared}): melepas kunci masuk (per jaringan, per akun, per perangkat
  dikenal) dan kunci langkah kedua 2FA, beserta hitungannya. Idempoten.
- **Keluarkan sesi** (`auth.session.revoked` {by: "administrator"}) / **semua sesi**
  (`auth.sessions.revoked_all`).

Error:

| Kasus | Respons |
|---|---|
| Supervisor/CS/Teknisi | 403 `FORBIDDEN` pesan bawaan (izin rute, `auth.access.denied`) |
| Pengguna tidak ada / organisasi lain | 404 `NOT_FOUND` "Pengguna tidak ditemukan." |
| Sasaran = diri sendiri | 403 `FORBIDDEN` "Akunmu sendiri tidak bisa dikelola dari halaman Tim…" (audit aturan `team.manage.self`) |
| Admin → Owner/Admin | 403 `FORBIDDEN` "Admin hanya bisa mengelola Supervisor, CS, dan Teknisi…" (aturan `team.manage.role`) |
| Admin memberi peran Admin | 403 `FORBIDDEN` "Admin hanya bisa memberi peran Supervisor, CS, atau Teknisi." (aturan `team.manage.assign_role`) |
| `role` bukan Admin/Supervisor/CS/Teknisi (termasuk `owner`) | 400 field `role` |
| Peran sama / sudah nonaktif / sudah aktif / 2FA belum aktif (atur ulang) / peran tidak wajib atau 2FA sudah aktif (buka lagi) | 409 `CONFLICT` dengan pesan khusus |
| Perubahan akan menghapus Owner aktif terakhir (mis. dua Owner saling menurunkan bersamaan) | 409 `CONFLICT` "Organisasi harus selalu punya minimal satu Owner aktif…" |
| Data berubah oleh permintaan lain | 409 `CONFLICT` "Data pengguna ini baru saja berubah…" |
| Sesi tidak ada / bukan milik pengguna itu / sudah berakhir | 404 `NOT_FOUND` "Sesi tidak ditemukan atau sudah berakhir." |
| Konfirmasi identitas | lihat tabel di atas (400/429) |

Semua 403 aturan di atas dicatat `auth.access.denied` (`targetType: "rule"`), paling banyak satu entri per
pengguna × aturan per menit.

### Sesi aktif milik sendiri (cukup sesi PENUH; sesi terbatas 2FA → 403 `TWO_FACTOR_ENROLLMENT_REQUIRED`)

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/auth/sessions` | – | `activeSessionListResponseSchema` `{ sessions }` |
| DELETE `/auth/sessions/:sessionId` | body opsional `revokeOwnSessionRequestSchema` `{ password, code? }` — WAJIB bila `confirmationRequired: true` | `{ status: "revoked" }` |
| POST `/auth/sessions/revoke-others` | `{ password, code? }` (`code` wajib bila 2FA aktif) | `{ revokedSessions }` |

`session` (`activeSessionSchema`): `id, device` ("Chrome di Windows"), `ipAddress` (tersamar: IPv4
`203.0.113.*`, IPv6 3 grup pertama `2001:db8:85a3:*`, `null` bila tidak tercatat), `createdAt` (waktu masuk),
`lastSeenAt` (diperbarui paling sering 1×/menit), `current` (sesi yang sedang dipakai — tampilkan "Sesi ini",
tanpa tombol keluarkan), `limited` (sesi pendaftaran 2FA 30 menit). Terakhir dipakai dulu; hanya sesi yang
masih berlaku. Mengeluarkan sesi ini sendiri → 409 "…pakai tombol Keluar." Sesi milik orang lain → 404.
"Keluarkan semua sesi lain" juga membuang login 2FA yang sedang setengah jalan; sesi ini tetap hidup.

### Batas waktu pendaftaran 2FA peran wajib (R3, `TWO_FACTOR_ENROLLMENT_WINDOW_HOURS` = 72)

- Akun Owner/Admin/Supervisor yang belum mendaftar 2FA punya batas `twoFactor.enrollmentDueAt` = 72 jam sejak:
  menerima undangan, perannya dinaikkan, 2FA-nya diatur ulang, diaktifkan kembali, atau pendaftarannya dibuka
  lagi. Mendaftar 2FA mengosongkannya.
- Lewat batas: `POST /auth/login` dengan password BENAR → **403 `TWO_FACTOR_ENROLLMENT_EXPIRED`** "Batas waktu
  mendaftarkan verifikasi dua langkah untuk akunmu sudah lewat. Minta Owner atau Admin di tempatmu membuka lagi
  pendaftarannya, lalu masuk kembali." — tanpa cookie. Password salah tetap `INVALID_CREDENTIALS`. Sesi
  pendaftaran yang terbit sebelum batas: `POST /auth/2fa/enroll` → 403 kode yang sama. Tercatat
  `auth.2fa.enrollment_expired` (maks. 1×/menit/pengguna). Web (halaman masuk): tampilkan pesannya apa adanya,
  tanpa tombol coba lagi otomatis.
- Pemulihan: Owner/Admin (sesuai matriks kelola) → "Buka lagi pendaftaran 2FA"
  (`POST /users/:userId/2fa/enrollment-window`). Daftar Tim menampilkan `enrollmentExpired: true`.
- **Owner hasil wizard setup tidak punya batas** (`enrollmentDueAt: null`): wizard memaksa pendaftaran di sesi
  yang sama, dan tidak ada orang lain yang bisa membukakannya. Batas seorang Owner (mis. setelah 2FA-nya diatur
  ulang Owner lain) hanya ditegakkan selama ada Owner aktif LAIN ber-2FA yang bisa membukanya lagi —
  instalasi tidak pernah terkunci dari dirinya sendiri.
- Atur ulang password akun peran wajib yang belum mendaftar 2FA tetap boleh (pemulihan sah), tetapi semua
  Owner/Admin lain mendapat email "{nama} mengatur ulang password tanpa verifikasi dua langkah"; audit
  `auth.password_reset.completed` memuat `twoFactorEnrollmentPending: true`.

### Audit log (`audit.view` = Owner, Admin)

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/audit-logs` | query `auditLogListQuerySchema` | `auditLogListResponseSchema` `{ entries, nextCursor }` |
| GET `/audit-logs/export` | query `auditLogFilterSchema` (tanpa `cursor`/`limit`) + **header `X-CSRF-Token` wajib walau GET** | **`text/csv; charset=utf-8`**, unduhan |
| GET `/audit-logs/security-summary` | – | `securitySummaryResponseSchema` |

Saringan (semua opsional): `actorUserId` (aksi oleh pengguna itu), `userId` (aksi OLEH atau TERHADAP pengguna
itu — dipakai di detail pengguna), `action` (salah satu `AUDIT_ACTION_NAMES`), `targetType`
(`AUDIT_TARGET_TYPES`), `targetId`, `from` ≤ waktu < `to` (ISO 8601 UTC). Halaman: `limit` 1–200 (bawaan 50),
`cursor` = `nextCursor` sebelumnya (`null` = habis). Terbaru dulu. Kursor/saringan tidak valid, `from` ≥ `to`,
`limit` > 200 → 400 `VALIDATION_ERROR`.

`entry` (`auditLogEntrySchema`): `id, createdAt, action` (label: `auditActionLabel(action)` /
`AUDIT_ACTION_LABELS`; aksi yang belum dikenal klien ditampilkan kodenya), `actor` `{ id, name, email, role }`
atau `null` (sistem / pelaku tidak dikenal, mis. login gagal) — **peran sekarang**, bukan saat kejadian,
`target` `{ type, id, name }` (`name` hanya untuk target `user`; label jenis `AUDIT_TARGET_TYPE_LABELS`),
`metadata` (datar: teks/angka/boolean/null; nilai bersarang dikirim sebagai teks JSON; rahasia sudah disaring
saat ditulis DAN saat dikirim), `ipAddress` (lengkap — log keamanan), `device` ("Chrome di Windows").

Ekspor CSV: RFC 4180 dengan koma, diawali BOM UTF-8 (Excel), header `Content-Disposition: attachment;
filename="audit-log-YYYYMMDD.csv"`, `x-export-rows`, `x-export-truncated` (`1` bila lebih dari 10.000 baris —
hanya 10.000 terbaru yang ikut; persempit rentang waktu). Kolom: Waktu (UTC), Waktu setempat, Aksi, Kode aksi,
Pelaku, Email pelaku, Peran pelaku, Jenis target, ID target, Nama target, Alamat IP, Perangkat, Rincian. Setiap
sel dikutip; teks yang diawali `= + - @`, tab, atau CR (juga setelah spasi/kutip) diberi awalan `'` (anti
formula injection). Maks. 10 ekspor/jam per pengguna → 429. Setiap ekspor dicatat `audit.exported`. Web:
unduh lewat `fetch` (credentials) → `Blob` → tautan unduhan, bukan membuka URL di tab baru (sama-origin, tanpa
token di URL).

Ringkasan kejadian keamanan (banner peringatan Owner/Admin): `{ since, events, counts, latestWarningAt }`,
rentang 7 hari (`SECURITY_SUMMARY_DAYS`), `events` terbaru dulu maks. 20. `event`: `id` (baris audit),
`kind` (`SECURITY_EVENT_KINDS`, label `SECURITY_EVENT_LABELS`), `severity` (`warning` → banner; `info` →
cukup di daftar), `occurredAt`, `actor` (`{ id, name, email, role }` pelaku, atau `null`; `actor.id` = ID
pengguna pelaku — web bisa menyembunyikan kejadian yang pelakunya pengguna yang sedang masuk), `subject`
`{ id, name, role }` (pengguna yang terkena), `details`
(mis. `email_sender_changed`: `previousHost`, `host`, `port`, `fromAddress`; `role_changed`: `from`, `to`;
`account_locked`: `scope`, `lockedUntil`). Jenis: `email_sender_changed` (server/alamat email pengirim diubah
oleh selain Owner — review RBAC S1), `two_factor_reset`, `two_factor_enrollment_reopened`,
`password_reset_without_two_factor`, `account_locked`, `role_changed`, `user_disabled`, serta
`channel_changed` dan `business_profile_changed` (lihat `KONTRAK-API-CHANNEL.md`). Saran web: tampilkan
banner bila `latestWarningAt` lebih baru dari "terakhir ditutup" (simpan waktu itu di `localStorage` per
pengguna — kenyamanan saja; server tidak menyimpan status "sudah dibaca"), tautan ke Audit log tersaring.

### Perubahan pada bagian yang sudah ada (bentuk respons tidak berubah)

- **Kode error baru** `TWO_FACTOR_ENROLLMENT_EXPIRED` (403) di `ERROR_CODES` — `POST /auth/login` dan
  `POST /auth/2fa/enroll` (lihat R3 di atas).
- Rute "cukup sesi" bertambah: `/auth/sessions*` (data milik sendiri).
- `POST /auth/invitation/accept` untuk Admin/Supervisor kini memulai batas pendaftaran 2FA 72 jam.
- Audit `auth.account.locked` untuk akun terdaftar kini memuat `lockRef` (kunci ember Redis berbentuk hash —
  bukan rahasia) supaya kunci bisa dibuka Owner/Admin.
- Email baru (worker): "Verifikasi dua langkah akun … diatur ulang" (ke sasaran), "Verifikasi dua langkah
  {nama} ({peran}) … diatur ulang" (ke Owner lain), "{nama} ({peran}) mengatur ulang password tanpa
  verifikasi dua langkah" (ke Owner/Admin).

### Catatan untuk tes E2E

- Konfirmasi identitas memakai kode TOTP pelaku; satu kode tidak bisa dipakai dua kali dalam 30 detik — pakai
  helper TOTP yang sama dengan tes 2FA (`e2e/tests/two-factor.ts`).
- Setelah ubah peran/nonaktifkan/atur ulang 2FA, browser sasaran mendapat 401 pada permintaan berikutnya.

### Perubahan setelah review keamanan butir 6 (path & bentuk tidak berubah; ada perilaku baru)

Sumber: `docs/security-reviews/2026-11-14-fase1-tim-audit.md` (R1–R4, Info 2, Info 6).

- **Ekspor audit wajib CSRF (R3).** `GET /audit-logs/export` kini ditolak **403 `CSRF_INVALID`** bila header
  `X-CSRF-Token` tidak ada/salah, bila `Sec-Fetch-Site` ada dan bukan `same-origin`, atau bila `Origin` ada dan
  bukan origin aplikasi (juga HEAD). **Web: unduh lewat `fetch(url, { credentials: 'include', headers:
  { 'X-CSRF-Token': csrfToken } })` → `Blob` → tautan unduhan**; jangan membuka URL ekspor di tab/`<a href>`.
  Pola server: rute GET ber-efek-samping memakai `config.requireCsrf: true` (wajib untuk setiap GET yang
  menulis data/memakai jatah berikutnya, mis. ekspor kontak).
- **Mengeluarkan sesi sendiri yang lebih baru (R4).** Daftar `GET /auth/sessions` kini memuat
  `confirmationRequired` per sesi (tambahan): `true` = sesi itu dibuat pada/sesudah sesi yang sedang dipakai.
  `DELETE /auth/sessions/:sessionId` untuk sesi seperti itu tanpa body → **400 `VALIDATION_ERROR` field
  `password`** "Sesi itu lebih baru dari sesi yang sedang kamu pakai. Masukkan password-mu (dan kode verifikasi
  dua langkah bila aktif) untuk mengeluarkannya." Dengan body `{ password, code? }` (`code` wajib bila 2FA
  aktif) → 200; salah → 400 field `password`/`code`, 429 seperti konfirmasi lain. Sesi yang lebih lama
  (`confirmationRequired: false`) tetap satu klik tanpa body. **Web: dialog konfirmasi (password + kode) hanya
  untuk sesi `confirmationRequired: true`.** Daftar sesi pengguna lain (Owner/Admin): selalu `false`.
- **Pemeriksaan ulang di transaksi (R1/R2).** Semua aksi kelola (termasuk buka kunci dan keluarkan satu sesi
  pengguna lain) kini berurutan per organisasi dan memeriksa ulang keadaan TERBARU: bila peran/status/2FA
  sasaran berubah sejak dibaca (permintaan lain menang tipis) → **409 `CONFLICT`** "Data pengguna ini baru saja
  berubah. Muat ulang halaman Tim, lalu coba lagi."; bila peran pelaku sekarang tidak lagi boleh mengelola
  sasaran / memberi peran itu → **403 `FORBIDDEN`** dengan pesan aturan. Dua Owner yang saling menurunkan
  bersamaan: satu 200, yang lain 403/409 (bukan 500). Web: pada 409 muat ulang daftar Tim; pada 403 yang tidak
  diduga muat ulang `/auth/me` (perannya mungkin baru diturunkan).
- **Perubahan tim oleh selain Owner (Info 6).** Ubah peran / nonaktifkan oleh Admin → email ke semua Owner
  aktif ("Peran {nama} di {produk} diubah oleh {pelaku} (Admin)" / "{nama} di {produk} dinonaktifkan oleh …"),
  dan di ringkasan keamanan kejadian `role_changed`/`user_disabled` itu ber-`severity: "warning"` (ikut
  `latestWarningAt`; `details.actorRole` = peran pelaku). Oleh Owner tetap `info`, tanpa email.
  `SECURITY_EVENT_SEVERITY` adalah keparahan BAWAAN — web selalu memakai `event.severity` dari server. Audit
  `user.role_changed`/`user.disabled` kini memuat `actorRole`.
- **Kunci 2FA harian (Info 2).** 20 kode verifikasi dua langkah salah dalam 24 jam dari perangkat yang belum
  dikenal → langkah kedua akun itu dikunci sampai jendela 24 jamnya habis (429 + `Retry-After`, audit
  `auth.account.locked` dengan `daily: true`). **"Buka kunci" Owner/Admin TIDAK melepas kunci ini** (supaya
  "tolong buka kunci saya" tidak memberi tebakan tanpa batas) — respons buka kunci bisa tetap
  `status: "locked"` dengan `lockedUntil` hingga 24 jam. Yang melepasnya: atur ulang 2FA (autentikator baru).
  Perangkat dikenal pemilik akun tidak dihitung dan tidak terkena. Saran teks web bila setelah buka kunci masih
  terkunci: "Kunci ini karena terlalu banyak kode verifikasi salah dalam 24 jam. Atur ulang verifikasi dua
  langkah bila pemiliknya kehilangan aplikasi autentikator."
- **Teks email**: subjek "akun {produk} kamu" kini "akun {produk}-mu" (nama produk dari branding); "kotak
  emailmu" → "kotak email-mu". `PASSWORD_RULES_HINT` dan pesan kode SMTP di shared kini "email-mu".
