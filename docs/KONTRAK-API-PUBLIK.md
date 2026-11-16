# Kontrak API — API publik v1 & API key (Fase 3)

API untuk integrasi (n8n, bot, sistem lain). Skema Zod: `packages/shared/src/api-keys.ts`,
`public-api.ts` (+ skema respons inbox yang SAMA dengan API web). Alamat: `API_ROUTES.publicApi`,
`API_ROUTES.apiKeys`, `API_DOCS_ROUTES`. Lapisan kompatibel MobiChat (`/api/public/*`, header
`X-API-Key`) adalah butir terpisah dan akan memakai API key yang sama.

## Namespace

`/api/v1/public/*` — terpisah dari API web bersesi `/api/v1/*` (cookie + CSRF) dan dari lapisan
kompatibel MobiChat `/api/public/*`. Satu rute = satu cara autentikasi (tidak ada rute yang menerima
sesi DAN API key), sehingga matriks izin tetap sederhana (DECISIONS 2026-11-18).

## Mengelola API key (Pengaturan → API key)

| Endpoint                                    | Izin                            | Keterangan                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/settings/api-keys`             | `api_keys.manage` (Owner/Admin) | `{ apiKeys: [{ id, name, displayPrefix, scopes, allowedIps, dailySendLimit, expiresAt, revokedAt, lastUsedAt, createdBy, createdAt, status }] }` — `status`: `active`/`expired`/`revoked`. Tidak pernah memuat rahasia                                                                                                                                                                                                       |
| `POST /api/v1/settings/api-keys`            | `api_keys.manage`               | CSRF. Body `{ name (≤ 80), scopes (≥ 1), expiresAt? (masa depan, ≤ 2 tahun), allowedIps? (≤ 20 IP/CIDR), dailySendLimit? (1–100.000, bawaan 500), confirmation }` — **wajib konfirmasi identitas**. → **201** `{ apiKey, secret }` (`Cache-Control: no-store`). **`secret` = kunci utuh, ditampilkan SEKALI**. Maks. 50 key aktif. Diaudit `api_key.created` (tanpa rahasia) + kejadian keamanan `api_key_changed` (warning) |
| `POST /api/v1/settings/api-keys/:id/revoke` | `api_keys.manage`               | CSRF. TANPA konfirmasi (arah aman). Berlaku seketika (permintaan berikutnya 401; pesan antrean key itu gagal `sender_not_allowed`). Diaudit `api_key.revoked` + `api_key_changed`                                                                                                                                                                                                                                            |
| `GET` / `PUT /api/v1/settings/api`          | `api_keys.manage`               | `{ settings: { docsEnabled } }` — halaman `/api/docs` aktif/mati (bawaan aktif). Diaudit `settings.api.updated`                                                                                                                                                                                                                                                                                                              |

**Bentuk kunci**: `blsn_live_<id 16 hex>_<rahasia 43 base64url>`. Server menyimpan `id` (pencarian)
dan **HMAC-SHA256(pepper, "<id>.<rahasia>")** saja; pepper diturunkan dari `BALESIN_MASTER_KEY`
(HKDF). Tanpa master key: membuat key → 503, semua key ditolak. Mengganti master key membatalkan
semua key (harus dibuat ulang). Log menyensor `blsn_live_…` dan header `Authorization`.

## Autentikasi & batas

- Header `Authorization: Bearer <API key>`. Cookie & CSRF TIDAK dipakai (cookie sesi web di rute
  publik → 401). Permintaan pengubah data dengan header `Origin` asing ditolak 403 (bukan untuk
  browser lintas situs).
- 401 `UNAUTHENTICATED`: header tidak ada, key salah, dicabut, atau kedaluwarsa (satu pesan yang sama).
- 403 `FORBIDDEN`: scope kurang (pesan menyebut scope-nya) atau IP pemanggil di luar `allowedIps`.
- 429: 300 permintaan/menit per key; 30 key SALAH/menit per IP (setelah itu key SALAH berikutnya dari
  IP itu 429; key SAH tetap dilayani — review R1; header kosong tidak dihitung). Pencarian kontak
  dibatasi waktu query 3 dtk (503).
- `lastUsedAt` diperbarui paling sering sekali per menit.

## Scope (bertingkat)

| Scope                | Arti                                                                          | Termasuk                              |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `conversations:read` | Daftar & detail percakapan                                                    | —                                     |
| `messages:read`      | Pesan & statusnya                                                             | `conversations:read`                  |
| `messages:send`      | Kirim pesan di percakapan YANG SUDAH ADA (dalam jendela 24 jam), unggah media | `messages:read`, `conversations:read` |
| `contacts:read`      | Cari & lihat kontak                                                           | —                                     |
| `contacts:write`     | Buat & ubah kontak, pasang/lepas tag                                          | `contacts:read`                       |

Menyusul bersama fiturnya: `messages:initiate` (template ke nomor baru), `conversations:write`
(selesai/buka lagi/assign/handoff — butir bot eksternal), `broadcasts:write`, `tickets:write`,
`reports:read`, `webhooks:manage`. Sesuai SECURITY §5, key tanpa `messages:initiate` tidak bisa
memulai percakapan ke nomor baru.

## Endpoint

Cakupan data = SELURUH organisasi pemilik key (mis. key ber-`messages:send` bisa MEMBACA semua percakapan & pesan organisasi — tidak ada cakupan per agen; berikan hanya ke integrasi tepercaya). Bentuk respons = API web (`Conversation`, `Message`,
`Contact`); galat `{ error: { code, message, details? } }`.

| Endpoint                                           | Scope                              | Keterangan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/public/conversations`                 | `conversations:read`               | Saringan & kursor sama dengan inbox (`status`, `channelId`, `tagId`, `assignee`, `window`, `unread`, `q`, `cursor`, `limit`)                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/v1/public/conversations/:id`             | `conversations:read`               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/v1/public/conversations/:id/messages`    | `messages:read`                    | Terbaru dulu; `cursor`, `limit`, `only`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/v1/public/conversations/:id/messages`   | `messages:send`                    | Body = API web tanpa `clientMessageId` (`text` / `media` / `location` / `reaction`). Header **`Idempotency-Key`** opsional (1–100 ASCII; per key) → **202** baru, **200** sudah pernah. Jendela 24 jam (409 `WINDOW_CLOSED`), rem darurat (423), batas per percakapan & organisasi, dan **batas harian PER KEY** (`dailySendLimit`, 24 jam bergulir → 429 + audit `sending.limit_reached` target `api_key` + email Owner atas nama pembuat key), dan batas organisasi 600/menit (sama dengan web) |
| `POST /api/v1/public/conversations/:id/media`      | `messages:send`                    | multipart `file` (aturan jenis/ukuran = web) → **201** `{ media }`; kirim dengan `{ type: 'media', mediaId }` memakai key yang SAMA                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/v1/public/messages/:id`                  | `messages:read`                    | Satu pesan (status kirim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/v1/public/contacts?q=&phone=&limit=`     | `contacts:read`                    | `q` (2–100, nama/nomor/username) atau `phone` (E.164); maks. 50                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/v1/public/contacts`                     | `contacts:write`                   | `{ phone (E.164), name?, email?, attributes? }` → **201** baru / **200** nomor sudah ada (kontak itu)                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET` / `PATCH /api/v1/public/contacts/:id`        | `contacts:read` / `contacts:write` | PATCH = body `PATCH /contacts/:id` web                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST` / `DELETE /api/v1/public/contacts/:id/tags` | `contacts:write`                   | `{ tags: [nama…] }` (≤ 20). Pasang membuat tag yang belum ada (biru); nama dibandingkan tanpa beda huruf                                                                                                                                                                                                                                                                                                                                                                                          |

**Pelaku**: pesan lewat key → `senderKind: 'bot'`, `senderUserId: null`, kolom `messages.api_key_id`;
tidak mengisi `firstResponseAt` (laporan waktu respons agen). Perubahan kontak/tag lewat key →
`contact_events.actor_user_id = null` + `contact_events.api_key_id` = key pelakunya (review R2). Audit batas kirim: `actorUserId`
null + target `api_key`. Worker memeriksa ulang key (tidak dicabut/kedaluwarsa, masih
`messages:send`) sebelum mengirim; selain itu `sender_not_allowed`.

## Dokumentasi

- `GET /api/docs` — halaman (HTML + `/api/docs/app.css` + `/api/docs/app.js`, tanpa CDN; CSP
  `script-src 'self'`, tanpa skrip inline). `GET /api/docs/openapi.json` — **OpenAPI 3.1** dari skema
  Zod bersama (`apps/api/src/modules/public-api/openapi.ts`).
- Publik (tanpa sesi), bisa dimatikan di Pengaturan → API (→ 404). Tidak memuat data organisasi atau
  contoh rahasia.
