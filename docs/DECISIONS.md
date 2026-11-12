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
