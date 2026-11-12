# Fitur MobiChat — Hasil Penelusuran

Ditelusuri 13 Nov 2026 (read-only) dari akun Sky Tech, paket **Engage** (Rp1.500.000/bulan,
5 agen, 5 channel). Screenshot ada di folder `mobichat/` (data pelanggan & API key
diburamkan). Tujuan: memahami **alur yang sudah biasa dipakai tim**, bukan menyalin desain.

## Navigasi
Rail kiri ikon + submenu: **Omnichannel** (Inbox, Integration) · **CRM** (Task, Contacts,
Customers) · **Marketing** (Templates, Broadcast, Campaigns, Integration) · **AI Agent**
(Chatbot, Builder, Knowledge, Files, Tools) · **Flow** (WhatsApp Flow, Flow) · **Billing**
(Credit Balance, Usage Report, Top Up History) · **Reports** · bawah: Search, Notifikasi,
Help, Settings, Profil (bahasa, logout).
Tampilan HP (`01`): navigasi bawah **Inbox · Task · Broadcast · Flow · Chatbot · More**.

## 1. Inbox (`01`–`03`)
- Tab: **All · Bot · Unserved · Served · Resolved**; badge jumlah belum dibaca per kontak.
- Item list: avatar/inisial, nama kontak, cuplikan pesan terakhir (ikon 📢 untuk broadcast,
  ✓✓ untuk terkirim), label channel, label status (Bot/Unserved/Served/Resolved), ikon sesi,
  garis warna di kiri item.
- **Filter**: urut Latest Message / Date Received, Newest/Oldest (hanya di Unserved &
  Served); Conversation type (Without Code, Code Testing); Read status (Read/Unread);
  **Session status (Broadcast, Open, Expiring, Expired)**; Contact status (Blocked);
  Ads (From Ads); Agents (Not Assigned); Tags; Departments.
- Header chat: nama kontak (bisa diedit ✏️), nomor, **Mark as Resolved/Unresolved**,
  Search dalam chat, tombol telepon, Details.
- Bar status: "Bot / Expiring at <tanggal> (sisa jam:menit)" atau "Resolved / Expired at",
  plus channel/nomor penerima.
- Pesan sistem di timeline: "Agent X has been assigned", "status changed to resolved by X",
  "All assignments and participants have been removed".
- Label pengirim di atas bubble (nama agen / "ULAN AI (n8n)" / "Broadcast Message"),
  kutip-balas, tombol CTA dari template (mis. "CEK STATUS PEMBAYARAN"), preview gambar,
  "Show less" untuk pesan panjang, "Load previous messages".
- Aksi hover pesan: bookmark, balas, teruskan.
- Composer: Emoji, Attach, **Template**, Contact, Location, Send; batas 4000 karakter.
- Panel Details: tab **Info · Task · Log**; ID kontak (copy), nomor; **Main Agent**
  (cari + "Assign to Me"); Participants; **Tags** (cari/buat); SLA; Audience integrations
  (Meta Conversion API, Google Ads, TikTok Events); **Session Notes**; Media & Files;
  Bookmarked Messages.

## 2. CRM
- **Task** (`04`,`05`): beberapa board/proyek (dropdown, mis. "CATATAN"), Export, cari
  tiket, filter status & agen; tampilan **Summary · Kanban · List · Calendar · Settings**;
  status (kolom) bisa ditambah. Form task: Title*, Description (rich text + tabel/gambar/
  lampiran), Task Relations, Assign To, Status*, Priority, Due Date, **Customer**,
  **Conversation Link**.
- **Contacts** (`06`): ±3.970 kontak; Merge, Export CSV, **Custom Fields**, Add Contact(s);
  filter Active, Type, Channel, Tag, Department; kolom nama, info kontak (channel + nomor +
  ID), "Go to Conversation", status, tag, departemen.
- **Customers** (`07`): entitas perusahaan (nama, alias, tipe, website, sales person, notes)
  — tidak dipakai Sky Tech.

## 3. Marketing
- **Templates** (`08`,`09`): 22 template disetujui (hampir semua Utility, 1 Marketing),
  Sync Templates dari Meta, tampilan tabel/kanban, filter channel/kategori/status.
  Buat template: dari kosong **atau dari template industri** (ISP, klinik, sekolah).
  Field: channel, nama (huruf kecil + underscore), kategori, bahasa, broadcast type
  (Default / Media carousel / Call Permission), parameter **Positional atau Named**,
  header (Text/Image/Video/Document/Location), body (≤1020), footer (≤60), tombol (≤3),
  **preview gaya WhatsApp**, tombol **"AI Review Template"**.
- **Broadcast** (`10`): pilih channel → template → **conversation tag opsional** (ditempel
  ke tiap percakapan penerima) → penerima via **download template Excel, isi, upload** →
  kirim sekarang/jadwalkan. Panel "Recent Broadcasts" (penerima, terkirim, gagal, waktu).
  Catatan: konfirmasi pembayaran dari billing muncul sebagai broadcast 1 penerima
  (`pembayaran_berhasil_office`, `payment_gateway_all`, dst.) — **±60 ribu baris** di
  usage report.
- **Campaigns** (`11`): daftar kampanye (template, channel, tag, penerima, delivered,
  status), tabel/kanban.
- **Integration** (`12`): Meta Ads, TikTok Ads, Google Ads (belum dipakai).

## 4. AI Agent
- **Chatbot** (`13`): 5 bot. Tipe: AI Agent, Workflow, **External**, Custom. Kolom channel,
  status, saklar **Assignment** (bot aktif menerima chat). Aktif sekarang: **ULAN AI (n8n)**
  (External) dan auth-skybase (External).
- **Detail bot External** (`14`): nama, deskripsi, **Webhook URL** (ke n8n), **API Key**
  (copy/show/regenerate), channel aktif, riwayat perubahan, tombol Test on Channel,
  Deactivate.
- Builder (alur statis, kosong), **Knowledge** (8 sumber teks/file), Files, **Tools**
  (Tag management, Task management, Broadcast, Document PDF, MCP Client, dll.).

## 5. Flow
WhatsApp Flow (sinkron dari Meta, kosong) dan Flow (form web multi-halaman, kosong).

## 6. Billing (`21`,`22`)
Kartu: paket, **Free WhatsApp Service Messages 1.000/1.000 per nomor per bulan**,
AI Responses, **saldo WhatsApp** + threshold + top-up, Monthly Active User, Agents 1/5,
Channels 1/5. Estimasi kuota per kategori dengan tarif (per 30 Sep 2026): Marketing
Rp593, Utility/Authentication/Service Rp363, Auth internasional Rp1.948, panggilan
Rp380/menit. **Usage Report**: per pengiriman (tanggal, template, kategori, status,
biaya), filter, Export CSV.

## 7. Reports (`23`)
Tab: Dashboard, **Conversation**, **Agent Performance**, **Bot Performance**, Broadcast,
Call, Package Usage, Billing, Survey, ROAS, Ads, Conversion, Template Usage. Conversation
report: total percakapan/sesi/resolved/ongoing, jumlah agen, **rata-rata first response
time**, Monthly Active Customer, tren harian & per jam, ruang per tag, daftar percakapan
(first response, response, waiting, resolution time, jumlah chat) + Export CSV.

## 8. Settings
- **Omnichannel** (`24`): Auto Responder (jam kerja vs di luar jam kerja, libur), pesan saat
  di-assign ke manusia / ke bot, **jam kerja bot**; tab Call Settings, Conversation Resolved.
- **Conversation Templates** (`25`): quick reply (kosong).
- Survey: **CSAT** "Survei Kepuasan Pelanggan CS" aktif.
- **Automations** (`26`): rule-based & time-based (kosong).
- Chatbot: batas karakter instruksi, file, knowledge.
- CRM: target revenue per user.
- **Role & Access** (`27`): departemen, akses departemen (semua / milik sendiri), role,
  izin panggilan masuk/keluar, **channel limit per user**, default tags, access template.
  Semua 7 user Sky Tech saat ini berperan **Admin** (termasuk akun "User Billing").
- Organization: zona waktu, jam kerja per hari, hari libur.
- **Agent Allocation**: "Pick by Agent", kapasitas maksimal percakapan per agen,
  kecualikan agen dari daftar ambil.

## 9. Integrasi channel (`28`)
WhatsApp Business (Validated), Instagram, Facebook (OAuth atau Page Access Token manual),
TikTok, Web Widget, Mobile Widget, Gmail, **Outlook (Validated)**, Threads, Google Play
Reviews, Google Business Reviews, Telegram Bot, Telegram personal; X/App Store/YouTube/
LinkedIn segera. Detail WhatsApp: nomor, tipe API (Cloud API), **quality rating**, status,
username WhatsApp, profil bisnis (kategori, alamat, website, email), Validate Connection.

---

## Usulan tambahan untuk PRD Balesin (dari temuan)

Status: **sudah diproses 13 Nov 2026** (rincian di `DECISIONS.md`). Semua butir diterima ke PRD;
butir 4 dan 7 diterima sebagian (lihat tanda per butir).
1. **Pesan interaktif** (tombol ≤3, list ≤10) dari agen & bot — ULAN bisa memakainya. **[DITERIMA: PRD 3.3, PENTING]**
2. Filter inbox **status sesi** (Open/Expiring/Expired/Broadcast) + hitung mundur. **[DITERIMA: PRD 3.3, WAJIB]**
3. Pesan otomatis saat di-assign ke manusia/bot; **jam kerja bot** terpisah. **[DITERIMA: PRD 3.4, PENTING]**
4. **Departemen** + akses "departemen sendiri" (mis. Teknisi hanya lihat tiket/percakapan
   departemen Teknisi) + batas channel per user + tag default per user. **[DITERIMA: PRD 3.6/3.8, PENTING; batas channel & tag default per user ditunda NANTI]**
5. Alokasi agen: ambil sendiri / round-robin + **kapasitas per agen**. **[DITERIMA: PRD 3.8, PENTING]**
6. **CSAT** setelah percakapan selesai. **[DITERIMA: PRD 3.3, PENTING]**
7. Task: beberapa board, tampilan Kanban/List/Calendar/Summary, custom fields, tautan ke
   kontak & percakapan, **API task** untuk bot. **[DITERIMA: PRD 3.6, PENTING; Kalender & Ringkasan NANTI]**
8. Template: parameter bernama, preset template industri **ISP** (tagihan, isolir,
   pembayaran berhasil, tiket perbaikan, gangguan massal) — keunggulan jual Balesin. **[DITERIMA: PRD 3.5, PENTING]**
9. Broadcast: tag percakapan otomatis untuk penerima. **[DITERIMA: PRD 3.5, PENTING]**
10. Halaman nomor WhatsApp: **quality rating**, status, edit profil bisnis. **[DITERIMA: PRD 3.2, PENTING]**
11. Laporan: first response time, waktu tunggu, waktu resolusi, kinerja agen & bot. **[DITERIMA: PRD 3.7, PENTING]**
12. **API untuk aplikasi billing** mengirim template ke nomor pelanggan (lihat
    `API-MOBICHAT-MAPPING.md` §3) — saat ini ini sumber pengiriman terbanyak Sky Tech. **[DITERIMA: PRD 3.4, WAJIB]**

Tidak perlu ditiru: integrasi iklan (Meta/TikTok/Google Ads), Customers B2B, target
revenue, Threads/Google Reviews.
