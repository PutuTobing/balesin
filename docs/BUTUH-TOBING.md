# Butuh Tobing

Hal yang tidak bisa dikerjakan agent sendiri. Tandai ✅ setelah selesai.

| # | Kebutuhan | Untuk | Status |
|---|---|---|---|
| 1 | Ekspor workflow n8n ULAN (Workflow → ⋯ → Download) simpan ke `docs/reference/n8n/ulan-workflow.json` | Mapping API MobiChat (Fase 3) | ✅ 13 Nov (token ulan-media dihapus dari salinan repo) |
| 2 | Screenshot semua menu MobiChat (Inbox, CRM, Marketing, AI Agent, Flow, Billing, Reports, Settings, Integrasi, pengaturan External Bot) ke `docs/reference/mobichat/` — **sensor/blur nomor & nama pelanggan** | Riset fitur (Fase 0) | ✅ 13 Nov (dikerjakan Claude) |
| 3 | Aplikasi Meta + nomor tes: Phone Number ID, WABA ID, token System User, App Secret (dimasukkan lewat wizard, **bukan** ke repo) | Fase 2 | ⏳ |
| 4 | Email `balesin@skytech.net.id` + detail SMTP (host, port, user) — password dimasukkan lewat wizard/`.env` lokal | Fase 1 | ⏳ |
| 5 | Gambar dari ChatGPT (`BRANDING-PROMPTS.md`) simpan ke `assets/brand/` | Desain | 🟡 Logo, ikon aplikasi, lembar karakter, ilustrasi login sudah terpasang (13 Nov). **Masih perlu** 9 pose satuan Prompt 2, latar transparan, pakai `kak-sky-sheet.png` sebagai acuan karakter: `kak-sky-wave`, `kak-sky-inbox-empty`, `kak-sky-sleep`, `kak-sky-success`, `kak-sky-search`, `kak-sky-fix`, `kak-sky-broadcast`, `kak-sky-shield`, `kak-sky-team` (.png). Prioritas: `wave` dan `inbox-empty` |
| 6 | Buat VM Balesin (Ubuntu 24.04, 4 vCPU, 8 GB RAM, 80 GB) IP privat | Fase 7 | ⏳ |
| 7 | DNS IDCloudHost: A record `balesin` → 198.15.25.13 | Fase 7 | ⏳ |
| 8 | Telegram bot token + chat ID grup SKYTECH untuk alarm | Fase 4 | ⏳ |
| 9 | Cek di pengaturan SKY BILL / BILL SURYA / BILL BAYU: bagaimana mereka terhubung ke MobiChat (URL API, API key/akun "User Billing") dan apakah URL-nya bisa diganti | Migrasi pengiriman template billing ke Balesin (`API-MOBICHAT-MAPPING.md` §4) | ✅ 13 Nov (ditelusuri Claude) |
| 10 | Saat Fase 3: izinkan gateway cadangan "WA BUSINES" (ID 2) di SKY BILL diubah ke vendor Qiscus + domain Balesin staging untuk tes tangkap format | Adaptor billing → Balesin | ⏳ |
| 11 | Pasang WSL supaya Docker Desktop bisa menyala di PC pengembangan (`wsl --install` sebagai Administrator, lalu restart) | Lingkungan dev lokal (Fase 0) | ✅ 13 Nov (WSL terpasang, Docker Desktop jalan) |
| 12 | Buka tab **Actions** di GitHub untuk branch `dev` dan pastikan run CI pertama hijau (kabari Claude bila ada job merah). Opsional: aktifkan branch protection `main` dengan check wajib `kualitas`, `tes`, `audit`, `e2e` | CI (Fase 0) — Claude tidak punya akses melihat hasil run | ✅ 13 Nov (run CI #1 hijau di commit 767b1e4) |
| 13 | **Ilustrasi login perlu dibuat ulang** (`login-hero.png` & `login-hero-dark.png`): (a) memuat Menara Siger (Lampung) dan tiang listrik + kotak distribusi + sawah yang bernuansa ISP, padahal Balesin dijual white-label ke berbagai usaha; (b) pose Kak Sky di versi terang dan gelap berbeda. Mohon buat ulang dengan Prompt 5/6 ditambah: "no specific landmark or monument, no utility poles or network equipment, same Kak Sky pose in both versions". Sampai ada gantinya, gambar sekarang tetap dipakai. | Branding (Fase 1, layar login) | ✅ 14 Nov (gambar baru: tanpa landmark/tiang, pose sama di terang & gelap) |
