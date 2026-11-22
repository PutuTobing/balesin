# Kontrak API — Modul Email: fondasi (Fase 9, tahap 9A)

Menu **Email** (kotak surat multi-akun, terpisah dari Inbox): akun IMAP/SMTP, hak akses per akun,
sinkron folder & header, daftar email, panel baca, aksi dua arah, foto/logo akun. Spesifikasi:
`docs/PRD-EMAIL.md` §4.1, §4.2, §4.3 (dasar), §4.12 (foto akun), §5, §6, §7; desain
`docs/design/email/mockup.html` (wizard 4 langkah: Penyedia → Server → Tes koneksi → Akses &
tampilan). Kirim lewat API untuk n8n/billing ada di `docs/KONTRAK-API-EMAIL-KIRIM.md` (tahap 9.1).

Rencana lokasi kode (belum ada): skema Zod `packages/shared/src/mail.ts` (akun, akses, folder, pesan,
aksi, event WS, kode tes) + `mail-presets.ts`; api `apps/api/src/modules/mail/` (rute
`API_ROUTES.mail`); core `packages/core/src/mail-client/` (IMAP akun: sinkron, IDLE, aksi; sanitasi HTML
tampilan; deteksi otomatis); db `packages/db/src/schema/mail.ts`; worker
`apps/worker/src/queues/mail.ts` + `apps/worker/src/mail-idle/` (pengawas IDLE). Migrasi: nomor
berikutnya setelah 9.1 (perkiraan `0036_mail_fondasi`).

Dipakai ulang (jangan ditulis ulang): klien IMAP `email-imap.ts` (kode galat `imap_*`, batas waktu,
`testCa`), klien SMTP `smtp.ts` (`verifySmtpConnection`, `classifySmtpError`), penjaga host
`resolveMailHost`, `fetchRemoteFile` (SSRF webhook keluar), `parseInboundEmail`/`mailparser`,
`emailSenderVerification` + `defaultTrustedAuthServIds`, `classifyEmailAttachment`, `cleanFileName`,
`createSecretBox`/`secretTail`, media store (`MEDIA_DIR`), `inspectLogoImage` (unggah gambar),
konfirmasi identitas, `forbidByRule`, outbox event WS `inbox-events`.

## 0. Cakupan 9A vs ditunda

| Area | 9A (sekarang) | Ditunda |
|---|---|---|
| Penyedia | **cPanel/IDCloudHost** (preset) dan **IMAP lain** (manual), IMAP + SMTP sandi/sandi aplikasi | Microsoft 365/Outlook (Graph OAuth), Google Workspace (XOAUTH2), POP3 → **9E** (kartu tampil "Segera hadir") |
| Akun | Wizard, deteksi otomatis, tes Masuk/Keluar, simpan terenkripsi, nama/warna/foto, status sinkron, sinkron sekarang/jeda/lanjut/putuskan, larangan alamat Channel Email | Alias/identitas tambahan & tanda tangan → **9B** (9A membuat identitas utama saja) |
| Akses | Pribadi/bersama, Baca · Baca & kirim · Kelola per pengguna/departemen, dari sisi akun & Pengaturan → Tim → **Akses email** | — |
| Folder | Daftar folder, peran RFC 6154 → nama Indonesia, jumlah belum dibaca, buat folder Arsip/Sampah bila tidak ada | Buat/ganti nama/hapus folder sendiri → **9C** |
| Daftar | Gabungan (Semua kotak masuk), Belum dibaca, Berbintang, per folder; kursor; titik warna akun; chip alamat tujuan | Utas, cari, panel Saring, label, urutan lain, kepadatan, tab Prioritas/Lainnya/Untuk saya → **9C/9D** |
| Baca | HTML tersanitasi di iframe sandbox, gambar luar diblokir + proksi + "selalu dari pengirim ini", lencana verifikasi, peringatan pengirim mirip & tautan menipu, lampiran (unduh, pratinjau gambar, blokir berbahaya), lihat header mentah | Panel Info pengirim/CRM, "Simpan ke kontak/tiket", Buat tiket → **9C**; Cetak = fitur web |
| Aksi | Baca/belum, bintang, pindah, arsip, sampah, spam/bukan spam, hapus permanen — dua arah; endpoint menerima ≤ 100 ID | UI pilih banyak + pintasan keyboard → **9C** |
| Tulis | — (tombol Balas/Tulis tampil nonaktif dengan teks "Segera hadir" atau disembunyikan) | Tulis/balas/teruskan, draf, batalkan kirim, `mail_outbox`, salinan Terkirim → **9B**; jadwal kirim → **9E** |
| Real-time | Event WS email (ID saja) lewat soket Inbox yang ada | Notifikasi PWA/browser per akun → **9C** |
| Privasi | Putuskan = hapus seluruh data akun; retensi cache | Ekspor data satu akun (mbox) → **9C** |

## 1. Izin & matriks peran

Tambahan di `PERMISSIONS` (`packages/shared/src/permissions.ts`) — wajib catatan `DECISIONS.md`, baris
tes `permissions.test.ts`, review `security`:

| Izin | Owner | Admin | Supervisor | CS | Teknisi | Arti |
|---|:-:|:-:|:-:|:-:|:-:|---|
| `mail.accounts.manage` | ✅ | ✅ | – | – | – | Tambah/ubah server & kredensial/putuskan akun **bersama**, atur akses semua akun bersama, Pengaturan email (retensi), putuskan akun pribadi milik pengguna nonaktif |
| `mail.view` | ✅ | ✅ | ✅ | ✅ | ✅ | Buka menu Email — **hanya akun yang ia punya hak** |
| `mail.send` | ✅ | ✅ | ✅ | ✅ | ✅ | Kirim (9B) dan aksi pindah/arsip/hapus, hanya di akun berhak "Baca & kirim"/"Kelola" |
| `mail.private.own` | ✅ | ✅ | ✅ | ✅ | – | Menghubungkan akun **pribadi** miliknya sendiri |

Semua cakupan `all` (tanpa `assigned`/`department`): hak nyata ditentukan per akun (§2), bukan oleh
cakupan izin. Tanda "akses hanya departemen sendiri" (Fase 5) **tidak** memengaruhi Email.

Menu Email tampil bila `navigation.mail = true` di respons sesi (`GET /auth/me`, login):
`mail.view` DAN (≥ 1 akun bisa diakses ATAU memegang `mail.private.own` ATAU `mail.accounts.manage`).
Teknisi bawaan → tidak tampil sampai diberi akses. Dihitung ulang saat akses berubah (event WS
`mail.access.changed` → web memuat ulang `/auth/me`).

## 2. Hak per akun

Tingkat: `read` (**Baca**) < `send` (**Baca & kirim**) < `manage` (**Kelola**).

**Resolusi hak efektif** (`resolveMailAccess(user, account)`, satu fungsi di api & worker, dites tabel):

```
jika !user.active atau !hasPermission(user, 'mail.view')           → null
jika account.kind = 'personal':
    user.id = account.owner_user_id                                → 'manage'
    selain itu (TERMASUK Owner/Admin)                              → null  (hanya metadata, lihat bawah)
jika account.kind = 'shared':
    base   = role ∈ {owner, admin} ? 'manage' : null
    direct = grant pengguna itu (mail_account_access, principal user)
    dept   = maks. grant semua departemen tempat pengguna menjadi anggota
    level  = maks(base, direct, dept)
kirim/pindah/arsip/hapus butuh level ≥ 'send' DAN hasPermission(user, 'mail.send')
```

| Aksi | `read` | `send` | `manage` |
|---|:-:|:-:|:-:|
| Lihat folder, daftar, baca, unduh lampiran, lihat header | ✅ | ✅ | ✅ |
| Tandai dibaca/belum, bintang | ✅ | ✅ | ✅ |
| Pindah, arsip, ke Sampah, spam/bukan spam | – | ✅ | ✅ |
| Kirim/balas (9B) | – | ✅ | ✅ |
| Hapus permanen (dari Sampah/Spam) | – | – | ✅ |
| Ubah nama tampilan, warna, foto; sinkron sekarang; jeda/lanjut; jendela sinkron | – | – | ✅ |
| Ubah server/kredensial, atur akses, putuskan | hanya `mail.accounts.manage` (bersama) / pemilik (pribadi) |||

- Akses **tidak bisa dilimpahkan** lewat "Kelola": pemegang Kelola yang bukan Owner/Admin tidak bisa
  menambah orang (mencegah perluasan akses tanpa Owner/Admin).
- **Akun pribadi**: tidak ada baris `mail_account_access` (ditolak 400). Owner/Admin melihat hanya
  **metadata** (`redacted: true`): nama tampilan, alamat, pemilik, penyedia, status sinkron — tanpa
  folder, jumlah, server, username, isi. Semua rute isi (folder, pesan, lampiran, render, aksi, WS)
  memperlakukan akun pribadi orang lain seperti tidak ada (**404**), termasuk untuk Owner. Isolasi ini
  isolasi aplikasi: operator server yang memegang database & master key secara teknis tetap bisa
  membaca — disebut di teks UI akun pribadi ("Admin tidak bisa membaca isinya di aplikasi").
- Pemilik akun pribadi **dinonaktifkan** → akun `owner_inactive` (sinkron berhenti, IDLE ditutup,
  kredensial disimpan). Diaktifkan lagi → lanjut. Owner/Admin (`mail.accounts.manage`) boleh
  **memutus** akun pribadi HANYA saat pemiliknya nonaktif (selain itu 403 "Akun pribadi hanya bisa
  diputus pemiliknya.").
- Pengguna keluar dari departemen / grant dicabut / peran turun → hak hilang seketika (dibaca ulang tiap
  permintaan; soket WS memfilter ulang per event).

## 3. Skema data (migrasi 9A)

Semua tabel: `organization_id` (FK `organizations`, `restrict`), `id` uuid, `created_at`/`updated_at`,
FK komposit `(organization_id, <fk>)` ke induk, sehingga isolasi tenant dijaga database (pola yang
ada). Rahasia: `*_encrypted` (AES-256-GCM `createSecretBox`, konteks = `mail_accounts.<kolom>:<id>`) +
`*_tail` (4 karakter terakhir).

**`mail_accounts`**
| Kolom | Isi |
|---|---|
| `kind` | `shared` · `personal` (CHECK) |
| `owner_user_id` | wajib bila `personal` (CHECK), FK komposit users; `null` untuk bersama |
| `provider` | `cpanel` · `imap` (9A); `microsoft` · `google` · `pop3` disiapkan di CHECK untuk 9E |
| `display_name` | 1–60 |
| `email_address` | huruf kecil, ≤ 254 |
| `from_name` | ≤ 80 (nama pengirim identitas utama) |
| `color` | `tagBlue`·`tagTeal`·`tagPurple`·`accent`·`success`·`warning` (token, tanpa warna baru) |
| `imap_host`, `imap_port` (993/143), `imap_security` (`ssl`·`starttls`), `imap_username`, `imap_password_encrypted`, `imap_password_tail` | |
| `smtp_host`, `smtp_port` (465/587), `smtp_security`, `smtp_username`, `smtp_password_encrypted`, `smtp_password_tail`, `smtp_same_credentials` bool | `same_credentials` = pakai username/password IMAP (password tidak disimpan dua kali) |
| `trusted_auth_serv_ids` text[] | `null` = bawaan `defaultTrustedAuthServIds(imap_host)` |
| `sync_window_days` | 30 · 90 (bawaan) · 365 · `null` (semua) |
| `periodic_sync_minutes` | 1–60, bawaan 5 |
| `sync_state` | `initial_sync` · `ready` · `syncing` · `paused` · `auth_failed` · `error` · `owner_inactive` · `deleting` |
| `sync_paused_by_user_id`, `last_synced_at`, `last_error_code`, `last_error_at`, `consecutive_failures`, `next_attempt_at` | status & backoff |
| `initial_sync_done`, `initial_sync_total` | progres sinkron awal |
| `capabilities` jsonb | `{ idle, condstore, qresync, move, uidplus, specialUse, quota }` hasil `CAPABILITY` terakhir |
| `message_count`, `unread_count` (bigint), `quota_used_bytes`, `quota_limit_bytes` | ringkasan (dari `STATUS`/`GETQUOTAROOT`) |
| `avatar_sha256` | `null` = tanpa foto |
| `created_by_user_id`, `deleted_at` | `deleted_at` terisi saat pemutusan berjalan |

Unik: `(organization_id, email_address)` sebagian `deleted_at is null`; `(organization_id, id)`. Indeks:
`(sync_state, next_attempt_at)`, `(organization_id, owner_user_id)`. Maks. 50 akun per organisasi, 5
akun pribadi per pengguna (service).

**`mail_account_avatars`** — `account_id` PK (FK komposit, `cascade`), `content_type` (`image/png`),
`data` bytea (256×256, ≤ 128 KB, CHECK), `sha256`. **`channel_avatars`** — sama untuk `channel_id`
(foto channel di Inbox, PRD §4.12). Di database (ikut backup), bukan disk — pola `organization_logos`.

**`mail_account_access`** — `account_id` (FK komposit, `cascade`), `principal_type` (`user`·
`department`), `user_id` (FK komposit, `cascade`), `department_id` (FK komposit, `cascade`), `level`
(`read`·`send`·`manage`), `granted_by_user_id`. CHECK tepat satu principal sesuai `principal_type`.
Unik sebagian `(account_id, user_id)` dan `(account_id, department_id)`. Indeks `(organization_id,
user_id)`, `(organization_id, department_id)`. Maks. 200 baris per akun. (Larangan akun pribadi
ditegakkan service + tes.)

**`mail_identities`** — `account_id` (`cascade`), `address`, `display_name`, `is_primary` (unik sebagian
satu per akun), `verified_at`. 9A hanya membuat identitas utama (= alamat akun); alias & tanda tangan 9B.
Unik `(account_id, address)`.

**`mail_folders`** — `account_id` (`cascade`), `path` (nama server mentah, ≤ 1.000), `delimiter`,
`name` (tampilan), `role` (`inbox`·`sent`·`drafts`·`junk`·`trash`·`archive`·`all`·`flagged`·`null`),
`role_source` (`special_use`·`name_guess`·`created`), `parent_id`, `depth`, `selectable`, `subscribed`,
`sync_enabled` (bawaan `true`, `false` untuk `all`/`flagged`), `uidvalidity` (bigint), `uidnext`,
`highest_modseq` (numeric), `total_count`, `unread_count`, `oldest_synced_at` (batas bawah yang sudah
dimuat), `last_synced_at`, `last_full_flag_sweep_at`. Unik `(account_id, path)`; unik sebagian
`(account_id, role)` bila `role` terisi.

**`mail_messages`** (header + status; isi di tabel terpisah supaya daftar ringan)
| Kolom | Isi |
|---|---|
| `account_id`, `folder_id` (`cascade`), `folder_role` (salinan, untuk saringan Belum dibaca/Berbintang tanpa join) | |
| `uid` (bigint), `uidvalidity` (bigint) | posisi di server |
| `message_id_header` (dinormalisasi, ≤ 998), `in_reply_to`, `references` text[] (≤ 20) | utas (dipakai 9B/9C) |
| `from_address`, `from_name` (dibersihkan dari karakter tak terlihat), `sender_address`, `reply_to` jsonb | |
| `to`, `cc` jsonb (`[{ address, name }]`, ≤ 100 masing-masing; sisanya dihitung `to_count`/`cc_count`), `bcc` jsonb (hanya pesan di folder `sent`/`drafts`) | |
| `delivered_to` | alamat tujuan sebenarnya: `Delivered-To` teratas → `X-Original-To` → alamat To/Cc yang cocok identitas/domain akun → `null` |
| `subject` (≤ 998), `snippet` (≤ 200) | |
| `sent_at` (header `Date`), `received_at` (`INTERNALDATE`) | |
| `is_read`, `is_starred`, `is_answered`, `is_draft`, `keywords` text[] | flag server |
| `size_bytes`, `has_attachments` | dari `BODYSTRUCTURE` |
| `sender_verification` (`pass`·`fail`·`unverified`), `auth_details` jsonb (`{ spf, dkim, dmarc, authServId }` dari header tepercaya teratas) | |
| `warnings` text[] | `lookalike_sender` · `impersonation` · `link_mismatch` · `dangerous_attachment` |
| `body_state` | `none` · `loading` · `ready` · `too_large` · `error` |
| `pending_action`, `pending_action_at` | aksi lokal yang belum tercermin di server (§9) |
| `bodystructure` jsonb | peta bagian (untuk ambil isi/lampiran per bagian) |

Unik `(folder_id, uidvalidity, uid)`. Indeks: `(folder_id, received_at desc, id desc)`;
`(organization_id, account_id, received_at desc, id desc)` sebagian `not is_read and folder_role is
distinct from all of ('junk','trash')`; sama untuk `is_starred`; `(account_id, message_id_header)`.
**Ditambah di 9C**: `thread_id`, `search_vector`, label.

**`mail_message_bodies`** — `message_id` PK (FK komposit, `cascade`), `text` (≤ 1 MB, teks polos untuk
tampilan alternatif & cuplikan), `html_sanitized` (≤ 2 MB; lebih → `body_state = too_large`, tampil teks),
`remote_images` jsonb (daftar URL gambar luar yang dicabut dari HTML, ≤ 200, urutan = indeks proksi),
`link_warnings` int, `raw_headers` text (≤ 64 KB, untuk "Lihat header"), `fetched_at`, `last_opened_at`.

**`mail_attachments`** — `message_id` (`cascade`), `part_id` (nomor bagian IMAP), `filename`
(dibersihkan), `declared_type`, `detected_type` (setelah diunduh), `size_bytes`, `content_id`, `is_inline`,
`risk` (`ok`·`warn`·`blocked`), `risk_reason`, `storage_key` (media store folder `mail/`, `null` = belum
diunduh / sudah dipangkas), `fetched_at`, `expires_at`.

**`mail_remote_image_allow`** — `user_id` (FK komposit, `cascade`), `sender_address`. Unik `(user_id,
sender_address)`. Per **pengguna** (preferensi privasi pribadi, juga di akun bersama). Maks. 500/pengguna.

**`mail_settings`** (satu baris per organisasi) — `cache_retention_days` (bawaan 90, 7–3.650; isi &
lampiran email yang tidak dibuka sejak N hari dipangkas, header tetap), `default_sync_window_days` (90),
`updated_by_user_id`.

**Ditunda**: `mail_threads` (9C), `mail_drafts`/`mail_outbox` (9B), `mail_labels`, aturan, penugasan
(9D), kolom OAuth (9E).

## 4. Akun

Alamat `API_ROUTES.mail`. Tulis = CSRF (hook auth), 60/menit/pengguna kecuali disebut lain. Galat §12.

| Endpoint | Izin / hak | Isi |
|---|---|---|
| `GET /api/v1/mail/providers` | `mail.view` | Kartu penyedia: `cpanel`, `imap` (`available: true`), `microsoft`, `google`, `pop3` (`available: false`, `note: "Segera hadir"`). Tanpa logo merek pihak lain (ikon netral, DESIGN) |
| `POST /api/v1/mail/accounts/detect` | `mail.private.own` atau `mail.accounts.manage` | `{ emailAddress }` → saran server (§4.1). 10/5 menit/pengguna |
| `POST /api/v1/mail/accounts/test` | sama | Tes tanpa menyimpan (§4.2). Jatah tes koneksi bersama channel: 10/5 menit/pengguna |
| `POST /api/v1/mail/accounts` | `bersama`: `mail.accounts.manage` + **konfirmasi identitas**; `pribadi`: `mail.private.own` | Buat (§4.3) → **201** `{ account }` |
| `GET /api/v1/mail/accounts` | `mail.view` | Akun yang BISA KUAKSES (menu Email): `{ accounts: [MailAccount + myLevel], canConnectPersonal, canManageShared }` |
| `GET /api/v1/settings/mail-accounts` | `mail.view` | Layar Pengaturan → Akun email: akun bersama berhak `manage` (semua bila `mail.accounts.manage`), akun pribadi milikku (penuh), dan — bila `mail.accounts.manage` — akun pribadi orang lain sebagai metadata `redacted` |
| `GET /api/v1/mail/accounts/:accountId` | level ≥ `read` (pribadi orang lain → 404; metadata lewat daftar pengaturan) | `{ account }` |
| `PATCH /api/v1/mail/accounts/:accountId` | lihat kolom kanan | `displayName`, `color`, `fromName`, `syncWindowDays`, `periodicSyncMinutes`: level `manage`. `imap`, `smtp`, `emailAddress`, `trustedAuthServIds`: bersama = `mail.accounts.manage`, pribadi = pemilik; **wajib konfirmasi identitas** + tes Masuk & Keluar lolos (§4.3). Ganti host/port/keamanan/username tanpa password → 400 (isi ulang password). `kind` tidak bisa diubah |
| `POST /api/v1/mail/accounts/:accountId/test` | level `manage` | Tes dengan kredensial tersimpan → hasil §4.2 + diperbarui `sync.lastTest` |
| `POST /api/v1/mail/accounts/:accountId/sync` | level `manage` | "Sinkron sekarang": antre sinkron semua folder segera → **202**. 6/menit/akun. `auth_failed`/`error` → mencoba lagi sekarang (backoff disetel ulang) |
| `POST /api/v1/mail/accounts/:accountId/pause` · `/resume` | level `manage` | Jeda: IDLE ditutup, tidak ada sinkron; aksi dua arah tertunda tetap dikirim lalu berhenti. Lanjut → `syncing` |
| `DELETE /api/v1/mail/accounts/:accountId` | bersama: `mail.accounts.manage` + konfirmasi; pribadi: pemilik + konfirmasi, atau `mail.accounts.manage` + konfirmasi bila pemilik nonaktif | **Putuskan** → **202** `{ deleting: true }`: kredensial dimusnahkan seketika, `sync_state = deleting`, job menghapus semua `mail_*` + berkas cache bertahap. Server email TIDAK disentuh. Alamat langsung bisa dipakai lagi |
| `PUT /api/v1/mail/accounts/:accountId/avatar` | level `manage` (pribadi: pemilik) | `{ image: base64 }` (PNG/JPEG/WebP dari isi, ≤ 1 MB, sisi ≤ 4.096, SVG ditolak) → dipotong persegi tengah, 256×256 PNG → `{ avatarUrl }` |
| `DELETE …/avatar` | sama | Tanpa foto (inisial + warna) |
| `GET /api/v1/mail/accounts/:accountId/avatar?v=<sha8>` | level ≥ `read`, atau `mail.accounts.manage` untuk metadata akun pribadi | `image/png`, `Cache-Control: private, max-age=31536000, immutable`, `nosniff` |
| `PUT`/`DELETE /api/v1/channels/:channelId/avatar` · `GET …/avatar?v=` | `channels.manage` / `inbox.view` (+ akses per channel 9.0) | Foto channel di Inbox, aturan sama |
| `GET`/`PUT /api/v1/settings/mail` | `mail.accounts.manage` | `{ cacheRetentionDays, defaultSyncWindowDays }`. Audit `settings.mail.updated` |

**`MailAccount`**:

```json
{ "id": "…", "kind": "shared", "provider": "cpanel", "displayName": "CS", "emailAddress": "cs@perusahaan.example",
  "fromName": "Tim CS", "color": "tagBlue", "avatarUrl": "/api/v1/mail/accounts/…/avatar?v=1a2b3c4d",
  "owner": null, "myLevel": "send", "redacted": false,
  "imap": { "host": "mail.perusahaan.example", "port": 993, "security": "ssl", "username": "cs@perusahaan.example", "password": "••••a1b2" },
  "smtp": { "host": "mail.perusahaan.example", "port": 465, "security": "ssl", "sameCredentials": true, "username": null, "password": null },
  "syncWindowDays": 90, "periodicSyncMinutes": 5,
  "sync": { "state": "ready", "lastSyncedAt": "…", "lastErrorCode": null, "lastErrorMessage": null, "lastErrorAt": null,
            "nextAttemptAt": null, "idleActive": true, "initialProgress": null,
            "lastTest": { "testedAt": "…", "incomingOk": true, "outgoingOk": true } },
  "stats": { "messageCount": 3482, "unreadCount": 14, "quota": { "usedBytes": 812000000, "limitBytes": 2147483648 } },
  "createdAt": "…", "updatedAt": "…" }
```

`imap`/`smtp` hanya untuk pemegang hak ubah server (bersama: `mail.accounts.manage`; pribadi: pemilik),
selain itu `null`. Password tidak pernah dikirim (hanya `••••` + 4 karakter terakhir). Bentuk
`redacted`: `{ id, kind: "personal", provider, displayName, emailAddress, color, avatarUrl, owner {id, name,
active}, redacted: true, sync: { state, lastSyncedAt, lastErrorCode } }`.

### 4.1 Deteksi otomatis

`POST /mail/accounts/detect { emailAddress }` → `{ domain, suggestions: [{ source, provider, imap { host,
port, security }, smtp { host, port, security }, username: "address"|"localpart", description }] }`,
terurut dari yang paling yakin. Tidak membuka sambungan IMAP/SMTP (itu tugas tes). Urutan sumber:
1. **Domain penyedia terkenal** (`gmail.com`, `outlook.com`, …) → saran penyedia + catatan "pakai sandi
   aplikasi / Masuk dengan Microsoft segera hadir".
2. **MX** (pola `email-host-detection.ts` yang ada): MX Google/Microsoft → catatan penyedia; MX
   `mail.<domain>`/cPanel → preset **cPanel**.
3. **SRV** RFC 6186/8314: `_imaps._tcp`, `_imap._tcp`, `_submissions._tcp`, `_submission._tcp`.
4. **Autoconfig** (format Thunderbird `config-v1.1.xml`): `https://autoconfig.<domain>/mail/config-v1.1.xml`
   lalu ISPDB `https://autoconfig.thunderbird.net/v1.1/<domain>` (hanya nama domain yang dikirim).
   Diambil `fetchRemoteFile` — https wajib, **alamat privat selalu ditolak** (tanpa allowlist untuk
   deteksi), redirect ≤ 2 diperiksa ulang, ≤ 64 KB, tenggat 5 dtk per URL. XML dibaca dengan pembaca
   minimal tanpa DTD/entitas (hanya `incomingServer type="imap"` + `outgoingServer type="smtp"`:
   `hostname`, `port`, `socketType`, `username`); hanya port & keamanan yang didukung yang diterima.
5. **Tebakan**: `mail.<domain>` (preset cPanel: IMAP 993 SSL/TLS, SMTP 465 SSL/TLS, username = alamat
   lengkap) bila namanya ada di DNS dan lolos `isBlockedMailAddress`.

Semua resolusi DNS dengan batas waktu 3 dtk; tenggat total deteksi 12 dtk (sisa sumber dilewati).
Hasil hanyalah SARAN: host yang dipakai tetap diperiksa penjaga host saat tes & simpan.

Preset (`MAIL_PRESETS`): `cpanel` (judul "cPanel / IDCloudHost", host `mail.<domain>`, 993/ssl, 465/ssl,
username alamat lengkap, panduan "Konfigurasi klien email" di cPanel) dan `imap` (manual, bawaan 993/ssl
+ 587/starttls).

### 4.2 Tes koneksi (Masuk dan Keluar terpisah)

Body: `{ accountId? , emailAddress, imap?: { host, port, security, username, password? }, smtp?: { host,
port, security, sameCredentials, username?, password? }, targets: ["incoming","outgoing"] }` —
`accountId` (level `manage` + hak ubah server) = password kosong memakai yang tersimpan.

```json
{ "testedAt": "…",
  "incoming": { "ok": true, "code": "ok", "message": "Masuk ke IMAP berhasil.", "durationMs": 1100,
                "details": { "folderCount": 14, "inboxTotal": 3482, "specialFolders": ["sent","drafts","junk","trash","archive"],
                             "idle": true, "quota": { "usedBytes": 812000000, "limitBytes": 2147483648 },
                             "estimatedInitialSync": 640 } },
  "outgoing": { "ok": true, "code": "ok", "message": "Masuk ke SMTP berhasil. Tidak ada email yang dikirim saat tes.", "durationMs": 900 } }
```

- Masuk: sambung + TLS + login + `LIST` (dengan `SPECIAL-USE` bila ada) + `STATUS INBOX` +
  `GETQUOTAROOT` (bila didukung) + perkiraan jumlah email dalam jendela sinkron (`SEARCH SINCE`).
  Keluar: `verifySmtpConnection` (sambung + TLS + login, tanpa mengirim).
- Kode & pesan dari daftar tetap (§12.2); teks balasan server hanya DIPINDAI untuk mengenali sebab,
  tidak pernah diteruskan/di-log.
- Hasil gagal tetap **200** (`ok: false`) — ini laporan tes, bukan galat permintaan. Galat permintaan
  (validasi, jatah tes habis) memakai kode HTTP biasa.

### 4.3 Buat akun

```json
{ "kind": "shared", "provider": "cpanel", "displayName": "CS", "emailAddress": "cs@perusahaan.example",
  "fromName": "Tim CS", "color": "tagBlue",
  "imap": { "host": "mail.perusahaan.example", "port": 993, "security": "ssl", "username": "cs@perusahaan.example", "password": "<sandi>" },
  "smtp": { "host": "mail.perusahaan.example", "port": 465, "security": "ssl", "sameCredentials": true },
  "syncWindowDays": 90,
  "access": [ { "principalType": "department", "departmentId": "…", "level": "send" },
              { "principalType": "user", "userId": "…", "level": "manage" } ],
  "confirmation": { "password": "…", "code": "123456" } }
```

Aturan:
- **TLS wajib**: IMAP 993 `ssl` atau 143 `starttls`; SMTP 465 `ssl` atau 587 `starttls`. Port/keamanan
  lain → 400. Sertifikat diverifikasi (tanpa opsi abaikan).
- **Penjaga host**: host di-resolve sekali (`resolveMailHost`), sambungan ke IP terperiksa. Selalu
  diblokir: loopback (production), link-local, metadata cloud, multicast, cadangan, pembungkus IPv4 di
  IPv6 (daftar yang sama dengan webhook keluar). **Alamat privat hanya bila CIDR-nya ada di allowlist
  IP privat organisasi** (Pengaturan → Integrasi; sama dengan webhook keluar) — untuk mail server LAN.
  Beda dengan Email pengirim sistem (Fase 1) yang membolehkan privat; akun Email lebih ketat karena
  dibuat banyak orang termasuk CS (akun pribadi).
- **Server menjalankan tes Masuk & Keluar** di permintaan yang sama; gagal salah satu → **502
  `CHANNEL_REQUEST_FAILED`** dengan `details: [{ field: "imap"|"smtp", reason: <kode tes>, message }]`,
  tidak ada yang disimpan.
- **Alamat sudah menjadi Channel Email Inbox** (channel `email` hidup dengan `email_address` sama) →
  **409 `CONFLICT`** reason `address_is_inbox_channel`: "Alamat ini sudah dipakai sebagai Channel Email
  di Inbox. Satu alamat hanya bisa dipakai di Inbox atau di menu Email. Pengaturannya ada di Pengaturan
  → Channel." (Pengguna tanpa `channels.manage`: kalimat terakhir diganti "Hubungi Owner/Admin.").
  **Arah sebaliknya juga** (perubahan rute Fase 6): membuat/mengubah Channel Email dengan alamat yang
  sudah menjadi akun Email → 409 reason `address_is_mail_account`. Kedua jalur memakai advisory lock
  `email-address:<org>:<alamat>` di transaksi supaya tidak bisa balapan.
- Alamat sudah terhubung sebagai akun Email lain di organisasi → 409 reason `address_already_connected`
  ("Alamat ini sudah terhubung sebagai akun email." — tanpa menyebut pemilik akun pribadi).
- `kind: personal`: `owner_user_id` = pengguna itu, `access` harus kosong (400). Tanpa konfirmasi
  identitas saat membuat; mengubah server/kredensial tetap wajib konfirmasi.
- `access` (bersama, ≤ 200) = aturan §5. Identitas utama (`mail_identities`) dibuat otomatis.
- Setelah dibuat: `sync_state = initial_sync`, folder disinkron, IDLE dimulai (§11). Event WS
  `mail.account.status`.

## 5. Akses akun

Dua tempat, satu sumber data (`mail_account_access`), izin **`mail.accounts.manage`** untuk mengubah.

| Endpoint | Izin | Isi |
|---|---|---|
| `GET /api/v1/mail/accounts/:accountId/access` | `mail.accounts.manage`, atau level `manage` (baca saja) | `{ implicit: [{ role: "owner"|"admin", level: "manage" }], grants: [{ principal, level, grantedBy {id,name}, grantedAt }] }`; `principal` = `{ type: "user", id, name, role, active }` / `{ type: "department", id, name, memberCount }`. Akun pribadi → 400 |
| `PUT /api/v1/mail/accounts/:accountId/access` | `mail.accounts.manage` | `{ grants: [{ principalType, userId \| departmentId, level }], confirmation? }` — mengganti seluruh daftar. **Menambah principal atau menaikkan tingkat wajib konfirmasi identitas**; hanya mengurangi/menurunkan tidak. Pengguna nonaktif/departemen lain organisasi → 400. Grant untuk Owner/Admin → 400 ("Owner dan Admin otomatis punya hak Kelola di semua akun bersama.") |
| `GET /api/v1/settings/team/:userId/mail-access` | `mail.accounts.manage` | Tab **Akses email** di Pengaturan → Tim → [pengguna]: `{ user {id,name,role,active}, menuVisible, canConnectPersonal, accounts: [{ account {id, displayName, emailAddress, color}, effectiveLevel, directLevel, sources: [{ type: "role"\|"user"\|"department", level, department? {id,name} }] }], personalAccounts: [{ id, emailAddress, syncState }] }` — `accounts` = SEMUA akun bersama (termasuk yang belum diakses, `effectiveLevel: null`) |
| `PUT /api/v1/settings/team/:userId/mail-access` | `mail.accounts.manage` | `{ grants: [{ accountId, level: "read"\|"send"\|"manage"\|null }], confirmation? }` — hanya grant LANGSUNG pengguna itu (`null` = cabut); grant departemen diubah dari sisi akun. Aturan konfirmasi sama |

Audit `mail.access.updated` `{ accountId, added, removed, changed (principal + level lama/baru) }`.
Perluasan oleh Admin → kejadian keamanan `mail_access_changed` (`warning`) + email semua Owner (pola
perubahan channel); oleh Owner → `info`. Setelah commit: event WS `mail.access.changed` ke pengguna
yang terdampak (§10).

## 6. Folder

| Endpoint | Hak | Isi |
|---|---|---|
| `GET /api/v1/mail/sidebar` | `mail.view` | Kolom kiri sekali jalan: `{ unified: { unreadCount }, unread: { count }, starred: { count }, accounts: [{ account: { id, displayName, emailAddress, color, avatarUrl, myLevel, sync { state } }, folders: [MailFolder] }] }` |
| `GET /api/v1/mail/accounts/:accountId/folders` | `read` | `{ folders: [MailFolder] }` |
| `POST /api/v1/mail/folders/:folderId/load-older` | `read` | Ambil 200 header lebih lama dari `oldest_synced_at` → **202**; hasil lewat event WS `mail.folder.counts` + muat ulang daftar. 10/menit/pengguna |

`MailFolder`: `{ id, accountId, path, name, role, parentId, depth, selectable, unreadCount, totalCount,
syncEnabled, hasOlderOnServer }`.

Peran RFC 6154 → nama Indonesia (urutan tampil): `inbox` **Kotak masuk** · `drafts` **Draf** · `sent`
**Terkirim** · `archive` **Arsip** · `junk` **Spam** · `trash` **Sampah**; lalu folder sendiri urut abjad
dengan nama apa adanya (awalan namespace `INBOX.`/`INBOX/` dibuang dari tampilan). `\All` (**Semua
email**) dan `\Flagged` disembunyikan bawaan dan tidak disinkron (isinya duplikat). Tanpa `SPECIAL-USE`:
tebakan nama (tanpa beda huruf, dengan/tanpa awalan `INBOX.`): `Sent`, `Sent Items`, `Sent Messages`,
`Terkirim` → sent; `Drafts`, `Draf` → drafts; `Junk`, `Spam`, `Junk E-mail` → junk; `Trash`, `Deleted
Items`, `Deleted Messages`, `Sampah` → trash; `Archive`, `Archives`, `Arsip` → archive.
`unreadCount` = `STATUS UNSEEN` server, disesuaikan seketika oleh aksi lokal.

## 7. Daftar email

`GET /api/v1/mail/messages?view=&accountId=&folderId=&cursor=&limit=` (`mail.view`; 240/menit/pengguna)

| `view` | Isi |
|---|---|
| `inboxes` | **Semua kotak masuk**: folder `inbox` semua akun berhak `read` (bisa disaring `accountId`) |
| `unread` | **Belum dibaca**: semua folder kecuali Spam & Sampah, semua akun berhak (atau `accountId`) |
| `starred` | **Berbintang**: sama, `is_starred` |
| `folder` | Satu folder (`folderId` wajib; hak `read` di akunnya) |

Urut `received_at` terbaru lalu `id` (9A hanya urutan ini). `limit` 1–100 (bawaan 50). `cursor` = opak
(base64url dari `received_at` + `id`). → `{ messages: [MailMessageSummary], nextCursor, olderOnServer }`
(`olderOnServer` = folder tunggal masih punya email di server yang lebih lama dari jendela sinkron →
web menampilkan "Muat email lebih lama" yang memanggil `load-older`).

`MailMessageSummary`:

```json
{ "id": "…", "accountId": "…", "folderId": "…",
  "account": { "id": "…", "displayName": "Billing", "color": "tagTeal" },
  "from": { "address": "noc@mitra.example", "name": "NOC Mitra" },
  "to": [{ "address": "cs@perusahaan.example", "name": null }], "toCount": 1, "ccCount": 1,
  "subject": "Pemeliharaan terjadwal 26 November", "snippet": "Tanggal Rabu, 26 November 2026 …",
  "receivedAt": "…", "sentAt": "…", "isRead": false, "isStarred": false, "isAnswered": false,
  "hasAttachments": true, "sizeBytes": 48211,
  "deliveredTo": "billing@perusahaan.example", "deliveredToAlias": true,
  "senderVerification": "pass", "warnings": [] }
```

- **Titik warna akun** = `account.color`; web menampilkan nama akun di tampilan gabungan.
- **Chip "ke billing@"**: `deliveredToAlias = true` bila `deliveredTo` ≠ alamat identitas utama akun.
  Panel baca: "Diterima di **<displayName>** · dikirim ke **<deliveredTo>**".
- Hitungan & cuplikan dihitung server. Target: akun 50.000 email → daftar < 300 ms, ganti folder
  < 500 ms (indeks §3; tes beban di qa).
- Pesan dengan `pending_action` pindah/hapus tidak tampil di folder asal (sudah dianggap pindah).

## 8. Baca email

| Endpoint | Hak | Isi |
|---|---|---|
| `GET /api/v1/mail/messages/:messageId` | `read` | Detail (bawah). Isi belum ada → `body.state: "loading"` + job ambil isi prioritas tinggi; event WS `mail.message.updated` saat siap. TIDAK menandai dibaca (web memanggil aksi `mark_read`) |
| `POST /api/v1/mail/messages/:messageId/view` | `read` | `{ images: "auto"\|"show" }` → `{ url, expiresAt, remoteImages: { count, shown } }` — URL dokumen tampilan (token 10 menit). `auto` = tampilkan gambar bila pengirim ada di daftar "selalu" pengguna itu. 120/menit/pengguna |
| `GET /api/v1/mail/view/:token` | token | Dokumen HTML tersanitasi untuk iframe (bawah) |
| `GET /api/v1/mail/view/:token/images/:index` | token (`images` aktif) | Proksi gambar luar |
| `GET /api/v1/mail/view/:token/cid/:attachmentId` | token | Gambar inline (`cid:`) milik email itu |
| `GET /api/v1/mail/messages/:messageId/source` | `read` | Header mentah (`text/plain; charset=utf-8`, ≤ 64 KB, `attachment` bila diminta `?download=1`). Isi badan tidak disertakan |
| `GET /api/v1/mail/attachments/:attachmentId` | `read` | Unduh (bawah) |
| `GET /api/v1/mail/attachments/:attachmentId/preview` | `read` | Gambar raster saja (PNG/JPEG/GIF/WebP dari isi), inline, ≤ 10 MB |
| `GET`/`POST`/`DELETE /api/v1/mail/remote-image-senders` | `mail.view` | Daftar "Selalu tampilkan gambar dari pengirim ini" milik pengguna: `{ senders: [{ address, createdAt }] }` / `{ address }` |

Detail `GET /mail/messages/:id` → `{ message }`: semua isian ringkasan + `cc`, `bcc` (hanya Terkirim/
Draf), `replyTo`, `to` lengkap, `messageIdHeader`, `receivedVia { accountId, displayName, address:
deliveredTo }`, `verification { result, label, spf, dkim, dmarc, authServId }`, `warnings: [{ type,
message }]`, `body { state, hasHtml, text, remoteImages: { count, senderAllowed } }`, `attachments:
[{ id, filename, contentType, sizeBytes, isInline, risk, riskMessage, previewable, cached }]`.

**Lencana verifikasi** — `emailSenderVerification` Fase 6 dengan `trusted_auth_serv_ids` akun: `pass`
"Terverifikasi" (`ShieldCheck`), `unverified` netral "Pengirim tidak diverifikasi server email", `fail`
peringatan keras "Email ini gagal pemeriksaan keaslian pengirim. Hati-hati dengan tautan dan
lampirannya." Hanya header `Authentication-Results` TERATAS dari server tepercaya.

**Peringatan** (dihitung saat isi diambil; pesan Indonesia tetap):
- `impersonation`: nama tampilan pengirim sama (tanpa beda huruf/spasi) dengan nama anggota tim aktif
  atau nama organisasi, atau memuat alamat domain organisasi, TETAPI domain From bukan domain
  organisasi (domain akun Email + Channel Email). "Nama pengirim mirip orang/organisasi kita, tetapi
  dikirim dari luar."
- `lookalike_sender`: domain From mirip domain organisasi (jarak edit ≤ 2, atau sama setelah
  penyetaraan huruf mirip / punycode) tetapi tidak sama. "Alamat pengirim mirip domain kita."
- `link_mismatch`: teks tautan berbentuk alamat/domain yang berbeda dengan domain tujuan `href`. Tautan
  itu ditulis ulang ke halaman peringatan web `/email/tautan?ke=<url>&tampil=<domain>` (tanpa
  pengalihan otomatis; pengguna menekan "Tetap buka").
- `dangerous_attachment`: ada lampiran `blocked`.

**Dokumen tampilan** (`GET /mail/view/:token`):
- HTML disanitasi SERVER saat isi diambil (`sanitizeMailHtmlForDisplay`, profil baru — profil Fase 6
  membuang semua gaya & gambar sehingga terlalu miskin untuk klien email): boleh struktur/tabel, `style`
  inline (daftar properti izin, tanpa `url()`/`expression`/`position: fixed`), elemen `<style>` (tanpa
  `@import`/`url()`), gambar. Dibuang: skrip, `on*`, `javascript:`/`vbscript:`/`data:` selain gambar
  raster ≤ 512 KB, `iframe`/`frame`/`object`/`embed`/`applet`, form & input, `svg`/`math`, `meta`
  (termasuk refresh), `base`, `link`, media. Semua `<a>` → `target="_blank" rel="noopener noreferrer
  nofollow"`, hanya `http(s):`/`mailto:`.
- Gambar luar: saat sanitasi, setiap `src` http(s) dicabut ke `remote_images[i]` dan diganti penanda;
  saat dokumen disajikan diganti `…/images/<i>` (bila `images` aktif) atau gambar kosong + teks alt. `cid:`
  → `…/cid/<attachmentId>`. Tidak ada permintaan dari browser ke server pihak ketiga.
- Header respons: `Content-Type: text/html; charset=utf-8`, **`Content-Security-Policy: default-src
  'none'; img-src <origin aplikasi> data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none';
  form-action 'none'; frame-ancestors <origin aplikasi>; sandbox allow-popups
  allow-popups-to-escape-sandbox`**, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`. `X-Frame-Options:
  DENY` global DIKECUALIKAN hanya untuk rute ini (digantikan `frame-ancestors`).
- Web: `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" src="<url>"
  referrerpolicy="no-referrer">` — TANPA `allow-scripts` dan `allow-same-origin`. Karena dokumen
  ber-origin opak, cookie sesi tidak terkirim; autentikasi = **token**.
- **Token**: `base64url(payload).HMAC-SHA256` (kunci HKDF dari master key, label `mail-view`); payload
  `{ org, user, message, sessionHash, images, exp (10 menit) }`. Setiap permintaan token memeriksa ulang:
  sesi asal masih sah (tidak dicabut/kedaluwarsa), pengguna aktif, hak `read` masih ada, pesan masih
  ada. Token tidak dicatat di log (path disensor).
- **Proksi gambar**: URL diambil dari `remote_images[index]` (bukan dari klien → bukan proksi terbuka),
  `fetchRemoteFile` dengan **https saja**, alamat privat SELALU ditolak (allowlist tidak berlaku),
  redirect ≤ 3 diperiksa ulang, ≤ 5 MB, tenggat 8 dtk, tanpa cookie/Referer, User-Agent umum. Jenis dari
  isi: PNG/JPEG/GIF/WebP; selain itu (termasuk SVG) → 415 + gambar kosong. Disimpan sementara 24 jam
  (`sha256(url)` per organisasi) supaya membuka ulang tidak memberi tahu pengirim lagi. 300/menit/
  pengguna. Gambar `http:` tetap diblokir (v1).
- "Tampilkan gambar" = `view` dengan `images: "show"` (sekali). "Selalu dari pengirim ini" =
  `POST /mail/remote-image-senders`. Email `fail` tidak pernah menampilkan gambar otomatis walau
  pengirimnya ada di daftar.

**Lampiran** (`GET /mail/attachments/:id`):
- `risk` dari nama + jenis yang dinyatakan saat sinkron, dipastikan ulang dari isi saat diunduh
  (`classifyEmailAttachment` + daftar tambahan): `blocked` = berkas eksekusi, makro Office, skrip,
  HTML/SVG, pintasan, citra disk → **403** "Lampiran ini diblokir karena berisiko (program, makro, atau
  halaman web). Minta pengirim mengirim dalam bentuk PDF." ; `warn` = arsip (`zip`, `rar`, `7z`) →
  butuh `?confirm=1` (tanpa → 409 reason `attachment_needs_confirmation`); `ok` = langsung.
- Belum di cache → **202** `{ state: "loading" }` + job ambil bagian itu dari IMAP; event WS
  `mail.attachment.ready`. Di cache → 200, `Content-Disposition: attachment; filename*=UTF-8''…`,
  `Content-Type` hasil deteksi (tak dikenal → `application/octet-stream`), `nosniff`, `CSP: sandbox`.
- > 50 MB → 413 "Lampiran terlalu besar untuk diunduh lewat aplikasi. Buka lewat webmail penyedia."
- Disimpan di media store folder `mail/` dengan `expires_at` = retensi cache (§3 `mail_settings`).

## 9. Aksi dua arah

`POST /api/v1/mail/messages/actions` (`mail.view`, CSRF, 120/menit/pengguna)

```json
{ "messageIds": ["…", "…"], "action": "move", "targetFolderId": "…" }
```

| `action` | Hak min. | Server (IMAP) |
|---|---|---|
| `mark_read` · `mark_unread` | `read` | `UID STORE ±FLAGS (\Seen)` |
| `star` · `unstar` | `read` | `±FLAGS (\Flagged)` |
| `move` (`targetFolderId` wajib, akun yang sama) | `send` | `UID MOVE` (RFC 6851); tanpa MOVE: `UID COPY` + `\Deleted` + `UID EXPUNGE` (UIDPLUS); tanpa UIDPLUS: `COPY` + `\Deleted` saja (tidak pernah `EXPUNGE` biasa yang bisa menghapus email lain bertanda `\Deleted`) |
| `archive` | `send` | pindah ke folder peran `archive`; tidak ada → dibuat `Archive` (sesuai namespace/pemisah server) sekali, `role_source: created` |
| `trash` | `send` | pindah ke `trash` (dibuat `Trash` bila tidak ada); pesan sudah di Sampah → 400 (pakai `delete_permanently`) |
| `spam` · `not_spam` | `send` | pindah ke `junk` / dari `junk` ke `inbox` (+ keyword `$Junk`/`$NotJunk` bila server mendukung keyword) |
| `delete_permanently` | `manage` | hanya pesan di Sampah/Spam (lainnya 400); `\Deleted` + `UID EXPUNGE`; **audit** `mail.message.deleted_permanently` `{ accountId, folderId, count }` |

- 1–100 ID; boleh lintas akun untuk aksi flag/arsip/sampah/spam (`move` hanya satu akun). Hak diperiksa
  per pesan; respons **200** `{ results: [{ id, ok, error?: { code, message } }], applied }` (sebagian
  boleh gagal, mis. hak kurang → `FORBIDDEN`, sudah tidak ada → `NOT_FOUND`).
- **Optimistis**: database diperbarui di transaksi permintaan (flag/pindah folder + `pending_action`),
  hitungan folder disesuaikan, event WS dikirim; job `mail-action` menerapkan ke server (berurutan per
  akun). Gagal di server (setelah 3 percobaan) → perubahan lokal dikembalikan + event WS
  `mail.action.failed { accountId, messageIds, action, code }` + pesan "Perubahan belum tersimpan di
  server email. Coba lagi." Sinkron berikutnya selalu menjadikan server sebagai kebenaran.
- Akun `paused`/`auth_failed`/`error` → aksi tetap diterima dan tertunda sampai tersambung (maks. 24 jam,
  lalu dikembalikan).

## 10. Real-time (WebSocket)

Memakai soket yang ada `GET /api/v1/inbox/stream` (autentikasi, Origin, heartbeat, penutupan, gabung
per 250 ms = KONTRAK-API-INBOX). Event baru — **ID & angka saja**, tanpa subjek/alamat/nama/isi:

| `type` | Isian | Kapan |
|---|---|---|
| `mail.message.created` | `accountId`, `folderId`, `messageId`, `receivedAt` | header email baru tersimpan |
| `mail.message.updated` | `accountId`, `messageId`, `fields: ("flags"\|"folder"\|"body")[]` | flag berubah, dipindah, isi siap |
| `mail.message.deleted` | `accountId`, `folderId`, `messageId` | hilang dari server / dihapus |
| `mail.folder.counts` | `accountId`, `folderId`, `unreadCount`, `totalCount` | hitungan berubah (digabung per 1 dtk per folder) |
| `mail.account.status` | `accountId`, `syncState`, `lastSyncedAt`, `errorCode`, `initialProgress` | status sinkron berubah |
| `mail.attachment.ready` | `accountId`, `attachmentId` | lampiran selesai diunduh |
| `mail.action.failed` | `accountId`, `messageIds` (≤ 100), `action`, `code` | aksi dua arah dikembalikan |
| `mail.access.changed` | — | hak pengguna ini atas akun mana pun berubah → web memuat ulang `/auth/me`, sidebar |
| `mail.resync` | `accountId` | terlalu banyak event akun ini (mis. sinkron awal/`UIDVALIDITY`) → web memuat ulang daftar & sidebar |

**Penyaringan per penerima**: setiap event dikirim hanya ke soket yang penggunanya punya hak ≥ `read`
atas `accountId` SAAT ITU (`resolveMailAccess`, di-cache per soket ≤ 30 dtk, dibuang saat
`mail.access.changed`); akun pribadi → hanya pemiliknya. Maks. 50 event `mail.*`/dtk per akun, lebih →
satu `mail.resync` per 5 dtk. Jalur: worker/api menerbitkan ke Redis pub/sub `inbox-events` setelah
commit (paling banyak sekali; kegagalan Redis tidak menggagalkan sinkron).

## 11. Worker sinkron

**Antrian BullMQ `mail`** (job ID unik per sasaran supaya tidak menumpuk):

| Job | Pemicu | Kerja |
|---|---|---|
| `mail-tick` | berulang tiap 30 dtk | Pilih akun aktif yang jatuh tempo (`next_attempt_at`, folder `last_synced_at + periodic_sync_minutes`), antre `mail-sync-folder` & `mail-sync-folders` |
| `mail-sync-folders` | akun baru, tiap 30 menit, "Sinkron sekarang" | `LIST "" "*"` (+ `RETURN (SPECIAL-USE)`), petakan peran, buat/hapus `mail_folders`, `STATUS` (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ) |
| `mail-sync-folder` | tick, IDLE (`EXISTS`/`EXPUNGE`/`FETCH`), "Sinkron sekarang" | Sinkron inkremental satu folder (bawah) |
| `mail-load-older` | `load-older` | 200 header berikutnya yang lebih lama |
| `mail-fetch-body` | buka email (prioritas 1), pra-ambil latar (prioritas 10) | Ambil `BODY.PEEK[]` (≤ 25 MB; lebih → `too_large`, tampil teks dari bagian teks saja), `parseInboundEmail`, sanitasi tampilan, `remote_images`, peringatan, lampiran inline gambar ≤ 5 MB disimpan |
| `mail-fetch-attachment` | unduh lampiran | `BODY.PEEK[<part>]` satu bagian, cek jenis dari isi, simpan |
| `mail-action` | aksi §9 | Terapkan ke server, berurutan per akun |
| `mail-purge-account` | putuskan | Hapus baris & berkas per 1.000 |
| `mail-cache-retention` | harian | Pangkas isi/lampiran yang tidak dibuka > `cache_retention_days` |

**Pengawas IDLE** (`apps/worker/src/mail-idle/`, di dalam proses worker, bukan job):
- **Satu sambungan IDLE per akun** untuk folder Kotak masuk. Kepemilikan lewat sewa Redis
  `mail:idle:<accountId>` (`SET NX PX 60000`, diperpanjang tiap 20 dtk) sehingga beberapa replika worker
  tidak pernah membuka IDLE ganda. Daftar akun dipindai tiap 30 dtk; akun `paused`/`auth_failed`/
  `owner_inactive`/`deleting` ditutup.
- `IDLE` diperbarui tiap 25 menit (RFC 2177 < 29 menit); notifikasi `EXISTS`/`EXPUNGE`/`FETCH` →
  antre `mail-sync-folder` INBOX (debounce 2 dtk). Target email baru tampil < 10 dtk.
- Server tanpa `IDLE` → Kotak masuk dipolling tiap 2 menit (folder lain tetap `periodic_sync_minutes`).
- Batas per proses: 200 sambungan IDLE; lebih → akun sisanya dipolling 2 menit (log peringatan +
  `sync.idleActive: false`).
- **Batas sambungan per akun**: maks. 2 bersamaan (1 IDLE + 1 kerja) lewat semafor Redis
  `mail:conn:<accountId>`; job yang tidak kebagian ditunda 5 dtk (bukan gagal). Banyak server cPanel/
  Dovecot membatasi sambungan per pengguna+IP (`mail_max_userip_connections`).

**Sinkron inkremental satu folder**:
1. `SELECT` (dengan `CONDSTORE`/`QRESYNC` bila ada). **`UIDVALIDITY` berubah** → hapus semua
   `mail_messages` folder itu (data Balesin-saja yang menyusul di 9D dikaitkan lewat `Message-ID`),
   setel ulang posisi, ulangi seperti sinkron awal folder; event `mail.resync`.
2. Email baru: `UID FETCH <uidnext>:*` (ENVELOPE, FLAGS, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE,
   `BODY.PEEK[HEADER.FIELDS (DELIVERED-TO X-ORIGINAL-TO AUTHENTICATION-RESULTS REFERENCES IN-REPLY-TO
   LIST-UNSUBSCRIBE AUTO-SUBMITTED PRECEDENCE)]`, + ≤ 4 KB awal bagian teks untuk cuplikan) per 100 UID.
   Hanya email dalam jendela sinkron (`received_at` ≥ sekarang − `sync_window_days`).
3. Perubahan flag: `CHANGEDSINCE <highest_modseq>` bila `CONDSTORE`; tanpa itu `FETCH FLAGS` 500 UID
   terbaru tiap putaran + sapuan penuh dalam jendela tiap 1 jam.
4. Email hilang: `VANISHED` (QRESYNC) bila ada; tanpa itu `UID SEARCH SINCE <batas jendela>` dibanding
   UID lokal (dalam sapuan 1 jam, dan segera setelah `EXPUNGE` IDLE untuk Kotak masuk).
5. Perbarui `uidnext`, `highest_modseq`, hitungan, `last_synced_at`; event WS.

**Sinkron awal**: `sync_state = initial_sync`; urutan folder: Kotak masuk → Terkirim → Draf → lainnya;
`UID SEARCH SINCE <sekarang − jendela>` lalu header diambil **dari yang terbaru** per 200 sehingga daftar
langsung terisi; progres `initialProgress { done, total }`. Isi email **tidak** diunduh semua: diambil
saat dibuka; pra-ambil latar untuk Kotak masuk 7 hari terakhir, email ≤ 256 KB, maks. 200 per akun per
jam. Email lebih lama dari jendela: `load-older` (scroll) dan "Cari juga di server" (9C).

**Ketahanan**:
- Gagal sambung/TLS/jaringan → `error`, `consecutive_failures + 1`, `next_attempt_at` = 1, 2, 5, 15, 30,
  lalu **60 menit (maks.)**. Berhasil → setel ulang.
- Login ditolak → `auth_failed`, **berhenti mencoba** (cegah akun terkunci penyedia), event status,
  notifikasi ke pemilik (pribadi) / pemegang Kelola + Owner/Admin (bersama): "Password akun email
  <alamat> ditolak. Perbarui di Pengaturan → Akun email." Pulih hanya setelah kredensial diperbarui atau
  "Sinkron sekarang".
- Kredensial tidak bisa dibuka (master key berubah) → `auth_failed` kode `secret_unavailable`.
- Batas waktu IMAP = `DEFAULT_IMAP_TIMEOUTS`, literal/respons dibatasi; balasan server tidak pernah
  di-log.
- Teks yang disimpan dari header (nama, subjek) dibersihkan dari karakter kendali & pengubah arah.

## 12. Model galat & kode tes

Amplop `{ error: { code, message, details?, requestId } }` + `details[].reason` opsional (tambahan
kompatibel yang juga dipakai KONTRAK-API-EMAIL-KIRIM). Teks Indonesia, "kamu", tanpa nama produk.

### 12.1 Galat endpoint

| HTTP | `code` / `reason` | Kapan / pesan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | isian salah; `port_not_allowed` "Port IMAP 993 (SSL/TLS) atau 143 (STARTTLS); SMTP 465 (SSL/TLS) atau 587 (STARTTLS)."; `password_required` "Server berubah — isi ulang password-nya."; `personal_account_no_access` "Akun pribadi tidak bisa dibagikan."; `grant_for_admin`; `cross_account_move` "Email hanya bisa dipindah ke folder di akun yang sama."; `already_in_trash` |
| 403 | `FORBIDDEN` | izin/level kurang (via `forbidByRule`, diaudit `auth.access.denied`); `personal_owner_only` "Akun pribadi hanya bisa diubah atau diputus pemiliknya."; `attachment_blocked` (pesan risiko di §8) |
| 404 | `NOT_FOUND` | akun/folder/pesan tidak ada ATAU akun pribadi orang lain ATAU tanpa hak `read` |
| 409 | `CONFLICT` | `address_is_inbox_channel`, `address_is_mail_account` (rute Channel), `address_already_connected`, `account_deleting` "Akun ini sedang diputus.", `attachment_needs_confirmation`, `limit_reached` "Maksimal 50 akun email per organisasi / 5 akun pribadi per pengguna." |
| 413 | `PAYLOAD_TOO_LARGE` | foto > 1 MB, lampiran > 50 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | foto bukan PNG/JPEG/WebP; proksi gambar bukan gambar raster |
| 429 | `RATE_LIMITED` | jatah deteksi/tes/aksi/daftar (+ `Retry-After`) |
| 502 | `CHANNEL_REQUEST_FAILED` | buat/ubah akun: tes Masuk/Keluar gagal (`details[].reason` = kode §12.2) |
| 503 | `SERVICE_UNAVAILABLE` | master key tidak ada (tidak bisa menyimpan kredensial); pencarian/daftar > 3 dtk |

Token tampilan tidak sah/kedaluwarsa/sesi dicabut → 401 `UNAUTHENTICATED` (dokumen kosong; web meminta
token baru sekali, lalu menampilkan "Muat ulang email").

### 12.2 Kode tes koneksi (`MAIL_TEST_MESSAGES`)

Masuk (memakai ulang `CONNECTION_TEST_MESSAGES` `imap_*` Fase 6, teks disesuaikan "akun email"):
`ok`; `imap_host_not_found`; `imap_host_blocked` (termasuk privat tanpa allowlist: "Server email di
jaringan lokal harus didaftarkan dulu di Pengaturan → Integrasi → Jaringan privat."); `imap_port_not_allowed`;
`imap_connection_refused`; `imap_connection_timeout`; `imap_tls_failed`; `imap_certificate_invalid`;
`imap_auth_failed`; **baru**: `imap_not_enabled` ("Akses IMAP belum diaktifkan di akun ini. Aktifkan di
pengaturan email penyedia (Gmail: Setelan → Penerusan dan POP/IMAP)."), `imap_app_password_required`
("Penyedia meminta sandi aplikasi, bukan password biasa. Buat sandi aplikasi di pengaturan keamanan
akunmu."), `imap_too_many_connections` ("Server menolak karena terlalu banyak sambungan dari akun ini.
Tutup aplikasi email lain sebentar, lalu coba lagi."), `imap_quota_full` (peringatan, `ok` tetap
`true`: "Kotak surat hampir/sudah penuh (≥ 95%). Email baru bisa ditolak server."),
`secret_unavailable`, `unknown`.

Keluar (memakai ulang `EMAIL_TEST_MESSAGES` dengan awalan `smtp_`): `smtp_host_not_found`,
`smtp_host_blocked`, `smtp_port_not_allowed`, `smtp_connection_refused`, `smtp_connection_timeout`
(+ "Banyak jaringan memblokir port 465/587 keluar; tanyakan ke penyedia server."), `smtp_tls_failed`,
`smtp_certificate_invalid`, `smtp_auth_failed`, `smtp_auth_unsupported`; **baru**:
`smtp_auth_disabled_m365` ("Microsoft 365 mematikan SMTP AUTH untuk akun ini. Admin Microsoft 365 perlu
mengaktifkan 'Authenticated SMTP' untuk kotak surat ini, atau tunggu 'Masuk dengan Microsoft'."),
`smtp_app_password_required`, `secret_unavailable`, `unknown`. Pengenalan dari kode balasan + pemindaian
teks (mis. `5.7.139`, `534-5.7.9`), teks tidak diteruskan.

## 13. Keamanan, audit, log, privasi

- **Rahasia**: password IMAP/SMTP dienkripsi AES-256-GCM, dibuka hanya saat sambungan dibuat, tidak
  pernah ke browser/log/galat. Respons `no-store` untuk rute akun.
- **SSRF**: host IMAP/SMTP lewat `resolveMailHost` (privat hanya allowlist organisasi), deteksi & proksi
  gambar lewat `fetchRemoteFile` (privat selalu ditolak). Port dibatasi. Tanpa redirect tak terperiksa.
- **HTML**: sanitasi server + dokumen ber-CSP sendiri + iframe sandbox tanpa skrip/same-origin + gambar
  lewat proksi. Teks email = data tak tepercaya di semua tempat.
- **Lampiran**: jenis dari isi, berbahaya diblokir, `attachment` + `nosniff` + `CSP: sandbox`.
- **Otorisasi**: setiap rute memanggil `resolveMailAccess`; tes tabel peran × jenis akun × tingkat ×
  endpoint (termasuk "Owner tidak bisa membaca akun pribadi" untuk daftar, detail, view token, lampiran,
  aksi, WS, sidebar, hitungan). `assertActorStillAuthorized` di transaksi aksi tulis sensitif (ubah
  server, akses, putuskan).
- **Audit** (`targetType: mail_account`, TANPA subjek/isi/alamat lawan): `mail.account.created`,
  `.updated` (`changedFields`), `.credentials_updated`, `.paused`, `.resumed`, `.deleted`,
  `.avatar_updated`; `mail.access.updated`; `mail.message.deleted_permanently` (jumlah);
  `settings.mail.updated`; `channel.avatar_updated`. Kejadian keamanan: `mail_account_changed` (akun
  bersama dibuat / server-kredensial diubah / diputus — `warning` bila oleh Admin, `info` oleh Owner)
  dan `mail_access_changed` (§5). Akun pribadi: audit hanya ID + alamat akun.
- **Log**: ID akun/folder/pesan, kode galat, durasi, jumlah. TIDAK: subjek, alamat lawan, isi, nama
  berkas, URL gambar, token tampilan, username IMAP.
- **Privasi (UU PDP)**: putuskan = hapus seluruh cache akun (header, isi, lampiran, cache gambar);
  retensi cache diatur; akun pribadi terisolasi di aplikasi; ekspor satu akun menyusul 9C. Backup
  database ikut memuat cache email (disebut di panduan backup).

## 14. Keputusan (untuk dipindah ke `DECISIONS.md`)

1. **Izin `mail.*` bercakupan `all`; hak nyata per akun** lewat `resolveMailAccess` (satu fungsi, dites
   tabel). Tanda "akses hanya departemen sendiri" tidak berlaku untuk Email.
2. **"Kelola" tidak bisa menambah akses**; mengubah server/kredensial/akses/putuskan akun bersama hanya
   `mail.accounts.manage` (Owner/Admin). Perluasan akses wajib konfirmasi identitas; pengurangan tidak.
3. **Akun pribadi orang lain = 404 di semua rute isi, termasuk Owner**; Owner/Admin hanya melihat
   metadata di Pengaturan dan hanya bisa memutus bila pemiliknya nonaktif. Pemilik nonaktif →
   `owner_inactive` (sinkron berhenti).
4. **Hak "Baca" boleh menandai dibaca & membintangi** (flag bersama di server, seperti kotak surat
   bersama Outlook); pindah/arsip/hapus butuh "Baca & kirim"; hapus permanen butuh "Kelola".
5. **Membuka email tidak otomatis menandai dibaca di server** — web memanggil `mark_read` (GET tetap
   tanpa efek samping, CSRF terjaga).
6. **Alamat privat untuk server akun Email hanya lewat allowlist** IP privat organisasi yang sama dengan
   webhook keluar (lebih ketat dari Email pengirim sistem). Deteksi otomatis & proksi gambar tidak
   pernah ke alamat privat.
7. **Buat/ubah server wajib lolos tes Masuk & Keluar** di permintaan yang sama (502 bila gagal).
8. **Larangan alamat ganda dua arah** (akun Email ↔ Channel Email) dengan advisory lock bersama.
9. **Tampilan HTML lewat dokumen ber-token** (`/mail/view/:token`, CSP sendiri, `frame-ancestors`),
   bukan `srcdoc` seperti Fase 6 — supaya `<style>` email bisa dipakai tanpa melonggarkan CSP aplikasi,
   dan karena iframe ber-origin opak tidak membawa cookie. Token 10 menit terikat sesi.
10. **Profil sanitasi tampilan baru** (gaya & gambar dipertahankan, gambar luar dicabut ke daftar
    proksi). Gambar `http:` tetap diblokir; proksi https saja, cache 24 jam.
11. **"Selalu tampilkan gambar dari pengirim ini" per pengguna**, tidak berlaku untuk email `fail`.
12. **Tautan menipu ditulis ulang ke halaman peringatan web**; arsip lampiran = `warn` (butuh
    konfirmasi), HTML/SVG/skrip/makro/eksekusi = `blocked`.
13. **Satu soket WS untuk Inbox & Email** (event `mail.*` ID saja, difilter per akses).
14. **Isi & lampiran diambil worker, bukan api**: api mengembalikan `loading` + event WS. IMAP hanya dari
    worker sehingga batas sambungan per akun (maks. 2) bisa ditegakkan.
15. **Satu IDLE per akun lewat sewa Redis**; batas 200 IDLE per proses; sisanya polling 2 menit.
    `auth_failed` berhenti mencoba (cegah akun terkunci).
16. **Putuskan = hapus cache sepenuhnya** (server tidak disentuh); foto akun & channel disimpan di
    database seperti logo organisasi.
17. **Belum dibaca/Berbintang mencakup semua folder kecuali Spam & Sampah**; `\All`/`\Flagged`
    disembunyikan & tidak disinkron.
18. Kolom utas/cari/label ditambah di migrasi 9C (tidak ada kolom menganggur di 9A).

## 15. Pertanyaan terbuka

Tidak ada yang memblokir 9A. Catatan untuk `devops`: rute `/api/v1/mail/view/*` butuh pengecualian
`X-Frame-Options` (diganti `frame-ancestors`) di Fastify maupun nginx bila proxy menambah header itu.

## 16. Penyimpangan implementasi 9A bagian 1 (backend, 2026-11-23)

Disetujui sebagai keputusan pelaksana (DECISIONS 2026-11-23); bagian 2 memakai fondasi ini.

1. **Kolom tambahan** `mail_accounts`: `folders_synced_at` (LIST terakhir), `idle_active`, `last_test_at`,
   `last_test_incoming_ok`, `last_test_outgoing_ok` (untuk `sync.idleActive`/`sync.lastTest`);
   `mail_folders.has_older_on_server` (untuk `hasOlderOnServer`). `mail_settings` ber-PK `organization_id`
   (tanpa `id`). `mail_folders.parent_id` tanpa FK (daftar folder diganti utuh saat LIST). CHECK
   `trusted_auth_serv_ids` memakai `char_length ≤ 1300` + regex tanpa `{1,1300}` (Postgres menolak
   pengulangan > 255 — catatan: CHECK serupa di `channels` punya masalah yang sama).
2. **Deklarasi rute**: semua rute `mail.view`, kecuali `PUT …/access`, `GET/PUT /settings/mail`, dan
   `GET/PUT /settings/team/:userId/mail-access` = `mail.accounts.manage`. `detect`/`test` butuh
   `mail.private.own` ATAU `mail.accounts.manage`; `POST /mail/accounts` butuh `mail.accounts.manage`
   (bersama) / `mail.private.own` (pribadi) — diperiksa handler (403 + audit).
3. **`navigation.mail`** dikirim di `GET /auth/me` dan `POST /auth/login` (bukan di jawaban 2FA/undangan/
   setup — web memuat `/auth/me` setelahnya).
4. **`GET …/access`** untuk pemegang Kelola non-Owner/Admin: boleh dibaca, `editable: false`. Akun pribadi
   milik sendiri → 400 `personal_account_no_access`; milik orang lain → 404.
5. **Galat tambahan**: `POST …/sync` saat `paused`/`owner_inactive` → 409 reason `account_paused`;
   `details[].reason` `principal_invalid`, `account_not_found`, `password_required` (tes/ubah tanpa
   password saat server berubah), `limit_reached` (grant > 200).
6. **Larangan alamat ganda** juga membandingkan ALIAS Channel Email (dua arah).
7. **Worker**: `mail-sync-folders` per AKUN (LIST + semua folder jatuh tempo, satu sambungan),
   `mail-sync-folder` satu folder (IDLE). Deteksi email hilang = `UID SEARCH SINCE <jendela>` vs UID lokal
   tiap sinkron (QRESYNC/VANISHED belum dipakai); `CHANGEDSINCE` dipakai bila CONDSTORE. `STATUS` per folder
   saat disinkron. Pemilik nonaktif → `owner_inactive` lewat tick (≤ 30 dtk). `mail-load-older`,
   `mail-fetch-body`, `mail-fetch-attachment`, `mail-action` = bagian 2.
8. **Event bus** `mail.access.changed` membawa `userIds` (penerima) — tetap tanpa isi/alamat.
9. **Rute foto channel** (`/channels/:channelId/avatar`) belum dibuat — tabel `channel_avatars` sudah ada.
10. **Deteksi**: domain/MX Google & Microsoft memberi saran server (`provider: google/microsoft`) dengan
    catatan; tebakan `mail.<domain>` hanya bila semua alamatnya lolos penjaga ketat (privat hanya allowlist).
