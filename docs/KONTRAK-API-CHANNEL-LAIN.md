# Kontrak API — Channel selain WhatsApp (Fase 6)

Telegram Bot, Email (IMAP masuk + SMTP keluar), Facebook Messenger, Instagram DM. Skema Zod:
`packages/shared/src/channel-connections.ts` + `channel-capabilities.ts`. Channel WhatsApp tetap di
`docs/KONTRAK-API-CHANNEL.md` (rute `/settings/channels` hanya melayani WhatsApp; channel jenis lain
di sana = 404).

## Model data (generalisasi channel)

| Konsep | WhatsApp | Telegram | Email | Messenger / Instagram |
|---|---|---|---|---|
| `channels.type` | `whatsapp` | `telegram` | `email` | `messenger` / `instagram` |
| Kolom channel | `wa_*` | `tg_*` | `email_*` (+ tabel `email_mailbox_states`) | `meta_*` |
| Identitas kontak | `wa_bsuid` / `phone` | `external_user_id` = ID pengguna | `external_user_id` = alamat (huruf kecil) | `external_user_id` = PSID / IGSID |
| Tampilan kontak | nomor / `@waUsername` | `channel_handle` = `@username` | `channel_handle` = alamat | — |
| ID pesan eksternal (`messages.wamid`, nama historis) | wamid | `<chat_id>:<message_id>` (`cb:<id>` tombol) | `Message-ID` tanpa `<>` (> 256 → `sha256:<hex>`) | `mid` |
| Jendela 24 jam | ya (di luar: template) | tidak | tidak | ya (tag pesan BELUM didukung v1) |
| Template / broadcast / mulai percakapan | ya | tidak | tidak | tidak |
| Jenis pesan keluar | semua | teks, media, lokasi, tombol (inline keyboard) | teks, media (lampiran) | teks, media |
| Status kirim | webhook Meta | `sent` saat diterima Bot API | `sent` saat diterima SMTP | `sent` → `delivered`/`read` lewat webhook |

- Kontak unik per (organisasi, jenis channel, identitas); satu orang di dua channel = dua kontak
  (bisa digabung hanya bila jenis channel sama dan identitas tidak bertentangan).
- Percakapan tetap per kontak × channel; inbox, penanganan, panel, laporan, webhook keluar, bot,
  departemen, alokasi berlaku untuk semua jenis. **Broadcast, template, CSAT = WhatsApp saja (v1).**
- **Bot**: saklar bot, jam kerja bot, batas waktu, handoff = `GET`/`PUT /settings/channels/:channelId/bot`
  yang sama dengan WhatsApp (KONTRAK-API-INBOX "Bot eksternal"); ID channel dari
  `GET /settings/channel-connections`. Penerima bot channel ini = webhook format **native** saja
  (format MobiChat hanya WhatsApp); event memuat `conversation.channel_type`. Email: opsi
  `requireVerifiedSender` (bawaan mati) — bot hanya melayani pengirim `pass`; email `fail` selalu ke tim.
- `conversations.window_expires_at` hanya diisi channel berjendela; Telegram/Email mengisi
  `last_inbound_at` saja.

### Perubahan respons inbox (tambahan, kompatibel)

- `ContactSummary.channelHandle` (`@username` / alamat email / `null`); `nameSource` bisa `channel`
  (nama profil dari channel non-WhatsApp — tidak tepercaya, tampilkan `channelHandle` di sampingnya).
- `Conversation.windowApplies` (`false` = sembunyikan hitung mundur); `windowOpen` selalu `true`
  untuk Telegram/Email; `windowExpiresAt` `null` untuk channel tanpa jendela.
- `Message.email`: `{ subject, hasHtml, authWarning, senderVerification, skippedAttachments }`
  (`null` untuk pesan lain). `senderVerification` (review Fase 6 R1) = `pass` | `fail` |
  `unverified` dari header `Authentication-Results` TERATAS yang dibuat server tepercaya kotak
  masuk itu: `pass` = DMARC lolos atau DKIM lolos selaras domain pengirim; `fail` = DMARC gagal /
  SPF gagal tanpa DKIM lolos (`authWarning: true`, peringatan keras); `unverified` = tidak ada hasil
  tepercaya → label NETRAL `EMAIL_SENDER_VERIFICATION_LABELS.unverified` ("Pengirim tidak
  diverifikasi server email"). Data lama tanpa isian ini dibaca sebagai `fail`/`unverified`.
- `GET /api/v1/messages/:messageId/email-html` (`inbox.view` + cakupan) → `{ html }` HTML yang SUDAH
  disanitasi server. **Web wajib** menampilkannya di `<iframe sandbox>` (tanpa `allow-scripts` dan
  `allow-same-origin`) via `srcdoc`; 404 bila tidak ada versi HTML.
- Kirim pesan (`POST /conversations/:id/messages`): jenis yang tidak berlaku di channel itu → 400
  ("Jenis pesan ini tidak didukung di channel …"); Messenger/Instagram teks > 2.000 karakter → 400;
  ID tombol Telegram > 64 byte → 400. Balas-kutip diabaikan di Email/Messenger/Instagram.
- Alasan gagal baru: `channel_rejected` (bisa dikirim ulang), `recipient_blocked` (Telegram: bot
  diblokir). Kode error baru `CHANNEL_REQUEST_FAILED` (502) untuk Telegram/IMAP/SMTP.

## Pengaturan — `/api/v1/settings/channel-connections` (semua `channels.manage`)

| Metode & path | Isi |
|---|---|
| `GET /settings/channel-connections` | `{ channels, types, canStoreSecrets, maxChannels }` — `types` = info 5 jenis channel (label, tersedia, catatan "Butuh App Review Meta", kemampuan) |
| `POST /settings/channel-connections` | buat (body per `type`, **konfirmasi identitas wajib**) → 201 `{ channel, webhook }` (`webhook` hanya Messenger/IG) |
| `GET /settings/channel-connections/:channelId` | `{ channel }` |
| `PATCH /settings/channel-connections/:channelId` | `type` wajib sama; kredensial/tujuan (token, host, username, password, alamat, ID) → konfirmasi identitas, status kembali `untested` |
| `DELETE /settings/channel-connections/:channelId` | body konfirmasi identitas; rahasia dimusnahkan; Telegram: webhook dilepas (usaha terbaik) |
| `POST …/:channelId/disable` · `…/enable` | Messenger/IG hanya bisa diaktifkan bila tes terakhir berhasil (409) |
| `POST …/:channelId/test` | `{ ok, code, message, testedAt, checks[] }` — jatah tes koneksi bersama WhatsApp (10/5 menit/pengguna) |
| `GET …/:channelId/webhook` | Messenger/IG: URL callback + verify token + field langganan |
| `POST …/:channelId/webhook` | Telegram: secret baru + `setWebhook`; Messenger/IG: verify token baru; Email: 409 |

`POST`/`PATCH` juga memakai jatah tes koneksi (Telegram memanggil `getMe`). Semua perubahan diaudit
(`channel.created/updated/disabled/enabled/deleted/tested/webhook_verify_token_rotated`, metadata
`type`, tanpa nilai rahasia); perubahan oleh Admin diberitahukan ke Owner (pola WhatsApp).

### Telegram

Body buat: `{ type: 'telegram', name, botToken, confirmation }`. Server memanggil `getMe` (token
harus sah dan milik bot yang sama dengan awalan token), menyimpan token terenkripsi
(`channels.tg_bot_token` — TERPISAH dari token alarm Telegram walau nilainya boleh sama), membuat
`secret_token` acak, lalu `setWebhook(url, secret_token, allowed_updates=[message, callback_query])`
bila `API_URL` https publik di port 443/80/88/8443 (selain itu `webhook.warning`, pasang ulang nanti).
Ganti token hanya untuk bot yang sama (bot lain → 400; hapus lalu buat baru). Tes: `bot` (getMe) +
`webhook` (getWebhookInfo: belum terpasang / URL lain / gagal terkirim 1 jam terakhir).

### Email

Body buat: `{ type: 'email', name, emailAddress, fromName, imap: { host, port, security: 'ssl'|'starttls',
username, password, folder='INBOX' }, pollIntervalMinutes (1–60, bawaan 2), markAsRead (bawaan true),
smtp: { mode: 'system' } | { mode: 'custom', host, port, security, username, password }, confirmation }`.

- IMAP **TLS wajib** (993 SSL/TLS atau 143 STARTTLS wajib); port lain ditolak; host di-resolve dan
  link-local/metadata cloud diblokir; sertifikat diverifikasi.
- SMTP `system` = Pengaturan → Email pengirim (From = alamat sistem, Reply-To = alamat channel);
  `custom` = akun sendiri (From = alamat channel). `none` ditolak di production.
- Mengganti host/port/keamanan/username tanpa password → 400 (isi ulang password).
- `trustedAuthServIds` (opsional, maks. 5; `null` = bawaan): `authserv-id` server penerima yang
  hasil verifikasinya dipercaya, mis. `mx.google.com`, atau `.perusahaan.co.id` (domain +
  subdomain). Bawaan = host IMAP + domain induknya (+ `mx.google.com` untuk Gmail). Mengubahnya =
  konfirmasi identitas. Tampilan: `channel.senderVerification = { trustedAuthServIds, isDefault }`.
- `aliases` (opsional, tahap 9.0; maks. 20, huruf kecil, duplikat & alamat utama dibuang): alamat lain
  yang juga masuk ke kotak surat ini (mis. `billing@` diteruskan ke `cs@`). Dipakai menentukan
  **alamat tujuan** email masuk, dibuang dari "Balas semua", dan dihitung alamat sendiri (anti-loop).
  `PATCH` mengganti seluruh daftar (`[]` = kosongkan); **menambah** alias wajib konfirmasi identitas
  (menghapus tidak; status tes tidak direset; diaudit `channel.updated` isian `aliases`). Alias yang
  sudah tercatat sebagai kontak email organisasi → 400 "Alamat … sudah tercatat sebagai kontak
  pelanggan, jadi tidak bisa dijadikan alias channel." (review 9.0 R7, juga saat membuat channel). Tampilan: `channel.aliases`; inbox:
  `ChannelSummary.emailAddresses` = `[emailAddress, ...aliases]` (channel lain `[]`).
- Tes: `incoming` (IMAP login + folder) + `outgoing` (SMTP verify).
- `channel.mailbox` = status pengambilan terakhir (`lastPolledAt`, `lastPollOk`, `lastPollCode`,
  `lastPollMessage`, `skippedMessages`).

Pengambilan (worker, antrian `channels`): polling tiap `pollIntervalMinutes` (bukan IDLE), ≤ 25 email
per putaran; pertama kali / `UIDVALIDITY` berubah → mulai dari email TERBARU (kotak lama tidak
diimpor). Email > 25 MB, balasan otomatis (`Auto-Submitted`, `Precedence`, `X-Autoreply`), bounce
(`multipart/report`, MAILER-DAEMON, `Return-Path: <>`), dan email dari alamat sendiri dilewati &
dihitung. Gagal → jeda bertambah (maks. 1 jam). HTML disanitasi ketat (tanpa skrip/gaya/gambar/
form/iframe; tautan http/https/mailto + `rel=noopener noreferrer nofollow`), kutipan email lama
dipotong dari teks ruang chat, lampiran ≤ 20 MB (maks. 10) dideteksi dari isi; makro Office &
berkas eksekusi/HTML/SVG dilewati; jenis tak dikenal disimpan biner (selalu diunduh `attachment`).
Balasan keluar: `Message-ID` baru di domain channel, `In-Reply-To`/`References` dari email masuk
terakhir, subjek `Re: …`; pesan bot/otomatis membawa `Auto-Submitted: auto-replied`.

### Messenger & Instagram (disiapkan, nonaktif bawaan)

Body buat: `{ type: 'messenger', name, pageId, pageAccessToken, appSecret, confirmation }` /
`{ type: 'instagram', name, pageId, instagramAccountId, pageAccessToken, appSecret, confirmation }`.
Dibuat `enabled: false` + `requiresAppReview: true`; aktifkan setelah App Review (`pages_messaging` /
`instagram_manage_messages`) dan tes koneksi (baca Halaman/akun IG) berhasil. Kirim lewat
`POST /{page-id}/messages` (klien Graph terpusat, `appsecret_proof`, `messaging_type: RESPONSE`).
Mengganti kredensial Meta menonaktifkan channel sampai dites lagi.

## Penerima webhook (publik, di luar `/api/v1`)

| Path | Keaslian | Catatan |
|---|---|---|
| `POST /webhooks/telegram/:channelId` | header `X-Telegram-Bot-Api-Secret-Token` dibanding waktu-konstan | 403 tanpa/salah; idempoten per `update_id`; hanya chat pribadi; tombol inline dijawab di badan respons (`{"method":"answerCallbackQuery",…}`) |
| `GET /webhooks/{messenger,instagram}/:channelId` | `hub.verify_token` | memantulkan `hub.challenge` |
| `POST /webhooks/{messenger,instagram}/:channelId` | `X-Hub-Signature-256` (App Secret) atas body mentah | `entry[].id` harus Halaman/akun IG channel; echo diabaikan; lampiran hanya dari CDN Meta (`*.fbcdn.net`, `*.fbsbx.com`, `*.cdninstagram.com`) |

Penjaga & batas laju sama dengan WhatsApp (`webhook-guard.ts`). Channel nonaktif → 200 tanpa simpan;
channel terhapus / jenis lain → 404. Kejadian disimpan di `webhook_events` (`source` = jenis channel,
payload bentuk netral `channelInboundEventSchema`) lalu diproses worker `webhooks`.

## Media masuk

`GET /messages/:id/media`: Telegram diunduh lewat `getFile` (host tetap api.telegram.org, maks.
20 MB); Messenger/IG dari CDN Meta (allowlist host, tanpa token, tanpa redirect); Email sudah disimpan
saat diambil (tidak bisa diunduh ulang setelah retensi).
