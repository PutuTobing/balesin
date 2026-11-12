# Roadmap — Balesin

Orkestrator mengerjakan dari atas ke bawah. Tandai `[x]` saat Definition of Done
(`CLAUDE.md`) lolos. Tugas yang terblokir oleh Tobing: tandai `[~]`, catat di
`BUTUH-TOBING.md`, lanjut tugas lain.

## Fase 0 — Fondasi
- [ ] Inisialisasi monorepo pnpm (`apps/api`, `apps/web`, `apps/worker`, `packages/shared`), TypeScript strict, ESLint, Prettier
- [ ] `deploy/docker-compose.dev.yml` (postgres 16, redis 7) + `.env.example` lengkap
- [ ] Fastify dasar: health/ready, logger pino (redaksi rahasia), error handler, Zod
- [ ] Drizzle + migrasi awal (organizations, users, sessions, audit_logs)
- [ ] Web: Vite + router + design token (`DESIGN.md`) + font self-host + mode gelap + shell layout desktop/HP
- [ ] Vitest + Playwright terpasang; skrip screenshot 390px/1440px untuk kritikus
- [ ] GitHub Actions: lint, typecheck, test, `pnpm audit`
- [ ] Hook Claude Code (`.claude/settings.json`): format + typecheck setelah edit
- [x] Riset: susun `docs/reference/MOBICHAT-FITUR.md` dari screenshot di `docs/reference/mobichat/`
- [x] Riset: masukkan "Usulan tambahan" dari `MOBICHAT-FITUR.md` ke `PRD.md` (catat di `DECISIONS.md`)

## Fase 1 — Akun, peran, keamanan
- [ ] Wizard setup pertama (token setup dari env) → Owner + organisasi + branding + SMTP
- [ ] Login, logout, sesi, CSRF, rate limit, kunci akun
- [ ] 2FA TOTP + kode cadangan; wajib untuk Owner/Admin/Supervisor
- [ ] Undangan via email, verifikasi email, reset password (template email bermerek)
- [ ] RBAC 5 peran + tes otorisasi per endpoint
- [ ] Manajemen pengguna & sesi aktif, audit log
- [ ] Review `security` + `kritikus-desain` untuk semua layar auth

## Fase 2 — WhatsApp & Inbox inti
- [ ] Wizard koneksi WhatsApp manual (teks dari `SETUP-META.md`), enkripsi kredensial, tes koneksi
- [ ] Halaman nomor WhatsApp: quality rating, status, batas pesan, edit profil bisnis dari UI
- [ ] Webhook masuk: verifikasi, signature, idempotensi, worker
- [ ] Kontak & percakapan otomatis, jendela 24 jam
- [ ] Inbox real-time: tab Semua/Bot/Belum dilayani/Dilayani/Selesai, cari, filter (termasuk filter status sesi + hitung mundur)
- [ ] Ruang chat: teks, gambar, dokumen, audio/VN, video, lokasi, reaksi, balas-kutip, status centang
- [ ] Assign/ambil/alihkan/antrian terbuka, tandai selesai
- [ ] Panel detail: info, tag, catatan, media, log
- [ ] Quick reply `/`
- [ ] Notifikasi + PWA installable
- [ ] Tampilan HP penuh (navigasi bawah, layar bertumpuk)
- [ ] E2E: pesan masuk (simulasi webhook) → tampil → dibalas → status

## Fase 3 — Bot & API untuk n8n
- [x] Mapping MobiChat untuk bot (`API-MOBICHAT-MAPPING.md` §1–3)
- [x] Mapping pengiriman template dari aplikasi billing (§4)
- [ ] Endpoint mode tangkap `/compat/<vendor>/*` + adaptor vendor Qiscus untuk aplikasi billing (butuh BUTUH-TOBING #10)
- [ ] Lapisan kompatibel MobiChat (`/api/public/*` prioritas, `/api/bot/reply*` kedua) + field `mobichat_base_url`/`mobichat_api_key` di webhook + tes kontrak
- [ ] Pesan interaktif (tombol/daftar) dari agen dan bot + penerusan balasan tombol ke bot
- [ ] Bot eksternal: kirim event, handoff, saklar bot
- [ ] API native v1 + API key bertingkat scope + OpenAPI `/api/docs`
- [ ] Webhook keluar bertanda tangan + allowlist IP privat + riwayat & kirim ulang

## Fase 4 — Template & Broadcast
- [ ] Sinkron & ajukan template Meta
- [ ] Broadcast: sumber CSV/Excel/segmen/konektor REST, pemetaan variabel, pratinjau
- [ ] Estimasi biaya, persetujuan > ambang, jadwal, throttle, jeda/batal
- [ ] Anti-dobel, rem darurat, alarm Telegram
- [ ] Laporan kampanye
- [ ] Tag percakapan otomatis untuk penerima broadcast
- [ ] Preset template industri (ISP dahulu) sebagai draf siap ajukan

## Fase 5 — CRM, tiket, laporan
- [ ] Kontak: atribut kustom, impor/ekspor, gabung duplikat
- [ ] Tiket/tugas untuk teknisi + akses terbatas peran Teknisi; multi-board, Kanban/Daftar, atribut kustom, API tiket untuk bot
- [ ] Departemen + akses "departemen sendiri"
- [ ] CSAT otomatis setelah percakapan selesai
- [ ] Dashboard laporan (waktu respons pertama/tunggu/resolusi, kinerja agen & bot) + **biaya pesan Meta** (kuota 1.000 layanan gratis/nomor/bulan, perkiraan biaya)
- [ ] Jam kerja (tim & bot terpisah), pesan otomatis (termasuk saat di-assign), alokasi agen ambil sendiri/round-robin + kapasitas per agen

## Fase 6 — Channel tambahan
- [ ] Telegram Bot
- [ ] Email (IMAP/SMTP)
- [ ] Facebook Messenger & Instagram DM (siapkan, aktifkan setelah App Review)

## Fase 7 — Produk self-hosted
- [ ] `deploy/docker-compose.yml` produksi, image multi-stage non-root
- [ ] `install.sh` (curl | bash), pilihan mode jaringan A/B/C, generate secret
- [ ] CLI `balesin` (update dengan backup + migrasi, backup, restore, status, logs)
- [ ] `deploy/nginx/balesin.conf` untuk vm-nginx Sky Tech
- [ ] White-label lengkap + dokumentasi pengguna (bahasa Indonesia)
- [ ] Audit akhir penuh (`/audit`) sebelum rilis 1.0

## Fase 8 — NANTI
- [ ] Meta Tech Provider → Embedded Signup + Coexistence QR
- [ ] Aplikasi Expo (Play Store / App Store)
- [ ] Builder alur visual, AI agent bawaan, Calling API, lisensi
