# Progress

**Fase aktif:** 2 — WhatsApp & Inbox inti
**Terakhir diperbarui:** 2026-11-16 (Fase 2 butir 1–4 selesai; butir 5 inbox real-time berjalan)

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
- Butir 1–2 **web**: Pengaturan → Channel, wizard 9 langkah, halaman nomor (navigasi bagian ≥1024px),
  profil bisnis, ganti kredensial, nonaktif/hapus; E2E dengan server Meta tiruan. Kritikus **LOLOS**
  putaran 4 (`docs/design-reviews/2026-11-16-fase2-channel.md`); security web **AMAN**
  (`docs/security-reviews/2026-11-16-fase2-channel-web.md`, R1/R2 sudah ditutup).
- Butir 3 **webhook masuk** (4642360 + pengerasan 2609aa2): security **AMAN** putaran 2
  (`docs/security-reviews/2026-11-16-fase2-webhook.md`).
- Butir 4 **kontak & percakapan otomatis + jendela 24 jam** (b03de89, bff5abd; migrasi 0012–0013):
  kontak BSUID/E.164, percakapan = satu sesi, pesan + status maju, retensi payload, API baca inbox.
  Security **AMAN** putaran 2 (`docs/security-reviews/2026-11-16-fase2-kontak-percakapan.md`).
  Kontrak: `docs/KONTRAK-API-INBOX.md`.

## Sedang dikerjakan
- **Fase 2 butir 5 — inbox real-time**: backend SELESAI (72b4fd2, 320ae51; security AMAN putaran 2,
  `docs/security-reviews/2026-11-16-fase2-inbox-realtime.md`). **Web layar inbox dihentikan di
  tengah jalan** (belum di-commit: `apps/web/src/features/inbox/**`, `AppShell.module.css`,
  `SearchField.tsx`, `id.ts`, `endpoints.ts`, `test/fake-inbox.ts`, `test/fake-socket.ts`): daftar +
  tab + hitungan, cari, filter, hitung mundur 24 jam, ruang chat baca-saja, panel kontak, klien WS.
  Lanjutkan: frontend menuntaskan (pasang di halaman + AppShell, mock E2E/screenshot inbox, E2E
  webhook → tampil) → root checks → commit → kritikus → QA.
- **Fase 2 butir 6 — ruang chat (backend) dihentikan di awal** (belum di-commit: migrasi
  `0014_ruang_chat_media.sql`, `schema/media-files.ts`, `schema/messages.ts`, `organizations.ts`,
  `packages/shared/src/{outbound,inbox,errors,api-routes}.ts`, `core/meta/graph-client.ts`,
  `apps/api/package.json` + lockfile). Lingkup: kirim teks/balas/reaksi/lokasi/media via worker,
  jendela 24 jam di server, peta error Meta → Indonesia + kirim ulang, upload (magic bytes) & unduh
  media (host Meta saja, `filename*` RFC 5987), fake Meta, kontrak di KONTRAK-API-INBOX. Sisipkan
  3 Info realtime putaran 2 (userId di sinyal revoke, penjaga checkClients, terbit setelah commit).
- Saran desain Channel terbuka (tidak menahan): S3 tautan channel di banner webhook, S10 ilustrasi
  per langkah wizard (BUTUH-TOBING #5), S11 nasib riwayat chat saat channel dihapus (putuskan di
  butir ruang chat), P4-S1 ruang kosong di bawah kartu terakhir.

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
