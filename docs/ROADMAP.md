# Roadmap — Balesin

Orkestrator mengerjakan dari atas ke bawah. Tandai `[x]` saat Definition of Done
(`CLAUDE.md`) lolos. Tugas yang terblokir oleh Tobing: tandai `[~]`, catat di
`BUTUH-TOBING.md`, lanjut tugas lain.

## Fase 0 — Fondasi
- [x] Inisialisasi monorepo pnpm (`apps/api`, `apps/web`, `apps/worker`, `packages/shared`), TypeScript strict, ESLint, Prettier
- [x] `deploy/docker-compose.dev.yml` (postgres 16, redis 7) + `.env.example` lengkap
- [x] Fastify dasar: health/ready, logger pino (redaksi rahasia), error handler, Zod
- [x] Drizzle + migrasi awal (organizations, users, sessions, audit_logs)
- [x] Web: Vite + router + design token (`DESIGN.md`) + font self-host + mode gelap + shell layout desktop/HP
- [x] Vitest + Playwright terpasang; skrip screenshot 390px/1440px untuk kritikus
- [x] GitHub Actions: lint, typecheck, test, `pnpm audit`
- [x] Hook Claude Code (`.claude/settings.json`): format + typecheck setelah edit
- [x] Riset: susun `docs/reference/MOBICHAT-FITUR.md` dari screenshot di `docs/reference/mobichat/`
- [x] Riset: masukkan "Usulan tambahan" dari `MOBICHAT-FITUR.md` ke `PRD.md` (catat di `DECISIONS.md`)

## Fase 1 — Akun, peran, keamanan
- [x] Wizard setup pertama (token setup dari env) → Owner + organisasi + branding + SMTP
- [x] Login, logout, sesi, CSRF, rate limit, kunci akun
- [x] 2FA TOTP + kode cadangan; wajib untuk Owner/Admin/Supervisor
- [x] Undangan via email, verifikasi email, reset password (template email bermerek)
- [x] RBAC 5 peran + tes otorisasi per endpoint
- [x] Manajemen pengguna & sesi aktif, audit log
- [x] Review `security` + `kritikus-desain` untuk semua layar auth

## Fase 2 — WhatsApp & Inbox inti
- [x] Wizard koneksi WhatsApp manual (teks dari `SETUP-META.md`), enkripsi kredensial, tes koneksi
- [x] Halaman nomor WhatsApp: quality rating, status, batas pesan, edit profil bisnis dari UI
- [x] Webhook masuk: verifikasi, signature, idempotensi, worker
- [x] Kontak & percakapan otomatis, jendela 24 jam
- [x] Inbox real-time: tab Semua/Bot/Belum dilayani/Dilayani/Selesai, cari, filter (termasuk filter status sesi + hitung mundur)
- [x] Ruang chat: teks, gambar, dokumen, audio/VN, video, lokasi, reaksi, balas-kutip, status centang
- [x] Assign/ambil/alihkan/antrian terbuka, tandai selesai
- [x] Panel detail: info, tag, catatan, media, log
- [x] Quick reply `/`
- [x] Notifikasi + PWA installable
- [x] Tampilan HP penuh (navigasi bawah, layar bertumpuk)
- [x] E2E: pesan masuk (simulasi webhook) → tampil → dibalas → status

## Fase 3 — Bot & API untuk n8n
- [x] Mapping MobiChat untuk bot (`API-MOBICHAT-MAPPING.md` §1–3)
- [x] Mapping pengiriman template dari aplikasi billing (§4)
- [ ] Endpoint mode tangkap `/compat/<vendor>/*` + adaptor vendor Qiscus untuk aplikasi billing (butuh BUTUH-TOBING #10)
- [x] Lapisan kompatibel MobiChat (`/api/public/*` prioritas, `/api/bot/reply*` kedua) + field `mobichat_base_url`/`mobichat_api_key` di webhook + tes kontrak
- [x] Pesan interaktif (tombol/daftar) dari agen dan bot + penerusan balasan tombol ke bot
- [x] Bot eksternal: kirim event, handoff, saklar bot
- [x] API native v1 + API key bertingkat scope + OpenAPI `/api/docs`
- [x] Webhook keluar bertanda tangan + allowlist IP privat + riwayat & kirim ulang

## Fase 4 — Template & Broadcast
- [x] Sinkron & ajukan template Meta
- [x] Broadcast: sumber CSV/Excel/segmen/konektor REST, pemetaan variabel, pratinjau
- [x] Estimasi biaya, persetujuan > ambang, jadwal, throttle, jeda/batal
- [x] Anti-dobel, rem darurat, alarm Telegram
- [x] Laporan kampanye
- [x] Tag percakapan otomatis untuk penerima broadcast
- [x] Preset template industri (ISP dahulu) sebagai draf siap ajukan

## Fase 5 — CRM, tiket, laporan
- [x] Kontak: atribut kustom, impor/ekspor, gabung duplikat
- [x] Tiket/tugas untuk teknisi + akses terbatas peran Teknisi; multi-board, Kanban/Daftar, atribut kustom, API tiket untuk bot
- [x] Departemen + akses "departemen sendiri"
- [x] CSAT otomatis setelah percakapan selesai
- [x] Dashboard laporan (waktu respons pertama/tunggu/resolusi, kinerja agen & bot) + **biaya pesan Meta** (kuota 1.000 layanan gratis/nomor/bulan, perkiraan biaya)
- [x] Jam kerja (tim & bot terpisah), pesan otomatis (termasuk saat di-assign), alokasi agen ambil sendiri/round-robin + kapasitas per agen

## Fase 6 — Channel tambahan
- [x] Telegram Bot
- [x] Email (IMAP/SMTP)
- [x] Facebook Messenger & Instagram DM (siapkan, aktifkan setelah App Review) — siap; aktivasi menunggu BUTUH-TOBING #17

## Fase 7 — Produk self-hosted
- [x] `deploy/docker-compose.yml` produksi, image multi-stage non-root
- [x] `install.sh` (curl | bash), pilihan mode jaringan A/B/C, generate secret
- [x] CLI `balesin` (update dengan backup + migrasi, backup, restore, status, logs)
- [x] `deploy/nginx/balesin.conf` untuk vm-nginx Sky Tech
- [x] White-label lengkap + dokumentasi pengguna (bahasa Indonesia)
- [x] Audit akhir penuh (`/audit`) sebelum rilis 1.0

## Fase 8 — NANTI
- [ ] Meta Tech Provider → Embedded Signup + Coexistence QR
- [ ] Aplikasi Expo (Play Store / App Store)
- [ ] Builder alur visual, AI agent bawaan, Calling API, lisensi

## Fase 9 — Modul Email (kotak surat multi-akun)
Spesifikasi `docs/PRD-EMAIL.md`, desain acuan `docs/design/email/` (mockup + screenshot terang/gelap).
Dikerjakan sebelum Fase 8 (NANTI). Menu **Email** terpisah dari Inbox; Channel Email Fase 6 tetap ada.
- [x] 9.0 Peningkatan Channel Email di Inbox (PRD-EMAIL §4.10): simpan & tampilkan Kepada/Cc/alamat tujuan email masuk; Cc/Bcc + Balas semua di composer channel Email; Cc/Bcc ke alamat baru = memulai percakapan (`inbox.initiate` + jatah harian), maks. 10 alamat tambahan, audit; **akses per channel** (semua jenis channel: "Semua tim" bawaan atau hanya departemen/pengguna tertentu, irisan dengan cakupan peran & departemen) — review `security`
- [x] 9.1 API kirim email untuk n8n/billing (PRD-EMAIL §4.8): `GET /public/email/senders`, `POST /public/email/send` (template Balesin atau HTML luar, variabel, QRIS → gambar inline, lampiran base64/mediaId/URL ber-allowlist, Cc/Bcc, `conversation: create`, `Idempotency-Key`), status + webhook `email.sent/failed/bounced/replied`, Pengaturan → Template email (+ preset ISP, kirim tes), batas per pengirim per jam, key dibatasi ke pengirim tertentu
- [ ] 9A Fondasi: skema `mail_*` + migrasi; izin `mail.*` (DECISIONS + `permissions.test.ts` + review `security`); akun IMAP/SMTP (preset cPanel/IDCloudHost, IMAP lain, deteksi otomatis ber-penjaga SSRF) + wizard 4 langkah + tes koneksi; sinkron folder & header (IMAP IDLE + berkala); menu Email di rail & navigasi bawah HP; daftar + panel baca (HTML tersanitasi di iframe sandbox, gambar luar diblokir + proksi; asal email: akun + alamat tujuan/alias); hak akses per akun (bersama/pribadi) + tab "Akses email" di Pengaturan → Tim; foto/logo per akun & channel
- [ ] 9B Tulis/balas/teruskan (jendela mengambang desktop, layar penuh HP), Kepada/Cc/Bcc + Balas semua + batas penerima, identitas & alias, tanda tangan, template email, draf otomatis ke server, lampiran, batalkan kirim, penanda "sedang membalas" + peringatan email baru di utas
- [ ] 9C Utas, cari + panel Saring, label berwarna, aksi massal & pintasan keyboard, notifikasi real-time + PWA, panel Info pengirim (kontak CRM, chat, tiket, "Buat tiket"), tampilan HP lengkap (laci, geser arsip)
- [ ] 9D Email banyak & kerja tim (PRD-EMAIL §4.7): Prioritas/Lainnya, aturan otomatis (+ uji ke 50 email terakhir), tugaskan + status, catatan internal & @sebut, tunda + pengingat tindak lanjut, balasan otomatis, tampilan tersimpan, blokir & berhenti langganan, bersihkan dari pengirim
- [ ] 9E OAuth Microsoft 365/Outlook (Graph) & Google Workspace (XOAUTH2), POP3, jadwalkan kirim, API + webhook `mail.*` untuk akun Email, bot eksternal per akun (draf saja / kirim otomatis di luar jam kerja + pagar pengaman PRD-EMAIL §4.11), asisten foto pengirim (BIMI, §4.12)
- [ ] NANTI: SLA belum dibalas di Laporan, AI agent bawaan untuk email & ringkasan/saran balasan (Fase 8), penyatuan akun Email dengan Inbox CS
