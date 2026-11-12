# Konteks Operasional Sky Tech

Untuk memahami kebutuhan & membuat data seed/demo yang realistis. **Jangan hardcode** ke
kode produk — semuanya harus bisa diatur.

- Sky Tech: ISP FTTH di Lampung Timur, ±1.200 kontak aktif per bulan di inbox WhatsApp.
- Saat ini memakai **MobiChat** (paket Engage) di nomor CS utama. Balesin akan diuji dulu
  dengan **nomor tes Meta**; nomor CS utama dipindah setelah Balesin stabil.
- Bot **ULAN AI** berjalan di **n8n** (di LAN kantor) sebagai *External Bot* MobiChat,
  memakai Claude. Ia membaca tagihan dari **SKY BILL** (billing.btd.co.id) dan billing
  mitra **BILL SURYA** & **BILL BAYU**, membuat tiket perbaikan, mengganti nama kontak,
  menambah tag, dan handoff ke manusia.
- Penamaan kontak: username MikroTik pelanggan, format `ID+NAMA@AREA`
  (contoh `101PUTU@G2`). Tag mitra: `MITRA-SURYA`, `MITRA-BAYU`.
- Setelah handoff, chat masuk **antrian terbuka** untuk staf kantor mana pun.
- Alarm & log operasional dikirim ke grup **Telegram SKYTECH**.
- Billing mengirim pengingat jatuh tempo otomatis tiap hari jam 07:00 → broadcast tagihan
  di Balesin harus bisa mencegah kirim dobel.
- Gaya balasan CS: ceria, santai, tidak kaku, **singkat dan langsung** (pelanggan kesal
  dengan pesan panjang).
- Biaya Meta (per 1 Okt 2026): 1.000 pesan layanan gratis per nomor per bulan, setelah itu
  berbayar; tarif yang tampil di MobiChat (per 30 Sep 2026) ±Rp363 Utility/Service,
  ±Rp593 Marketing. Kuota gratis Sky Tech habis sekitar tanggal 13 → dashboard biaya &
  pencegahan balasan tidak perlu (mis. membalas "ok/siap kak") sangat penting.
- Peran tim: Owner (Direktur), Admin, Supervisor, CS, **Teknisi** (memakai nomor yang sama
  agar pelanggan tidak bingung nomor resmi).
- Email pengirim sistem: `balesin@skytech.net.id` (email hosting IDCloudHost).
- Deploy: VM Balesin IP privat di Proxmox, dipublikasikan lewat `vm-nginx`
  (198.15.25.13), DNS A record di IDCloudHost (lihat `ARCHITECTURE.md` §5).
