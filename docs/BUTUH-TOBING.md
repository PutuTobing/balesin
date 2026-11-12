# Butuh Tobing

Hal yang tidak bisa dikerjakan agent sendiri. Tandai ✅ setelah selesai.

| # | Kebutuhan | Untuk | Status |
|---|---|---|---|
| 1 | Ekspor workflow n8n ULAN (Workflow → ⋯ → Download) simpan ke `docs/reference/n8n/ulan-workflow.json` | Mapping API MobiChat (Fase 3) | ✅ 13 Nov (token ulan-media dihapus dari salinan repo) |
| 2 | Screenshot semua menu MobiChat (Inbox, CRM, Marketing, AI Agent, Flow, Billing, Reports, Settings, Integrasi, pengaturan External Bot) ke `docs/reference/mobichat/` — **sensor/blur nomor & nama pelanggan** | Riset fitur (Fase 0) | ✅ 13 Nov (dikerjakan Claude) |
| 3 | Aplikasi Meta + nomor tes: Phone Number ID, WABA ID, token System User, App Secret (dimasukkan lewat wizard, **bukan** ke repo) | Fase 2 | ⏳ |
| 4 | Email `balesin@skytech.net.id` + detail SMTP (host, port, user) — password dimasukkan lewat wizard/`.env` lokal | Fase 1 | ⏳ |
| 5 | Gambar dari ChatGPT (`BRANDING-PROMPTS.md`) simpan ke `assets/brand/` | Desain | ⏳ |
| 6 | Buat VM Balesin (Ubuntu 24.04, 4 vCPU, 8 GB RAM, 80 GB) IP privat | Fase 7 | ⏳ |
| 7 | DNS IDCloudHost: A record `balesin` → 198.15.25.13 | Fase 7 | ⏳ |
| 8 | Telegram bot token + chat ID grup SKYTECH untuk alarm | Fase 4 | ⏳ |
| 9 | Cek di pengaturan SKY BILL / BILL SURYA / BILL BAYU: bagaimana mereka terhubung ke MobiChat (URL API, API key/akun "User Billing") dan apakah URL-nya bisa diganti | Migrasi pengiriman template billing ke Balesin (`API-MOBICHAT-MAPPING.md` §4) | ✅ 13 Nov (ditelusuri Claude) |
| 10 | Saat Fase 3: izinkan gateway cadangan "WA BUSINES" (ID 2) di SKY BILL diubah ke vendor Qiscus + domain Balesin staging untuk tes tangkap format | Adaptor billing → Balesin | ⏳ |
| 11 | Pasang WSL supaya Docker Desktop bisa menyala di PC pengembangan (`wsl --install` sebagai Administrator, lalu restart) | Lingkungan dev lokal (Fase 0) | ✅ 13 Nov (WSL terpasang, Docker Desktop jalan) |
