# API & Integrasi n8n — Balesin

Ada dua lapis API:

1. **Mode kompatibel MobiChat** — supaya workflow n8n "ULAN AI" yang sudah live di Sky Tech
   cukup **ganti base URL + token**, tanpa membangun ulang node.
2. **API native Balesin v1** — REST rapi + webhook keluar, terdokumentasi OpenAPI di
   `/api/docs` (untuk integrasi baru & perusahaan lain).

## 1. Mode kompatibel MobiChat (PRIORITAS)

### Sumber kebenaran
Format pasti payload & endpoint MobiChat **tidak ditebak**. Agent `riset-fitur` wajib
menurunkannya dari:
- `docs/reference/n8n/ulan-workflow.json` — ekspor workflow n8n ULAN (lihat
  `docs/BUTUH-TOBING.md`). Dari sini terlihat: bentuk body webhook yang diterima n8n dari
  MobiChat, dan setiap HTTP Request node yang dipanggil n8n ke MobiChat (method, path,
  header auth, body).
- Dokumentasi/halaman pengaturan External Bot MobiChat (screenshot di
  `docs/reference/mobichat/`).

Hasilnya ditulis ke `docs/API-MOBICHAT-MAPPING.md` berupa tabel:
`aksi | endpoint MobiChat | method | field request | field respons | padanan Balesin`.
Backend membangun **lapisan adaptor** (`apps/api/src/modules/compat-mobichat/`) yang
menerjemahkan ke layanan internal Balesin. Tes kontrak memakai contoh payload dari ekspor.

### Aksi minimum yang harus didukung (dipakai ULAN)
- Menerima event pesan masuk (teks, gambar, video, audio/VN, dokumen, lokasi) + info kontak
  & percakapan → dikirim ke URL bot eksternal.
- Kirim balasan teks; kirim gambar/dokumen; kirim template.
- Ubah nama kontak (format `ID+NAMA@AREA`).
- Tambah/hapus tag kontak (mis. `MITRA-SURYA`, `MITRA-BAYU`).
- **Handoff**: bot berhenti, percakapan masuk antrian terbuka untuk staf.
- Tandai selesai / buka lagi.
- Ambil detail kontak, percakapan, dan riwayat pesan terakhir.

### Perilaku bot eksternal
- Event dikirim hanya bila bot aktif untuk percakapan tersebut.
- Timeout 30 dtk, retry 3× dengan backoff; kegagalan beruntun → alarm.
- Saat agen manusia mengambil alih, bot otomatis nonaktif untuk percakapan itu.

## 2. API native v1 (ringkas)

Auth: header `Authorization: Bearer blsn_...` (API key dengan scope).

| Method | Path | Scope |
|---|---|---|
| GET | `/api/v1/conversations?status=&assignee=&tag=` | `conversations:read` |
| GET | `/api/v1/conversations/:id/messages` | `conversations:read` |
| POST | `/api/v1/conversations/:id/messages` (text/media/template) | `messages:send` |
| POST | `/api/v1/conversations/:id/handoff` | `conversations:write` |
| POST | `/api/v1/conversations/:id/resolve` · `/reopen` | `conversations:write` |
| POST | `/api/v1/conversations/:id/assign` | `conversations:write` |
| GET/PATCH | `/api/v1/contacts/:id` | `contacts:read` / `contacts:write` |
| POST/DELETE | `/api/v1/contacts/:id/tags` | `contacts:write` |
| POST | `/api/v1/messages/template` (ke nomor; memulai percakapan) | `messages:initiate` |
| POST | `/api/v1/broadcasts` | `broadcasts:write` |
| POST | `/api/v1/tickets` | `tickets:write` |
| GET | `/api/v1/usage` (biaya & kuota pesan) | `reports:read` |

Pagination berbasis cursor; error format `{ "error": { "code", "message" } }`;
idempotensi lewat header `Idempotency-Key` untuk kirim pesan.

## 3. Webhook keluar

Event: `message.received`, `message.sent`, `message.status` (delivered/read/failed),
`conversation.assigned`, `conversation.resolved`, `conversation.handoff`,
`contact.updated`, `broadcast.completed`, `ticket.created`.

Header: `X-Balesin-Event`, `X-Balesin-Delivery`, `X-Balesin-Signature: t=..,v1=..`.
Body: `{ "id", "event", "created_at", "data": {...} }`. Riwayat pengiriman + tombol
"Kirim ulang" di Pengaturan → Webhook.

## 4. Node n8n
Fase NANTI: paket community node `n8n-nodes-balesin`. Untuk sekarang cukup HTTP Request
node + mode kompatibel.
