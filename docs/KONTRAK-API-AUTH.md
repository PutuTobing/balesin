# Kontrak API — Setup, Login, Branding, Email pengirim (Fase 1)

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
| POST `/setup/complete` | `completeSetupRequestSchema` | **201** `authenticatedSessionSchema` + Set-Cookie |

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
7. **Selesai**: `complete` 201 → Owner langsung masuk. Error dipetakan ke langkah lewat awalan
   field (`owner.`, `organization.`, `branding.`, `email.`). 409 → halaman masuk.

## Auth
- POST `/auth/login` (publik, `loginRequestSchema`) → 200 `loginResponseSchema`. Periksa
  `status` (sekarang hanya `authenticated`; langkah 2FA nanti menambah varian).
  - 401 `INVALID_CREDENTIALS`: pesan sama untuk email tak terdaftar, password salah, akun
    nonaktif. Jangan diperlakukan seperti 401 sesi habis.
  - 429: per IP (20 gagal/15 menit, "…dari jaringanmu…") atau akun dikunci 15 menit setelah
    5 gagal.
  - 503: Redis mati / server sibuk. 400: validasi.
- POST `/auth/logout` (sesi + CSRF) → `{status: 'logged_out'}`, cookie dihapus.
- GET `/auth/me` (sesi) → `meResponseSchema` atau 401.

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

## Pengembangan lokal
- Mailpit (dari `pnpm db:up`) menangkap semua email: UI http://localhost:8025. Isian SMTP:
  host `localhost`, port `1025`, keamanan "Tanpa enkripsi", username/password `balesin`.
