# Arsitektur — Balesin

## 1. Gambaran

```
 Pelanggan (WhatsApp/Telegram/Email/IG/FB)
            │
      Meta Cloud API ── webhook ──┐
                                  ▼
 Internet ── HTTPS ──► [Reverse proxy / Tunnel] ──► [Balesin VM, IP privat]
                                                     ├─ web     (React PWA, static)
                                                     ├─ api     (Fastify, REST + WebSocket)
                                                     ├─ worker  (BullMQ: kirim pesan, broadcast,
                                                     │           webhook keluar, email, media)
                                                     ├─ postgres
                                                     ├─ redis
                                                     └─ media   (disk lokal / S3-compatible)
                                                           │
                                           LAN ────────────┴──► n8n (bot ULAN), billing API
```

## 2. Struktur repo

```
balesin/
├─ apps/
│  ├─ api/        Fastify + Drizzle; modul per domain (auth, channels, inbox, contacts,
│  │              templates, broadcasts, bots, webhooks, reports, settings, audit)
│  ├─ worker/     Proses antrian BullMQ
│  └─ web/        React + Vite PWA
├─ packages/
│  ├─ shared/     Skema Zod, tipe, konstanta, design token (dipakai api, worker & web)
│  ├─ core/       Khusus server: logger + redaksi, env, AppError, util Redis/antrian
│  └─ db/         Skema Drizzle, migrasi, klien Postgres (dipakai api & worker)
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ Caddyfile           (mode Caddy bawaan)
│  ├─ nginx/balesin.conf  (contoh untuk reverse proxy yang sudah ada)
│  ├─ install.sh          (curl | bash)
│  └─ balesin             (CLI: update, backup, restore, status, logs)
├─ e2e/                   Playwright
├─ docs/
└─ .claude/
```

## 3. Data utama (ringkas)

`organizations`, `users`, `user_sessions`, `invitations`, `password_resets`,
`roles`/`permissions`, `audit_logs`, `channels` (kredensial terenkripsi),
`contacts`, `contact_tags`, `conversations` (status, assignee, bot_active,
window_expires_at), `messages` (direction, type, wa_message_id unik, status, sender_user_id,
sender_kind: customer/agent/bot/broadcast/system), `attachments`, `notes`, `templates`,
`broadcasts`, `broadcast_recipients`, `bots`, `api_keys`, `webhook_endpoints`,
`webhook_deliveries`, `tickets`, `usage_counters` (biaya pesan per kategori per bulan).

Semua tabel punya `organization_id` (siap jika nanti multi-tenant), `created_at`,
`updated_at`. ID: UUIDv7.

## 4. Alur penting

**Pesan masuk WhatsApp**
1. Meta → `POST /webhooks/whatsapp/:channelId` → verifikasi `X-Hub-Signature-256`.
2. Simpan event mentah (idempotent berdasar `wa_message_id`), balas 200 cepat (< 1 dtk).
3. Worker memproses: upsert kontak, buka/lanjutkan percakapan, perbarui jendela 24 jam,
   unduh media ke storage, siarkan via WebSocket.
4. Jika bot aktif untuk percakapan → kirim event ke bot eksternal (n8n).

**Pesan keluar**: API memvalidasi izin & jendela 24 jam → antre ke worker → worker
memanggil Graph API dengan retry + rate limit → status diperbarui dari webhook status.

**Broadcast**: rancangan → (persetujuan jika > ambang) → worker mengirim bertahap
dengan throttle → status per penerima → laporan.

## 5. Mode jaringan & deploy

Installer mendukung tiga mode:

| Mode | Kapan | Catatan |
|---|---|---|
| **A. Di belakang reverse proxy yang sudah ada** | Perusahaan sudah punya nginx/proxy publik | Balesin hanya buka port di LAN |
| **B. Caddy bawaan + IP publik** | Server punya IP publik sendiri | HTTPS otomatis (Let's Encrypt) |
| **C. Cloudflare Tunnel** | Tanpa IP publik; domain dikelola Cloudflare | Tanpa port terbuka sama sekali |

### Keputusan untuk Sky Tech: **Mode A**

DNS `skytech.net.id` tetap di IDCloudHost. Delegasi satu subdomain saja ke Cloudflare
("subdomain setup") hanya tersedia untuk akun Cloudflare **Enterprise**, sehingga
Cloudflare Tunnel untuk `balesin.skytech.net.id` tidak bisa tanpa memindah seluruh
nameserver. Maka:

- VM Balesin: **IP privat saja**, akses internet keluar lewat NAT seperti VM lain.
- `vm-nginx` (IP publik 198.15.25.13) menambah satu `server` block untuk
  `balesin.skytech.net.id` → proxy ke IP privat VM Balesin. Contoh konfigurasi di
  `deploy/nginx/balesin.conf` (dibuat agent `devops`), termasuk WebSocket, batas
  ukuran upload, rate limit, header keamanan.
- DNS di IDCloudHost: **A record** `balesin` → `198.15.25.13`.
- Sertifikat TLS: Let's Encrypt di vm-nginx (certbot).
- Firewall VM Balesin: hanya terima port aplikasi dari IP privat vm-nginx; SSH hanya dari
  jaringan manajemen.
- Opsi masa depan: domain produk terpisah (mis. `balesin.id`) di Cloudflare → Mode C.

### Lingkungan
- **Lokal** (laptop/PC Tobing): `docker compose -f deploy/docker-compose.dev.yml up`
  untuk postgres+redis, aplikasi jalan dengan `pnpm dev`.
- **Staging** (VM terpisah, opsional) → **Produksi** (VM Balesin).
- Tidak pernah develop langsung di VM produksi.

## 6. Integrasi luar
- **Meta Graph API** (WhatsApp Cloud API; versi API dikunci di config, mis. `v2x.0`,
  diperbarui sengaja).
- **n8n** lewat bot eksternal + REST API + webhook keluar (`API-N8N.md`). n8n Sky Tech ada
  di LAN, jadi webhook keluar ke IP privat harus bisa di-allowlist (`SECURITY.md` §SSRF).
- **Konektor sumber data broadcast** (SKY BILL / BILL SURYA / BILL BAYU): modul konektor
  generik REST dengan pemetaan field, bukan hardcode.
- **SMTP** untuk undangan/reset password (Sky Tech: `balesin@skytech.net.id` dari email
  hosting IDCloudHost).

## 7. Observabilitas
Log terstruktur (pino) tanpa data rahasia, endpoint `/health` & `/ready`, metrik dasar
(antrian, error rate), alarm ke Telegram (dapat diatur) untuk: webhook gagal beruntun,
lonjakan pesan keluar, antrian macet, kuota/biaya melewati ambang.
