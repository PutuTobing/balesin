# Mapping API MobiChat → Balesin

Status: §1–2 dari dokumentasi resmi MobiChat (`app.mobichat.id/api-documentation`), §3 dari
ekspor workflow n8n ULAN — **lengkap untuk bot**. §4 (aplikasi billing) menunggu pengecekan
(`BUTUH-TOBING.md` #9). Dibaca 13 Nov 2026.

## 1. Bot API versi lama (dokumentasi publik) — dukung juga, prioritas kedua

Base URL MobiChat: `https://app.mobichat.id`. Auth: header `X-API-Key: <api key bot>`.
Balesin menyediakan path & body **identik** di bawah base URL Balesin
(`https://balesin.skytech.net.id`), API key dibuat di halaman bot eksternal Balesin.

| Aksi | Method & path | Body | Padanan Balesin |
|---|---|---|---|
| Balas teks | `POST /api/bot/reply` | `conversation_id` (string/int), `message_text`, `message_type`=`text` | kirim pesan teks ke percakapan |
| Tombol (≤3) | `POST /api/bot/reply` | `message_type`=`button`, `list_options[]` {id,title} | pesan interaktif button |
| List (≤10) | `POST /api/bot/reply` | `message_type`=`list`, `list_title`, `list_options[]` {id,title,description?} | pesan interaktif list |
| WhatsApp Flow | `POST /api/bot/reply` | `message_type`=`flow`, `flow_name`, `flow_button_title?` | NANTI (fase builder) |
| Media | `POST /api/bot/reply/media` | `conversation_id`, `media_url`, `media_type` (`image`/`document`), `caption?`, `file_name?` | unduh media dari URL → kirim |

Respons sukses (wajib sama bentuknya):
```json
{ "success": true, "message_id": 123, "conversation_id": 456,
  "result": { "success": true, "data": { "messaging_product": "whatsapp",
    "contacts": [{ "input": "62...", "wa_id": "62..." }],
    "messages": [{ "id": "wamid.xxx" }] } },
  "status": "sent" }
```
Error: `{ "error": "Invalid API key" }` dengan HTTP 400 (parameter/percakapan tidak
ditemukan), 401 (API key), 404 (media URL tidak bisa diakses), 500.
Flow: `{ "success": true, "message": "Message sent successfully" }`.

## 2. Task API (bot membuat/mengubah tiket)
Auth: header `X-Task-Key` (key terpisah per organisasi).
- `GET /api/tasks/public?projectCode=&page=&limit=&status=&priority=&assignee=&search=&taskNumbers=&createdAt=&dueDate=&additionalFields_<key>=`
  (rentang tanggal = JSON di-stringify lalu URL-encode) → `{ tasks:[{taskNumber,title,status,priority,createdAt,assignee:{fullName,email},subTask,superTask}], pagination:{page,limit,total} }`
- `POST /api/tasks/public` — wajib `projectCode`, `title`; opsional `description,status,priority,assignee(email),dueDate (UTC+7),subTaskNumbers,superTaskNumbers,additionalFields`.
- `PUT /api/tasks/public` — wajib `taskNumber`; field lain opsional (`assignee: ""` untuk lepas).

## 3. API yang benar-benar dipakai workflow ULAN ✅

Sumber: `reference/n8n/ulan-workflow.json` ("SKY CS AI - MobiChat (Claude)", 116 node,
dibaca 13 Nov 2026). Sejak 29 Okt 2026, atas arahan tim MobiChat, ULAN **tidak lagi
memakai `/api/bot/reply`** — semua lewat `/api/public/*`. **Inilah prioritas lapisan
kompatibel Balesin.**

Auth semua endpoint: header `X-API-Key: <api key bot>` (sebagian kode juga mengirim
`x-api-key` huruf kecil — header tidak peka huruf besar). Base URL & API key **dikirim
MobiChat di dalam body webhook** (`mobichat_base_url`, `mobichat_api_key`), lalu dipakai
ulang oleh node Code. Balesin wajib menyertakan kedua field itu di webhook (isi dengan
URL Balesin & API key bot) supaya workflow tidak perlu diubah sama sekali.

### 3.1 Webhook masuk (Balesin → n8n)
`POST <Webhook URL bot>` — node "Ambil data pesan" membaca secara fleksibel. Kirim
bentuk ini (semua field top-level, plus objek bersarang untuk cadangan):

```json
{
  "conversation_id": 791262,
  "message_id": 123456,
  "message_text": "Siap kak",
  "message_type": "text",
  "sender": "user",
  "contact": { "full_name": "1500040SUWANTO@KWSN", "name": "...", "phone": "62...", "edited_name": "..." },
  "message": { "id": 123456, "type": "user", "text": "Siap kak", "sender": "user", "attachments": [] },
  "mobichat_base_url": "https://balesin.skytech.net.id",
  "mobichat_api_key": "<api key bot>"
}
```
Pesan dengan `type`/`sender` = `agent`, `api-bot`, `bot`, `broadcast`, `system`,
`bot_webhook` diabaikan bot → Balesin boleh tetap mengirimnya, tapi lebih hemat hanya
mengirim pesan pelanggan.

### 3.2 Endpoint yang dipanggil n8n

| Aksi | Method & path | Request | Respons yang dibaca n8n |
|---|---|---|---|
| Riwayat chat | `GET /api/public/messages?conversation_id=<id>&limit=10..30` | – | array pesan, **atau** `{messages:[...]}` / `{data:[...]}` / `{data:{messages:[...]}}`. Field per pesan: `id`, `type` (`user`/`agent`/`api-bot`/`bot`/`broadcast`/`system`/`note`), `sender`, `sender_name`, `text`, `message_text`, `created_at`, `attachments`, `file_attachments`, `index` |
| Kirim teks | `POST /api/public/messages` | `{ "conversation_id": 123, "messages": [{ "message_type": "text", "text": "..." }] }` | status 2xx |
| Kirim gambar/media | `POST /api/public/messages` | `{ "conversation_id": 123, "messages": [{ "message_type": "media", "media_type": "image", "media_url": "https://...", "text": "caption", "caption": "caption" }] }` | status 2xx |
| Status percakapan | `GET /api/public/conversation-status?conversationId=<id>` | – | `status`, `assignments[]` dengan `user.{role,name,email}` (role `chatbot` = bot) |
| Handoff (cara lama) | `POST /api/public/conversation-status` | `{ "conversation_id": 123, "status": "unserved" }` | 2xx |
| Lepas agen/bot | `POST /api/public/unassign-agent` | `{ "conversation_id": 123, "agent_id"?: n }` (MobiChat kini mewajibkan `agent_id`) | 2xx |
| Assign agen | `POST /api/public/agents` | `{ "conversation_id": 123, "agent_id": n }` | 2xx |
| Catatan internal | `POST /api/public/conversation/notes` | `{ "conversationId": 123, "notes": "..." }` | 2xx |
| Ganti nama kontak | `PUT /api/public/contacts` | `{ "conversation_id": 123, "full_name": "...", "edited_name": "..." }` | 2xx |
| Tambah tag kontak | `PUT /api/public/tags/whatsapp` | `{ "whatsapp_number": "62...", "tags": ["MITRA-SURYA"] }` (tag lama tidak dihapus) | 2xx, `success`/`status` tidak `false`; error di `message`/`error` |

Aturan Balesin untuk lapisan ini:
- Handoff: `unassign-agent` **tanpa** `agent_id` harus diterima (melepas bot → masuk
  antrean "Belum dilayani"). Ini memperbaiki masalah yang sekarang terjadi di MobiChat.
- `conversation_id` boleh angka atau string.
- Respons error berbentuk `{ "success": false, "message": "..." }` + kode HTTP yang tepat.
- Semua aksi tercatat di audit log dengan aktor = bot.

### 3.3 Ketergantungan lain di workflow (bukan MobiChat)
Claude API, SKY BILL & billing mitra (`/api/v1/auth/login`, dst.), TriPay, OLT HIOSO /
EPON / C-DATA, SmartOLT, Panel ACS, layanan `ulan-media` (172.16.31.24:8091), Google
Sheets "CATATAN STRUK", Telegram. Tidak perlu diubah saat pindah ke Balesin.
Tautan "https://app.mobichat.id/inbox?id=<cid>" di laporan Telegram nanti diganti ke
`https://balesin.skytech.net.id/inbox/<cid>` — Balesin wajib mendukung URL langsung ke
percakapan dengan ID yang sama (`conversation_id` numerik).

### 3.4 Langkah migrasi ULAN (nanti)
1. Buat bot eksternal di Balesin → isi Webhook URL n8n yang sama → salin API key.
2. Di n8n: ganti credential header auth (X-API-Key) & URL `app.mobichat.id` →
   `balesin.skytech.net.id` di node HTTP Request (11 node) — node Code membaca URL dari
   webhook, jadi otomatis ikut.
3. Uji dengan nomor tes Meta sebelum nomor CS utama dipindah.

## 4. Pengiriman template dari aplikasi billing ✅ (ditelusuri 13 Nov 2026)

Aplikasi billing (SKY BILL, berbasis MyWifi) → menu **Integration → Whatsapp**.
Ada 2 gateway: **"Billing BTD" (ID 1, vendor Mobichats, Aktif, 19 area)** dan
"WA BUSINES" (ID 2, vendor WeaGate, Non Aktif, 0 area). Gateway paling atas wajib aktif.

### 4.1 Cara billing terhubung ke MobiChat sekarang
- Vendor **Mobichats (Official)**: diisi **email + password akun MobiChat** (user
  "User Billing"/helpdesk) → billing login sendiri dan menyimpan **token Bearer** otomatis
  ("Update Token"), plus **Channel ID** = nomor WA pengirim. **Alamat API MobiChat tidak bisa
  diubah** (tidak ada kolom domain untuk vendor ini).
- Antrean: mode Tetap, 10 pesan per eksekusi, tiap 1 menit, jam kirim 07:00–21:00,
  "tunggu respon vendor". Webhook balik: `https://billing.btd.co.id/whatsapp/webhook`.
- Otomatisasi aktif: kirim saat tagihan dibuat, pembayaran diterima, checkout, jatuh tempo,
  pengingat 5 hari sebelum jatuh tempo, tiket (ke teknisi & grup), update/selesai tiket,
  isolir, ulang tahun.
- **Menu "Kelola Template WA"**: tiap kejadian dipetakan ke **nama template Meta** + urutan
  placeholder `{{1}}..{{n}}` berisi variabel billing; tombol URL juga diberi variabel.

| Kejadian billing | Template | Placeholder (urut) | Tombol URL |
|---|---|---|---|
| Kirim tagihan / pengingat | `pesan_reminder_tagihan_office` | name, duedate, period, name, invoice, noservices, nominal | invoice |
| Pembayaran diterima | `pembayaran_berhasil_office` | name, name, invoice, noservices, duedate, period, nominal | invoice |
| Info jatuh tempo | `tagihan_jatuh_tempo_office` | name, period, name, invoice, noservices, duedate, nominal | invoice |
| Pelanggan baru | `pelanggan_baru_all` | name, name, address, noservices, email, duedate | – |
| Checkout payment gateway | `payment_gateway_all` | payment_url | – |
| Tiket ke teknisi | `tiket_perbaikan_teknisi_all` | noticket, name, phone, address, topic, report, remark, maps | – |
| Tiket diambil / diupdate | `update_tiket_ketika_tiket_diambil_all` | name, noticket, action, noservices, nametechnician, dateestimation, urlticket, remark | – |
| Isolir | `pesan_isolir_office` | name, invoice, noservices, duedate, nominal | invoice |
| Tiket selesai | `tiket_perbaikan_selesai_all` | name, name, noservices, topic, report, urlticket | – |
| Ulang tahun | `ucapan_ulang_tahun` | name | – |
(Reset password & OTP belum diberi template.)

### 4.2 Jalur migrasi ke Balesin
Vendor lain di billing yang **resmi dan alamat API-nya bisa diganti** (kolom `domain_api`):
**Qiscus** (field: Qiscus App ID, Qiscus Secret Key, Qiscus Channel ID, domain),
**Bablast** (API key, mode OFFICIAL/UNOFFICIAL, domain), **WATZAP** (API key, number key,
mode, domain), **Ashento** (token, domain). Rencana:

1. **Fase 3 – mode tangkap**: Balesin staging menyediakan endpoint `/compat/<vendor>/*` yang
   mencatat request mentah (header + body, rahasia disamarkan) tanpa mengirim apa pun.
2. Di billing, **pakai gateway cadangan "WA BUSINES" (ID 2, 0 area)**, ganti vendor ke
   **Qiscus** (prioritas — format pesan Qiscus mengikuti format Meta Cloud API) dengan
   `domain_api` = URL Balesin staging. Tes kirim 1 pesan (mis. tiket ke nomor internal).
   Gateway produksi "Billing BTD" tidak disentuh.
3. Dari request yang tertangkap, `backend` membangun adaptor: terima format vendor →
   kirim template Meta lewat Balesin → balas dengan format respons vendor → status dikirim
   ke webhook billing bila diperlukan.
4. Setelah lolos uji, pindahkan area (fitur **"Pindah Coverage"** di billing) dari gateway
   lama ke gateway Balesin secara bertahap.
5. Cadangan bila tidak ada vendor yang cocok: minta vendor billing menambah opsi
   "Balesin" / domain kustom untuk Mobichats.

Ulangi untuk BILL SURYA & BILL BAYU (aplikasi yang sama → langkah sama).
