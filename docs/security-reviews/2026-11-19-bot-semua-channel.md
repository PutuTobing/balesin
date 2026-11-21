# Review keamanan: bot untuk semua jenis channel

- Commit: `f493358` (`feat(bot): bot untuk semua jenis channel — jenis channel di event bot, MobiChat hanya WhatsApp, receiverReady`) — putaran 1; perbaikan `d612b29` — putaran 2; fitur P2-1/P2-3 `d9766b3` — putaran 3; perbaikan `e611a65` — putaran 4 (bagian akhir dokumen)
- Lingkup: `packages/db/src/outgoing-events.ts` (`hasActiveBotReceiver`), `packages/shared/src/bot.ts`,
  `apps/api/src/modules/bot/bot.service.ts`, `apps/worker/src/inbound/handlers.ts`,
  `apps/worker/src/queues/webhooks-out.ts`, `bot-channel-lain.integration.test.ts`, dan kontrak di docs
  (INBOX, WEBHOOK-KELUAR, MOBICHAT, CHANNEL-LAIN, PUBLIK, DECISIONS). Jalur yang ikut ditelusuri karena
  terpakai oleh fitur ini: `outbound.service.ts` (`sendAs`), `sending-limits.service.ts`,
  `compat-mobichat/mobichat.service.ts`, `inbox/assignment.service.ts` (`setBot`, `*AsApiKey`),
  `audit/audit.service.ts` (`bot_enabled`).
- Acuan: `docs/SECURITY.md` §2 (otorisasi), §3 (rahasia), §5 (penyalahgunaan pengiriman), §6 (webhook
  keluar), §10 (privasi data).
- Peninjau: subagent `security`
- Model ancaman: (1) akun CS yang dibobol; (2) API key bot yang bocor, misalnya key MobiChat yang ikut
  di body webhook dan bisa lewat `http://` di LAN; (3) pihak luar tanpa akun yang memalsukan pengirim
  email untuk mengelabui bot; (4) penerima webhook (n8n/bot) sebagai pihak yang datanya harus
  diminimalkan.

## Putusan: **AMAN**

Tidak ada temuan Kritis atau Tinggi. Ada 1 temuan **Sedang** (B1) yang dikunci dengan `it.fails`,
2 temuan **Rendah** (B2–B3), dan beberapa Info. Tes penjaga ada di
`apps/api/src/modules/bot/security-review-bot-semua-channel.integration.test.ts`: 10 lulus dan
1 `it.fails`. Salinan tes B1 tanpa `.fails` gagal tepat di asersi temuan
(`expected undefined to be 'fail'`), lalu salinan itu dihapus.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| ID platform mentah tidak terkirim | `apps/worker/src/queues/webhooks-out.ts:108-139` (`contactData`) | Kolom kontak dipilih satu per satu. `external_user_id` (ID Telegram/PSID/IGSID) dan `wa_bsuid` tidak ikut. `channel_handle` diisi `@username` Telegram (regex `^[A-Za-z0-9_]{1,64}$`, `telegram-update.ts:121-123`) atau alamat email (`channel-mailboxes.ts:341`). Messenger/Instagram mengirim `null` (`meta-social.ts:249`). Tes baru untuk 4 channel: ID mentah, `external_user_id`, dan `wa_bsuid` tidak muncul di body; daftar kunci `contact` dikunci persis |
| Tidak ada rahasia/kolom channel | `webhooks-out.ts:155-186` (`conversationData`) | Join `channels` hanya mengambil `type` dan `name`, dengan filter `organization_id` di syarat join. Tes baru: token/app secret/password IMAP tiruan, ID bot Telegram, username bot, Page ID, IG account ID, host dan username IMAP tidak muncul di body. Objek `channel` dikunci `{id,type,name}` |
| Format MobiChat = WhatsApp saja | `webhooks-out.ts:376-382`, `outgoing-events.ts:50-79` | `buildMobichatBody` mengembalikan `null` untuk non-WhatsApp, jadi body yang membawa `mobichat_api_key` tidak pernah dibangun untuk Telegram/Email/Meta. Ini juga berlaku untuk percakapan yang dipaksa berstatus `bot` (tes baru: 0 kiriman). `hasActiveBotReceiver` untuk non-WhatsApp hanya menghitung `format <> 'mobichat'`. Untuk WhatsApp, syarat key aktif sama persis dengan versi lama (pindahan 1:1 dari `handlers.ts`) |
| Penerima bot dipakai bersama | `handlers.ts:94-104`, `bot.service.ts:83-96` | Worker dan `receiverReady` memakai fungsi yang sama, jadi UI tidak bisa berbeda dari perilaku worker. Query difilter `organization_id`, dan join `api_keys` memakai `(organization_id, id)` |
| Pengaturan bot channel lain | `bot.service.ts:103-150` | `integrations.manage` dicek ulang di transaksi (`assertActorStillAuthorized`), CSRF, `deleted_at is null`, dan audit memuat `channelType` tanpa data pelanggan. Respons hanya menambah `channelType` dan `receiverReady` (boolean), tanpa membuka host/URL endpoint. Tes backend: CS/Supervisor 403, tanpa CSRF 403 |
| API publik membalas di channel lain | `outbound.service.ts:707-800` | Scope `messages:send` diperiksa di lapisan rute. Pelaku `senderKind: 'bot'` + `apiKeyId` (`:782`). Jenis pesan dibatasi `channelSupportsOutbound` dan ukuran media mengikuti `CHANNEL_CAPABILITIES`. Jendela 24 jam diperiksa lewat `channelHasCustomerWindow` (`:753`): Messenger/IG 409 `WINDOW_CLOSED`, Telegram/Email tanpa jendela (tes backend) |
| Batas laju key | `sending-limits.service.ts:389-440` | Rem darurat (`SENDING_PAUSED`), batas harian PER KEY, batas harian organisasi, dan batas per percakapan per menit berlaku sama untuk semua jenis channel. Hitungannya lintas channel, jadi key tidak bisa menghindari batas dengan berpindah channel. Batas organisasi 600/menit ada di rute. Tidak ada batas khusus per channel, dan untuk keamanan itu tidak diperlukan karena batas per key dan per organisasi sudah membatasi total |
| Key tidak mengubah status chat agen | `assignment.service.ts:542-592` | Handoff/lepas hanya dari `bot`, tugaskan hanya dari bot/antrian, dan selesai hanya `bot`. Tes baru untuk Telegram: handoff ke percakapan `served` → `changed:false`, status dan pemegang tetap |
| `bot_enabled` di semua channel | `audit.service.ts:98,227-232` | Deteksinya hanya melihat `action = channel.bot_updated` + `enabled`/`previousEnabled`/`actorRole`, tanpa syarat jenis channel. Tes baru untuk 4 channel: Admin menyalakan bot → 1 kejadian `bot_enabled` `warning` di ringkasan keamanan Owner |
| Dependensi | `pnpm audit` | `--prod`: **0 kerentanan**. Total ada 2 moderate dev-only (esbuild, minimatch), sama dengan review sebelumnya dan tidak terkait commit ini |

---

## B. Temuan

### B1 (Sedang) — Bot tidak menerima hasil verifikasi pengirim email

- **Bukti.** `apps/worker/src/queues/webhooks-out.ts:190-222` (`messageData`) tidak mengirim
  `extras.email.senderVerification`/`authWarning`, padahal nilainya tersimpan per pesan
  (`packages/db/src/schema/messages.ts:113-123`, diisi `channel-inbound.ts:172-173`). Inbox web dan API
  v1 menampilkannya (`inbox-view.ts:221-235`), jadi agen manusia melihat label "pengirim tidak
  diverifikasi" atau peringatan DMARC. Bot yang dilayani lewat webhook tidak mendapat sinyal ini.
- **Dampak.** Identitas kontak email adalah alamat `From`, dan alamat itu bisa dipalsukan (review Fase 6
  R1). Commit ini menjadikan email channel bot resmi. Kontrak juga mengarahkan bot memakai
  `contact.channel_handle`/`contact.email` untuk mengenali pelanggan. Akibatnya, pihak luar tanpa akun
  bisa mengirim email ber-`From` pelanggan X, dan bot otomatis (tanpa penilaian manusia) memprosesnya
  sebagai X: mengubah paket, mengisolir layanan, membuat tiket, atau mengubah data CRM lewat API.
  Balasan bot tetap terkirim ke alamat X yang asli, jadi data tidak langsung bocor ke penyerang.
  Risikonya ada pada **aksi** yang dijalankan bot. Untuk WhatsApp/Telegram/Messenger/Instagram,
  identitas pengirim dijamin platform, jadi masalah ini hanya ada di email.
- **Perbaikan.**
  1. Tambahkan ke `message` di body native, khusus pesan email masuk, misalnya
     `email: { subject, sender_verification: 'pass'|'fail'|'unverified' }` (sumber datanya sama dengan
     `inbox-view.ts:235`, termasuk data lama tanpa `senderVerification`).
  2. Di KONTRAK-WEBHOOK-KELUAR/INBOX, tulis bahwa bot **wajib** memperlakukan `sender_verification !==
     'pass'` sebagai pengirim tidak tepercaya (tidak menjalankan aksi akun) dan sebaiknya langsung
     handoff.
  3. Opsional (lebih aman): percakapan email yang pesan pertamanya `fail` tidak diparkir di bot
     (`botAwareInitialStatus` → `unserved`).
- **Tes.** `it.fails` "B1: body native message.received email memuat hasil verifikasi pengirim". Nama
  isian `sender_verification` hanya usulan. Kalau kontrak memilih nama lain, sesuaikan nama isiannya,
  tetapi asersinya tetap: nilai `fail` harus terlihat di body.

### B2 (Rendah) — Klaim "key hanya bertindak atas percakapan bot/antrian" tidak akurat; rute MobiChat menerima percakapan non-WhatsApp

- **Bukti.** `docs/DECISIONS.md:313` menyebut "`/api/public/*` & `/api/bot/*` tidak memblokir percakapan
  non-WhatsApp (key tetap hanya bertindak atas percakapan bot/antrian)". Kenyataannya, hanya **perubahan
  status** yang dibatasi ke bot/antrian (`assignment.service.ts:542-592`). Mengirim pesan
  (`mobichat.service.ts:299` → `outbound.service.ts:707`, tanpa cek status), riwayat
  (`mobichat.service.ts:258`), catatan, dan ganti nama kontak berlaku untuk **semua** percakapan
  organisasi, termasuk yang sedang dipegang agen dan percakapan Telegram/Email/Meta.
  `mobichat.service.ts:180` mencari percakapan berdasarkan `number` tanpa syarat jenis channel.
- **Dampak.** Perilaku ini sudah ada sebelumnya dan sesuai KONTRAK-API-PUBLIK ("Cakupan data = SELURUH
  organisasi", review `2026-11-18-fase3-api-publik.md` Info 4), jadi commit ini tidak menambah
  kemampuan key. Yang bermasalah: (a) dokumen keputusan membuat Owner/peninjau mengira key MobiChat
  terkurung. (b) Key MobiChat adalah key yang paling sering terpapar karena ikut di setiap body webhook
  dan bisa lewat `http://` di LAN. Kalau bocor, key ini tetap bisa mengirim ke percakapan Telegram/Email
  (nomor percakapan berurutan, jadi mudah ditebak) dan menyela chat yang sedang dipegang agen. Batas
  harian per key, rem darurat, dan audit tetap berlaku.
- **Perbaikan.**
  1. Perbaiki kalimat di DECISIONS dan KONTRAK-API-MOBICHAT: key bisa membaca dan mengirim ke semua
     percakapan organisasi, sedangkan perubahan status hanya untuk bot/antrian.
  2. Agar konsisten dengan "MobiChat = WhatsApp saja", buat `conversation()` di
     `mobichat.service.ts` menjawab 404 seragam untuk percakapan non-WhatsApp. Body MobiChat tidak
     pernah memberi nomornya, jadi integrasi sah tidak terdampak.
  3. Jangka panjang: tambahkan opsi key "kirim hanya ke percakapan yang dipegang bot" (§5 SECURITY.md,
     prinsip hak minimum untuk key bot).

### B3 (Rendah) — "Kembalikan ke bot" tidak memeriksa penerima, dan penanda batas waktu dikosongkan

- **Bukti.** `assignment.service.ts:595-633` (`setBot(true)`) hanya mensyaratkan `channels.bot_enabled`
  dan tidak memanggil `hasActiveBotReceiver`. `assignment.service.ts:234` mengosongkan
  `bot_awaiting_since` saat status berubah dari non-bot ke `bot`. Batas waktu bot hanya berjalan bila
  penanda itu terisi (`worker/src/queues/maintenance.ts:291`).
- **Dampak.** Commit ini sengaja tidak menghitung endpoint MobiChat sebagai penerima Telegram/Email/Meta
  (`receiverReady:false`). Kalau Admin tetap menyalakan bot channel itu (UI hanya memberi peringatan),
  pemegang `inbox.reply` termasuk CS bisa mengembalikan percakapan antrian ke bot yang tidak menerima
  apa pun. Percakapan itu hilang dari antrian dan push, dan batas waktunya baru berjalan setelah
  pelanggan menulis lagi. Akun CS yang dibobol bisa memakai ini untuk "menyembunyikan" antrian.
  Dampaknya kecil: aksinya tercatat `bot_resumed`, aksi massal tertangkap `watchBulk` (review bot Info
  1), dan percakapannya tetap terlihat di tab Bot. Inilah celah pada jaminan review bot R1 ("tidak ada
  pelanggan terjebak di bot") yang kini berlaku untuk semua channel.
- **Perbaikan.** Di `setBot(true)`, panggil `hasActiveBotReceiver(tx, { channelType, at })` dan jawab
  409 "Belum ada penerima bot aktif untuk channel ini" bila hasilnya `false`. Saat kembali ke bot, isi
  `bot_awaiting_since` dengan `last_inbound_at` bila pesan terakhir datang dari pelanggan dan belum
  dibalas, supaya batas waktu tetap berjalan.

---

## C. Info

1. **Semua endpoint native menerima data semua channel.** `webhook_endpoints` tidak punya saringan
   channel. Workflow n8n yang dibuat untuk WhatsApp kini juga menerima isi pesan Telegram/Email/Meta
   setelah bot channel itu dinyalakan. Hal ini sudah begitu sebelum commit ini, tetapi sekarang lebih
   sering terjadi. Pertimbangkan saringan `channelIds`/`channelTypes` per endpoint untuk minimisasi data
   (UU PDP).
2. **`channel_handle` dan `profile_name` adalah masukan pelanggan.** `@username` Telegram bisa diganti
   lalu dipakai orang lain, dan nama tampilan bebas diisi. Tambahkan satu kalimat di
   KONTRAK-WEBHOOK-KELUAR: bot harus mengenali pelanggan lewat `contact.id`, bukan `channel_handle`.
   Untuk email, `channel_handle` sama dengan `email` (lihat B1).
3. **Detail banner `bot_enabled` belum memuat `channelType`** (`audit.service.ts:272`). Metadata audit
   sudah menyimpannya, jadi menambahkan `'channelType'` ke `DETAIL_KEYS.bot_enabled` membantu Owner
   melihat channel mana yang dinyalakan.
4. **Kontrak INBOX belum seragam.** Butir "Berlaku untuk percakapan BARU" (`docs/KONTRAK-API-INBOX.md`
   sekitar baris 463) masih menulis "format MobiChat: key-nya masih aktif" tanpa "hanya WhatsApp",
   sementara butir `receiverReady` di atasnya sudah benar. Samakan.
5. **Join `channels` di `conversationData` adalah `innerJoin`.** Channel yang dihapus permanen (bukan
   `deleted_at`) akan membuat event percakapannya tidak terkirim. Ini gagal-aman (data tidak bocor),
   hanya disebut untuk kelengkapan.

---

## D. Tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `vitest run src/modules/bot/bot-channel-lain.integration.test.ts` (tes backend) | 9 lulus |
| `vitest run src/modules/bot/security-review-bot-semua-channel.integration.test.ts` (baru) | 10 lulus + 1 expected fail (B1) |
| Salinan tes B1 tanpa `.fails` | gagal di `expected undefined to be 'fail'` (sesuai temuan), lalu salinannya dihapus |
| `eslint` + `tsc --noEmit` (apps/api) | bersih |
| `pnpm audit --prod` | 0 kerentanan |

Tes penjaga baru:

- Minimisasi payload ×4 channel: tanpa ID platform mentah, rahasia, atau kolom konfigurasi channel;
  kunci `contact` dan `channel` dikunci.
- Endpoint MobiChat tidak menerima apa pun dari Telegram, termasuk saat percakapan dipaksa `bot`.
- Key tidak mengubah status percakapan Telegram yang dipegang agen.
- `bot_enabled` ×4 channel (Admin → `warning`).
- `it.fails` B1.

---

## Putaran 2 — verifikasi perbaikan `d612b29`

Commit: `d612b29` (`fix(bot): verifikasi pengirim email ke bot & email fail tidak dipegang bot, MobiChat
hanya percakapan WhatsApp, kembalikan ke bot wajib ada penerima`).

### Putusan putaran 2: **AMAN**

B1–B3 dan Info 2–4 **tertutup**. Tidak ada temuan baru di level Sedang atau lebih tinggi, jadi tidak
ada `it.fails` baru. Ada 3 catatan Info baru (P2-1 sampai P2-3). Tes `it.fails` B1 sudah diubah
backend menjadi `it` dengan asersi yang sama, dan tes itu lulus.

| Temuan | Bukti perbaikan | Status |
|---|---|---|
| B1 verifikasi pengirim ke bot | `apps/worker/src/queues/webhooks-out.ts:223,236-256` (`emailDataOf`): pesan email mengirim `{subject, sender_verification, auth_warning}`, pesan selain email `null`, pesan keluar `sender_verification: null`. Untuk data lama tanpa `senderVerification`, nilainya `fail` bila dulu ada `authWarning` dan selain itu `unverified`, jadi tidak pernah dianggap `pass` (sama dengan `inbox-view.ts:235`). Nilai di luar daftar dibuang. Perbaikan tambahan: `apps/worker/src/inbound/channel-inbound.ts:189-204`. Email `fail` membuat percakapan baru `unserved`, dan percakapan terbuka yang sedang `bot` diserahkan ke antrian lewat `handOffFromBot` (`:136-167`). Update itu bersyarat `status = 'bot'` dan memakai filter `organization_id`, mencatat kejadian `handoff` dengan pelaku sistem, dan mengirim webhook `conversation.handoff` | **Tertutup** |
| B1 agen tetap tahu | `handOffFromBot` memang tidak mengirim push khusus "queued". Tetapi pesan `fail` itu sendiri tetap memicu push `kind: 'message'` (`apps/worker/src/queues/webhooks.ts:281-296`), dan worker notifikasi membaca status percakapan dari DB saat itu, yaitu `unserved`. Akibatnya cabang antrian berlaku: penerimanya semua yang boleh mengambil, preferensinya `queue`, dan `needsAssign` true (`apps/worker/src/queues/notifications.ts:477-485`). Real-time `conversation.updated` juga dikirim. Tes baru memastikan push `message` diantrekan untuk percakapan itu dan statusnya `unserved` | **Memadai** |
| B1 bot tidak melihat pesan palsu | Endpoint "hanya saat bot" dinilai saat dispatch (`webhooks-out.ts` `dispatchOne`). Karena status sudah `unserved`, pesan palsu tidak dikirim ke bot. Tes baru: bot hanya menerima pesan `pass` | **Tertutup** |
| B2 MobiChat hanya WhatsApp | `apps/api/src/modules/compat-mobichat/mobichat.service.ts:191-200`: `innerJoin channels` dengan syarat `organization_id`, `id`, dan `type = 'whatsapp'`. Semua rute `/api/public/*` dan `/api/bot/*` yang memakai nomor percakapan melewati `conversation()` (riwayat, kirim, status, ubah status, lepas, tugaskan, catatan, ganti nama, bot reply/media). `addTags` sudah khusus kontak WhatsApp. URL media bertanda tangan hanya diterbitkan dari riwayat (yang kini hanya WhatsApp) dan tidak bisa dipalsukan tanpa rahasia server. Tes baru: untuk 9 rute, jawaban percakapan Telegram **byte-identik** dengan jawaban nomor yang tidak ada, jadi tidak ada oracle jenis channel. Tidak ada pesan keluar dan status tidak berubah | **Tertutup** |
| B3 kembalikan ke bot | `apps/api/src/modules/inbox/assignment.service.ts:605-668`. Urutannya: `mutate` → cakupan (`findConversation`), lalu saklar bot channel, lalu aturan "chat agen lain butuh `inbox.assign`" (403), baru kemudian `hasActiveBotReceiver` (409). Pemeriksaan penerima memakai fungsi bersama di transaksi yang sama, sehingga hasilnya identik dengan `receiverReady` dan worker. Tes baru: Teknisi di luar cakupan mendapat 404 (bukan 409, jadi keadaan penerima tidak bocor), dan Owner tanpa penerima mendapat 409 dengan status tetap | **Tertutup** |
| B3 query pesan terakhir | `assignment.service.ts:651-662`: filter `organization_id` dan `conversation_id`, reaksi dikecualikan, `ORDER BY occurred_at DESC LIMIT 1`, di dalam transaksi yang sama. Nilai input berasal dari baris percakapan yang sudah lolos cakupan. Tidak ada injeksi dan tidak ada lintas organisasi | **Aman** |
| B3 urutan `...change.patch` | `assignment.service.ts:230-238`: patch kini diterapkan terakhir. Sudah dicek: hanya `bot_resumed` yang memuat `botAwaitingSince`, dan tidak ada patch yang memuat `assigneeUserId` (`:441-667`), sehingga pemegang percakapan tidak bisa tertimpa | **Aman** |
| Info 3 `bot_enabled` + `channelType` | `apps/api/src/modules/audit/audit.service.ts:272` | **Tertutup** |
| Info 4 kontrak INBOX | `docs/KONTRAK-API-INBOX.md` (butir "Berlaku untuk percakapan BARU": native semua channel, MobiChat **hanya WhatsApp**) | **Tertutup** |
| Info 2 `contact.id` bukan handle | `docs/KONTRAK-WEBHOOK-KELUAR.md`, `docs/KONTRAK-API-INBOX.md` | **Tertutup** |
| B2 klaim DECISIONS | `docs/DECISIONS.md` sudah dikoreksi: key hanya dibatasi untuk perubahan status, sedangkan baca dan kirim berlaku untuk semua percakapan WhatsApp. Opsi key "hanya percakapan bot" dan saringan channel per endpoint (Info 1) dicatat sebagai ide yang ditunda | **Tertutup** (sisa = ide terdokumentasi) |

### Penilaian keputusan B3: `bot_awaiting_since` = saat dikembalikan (bukan `last_inbound_at`)

**Disetujui.** Alasan:

1. Bot tidak pernah menerima pesan lama, karena `message.received` hanya dikirim saat pesan masuk.
   Kalau penanda diisi `last_inbound_at` yang sudah lama, `handoffTimedOutBots` akan melepas percakapan
   itu lagi dalam ≤ 1 menit. Fitur "Kembalikan ke bot" jadi tidak berguna, dan tercipta siklus
   bot↔antrian yang memicu push berulang.
2. Jaminan R1 tetap terpenuhi. Pelanggan yang menunggu paling lama tertahan `timeoutMinutes` (≤ 1.440)
   sejak dikembalikan, lalu otomatis kembali ke antrian dengan kejadian `handoff` dan push. Sebelum
   perbaikan, penantiannya tidak terbatas sampai pelanggan menulis lagi.
3. Penyalahgunaan oleh akun CS curian (memarkir antrian) kini butuh penerima bot aktif, dibatasi batas
   waktu, tercatat `bot_resumed`, dan aksi massal tertangkap `watchBulk`.

Pesan terakhir dari tim berarti `null`, dan itu benar karena tidak ada pelanggan yang menunggu.

### Catatan baru (Info)

- **P2-1 — Email `unverified` tetap dilayani bot.** Server IMAP tanpa `Authentication-Results` dari
  `authserv-id` tepercaya menghasilkan `unverified` untuk *semua* email (review Fase 6 R1). Di organisasi
  seperti itu, perlindungan bergantung pada kepatuhan bot terhadap kontrak (`≠ pass` = tidak
  tepercaya). Ini sudah terdokumentasi dan sesuai keputusan. Pertimbangkan opsi per channel "bot email
  hanya untuk `pass`" di Pengaturan → Bot.
- **P2-2 — Email palsu bisa memaksa handoff.** Pihak luar yang mengetahui alamat pelanggan bisa
  mengirim email ber-`From` palsu yang gagal DMARC untuk memindahkan percakapan bot pelanggan itu ke
  antrian manusia. Dampaknya hanya beban antrian, tanpa kebocoran atau aksi. Arah gagalnya aman, jadi
  diterima.
- **P2-3 — Bot tidak diberi tahu saat percakapan dikembalikan kepadanya.** Tidak ada event webhook
  `conversation.bot_resumed`, sehingga bot baru bertindak saat pelanggan menulis lagi. Untuk keamanan
  ini aman karena batas waktu berjalan. Ini catatan UX/kontrak untuk masa depan.

### Tes putaran 2

| Perintah | Hasil |
|---|---|
| `security-review-bot-semua-channel.integration.test.ts` | **15 lulus** (11 lama, dengan B1 kini `it`, ditambah 4 penjaga baru) |
| `vitest run src/modules/bot src/modules/compat-mobichat` (apps/api) | 7 berkas, 63 lulus |
| `assignment.integration` + `security-review-fase2-penanganan` (apps/api) | 16 lulus |
| `vitest run src/inbound src/queues/webhooks-out` (apps/worker) | 3 berkas, 33 lulus |
| `eslint` + `tsc --noEmit` (apps/api) | bersih |

Penjaga baru:

- B1: email `fail` di percakapan bot dipindah ke antrian, push `message` tetap diantrekan, dan endpoint
  "hanya saat bot" tidak menerima pesan palsu.
- B1: email `unverified` tetap ke bot dengan label `unverified`.
- B2: 9 rute MobiChat menjawab 404 yang byte-identik dengan nomor yang tidak ada, tanpa efek samping.
- B3: Teknisi di luar cakupan mendapat 404 (cakupan diperiksa sebelum penerima), dan Owner tanpa
  penerima mendapat 409.

---

## Putaran 3 — opsi `requireVerifiedSender` & event `conversation.bot_resumed` (`d9766b3`)

Commit: `d9766b3` (`feat(bot): opsi Email "bot hanya pengirim terverifikasi" & event webhook
conversation.bot_resumed`). Lingkup: migrasi `0032`, `packages/db/src/schema/channels.ts`,
`packages/shared/src/bot.ts`, `packages/shared/src/outgoing-webhooks.ts`,
`apps/api/src/modules/bot/bot.service.ts`, `apps/api/src/modules/inbox/assignment.service.ts`
(`setBot`), `apps/worker/src/inbound/channel-inbound.ts`, `apps/worker/src/queues/webhooks-out.ts`,
serta kontrak INBOX, WEBHOOK-KELUAR, CHANNEL-LAIN, dan DECISIONS.

### Putusan putaran 3: **AMAN** (dengan 1 Sedang yang dikunci `it.fails`)

Tidak ada temuan Kritis atau Tinggi. Ada 1 temuan **Sedang** (P3-1), 1 **Rendah** (P3-2), dan 2 Info.
P3-1 dikunci dengan dua `it.fails`. Salinan sementara tanpa `.fails` gagal tepat di asersi temuan
(`expected [ 'Isolir layanan saya sekarang' ] to not include …` dan `expected [ 'Ganti paket saya' ]
to not include …`), lalu salinan itu dihapus. P2-1 dan P2-3 dari putaran 2 **tertutup** oleh commit
ini; P3-1 adalah celah yang muncul dari gabungan keduanya.

### Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Izin, CSRF, cek ulang aktor | `bot.routes.ts:71-95` (`MANAGE` = `integrations.manage`, batas laju 30/menit), `bot.service.ts:116` (`assertActorStillAuthorized` di transaksi), `:132` (`FOR UPDATE` baris channel milik organisasi, `deleted_at is null`) | Opsi baru lewat rute yang sama, jadi tidak ada jalur baru. Tes baru: CS dan Supervisor 403, tanpa CSRF 403, dan nilai di DB tetap `false` |
| Validasi hanya Email | `bot.service.ts:134-145` (`true` di non-email → 400 `VALIDATION_ERROR`, `field = requireVerifiedSender`), migrasi `0032` + `schema/channels.ts` CHECK `channels_bot_verified_sender_email_only` | Dua lapis. `false` di non-email diterima dan tetap `false`, tidak berbahaya. Tes baru: `UPDATE` langsung ke channel Telegram dengan `true` ditolak DB |
| Bawaan aman & "tidak diisi = tetap" | Migrasi `DEFAULT false NOT NULL`, `bot.service.ts:146` (`raw.requireVerifiedSender ?? current…`) | Klien lama yang tidak mengirim isian ini tidak mematikan perlindungan tanpa sengaja. Bawaan mati sesuai alasan P2-1 (IMAP tanpa `Authentication-Results` tepercaya) |
| Audit | `bot.service.ts:170-175` | `requireVerifiedSender` + `previousRequireVerifiedSender` hanya untuk channel Email, tanpa data pelanggan. Tes backend memastikan isinya |
| Worker: filter organisasi & N1 | `channel-inbound.ts:137-148` (`organization_id` + `id`), `:208-211` | Hanya `SELECT` biasa tanpa kunci baris, jadi tidak menaikkan kunci channel (N1 review webhook tetap dipatuhi) dan tidak menambah urutan kunci baru. Query hanya berjalan bila email `unverified`. Perubahan pengaturan yang bersamaan paling banyak memengaruhi satu pesan yang sedang diproses, dan itu bisa diterima. Tes baru: dua channel Email di organisasi yang sama dengan opsi hanya hidup di satu channel; `unverified` di channel yang opsinya hidup → `unserved`, di channel lain → `bot` |
| Perilaku opsi hidup | `channel-inbound.ts:208-221` | `unverified` sama dengan `fail`: percakapan baru `unserved`, percakapan bot terbuka diserahkan lewat `handOffFromBot` (bersyarat `status = 'bot'`, pelaku sistem, webhook `conversation.handoff`) |
| `bot_resumed`: minimisasi data | `webhooks-out.ts:329-332` memakai `messageData` yang sama dengan `message.received` (filter `organization_id`); `conversationData`/`contactData`/`userRef` tidak berubah | Kunci `data` dikunci persis `{actor, contact, conversation, message}`, dan `actor` hanya `{id, name}` (tanpa email agen). Tes baru: tanpa rahasia channel, host/username IMAP, `mobichat_api_key`, header email mentah (`inReplyTo`, `references`, `hasHtml`), ID media Meta, `external_user_id`, `wa_bsuid`, dan email agen. Catatan internal ada di tabel terpisah (`conversation_notes`), jadi tidak mungkin ikut sebagai "pesan tertunda" |
| `bot_resumed`: pesan yang dibawa | `assignment.service.ts:665-684` | `pendingMessageId` hanya diisi bila pesan terakhir (selain reaksi) dari percakapan itu sendiri adalah `inbound`. Query difilter `organization_id` + `conversation_id` di transaksi yang sama, setelah cakupan, izin `inbox.assign` untuk chat agen lain, dan `hasActiveBotReceiver`. Body dibangun saat dispatch, sehingga pesan yang sudah dihapus menjadi `null` |
| MobiChat tidak bisa melanggan | Buat: `packages/shared/src/outgoing-webhooks.ts:156` (`MOBICHAT_WEBHOOK_EVENTS`); ubah: `outgoing-webhooks.service.ts:422-430`; body: `buildMobichatBody` → `null` untuk selain `message.received` | Tiga lapis. Tes backend: buat 400. Tes baru: PATCH `events` endpoint MobiChat dengan `conversation.bot_resumed` → 400. `mobichat_api_key` tidak pernah ikut di event ini |
| Dorongan berulang oleh akun CS curian | `assignment.routes.ts:43,145` (120/menit per pengguna), `setBot` | Bolak-balik matikan/kembalikan bisa mengirim pesan tertunda yang sama berkali-kali. Tetapi setelah bot membalas, pesan terakhir menjadi `outbound` dan `message` menjadi `null`. Balasan bot tetap terkena batas per key, per percakapan per menit, dan rem darurat. Setiap aksi tercatat `bot_resumed`/`handoff` |
| Dependensi | `pnpm audit` | `--prod`: **0 kerentanan**. Total ada 2 moderate dev-only, sama dengan putaran sebelumnya |

### P3-1 (Sedang) — "Kembalikan ke bot" meneruskan email palsu/tak terverifikasi ke bot

- **Bukti.** `apps/api/src/modules/inbox/assignment.service.ts:614-685` (`setBot(true)`) tidak memeriksa
  `extras.email.senderVerification` pesan tertunda; `:679-684` mengisi `pendingMessageId` dengan pesan
  `inbound` terakhir apa pun. `apps/worker/src/queues/webhooks-out.ts:329-332` mengirim pesan itu utuh
  di `conversation.bot_resumed`. `dispatchOne` (`:629`) juga hanya menerapkan saringan bot untuk
  `message.received`.
- **Dampak.** Jaminan B1 di worker ("email `fail` tidak pernah dilayani bot") dan opsi P2-1 (alasan di
  DECISIONS: "perlindungan tidak hanya bergantung pada kepatuhan bot ke kontrak") bisa dilewati dengan
  satu klik agen. Skenarionya begini. Pihak luar mengirim email ber-`From` pelanggan X ("isolir layanan
  saya", "ganti paket"). Email itu benar masuk antrian. Lalu agen yang lalai, atau akun CS curian yang
  sengaja memalsukan email lalu mengembalikannya ke bot, menekan "Kembalikan ke bot". Bot menerima
  pesan palsu itu sebagai pesan tertunda X dan menjalankan aksi akun lewat API/n8n, padahal aksi itu
  mungkin tidak bisa dilakukan CS sendiri. Sebelum commit ini, bot tidak pernah menerima pesan lama
  tersebut. Label `sender_verification` memang ikut di body, tetapi itu kembali ke perlindungan yang
  bergantung pada kepatuhan bot, dan itulah yang mau dihindari oleh B1/P2-1. Levelnya Sedang (bukan
  Tinggi) karena butuh tindakan manusia ber-izin `inbox.reply`, label peringatan terlihat di inbox,
  dan kontrak sudah mewajibkan bot mengabaikan selain `pass`.
- **Perbaikan yang disarankan** (pilih salah satu; yang pertama paling sederhana):
  1. Di `setBot(true)`, ambil juga `extras` pesan terakhir. Bila pesan itu email `inbound` dengan
     verifikasi `fail` (data lama tanpa verifikasi + `authWarning` = `fail`), atau `unverified` saat
     channel `bot_require_verified_sender = true`, maka `pendingMessageId = null`. Event tetap dikirim
     tanpa `message`, dan `bot_awaiting_since` tetap diisi supaya batas waktu mengembalikan pelanggan ke
     tim. Pakai penafsiran yang sama dengan `emailDataOf` / `inbox-view.ts:235` supaya data lama
     ditafsirkan seragam.
  2. Atau tolak 409 `CONFLICT` dengan pesan "Pesan terakhir dari pengirim email yang tidak terverifikasi
     — balas manual". Ini paling ketat dan konsisten dengan "email `fail` tidak pernah dipegang bot".
  Tambahkan satu kalimat di KONTRAK-WEBHOOK-KELUAR/INBOX. Setelah itu ubah kedua `it.fails` P3-1 menjadi
  `it` tanpa mengubah asersi (asersinya menerima 409 maupun `message: null`).

### P3-2 (Rendah) — `conversation.bot_resumed` tidak dinilai ulang saat dispatch untuk endpoint "hanya saat bot"

- **Bukti.** `webhooks-out.ts:629`: pemeriksaan `botHolds` hanya untuk `message.received`. Body dibangun
  saat dispatch (`conversation.status` terbaru), tetapi `data.message` tetap ikut walaupun saat itu
  agen sudah mengambil alih lagi atau pesan `fail` baru sudah menyerahkannya ke tim.
- **Dampak.** Endpoint `botOnly` bisa menerima paling banyak satu pesan pelanggan untuk percakapan yang
  sudah tidak dipegang bot. Kebocorannya kecil, karena endpoint itu buatan admin dan memang
  berlangganan event ini. Bot yang tidak memeriksa `conversation.status` juga bisa membalas chat yang
  sudah dipegang agen.
- **Perbaikan.** Untuk `endpoint.botOnly && event.type === 'conversation.bot_resumed'`, pakai pemeriksaan
  `botHolds` yang sama (lewati bila status bukan `bot`). Tambahkan ke kontrak: bot wajib mengabaikan
  event bila `data.conversation.status !== 'bot'`.

### Info

- **P3-I1 — Mematikan `requireVerifiedSender` tidak muncul di ringkasan keamanan Owner.** Admin yang
  mematikan perlindungan hanya tercatat di audit `channel.bot_updated`, bukan sebagai kejadian
  `warning` seperti `bot_enabled` (`audit.service.ts`). Pertimbangkan deteksi
  `previousRequireVerifiedSender = true → false` oleh non-Owner.
- **P3-I2 — Idempotensi di sisi bot.** Pesan tertunda yang sama bisa muncul di beberapa
  `conversation.bot_resumed` (siklus matikan/kembalikan). Sarankan di kontrak agar bot menghapus
  duplikat berdasarkan `data.message.id`.

### Tes putaran 3

| Perintah | Hasil |
|---|---|
| `security-review-bot-semua-channel.integration.test.ts` | **20 lulus + 2 expected fail** (15 lama + 5 penjaga baru + 2 `it.fails` P3-1) |
| Salinan sementara tanpa `.fails` (`-t "P3-1"`) | 2 gagal tepat di asersi temuan, lalu salinannya dihapus |
| `vitest run src/modules/bot src/modules/inbox/assignment.integration.test.ts src/modules/outgoing-webhooks` (apps/api) | 8 berkas, 76 lulus + 2 expected fail |
| `vitest run src/inbound src/queues/webhooks-out` (apps/worker) | 3 berkas, 33 lulus |
| `eslint` (berkas tes) + `tsc --noEmit` (apps/api) | bersih |
| `pnpm audit --prod` / `pnpm audit` | 0 / 2 moderate dev-only (tidak berubah) |

Penjaga baru (`describe('putaran 3 …')`, `security-review-bot-semua-channel.integration.test.ts:600`):

- Opsi baru: CS/Supervisor 403, tanpa CSRF 403, nilai tetap.
- CHECK DB: non-email `true` ditolak.
- Worker membaca pengaturan per channel (channel Email lain tidak terpengaruh).
- Minimisasi body `conversation.bot_resumed` (kunci `data` & `actor` dikunci, tanpa rahasia/ID mentah/
  header email/email agen).
- Endpoint MobiChat tidak bisa melanggan `conversation.bot_resumed` lewat PATCH.
- `it.fails` P3-1 ×2 (`:763` email `fail`; `:787` `unverified` + `requireVerifiedSender`).

---

## Putaran 4 — verifikasi perbaikan `e611a65`

Commit: `e611a65` (`fix(bot): kembalikan ke bot tidak meneruskan email tak tepercaya, saringan botOnly
untuk bot_resumed, kejadian keamanan bot_verified_sender_disabled`).

### Putusan putaran 4: **AMAN**

P3-1, P3-2, P3-I1, dan P3-I2 **tertutup**. Tidak ada temuan baru di level Sedang atau lebih tinggi, jadi
tidak ada `it.fails` baru. Kedua `it.fails` P3-1 sudah menjadi `it` dengan asersi yang tidak diubah
(sudah dicek di diff) dan lulus. Ada 2 catatan Info baru.

| Temuan | Bukti perbaikan | Status |
|---|---|---|
| P3-1 email tak tepercaya ke bot | `apps/api/src/modules/inbox/assignment.service.ts:147` (`trustedForBot`) dan `:708`. Pesan selain email selalu diteruskan. Email `pass` diteruskan, `fail` tidak pernah, dan data lama tanpa hasil verifikasi tetapi ber-`authWarning` dianggap `fail`. `unverified` (termasuk data lama tanpa peringatan) hanya diteruskan bila opsi channel mati. Opsi channel dibaca di transaksi yang sama, dengan filter `organization_id`. Event tetap terkirim dengan `message: null`, dan `bot_awaiting_since` tetap diisi, jadi batas waktu tetap mengembalikan pelanggan ke tim. Agen tidak dihalangi | **Tertutup** |
| P3-1 kekuatan tes | Asersi `it` lama (`not.toContain(text)`) juga lulus bila event sama sekali tidak terkirim. Karena itu ditambah penjaga yang mewajibkan **tepat 1** `bot_resumed` berstatus `bot` dengan `message: null` (`fail`, `fail` ke endpoint `botOnly`, data lama ber-`authWarning`, `unverified` + opsi) dan `message.id` = pesan tertunda (`unverified` tanpa opsi, `pass` + opsi) | **Terkunci** |
| P3-2 saringan `botOnly` | `apps/worker/src/queues/webhooks-out.ts:629-633`: `botHolds` (dibaca saat dispatch, dengan filter `organization_id`) kini berlaku juga untuk `conversation.bot_resumed`. Tes backend: event dilewati bila agen sudah mengambil alih. Tes baru: endpoint tanpa `botOnly` tetap menerima event itu, tetapi endpoint `botOnly` tidak | **Tertutup** |
| P3-I1 kejadian keamanan | `packages/shared/src/audit.ts` (`bot_verified_sender_disabled`, `warning`), `apps/api/src/modules/audit/audit.service.ts:100` (SQL), `:229-237` (`kindOf`), `:278` (detail tanpa data pelanggan). Kejadian hanya dicatat untuk pelaku selain Owner, sama seperti `bot_enabled`. Syarat SQL dan `kindOf` sama: satu baris audit menghasilkan satu jenis kejadian, dan `bot_enabled` didahulukan | **Tertutup** |
| P3-I2 idempotensi + status | `docs/KONTRAK-WEBHOOK-KELUAR.md`: bot wajib membuang duplikat berdasarkan `data.message.id` dan mengabaikan event bila `data.conversation.status` bukan `bot`. `docs/KONTRAK-API-INBOX.md` memuat aturan `message: null` | **Tertutup** |

### Catatan baru (Info)

- **P4-I1 — Mematikan perlindungan bersamaan dengan menyalakan bot hanya muncul sebagai
  `bot_enabled`.** Admin bisa mematikan bot (tanpa banner), lalu dalam satu permintaan menyalakannya
  lagi sambil mematikan `requireVerifiedSender`. Owner melihat banner `warning` "Bot channel
  dinyalakan", tetapi `DETAIL_KEYS.bot_enabled` (`audit.service.ts:277`) tidak memuat
  `requireVerifiedSender`, jadi Owner tidak tahu perlindungan ikut dimatikan. Tetap ada banner
  peringatan dan audit lengkap, jadi bukan celah. Saran: tambahkan `requireVerifiedSender` dan
  `previousRequireVerifiedSender` ke `DETAIL_KEYS.bot_enabled`. Tes baru memastikan banner `bot_enabled`
  tetap muncul untuk kasus ini.
- **P4-I2 — Dua penafsir verifikasi email.** `trustedForBot` (`assignment.service.ts:147`) dan
  `emailDataOf` (`webhooks-out.ts`) berbeda untuk nilai di luar `pass`/`fail`/`unverified`.
  `emailDataOf` + `authWarning` menghasilkan `fail`, sedangkan `trustedForBot` menghasilkan
  `unverified`. Nilai seperti itu hanya mungkin muncul karena bug, sebab worker menulis enum bertipe.
  Saran: satukan ke satu fungsi di `@balesin/shared`/`@balesin/db` yang juga dipakai `inbox-view.ts`.

### Tes putaran 4

| Perintah | Hasil |
|---|---|
| `security-review-bot-semua-channel.integration.test.ts` | **27 lulus** (22 lama, dengan P3-1 kini `it`, ditambah 5 penjaga baru) |
| `vitest run src/modules/bot src/modules/inbox/assignment.integration.test.ts src/modules/outgoing-webhooks src/modules/audit` (apps/api) | 11 berkas, 106 lulus |
| `vitest run src/queues/webhooks-out src/inbound` (apps/worker) | 33 lulus |
| `eslint` (berkas tes) + `tsc --noEmit` (apps/api) | bersih |
| `pnpm audit --prod` | 0 kerentanan (commit ini tidak mengubah dependensi) |

Penjaga baru (`describe('putaran 4 …')`, `security-review-bot-semua-channel.integration.test.ts:808`):

- P3-1: `fail` menghasilkan tepat satu `bot_resumed` dengan `message: null`, juga untuk endpoint `botOnly`.
- P3-1: data lama tanpa `senderVerification` + `authWarning` menghasilkan `message: null`.
- P3-1: `unverified` + opsi menghasilkan `null`; `unverified` tanpa opsi dan `pass` + opsi tetap
  diteruskan (fitur tidak rusak).
- P3-2: endpoint tanpa `botOnly` tetap menerima event, endpoint `botOnly` tidak, bila status sudah
  bukan `bot` saat dispatch.
- P3-I1/P4-I1: Admin yang menyalakan bot sekaligus mematikan perlindungan tetap memunculkan banner
  `warning` (`bot_enabled`).
