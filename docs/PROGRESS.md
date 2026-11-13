# Progress

**Fase aktif:** 1 — Akun, peran, keamanan
**Terakhir diperbarui:** 2026-11-14 (Fase 1 butir 1–2 selesai; butir 3 2FA berjalan)

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

## Sedang dikerjakan
- **Fase 1 butir 3 — 2FA TOTP + kode cadangan (14 Nov).** Backend selesai tetapi **BELUM di-commit**
  (working tree: `apps/api/src/modules/two-factor/`, `packages/core/src/totp.ts`, migrasi `0003`, dsb.)
  karena mengubah respons `/auth/me`, `/auth/login`, `/setup/complete` sehingga `apps/web` gagal
  typecheck sampai frontend menyesuaikan. Frontend (langkah kode di halaman masuk, pendaftaran 2FA +
  QR + kode cadangan, Pengaturan → Keamanan, E2E dengan TOTP) dan review security 2FA sedang
  berjalan. Commit backend + frontend bersama setelah root hijau, lalu QA + kritikus untuk layar 2FA.
  Bila sesi terputus: periksa `git status`, jalankan `pnpm typecheck` — sisa pekerjaan ada di
  `apps/web` dan `e2e`.
- Pose Kak Sky & ilustrasi login pengganti menunggu Tobing (BUTUH-TOBING #5, #13).
- Database dev `balesin` dimigrasi s.d. 0002 (0003 belum). E2E memakai database `balesin_e2e`,
  Redis db 14, port API 3100 / web 5180.

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
