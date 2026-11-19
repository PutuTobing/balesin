# Kontrak API — Inbox: kontak, percakapan, pesan, real-time, ruang chat, panel detail, quick reply (Fase 2 butir 4–9)

Butir ini membangun **model data + pemrosesan otomatis** pesan masuk WhatsApp dan **API baca
minimal** sebagai fondasi layar inbox. Belum ada aksi tulis (assign, balas, selesai, ubah kontak) —
itu butir berikutnya. Skema Zod: `packages/shared/src/inbox.ts`. Alamat: `API_ROUTES.inbox`.

## Model data

| Tabel | Isi penting |
|---|---|
| `contacts` | per organisasi; `number` (nomor publik berurutan), `channel_type`, `wa_bsuid` (BSUID Meta), `phone` (E.164 `+62…`, bisa kosong), `wa_username`, `profile_name` (dari WhatsApp), `name` (diedit tim, mis. `ID+NAMA@AREA`). Unik per (organisasi, jenis channel, BSUID) dan per (organisasi, jenis channel, nomor); minimal salah satu ada |
| `conversations` | satu **sesi** kontak × channel; `number`; `status` `bot`/`unserved`/`served`/`resolved`; `assignee_user_id`; `unread_count`; `last_message_at`; `last_inbound_at` + `window_expires_at` (jendela 24 jam, jam server); `resolved_at`. Paling banyak satu percakapan terbuka (≠ `resolved`) per kontak × channel |
| `messages` | `number`; `direction` `inbound`/`outbound`; `sender_kind` `customer`/`agent`/`bot`/`broadcast`/`system`; `type`; `raw_type` (jenis asli Meta); `wamid` (unik per channel); `text`; `media` (ID media Meta + mime/nama berkas — unduh menyusul); `location`; `extras` (balasan tombol, referral iklan, diteruskan, jumlah kartu kontak); `reply_to_*` (balas-kutip); `reaction_*`; `status` (pesan keluar, hanya maju); `error_code`; `occurred_at` (urutan tampilan) |
| `webhook_events` | tambahan `contact_id` (dikaitkan worker) dan `payload_purged_at` (retensi) |
| `organizations` | tambahan `webhook_payload_retention_days` (bawaan 8, 1–90; UI menyusul) |

`number` di ketiga tabel disiapkan untuk mode kompatibel MobiChat (`conversation_id`/`message_id`
numerik, URL `/inbox/<number>`). Respons API memakai UUID `id` + `number`.

## Pemrosesan pesan masuk (worker, `apps/worker/src/inbound/`)

1. Identitas pengirim: BSUID (`from_user_id`) bila formatnya aman; nomor dari `from`/`wa_id` hanya
   bila lolos E.164. Keduanya tidak sah → kejadian `failed` (`WebhookPayloadError`), tidak ada yang
   dibuat. Nama profil/username dibersihkan dari karakter tak terlihat (pengubah arah, lebar-nol).
2. Kontak dicocokkan BSUID lalu nomor (advisory lock per identitas, lalu baris kontak `FOR UPDATE`):
   identitas yang belum tercatat dilengkapi; ganti nomor (BSUID sama) memperbarui nomor; nomor yang
   kini milik BSUID lain = nomor didaur ulang → dilepas dari kontak lama, kontak baru dibuat; kontak
   hanya-nomor lama + kontak BSUID berbeda tidak digabung otomatis. `name` dari tim tidak pernah
   ditimpa profil WhatsApp.
3. Percakapan terbuka kontak × channel dipakai; bila tidak ada (atau yang terakhir `resolved`) dibuat
   **percakapan baru** berstatus `unserved` (titik kait bot: `initialConversationStatus`).
4. Pesan disimpan idempoten (`wamid`); balas-kutip/reaksi ditautkan ke pesan sasaran hanya bila
   pesan itu milik KONTAK YANG SAMA di channel yang sama (review kontak R1) — selain itu hanya wamid
   sasarannya yang disimpan. `referral.sourceUrl` hanya http(s), nama berkas media dibersihkan
   (`cleanFileName`) — juga saat dibaca api (R2).
5. Pesan pelanggan (selain reaksi & pesan sistem) memperbarui `last_inbound_at` = `received_at`
   kejadian (jam server), `window_expires_at` = +24 jam, `last_message_at`, `unread_count` + 1 —
   dengan `greatest` sehingga kejadian yang diproses tidak urut tidak memundurkan jendela. Reaksi &
   pesan sistem hanya ditempel ke percakapan terbuka/terakhir (tanpa percakapan sama sekali → tidak
   disimpan).
6. Status pesan keluar: dicocokkan `wamid` + channel + arah keluar; hanya maju (`isStatusAdvance`);
   `failed` menyimpan kode error Meta. Pesan tidak dikenal → diabaikan tanpa error.
7. Kejadian `error` tingkat akun: log kode saja.

Tidak ada isi pesan, nomor, nama, atau BSUID di log. Handler tidak pernah `UPDATE channels` (N1).

## Endpoint

Semua `GET`, sesi penuh, respons hanya lewat skema Zod (tanpa payload mentah, BSUID, ID media Meta,
`ctwaClid`). Data di luar cakupan, ID organisasi lain, ID tak dikenal, dan ID bukan UUID → **404
`NOT_FOUND`** yang sama.

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/conversations` | `inbox.view` | Query: `status` (`bot`/`unserved`/`served`/`resolved`; kosong = Semua), `channelId`, `q` (2–100 karakter: nama tim/profil/username, atau potongan nomor ≥ 3 digit — `0812…` juga dicari sebagai `62812…`; `%`/`_` bukan wildcard), `cursor`, `limit` (1–100, bawaan 30). Urut `lastMessageAt` terbaru dulu. → `{ conversations, nextCursor }`. Batas laju per pengguna: 240/menit (`inbox-daftar`) + pencarian 60/menit (`inbox-cari`) → 429 + `Retry-After`; pencarian > 3 detik → 503 "Pencarian terlalu lama. Persempit kata kuncinya lalu coba lagi." |
| `GET /api/v1/conversations/:conversationId` | `inbox.view` | → `{ conversation }` |
| `GET /api/v1/conversations/:conversationId/messages` | `inbox.view` | Terbaru dulu; `nextCursor` = halaman pesan yang lebih lama. → `{ messages, nextCursor }` |
| `GET /api/v1/contacts/:contactId` | `contacts.view` | → `{ contact }` |

Cakupan (PRD §4): Owner/Admin/Supervisor/CS = semua; **Teknisi** = percakapan yang
`assignee_user_id`-nya dirinya, dan kontak yang punya percakapan seperti itu (tiket menyusul).

### Bentuk `Conversation`
`id`, `number`, `status`, `channel {id,name,type}`, `contact {id,number,displayName,phone}`,
`assignee {id,name} | null`, `unreadCount`, `lastMessageAt`, `lastInboundAt`, `windowExpiresAt`,
`windowOpen` (dihitung saat respons), `lastMessage {direction,type,text (≤ 200),status,createdAt} |
null`, `createdAt`, `resolvedAt`. `displayName` = nama tim → nama profil → nomor → `@username` →
`Kontak #n`.

### Bentuk `Message`
`id`, `number`, `direction`, `senderKind`, `type`, `rawType`, `text`, `media {kind,mimeType,filename,
voice,animated} | null`, `location`, `interactive {kind,id,title,description}`, `reaction {emoji,
messageId}`, `replyTo {messageId}`, `referral {sourceType,sourceUrl,headline,body}` (**`sourceUrl`
tidak tepercaya — tampilkan sebagai teks**), `forwarded`, `sharedContactsCount`, `status`,
`errorCode`, `createdAt`. Semua teks = input pelanggan: wajib di-escape di web.

### Kursor
Base64url dari `<waktu mikrodetik UTC>|<uuid>`; rusak/dibuat-buat → 400 `VALIDATION_ERROR`
("Kursor halaman tidak valid. Muat ulang daftar dari awal.").

## Saringan, hitungan per tab, tandai dibaca (butir 5)

Saringan bersama `GET /conversations` dan `GET /conversations/counts`:

| Query | Nilai | Arti |
|---|---|---|
| `channelId` | UUID | channel tertentu |
| `assignee` | UUID / `me` / `unassigned` | agen percakapan |
| `window` | `open` / `expiring` / `expired` / `none` | jendela 24 jam: terbuka (sisa > 2 jam) / hampir habis (sisa ≤ 2 jam, `WINDOW_EXPIRING_SOON_MS`) / kedaluwarsa / belum pernah ada pesan masuk (label UI "Broadcast") — dihitung dari jam server saat query |
| `unread` | `true` / `false` | punya pesan belum dibaca / tidak |
| `q` | 2–100 karakter | cari (lihat atas) |
| tag | — | **titik kait**: `tagId` ditambahkan saat tabel tag dibangun |

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/conversations/counts` | `inbox.view` | Saringan di atas (tanpa `status`). → `{ counts: { all, bot, unserved, served, resolved }, unreadOpen }` sesuai cakupan pemanggil (Teknisi: hanya yang di-assign). `unreadOpen` = percakapan terbuka yang punya pesan belum dibaca (badge menu). Batas laju sama dengan daftar (`q` → ember cari + `statement_timeout`) |
| `POST /api/v1/conversations/:conversationId/read` | `inbox.view` (cakupan) | Wajib `Origin` aplikasi + `X-CSRF-Token`. `unread_count = 0`; idempoten. → `{ conversation }`; di luar cakupan/tak dikenal → 404. Bila berubah, event `conversation.updated` diterbitkan |

Penghitung belum dibaca **per percakapan** (dipakai bersama tim, seperti MobiChat) — bukan per
pengguna (DECISIONS 2026-11-16).

## Real-time — WebSocket `GET /api/v1/inbox/stream` (butir 5)

**Sambungan.** `new WebSocket('wss://<host>/api/v1/inbox/stream')` dari origin aplikasi. Autentikasi =
cookie sesi yang sama dengan REST (tidak ada token di URL). Ditolak SEBELUM upgrade dengan jawaban
HTTP biasa:

| Kondisi | HTTP |
|---|---|
| tanpa sesi / sesi tidak sah | 401 `UNAUTHENTICATED` |
| sesi terbatas 2FA / peran tanpa `inbox.view` | 403 |
| `Origin` bukan origin aplikasi (termasuk tanpa `Origin`) | 403 `FORBIDDEN` + audit `auth.csrf.rejected` |
| sudah 10 socket terbuka untuk pengguna ini (per proses api) | 429 `RATE_LIMITED` |
| GET biasa tanpa `Upgrade: websocket` (navigasi) | 404, tanpa pemeriksaan Origin/audit |

**Pesan server → klien** (JSON, `inboxStreamEventSchema`). Isinya hanya ID + status — TANPA isi pesan,
nama, nomor, atau BSUID; klien mengambil detail lewat REST (cakupan ditegakkan lagi):

| `type` | Isian | Kapan |
|---|---|---|
| `hello` | `heartbeatSeconds` | tepat setelah tersambung |
| `conversation.updated` | `conversationId`, `status`, `assigneeUserId`, `unreadCount`, `lastMessageAt`, `windowExpiresAt` | pesan masuk baru, tandai dibaca (nanti: assign, selesai) |
| `message.created` | `conversationId`, `messageId`, `direction`, `createdAt` | pesan tersimpan (masuk; nanti keluar) |
| `message.status` | `conversationId`, `messageId`, `status` | status pesan keluar maju |
| `resync` | — | (Fase 4) terlalu banyak event untuk organisasi ini (mis. broadcast besar): event dibuang — web WAJIB memuat ulang daftar, hitungan, dan percakapan yang terbuka lewat REST |

**Penggabungan (Fase 4, `docs/KONTRAK-API-BROADCAST.md`).** Event dari Redis digabung per 250 ms; > 20 `message.status` dalam satu jendela per organisasi diganti `conversation.updated` percakapannya (centang diperbarui saat riwayat dimuat ulang); maks. 200 event/detik per organisasi, kelebihannya → satu `resync` per 2 detik.

Klien → server: tidak ada perintah; pesan diabaikan (maks. 1 KiB, lebih → ditutup 1009).

**Penyaringan per penerima (server).** Setiap event dibaca ulang dari database (keadaan terbaru,
terfilter organisasi), lalu dikirim hanya ke socket yang cakupan `inbox.view`-nya mencakup
percakapan itu: Owner/Admin/Supervisor/CS semua; Teknisi hanya bila dia `assigneeUserId`-nya.
Catatan: Teknisi yang percakapannya dialihkan ke orang lain tidak menerima event berikutnya untuk
percakapan itu — klien memuat ulang daftar saat tersambung lagi / berkala.

**Kode penutupan** (`INBOX_STREAM_CLOSE_CODES`): `4401` sesi berakhir/dicabut/akun dinonaktifkan/2FA
kini wajib (web → halaman masuk); `4403` peran tidak lagi boleh melihat inbox; `4408` tidak menjawab
heartbeat; `4429` terlalu banyak koneksi; `1001` server berhenti. Selain 4401/4403: sambung ulang
dengan jeda bertambah (mis. 1, 2, 5, 10, 30 detik) lalu muat ulang daftar & hitungan lewat REST
(event selama terputus tidak diulang).

**Heartbeat & validasi ulang.** Server mengirim ping WebSocket tiap 30 detik (browser menjawab pong
otomatis); tanpa pong sampai ping berikutnya → 4408. Tiap 30 detik sesi divalidasi ulang tanpa
memperpanjang batas idle (socket terbuka tidak membuat sesi abadi; putaran tidak pernah tumpang
tindih); perubahan peran langsung mengubah cakupan event. Logout, cabut sesi, nonaktifkan, ganti
peran, dan atur ulang password/2FA juga menerbitkan sinyal `session.revoked` sehingga socket
terkait ditutup 4401 dalam ±2 detik.

**Jalur event.** Worker (pesan masuk/status) dan api (tandai dibaca) menerbitkan event berisi ID ke
Redis pub/sub `<awalan>:inbox-events` SETELAH transaksi commit; tiap proses api berlangganan dan
mengantar ke socket miliknya. Pub/sub = paling banyak sekali; kegagalan Redis tidak menggagalkan
pemrosesan (hanya log).

**Proxy (devops, Fase 7).** Reverse proxy wajib meneruskan upgrade WebSocket untuk
`/api/v1/inbox/stream` (`proxy_http_version 1.1`, `Upgrade`/`Connection`, `proxy_read_timeout` > 30
detik). Dev server web perlu `ws: true` pada proxy `/api`.

## Ruang chat — kirim pesan & media (butir 6)

| Endpoint | Izin | Keterangan |
|---|---|---|
| `POST /api/v1/conversations/:conversationId/messages` | `inbox.reply` (cakupan) | CSRF. Body `sendMessageRequestSchema` (`type`: `text` / `media` / `location` / `reaction`, `clientMessageId` UUID wajib). → **202** `{ message }` (status `pending`) atau **200** bila `clientMessageId` yang sama sudah pernah dikirim (idempoten, per pengirim) |
| `POST /api/v1/conversations/:conversationId/media` | `inbox.reply` (cakupan) | CSRF, `multipart/form-data` isian `file` (satu berkas). → **201** `{ media: { id, kind, mimeType, filename, sizeBytes } }`; lalu kirim `{ type: 'media', mediaId: id, caption? }` |
| `POST /api/v1/messages/:messageId/retry` | `inbox.reply` (cakupan) | CSRF. Hanya pesan keluar `failed` yang `failure.retryable` (maks. 5 percobaan). → **202** `{ message }` (`pending`). `senderUserId` tetap penulis asli (pemilik kunci idempotensi); penekan "Kirim ulang" dicatat di `last_sent_by_user_id` dan dialah yang diperiksa ulang worker (review R2) |
| `GET /api/v1/messages/:messageId/media` | `inbox.view` (cakupan) | **Wajib `X-CSRF-Token`** walau GET (memakai jatah Meta + menulis cache) — web memanggil lewat `fetch` lalu `Blob`/`URL.createObjectURL`, bukan `<img src>`. Berkas biner (lihat Header) |

**Jendela 24 jam ditegakkan server**: di luar jendela → **409 `WINDOW_CLOSED`** (pesan: tunggu
pelanggan membalas atau kirim template). Diperiksa lagi oleh worker saat benar-benar mengirim.
Template Meta = fase berikutnya (titik kait di `outbound.service.ts`).

**Jenis pesan.**
- `text`: 1–4.096 karakter, tanpa NUL; `replyToMessageId` opsional (balas-kutip).
- `media`: `mediaId` dari unggahan pengguna yang SAMA di channel percakapan itu, belum kedaluwarsa;
  `caption` ≤ 1.024 (diabaikan untuk audio). Jenis pesan = jenis berkas hasil deteksi.
- `location`: `latitude`, `longitude`, `name?`, `address?`.
- `reaction`: `targetMessageId` + `emoji` (satu emoji; `''` = hapus reaksi).
- Pesan yang dikutip/diberi reaksi harus milik kontak & channel yang sama dan sudah punya wamid
  (belum terkirim → 409).

**Unggahan.** Jenis ditentukan dari ISI (magic bytes), bukan nama/`Content-Type`:
gambar JPEG/PNG ≤ 5 MB; audio OGG/MP3/AAC/M4A/AMR ≤ 16 MB; video MP4/3GP ≤ 16 MB; dokumen PDF,
Word/Excel/PowerPoint (lama & baru), TXT ≤ 100 MB. Selain itu **415**, terlalu besar **413**.
Berkas dialirkan ke `MEDIA_DIR/tmp` (tidak dibaca utuh ke memori) dan pembacaan BERHENTI begitu
melewati batas jenisnya (jenis dari 64 KiB pertama) → 413. Office: ZIP wajib memuat
`[Content_Types].xml` + folder sesuai ekstensi (`word/`, `xl/`, `ppt/`), tanpa `vbaProject.bin`/program
tersisip; Word/Excel/PowerPoint lama (CFB) dengan aliran makro (`_VBA_PROJECT`, `VBA`, `Macros`) → 415.
Maks. 4 unggahan berjalan per proses dan 2 per pengguna; selebihnya **429** "coba lagi". Nama
berkas dibersihkan (`cleanFileName`). Disimpan di `MEDIA_DIR/uploads/<uuid>` lalu diunggah ke Meta
(`/{phone-number-id}/media`); salinan lokal & ID Meta berlaku `min(retensi organisasi, 29)` hari.
Batas laju 20 unggahan/menit per pengguna. Tidak ada URL dari klien (tanpa SSRF).

**Unduhan media masuk.** Pertama kali: `GET /{media-id}` → URL → unduh dengan token hanya dari
`https://lookaside.fbsbx.com` (server tiruan di dev/test), tanpa redirect, maks. 100 MB → disimpan
`MEDIA_DIR/inbound/<uuid>` (retensi organisasi, bawaan 30 hari) lalu disajikan dari cache.
Dialirkan ke disk, single-flight per pesan (permintaan bersamaan menunggu SATU unduhan & satu baris
`media_files`); dibatalkan bila semua peminta memutus. Maks. 4 unduhan berjalan per proses dan 2 per
pengguna → selebihnya **429**. Channel nonaktif/terhapus → unduhan BARU **404** (salinan cache tetap
bisa dibaca). Dokumen Office masuk yang gagal pemeriksaan makro disajikan sebagai biner.

Header unduhan: `Content-Type` = hasil deteksi isi bila termasuk gambar/audio/video yang aman
(`inline`), selain itu `application/octet-stream` + `attachment` (PDF, dokumen, tak dikenali; SVG/HTML
tidak pernah inline); `Content-Disposition` dengan `filename` ASCII + `filename*=UTF-8''…`
(RFC 5987); `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none';
sandbox`; `Cache-Control: private, max-age=300`. Batas 120 unduhan/menit per pengguna.

**Batas kirim**: 30 pesan/menit per pengguna dan 600/menit per organisasi → 429, ditambah batas
harian, per percakapan, dan rem darurat (lihat "Batas kirim & rem darurat").

**Status & kegagalan.** Pesan keluar `pending` → worker mengirim → Meta menerima (wamid tersimpan,
masih `pending`) → webhook `sent` → `delivered` → `read` (hanya maju). Status yang datang sebelum
wamid tersimpan diputar ulang dari `webhook_events`. `failed` membawa `failure: { reason, code,
message, retryable }` — `message` menjelaskan penyebab + solusi (mis. 131047 di luar jendela, 131026
tidak terkirim, 130429 batas laju, 131049, 131051, 131053, 131030, 190 token). Alasan
(`OUTBOUND_FAILURE_REASONS`): `window_closed`, `channel_unavailable`, `recipient_unavailable`
(pelanggan username tanpa nomor — kirim ke BSUID menyusul), `sender_not_allowed`,
`media_unavailable`, `meta_rejected`, `delivery_failed` (webhook), `delivery_unknown` (koneksi putus;
TIDAK diulang otomatis — bisa saja sudah terkirim), `credentials_unavailable`, `queue_unavailable`,
`sending_paused` (rem darurat ditarik; bisa dikirim ulang setelah dilanjutkan).

**Worker** (`apps/worker/src/queues/messages.ts`, antrian `messages`, payload ID saja): memeriksa
ULANG saat kirim — channel aktif, pengirim aktif & masih memegang `inbox.reply` dalam cakupan
percakapan (Teknisi: agen percakapan), jendela 24 jam, media, nomor pelanggan. Kirim lewat klien
Graph terpusat (kelompok laju `messaging`, tidak diulang otomatis oleh klien). Batas laju/gangguan
sementara Meta → diulang BullMQ (5×, eksponensial mulai 10 dtk). Tanpa kunci/transaksi selama
panggilan HTTP. Sebelum memanggil Meta, worker MENGKLAIM pesan secara atomik (`send_claimed_at`);
pesan yang sudah diklaim tanpa wamid → `delivery_unknown` (cegah kirim ganda, review R3). Klaim
dilepas hanya bila Meta jelas menolak sementara. Rem darurat diperiksa ulang di worker.
Review R5: klaim yang lebih muda dari 2 menit (`SEND_CLAIM_STALE_MS`) = percobaan lain masih
memanggil Meta → job ganda DILEWATI (pesan tetap `pending`). Job `maintenance`
`stale-send-claims` (tiap menit) menandai klaim > 2 menit tanpa wamid → `delivery_unknown`. Bila
Meta ternyata menerima belakangan, wamid tetap disimpan dan status dibetulkan menjadi `sent`.

**Bentuk `Message` (tambahan)**: `failure`, `senderUserId`, `senderName` (nama tampilan agen pengirim pesan keluar, tanpa email — semua peran yang melihat percakapan, termasuk Teknisi, melihat nama pengirim tanpa `/inbox/agents`), `mediaAvailable`.

**Pembersih media** (retensi/hapus kontak) juga mengosongkan `filename`, `sha256` (diisi nol) dan ID
media Meta (review R4). Lokasi: NUL di `name`/`address` → 400.


## Batas kirim & rem darurat (review ruang chat S2)

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/settings/sending-limits` | `sending.limits.manage` | `{ limits: { dailyPerUser, dailyPerOrganization, perConversationPerMinute, paused: { at, by: {id,name}|null, reason }|null, sentLast24Hours } }` |
| `PUT /api/v1/settings/sending-limits` | `sending.limits.manage` | Body `{ dailyPerUser (1–100.000), dailyPerOrganization (1–1.000.000), perConversationPerMinute (1–120), confirmation }` — **wajib konfirmasi identitas** (password + kode 2FA). Diaudit `settings.sending_limits.updated` (nilai lama & baru); oleh selain Owner → banner `warning` |
| `POST /api/v1/settings/sending-limits/pause` | `sending.limits.manage` | **Rem darurat** — body `{ reason? }` (≤ 200). TANPA konfirmasi (arah aman, harus cepat). Semua pengiriman keluar berhenti seketika (api + worker). Audit `sending.paused` + banner `warning` + email ke semua Owner |
| `POST /api/v1/settings/sending-limits/resume` | `sending.resume` | Body `{ confirmation }` — wajib konfirmasi identitas. Audit `sending.resumed` |

Bawaan: 500 pesan/pengguna/24 jam, 5.000/organisasi/24 jam (bergulir, dihitung dari tabel
`messages`), 20 pesan/percakapan/menit. Nilai di DB (`organizations.send_*`), bukan `.env`.

Saat mengirim/kirim ulang: rem ditarik → **423 `SENDING_PAUSED`**; batas harian pengguna atau
organisasi → **429** (pesan menyebut batasnya; audit `sending.limit_reached` + email ke semua Owner,
paling banyak sekali per 24 jam per cakupan); batas per percakapan → **429**. Pesan yang sudah
diantre saat rem ditarik gagal dengan alasan `sending_paused` (bisa dikirim ulang setelah dilanjutkan).

Kejadian keamanan baru di ringkasan (`SECURITY_EVENT_KINDS`): `sending_paused` (warning),
`sending_limit_reached` (warning), `sending_limits_changed` (info; warning bila oleh selain Owner;
termasuk "dilanjutkan").

**Status untuk semua agen** (butir 10): `GET /api/v1/inbox/sending-status` (`inbox.view`) →
`{ paused }` tanpa rincian batas/pelaku; event WebSocket `{ type: 'sending.changed', paused }` saat
rem ditarik/dilepas — banner tampil sebelum agen terkena 423.

## Penanganan percakapan (butir 7)

| Endpoint | Izin | Keterangan |
|---|---|---|
| `POST /api/v1/conversations/:id/claim` | `inbox.assign` | Ambil dari antrian terbuka (`unserved`) atau ambil alih dari `bot` → `served`, agen = diri. Atomik (kunci baris): dua agen bersamaan → satu 200, lainnya **409** "Percakapan ini sudah diambil {nama}." |
| `POST /api/v1/conversations/:id/assign` | `inbox.assign` | Body `{ userId }`. Sasaran aktif, satu organisasi, perannya memegang `inbox.reply` (Teknisi boleh) — selain itu 400. → `served`. Percakapan selesai → 409 |
| `POST /api/v1/conversations/:id/unassign` | `inbox.reply` + cakupan | Kembali ke antrian (`unserved`). Tanpa `inbox.assign` (Teknisi) hanya chat miliknya (milik orang lain = 404 karena di luar cakupan) |
| `POST /api/v1/conversations/:id/resolve` | `inbox.reply` + cakupan | `resolved` + `resolvedAt`; agen tetap tercatat (laporan). Idempoten |
| `POST /api/v1/conversations/:id/reopen` | `inbox.reply` + cakupan | Hanya sesi TERAKHIR kontak × channel dan bila belum ada sesi terbuka → `served` (agen lama bila masih aktif & berizin) atau `unserved`; selain itu 409. Jendela 24 jam tidak menjadi syarat (pengiriman tetap dibatasi jendela) |
| `GET /api/v1/conversations/:id/events` | `inbox.view` + cakupan | Riwayat penanganan (tab "Log"): `{ events: [{ id, kind, actor, assignee, previousAssignee, createdAt }] }` — `kind`: `claimed`/`assigned`/`unassigned`/`resolved`/`reopened`; `actor` `null` = sistem |
| `GET /api/v1/inbox/agents` | `inbox.assign` | `{ agents: [{ id, name, role, active, openConversations }] }` — semua pengguna berperan `inbox.reply` (termasuk nonaktif untuk saringan percakapan lama; hanya `active` yang bisa ditugaskan). Tanpa email. Teknisi → 403 (review butir 7 Info 1; ia tidak menugaskan/menyaring per agen) |

**Alarm aksi massal** (review butir 7 R1 + R2): > 30 ambil/tugaskan/selesai/kembalikan oleh SATU pengguna dalam
10 menit → audit `inbox.bulk_action` (`actions`, `windowMinutes`, `kinds`, `actorRole`) + kejadian
keamanan `inbox_bulk_action` (`warning`, banner Owner/Admin), paling banyak sekali per jam per
pengguna. Aksinya sendiri tidak ditolak.

Semua POST: CSRF (Origin + token), batas 120 aksi/menit per pengguna (`inbox-aksi`). Jawaban
`{ conversation }` = keadaan sesudah aksi menurut cakupan pemanggil; **`null`** bila pemanggil tidak
lagi boleh melihatnya (mis. Teknisi mengembalikan chat-nya).

Satu transaksi per aksi: pelaku diperiksa ulang (`assertActorStillAuthorized`, peran SEKARANG untuk
cakupan) → baris percakapan dikunci `FOR UPDATE` dengan saringan cakupan → perubahan + baris
`conversation_events`. Setelah commit: event `conversation.updated`; bila agen berubah, agen lama
yang kehilangan akses (Teknisi) menerima **`conversation.removed`** `{ conversationId }` lewat
WebSocket dan tidak lagi menerima event percakapan itu.

Kolom laporan pada `Conversation`: `firstAssignedAt` (pertama diambil/ditugaskan), `firstResponseAt`
(pesan keluar pertama agen, selain reaksi), `resolvedAt`.

Pesan masuk ke percakapan `served` tetap pada agennya; ke percakapan `resolved` membuka sesi baru.

Titik kait (menyusul): penugasan otomatis round-robin + kapasitas maks. per agen (pelaku `null`),
departemen (menyempitkan cakupan & agen sasaran), CSAT setelah `resolve`.

Ringkasan kontak di daftar percakapan kini memuat `nameSource` (`team` / `whatsapp` / `none`) dan
`waUsername` — tampilkan penanda "dari WhatsApp" + nomor/@username di samping nama profil.

## Panel detail (butir 8)

Skema: `packages/shared/src/inbox.ts`, `tags.ts`. Semua tulis: CSRF (Origin + token), batas 120
perubahan/menit per pengguna (`panel-ubah`), pelaku diperiksa ulang di transaksi
(`assertActorStillAuthorized`), semua query tersaring `organization_id`. Event real-time HANYA ID.

**Tag (menempel ke KONTAK).** Sama dengan API n8n/MobiChat (`/contacts/:id/tags`). Warna = kunci
palet `TAG_COLORS` (`gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, `teal`) — web
memetakannya ke token desain; bukan hex.

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/tags` | `inbox.view` | `{ tags: [{ id, name, color, contactCount, createdAt, updatedAt }] }` urut nama |
| `POST /api/v1/tags` | `contacts.manage` | Body `{ name (1–40, satu baris), color? (bawaan blue) }` → **201** `{ tag }`. Nama unik tanpa beda huruf besar/kecil → **409**. Maks. 300 tag/organisasi (409). Diaudit `tag.created` |
| `PATCH /api/v1/tags/:tagId` | `settings.workspace.manage` | Body `{ name?, color? }` → `{ tag }`. Diaudit `tag.updated` (nama/warna lama & baru) |
| `DELETE /api/v1/tags/:tagId` | `settings.workspace.manage` | Lepas dari semua kontak + hapus → `{ deleted: true }`. Diaudit `tag.deleted` |
| `POST /api/v1/contacts/:contactId/tags` | `contacts.manage` | Body `{ tagId }` → `{ contact }`. Idempoten. Maks. 20 tag/kontak (409). Tag tak dikenal → 404 |
| `DELETE /api/v1/contacts/:contactId/tags/:tagId` | `contacts.manage` | → `{ contact }`. Idempoten |

Saringan daftar & hitungan: `GET /conversations?tagId=` dan `/conversations/counts?tagId=` =
percakapan yang KONTAKNYA memakai tag itu. `Conversation.contact.tags` dan `Contact.tags` =
`[{ id, name, color }]` (urut nama).

**Ubah kontak.** `PATCH /api/v1/contacts/:contactId` (`contacts.manage`; Teknisi hanya melihat) →
`{ contact }`. Body (minimal satu): `name` (≤ 256, satu baris; `null` = kembali ke nama profil
WhatsApp), `email` (dinormalkan huruf kecil; `null` = hapus), `notes` (catatan KONTAK ≤ 2.000, boleh
baris baru; `null` = hapus), `attributes` (MENGGANTI daftar: maks. 30 `{ key, value }`, kunci 1–40
huruf/angka/spasi/`._-` unik tanpa beda huruf, nilai 1–500 satu baris). `Contact` kini memuat
`email`, `notes`, `attributes`, `tags`.

**Riwayat kontak** (`contact_events`): `tag_added`/`tag_removed` (nama & warna tag saat kejadian),
`contact_updated` (`fields`: nama isian yang berubah) — TANPA nilai data pelanggan. Bukan audit log
(perubahan data pelanggan sehari-hari tidak membanjiri audit). Tampil di tab "Log" setiap percakapan
kontak itu sejak percakapan dibuat.

**Catatan sesi** (internal, tidak pernah terkirim ke pelanggan):

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/conversations/:id/notes` | `inbox.view` + cakupan | `{ notes: [{ id, body, author: {id,name}, createdAt, updatedAt, edited, canEdit, canDelete }] }` terlama dulu |
| `POST /api/v1/conversations/:id/notes` | `inbox.reply` + cakupan | Body `{ body }` (1–2.000, boleh baris baru) → **201** `{ note }`. Maks. 200/percakapan (409) |
| `PATCH /api/v1/conversations/:id/notes/:noteId` | `inbox.reply` + cakupan | HANYA penulisnya (selain itu **403**, diaudit `auth.access.denied` aturan `inbox.note.edit_others`) → `{ note }` (`edited: true`) |
| `DELETE /api/v1/conversations/:id/notes/:noteId` | `inbox.reply` + cakupan | Penulisnya, atau pemegang `inbox.notes.moderate` (Owner/Admin); selain itu **403** (`inbox.note.delete_others`) → `{ deleted: true }` |

`canEdit`/`canDelete` = hak PEMANGGIL (untuk tombol). Log mencatat `note_added`/`note_updated`/
`note_deleted` tanpa isi. Isi catatan tidak pernah masuk log server, audit, atau event.

**Pesan ditandai** (bintang, satu tanda bersama per pesan): `PUT` / `DELETE
/api/v1/messages/:messageId/star` (`inbox.reply` + cakupan; di luar cakupan 404) → `{ message }`.
Idempoten. `Message.starredAt` (`null` = tidak ditandai).

**Media, file, pesan ditandai** di panel: `GET /conversations/:id/messages?only=starred|media|files`
(kursor sama dengan riwayat pesan): `media` = gambar/video/stiker, `files` = dokumen/audio.

**Log**: `GET /conversations/:id/events` kini memuat juga `note_*` dan kejadian kontak
(`tag_added`, `tag_removed`, `contact_updated`), dengan isian tambahan `tag: { name, color } | null`
dan `fields: string[] | null`.

Notifikasi push: lihat `docs/KONTRAK-API-NOTIFIKASI.md` (butir 10).

**Real-time** (WebSocket, hanya ID): `{ type: 'conversation.detail', conversationId, section }` —
`section` = `tags` / `contact` / `notes` / `stars`; dikirim ke pengguna yang boleh melihat percakapan
itu (perubahan kontak → maks. 20 percakapan terbaru kontak itu). `{ type: 'tags.changed' }` — master
tag berubah (semua pemegang `inbox.view`).

**Kompatibilitas skema web**: `contact.tags`, `Contact.email/notes/attributes`, `Message.starredAt`,
dan `ConversationEvent.tag/fields` OPSIONAL di skema Zod (server selalu mengisinya) supaya data tiruan
web lama tetap sah — dijadikan wajib setelah web menyesuaikan.

## Quick reply `/` (butir 9)

Skema: `packages/shared/src/quick-replies.ts`.

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/quick-replies?q=` | `inbox.reply` | `{ quickReplies: [{ id, shortcut, title, body, usageCount, lastUsedAt, updatedBy, createdAt, updatedAt }] }` — urut paling sering dipakai lalu shortcut; `q` (≤ 50) mencari shortcut/judul. Maks. 500 |
| `POST /api/v1/quick-replies` | `quick_replies.manage` | Body `{ shortcut, title (≤ 80), body (≤ 3.500) }` → **201**. Shortcut: `/` di depan dibuang, huruf kecil, `[a-z0-9_-]`, ≤ 32; kembar → **409**. Maks. 500/organisasi |
| `PATCH /api/v1/quick-replies/:id` | `quick_replies.manage` | Isian sebagian → `{ quickReply }` |
| `DELETE /api/v1/quick-replies/:id` | `quick_replies.manage` | → `{ deleted: true }` |
| `POST /api/v1/quick-replies/:id/use` | `inbox.reply` + cakupan percakapan | Body `{ conversationId }` → `{ text }` (variabel terisi) + penghitung naik. Percakapan di luar cakupan → 404. Batas 240/menit per pengguna |

Variabel HANYA `{nama}` (nama dari tim → nama profil WhatsApp → "Kak") dan `{agen}` (nama pemakai);
bentuk `{kata}` lain ditolak saat menyimpan (400). Teks hasil dimasukkan ke composer lalu dikirim
lewat endpoint kirim pesan biasa (jendela 24 jam & batas kirim tetap berlaku). Buat/ubah/hapus
diaudit (`quick_reply.*`: shortcut, nama isian yang berubah, isi lama → baru UTUH (≤ 3.500), juga
isi terakhir saat dihapus — teks bisnis, bukan data pelanggan; review panel R1/R2). Tautan (dengan
atau tanpa skema, mis. `bayar-aman.co`) atau angka ≥ 8 digit yang BARU ditambahkan oleh selain Owner →
`risky: true` + kejadian keamanan `quick_reply_risky` (warning).

## Retensi & hapus per kontak (UU PDP, review webhook S4)

- Job `maintenance` (`webhook-payload-retention`, tiap jam, BullMQ Job Scheduler) mengosongkan
  `payload` kejadian `processed`/`skipped`/`failed` yang `received_at`-nya lebih tua dari
  `organizations.webhook_payload_retention_days` (`{}` + `payload_purged_at`). Kunci dedup tetap.
  Kejadian macet `pending` lebih lama dari retensi organisasi → `failed` (`expired_pending`) dan
  dikosongkan. Baris dihapus seluruhnya setelah `max(35 hari, retensi organisasi)` (review kontak R5).
- Kejadian field lain (`other`) hanya menyimpan `{ wabaId, valueSha256 }` sejak diterima (baris lama
  diubah migrasi 0012).
- `deleteContactData(tx, organizationId, contactId)` (`apps/api/src/modules/contacts/contacts.repo.ts`):
  hapus pesan, percakapan, kontak; kosongkan payload `webhook_events` yang dikaitkan atau cocok
  identitasnya; kejadian `pending` → `skipped` (`contact_deleted`). Baris + kunci dedup tetap, jadi
  kiriman ulang Meta tidak menghidupkan kontak. Juga menghapus tag kontak, riwayat kontak, dan
  catatan sesi.

**Hapus kontak** — `DELETE /api/v1/contacts/:contactId` (`contacts.delete` = Owner/Admin). CSRF; body
`{ confirmation }` WAJIB (password + kode 2FA; tanpa → 400 `confirmation.password`). Satu transaksi:
pelaku diperiksa ulang → `deleteContactData` → audit `contact.deleted` (HANYA ID kontak + jumlah:
`messages`, `conversations`, `webhookEvents`, `hadOpenConversation`, `actorRole` — tanpa nama, nomor,
isi). Kontak dengan percakapan TERBUKA tetap boleh dihapus (permintaan UU PDP tidak menunggu chat
selesai; tercatat `hadOpenConversation`). Setelah commit: berkas media langsung dihapus dari disk
(HANYA berkas kontak itu, `purgeMediaFiles`, review R4 + Info) dan setiap percakapannya
diumumkan `conversation.removed` (`{ conversationId }`) ke pemegang `inbox.view` yang cakupannya
mencakup percakapan itu (agen terakhir dibawa event; Teknisi lain tidak menerimanya). → `{ deleted: { messages, conversations,
webhookEvents, mediaFiles } }`; kontak tak dikenal → 404.

**Ekspor data satu kontak** (permintaan akses data) — `GET /api/v1/contacts/:contactId/export`
(`contacts.export` = Owner/Admin/Supervisor; 20/jam per pengguna; **wajib `X-CSRF-Token`** — GET
ber-efek-samping, review R1: web memanggil lewat `fetch` lalu `Blob`) → JSON `contactExportSchema`
(`Content-Disposition: attachment; filename="kontak-<nomor>.json"`, `Cache-Control: no-store`): data
kontak (nomor, username, nama tim & profil, email, catatan kontak, atribut, nama tag), percakapan
(nomor, channel, status, waktu), pesan (arah, jenis, teks, nama/jenis media, lokasi, status, waktu;
maks. 10.000 — lebih → `truncated: true`). TIDAK memuat ID internal Meta (BSUID, ID media), catatan
sesi internal tim, atau berkas media. Diaudit `contact.exported` (ID + jumlah). Ekspor massal &
berkas media menyusul (Fase 4).

## Jejak kejadian yang ditolak database (review webhook N2)

Baris yang ditolak Postgres saat disimpan penerima diganti **baris stub tanpa payload**:
`status = 'failed'`, `last_error = 'rejected:<kode>'`, kunci dedup + wamid, `payload_purged_at`
terisi. Dihitung dengan `countRejectedWebhookEvents` (untuk layar diagnosis nanti). Bila stub pun
ditolak → log `error`.

## Bot eksternal (Fase 3)

Bot = penerima webhook keluar (native atau format MobiChat) yang membalas lewat API key
(docs/KONTRAK-API-PUBLIK.md, docs/KONTRAK-API-MOBICHAT.md). Skema: `packages/shared/src/bot.ts`.

**Saklar bot channel** — `GET`/`PUT /api/v1/settings/channels/:channelId/bot` (`integrations.manage`,
Owner/Admin; PUT ber-CSRF, 30/menit, diaudit `channel.bot_updated` tanpa data pelanggan — metadata
memuat `channelType` — tanpa konfirmasi identitas, bisa dibalik kapan saja). **Berlaku untuk SEMUA
jenis channel** (WhatsApp, Telegram, Email, Messenger, Instagram — DECISIONS 2026-11-19): `:channelId`
= ID dari `GET /settings/channels` (WhatsApp) atau `GET /settings/channel-connections` (channel lain);
perilaku, batas waktu, handoff, dan saklar per percakapan sama persis.

```json
{ "enabled": true,
  "hours": { "mode": "always" }  |  { "mode": "schedule", "windows": [{ "day": 1, "start": "08:00", "end": "17:00" }] },
  "timeoutMinutes": 10 }
```

- `day` 0 = Minggu … 6 = Sabtu, `HH:MM` 00:00–24:00, mulai < selesai (lewat tengah malam = dua
  jendela), maks. 21 jendela; zona waktu = zona organisasi. `timeoutMinutes` 1–1.440 (`null` saat aktif → 15).
- Jawaban `{ settings: { …, channelType, timezone, activeNow, receiverReady, updatedAt } }` —
  `activeNow` = bot aktif + sekarang dalam jam kerja bot; `receiverReady` = ada penerima bot aktif
  untuk channel ini (endpoint aktif yang melanggan `message.received`: format native untuk semua
  channel, format MobiChat **hanya WhatsApp** + key masih aktif). Percakapan baru masuk ke bot hanya
  bila `activeNow && receiverReady` — UI menampilkan peringatan bila bot aktif tetapi
  `receiverReady: false`. `channelType` & `receiverReady` selalu dikirim (opsional di skema hanya demi
  klien lama).
- Berlaku untuk percakapan BARU: worker memberi status `bot` bila bot aktif + dalam jam kerja bot +
  **ada penerima aktif** (endpoint webhook aktif yang melanggan `message.received`: format native
  untuk semua channel; format MobiChat **hanya WhatsApp** + key-nya masih aktif)
  (`botAwareInitialStatus`), selain itu `unserved`. Isi jam rusak → `unserved`.
- **Email yang gagal verifikasi pengirim** (`senderVerification: fail` — SPF/DKIM/DMARC) tidak pernah
  dilayani bot: percakapan barunya langsung `unserved`, dan bila percakapan terbuka sedang dipegang
  bot, ia diserahkan ke antrian (kejadian `handoff` pelaku sistem + webhook `conversation.handoff`).
  Pesan email `unverified`/`pass` tetap ke bot; bot wajib membaca `data.message.email.sender_verification`.
- Review bot R1 (tidak ada pelanggan terjebak di bot): bot aktif SELALU punya batas waktu —
  `timeoutMinutes: null` saat `enabled` diisi 15 (constraint DB); **mematikan bot channel menyerahkan
  semua percakapan `bot` channel itu ke antrian** (kejadian `handoff` oleh pengguna, webhook, push);
  menyalakan bot oleh SELAIN Owner = kejadian keamanan `bot_enabled` (warning, banner).

**Selama `bot`**: pesan pelanggan masuk ke tab "Bot", TIDAK memicu push ke manusia; bot menerima
`message.received` lewat webhook keluar (opsi endpoint `botOnly`: hanya selama bot memegang). Body
native memuat `data.conversation.channel_type` + `data.conversation.channel { id, type, name }` dan
`data.contact.channel_type`/`channel_handle` supaya satu bot bisa melayani banyak channel. Balasan bot
(`POST /api/v1/public/conversations/:id/messages`) selalu terkirim lewat channel percakapan itu, dengan
aturan kirim channel tersebut (`CHANNEL_CAPABILITIES`: jenis pesan, ukuran media); **jendela 24 jam
hanya WhatsApp/Messenger/Instagram** (Telegram & Email tanpa jendela). **Pesan email**:
`data.message.email.sender_verification` ≠ `pass` = pengirim TIDAK tepercaya (alamat `From` bisa
dipalsukan) — bot tidak boleh menjalankan aksi akun (ubah paket, isolir, ubah data) dan sebaiknya
langsung handoff. Kenali pelanggan lewat `contact.id`, bukan `channel_handle`/nama (masukan pelanggan).
`conversations.bot_awaiting_since` = pesan pelanggan pertama yang belum dibalas bot (dikosongkan saat
bot membalas lewat API key atau status bukan `bot`).

**Handoff → tim** (kejadian `handoff`, webhook `conversation.handoff`, push "kembali ke antrian"):
- bot meminta: `POST /api/v1/public/conversations/:id/handoff` atau MobiChat `unassign-agent` /
  `conversation-status {status:"unserved"}`;
- agen mematikan bot: `POST /api/v1/conversations/:id/bot { "active": false }`;
- **batas waktu**: job maintenance `bot-timeouts` (tiap menit) memindahkan percakapan `bot` yang
  `bot_awaiting_since` lebih tua dari `timeoutMinutes` channelnya → `unserved`, pelaku sistem;
- agen "Ambil" (`claim`) dari bot → `served` + `conversation.handoff`.

**Kembali ke bot**: `POST /api/v1/conversations/:id/bot { "active": true }` (`inbox.reply` + cakupan)
→ status `bot`, tanpa pemegang, kejadian `bot_resumed`. Bot channel mati → 409; **belum ada penerima
bot aktif untuk channel itu** (sama dengan `receiverReady: false`) → 409 `CONFLICT` "Belum ada penerima
bot aktif untuk channel ini. Tambahkan webhook bot di Pengaturan → Webhook, lalu coba lagi." (diperiksa
SETELAH izin); bila pesan terakhir dari pelanggan (belum dibalas), `bot_awaiting_since` = saat
dikembalikan sehingga batas waktu bot berjalan; percakapan selesai →
409; mengambil dari agen LAIN butuh `inbox.assign` (403 + audit penolakan). Jawaban = bentuk aksi
penanganan (`{ conversation }`). Tab Log: `handoff` "Menyerahkan dari bot ke tim", `bot_resumed`
"Mengembalikan ke bot" (pelaku pengguna / "Bot · <nama key>" / sistem bila `actor` `null`).

## Pesan interaktif (Fase 3)

`POST /conversations/:id/messages` menerima juga
`{ type: "interactive", clientMessageId, interactive, replyToMessageId? }` (skema
`packages/shared/src/interactive.ts`, batas Meta):

- tombol: `{ kind: "button", body (≤ 1.024), header? (≤ 60), footer? (≤ 60), buttons: [{ id (≤ 256),
  title (≤ 20) }] }` 1–3 tombol, ID & judul unik;
- daftar: `{ kind: "list", body, header?, footer?, buttonText (≤ 20), sections: [{ title? (≤ 24, wajib
  bila > 1 bagian), rows: [{ id (≤ 200), title (≤ 24), description? (≤ 72) }] }] }` total 1–10 baris,
  ID unik.
- Hanya di dalam jendela 24 jam (409 `WINDOW_CLOSED`), semua batas kirim & rem darurat berlaku. Disimpan
  `type: interactive`, `text` = body, `extras.interactiveMessage`; respons `Message.interactiveMessage`
  (pesan keluar; `null` lainnya). Worker membangun objek `interactive` Cloud API (`reply` buttons /
  `sections` rows).
- Balasan pelanggan (`button_reply`/`list_reply`) tetap tersimpan di `Message.interactive`
  `{ kind, id, title, description }` dan diteruskan ke bot (webhook native `data.message.interactive`
  `{ type, id, title, description }`; format MobiChat `interactive_reply` + `reply_id`,
  `message_text` = judul pilihan).

## Template (Fase 4)

`type: "template"` di `POST /conversations/:id/messages` = satu-satunya pesan yang boleh di luar jendela
24 jam; mulai percakapan ke nomor baru = `POST /conversations/start` (`inbox.initiate`). `Message.type`
bisa `template` dengan `Message.template { templateId, name, language, category }`. Rincian:
docs/KONTRAK-API-TEMPLATE.md.

## Titik kait berikutnya

- Pesan otomatis saat diserahkan ke manusia / dikembalikan ke bot, sapaan & di luar jam kerja (PRD
  §3.4 PENTING): kait di kejadian `handoff`/`bot_resumed` dan `botAwareInitialStatus`.
- Pesan keluar: setelah `wamid` tersimpan, putar ulang status yang datang lebih dulu dari
  `webhook_events` (`external_id`).
- Unduh media (ID media Meta lewat Graph API), siaran WebSocket: job terpisah, bukan di transaksi
  worker.
- Urutan kunci untuk modul yang mengunci keduanya: kontak → percakapan. Kunci identitas kontak:
  `contactIdentityLockKeys` (`@balesin/core`) + `lockAdvisoryKeys` (`@balesin/db`).
- Unduh media (butir ruang chat): `Content-Disposition` dengan `filename*` RFC 5987 dari nama yang
  sudah dibersihkan, `Content-Type` hasil deteksi isi, nama di storage = ID buatan server.
- Impor kontak / kirim ke nomor (Fase 4): selesaikan review kontak R4 lebih dulu (DECISIONS).

## Jam kerja, pesan otomatis, alokasi (Fase 5)

Skema: `packages/shared/src/workspace.ts`. Alamat: `API_ROUTES.workspace`, `API_ROUTES.inbox.availability`.
Migrasi `0028`. Dijalankan worker lewat job pemeliharaan **`workspace-dispatch`** (tiap 10 detik).

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/settings/workspace` | `settings.workspace.manage` | `{ settings: { timezone, teamHours, holidays, withinTeamHoursNow, allocation: { mode, maxOpenPerAgent }, autoMessages: { greeting, away, assigned: { enabled, text } }, updatedAt } }` |
| `PUT /api/v1/settings/workspace` | `settings.workspace.manage` | Sebagian: `teamHours` (format jam kerja bot: `always` / `schedule` + `windows [{ day 0–6, start, end }]`, zona organisasi), `holidays` (≤ 60 `{ date YYYY-MM-DD, name }`, tidak kembar), `allocation { mode: manual·round_robin, maxOpenPerAgent: 1–200 \| null }`, `autoMessages.{greeting,away,assigned} { enabled, text ≤ 1.000 }`, `confirmation`. Variabel: `{nama}` (semua), `{agen}` (hanya `assigned`) — lainnya 400. **Mengaktifkan pesan otomatis atau mengubah teksnya wajib `confirmation`** (password + kode 2FA; review jam kerja S1) — mematikan & isian lain tidak. Audit `settings.workspace.updated` `{ changedFields, actorRole, autoMessageTexts: { <jenis>: { previous, next } } }` (teks pengaturan, maks. 1.000); teks baru memuat tautan/angka panjang (≥ 8 digit) baru → `risky` + kejadian keamanan **`auto_message_risky`** (`warning`, oleh siapa pun termasuk Owner) |
| `GET /api/v1/settings/workspace/agents` | `settings.workspace.manage` | `{ agents: [{ userId, name, role, available, excluded, openConversations, lastAssignedAt }] }` — peran alokasi saja (Owner/Admin/Supervisor/CS aktif; Teknisi tidak) |
| `PATCH /api/v1/settings/workspace/agents/:userId` | `settings.workspace.manage` | `{ available?, excluded? }` → `{ agent }`; Teknisi/nonaktif → 404. Audit `settings.workspace.agent_updated` |
| `GET`/`PUT /api/v1/inbox/availability` | `inbox.reply` | Saklar milik agen sendiri `{ available }` → `{ availability: { available, excluded, mode } }`. Peran non-alokasi (Teknisi) → 409. Tidak diaudit (saklar harian) |
| `PATCH /api/v1/settings/departments/:id` | `settings.workspace.manage` | + `teamHours` (jam kerja khusus departemen, `null` = ikut organisasi) |

**Jam kerja tim** terpisah dari jam kerja bot (`channels.bot_hours`). Hari libur (tanggal lokal zona
organisasi) = di luar jam kerja. Percakapan berdepartemen memakai jam departemennya bila diatur.

**Alokasi** — `manual` (bawaan: agen mengambil sendiri dari antrian) atau `round_robin`: tiap putaran,
percakapan `unserved` tanpa agen (tertua dulu, maks. 50/organisasi) yang berada DALAM jam kerja
ditugaskan ke agen yang paling lama tidak mendapat penugasan otomatis dan memenuhi semua syarat: aktif,
peran alokasi (cakupan `inbox.reply` penuh), 2FA aktif bila perannya wajib 2FA, `available`, tidak
`excluded` (bawaan: Owner/Admin dikecualikan), `served` terbuka < `maxOpenPerAgent`, anggota departemen
percakapan (percakapan tanpa departemen: bukan pengguna bertanda "akses departemen sendiri"). Tidak ada
yang memenuhi → tetap di antrian. **Atomik**: percakapan dan baris agen dikunci `FOR UPDATE SKIP LOCKED`,
kapasitas dihitung di transaksi yang sama. Hasil: status `served`, kejadian `assigned` dengan pelaku
**sistem** (`actor: null`), webhook `conversation.assigned`, real-time `conversation.updated`, push
"ditugaskan" ke agen. Percakapan bot tidak pernah diambil (hanya `unserved`).

**Pesan otomatis** (`sender_kind: system`, jalur kirim biasa → rem darurat & klaim kirim berlaku),
**sekali per sesi** (`conversation_auto_messages`, unik per slot `welcome`/`assigned`):
- `greeting` / `away` — percakapan BARU (≤ 10 menit) yang pesan pertamanya dari pelanggan, belum pernah
  ditangani bot (`handoff`/`bot_resumed`), status `unserved`/`served`: dalam jam kerja saat percakapan
  dibuat → sapaan, di luar → pesan di luar jam kerja. Tidak untuk percakapan broadcast/API/agen
  (pesan pertama keluar).
- `{nama}` = nama dari tim → nama profil WhatsApp, **tautan dibuang** (nama profil = teks bebas pelanggan;
  review jam kerja Info 3), maks. 60 karakter, kosong → "Kak".
- `assigned` — kejadian `claimed`/`assigned` ≤ 15 menit (termasuk round-robin) pada percakapan yang
  dimulai pelanggan dan masih dipegang agen itu; `{agen}` = nama agen.
- Hanya dalam jendela 24 jam. Rem darurat aktif / jenis dimatikan → dicatat `skip_reason`
  (`sending_paused`, `disabled`, `window_closed`), tidak dikirim, tidak dicoba ulang.
