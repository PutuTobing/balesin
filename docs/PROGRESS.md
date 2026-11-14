# Progress

**Fase aktif:** 1 — Akun, peran, keamanan
**Terakhir diperbarui:** 2026-11-14 malam (Fase 1 butir 4–6 backend selesai; web butir 6 hampir selesai)

## Selesai

### Fase 0 — Fondasi (13 Nov 2026)
- Monorepo pnpm 12: `apps/api`, `apps/web`, `apps/worker`, `packages/shared`, `packages/core`
  (khusus server), `packages/db`, `e2e`. TypeScript 6 strict, ESLint (type-checked), Prettier.
- Dev lokal: `pnpm db:up` (Postgres 16 + Redis 7 lewat Docker), `.env.example` lengkap.
- API: Fastify dasar — `/health`, `/ready`, amplop error seragam berbahasa Indonesia, validasi
  Zod, logger pino dengan redaksi rahasia, header keamanan, CORS, 405 + `Allow`.
- DB: Drizzle + migrasi awal (`organizations`, `users`, `user_sessions`, `audit_logs`).
- Worker: kerangka BullMQ (antrian `system`).
- Web: shell desktop (rail 64px) / HP (navigasi bawah), design token → CSS variables, font
  self-host, tema Terang/Gelap/Ikuti sistem tanpa inline script, keadaan kosong/memuat/gagal/404.
- Tes: Vitest (628 tes unit + integrasi terhadap Postgres/Redis sungguhan) dan Playwright
  (123 tes E2E di 390px dan 1440px). Skrip screenshot: `pnpm screenshots`.
- CI GitHub Actions + Dependabot; penjaga library WhatsApp tidak resmi (`pnpm check:deps`).
- Hook Claude Code: Prettier + typecheck otomatis setelah setiap edit.
- Riset: 12 usulan fitur dari MobiChat diputuskan dan masuk PRD/ROADMAP.
- Review: `kritikus-desain` LOLOS (putaran 2), laporan di `docs/design-reviews/`;
  `security` AMAN (putaran 2, tanpa temuan Kritis/Tinggi), laporan di `docs/security-reviews/`.
- `pnpm audit`: 2 temuan sedang, hanya di dependensi dev (esbuild lewat drizzle-kit, minimatch
  lewat eslint); `--prod` bersih. Diterima tanpa override.

### Fase 1 butir 1–2 — Setup & login (14 Nov 2026)
- Wizard setup Owner (token setup, organisasi, Owner, nama produk + logo, email pengirim), halaman
  masuk, menu akun + keluar, Pengaturan → Email pengirim (preset, panduan, tes koneksi, email tes).
- Sesi ter-hash, CSRF terikat sesi, hook auth bawaan tolak, kunci login per email+asal + cookie
  perangkat dikenal, audit log hanya-tambah, password SMTP terenkripsi. Kontrak:
  `docs/KONTRAK-API-AUTH.md`.
- Review: security AMAN (`docs/security-reviews/2026-11-13-fase1-setup-login.md`), QA bug QA1–QA6
  diperbaiki, `kritikus-desain` LOLOS putaran 3 (`docs/design-reviews/2026-11-13-auth-fase1.md`).
- Aset merek terpasang (logo, favicon, ikon PWA, ilustrasi login).

### Fase 1 butir 3 — 2FA TOTP + kode cadangan (14 Nov 2026)
- Wajib untuk Owner/Admin/Supervisor (termasuk Owner hasil setup — sesi pendaftaran 30 menit),
  login dua langkah dengan tantangan, kode cadangan (argon2id, tampil sekali + dialog tinggalkan),
  Pengaturan → Keamanan akun, QR di browser, email pemberitahuan, audit. TOTP ditulis sendiri
  (vektor RFC). Kontrak: `docs/KONTRAK-API-AUTH.md` bagian 2FA.
- Review: security AMAN putaran 2 (`docs/security-reviews/2026-11-14-fase1-2fa.md`), QA bug
  QA-2FA-1..5 diperbaiki, `kritikus-desain` LOLOS putaran 3 (`docs/design-reviews/2026-11-14-2fa.md`).
- Tes: 1.238 Vitest + 176 E2E lulus.

## Sedang dikerjakan (dihentikan 14 Nov malam — lanjut sesi berikutnya)

**Sudah di-commit (belum di-push — 39 commit menunggu `git push origin dev`):**
- Fase 1 butir 4 backend + perbaikan security (`5affb46`, `ccc5623`); web butir 4 (`9ef14f8`).
- Fase 1 butir 5 RBAC + perbaikan security (`a6a76b4`, `e87bd33`) — PRD §4 diperbarui.
- Fase 1 butir 6 backend (`4141fcd`) + perbaikan security R1–R4 (`84792bc`).
- Fase 2 butir 1–2 backend: channel WhatsApp (`91ec7c2`), kontrak `docs/KONTRAK-API-CHANNEL.md`.
- Review: security AMAN untuk butir 4, 5, 6 (`docs/security-reviews/2026-11-14-*`).

**Di working tree, BELUM di-commit (setengah jadi — periksa dulu, jangan commit apa adanya):**
1. `apps/web`, `e2e` (agent frontend, hampir selesai — terakhir: screenshot 625/625 lulus, akan
   menjalankan `pnpm test` dan `pnpm build`):
   - layar butir 6: Tim (daftar & detail pengguna, ubah peran, nonaktif, reset 2FA, buka kunci,
     sesi), dialog konfirmasi identitas, Keamanan → Sesi aktif, Audit log (+ ekspor CSV dengan
     header CSRF), banner keamanan, `TWO_FACTOR_ENROLLMENT_EXPIRED`;
   - revisi kritikus butir 4 (`docs/design-reviews/2026-11-14-undangan-reset.md` W1–W3, S1–S6,
     P1–P3, P5, P6);
   - penyesuaian perubahan API butir 6 (`docs/KONTRAK-API-AUTH.md` bagian "Perubahan setelah
     review keamanan butir 6") dan teks "email-mu".
   Lanjutkan: agent `frontend` periksa `git diff`, lengkapi yang belum, jalankan semua pemeriksaan
   root (`format:check`, `lint`, `check:deps`, `typecheck`, `test`, `build`, `e2e`, `screenshots`).
2. `apps/api`, `packages/core`, `packages/shared` (agent backend, baru sebagian): pemberitahuan
   email ke Owner + kejadian `warning` saat Admin mengubah kredensial/channel WhatsApp. Lanjutkan
   atau mulai ulang dengan agent `backend` (periksa `git diff` dulu), lalu pemeriksaan backend.

**Urutan berikutnya:** selesaikan 1 & 2 → commit → kritikus putaran 2 butir 4 + kritikus layar
butir 6 → QA butir 4–6 → centang butir 4, 5, 6 di ROADMAP → butir 7 (review security +
kritikus semua layar auth) → tutup Fase 1 → review security channel WhatsApp → frontend wizard
WhatsApp (Fase 2 butir 1–2) → webhook masuk (Fase 2 butir 3).

- Owner lupa password tanpa SMTP butuh perintah CLI pemulihan → Fase 7 (wajib sebelum produksi).
- Pose Kak Sky menunggu Tobing (BUTUH-TOBING #5). Kredensial Meta menunggu Tobing (#3).
- Database dev `balesin` belum menerima migrasi 0003–0008 (jalankan `pnpm db:migrate`). E2E memakai
  database `balesin_e2e`, Redis db 14, port API 3100 / web 5180.

## Catatan untuk sesi berikutnya

**Cara menjalankan**
- `pnpm db:up` → salin `.env.example` ke `.env` (isi `BALESIN_MASTER_KEY`, `SESSION_SECRET`,
  `SETUP_TOKEN`) → `pnpm db:migrate` → `pnpm dev` → buka `http://localhost:5173`.
- Pemeriksaan lengkap: `pnpm check` (format, lint, check:deps, typecheck, tes), `pnpm build`,
  `pnpm e2e`.
- Di Git Bash (Windows), nilai variabel lingkungan yang berawalan `/` diubah menjadi path
  Windows; isi rahasia lewat `.env`, jangan `export` dari Git Bash.

**Wajib diperhatikan saat membangun Fase 1** (rincian: bagian F laporan security Fase 0)
- Cookie sesi berawalan `__Host-`; token CSRF terikat sesi (`SameSite=Lax` saja tidak cukup).
- Setiap rute punya skema respons; RBAC bawaan menolak. Rate limit melempar
  `AppError('RATE_LIMITED')`.
- `request.ip` divalidasi `net.isIP` sebelum masuk kolom `inet`; tautan email selalu disusun
  dari `config.appUrl`, bukan `request.host`.
- Token tidak boleh berada di segmen path URL atau payload job (sensor log tidak menangkapnya).
- Kunci log `sessionId` selalu disensor; untuk ID baris sesi pakai nama lain (mis. `sessionRef`).
- Semua rute modul didaftarkan di `buildApp` **sebelum** `registerMethodNotAllowedRoutes()`.
- Audit log hanya-tambah baru berupa konvensi; kunci di tingkat database (trigger/hak akses).
- Auth dipasang sebagai hook `onRequest` di root dengan bawaan tolak + daftar rute publik
  eksplisit; rute pelengkap 405 berada di luar scope plugin (temuan N1 security putaran 2).
- Komponen modal Radix (Dialog, Select) menyuntikkan `<style>` inline yang ditolak CSP
  `style-src 'self'`; perlu nonce atau keputusan CSP saat dialog pertama dibuat.
- Data daftar dimuat lewat TanStack Query di dalam komponen (prop `loading`), bukan loader rute
  — `pendingComponent` me-remount layar dan menghapus teks yang sedang diketik.

**Poles desain yang ditunda** (laporan kritikus putaran 2)
- Tab "Bot" di lebar 360px hanya 42px (target 44px); CSS perbaikannya ada di laporan.
- Bedakan "inbox kosong" dari "belum memilih chat"; kerangka memuat per halaman begitu ada data.
- Logo dan ilustrasi Kak Sky masih placeholder (BUTUH-TOBING #5): ganti di
  `apps/web/src/brand/brand-mark-shape.ts` dan `components/illustrations/illustrations.tsx`.

**Terblokir untuk Fase 1**
- Kirim email sungguhan (undangan, reset password) butuh detail SMTP (BUTUH-TOBING #4). Fitur
  tetap dibangun dan dites dengan penangkap email lokal; yang menunggu hanya uji kirim nyata.
