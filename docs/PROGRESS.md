# Progress

**Fase aktif:** 5–7 berjalan paralel (Fase 2 selesai, Fase 3 & 4 tinggal review/terblokir)
**Terakhir diperbarui:** 2026-11-23 (Fase 7 butir 1–4 selesai; revisi UI Fase 5, UI channel/jam kerja, stabilisasi tes berjalan)

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

### Fase 2 — WhatsApp & Inbox inti (20 Nov 2026)
- **Channel WhatsApp Cloud API**: wizard 9 langkah (`docs/SETUP-META.md`), kredensial terenkripsi,
  klien Graph v26.0 + `appsecret_proof`, tes koneksi, halaman nomor (kualitas, status, batas, profil
  bisnis, diagnosis webhook). Kontrak: `docs/KONTRAK-API-CHANNEL.md`.
- **Webhook masuk** (tanda tangan raw body, idempotensi, worker), **kontak & percakapan otomatis**
  (BSUID/E.164, satu sesi, jendela 24 jam dari `receivedAt`, retensi payload), hapus & ekspor kontak.
- **Inbox real-time** (WebSocket Origin wajib, disaring per RBAC; tab + hitungan, cari trigram,
  saringan, hitung mundur 24 jam), **ruang chat** (teks/media/lokasi/reaksi/kutip, unggah magic bytes,
  unduh media aman, kirim ulang, error Meta → Indonesia), **ambil/alihkan/selesai/buka lagi**,
  **panel detail** (tag kontak, catatan sesi, bintang, berkas, log), **balasan cepat `/`**,
  **batas kirim harian + rem darurat**, **notifikasi Web Push + PWA**, **tampilan HP penuh**.
  Kontrak: `docs/KONTRAK-API-INBOX.md`, `docs/KONTRAK-API-NOTIFIKASI.md`.
- Review: semua layar kritikus **LOLOS** (`docs/design-reviews/2026-11-16..19-*`), semua butir
  security **AMAN** (`docs/security-reviews/2026-11-16..20-*`). QA penutupan: Vitest 2.459 lulus,
  E2E 263 lulus (2 run penuh berturut-turut hijau), screenshot 1.144.

### Fase 3 — Bot & API untuk n8n (sebagian, 20 Nov 2026)
- **API publik v1** + API key bertingkat scope + OpenAPI `/api/docs` (`docs/KONTRAK-API-PUBLIK.md`),
  **webhook keluar** bertanda tangan (outbox, SSRF ketat + allowlist IP privat, riwayat & kirim
  ulang; `docs/KONTRAK-WEBHOOK-KELUAR.md`), layar Pengaturan → API key & Webhook — security AMAN,
  kritikus LOLOS.
- **Lapisan kompatibel MobiChat** (`/api/public/*`, `/api/bot/*`, webhook format MobiChat; tes kontrak
  memutar ulang node n8n ULAN; `docs/KONTRAK-API-MOBICHAT.md`), **bot eksternal** (saklar per channel
  & percakapan, jam kerja bot, batas waktu wajib, handoff), **pesan interaktif** — backend & web
  security AMAN; kritikus web tinggal B1–B3 (jadwal bot, dialog daftar, teks formulir MobiChat).

- Fase 3 bot/interaktif/MobiChat kritikus **LOLOS** putaran 2 → Fase 3 tinggal mode tangkap
  `/compat/<vendor>/*` + Qiscus (terblokir BUTUH-TOBING #10).

### Fase 4 — Template & Broadcast (sudah di-commit)
- **Template Meta** backend + UI (f185b2a): security backend & web AMAN; kritikus putaran 2 tinggal
  **R1** (chip nilai di pratinjau harus inline).
- **Broadcast** backend (f0fad04, 6474d8e, 2ac0d72, 6a47174 laporan "Terkirim") + UI (83a4e87):
  security backend & web AMAN; kritikus putaran 1 REVISI **BC1–BC4**
  (`docs/design-reviews/2026-11-21-fase4-broadcast.md`).

### Fase 5 — backend selesai (c5668a3, f335d9c)
- CRM (atribut, impor/ekspor, gabung), tiket multi-board, departemen, laporan + biaya Meta, CSAT,
  jam kerja tim + pesan otomatis + round-robin. Security AMAN putaran 2
  (`docs/security-reviews/2026-11-21-fase5-backend.md`, `...-fase5-jam-kerja.md`). UI Fase 5 BELUM.

### Fase 6 — backend selesai (f335d9c)
- Telegram, Email (IMAP/SMTP), Messenger & IG (nonaktif bawaan sampai App Review). Kontrak
  `docs/KONTRAK-API-CHANNEL-LAIN.md`. Security sedang mereview. UI channel baru BELUM.

### Fase 7 — butir 1–4 SELESAI (9779996, 2a09122, 4301bd7)
- Compose produksi + image non-root, gateway nginx, install.sh (mode A/B/C), CLI `balesin` (update/
  rollback, backup v2 encrypt-then-MAC, restore aman, reset-owner-password + email Owner), nginx vm,
  rilis bertanda tangan (cosign). Security **AMAN putaran 2**
  (`docs/security-reviews/2026-11-22-fase7-deploy.md`). Tersisa: banner Owner untuk reset dari server
  (`owner_password_reset_server`, backend + frontend).

## Sedang dikerjakan (dihentikan 23 Nov, BELUM di-commit)
- **Devops** — 3 Rendah putaran 2 Fase 7: P2-R3 hapus `git fetch origin main` di `rilis.yml`, P2-R1
  shebang skrip firewall di `docs/DEPLOY.md`, P2-R2 installer memasang cosign; Info (vitest.deploy di
  image, catatan nftables).
- **Frontend (agen UI Fase 5)** — revisi kritikus F1–F10 + BC5 + T3-S1, UI channel Telegram/Email/
  Meta, inbox multi-channel, jam kerja/pesan otomatis/alokasi, saklar "Tersedia",
  `z.config({jitless})` (E2E baru `jam-kerja.spec.ts`, `channel-lain.spec.ts`).
- **Backend** — stabilisasi suite tes API (timeout `afterAll`, alarm Telegram): `apps/api/src/testing/*`,
  `vitest.config.ts`, `packages/db/src/testing/*`, `apps/api/src/cli/db-roles.integration.test.ts`.
- Berikutnya: commit masing-masing setelah lolos pemeriksaan → kritikus (UI Fase 5 putaran 2 + UI baru)
  → security web UI baru → banner reset Owner → Fase 7 butir 5 (white-label + dokumentasi pengguna)
  & butir 6 (`/audit` penuh) → E2E penuh.
- Terblokir: Fase 3 mode tangkap (#10); kredensial nyata (#3, #4, #8, #15, #16, #17); distribusi (#18:
  kanal, environment `rilis`, ruleset tag, cosign keyless/kunci); deploy produksi (#19, menunggu
  #6/#7).

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
