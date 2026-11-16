# Kontrak API — Inbox: kontak, percakapan, pesan (Fase 2 butir 4)

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
  kiriman ulang Meta tidak menghidupkan kontak. Endpoint (izin `contacts.delete` + konfirmasi
  identitas + audit) menyusul di butir CRM.

## Jejak kejadian yang ditolak database (review webhook N2)

Baris yang ditolak Postgres saat disimpan penerima diganti **baris stub tanpa payload**:
`status = 'failed'`, `last_error = 'rejected:<kode>'`, kunci dedup + wamid, `payload_purged_at`
terisi. Dihitung dengan `countRejectedWebhookEvents` (untuk layar diagnosis nanti). Bila stub pun
ditolak → log `error`.

## Titik kait berikutnya

- Bot (Fase 3): `initialConversationStatus` + antre job kirim-ke-bot (ID saja).
- Pesan keluar: setelah `wamid` tersimpan, putar ulang status yang datang lebih dulu dari
  `webhook_events` (`external_id`).
- Unduh media (ID media Meta lewat Graph API), siaran WebSocket: job terpisah, bukan di transaksi
  worker.
- Urutan kunci untuk modul yang mengunci keduanya: kontak → percakapan. Kunci identitas kontak:
  `contactIdentityLockKeys` (`@balesin/core`) + `lockAdvisoryKeys` (`@balesin/db`).
- Unduh media (butir ruang chat): `Content-Disposition` dengan `filename*` RFC 5987 dari nama yang
  sudah dibersihkan, `Content-Type` hasil deteksi isi, nama di storage = ID buatan server.
- Impor kontak / kirim ke nomor (Fase 4): selesaikan review kontak R4 lebih dulu (DECISIONS).
