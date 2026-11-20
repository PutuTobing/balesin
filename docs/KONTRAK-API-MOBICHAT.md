# Kontrak — Lapisan kompatibel MobiChat (Fase 3)

Tujuan: workflow n8n yang dulu memanggil MobiChat (ULAN) cukup mengganti **base URL** + **API key**
ke Balesin dan tetap jalan. Sumber bentuk: `docs/API-MOBICHAT-MAPPING.md` §1 & §3 dan ekspor
`docs/reference/n8n/ulan-workflow.json`. Skema Zod: `packages/shared/src/mobichat.ts`
(`MOBICHAT_ROUTES`). Kode: `apps/api/src/modules/compat-mobichat/` (adaptor tipis di atas layanan yang
sudah ada — kirim pesan, penanganan, catatan, kontak & tag; tidak ada logika bisnis ganda).

## Autentikasi & scope

- Header **`X-API-Key: <API key Balesin>`** (nama header tidak peka huruf: `x-api-key` juga). Key yang
  SAMA dengan API publik v1 (`blsn_live_…`, Pengaturan → API key). `Authorization: Bearer` dan key di
  query string **tidak diterima** di rute ini; sebaliknya `X-API-Key` tidak berlaku di `/api/v1/public/*`
  (satu rute = satu cara autentikasi).
- Batas sama dengan API v1: 300 permintaan/menit per key, kunci IP untuk key salah, IP yang diizinkan,
  dicabut/kedaluwarsa → 401.
- Cakupan data = seluruh organisasi pemilik key.

| Endpoint | Scope | Padanan Balesin |
|---|---|---|
| `GET /api/public/messages?conversation_id=&limit=` | `messages:read` | riwayat sesi (`limit` 1–100, bawaan 30) |
| `POST /api/public/messages` | `messages:send` | kirim teks / media dari URL (`sendAsApiKey`) |
| `GET /api/public/conversation-status?conversationId=` | `conversations:read` | status + "assignment" |
| `POST /api/public/conversation-status` | `conversations:write` | `unserved` = lepas bot (handoff), `resolved` = selesai |
| `POST /api/public/unassign-agent` | `conversations:write` | lepas bot / lepas agen tertentu |
| `POST /api/public/agents` | `conversations:write` | tugaskan agen |
| `POST /api/public/conversation/notes` | `conversations:write` | catatan sesi oleh bot |
| `PUT /api/public/contacts` | `contacts:write` | ganti nama kontak percakapan |
| `PUT /api/public/tags/whatsapp` | `contacts:write` | tambah tag (tag lama tetap) |
| `GET /api/public/media/:messageNumber?exp=&kid=&sig=` | tanpa header (URL bertanda tangan) | berkas lampiran |
| `POST /api/bot/reply` | `messages:send` | Bot API lama — teks, tombol (`button`), daftar (`list`) |
| `POST /api/bot/reply/media` | `messages:send` | Bot API lama — media dari URL |

`conversation_id`/`conversationId` (keduanya diterima) = **`conversations.number`**; `id`/`message_id`
pesan = **`messages.number`** — angka berurutan, boleh dikirim sebagai angka atau string angka. Satu
percakapan Balesin = satu sesi; percakapan baru setelah "Selesai" mendapat nomor baru.

## Bentuk jawaban

- Sukses `/api/public/*`: `{ success: true, … }`. Galat: **`{ success: false, code, message }`** dengan
  kode HTTP standar — 400 validasi (pesan menyebut isian pertama yang salah), 401 key, 403 scope/IP,
  404 tidak ditemukan / `media_url` tidak bisa diakses, 409 `WINDOW_CLOSED`/konflik, 413 berkas terlalu
  besar, 415 jenis berkas, 423 `SENDING_PAUSED` (rem darurat), 429 batas (+ `Retry-After`), 5xx.
- Galat `/api/bot/*`: **`{ error: "…" }`** (sama dengan dokumentasi MobiChat).

### Riwayat — `GET /api/public/messages`

`{ success, conversation_id, messages: [ … ] }` urut lama → baru (N terbaru). Per pesan: `id`, `index`,
`conversation_id`, `type` = `sender` ∈ `user` (pelanggan) · `agent` · `api-bot` (bot/API key) ·
`broadcast` · `system`, `sender_name` (nama kontak / nama agen / nama API key), `message_type` (jenis
Balesin: `text`, `image`, `document`, `audio`, `video`, `sticker`, `location`, …), `text` = `message_text`
(caption untuk media; lokasi → `[lokasi] <nama> https://maps.google.com/?q=lat,long`; balasan tombol →
judulnya), `status` (pesan keluar), `created_at`, `attachments` = `file_attachments`. Reaksi tidak ikut.

Lampiran: `{ id, type, file_type, mime_type (sama), media_type, name, url, signed_url, public_url }` —
stiker bernama `sticker_<n>.webp`. URL = `<APP_URL>/api/public/media/<n>?exp=&kid=&sig=`:
HMAC-SHA256 (kunci turunan `BALESIN_MASTER_KEY`) atas nomor pesan + kedaluwarsa + ID key peminta,
berlaku **1 jam**, mati seketika bila key dicabut/kedaluwarsa/tanpa `messages:read`. Diunduh dengan GET
polos (n8n / penyedia AI) — header `nosniff`, CSP sandbox, `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer`. Tidak sah → 404 seragam.

### Kirim — `POST /api/public/messages`

```json
{ "conversation_id": 123, "messages": [
  { "message_type": "text", "text": "…" },
  { "message_type": "media", "media_type": "image", "media_url": "https://…", "caption": "…", "file_name": "qr.png" } ] }
```

- Maks. 5 pesan; dikirim berurutan; galat menghentikan sisanya (yang sebelumnya sudah terantre).
- `message_type: "button"` (`text` + `list_options` 1–3 `{id,title}`) dan `"list"` (`text` +
  `list_title` = teks tombol pembuka, bawaan "Pilih" + `list_options` 1–10 `{id,title,description?}`)
  → pesan interaktif dengan batas Meta yang sama dengan web (galat 400 menyebut `list_options`).
  `flow`/template → 400 "belum didukung".
- Semua aturan kirim tetap: jendela 24 jam (409), rem darurat (423), batas per percakapan & organisasi
  600/menit, **batas harian per key** (429), pelaku `senderKind: bot` + `api_key_id`.
- Header `Idempotency-Key` opsional — berlaku per butir (`<key>#<urutan>`); diulang → pesan yang sama.
- `media_url` diunduh server dengan aturan SSRF **sama dengan webhook keluar**: https wajib untuk
  alamat publik; loopback/link-local/metadata/cadangan selalu ditolak; jaringan privat hanya lewat
  allowlist IP privat organisasi (Pengaturan → Webhook); port 80/443/5678/8080/8443; DNS sekali + soket
  ke IP terperiksa; redirect maks. 3 (setiap lompatan diperiksa ulang); tenggat total 15 dtk; ukuran
  maks. sesuai jenis media WhatsApp. Lalu masuk jalur unggah biasa (jenis ditentukan dari ISI berkas).
- Jawaban: `{ success, conversation_id, message_id, status: "pending", messages: [{ id, message_id,
  message_type, status }] }`.

### Status & handoff

- `GET conversation-status` → `{ success, conversation_id, status, assignments }`. `status` = status
  Balesin (`bot`/`unserved`/`served`/`resolved`). `assignments`: `{ user: { id: "bot", name: "Bot",
  role: "chatbot" } }` saat status `bot`; agen pemegang `{ user: { id, name, email: null, role: "agent" } }`
  (email agen sengaja tidak dibuka).
- **Perubahan STATUS oleh key hanya atas percakapan bot / antrian** (review Info 2, DECISIONS): tidak
  pernah mengeluarkan atau mengalihkan agen manusia. Membaca riwayat, mengirim pesan, catatan, dan
  ganti nama kontak berlaku untuk semua percakapan WhatsApp organisasi (cakupan data API publik =
  seluruh organisasi), termasuk yang sedang dipegang agen — batas harian per key, rem darurat, dan
  audit tetap berlaku.
- **Kirim ke percakapan `resolved`** (audit akhir A1): teks/media/tombol dalam jendela 24 jam tetap
  cukup `messages:send` (perilaku lama). Lapisan MobiChat tidak mengirim template, jadi aturan
  "template ke percakapan selesai butuh `messages:initiate`" tidak memengaruhinya.
- **Hanya percakapan WhatsApp** (review bot semua channel B2): `conversation_id` milik percakapan
  Telegram/Email/Messenger/Instagram dijawab **404** yang sama dengan percakapan yang tidak ada, di
  semua rute `/api/public/*` dan `/api/bot/*`.
- `POST unassign-agent { conversation_id, agent_id? }` = **lepas bot** (handoff): status `bot` →
  `unserved` (antrian "Belum dilayani"), kejadian `handoff`, webhook `conversation.handoff`, push
  antrian. `agent_id` diabaikan. Percakapan yang tidak dipegang bot **tidak diubah** (200 + pesan).
- `POST conversation-status { status: "unserved" }` = lepas bot (cara lama); `"resolved"` = selesai,
  hanya untuk percakapan `bot` (lainnya 409); status lain 400.
- `POST agents { conversation_id, agent_id }` → agen aktif yang boleh membalas (UUID), hanya dari
  `bot`/antrian (dipegang agen lain → 409), selain itu 400.
- Semua aksi dicatat di `conversation_events` dengan `api_key_id` (pelaku tampil "Bot · <nama key>" di
  tab Log) + webhook keluar `conversation.*`; key diperiksa ulang di transaksi akhir (dicabut → 401).
- Status `bot` diisi saklar bot channel (Pengaturan → Channel → Bot) untuk percakapan baru; agen bisa
  mematikan/menyalakan bot per percakapan; batas waktu bot memindahkan ke antrian (KONTRAK-API-INBOX
  "Bot eksternal").

### Catatan, kontak, tag

- `POST conversation/notes { conversationId, notes }` → catatan sesi dengan penulis = API key (≤ 2.000
  karakter, maks. 200/percakapan). Agen tidak bisa mengubahnya; moderator bisa menghapus.
- `PUT contacts { conversation_id, full_name?, edited_name?, name? }` → nama kontak (dari tim) =
  `edited_name` → `full_name` → `name`. Jawaban `contact: { id (nomor kontak), full_name, edited_name,
  name, phone_number (62…), tags }`.
- `PUT tags/whatsapp { whatsapp_number, tags }` → nomor `62…`/`0…`/`+62…` dinormalkan ke E.164; kontak
  tidak ada → 404 `{ success:false, message:"Kontak dengan nomor itu tidak ditemukan." }`. Tag yang
  belum ada dibuat; tag lama tetap.

### Bot API lama

`POST /api/bot/reply { conversation_id, message_text, message_type: "text" }` dan
`POST /api/bot/reply/media { conversation_id, media_url, media_type, caption?, file_name? }` →
`{ success, message_id, conversation_id, result: { success, data: { messaging_product: "whatsapp",
contacts: [{ input, wa_id }], messages: [{ id: null }] } }, status: "pending" }`. `id` (wamid) `null`
karena pesan dikirim lewat antrean worker (status menyusul lewat webhook/riwayat).

## Webhook keluar format MobiChat

Pengaturan → Webhook, `format: "mobichat"` (tidak bisa diubah setelah dibuat), hanya event
`message.received`. Body (dibaca node "Ambil data pesan" ULAN apa adanya):

```json
{ "event": "message.received", "event_id": "…", "created_at": "…",
  "conversation_id": 791262, "conversation_session_log_id": 791262, "message_id": 123456,
  "message_text": "Siap kak", "message_type": "text", "sender": "user", "type": "user",
  "contact_name": "…", "tags": ["MITRA-SURYA"],
  "contact": { "id": 55, "full_name": "…", "name": "…", "edited_name": "…", "profile_name": "…",
    "phone": "62…", "phone_number": "62…", "contact_details": [{ "type": "whatsapp", "value": "62…" }], "tags": [] },
  "conversation": { "id": 791262, "status": "bot", "assignee": null, "window_expires_at": "…" },
  "message": { "id": 123456, "conversation_id": 791262, "type": "user", "sender": "user", "sender_name": "…",
    "text": "Siap kak", "message_text": "Siap kak", "message_type": "text", "attachments": [], "created_at": "…" },
  "mobichat_base_url": "https://balesin.skytech.net.id",
  "mobichat_api_key": "blsn_live_…" }
```

- `mobichat_base_url` = isian endpoint, atau `APP_URL` bila kosong. `mobichat_api_key` = API key yang
  ditempel admin. **Keduanya disisipkan SAAT KIRIM** — tidak pernah tersimpan di `webhook_deliveries`
  (riwayat/kirim ulang aman), key dibaca dari `webhook_endpoints.mobichat_api_key_encrypted`.
- Lampiran tanpa URL (ambil URL bertanda tangan dari riwayat). Hanya pesan pelanggan (bukan agen/bot).
- Balasan tombol/daftar pelanggan: `message_text` = judul pilihan, `reply_id` = ID pilihan,
  `interactive_reply` / `message.interactive_reply` = `{ type: button_reply|list_reply, id, title,
  description }`. **Semua isian ini MASUKAN PELANGGAN yang tidak tepercaya** (klien WhatsApp tidak
  resmi bisa mengirim ID/judul buatan): bot memperlakukannya seperti teks pelanggan, bukan perintah.
- Opsi `botOnly` endpoint: kirim hanya selama bot memegang (bawaan: semua pesan pelanggan — workflow
  ULAN memutuskan diam sendiri).
- **Batasan: format MobiChat = WhatsApp saja** (DECISIONS 2026-11-19). Body berbasis nomor WhatsApp
  (`phone`, `contact_details[type=whatsapp]`), jadi pesan dari channel Telegram/Email/Messenger/
  Instagram TIDAK dikirim ke endpoint format ini, dan endpoint format ini tidak dihitung sebagai
  penerima bot untuk channel tersebut (percakapan baru di sana langsung ke antrian tim, bukan diparkir
  di bot). Bot untuk channel lain memakai webhook format native (`data.conversation.channel_type`) +
  API publik v1. Body untuk percakapan WhatsApp tidak berubah sedikit pun. Rute `/api/public/*` &
  `/api/bot/*` juga menjawab 404 untuk percakapan non-WhatsApp.
- **Peringatan `http://`**: bila URL webhook atau `mobichat_base_url` memakai `http://`, API key
  mengalir tanpa TLS. Hanya pantas untuk jaringan LAN tepercaya (allowlist IP privat); UI wajib
  menampilkan peringatan. Alamat LAN tanpa DNS: pakai IP (resolver tidak membaca `/etc/hosts`).
- Potongan jawaban penerima di riwayat disensor (key yang disisipkan + pola rahasia, review S1).
- Key yang dipakai dicabut/kedaluwarsa → pengiriman gagal `mobichat_key_inactive` (tidak dikirim);
  daftar webhook menampilkan `apiKeyStatus`.
- Tanda tangan `X-Balesin-Signature` tetap ada (penerima boleh mengabaikan).
- Event tes dari Pengaturan: body gaya MobiChat TANPA `conversation_id` (workflow tidak memprosesnya).

Pengelolaan (`integrations.manage`, docs/KONTRAK-WEBHOOK-KELUAR.md):

| Isian | Keterangan |
|---|---|
| `POST … { url, events: ["message.received"], format: "mobichat", mobichat: { apiKey, baseUrl? }, confirmation }` | `apiKey` harus key SAH organisasi ini (bentuk + rahasia + aktif) → selain itu 400. `baseUrl` http/https tanpa kredensial/query/#, `/` di akhir dibuang |
| `PATCH … { mobichat: { apiKey?, baseUrl? }, confirmation }` | mengganti key atau alamat = **wajib konfirmasi identitas** (menentukan ke mana n8n mengirim key) |
| Jawaban `webhook.format`, `webhook.mobichat: { baseUrl, apiKeyLast4, apiKeyId, apiKeyName, apiKeyStatus }` | key utuh TIDAK PERNAH dikirim balik |

Audit: `webhook.created/updated` memuat `format`, `mobichatApiKeyId`, host alamat balik — tanpa key.

## Risiko yang diterima (DECISIONS 2026-11-19)

- API key ada di body webhook (seperti MobiChat) → siapa pun yang membaca log/riwayat eksekusi n8n
  bisa memakainya. Mitigasi: key khusus bot dengan scope minimum (`messages:send`,
  `conversations:write`, `contacts:write`), batas harian, IP diizinkan (alamat n8n), mudah dicabut.
- URL media bertanda tangan bisa dibuka siapa pun yang memegangnya selama ≤ 1 jam. Query string tidak
  pernah ditulis log aplikasi; **proxy di depan (nginx) sebaiknya tidak mencatat query** untuk
  `/api/public/media/` (catatan untuk devops).
