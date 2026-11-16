# Kontrak — Webhook keluar (Fase 3)

Balesin mengirim event ke sistem lain (n8n, bot, CRM) lewat HTTP POST bertanda tangan. Skema Zod:
`packages/shared/src/outgoing-webhooks.ts`. Alamat pengelolaan: `API_ROUTES.outgoingWebhooks`.
Format body: `native` (di bawah) atau `mobichat` (body webhook MobiChat + `mobichat_base_url`/
`mobichat_api_key` disisipkan saat kirim, hanya `message.received`) — lihat
`docs/KONTRAK-API-MOBICHAT.md` "Webhook keluar format MobiChat".

## Mengelola (Pengaturan → Webhook) — `integrations.manage` (Owner/Admin)

| Endpoint | Keterangan |
|---|---|
| `GET /api/v1/settings/webhooks` | `{ webhooks: [{ id, url, description, events, enabled, disabledReason, consecutiveFailures, lastDeliveryAt, secretRotatedAt, previousSecretExpiresAt, createdAt }] }` |
| `POST /api/v1/settings/webhooks` | `{ url, events (≥ 1), description?, format? (native/mobichat), mobichat? { apiKey, baseUrl? }, confirmation }` — **wajib konfirmasi identitas** → **201** `{ webhook, secret }` (`whsec_…`, **tampil SEKALI**, `no-store`). Maks. 10 webhook. Jawaban juga memuat `format` + `mobichat { baseUrl, apiKeyLast4, apiKeyId, apiKeyName, apiKeyStatus }` (tanpa key utuh) |
| `PATCH /api/v1/settings/webhooks/:id` | `{ url?, events?, description?, enabled?, mobichat? { apiKey?, baseUrl? }, confirmation? }` — `url` BERUBAH atau `mobichat` key/alamat berubah = wajib konfirmasi; aktif/nonaktif & event tanpa konfirmasi. Mengaktifkan lagi menyetel ulang hitungan gagal. `format` tidak bisa diubah |
| `DELETE /api/v1/settings/webhooks/:id` | → `{ deleted: true }` (riwayatnya ikut terhapus) |
| `POST /api/v1/settings/webhooks/:id/rotate-secret` | `{ confirmation, revokePrevious? }` → `{ webhook, secret }` baru; rahasia LAMA tetap ikut ditandatangani 24 jam (`previousSecretExpiresAt`), kecuali `revokePrevious: true` (bocor) → langsung berhenti |
| `POST /api/v1/settings/webhooks/:id/test` | Kirim event `webhook.test` → **201** `{ delivery }` (dikirim worker ≤ 5 dtk) |
| `GET /api/v1/settings/webhooks/:id/deliveries?cursor=&limit=` | Riwayat terbaru dulu: `{ deliveries: [{ id, event, status (pending/succeeded/failed), attempts, httpStatus, durationMs, error, responseSnippet, payloadPurged, createdAt, deliveredAt, nextAttemptAt }], nextCursor }` |
| `POST /api/v1/settings/webhooks/:id/deliveries/:deliveryId/redeliver` | Kirim ulang body yang SAMA (ID pengiriman baru) → **201**; isi sudah lewat masa simpan → **409** |
| `GET` / `PUT /api/v1/settings/webhooks-private-network` | Allowlist IP privat `{ cidrs }` — PUT wajib konfirmasi; hanya CIDR yang seluruhnya di 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 (maks. 20) |

Audit (tanpa rahasia; URL hanya `host` — path/query bisa memuat token penerima):
`webhook.created/updated/deleted/secret_rotated/auto_disabled`, `settings.private_network.updated`.
Kejadian keamanan: `webhook_changed` (dibuat, URL diubah, rahasia dirotasi, allowlist diubah) dan
`webhook_disabled` (nonaktif otomatis) — keduanya `warning`.

## Event

`message.received`, `message.sent` (Meta menerima), `message.status` (sent/delivered/read/failed),
`conversation.created`, `conversation.assigned` (diambil/ditugaskan), `conversation.unassigned`,
`conversation.resolved`, `conversation.reopened`, `contact.created`, `contact.updated` (termasuk tag).
Menyusul: `conversation.handoff`, `broadcast.completed`, `ticket.created`.

Kejadian dicatat sebagai **outbox** (`outgoing_events`, hanya ID + jenis) di transaksi yang SAMA
dengan perubahannya, dan hanya bila ada endpoint aktif yang melanggan jenis itu.

## Pengiriman

```
POST <url>
Content-Type: application/json
User-Agent: Balesin-Webhook/1.0
X-Balesin-Event: message.received
X-Balesin-Delivery: <uuid pengiriman>
X-Balesin-Signature: t=<unix detik>,v1=<hex>[,v1=<hex rahasia lama>]

{ "id": "<uuid kejadian>", "event": "message.received", "created_at": "…", "data": { … } }
```

- `v1` = HMAC-SHA256(rahasia, `"<t>.<body mentah>"`) (hex). Penerima: hitung ulang, bandingkan
  waktu-konstan dengan SALAH SATU `v1`, tolak bila `t` > 5 menit dari jam sekarang. `id` sama untuk
  kirim ulang (pakai untuk idempotensi); `X-Balesin-Delivery` beda tiap pengiriman.
- `data` dibangun worker SAAT DISPATCH dari database: `message` (id, number, direction, sender_kind,
  type, text, media {kind, mime_type, filename}, location, status, error_code, created_at),
  `conversation` (id, number, status, channel_id, assignee {id,name}, window_expires_at, created_at,
  resolved_at), `contact` (id, number, phone, wa_username, name, profile_name, email, attributes,
  tags), `actor` {id,name} bila ada. Memuat data pelanggan seperlunya untuk bot/n8n (isi pesan,
  nomor); TANPA rahasia, ID media Meta, atau BSUID. Subjek sudah dihapus → tidak dikirim.
- Worker (`webhooks-out`, job berkala tiap 5 dtk): sukses = 2xx. 408/429/5xx/jaringan/batas waktu →
  dicoba lagi setelah 30 dtk, 2 mnt, 10 mnt, 30 mnt, 2 jam (6 percobaan); 3xx (redirect TIDAK
  diikuti), 4xx lain, alamat terlarang → langsung gagal. Batas waktu 10 dtk; jawaban dibaca maks.
  500 byte (potongan riwayat).
- **20 gagal final beruntun** → webhook dinonaktifkan otomatis (`auto_failures`) + audit + kejadian
  keamanan + email ke semua Owner. Sukses mana pun menyetel ulang hitungan.
- Retensi: `payload` & potongan jawaban dikosongkan setelah 7 hari (tidak bisa dikirim ulang), baris
  dihapus setelah 30 hari. Hapus kontak (UU PDP) langsung mengosongkan isi pengiriman tentang kontak
  itu dan membuang kejadian outbox-nya.

## SSRF (SECURITY §6)

- Skema `https` wajib, kecuali tujuan IP PRIVAT yang ada di allowlist (boleh `http`, mis. n8n LAN).
- Port: 80, 443, 5678 (n8n), 8080, 8443. Tanpa kredensial di URL.
- Alamat SELALU ditolak: loopback, 0/8, link-local 169.254/16 & fe80::/10 (termasuk metadata cloud
  169.254.169.254, fd00:ec2::254), multicast, broadcast, cadangan 240/4, 192.0.0/24, 198.18/15,
  64:ff9b::/96, 2001:db8::/32, serta IPv6 pembungkus IPv4 `::/96`, 6to4 `2002::/16`, NAT64 local-use
  `64:ff9b:1::/48`, Teredo `2001::/32`; IPv4-mapped IPv6 diperiksa sebagai IPv4.
- Jaringan privat (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) hanya bila CIDR-nya ada di
  allowlist organisasi.
- DNS di-resolve SEKALI lewat resolver c-ares (`dns.promises.Resolver`, A + AAAA, bukan threadpool;
  `/etc/hosts` tidak dibaca) DI DALAM tenggat total 10 dtk; SEMUA alamat hasilnya harus lolos; soket
  disambungkan ke alamat yang sudah diperiksa (tanpa resolusi kedua → kebal DNS rebinding); SNI/Host
  tetap nama aslinya.
- Kejadian outbox yang gagal dibangun dibuang per kejadian (savepoint) + dicatat (ID + kode galat), tidak
  memacetkan kejadian lain. Log galat worker tanpa teks/parameter kueri.
- Diperiksa saat menyimpan (sintaksis + IP literal) DAN setiap pengiriman (setelah DNS).
