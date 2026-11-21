# Kontrak API — Notifikasi Web Push (Fase 2 butir 10)

Notifikasi browser/PWA standar **Web Push** (VAPID, RFC 8030/8291/8292) untuk inbox. Skema Zod:
`packages/shared/src/notifications.ts`. Alamat: `API_ROUTES.notifications`. Manifest PWA & service
worker = web (`apps/web`).

## Alur

1. Web: `GET /notifications/vapid-public-key` → `PushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey })`.
2. Web: `POST /notifications/subscriptions` dengan `PushSubscription.toJSON()`.
3. Kejadian inbox → api/worker mengantre job `notifications` (payload HANYA ID) → worker menentukan
   penerima dari database → push terenkripsi ke layanan push browser.
4. Service worker menerima `PushNotificationPayload`, menampilkan `title`/`body` dengan `tag`
   (satu notifikasi per percakapan), dan saat diklik membuka `url` (path RELATIF aplikasi).

## Endpoint

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/notifications/vapid-public-key` | `inbox.view` | `{ publicKey }` (base64url, 65 byte). Pasangan kunci dibuat otomatis saat pertama diminta, per organisasi; kunci privat terenkripsi di DB (tidak pernah ke browser/log). Tanpa `BALESIN_MASTER_KEY` → **503** |
| `POST /api/v1/notifications/subscriptions` | `inbox.view` | CSRF. Body `{ endpoint, keys: { p256dh, auth }, expirationTime? }` → **201** `{ subscription: { id, createdAt } }`. Langganan terikat SESI pemanggil. Alamat bukan HTTPS ke layanan push yang dikenal → **400**; kunci bukan titik P-256 / `auth` ≠ 16 byte → **400**. Alamat yang sama didaftarkan lagi (pengguna lain di browser yang sama) → pindah ke pemanggil. Maks. 10 perangkat per pengguna (yang tertua dilepas) |
| `DELETE /api/v1/notifications/subscriptions` | `inbox.view` | CSRF. Body `{ endpoint }` (dinormalkan seperti saat mendaftar) → `{ deleted }` — hanya langganan milik pemanggil |
| `GET /api/v1/notifications/preferences` | `inbox.view` | `{ preferences, timezone, devices }` |
| `PUT /api/v1/notifications/preferences` | `inbox.view` | CSRF. Body `NotificationPreferences` → sama dengan GET |
| `POST /api/v1/notifications/test` | `inbox.view` | CSRF. Kirim notifikasi tes ke perangkat SENDIRI → `{ devices }` (0 = belum berlangganan; tidak ada yang diantre). Batas 5/menit |
| `GET /api/v1/settings/notifications` | `organization.manage` | `{ settings: { preview, contactName } }` |
| `PUT /api/v1/settings/notifications` | `organization.manage` | CSRF. Body `{ preview, contactName }` (cuplikan isi pesan / nama kontak di notifikasi; keduanya bawaan MATI). Diaudit `settings.notifications.updated` |

Batas laju tulis: 30/menit per pengguna (`notifikasi-ubah`).

**Layanan push yang dikenal** (cegah SSRF; alamat langganan datang dari browser): HTTPS port bawaan ke
`fcm.googleapis.com`, `android.googleapis.com` (Chrome/Edge/Opera/Samsung), `*.push.services.mozilla.com`
(Firefox), `web.push.apple.com` / `*.push.apple.com` (Safari & PWA iOS 16.4+), `*.notify.windows.com`.
Tanpa kredensial di URL, tanpa fragmen, ≤ 1.024 karakter. Worker memeriksa ulang sebelum mengirim,
tidak mengikuti redirect, batas waktu 10 dtk.

## Preferensi (`NotificationPreferences`)

| Isian | Bawaan | Arti |
|---|---|---|
| `queue` | `true` | Pesan/percakapan di antrian terbuka (Belum dilayani). Hanya untuk peran yang bisa mengambil chat (`inbox.assign`: Owner, Admin, Supervisor, CS) |
| `assignedMessage` | `true` | Pesan masuk di percakapan yang saya pegang |
| `assignedToMe` | `true` | Percakapan ditugaskan/dialihkan ke saya oleh ORANG LAIN |
| `quietHours` | `null` | `{ start: 'HH:MM', end: 'HH:MM' }` zona waktu organisasi; boleh melewati tengah malam; tanpa push selama rentang itu |

Sebutan `@nama` di catatan menyusul bersama fiturnya.

## Siapa menerima apa (worker `apps/worker/src/queues/notifications.ts`)

| Kejadian (job) | Sumber | Penerima |
|---|---|---|
| `message` — pesan masuk baru (bukan reaksi/sistem) | worker webhook, setelah commit; ID job = ID pesan (kiriman ulang Meta tidak dobel) | `served` → pemegangnya (`assignedMessage`); `unserved` → semua pengguna aktif ber-`inbox.assign` (`queue`); `bot`/`resolved` → tidak ada |
| `assigned` — ditugaskan/dialihkan | api (aksi penanganan) | Pemegang baru bila bukan pelakunya sendiri (`assignedToMe`). Mengambil sendiri tidak memicu push |
| `queued` — kembali ke antrian | api (kembalikan / buka lagi tanpa agen) | Pengguna aktif ber-`inbox.assign` kecuali pelaku (`queue`) |
| `test` | api `POST /notifications/test` | Pemanggil sendiri |

Setiap penerima diperiksa ULANG saat job berjalan: aktif, `inbox.view` dalam cakupan (Teknisi hanya
percakapan yang di-assign), preferensi, jam tenang, lalu **jeda gabung 30 dtk** per pengguna per
percakapan (Redis). Langganan hanya dipakai bila SESI pendaftarnya masih berlaku (tidak dicabut,
belum kedaluwarsa, 2FA terpenuhi); selain itu langganannya dihapus. Logout / cabut sesi / nonaktifkan
pengguna / ganti peran (semua sesi dicabut) menghapus langganan sesi itu seketika. Jawaban **404/410**
layanan push → langganan dihapus; jawaban lain dicatat (tanpa isi).

## Isi push (`PushNotificationPayload`)

```json
{ "v": 1, "title": "Pesan baru di inbox", "body": "Buka untuk membaca pesan.",
  "url": "/inbox?chat=<conversationId>", "tag": "chat-<conversationId>", "conversationId": "<uuid>" }
```

- Bawaan TANPA isi pesan (layar kunci). Cuplikan (≤ 80 karakter; media → "Mengirim gambar", dst.)
  hanya bila Owner menyalakan `preview`.
- Nama kontak hanya bila Owner menyalakan `contactName` (review push R1); bawaan judul generik
  "Pesan baru di inbox" dan badan "Buka untuk melihat percakapan." untuk ditugaskan/antrian. Bila
  menyala: nama dari tim, atau nama profil WhatsApp dengan penanda `~` (tidak tepercaya, selaras UI),
  ≤ 60 karakter.
- Judul lain: "Chat ditugaskan ke kamu", "Chat menunggu di antrian" (badan: "Percakapan dengan {nama}"),
  "Notifikasi aktif" (tes; `url` `/inbox`, `tag` `balesin-test`, `conversationId` `null`).
- Terenkripsi `aes128gcm` (RFC 8291); header `TTL` 3600 (tes 300), `Urgency: high`, `Topic` = ID
  percakapan tanpa tanda hubung (push tertunda untuk percakapan yang sama digantikan).
- Isi pesan, nama kontak, dan alamat langganan tidak pernah ditulis ke log.

## Mode jaringan

Web Push butuh akses KELUAR dari worker ke layanan push browser (HTTPS 443). Ketiga mode deploy
(ARCHITECTURE §5) punya akses keluar (NAT/IP publik/tunnel). Bila akses keluar diblokir, push gagal
`unreachable` (dicatat, tidak diulang tanpa batas — 3 percobaan job) dan aplikasi tetap berjalan;
notifikasi di tab yang terbuka (WebSocket) tidak terpengaruh.

## Real-time terkait (inbox)

- `{ type: 'sending.changed', paused }` — rem darurat ditarik/dilepas; untuk banner semua agen.
  Status awal: `GET /api/v1/inbox/sending-status` (`inbox.view`) → `{ paused }`.
