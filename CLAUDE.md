# Balesin — Panduan Kerja untuk Claude

> File ini dibaca otomatis setiap sesi Claude Code. Ini "otak" proyek.
> Jangan andalkan riwayat chat: semua keputusan ada di `docs/`.

## Apa itu Balesin

Balesin adalah aplikasi **omnichannel customer service** (inbox tim bersama) berbasis
**WhatsApp Cloud API resmi dari Meta**, plus channel lain (Telegram, Email, Facebook
Messenger, Instagram DM). Dibuat oleh **PT Sky Base Technology Digital (Sky Tech)**,
dipakai pertama kali oleh tim Sky Tech, lalu dijual sebagai produk **self-hosted
white-label** ke perusahaan lain.

- Domain produksi Sky Tech: `https://balesin.skytech.net.id`
- Repo: `github.com/PutuTobing/balesin` (PRIVAT)
- Maskot: **Kak Sky**
- Pemilik produk: Tobing (Direktur Sky Tech)

## Peran sesi utama: ORKESTRATOR

Sesi utama Claude Code adalah **orkestrator**. Tugasnya:
1. Baca `docs/PROGRESS.md` → tahu posisi terakhir.
2. Ambil tugas berikutnya dari `docs/ROADMAP.md`.
3. Delegasikan ke subagent di `.claude/agents/` (lihat tabel di bawah).
4. Jalankan **siklus mutu** sampai *Definition of Done* lolos.
5. Catat hasil di `docs/PROGRESS.md`, commit, lanjut tugas berikutnya.

Perintah praktis: `/lanjut` (kerjakan fase berjalan sampai selesai) dan `/audit`
(audit menyeluruh tampilan + keamanan + bug).

| Subagent | Tugas |
|---|---|
| `riset-fitur` | Ubah referensi (screenshot MobiChat, ekspor n8n) jadi spesifikasi fitur & mapping API |
| `backend` | API, database, worker, integrasi Meta/n8n/email |
| `frontend` | Web app (desktop + HP), PWA |
| `kritikus-desain` | Menilai setiap layar dengan rubrik `docs/DESIGN.md`, memaksa revisi |
| `qa-tester` | Tes otomatis (unit, integrasi, E2E Playwright), screenshot 390px & 1440px |
| `security` | Review keamanan sesuai `docs/SECURITY.md` sebelum tugas dianggap selesai |
| `devops` | Docker, installer `curl`, update, backup, deploy |

## Aturan otonomi (PENTING)

Tobing ingin **sesedikit mungkin memberi prompt**. Maka:
- **Jangan bertanya** untuk hal yang bisa diputuskan dari dokumen ini atau `docs/`.
  Ambil keputusan terbaik, catat di `docs/DECISIONS.md`, lanjut.
- Koreksi tampilan (font kebesaran, kurang menarik, jarak berantakan) **bukan tugas
  Tobing** — itu tugas `kritikus-desain` + `frontend`. Ulangi sampai rubrik lolos.
- Hanya berhenti/menunggu untuk hal di daftar **"Butuh Tobing"**: kredensial/token
  (Meta, SMTP, GitHub), aksi di akun pihak ketiga, deploy ke produksi, biaya uang,
  keputusan yang tidak bisa dibatalkan. Tulis ke `docs/BUTUH-TOBING.md`, lalu
  **kerjakan tugas lain** yang tidak terblokir. Jangan diam menunggu.
- Kalau dua pendekatan sama-sama masuk akal: pilih yang lebih sederhana & aman.

## Definition of Done (setiap tugas)

Tugas BELUM selesai sampai semua ini benar:
1. Fitur jalan sesuai spesifikasi di `docs/PRD.md` / `docs/ROADMAP.md`.
2. Lint + typecheck bersih, semua tes lulus (`qa-tester`).
3. Ada tes untuk logika baru (unit/integrasi) dan alur utama (E2E bila ada UI).
4. Layar baru lolos rubrik `kritikus-desain` di **390px (HP)** dan **1440px (desktop)**,
   mode terang & gelap.
5. `security` tidak menemukan temuan level Tinggi/Kritis.
6. Teks UI bahasa Indonesia yang natural, tidak ada teks placeholder/Lorem/English nyasar.
7. `docs/PROGRESS.md` diperbarui; commit dibuat.

## Stack (sudah diputuskan — lihat `docs/ARCHITECTURE.md`)

- Monorepo **pnpm**: `apps/api`, `apps/web`, `apps/worker`, `packages/shared`
- Backend: **Node.js 22 + TypeScript + Fastify**, ORM **Drizzle**, **PostgreSQL 16**
- Antrian/real-time: **Redis 7 + BullMQ**, WebSocket untuk inbox real-time
- Frontend: **React + Vite + TypeScript**, TanStack Router/Query, primitives Radix,
  styling dengan design token sendiri (`docs/DESIGN.md`) — bukan tampilan template default
- Validasi bersama: **Zod** di `packages/shared`
- Tes: Vitest + Playwright
- Deploy: **Docker Compose**, installer `curl | bash`, perintah `balesin update`

## Aturan keras (TIDAK BOLEH dilanggar)

- ❌ **Jangan pernah** memakai library WhatsApp tidak resmi (Baileys, whatsapp-web.js,
  WAHA, venom, dsb). Hanya **WhatsApp Cloud API resmi Meta**.
- ❌ Jangan pakai kata "WhatsApp" di nama produk/logo (merek dagang Meta).
- ❌ Token Meta, app secret, password SMTP, API key **tidak pernah** dikirim ke browser,
  tidak di-log, tidak di-commit. Simpan terenkripsi di DB (lihat `docs/SECURITY.md`).
- ❌ Jangan commit `.env`, jangan `git push --force`, jangan ubah branch `main` langsung.
- ❌ Jangan hardcode hal khusus Sky Tech di kode produk. Semua lewat pengaturan
  (white-label). Konteks Sky Tech ada di `docs/KONTEKS-SKYTECH.md` hanya untuk seed/demo.
- ❌ Jangan mendaftar pengguna bebas. Akun pertama = Owner via wizard setup; sisanya
  lewat **undangan email**.

## Git

- Kerja di branch `dev`. Satu commit per tugas selesai, pesan bahasa Indonesia gaya
  Conventional Commits, mis. `feat(inbox): tab Unserved dan timer jendela 24 jam`.
- `main` hanya diperbarui setelah Tobing review (lewat PR).

## Bahasa

- Komunikasi dengan Tobing, dokumen, dan teks UI: **bahasa Indonesia**.
- Nama variabel/fungsi/tabel: bahasa Inggris.

## Peta dokumen

| File | Isi |
|---|---|
| `docs/PRD.md` | Daftar fitur lengkap & prioritas |
| `docs/ARCHITECTURE.md` | Arsitektur, deploy, mode jaringan, struktur repo |
| `docs/ROADMAP.md` | Fase & tugas berurutan + kriteria selesai |
| `docs/SECURITY.md` | Standar keamanan wajib |
| `docs/DESIGN.md` | Design system + rubrik penilaian layar |
| `docs/PENGATURAN-UI.md` | Aturan wajib: semua koneksi/konfigurasi diisi lewat UI, bukan kode/`.env` |
| `docs/API-N8N.md` | API & webhook, termasuk mode kompatibel MobiChat |
| `docs/SETUP-META.md` | Teks wizard koneksi WhatsApp (dipakai di UI) |
| `docs/BRANDING-PROMPTS.md` | Prompt gambar Kak Sky & logo |
| `docs/KONTEKS-SKYTECH.md` | Konteks operasional Sky Tech |
| `docs/DECISIONS.md` | Log keputusan |
| `docs/PROGRESS.md` | Status terkini |
| `docs/BUTUH-TOBING.md` | Antrian hal yang menunggu Tobing |
| `docs/reference/` | Screenshot MobiChat, ekspor workflow n8n |
