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
