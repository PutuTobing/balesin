# Log Keputusan

| Tanggal | Keputusan | Alasan |
|---|---|---|
| 2026-11-13 | Nama produk **Balesin**, maskot **Kak Sky**, domain `balesin.skytech.net.id` | Gen Z, jelas fungsinya, bebas merek "WhatsApp" |
| 2026-11-13 | Model bisnis: **self-hosted** per perusahaan, nomor & Meta app milik masing-masing | Tidak perlu jadi Tech Provider untuk v1 |
| 2026-11-13 | Koneksi WhatsApp v1 = **wizard manual**; Embedded Signup + Coexistence QR = fase NANTI | Embedded Signup butuh status Meta Tech Provider |
| 2026-11-13 | Uji coba pakai **nomor tes Meta** dulu | Nomor CS utama tetap di MobiChat sampai stabil |
| 2026-11-13 | API n8n **kompatibel MobiChat** | Workflow ULAN tinggal ganti URL |
| 2026-11-13 | DNS tetap di IDCloudHost; deploy Sky Tech **Mode A** (di belakang vm-nginx) | Delegasi subdomain ke Cloudflare hanya untuk Enterprise |
| 2026-11-13 | 5 peran: Owner, Admin, Supervisor, CS, Teknisi; satu nomor untuk semua | Pelanggan tidak bingung nomor resmi |
| 2026-11-13 | Tidak ada daftar bebas; Owner via wizard, lainnya undangan email | Keamanan |
| 2026-11-13 | Play Store/App Store ditunda; v1 = **PWA** | Fokus produk inti dulu |
| 2026-11-13 | Stack: pnpm monorepo, Fastify, Drizzle, Postgres, Redis/BullMQ, React+Vite | Portabel, cocok self-hosted Docker |
| 2026-11-13 | Usulan tambahan MobiChat diproses. **Masuk PRD**: pesan interaktif (PENTING, F3); filter status sesi (WAJIB, F2); pesan otomatis saat assign + jam kerja bot (PENTING, F5); departemen + akses departemen sendiri (PENTING, F5); kapasitas per agen (PENTING, F5); CSAT (PENTING, F5); tiket multi-board/Kanban/Daftar/atribut kustom + API tiket (PENTING, F5); preset template industri ISP (PENTING, F4); tag otomatis broadcast (PENTING, F4); quality rating & profil bisnis nomor (PENTING, F2); laporan waktu respons/tunggu/resolusi + kinerja agen & bot (PENTING, F5); API template untuk aplikasi billing (WAJIB, F3, sudah ada di roadmap). **Ditunda/ditolak**: batas channel per user dan tag default per user (NANTI, tidak ada kebutuhan Sky Tech; peran + departemen cukup untuk v1); tampilan Kalender/Ringkasan tiket (NANTI, Kanban+Daftar cukup); iklan, Customers B2B, target revenue, Threads/Google Reviews (di luar cakupan). Preset template dibuat generik, bukan hardcode Sky Tech | Kebutuhan nyata tim Sky Tech dan nilai jual, tanpa menarik fitur NANTI ke depan; tidak melanggar aturan keras |
| 2026-11-13 | **TypeScript dikunci 6.0.x** (bukan 7.x); versi bersama dikunci lewat `catalog` di `pnpm-workspace.yaml` | `typescript-eslint` baru mendukung TS < 6.1; naik ke 7 setelah linter mendukung |
| 2026-11-13 | Tambah paket **`packages/db`** (`@balesin/db`: skema Drizzle, migrasi, klien) di luar struktur awal `ARCHITECTURE.md` §2 | Dipakai api **dan** worker; tidak boleh ikut ter-bundle ke browser lewat `packages/shared` |
| 2026-11-13 | Paket internal dikonsumsi sebagai **sumber TypeScript langsung** (tanpa langkah build antar-paket); api/worker di-bundle `tsup` | Dev lebih sederhana, tidak ada urutan build yang bisa lupa |
| 2026-11-13 | **pnpm 12** dengan kebijakan rantai pasok bawaan: versi yang terbit < 1 hari ditolak (pilih versi sebelumnya, bukan pengecualian), skrip install pihak ketiga hanya yang terdaftar di `allowBuilds` | `SECURITY.md` §9 (kunci versi, audit dependency) |
| 2026-11-13 | Node minimal **22** (`engines`, `.nvmrc`, CI); PC pengembangan memakai Node 24 | Stack menetapkan Node 22 LTS; kode tidak memakai fitur khusus 24 |
| 2026-11-13 | Dev lokal: Postgres 16 + Redis 7 lewat `pnpm db:up` (Docker compose); tes integrasi memakai Postgres sungguhan di `DATABASE_URL_TEST` (CI: service container). Cadangan `embedded-postgres` dibatalkan | Docker Desktop sudah jalan setelah WSL dipasang (BUTUH-TOBING #11); satu jalur lebih sederhana dan mengurangi dependensi ber-skrip install |
| 2026-11-13 | `.env.example` dibuat generik (tanpa host/email Sky Tech); `SMTP_*` hanya cadangan opsional | Aturan white-label + `PENGATURAN-UI.md` (koneksi diisi lewat UI) |
| 2026-11-13 | ESLint memblokir impor library WhatsApp tidak resmi (Baileys, whatsapp-web.js, venom, wppconnect, open-wa) | Aturan keras `CLAUDE.md` dijaga otomatis, bukan hanya lewat review |
