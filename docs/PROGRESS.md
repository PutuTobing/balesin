# Progress

**Fase aktif:** 2 — WhatsApp & Inbox inti
**Terakhir diperbarui:** 2026-11-16 (Fase 2 butir 1–3 selesai dibangun; revisi desain Channel berjalan)

## Selesai

### Fase 0 — Fondasi (13 Nov 2026)
- Monorepo pnpm 12: `apps/api`, `apps/web`, `apps/worker`, `packages/shared`, `packages/core`
  (khusus server), `packages/db`, `e2e`. TypeScript 6 strict, ESLint (type-checked), Prettier.
- Dev lokal: `pnpm db:up` (Postgres 16 + Redis 7 + Mailpit lewat Docker), `.env.example` lengkap.
- API Fastify dasar, Drizzle + migrasi, worker BullMQ, shell web desktop/HP dengan design token.
- CI GitHub Actions + Dependabot; penjaga library WhatsApp tidak resmi (`pnpm check:deps`).
- Review: `kritikus-desain` LOLOS, `security` AMAN (`docs/design-reviews/`, `docs/security-reviews/`).

### Fase 1 — Akun, peran, keamanan (16 Nov 2026)
- **Setup & login**: wizard setup Owner (token setup, organisasi, Owner, nama produk + logo, email
  pengirim), halaman masuk, sesi ter-hash, CSRF terikat sesi, hook auth bawaan tolak, kunci login
  per email+asal + perangkat dikenal, jatah login per IP hanya untuk percobaan gagal.
- **2FA TOTP + kode cadangan**, wajib untuk Owner/Admin/Supervisor; batas pendaftaran 72 jam.
- **Undangan via email, verifikasi email, atur ulang password, template email bermerek** (token di
  fragment URL; reset tidak bisa memotong 2FA; tanpa SMTP: tautan undangan disalin).
- **RBAC 5 peran**: matriks izin tunggal `packages/shared/src/permissions.ts` (PRD §4), penegakan
  bawaan-tolak + tes semua rute × peran, menu & rute web berbasis izin.
- **Manajemen tim, sesi aktif, audit log** (ekspor CSV, ringkasan keamanan 7 hari → banner).
- **Konfirmasi ulang identitas** (password + kode 2FA) untuk semua aksi sensitif, **termasuk
  Owner**: kelola pengguna, undang/kirim ulang undangan, email pengirim, kredensial channel.
- Pemberitahuan ke Owner untuk perubahan oleh Admin (email pengirim, tim, channel, profil bisnis),
  anggota baru bergabung, reset password massal.
- Kontrak: `docs/KONTRAK-API-AUTH.md`. Aturan istilah UI: `docs/DESIGN.md` §4.
- Review akhir: security **AMAN** putaran 2 (`docs/security-reviews/2026-11-15-fase1-akhir.md`),
  kritikus konsistensi **LOLOS** putaran 2 (`docs/design-reviews/2026-11-15-fase1-akhir.md`);
  semua review per butir lolos (`docs/security-reviews/2026-11-1*`, `docs/design-reviews/2026-11-1*`).
- Tes: Vitest (shared 97, core 445, db 86, web 467, worker 61, api 638) + **224 E2E** lulus.

### Fase 2 (sebagian)
- Butir 1–2 **backend**: channel WhatsApp Cloud API (kredensial terenkripsi, klien Graph v26.0
  dengan `appsecret_proof`, tes koneksi, profil bisnis, pemberitahuan Owner), review security AMAN.
  Kontrak: `docs/KONTRAK-API-CHANNEL.md`.

- Butir 1–2 **web** (60be001): Pengaturan → Channel, wizard 9 langkah, halaman nomor, profil
  bisnis, E2E dengan server Meta tiruan. `disabledAt` + 404 untuk ID bukan UUID (294e0d6, migrasi
  0011). Security web **AMAN** (`docs/security-reviews/2026-11-16-fase2-channel-web.md`, R1/R2 Rendah).
- Butir 3 **webhook masuk** (4642360 + pengerasan 2609aa2): security **AMAN** putaran 2
  (`docs/security-reviews/2026-11-16-fase2-webhook.md`). Ditunda: S3 `TRUST_PROXY` → Fase 7;
  S4 retensi payload → butir kontak (wajib sebelum produksi). Catatan N1: handler jangan
  `UPDATE channels` di transaksi yang memegang `FOR SHARE`; N2: jejak tahan lama untuk baris ditolak DB.

## Sedang dikerjakan
- **Revisi layar Channel putaran 1** (kritikus REVISI, `docs/design-reviews/2026-11-16-fase2-channel.md`):
  W1–W9 + S1/S2 + tampilan `disabledAt` + security web R1 (isian rahasia tak terkendali, ubah
  `it.fails` jadi `it`) dan R2 (autocomplete/abaikan password manager) + Q1/Q2 mock & foto.
  **Dihentikan di tengah jalan (16 Nov)** — perubahan belum di-commit ada di working tree
  (`apps/web/src/features/channels/**`, `base.css`, `id.ts`, `RichText`, `CodeField`, `Field`,
  `packages/shared/src/channels.ts`, `e2e/capture/*channel*`, `e2e/tests/channel.spec.ts`, baru:
  `SectionNav.tsx`, `MasterKeyCommand.tsx`). Lanjutkan: frontend menuntaskan + root checks + e2e +
  screenshots → commit → kritikus putaran 2 → QA → centang butir 1–3 di ROADMAP.
- **Lalu Fase 2 butir 4 — kontak & percakapan otomatis + jendela 24 jam**: isi `InboundEventHandlers`
  di `apps/worker/src/queues/webhooks.ts` (kunci kontak BSUID `sender.userId`, jendela dari
  `receivedAt`), retensi payload `webhook_events` (S4), perhatikan N1/N2. Sisa Rendah audit akhir
  Fase 1 (R1 audit penolakan CSRF bersesi, sisa R5, F.5 Origin WebSocket, F.11 RLS) dikerjakan
  bersama butir inbox real-time.

## Catatan untuk sesi berikutnya

**Cara menjalankan**
- `pnpm db:up` → salin `.env.example` ke `.env` (isi `BALESIN_MASTER_KEY`, `SESSION_SECRET`,
  `SETUP_TOKEN` — acak kuat, lihat komentar di berkas) → `pnpm db:migrate` → `pnpm dev` → buka
  `http://localhost:5173`. Email tertangkap di Mailpit http://localhost:8025.
- Pemeriksaan lengkap: `pnpm check` (format, lint, check:deps, typecheck, tes), `pnpm build`,
  `pnpm e2e` (stack E2E: database `balesin_e2e`, Redis db 14, API 3100 / web 5180),
  `pnpm screenshots`. Tes API berat: `pnpm --filter @balesin/api exec vitest run --maxWorkers=3`.
- Di Git Bash (Windows), nilai env berawalan `/` diubah jadi path Windows; isi rahasia lewat `.env`.
- Kritikus memotret dari git worktree sementara dengan stack terpisah (3191/5191,
  `balesin_kd_e2e`, Redis db 11) supaya tidak bentrok dengan pekerjaan yang belum di-commit.

**Pola wajib untuk fase berikutnya**
- Setiap rute mendeklarasikan izin (`requirePermission`) + skema respons; GET berefek pakai
  `requireCsrf`; penolakan aturan turunan lewat `forbidByRule()`.
- Aksi tulis sensitif: konfirmasi identitas (`requireIdentityConfirmation`) dan cek ulang pelaku di
  transaksi akhir (`assertActorStillAuthorized`). Data bercakupan: `permissionGrant` +
  `scopeCondition` di repo daftar.
- Kirim pesan: izin `inbox.reply` (percakapan yang ada) vs `inbox.initiate` (nomor baru, batas harian
  per pengguna); Teknisi hanya data yang di-assign; batas laju Meta per kelompok `messaging`.
- Payload antrian hanya ID; token tidak pernah di URL path/log; tautan dari `APP_URL`.
- Data daftar dimuat lewat TanStack Query di komponen (bukan loader rute).

**Ditunda / menunggu**
- Owner lupa password tanpa SMTP butuh perintah CLI pemulihan → Fase 7 (wajib sebelum produksi);
  production wajib `BALESIN_MASTER_KEY`; catatan rilis migrasi 0007; CSP produksi (pratinjau email,
  Radix `<style>`); peran DB runtime terpisah dari pemilik tabel (trigger audit); `TRUST_PROXY` diisi
  installer + peringatan health/banner (webhook S3); hak `CREATE` pada database untuk
  `CREATE EXTENSION pg_trgm` (migrasi 0013) saat `balesin update`.
- Fase 4 (impor kontak/kirim ke nomor/broadcast): R4 kontak hanya-nomor vs BSUID pertama.
- Web inbox: teks pesan & nama profil `dir="auto"`; nomor/@username selalu di samping nama profil WA;
  `sourceUrl`/`filename` sebagai teks (tonjolkan hostname); layar diagnosis webhook (`expired_pending`,
  baris ditolak N2); banner `webhook_signature_failed` menautkan ke channel (butuh `channelId`).
- Pose Kak Sky (BUTUH-TOBING #5), kredensial Meta (#3), detail SMTP (#4).
- Poles desain: tab "Bot" di 360px 42px; bedakan "inbox kosong" vs "belum memilih chat".
