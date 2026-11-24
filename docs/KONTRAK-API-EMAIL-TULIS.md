# Kontrak API — Modul Email: tulis, balas, teruskan (Fase 9, tahap 9B)

Jendela tulis menu **Email**: tulis baru, balas, balas semua, teruskan, Kepada/Cc/Bcc, identitas &
alias terverifikasi, tanda tangan, template di editor, draf otomatis (juga ke folder Draf server),
lampiran, **batalkan kirim**, salinan ke Terkirim, penanda "sedang membalas", dan peringatan email
baru di utas. Spesifikasi: `docs/PRD-EMAIL.md` §4.1 (identitas & alias), §4.4, §4.12 (logo di tanda
tangan), §5, §7; desain `docs/design/email/mockup.html` keadaan **Tulis** (jendela mengambang 600×600
desktop, layar penuh HP, toast "Batalkan" dengan hitung mundur, cip "Tampilkan kutipan").

Kontrak ini MELANJUTKAN `docs/KONTRAK-API-EMAIL.md` (9A: skema `mail_*`, `resolveMailAccess`, hak per
akun, WS, worker, §16–17 penyimpangan) dan MEMAKAI ULANG `docs/KONTRAK-API-EMAIL-KIRIM.md` (9.1).
Bila tidak disebut lain, aturan 9A/9.1 tetap berlaku.

Rencana lokasi kode: skema Zod `packages/shared/src/mail-compose.ts` (identitas, tanda tangan, draf,
outbox, cek, event WS, kode galat & pesan); api `apps/api/src/modules/mail/` berkas baru
`mail-identities.*`, `mail-signatures.*`, `mail-drafts.*`, `mail-outbox.*` (rute di
`API_ROUTES.mail`); core `packages/core/src/mail/compose-html.ts` (profil sanitasi editor, kutipan,
perakitan HTML akhir) + `packages/core/src/mail-client/append.ts` (IMAP `APPEND` + hapus UID lama);
db `packages/db/src/schema/mail.ts` (tabel baru) + migrasi **`0038_mail_tulis`**; worker
`apps/worker/src/mail/send.ts`, `apps/worker/src/mail/drafts.ts`, `apps/worker/src/mail/verify.ts`.

**Dipakai ulang (jangan ditulis ulang)**: `resolveMailAccess`, `sanitizeOutboundEmailHtml`,
`htmlWithinLimits`/`EMAIL_HTML_LIMITS` (`html-guard.ts`), `renderOutboundEmail`/`scanTemplateVariables`/
`htmlToText` (`outbound-html.ts`), `classifyOutboundEmailAttachment` (daftar izin lampiran 9.1),
`cleanFileName`, validator alamat penerima 9.1 (`recipient_invalid`, punycode), `maskEmailAddress`,
`newOutboundMessageId`, `classifyApiSmtpError` + jadwal coba ulang 9.1, `email_sender_settings`
(batas per jam per penerima, `throttled`/`paused`/`blocked`), penjaga host KETAT akun Email 9A
(`resolveMailHost` + `strictMailAddressAllowed`, privat hanya allowlist), `openMailAccountSecret`,
`withWorkSlot`/semafor sambungan IMAP per akun, `riskyAdditions`, `inspectLogoImage`, media store
(`MEDIA_DIR`), `assertCanSend`/rem darurat, `RateLimiter` + `refund`, konfirmasi identitas,
`forbidByRule`, antrian email sistem (`EMAIL_JOBS`, pola token terenkripsi `account_tokens`), bus
`inbox-events` (event ber-`userIds`), dokumen tampilan ber-token 9A (`POST /mail/messages/:id/view`).

## 0. Cakupan 9B vs ditunda

| Area | 9B (sekarang) | Ditunda |
|---|---|---|
| Tulis | Tulis baru, Balas, Balas semua, Teruskan (isi asli sebagai kutipan + lampiran asli pilihan), Kepada/Cc/Bcc, editor rich text + mode teks biasa, gambar inline (unggah), kutipan bisa dilipat | Teruskan sebagai lampiran `.eml`; Cc/Bcc bawaan per identitas (PENTING) → **9D** |
| Identitas | Identitas utama + alias per akun, **verifikasi wajib** sebelum dipakai sebagai "Dari", `Reply-To` per identitas | — |
| Tanda tangan | Bersama (per akun) & pribadi (per pengguna per akun), logo, variabel, bawaan baru vs balasan per identitas + pilihan pribadi | — |
| Template | Menu `/`: Balasan cepat (`{nama}`, `{agen}`) + Template email terbit 9.1 (`{{var}}`, isi dari kontak) | Editor visual berbasis blok |
| Draf | Simpan otomatis ke database (debounce), konflik versi, **salinan ke folder Draf server** (IMAP `APPEND`, ganti salinan lama) | "Lanjutkan menulis" draf yang dibuat aplikasi email lain → **9C** |
| Kirim | Outbox `mail_outbox`, **batalkan kirim** 5–30 dtk, "Kirim sekarang", coba ulang + backoff, status ke UI, **salinan ke Terkirim** (`auto`/`append`/`none`) | **Jadwalkan kirim** → **9E**; pelacakan bounce/DSN ke outbox → **9D** |
| Kerja tim | Penanda "sedang membalas" (presence HTTP + WS, TTL) + peringatan "ada email baru di utas ini" sebelum kirim | Utas penuh (`mail_threads`), penugasan → **9C/9D** |
| API | — | Pengirim `acc_<akun>` di API kirim 9.1 + webhook `mail.*` → **9E** (tabel 9B sudah siap dipakai) |
| HP | Jendela tulis layar penuh, FAB "Tulis" | Geser arsip & laci lengkap → **9C** |

## 1. Izin & hak

**Matriks izin TIDAK berubah** (tidak ada izin baru): semua tulis/kirim butuh `mail.send` DAN level
akun ≥ `send` (**Baca & kirim**) dari `resolveMailAccess` (KONTRAK-API-EMAIL §2). Teknisi mengikuti
aturan yang sama (bawaan tanpa akun → tidak bisa menulis sampai diberi hak `send`).

| Aksi | `read` | `send` | `manage` | Catatan |
|---|:-:|:-:|:-:|---|
| Lihat identitas & status verifikasinya, tanda tangan bersama | ✅ | ✅ | ✅ | |
| Buat/ubah/hapus draf **milik sendiri**, lampiran draf, kirim, batalkan kirim | – | ✅ | ✅ | draf & outbox selalu milik pembuatnya |
| Tanda tangan **pribadi** (untuk akun itu) | – | ✅ | ✅ | |
| Tanda tangan **bersama**, bawaan tanda tangan identitas, nama tampilan & `Reply-To` identitas | – | – | ✅ | |
| Mulai verifikasi / masukkan kode verifikasi identitas | – | – | ✅ | |
| Mode salinan Terkirim, peringatan penerima luar domain (PATCH akun) | – | – | ✅ | |
| **Tambah/hapus alias** akun **bersama** | `mail.accounts.manage` + **konfirmasi identitas** (tambah) ||| sama dengan alias channel 9.0 R7 |
| Tambah/hapus alias akun **pribadi** | pemilik saja, tanpa konfirmasi (verifikasi tetap wajib) ||| |

- **Draf, lampiran draf, outbox, preferensi = pribadi pembuatnya**, juga di akun bersama dan juga
  terhadap Owner. Pengguna lain (termasuk Owner) → **404**. Salinan draf di folder Draf server tetap
  terlihat oleh semua pemegang hak `read` akun bersama (sifat kotak surat bersama; disebut di UI).
- **Akun pribadi orang lain** = tidak ada (404) di semua rute 9B, termasuk Owner (aturan 9A §2).
- **Cek ulang di worker** sesaat sebelum SMTP: pengguna aktif, `mail.send`, level ≥ `send`, identitas
  masih terverifikasi & milik akun itu, akun tidak `deleting`/`owner_inactive`, rem darurat, keadaan
  pengirim. Gagal → outbox `failed` alasan `not_allowed`/`identity_unverified`/`account_unavailable`
  dan draf dikembalikan (§9).
- Penolakan izin/level di rute tulis → `forbidByRule` (audit `auth.access.denied`), pola 9A.

## 2. Skema data (migrasi `0038_mail_tulis`)

Pola 9A: `organization_id` (FK `organizations`, `restrict`), `id` uuid, `created_at`/`updated_at`, FK
komposit `(organization_id, <fk>)`, CHECK panjang/isi, rahasia `*_encrypted` (AES-256-GCM).

**`mail_identities`** (tabel 9A, kolom baru)
| Kolom | Isi |
|---|---|
| `reply_to` | `null` atau satu alamat ber**domain sama** dengan `address` (aturan 9.1 §3.6) |
| `verification_state` | `unverified` · `pending` · `verified` (CHECK; `verified` ⇔ `verified_at` terisi) |
| `verified_method` | `mailbox` (email verifikasi ditemukan di kotak surat akun ini) · `code` (kode dimasukkan) |
| `verification_secret_encrypted` | salinan terenkripsi `{ code, messageId }` untuk worker pengirim email verifikasi; **dihapus** setelah terkirim (pola `account_tokens`) |
| `verification_code_hash` | HMAC-SHA256 (kunci HKDF `balesin/mail-identity-verify/v1`) kode 6 digit |
| `verification_message_id_hash` | SHA-256 `Message-ID` email verifikasi yang dinormalisasi (cocokkan saat sinkron, tanpa teks asli di DB) |
| `verification_sent_at`, `verification_expires_at` (30 menit), `verification_attempts` (≤ 5), `verification_requested_by_user_id` | |
| `default_signature_new_id`, `default_signature_reply_id` | FK komposit `mail_signatures` `set null`; hanya tanda tangan BERSAMA akun yang sama (service + tes) |
| `created_by_user_id` | alias: pembuat; utama: `null` |

Data lama: `verification_state = verified_at is null ? 'unverified' : 'verified'`. Unik org-wide alamat
identitas **tidak** dipasang sebagai indeks (akun `deleting` masih punya baris) — ditegakkan service di
bawah advisory lock `email-address:<org>:<alamat>` 9A (§3.2). Maks. **20 alias** per akun.

**`mail_signatures`** — `account_id` (FK komposit, `cascade`), `owner_user_id` (`null` = **bersama**;
terisi = **pribadi** pengguna itu untuk akun itu; FK komposit users `cascade`), `name` 1–60, `html`
(profil editor §6.4, ≤ 32 KB), `text` (≤ 8 KB, dibuat dari HTML bila kosong), `logo_png` bytea (PNG
lebar ≤ 320 px, ≤ 128 KB, CHECK), `logo_sha256`, `created_by_user_id`, `updated_by_user_id`. Indeks
`(organization_id, account_id, owner_user_id)`. Maks. 20 bersama per akun, 10 pribadi per pengguna per
akun.

**`mail_user_preferences`** — `user_id` PK (FK komposit `cascade`), `organization_id`,
`undo_send_seconds` (5–30, bawaan **10**), `compose_format` (`html`·`text`, bawaan `html`),
`signature_choices` jsonb `{ "<identityId>": { "new": "<signatureId>"|"none"|null, "reply": … } }`
(≤ 100 kunci; `null` = ikut bawaan identitas; ID yang tidak lagi sah diabaikan saat dibaca).

**`mail_drafts`**
| Kolom | Isi |
|---|---|
| `account_id` (`cascade`), `identity_id` (FK komposit `restrict`; hapus alias memindah draf ke identitas utama di transaksi yang sama), `owner_user_id` (`cascade`) | |
| `mode` | `new` · `reply` · `reply_all` · `forward` |
| `source_message_id` | `mail_messages` (`set null`) — email yang dibalas/diteruskan |
| `source_snapshot` jsonb | disalin saat draf dibuat supaya balasan tetap benar walau cache email dipangkas: `{ messageIdHeader, inReplyTo, references[≤20], from, to[≤100], cc[≤100], replyTo, subject, sentAt, folderRole }` |
| `thread_root` (≤ 998), `thread_seen_at` | kunci utas (§11) & batas "email baru sejak draf dibuka" |
| `to`, `cc`, `bcc` jsonb `[{ address, name }]` | masing-masing ≤ 100 (batas sebenarnya dicek saat cek/kirim, §12) |
| `subject` (≤ 200), `format` (`html`·`text`), `body_html` (≤ 256 KB, sudah lewat profil editor), `body_text` (≤ 128 KB) | `html`: `body_html` terisi; `text`: `body_text` terisi |
| `include_quote` bool | balas: bawaan `true`; teruskan: selalu `true` |
| `state` | `editing` · `sending` (terkunci selama ada outbox aktif) |
| `version` int | naik +1 tiap simpan (konkurensi optimistis) |
| `last_send_error` jsonb | `{ reason, message, at }` dari outbox gagal terakhir (§9) |
| `server_ref` | 128 bit acak (base32), bagian `Message-ID` salinan server |
| `server_folder_id`, `server_uid`, `server_uidvalidity`, `server_message_id`, `server_synced_version`, `server_sync_state` (`pending`·`synced`·`error`·`disabled`), `server_synced_at`, `server_error_code` | salinan di folder Draf server (§7) |
| `template_id` | template email terakhir yang disisipkan (statistik `last_used_at`), `set null` |

Indeks `(organization_id, owner_user_id, updated_at desc)`, `(account_id, thread_root)`,
`(server_sync_state, updated_at)` sebagian `server_sync_state = 'pending'`. Maks. **100 draf** per
pengguna (semua akun).

**`mail_draft_attachments`** — `draft_id` (FK komposit `cascade`), `position`, `filename`
(`cleanFileName`, ekstensi dipaksa sesuai isi), `content_type` (hasil deteksi isi), `size_bytes`,
`sha256`, `storage_key` (`mail-out/<uuid>`, CHECK pola), `source` (`upload`·`original`),
`source_attachment_id` (`mail_attachments`, `set null`), `state` (`ready`·`loading`·`failed`),
`failure_code`, `inline` bool, `content_id` (`^[A-Za-z0-9._-]{1,64}$`, unik per draf),
`created_by_user_id`. CHECK ukuran ≤ 25 MB per berkas. Maks. 20 berkas per draf.

**`mail_outbox`** (satu baris per permintaan kirim; draf tetap ada sampai `sent`)
| Kolom | Isi |
|---|---|
| `account_id`, `identity_id` (`set null`), `draft_id` (`set null`), `created_by_user_id` | |
| `mode` | sama dengan draf |
| `from_address`, `from_name`, `reply_to`, `envelope_from` (= alamat akun, §8.4) | dibekukan saat kirim |
| `to`, `cc`, `bcc` jsonb, `recipient_count` (1–100), `new_recipient_count` | setelah digabung (§12.1) |
| `subject`, `html`, `text` | isi FINAL (badan + tanda tangan + kutipan) yang dibekukan; `null` setelah dipangkas |
| `message_id_header` (unik per organisasi), `in_reply_to`, `references` text[] (≤ 20) | |
| `status` | `pending` (masa batal) · `queued` · `sending` · `sent` · `failed` · `canceled` (CHECK) |
| `send_after` | `created_at + undo_send_seconds`; "Kirim sekarang" = `now()` |
| `next_attempt_at`, `attempts`, `sending_started_at`, `sent_at`, `failed_at`, `canceled_at` | |
| `failure_reason` (CHECK §15.2), `smtp_code` int, `rejected_recipients` jsonb, `hold_reason` (`hourly_limit`·`throttled`·`paused`·`blocked`·`sending_paused`·`account_offline`·`null`) | |
| `raw_storage_key` | `mail-out/<uuid>.eml` — MIME final ber-Bcc untuk salinan Terkirim; dihapus setelah salinan selesai atau 7 hari |
| `sent_copy_state` (`pending`·`done`·`server_saved`·`skipped`·`failed`), `sent_copy_attempts`, `sent_copy_at`, `sent_message_id` (`mail_messages`, `set null`) | |
| `body_purged_at` | |

Indeks: `(status, send_after, next_attempt_at)` sebagian `status in ('pending','queued')`; **unik
sebagian `(draft_id)` bila `status in ('pending','queued','sending')`** (idempotensi klik ganda);
`(organization_id, account_id, sent_at)` (batas per jam); `(organization_id, created_by_user_id,
created_at)` (batas harian pengguna & daftar outbox).

**`mail_correspondents`** (pelengkap otomatis + "alamat baru") — `account_id` (`cascade`), `address`
(huruf kecil), `name` (terakhir terlihat, dibersihkan), `sent_count`, `received_count`,
`last_seen_at`. Unik `(account_id, address)`; indeks `(organization_id, account_id, address
text_pattern_ops)`. Diisi worker: alamat **From** email masuk yang `sender_verification <> 'fail'`
(`received_count`), semua penerima email yang `sent` (`sent_count`). Maks. 20.000 per akun (yang
`last_seen_at` tertua dipangkas harian). Isi awal: job `mail-correspondents-backfill` per akun (bukan
di migrasi — tabel besar).

**Kolom tambahan lain**
- `mail_messages.thread_root` text (≤ 998) + indeks `(organization_id, account_id, thread_root,
  received_at desc)`. Rumus: `references[1]` → `in_reply_to` → `message_id_header` → `'id:' || id`.
  Diisi sinkron untuk email baru; email lama diisi job `mail-thread-root-backfill` per 5.000 baris.
  (9C membangun `mail_threads` di atasnya.)
- `mail_accounts.sent_copy_mode` (`auto`·`append`·`none`, bawaan `auto`),
  `mail_accounts.warn_external_recipients` bool (bawaan `false`).
- `mail_settings.max_recipients_per_email` (1–100, bawaan **50**), `max_attachment_total_mb` (1–25,
  bawaan **20**).
- **FK yang tertinggal dari 9.1**: `email_sender_settings.mail_account_id` dan
  `api_key_email_senders.mail_account_id` → FK komposit ke `mail_accounts` (`cascade`). (`email_outbound`
  menyusul 9E saat pengirim `acc_` dibuka.)

## 3. Identitas & verifikasi

### 3.1 Masalah yang ditutup (sisa risiko S4 review 9A-1)

Login IMAP/SMTP **tidak** membuktikan bahwa pendaftar memiliki alamat yang ia ketik: server IMAP/SMTP
bisa milik pendaftar sendiri (akun pribadi CS), dan server SMTP hosting (mis. cPanel/Exim) sering
menerima "Dari" alamat lain di domain yang sama. Tanpa verifikasi, pengguna bisa mengirim sebagai
`direktur@domain-kita` dari Balesin, atau "menduduki" alamat orang lain.

**Aturan**: email hanya boleh dikirim dari identitas `verified`. Identitas utama dan alias sama-sama
wajib diverifikasi; **tidak ada jalan pintas**, termasuk untuk Owner/Admin.

### 3.2 Desain verifikasi

1. **Mulai** (`POST …/verification`, hak `manage`): api membuat kode 6 digit + `Message-ID` acak 128 bit
   di domain organisasi (`<v.<acak>@<domain sistem>>`), menyimpan HMAC kode, SHA-256 `Message-ID`, dan
   salinan terenkripsi keduanya, lalu mengantre job `mail-identity-verification` di antrian **email
   sistem**.
2. **Email verifikasi dikirim lewat Email pengirim SISTEM** (Pengaturan → Email pengirim, Fase 1),
   **bukan** lewat SMTP akun itu. Alasannya: SMTP & IMAP akun bisa dikuasai pendaftar, sehingga email
   yang dikirim lewat server itu bisa "dikirim" ke kotak suratnya sendiri tanpa lewat MX sebenarnya.
   Lewat SMTP sistem, email menempuh **rute MX yang asli** ke alamat itu. Salinan terenkripsi dihapus
   setelah terkirim.
3. **Terbukti** bila salah satu terjadi sebelum kedaluwarsa (30 menit):
   - **Otomatis — ditemukan di kotak surat akun ini** (`verified_method: mailbox`): saat sinkron
     menyimpan email baru di folder berperan `inbox`, `junk`, `archive`, atau folder sendiri
     (**bukan** `sent`/`drafts`/`trash`) akun yang SAMA, SHA-256 `Message-ID`-nya dicocokkan dengan
     verifikasi tertunda akun itu. IDLE membuat ini biasanya < 10 dtk. Cadangan: job
     `mail-identity-verify-check` (tiap 60 dtk, maks. 15 menit) mencocokkan ULANG secara lokal email yang sudah
     tersinkron (review 9B S1: `Message-ID` TIDAK PERNAH dikirim ke server akun). Ini membuktikan: email ke alamat itu, lewat
     rute aslinya, masuk ke kotak surat yang terhubung — pola alias/penerusan yang sah.
   - **Kode** (`verified_method: code`): pemegang `manage` memasukkan kode dari email itu (untuk alamat
     "kirim sebagai" yang kotak suratnya ada di tempat lain — pola Gmail "Kirim email sebagai"). Maks.
     5 percobaan per kode; habis → `unverified` (mulai lagi).
4. Pengirim tidak bisa memalsukan bukti: `Message-ID` dan kode hanya ada di email yang dikirim ke
   pemilik alamat sebenarnya; server tiruan tidak mengetahuinya.

**Isi email verifikasi** (teks tetap, tanpa nama produk, nama organisasi dari Branding): subjek
"Kode verifikasi alamat pengirim: 482913"; isi: "<Nama pengguna> di <nama organisasi> ingin mengirim
email sebagai **<alamat>** lewat akun **<nama tampilan akun>**. Kalau ini memang kamu atau timmu,
masukkan kode **482913** (berlaku 30 menit). Kalau bukan, abaikan email ini — tanpa kode ini alamatmu
tidak bisa dipakai. Jangan berikan kode ini kepada orang yang tidak kamu kenal." Tanpa tautan
(tidak ada yang bisa dipancing diklik).

**Tidak tersedia** (`verification.available: false`, mulai → 409):
- `system_sender_missing` — Email pengirim sistem belum diatur dan tidak ada cadangan env: "Atur Email
  pengirim di Pengaturan dulu supaya email verifikasi bisa dikirim."
- `system_sender_conflict` — alamat ATAU kotak surat SMTP sistem (host + username) sama dengan akun
  ini: salinan email verifikasi bisa tersimpan otomatis di Terkirim akun itu (Gmail/Microsoft 365),
  sehingga kode terbaca pemegang `read`. "Akun ini juga dipakai sebagai Email pengirim sistem. Ganti
  Email pengirim ke alamat lain (mis. noreply@) supaya verifikasi aman."

**Reset ke `unverified`** (semua identitas akun): alamat akun, host/port/username IMAP, atau
host/username SMTP berubah (perluasan perilaku 9A yang hanya mereset identitas utama). Outbox
`pending`/`queued` identitas itu gagal `identity_unverified` saat diperiksa worker.

### 3.3 Aturan alamat identitas

- Validator alamat 9.1 (ASCII, punycode, ≤ 254); disimpan huruf kecil.
- **Unik di organisasi** (di bawah advisory lock `email-address:<org>:<alamat>` yang sama dengan 9A):
  bukan identitas akun Email lain yang hidup, bukan alamat/alias **Channel Email** Inbox, bukan alamat
  **Email pengirim sistem** → **409** reason `address_in_use` ("Alamat ini sudah dipakai di akun email,
  channel, atau Email pengirim lain."). Ini juga mencegah pengguna yang hanya punya hak Baca di
  `cs@` bersama menambahkan `cs@` sebagai alias akun pribadinya lalu memverifikasinya dari kotak masuk
  bersama.
- Membuat/mengubah Channel Email atau Email pengirim sistem dengan alamat yang sudah menjadi identitas
  → 409 (arah sebaliknya, pola 9A §4.3).
- `display_name` 1–80, tanpa karakter kendali/pengubah arah, tanpa `@`, `<`, `>` (aturan `fromName`
  9.1). `reply_to` domain sama (400 `reply_to_not_allowed`).

### 3.4 Endpoint identitas

Tulis = CSRF, 60/menit/pengguna kecuali disebut lain.

| Endpoint | Hak | Isi |
|---|---|---|
| `GET /api/v1/mail/identities` | `mail.view` | Pilihan **Dari** di jendela tulis: identitas semua akun yang aku punya level ≥ `send` DAN `mail.send` → `{ identities: [MailIdentity & { account { id, displayName, color, kind, avatarUrl } }] }`; yang belum terverifikasi tetap tampil dengan `canSend: false` + alasan (UI: dinonaktifkan, "Verifikasi alamat ini dulu") |
| `GET /api/v1/mail/accounts/:accountId/identities` | `read` | `{ identities: [MailIdentity] }` |
| `POST /api/v1/mail/accounts/:accountId/identities` | bersama: `mail.accounts.manage` + konfirmasi; pribadi: pemilik | `{ address, displayName, replyTo?, confirmation? }` → **201** `{ identity }`, verifikasi langsung dimulai (bila tersedia) |
| `PATCH /api/v1/mail/identities/:identityId` | `manage` | `{ displayName?, replyTo?, defaultSignatureNewId?, defaultSignatureReplyId? }`. Identitas utama: `displayName` juga memperbarui `mail_accounts.from_name`. Alamat tidak bisa diubah (hapus + buat) |
| `DELETE /api/v1/mail/identities/:identityId` | sama dengan POST | Hanya alias (utama → 400 `primary_identity`). Draf yang memakainya dipindah ke identitas utama; outbox aktif gagal di worker |
| `POST /api/v1/mail/identities/:identityId/verification` | `manage` | Mulai/kirim ulang → **202** `{ verification }`. Batas: 3/identitas/24 jam, 10/pengguna/24 jam, 50/organisasi/24 jam → 429 `verification_send_limit`. Sudah `verified` → 409 `already_verified` |
| `POST /api/v1/mail/identities/:identityId/verification/confirm` | `manage` | `{ code }` (6 digit) → 200 `{ identity }` · 400 `verification_code_invalid` (`details[].attemptsLeft`) · 410 `verification_expired`. 20/jam/pengguna |

`MailIdentity`:

```json
{ "id": "…", "accountId": "…", "address": "tagihan@perusahaan.example", "displayName": "Tim Tagihan",
  "isPrimary": false, "replyTo": null,
  "verification": { "state": "pending", "verifiedAt": null, "method": null,
                    "pending": { "sentAt": "…", "expiresAt": "…", "attemptsLeft": 5, "autoCheckUntil": "…" },
                    "available": true, "unavailableReason": null },
  "defaultSignatures": { "new": "…", "reply": null }, "canSend": false,
  "cannotSendReason": "identity_unverified", "createdAt": "…" }
```

Audit `mail.identity.created` / `.updated` (`changedFields`) / `.deleted` / `.verification_started` /
`.verified` (`method`) / `.verification_failed` (percobaan habis) — target `mail_account`, metadata
alamat identitas saja (akun pribadi: ID saja). Alias baru di akun **bersama** → kejadian keamanan
`mail_identity_added` (`warning` bila oleh Admin + email semua Owner; `info` oleh Owner). WS
`mail.identity.updated` (§14).

UI: wizard tambah akun 9A mendapat langkah akhir **"Verifikasi alamat"** (otomatis berjalan; biasanya
selesai dalam hitungan detik; ada kolom kode sebagai cadangan). Akun lama: banner di menu Email
"Verifikasi alamat <akun> supaya bisa mengirim email".

## 4. Tanda tangan

| Endpoint | Hak | Isi |
|---|---|---|
| `GET /api/v1/mail/accounts/:accountId/signatures` | `read` | `{ shared: [MailSignature], mine: [MailSignature] }` (`mine` hanya bila level ≥ `send`) |
| `POST /api/v1/mail/accounts/:accountId/signatures` | bersama: `manage`; pribadi: `send` | `{ scope: "shared"\|"personal", name, html }` → **201** |
| `PATCH /api/v1/mail/signatures/:signatureId` | sama dengan pembuatannya | `{ name?, html? }` |
| `DELETE /api/v1/mail/signatures/:signatureId` | sama | Bawaan identitas yang merujuknya → `null` |
| `PUT /api/v1/mail/signatures/:signatureId/logo` | sama | `{ image: base64 }` PNG/JPEG/WebP dari isi (≤ 1 MB, SVG ditolak, `inspectLogoImage`) → PNG lebar ≤ 320 px, ≤ 128 KB → `{ logoUrl }` |
| `DELETE /api/v1/mail/signatures/:signatureId/logo` | sama | |
| `GET /api/v1/mail/signatures/:signatureId/logo?v=<sha8>` | `read` (bersama) / pemilik (pribadi) | `image/png`, `private, max-age=31536000, immutable`, `nosniff` — dipakai editor |
| `GET /api/v1/mail/identities/:identityId/signature?purpose=new\|reply` | `send` | Tanda tangan siap sisip untuk pengguna ini: `{ signatureId \| null, html, text }` (variabel terisi) |

- **Pilihan efektif** per (pengguna, identitas, tujuan): `mail_user_preferences.signature_choices` →
  bawaan identitas (`default_signature_new_id`/`reply_id`) → tanpa tanda tangan. `"none"` = pengguna
  memilih tanpa tanda tangan.
- **Variabel** (diisi saat disisipkan, di-escape): `{{nama_agen}}` (nama pengguna), `{{alamat_pengirim}}`,
  `{{nama_organisasi}}`, `{{logo}}` (gambar logo tanda tangan itu, `<img src="cid:sig-logo-<signatureId>"
  alt="<nama organisasi>" width="…">`). Variabel lain → 400 `signature_variable_unknown`. Satu
  tanda tangan bersama bisa memuat nama tiap agen.
- Tanda tangan disisipkan ke badan draf dalam `<div data-signature="<signatureId>">…</div>` (satu-
  satunya atribut `data-*` yang diizinkan profil editor); mengganti "Dari" = web menukar isi blok itu
  dengan hasil `GET …/signature`. Server tidak menambah tanda tangan lagi saat kirim.
- Tanda tangan **bersama** diubah: audit `mail.signature.updated` (tanpa isi; `risky` dari
  `riskyAdditions` tautan/angka panjang baru). Pribadi tidak diaudit.

## 5. Preferensi pengguna

`GET`/`PUT /api/v1/mail/preferences` (`mail.view`) → `{ undoSendSeconds: 10, composeFormat: "html",
signatureChoices: { "<identityId>": { "new": "…"|"none"|null, "reply": … } } }`. ID identitas/tanda
tangan yang tidak boleh dipakai pengguna → 400.

## 6. Draf

### 6.1 Buat

`POST /api/v1/mail/drafts` (`mail.send`, level `send`; 30/menit/pengguna)

```json
{ "mode": "reply_all", "sourceMessageId": "…", "identityId": null,
  "to": [], "cc": [], "bcc": [], "subject": null, "bodyHtml": null }
```

- `new`: `identityId` wajib bila pengguna punya > 1 identitas yang bisa dipakai (bawaan web: akun yang
  sedang dibuka); boleh `to`/`subject`/`bodyHtml` awal (mis. tombol "Tulis email" dari kartu kontak).
- `reply`/`reply_all`: `sourceMessageId` wajib, hak `read` di akun email itu, dan balasan **dari akun
  yang sama** (level `send`). `forward`: `sourceMessageId` dengan hak `read`, boleh dari akun lain yang
  ber-level `send`.
- **Identitas bawaan balasan**: identitas terverifikasi akun itu yang alamatnya = `delivered_to` email
  asli, lalu yang muncul di To/Cc asli, lalu identitas utama.
- **Penerima** (dari `source_snapshot`):
  - Balas: `Reply-To` asli bila ada, selain itu `From`. Email asli dari folder `sent` (balas email
    sendiri) → `To` asli.
  - Balas semua: Kepada = seperti Balas; Cc = `To` + `Cc` asli. **Dibuang**: semua identitas akun ini
    (utama & alias), alamat yang sudah ada di Kepada, duplikat (tanpa beda huruf). **Bcc asli tidak
    pernah ikut.**
  - Teruskan: kosong.
- **Subjek**: `Re: ` / `Fwd: ` ditambahkan kecuali sudah diawali `re:`/`aw:`/`bls:` (balas) atau
  `fwd:`/`fw:`/`tr:` (teruskan), tanpa beda huruf. Awalan tidak diterjemahkan (aplikasi penerima
  mengelompokkan utas dengan `Re:`).
- **Badan awal**: kosong + tanda tangan efektif (§4) untuk `purpose` `new` (tulis baru, teruskan) atau
  `reply` (balas). `include_quote = true` untuk balas & teruskan.
- **Teruskan**: lampiran asli yang `risk = ok` DAN lolos daftar izin keluar 9.1 otomatis ditambahkan
  sebagai `source: original` (`state: loading` bila belum di cache → job ambil lampiran 9A lalu disalin
  ke `mail-out/`). Lampiran yang tidak boleh diteruskan dilaporkan di `skippedAttachments: [{ filename,
  reason: "blocked"|"type_not_allowed"|"too_large" }]`.
- `thread_root` = `thread_root` email asli (baru: `null`), `thread_seen_at = now()`.
- → **201** `{ draft: MailDraft, skippedAttachments }`. Batas 100 draf → 409 `draft_limit`.

### 6.2 Ambil, daftar, hapus

| Endpoint | Isi |
|---|---|
| `GET /api/v1/mail/drafts?accountId=&cursor=` | Draf milikku (terbaru diubah dulu, 50/halaman): `{ drafts: [{ id, accountId, identityId, mode, subject, toPreview: ["Rina Wulandari"], updatedAt, state, hasAttachments, canSend, lastSendError }] }` |
| `GET /api/v1/mail/drafts/:draftId` | `{ draft: MailDraft }` |
| `DELETE /api/v1/mail/drafts/:draftId` | Buang draf: baris + lampiran + berkas dihapus, job hapus salinan server. `state: sending` → 409 `draft_locked` |

```json
{ "id": "…", "accountId": "…", "identityId": "…", "mode": "reply", "sourceMessageId": "…",
  "threadKey": "q2V0…", "to": [{ "address": "rina@contoh.example", "name": "Rina Wulandari" }],
  "cc": [], "bcc": [], "subject": "Re: Permintaan upgrade paket", "format": "html",
  "bodyHtml": "<p>Halo Bu Rina,</p>…<div data-signature=\"…\">…</div>", "bodyText": null,
  "includeQuote": true,
  "quote": { "available": true, "messageId": "…", "from": { "address": "…", "name": "Rina Wulandari" },
             "sentAt": "…", "hasHtml": true },
  "attachments": [{ "id": "…", "filename": "Penawaran.pdf", "contentType": "application/pdf",
                    "sizeBytes": 319488, "inline": false, "contentId": null, "state": "ready", "source": "upload" }],
  "attachmentTotalBytes": 319488, "version": 7, "state": "editing", "lastSendError": null,
  "serverCopy": { "state": "synced", "syncedAt": "…" }, "threadSeenAt": "…", "canSend": true,
  "cannotSendReason": null, "createdAt": "…", "updatedAt": "…" }
```

Kutipan TIDAK dikirim sebagai HTML ke editor. Web menampilkannya (cip "Tampilkan kutipan") lewat
dokumen tampilan ber-token 9A (`POST /mail/messages/:sourceMessageId/view`, iframe sandbox tanpa
skrip) — HTML email asli yang tidak tepercaya tidak pernah masuk `contenteditable` di origin aplikasi.

### 6.3 Simpan otomatis & konflik versi

`PUT /api/v1/mail/drafts/:draftId` (120/menit/pengguna; body ≤ 512 KB)

```json
{ "baseVersion": 7, "identityId": "…", "to": […], "cc": […], "bcc": […], "subject": "…",
  "format": "html", "bodyHtml": "…", "bodyText": null, "includeQuote": true, "force": false }
```

- Semua isian opsional kecuali `baseVersion` (hanya yang dikirim yang berubah). Web: simpan
  **debounce 2 dtk setelah berhenti mengetik, paling lambat tiap 5 dtk** selama mengetik, dan saat
  jendela ditutup/diperkecil. Status "Draf tersimpan · 09.41".
- `baseVersion` ≠ versi sekarang → **409** reason `draft_version_conflict` `{ details: [{ currentVersion,
  updatedAt }] }` (tab/perangkat lain). Web: "Draf ini diubah di tab atau perangkat lain." + **Muat
  versi terbaru** / **Timpa dengan versi ini** (`force: true`, mengabaikan `baseVersion`).
- `state: sending` → 409 `draft_locked` ("Email ini sedang dikirim. Batalkan kirim dulu untuk
  mengubahnya.").
- `identityId` harus identitas akun draf itu (pindah akun = buat draf baru; web menyalin isi).
- `bodyHtml` melewati `htmlWithinLimits` lalu **profil editor** (§6.4); bila ada yang dibuang →
  respons memuat `sanitized: true` + `bodyHtml` hasil (web mengganti isinya), selain itu hanya
  `{ draft: { id, version, updatedAt, serverCopy } }`.
- Setiap simpan menandai `server_sync_state = pending` (§7) dan event `mail.draft.updated` ke tab lain
  pengguna itu.

### 6.4 Profil HTML editor (`sanitizeComposerHtml`)

Lebih sempit dari profil keluar 9.1 (dipakai untuk badan draf & tanda tangan):
- Elemen: `p`, `br`, `div`, `span`, `strong`, `b`, `em`, `i`, `u`, `s`, `ul`, `ol`, `li`, `a`,
  `blockquote`, `pre`, `code`, `h1`–`h3`, `hr`, `img`, `table`, `thead`, `tbody`, `tr`, `td`, `th`.
- Atribut: `a[href]` (`https:`, `http:`, `mailto:`, `tel:`; ditambah `rel="noopener noreferrer"`
  `target="_blank"` saat tampil di editor saja), `img[src|alt|width|height]` dengan **`src` hanya
  `cid:`** yang merujuk lampiran inline draf itu atau `cid:sig-logo-<id>` tanda tangan yang boleh
  dipakai, `td/th[colspan|rowspan]`, `div[data-signature]`, `style` dengan properti `color`,
  `background-color`, `text-align`, `font-weight`, `font-style`, `text-decoration` (nilai warna hex/
  `rgb()` saja; tanpa `url()`).
- Dibuang: semua elemen lain termasuk `<style>`, `class`/`id`, `on*`, `data:`/`https:` di `img`
  (**gambar jarak jauh tidak pernah dimuat di editor** — tempelan dari Word/web yang memuat gambar luar
  kehilangan gambarnya; web memberi tahu "Gambar dari luar tidak ikut ditempel. Unggah gambarnya."),
  komentar & sisa `mso-*` Word.
- Web membersihkan tempelan dengan profil yang sama di klien; **server tetap penentu**. Web memetakan
  `cid:` → URL pratinjau lampiran draf / logo tanda tangan hanya untuk tampilan editor.

### 6.5 Cek sebelum kirim

`POST /api/v1/mail/drafts/:draftId/check` (60/menit/pengguna) — dipanggil web saat penerima berubah
(debounce) dan saat menekan Kirim. Tidak mengubah apa pun.

```json
{ "checks": {
  "totalRecipients": 3, "maxRecipients": 50, "bccCount": 1, "bccWarning": false,
  "recipients": [{ "field": "to", "address": "rina@contoh.example", "valid": true, "known": true,
                   "external": true, "ownIdentity": false, "contactId": "…" }],
  "newAddressCount": 0, "newAddressQuota": { "limit": 200, "remaining": 187 },
  "replyToDiffers": null,
  "identity": { "verified": true, "reason": null },
  "attachments": { "totalBytes": 319488, "maxBytes": 20971520, "notReady": 0 },
  "threadNewMessages": { "count": 0, "latestReceivedAt": null } } }
```

- `bccWarning` = Bcc > 10 → web: "Bcc lebih dari 10 alamat. Untuk kirim massal, pakai Broadcast."
- `external` hanya dihitung bila `warn_external_recipients` akun menyala (domain internal = domain
  semua identitas akun Email + Channel Email organisasi) → web: "Ada penerima di luar domain kantor."
- `replyToDiffers` = email asli punya `Reply-To` berdomain beda dengan `From` → web: "Balasan akan
  dikirim ke <alamat> (alamat balas-ke), bukan ke alamat pengirim." (pola penipuan umum).
- Peringatan "kamu menulis 'terlampir' tapi belum ada lampiran" = **web saja** (kata kunci: terlampir,
  lampiran, dilampirkan, lampirkan, attached, attachment), tidak memblokir.

## 7. Salinan draf di folder Draf server

- Job `mail-draft-sync` (antrian `mail`, ID job = draf): jalan bila `server_sync_state = pending`,
  draf **diam ≥ 30 dtk** sejak simpan terakhir, dan **paling sering sekali per 2 menit** per draf
  (lampiran besar tidak diunggah ulang tiap beberapa detik). Juga segera saat jendela tulis ditutup.
- Kerja (lewat `withWorkSlot`): bangun MIME draf (Kepada/Cc/**Bcc** disertakan seperti klien email
  lain, `Message-ID` `<d.<server_ref>.<version>@<domain identitas>>`, badan + kutipan seperti hasil
  kirim, lampiran), `APPEND` ke folder berperan `drafts` (dibuat `Drafts` bila tidak ada, pola
  Arsip/Sampah 9A) dengan flag `\Draft \Seen`, lalu hapus salinan lama: `UID STORE +FLAGS (\Deleted)`
  + `UID EXPUNGE <uid lama>` (UIDPLUS); tanpa UIDPLUS hanya `\Deleted` (TIDAK PERNAH `EXPUNGE` biasa,
  aturan 9A). UID baru dari `APPENDUID`; tanpa itu dicari `UID SEARCH HEADER Message-ID`.
- Akun `paused`/`auth_failed`/`owner_inactive` atau gagal → `server_sync_state` tetap `pending`/
  `error` (`server_error_code`), dicoba lagi pada simpan berikutnya / tick 10 menit. **Database =
  kebenaran** untuk draf Balesin; perubahan salinan server dari aplikasi lain ditimpa pada sinkron
  berikutnya (disebut di UI bantuan).
- Draf dibuang / terkirim → job `mail-draft-remote-delete` menghapus salinan terakhir (usaha terbaik,
  3× coba).
- Daftar folder Draf (9A `GET /mail/messages?view=folder`): email yang `message_id_header`-nya = salinan
  draf MILIKKU mendapat isian `draftId` → web membuka jendela tulis; draf orang lain tampil sebagai
  email biasa (hanya baca).
- Ukuran: draf yang MIME-nya > 30 MB tidak disalin ke server (`server_sync_state = disabled`,
  "Draf terlalu besar untuk disimpan di server email; tetap tersimpan di sini").

## 8. Lampiran draf

| Endpoint | Hak | Isi |
|---|---|---|
| `POST /api/v1/mail/drafts/:draftId/attachments` | pemilik draf | multipart `file` (+ isian `inline=true` untuk gambar di badan) → **201** `{ attachment, draft: { version } }`. 20/menit/pengguna (`unggah-media`), kuota 500 MB/24 jam/pengguna → 429 `upload_quota` |
| `POST /api/v1/mail/drafts/:draftId/attachments/from-message` | pemilik draf + hak `read` di akun email asal | `{ attachmentIds: [] }` (≤ 20) — lampiran email asli (teruskan, atau "sertakan lampiran asli" saat membalas) |
| `GET /api/v1/mail/drafts/:draftId/attachments/:attachmentId` | pemilik draf | Unduh (`attachment`, `nosniff`, `CSP: sandbox`) atau `?preview=1` untuk gambar raster inline di editor |
| `DELETE /api/v1/mail/drafts/:draftId/attachments/:attachmentId` | pemilik draf | Hapus baris + berkas |

- Jenis dari **isi** dengan **daftar izin keluar 9.1** (`classifyOutboundEmailAttachment`): PDF,
  PNG/JPEG/GIF/WebP/BMP/TIFF, `docx`/`xlsx`/`pptx` tanpa makro, CSV/TXT. Selain itu (eksekusi, makro,
  HTML/SVG, skrip, pintasan, citra disk, arsip `zip`/`rar`/`7z`, audio/video, biner tak dikenal, Office
  lama `doc`/`xls`/`ppt`) → **400** `attachment_type_blocked` (pesan 9.1). Lampiran asli ber-`risk`
  `blocked`/`warn` 9A tidak bisa diteruskan.
- `inline: true` hanya gambar raster ≤ 5 MB → `contentId` dibuat server (`img-<8 hex>`) dan dikembalikan
  untuk disisipkan di editor sebagai `<img src="cid:…">`.
- Batas: ≤ **20 berkas** (`attachments_too_many`), total ≤ `mail_settings.max_attachment_total_mb`
  (bawaan **20 MB**, maks. 25) termasuk gambar inline & lampiran asli (`attachment_too_large` →
  "Total lampiran maksimal 20 MB. Untuk berkas besar, bagikan tautan."). Logo tanda tangan tidak
  dihitung.
- Berkas disimpan di media store folder `mail-out/` (nama acak, streaming, sha256); nama berkas
  dibersihkan; isi & nama tidak di-log.

## 9. Kirim & batalkan kirim

### 9.1 `POST /api/v1/mail/drafts/:draftId/send`

`{ "baseVersion": 8, "acknowledgeNewMessagesUntil": null }` — web selalu menyimpan draf dulu (PUT)
lalu mengirim versi itu. 20/menit/pengguna.

**Urutan pemeriksaan** (pola R1 9.1: tidak ada baris dibuat sebelum lolos semua):
1. Sesi, CSRF, `mail.send`, draf milikku (lain → 404).
2. **Idempotensi**: draf sudah punya outbox `pending`/`queued`/`sending` → **200** `{ outbox,
   duplicate: true }` (klik ganda, dua tab). Dijamin indeks unik sebagian `mail_outbox(draft_id)`;
   dua permintaan bersamaan → satu menang, yang lain membaca hasilnya.
3. `baseVersion` = versi draf → selain itu 409 `draft_version_conflict`.
4. `resolveMailAccess` level ≥ `send` (403); akun `deleting` → 409 `account_deleting`.
5. Identitas milik akun & `verified` → selain itu **409** `identity_unverified` ("Alamat <alamat>
   belum diverifikasi. Verifikasi dulu di Pengaturan → Akun email.").
6. Isi: subjek ≤ 200 tanpa CR/LF/kendali (boleh kosong — web meminta konfirmasi "Kirim tanpa
   subjek?"); badan ≤ batas §12.3; minimal satu penerima (Kepada/Cc/Bcc).
7. Penerima: valid (400 `recipient_invalid` `field: "cc.2"`), digabung (§12.1), total ≤
   `max_recipients_per_email` (400 `too_many_recipients`).
8. Lampiran: semua `ready` (409 `attachments_not_ready`), total dalam batas.
9. **Email baru di utas**: ada email di `thread_root` draf (folder bukan `sent`/`drafts`/`trash`,
   pengirim bukan identitas akun ini) dengan `received_at > max(thread_seen_at,
   acknowledgeNewMessagesUntil)` → **409** reason `thread_has_new_messages` `{ details: [{ count,
   latestReceivedAt, messageIds (≤ 5) }] }`. Web: dialog "Ada 1 email baru di utas ini sejak kamu mulai
   menulis." + **Lihat dulu** / **Tetap kirim** (kirim ulang dengan `acknowledgeNewMessagesUntil =
   latestReceivedAt`).
10. **Rem darurat** → 423 `SENDING_PAUSED`.
11. **Batas harian pengguna** (`send_daily_limit_per_user`, per penerima, §12.2) → 429 `daily_limit`.
12. **Jatah alamat baru** (`mail-alamat-baru`, §12.2) → 429 `new_address_quota` (unit diambil di
    langkah ini; gagal di langkah berikut → dikembalikan).
13. **Antrean akun penuh** (penerima menunggu + baru > 24 × batas per jam akun) → 429
    `sender_queue_full`.
14. **Rakit isi final** (§9.3) → 400 `html_too_complex`/`content_too_large` bila lewat batas.
15. Satu transaksi: insert `mail_outbox` (`status: pending`, `send_after = now() + undoSendSeconds`),
    draf `state: sending`, simpan `last_send_error = null`. Setelah commit: event
    `mail.outbox.updated`.

→ **202** `{ outbox: MailOutboxItem }`. Web menutup jendela tulis dan menampilkan toast "Email akan
dikirim dari cs@… · **Batalkan** (10)" (hitung mundur dari `sendAfter`; tombol hilang 1 dtk sebelum
`sendAfter` supaya tidak menjanjikan pembatalan yang kalah balapan).

### 9.2 Outbox

| Endpoint | Isi |
|---|---|
| `GET /api/v1/mail/outbox?state=active\|failed\|recent` | Milikku: `active` = `pending`/`queued`/`sending`; `failed` = gagal 7 hari terakhir yang drafnya belum dikirim ulang; `recent` = 50 terakhir. Untuk baki "Mengirim…/Gagal kirim" |
| `GET /api/v1/mail/outbox/:outboxId` | `{ outbox }` |
| `POST /api/v1/mail/outbox/:outboxId/cancel` | **Batalkan kirim**: hanya dari `pending`/`queued` (`UPDATE … WHERE status in ('pending','queued')`) → `canceled`, draf kembali `editing`, jatah alamat baru dikembalikan, job tidak diproses → 200 `{ outbox, draftId }` (web membuka lagi jendela tulis). Sudah `sending`/`sent` → **409** `not_cancelable` ("Email sudah terkirim, jadi tidak bisa dibatalkan.") |
| `POST /api/v1/mail/outbox/:outboxId/send-now` | `pending` → `send_after = now()` (lewati masa batal) |

```json
{ "id": "…", "draftId": "…", "accountId": "…",
  "identity": { "id": "…", "address": "cs@perusahaan.example", "displayName": "CS" },
  "status": "queued", "holdReason": "hourly_limit", "sendAfter": "…", "nextAttemptAt": "…", "attempts": 0,
  "subject": "Re: Permintaan upgrade paket", "recipientCount": 3, "toPreview": ["Rina Wulandari"],
  "sentAt": null, "failure": null, "rejectedRecipients": [], "sentCopy": { "state": "pending" },
  "createdAt": "…" }
```

Pembatalan memakai pembaruan bersyarat; worker mengklaim baris dengan `FOR UPDATE SKIP LOCKED` hanya
bila `status in ('pending','queued') and send_after <= now()` dan mengubahnya ke `sending` di transaksi
klaim — siapa pun yang commit dulu menang, tidak ada keadaan "dibatalkan tapi terkirim".

**Gagal final** → outbox `failed`, draf kembali `editing` dengan `last_send_error { reason, message,
at }` (jendela tulis menampilkan "Gagal dikirim: Server email menolak alamat Dari ini." dan tombol Kirim
lagi = outbox baru). Penerima sebagian ditolak (5xx per penerima) → tetap `sent` +
`rejectedRecipients` (kirim ulang akan menggandakan email ke yang lain; aturan 9.0/9.1).

### 9.3 Rakit isi final (api, saat kirim)

1. Badan: `body_html` (sudah profil editor) atau `body_text` (mode teks → HTML `<pre>`-bebas: paragraf
   + `<br>`, di-escape).
2. **Kutipan** (bila `include_quote` dan email asli punya isi):
   - Kepala: balas "Pada <tanggal panjang, zona organisasi>, <nama> <<alamat>> menulis:"; teruskan blok
     "---------- Email diteruskan ----------" + Dari / Tanggal / Subjek / Kepada / Cc.
   - HTML dari `mail_message_bodies.html_sanitized` 9A lalu: **semua gambar dibuang** (penanda
     `balesin-remote:`/`balesin-cid:`, `data:`) diganti teks alt "[gambar]"; tautan yang ditulis ulang
     ke halaman peringatan 9A (tautan menipu) **dicabut menjadi teks saja**; elemen `<style>` dibuang
     (gaya email asli tidak boleh menimpa balasan); dibungkus `<blockquote type="cite">`; maks.
     **192 KB** — lebih, atau isi asli hanya teks/`too_large` → kutipan teks (`> ` per baris, ≤ 64 KB,
     sisanya "[kutipan dipotong]").
3. HTML akhir = `<div dir="auto">badan</div>` + kutipan → `htmlWithinLimits` (20.000 tag / kedalaman
   200) → `sanitizeOutboundEmailHtml` (lapis akhir yang sama dengan 9.1) → ≤ 512 KB.
4. Teks akhir = `body_text` atau `htmlToText(badan)` + kutipan teks.
5. `cid:` di HTML akhir harus merujuk lampiran inline draf atau logo tanda tangan yang sah; rujukan
   yatim dibuang. Logo tanda tangan dilampirkan inline oleh worker dari `mail_signatures` (tanda tangan
   terhapus sebelum terkirim → gambar dibuang, teks alt tetap).

### 9.4 Header MIME (worker)

- `From: "<display_name>" <identitas>`, `Reply-To` identitas (bila ada), `To`, `Cc` (dibangun objek
  alamat nodemailer, **tidak pernah** gabungan string), `Subject` (RFC 2047 oleh nodemailer), `Date`,
  `Message-ID` = `newOutboundMessageId(alamat identitas)` (domain identitas), `MIME-Version`.
- Balas: `In-Reply-To` = `Message-ID` asli; `References` = `references` asli + `Message-ID` asli,
  maks. 20 (yang pertama/akar + 19 terakhir, RFC 5322). **Setiap ID divalidasi ulang**
  `^<[^<>\s\p{Cc}]{1,996}>$` saat dipakai (berasal dari email masuk yang tidak tepercaya); yang tidak
  lolos dibuang.
- **Bcc** hanya di amplop `RCPT TO` (nodemailer tanpa `keepBcc`), tidak di header yang dikirim;
  salinan Terkirim (`raw_storage_key`) dibangun dengan `Bcc:` (PRD §4.4). Kedua bangunan memakai
  `Message-ID`/`Date`/batas MIME yang sama.
- Amplop `MAIL FROM` = alamat akun (kotak surat yang login) — banyak server menolak amplop selain
  pengguna yang login; pantulan kembali ke Kotak masuk akun.
- **Tanpa** `Auto-Submitted` (email manusia, beda dengan API 9.1), tanpa `X-Mailer`/`User-Agent`,
  tanpa `Disposition-Notification-To`, tanpa piksel pelacak, tanpa penulisan ulang tautan.
- Transport nodemailer: akses berkas & URL dimatikan (isi Buffer/stream dari media store), host lewat
  **penjaga ketat akun Email 9A** (privat hanya allowlist), port 465/587 + TLS wajib + sertifikat
  diverifikasi, password dibuka `openMailAccountSecret` sesaat sebelum sambung.

## 10. Template & balasan cepat di editor, pelengkap penerima

| Endpoint | Hak | Isi |
|---|---|---|
| `GET /api/v1/mail/compose/snippets?q=` | `mail.send` | Menu `/`: `{ quickReplies: [{ id, shortcut, title }], emailTemplates: [{ id, slug, name, variables: [{ name, label, required }] }] }` (≤ 20 masing-masing; template = terbit & tidak diarsip, 9.1) |
| `POST /api/v1/mail/drafts/:draftId/snippet` | pemilik draf | `{ kind: "quick_reply"\|"email_template", id, variables? }` → `{ html, text, subject, missingVariables: [{ name, label, required }] }` — TIDAK mengubah draf; web menyisipkan di posisi kursor. 60/menit/pengguna |
| `GET /api/v1/mail/recipients/suggest?q=&accountId=` | `mail.view` | Pelengkap Kepada/Cc/Bcc (q ≥ 2 karakter, ≤ 10 hasil): kontak dalam cakupan `contacts.view` pengguna (punya email) + `mail_correspondents` akun yang ia punya hak `read` (akun pribadi: hanya pemiliknya) → `[{ address, name, source: "contact"\|"history", contactId? }]`. 120/menit/pengguna |

- **Balasan cepat**: `{nama}` = nama kontak penerima Kepada pertama (kontak organisasi yang terlihat
  pengguna), lalu nama tampilan penerima, lalu kosong; `{agen}` = nama pengguna. Teks di-escape lalu
  baris baru → `<br>`. `usage_count` naik.
- **Template email**: `renderOutboundEmail` 9.1 dengan `layout: "none"` (bingkai merek tidak dipakai di
  dalam balasan), variabel dari `variables` permintaan, lalu otomatis dari kontak penerima: `nama` =
  nama kontak, variabel lain = atribut kontak (CRM) dengan kunci sama; `{{nama_organisasi}}` bawaan;
  `{{qris}}` tidak didukung di editor (dikosongkan). Wajib yang masih kosong → `missingVariables` (web
  menampilkan formulir kecil, lalu memanggil ulang). Hasil HTML dilewatkan **profil editor** (§6.4)
  sebelum dikembalikan; `subject` hanya dipakai web bila subjek draf kosong. Batas 9.1 berlaku
  (`template_placeholders_too_many`, `content_too_large`). `email_templates.last_used_at` diperbarui
  saat email terkirim (`mail_drafts.template_id`).

## 11. Penanda "sedang membalas" & email baru di utas

- **Kunci utas** 9B: `thread_root` (§2). `threadKey` = base64url(HMAC-SHA256(kunci HKDF
  `balesin/mail-thread/v1`, `accountId ‖ thread_root`))[0..22] — opak, tidak membocorkan
  `Message-ID`. Ada di detail email (`GET /mail/messages/:id` → `threadKey`, `composing: [{ user { id,
  name } }]`), di draf, dan di event `mail.message.created` (tambahan isian, kompatibel).
- **Presence lewat HTTP** (soket WS tetap satu arah server → klien): `PUT
  /api/v1/mail/drafts/:draftId/presence` (pemilik draf, draf balas/teruskan dengan `thread_root`) tiap
  **20 dtk** selama jendela tulis terbuka & terlihat; `DELETE …/presence` saat ditutup/dibuang/
  terkirim. Redis hash `mail:presence:<accountId>:<threadKey>` → `{ userId: kedaluwarsa }`, **TTL 45
  dtk** per pengguna; 6/menit per draf.
- Perubahan anggota (masuk/keluar/kedaluwarsa, dicek tick 15 dtk) → event `mail.compose.presence {
  accountId, threadKey, users: [{ id, name }] }` ke soket pengguna ber-hak ≥ `read` akun itu (filter
  per soket 9A). Web di panel baca: "Dimas sedang membalas…" (dirinya sendiri disembunyikan). Akun
  pribadi: presence tidak dikirim ke siapa pun selain pemilik (tidak berguna, tidak dibuat).
- **Email baru di utas**: web membandingkan `threadKey` event `mail.message.created` dengan draf yang
  terbuka → bilah di jendela tulis "Ada email baru di utas ini. **Lihat**". Server menegakkan saat kirim
  (§9.1 langkah 9).

## 12. Batas

### 12.1 Penerima per email

- Kepada + Cc + Bcc setelah digabung (tanpa beda huruf, prioritas Kepada > Cc > Bcc) ≤
  `mail_settings.max_recipients_per_email` (bawaan **50**, 1–100; Pengaturan → Batas kirim → "Email";
  izin `mail.accounts.manage`; **menaikkan wajib konfirmasi identitas**, menurunkan tidak; audit
  `settings.mail.updated` `{ previous, next }`). Bcc > 10 = peringatan (bukan tolakan).
- Mengirim ke identitas akun sendiri diizinkan (mis. Bcc ke diri sendiri).

### 12.2 Laju

| Batas | Nilai | Penegakan |
|---|---|---|
| Per **akun** per jam (per penerima) | `email_sender_settings` jenis `account` (bawaan **100**, 1–5.000), dihitung dari `mail_outbox` `sending`/`sent` + `email_outbound` akun (9E) 60 menit bergulir | Worker: tertahan (`hold_reason: hourly_limit`, "Tertahan batas per jam — dikirim sekitar 14.05"); antrean > 24 × batas → 429 saat kirim. Pengaturan → Batas kirim "Email per pengirim" 9.1 kini juga mencantumkan akun Email (`acc_<id>`; akun pribadi orang lain = alamat & angka saja) |
| Per **pengguna** per 24 jam (per penerima) | `organizations.send_daily_limit_per_user` (bawaan 500) — SATU batas harian pengguna untuk pesan Inbox + email menu Email | `assertCanSend` menghitung juga `mail_outbox.recipient_count` milik pengguna (status `sending`/`sent`/`pending`/`queued`); batas harian **organisasi** tidak menghitung email (DECISIONS 9.1 #4) |
| **Alamat baru** per pengguna per 24 jam | `mail-alamat-baru` **200 unit** (sama dengan `mulai-percakapan`), 1 unit per penerima yang TIDAK ada di `mail_correspondents` akun itu | Redis `RateLimiter` diambil N unit di langkah 12, dikembalikan bila gagal di langkah berikut atau dibatalkan (pola 9.0 R1). Tidak butuh `inbox.initiate` — email menu Email memang untuk menulis ke siapa pun; jatah ini rem penyalahgunaan |
| Rem darurat & rem otomatis organisasi | yang ada | Kirim → 423; worker menahan (`hold_reason: sending_paused`); rem otomatis per menit ikut menghitung penerima email menu Email |
| Permintaan | kirim 20/mnt, simpan 120/mnt, cek 60/mnt, unggah 20/mnt + 500 MB/24 jam, presence 6/mnt/draf, saran 120/mnt, snippet 60/mnt, buat draf 30/mnt (per pengguna) | `RateLimiter` |
| Verifikasi | kirim 3/identitas, 10/pengguna, 50/organisasi per 24 jam; kode 5/kode, 20/jam/pengguna | §3.4 |

### 12.3 Ukuran

Subjek ≤ 200 karakter; badan HTML ≤ 256 KB (sebelum sanitasi, lewat `htmlWithinLimits`), teks ≤
128 KB; tanda tangan ≤ 32 KB; kutipan ≤ 192 KB (cadangan teks ≤ 64 KB); HTML akhir ≤ 512 KB, teks
akhir ≤ 256 KB; lampiran ≤ 20 berkas, total ≤ 20 MB (bisa diatur ≤ 25 MB); gambar inline ≤ 5 MB.
Lewat → 400 (`body_too_large`, `content_too_large`, `html_too_complex`) / 413 (unggahan).

## 13. Worker

**Antrian & job**

| Job | Antrian | Pemicu | Kerja |
|---|---|---|---|
| `mail-send-tick` | `mail-schedule` (konkurensi 1) | berulang tiap **2 dtk** | Klaim ≤ 20 baris `pending`/`queued` jatuh tempo (`send_after`, `next_attempt_at`) dengan `FOR UPDATE SKIP LOCKED`, hanya bila lolos batas per jam akun; `status = sending`; antre `mail-send` (ID job = outbox). Tick 2 dtk = jeda batal paling banyak +2 dtk |
| `mail-send` | `mail-send` (konkurensi 4, **satu SMTP bersamaan per akun** lewat semafor `mail:smtp:<accountId>`) | tick | Cek ulang §1 → bangun MIME (§9.4) → simpan `raw_storage_key` → SMTP → catat hasil di satu transaksi (outbox, draf, `mail_correspondents`, audit `mail.message.sent`, event) |
| `mail-append-sent` | `mail` (`withWorkSlot`) | setelah `sent` | Salinan Terkirim (bawah) |
| `mail-draft-sync`, `mail-draft-remote-delete` | `mail` | §7 | |
| `mail-identity-verification` | email sistem (`EMAIL_JOBS`) | mulai verifikasi | Buka salinan terenkripsi, kirim lewat SMTP sistem, hapus salinan |
| `mail-identity-verify-check` | `mail` | tiap 60 dtk selama `pending` (maks. 15 menit) | Cadangan `UID SEARCH HEADER Message-ID` di Kotak masuk & Spam |
| `mail-presence-tick` | `mail-schedule` | tiap 15 dtk | Buang anggota presence kedaluwarsa → event |
| `mail-correspondents-backfill`, `mail-thread-root-backfill` | `mail` | sekali per akun setelah migrasi | per 5.000 baris |
| `mail-outbox-retention` | `mail-schedule` | harian | Pangkas isi 30 hari setelah final, `.eml` 7 hari, baris 180 hari; berkas lampiran draf yatim; `mail_correspondents` > 20.000 |

Sinkron 9A ditambah: isi `thread_root`, cocokkan hash `Message-ID` verifikasi tertunda (§3.2),
perbarui `mail_correspondents` (From email masuk non-`fail`).

**Hasil SMTP** (pemetaan `classifyApiSmtpError` 9.1):
- Diterima ≥ 1 penerima → `sent` (+ `rejectedRecipients`), draf + lampiran dihapus (berkas setelah
  salinan Terkirim selesai), job hapus salinan draf server, `mail_correspondents.sent_count`, audit.
- Sementara (4xx, sambungan ditolak/terlalu lama) → `queued`, coba lagi **1, 5, 15, 30, 60 menit, lalu
  tiap jam**, maks. **24 jam** → `failed` `throttle_expired`. 4xx pembatasan laju (`4.7.x`, terlalu
  banyak sambungan) juga menyetel pengirim akun `throttled` (5 menit, ×2 beruntun, maks. 60).
- Login SMTP ditolak / kredensial tak terbuka / pengaturan salah → pengirim akun `blocked` (9.1:
  `smtp_auth_failed`/`credentials_unavailable`/`smtp_config_invalid`), email tertahan (`hold_reason:
  blocked`, "Password SMTP akun ini ditolak — perbarui di Pengaturan → Akun email"), notifikasi ke
  pemegang Kelola + Owner/Admin (bersama) / pemilik (pribadi) maks. sekali per 24 jam, kejadian
  keamanan `email_sender_blocked`; > 24 jam → `failed` `sender_unavailable`. Pemulihan = simpan
  kredensial (PATCH akun 9A melepas `blocked`) atau "Lanjutkan" 9.1.
- 5xx semua penerima → `failed` `recipient_rejected`; 5xx tingkat pesan → `message_rejected` /
  `sender_rejected` (alias ditolak server: "Server email menolak alamat Dari ini. Pastikan alamat ini
  diizinkan sebagai 'kirim sebagai' di penyedia emailmu.").
- Putus setelah `DATA` → `failed` `delivery_unknown`, **tidak dicoba ulang** ("Status pengiriman tidak
  pasti — cek folder Terkirim atau tanyakan penerima sebelum mengirim ulang.").
- Tertahan rem darurat/jeda > 24 jam → `sending_paused_expired` / `sender_unavailable`.

**Salinan Terkirim** (`sent_copy_mode`):
- `none` → `skipped`. `append` → langsung `APPEND` `.eml` ber-Bcc ke folder berperan `sent` (dibuat
  `Sent` bila tidak ada) dengan `\Seen`.
- `auto` (bawaan) → tunggu 20 dtk, `UID SEARCH HEADER Message-ID <id>` di folder Terkirim: ada →
  `server_saved` (Gmail/Microsoft 365 menyimpan sendiri; mencegah salinan ganda), tidak ada →
  `APPEND`. Tanpa folder Terkirim & tanpa izin membuat → `failed`.
- Coba 3× (1, 10, 60 menit); gagal → `sent_copy_state = failed` + catatan di outbox/UI "Email
  terkirim, tetapi salinannya gagal disimpan di folder Terkirim." (email tetap terkirim). Setelah
  selesai: sinkron folder Terkirim diantre; email hasil sinkron dengan `Message-ID` sama →
  `sent_message_id`. `.eml` dihapus.

## 14. Real-time (WebSocket)

Soket `GET /api/v1/inbox/stream` yang sama, event ID & angka saja (kecuali nama pengguna di
presence — data tim, bukan isi email):

| `type` | Isian | Penerima |
|---|---|---|
| `mail.outbox.updated` | `outboxId`, `draftId`, `accountId`, `status`, `holdReason`, `sendAfter`, `nextAttemptAt`, `failureReason` | pembuat saja (`userIds`) |
| `mail.draft.updated` | `draftId`, `version`, `serverCopyState` | pemilik draf (tab lain) |
| `mail.draft.deleted` | `draftId` | pemilik draf |
| `mail.identity.updated` | `accountId`, `identityId`, `verificationState` | pengguna ber-hak ≥ `read` akun |
| `mail.compose.presence` | `accountId`, `threadKey`, `users: [{ id, name }]` (≤ 20) | pengguna ber-hak ≥ `read` akun (akun bersama saja) |
| `mail.message.created` (9A) | + `threadKey` | aturan 9A |

## 15. Model galat

Amplop `{ error: { code, message, details?, requestId } }` + `details[].reason` (9.1/9A). Teks
Indonesia, "kamu", tanpa nama produk.

### 15.1 Galat endpoint

| HTTP | `code` | `reason` | Pesan (contoh) |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | `recipient_invalid` · `too_many_recipients` | 9.1 (batas mengikuti `max_recipients_per_email`) |
| 400 | `VALIDATION_ERROR` | `subject_invalid` · `body_too_large` · `content_too_large` · `html_too_complex` | "Subjek maksimal 200 karakter, satu baris." · "Isi email terlalu panjang (maks. 256 KB)." |
| 400 | `VALIDATION_ERROR` | `attachment_type_blocked` · `attachment_too_large` · `attachments_too_many` | 9.1 |
| 400 | `VALIDATION_ERROR` | `reply_to_not_allowed` · `display_name_invalid` · `primary_identity` · `signature_variable_unknown` · `identity_not_in_account` | "Identitas utama tidak bisa dihapus." |
| 400 | `VALIDATION_ERROR` | `verification_code_invalid` | "Kodenya salah. Sisa 3 percobaan." |
| 403 | `FORBIDDEN` | — | izin/level kurang (`forbidByRule`) |
| 404 | `NOT_FOUND` | — | draf/outbox orang lain, akun pribadi orang lain, tanpa hak |
| 409 | `CONFLICT` | `identity_unverified` | "Alamat cs@… belum diverifikasi. Verifikasi dulu di Pengaturan → Akun email." |
| 409 | `CONFLICT` | `draft_version_conflict` · `draft_locked` · `draft_limit` | "Draf ini diubah di tab atau perangkat lain." · "Maksimal 100 draf. Kirim atau buang draf lama dulu." |
| 409 | `CONFLICT` | `thread_has_new_messages` · `attachments_not_ready` · `not_cancelable` · `account_deleting` | "Lampiran masih disiapkan. Tunggu sebentar." |
| 409 | `CONFLICT` | `address_in_use` · `already_verified` · `verification_unavailable` (`details[].cause`: `system_sender_missing`/`system_sender_conflict`) · `alias_limit` | |
| 410 | `TOKEN_INVALID` (kode yang sudah ada, tanpa kode baru) | `verification_expired` | "Kodenya sudah kedaluwarsa. Kirim kode baru." |
| 413 | `PAYLOAD_TOO_LARGE` | — | unggahan > batas |
| 423 | `SENDING_PAUSED` | — | rem darurat |
| 429 | `RATE_LIMITED` | `daily_limit` · `new_address_quota` · `sender_queue_full` · `upload_quota` · `verification_send_limit` · `rate` | "Jatah email ke alamat baru hari ini (200) sudah habis. Coba lagi besok atau minta Owner/Admin." + `Retry-After` |
| 503 | `SERVICE_UNAVAILABLE` | `master_key_missing` | |

### 15.2 Alasan gagal outbox (`MAIL_SEND_FAILURE_REASONS`)

`recipient_rejected`, `message_rejected`, `sender_rejected`, `sender_unavailable`, `throttle_expired`,
`sending_paused_expired`, `delivery_unknown`, `attachment_unavailable`, `credentials_unavailable`
(arti & pesan = 9.1), ditambah `not_allowed` ("Kamu tidak lagi punya hak kirim di akun ini."),
`identity_unverified` ("Alamat pengirim perlu diverifikasi ulang."), `account_unavailable` ("Akun email
ini sedang diputus atau pemiliknya nonaktif."). Teks balasan server SMTP tidak pernah diteruskan;
`smtpCode` angka saja.

## 16. Keamanan, audit, log, privasi

- **Identitas**: kirim hanya dari identitas `verified`, diperiksa di api DAN worker; verifikasi lewat
  SMTP sistem + bukti kotak surat/kode (§3); alamat unik lintas akun/channel/pengirim sistem; reset saat
  kotak surat berubah.
- **HTML keluar**: profil editor (simpan) + `htmlWithinLimits` + `sanitizeOutboundEmailHtml` (kirim);
  HTML email asli hanya masuk lewat kutipan yang dibersihkan (§9.3) dan tidak pernah ke editor.
  Variabel template/tanda tangan/balasan cepat di-escape.
- **Header injection**: subjek, nama tampilan, nama penerima menolak CR/LF, `\p{Cc}`, U+2028/U+2029,
  pengubah arah (U+202A–202E, U+2066–2069); alamat lewat validator ketat 9.1; `In-Reply-To`/
  `References` divalidasi ulang; header dibangun objek nodemailer, bukan string.
- **SMTP & SSRF**: hanya host akun lewat penjaga ketat 9A (privat hanya allowlist organisasi), port
  465/587, TLS + sertifikat wajib; tidak ada pengambilan URL di jalur tulis (tanpa gambar jarak jauh di
  editor, tanpa lampiran URL dari UI).
- **Rahasia**: password SMTP/IMAP hanya dibuka worker sesaat sebelum sambung; kode & `Message-ID`
  verifikasi disimpan ter-hash + salinan terenkripsi sementara; tidak ada yang ke browser/log.
- **Idempotensi**: satu outbox aktif per draf (indeks unik) + `baseVersion`.
- **Privasi tim**: draf/outbox/preferensi pribadi pembuatnya (404 untuk orang lain, termasuk Owner);
  akun pribadi terisolasi seperti 9A; `mail_outbox` TIDAK muncul di Riwayat kirim API 9.1 (tabel
  berbeda) dan tidak memicu webhook keluar (9E).
- **Tanpa pelacakan**: tidak ada piksel, tanda terima baca, penulisan ulang tautan, `X-Mailer`.
- **Audit** (`targetType: mail_account`, TANPA subjek/isi/alamat penerima): `mail.message.sent`
  `{ accountId, identityId, outboxId, mode, recipientCount, newRecipientCount, attachmentCount, hasBcc }`
  (pelaku = pengguna, dicatat worker); `mail.identity.*` (§3.4); `mail.signature.*` (bersama saja);
  `settings.mail.updated`; `settings.email_sender_limit.updated` (akun); `sending.limit_reached`
  (target `user`). Kejadian keamanan: `mail_identity_added`, `email_sender_blocked`. Akun pribadi: ID &
  angka saja.
- **Log**: ID outbox/draf/akun/identitas, status, jumlah penerima + penerima pertama tersamar
  (`maskEmailAddress`), `smtpCode`, durasi. TIDAK: subjek, isi, nama/isi lampiran, alamat lengkap,
  `Message-ID`, kode/`Message-ID` verifikasi, password.
- **Retensi**: isi outbox 30 hari setelah final (salinan ada di Terkirim server), `.eml` ≤ 7 hari,
  baris 180 hari. Draf tidak kedaluwarsa (milik pengguna); ikut terhapus saat akun diputus (purge 9A
  ditambah `mail_drafts`, lampiran, `mail_outbox`, `mail_signatures`, `mail_correspondents`, berkas
  `mail-out/`). Kontak dihapus (UU PDP) → baris `mail_correspondents` alamat itu dihapus.

## 17. Tes wajib

**Unit (core/shared)**
- `sanitizeComposerHtml`: skrip, `on*`, `<style>`, `class`, gambar `https:`/`data:` dibuang, `cid:` sah
  dipertahankan, `data-signature` hanya di `div`, sisa Word (`mso-*`, komentar), tempelan bersarang
  dalam (penjaga kompleksitas).
- Penerima balas/balas semua: identitas sendiri (utama & alias) dibuang, duplikat, `Reply-To`, email
  asli dari folder Terkirim, Bcc asli tidak pernah ikut.
- Awalan subjek (`Re:`/`RE:`/`Aw:`/`Fwd:`/`FW:` tidak ganda).
- `References`: akar + 19 terakhir, ID tak sah (CRLF, spasi, `>` ganda) dibuang.
- Kutipan: gambar dibuang, tautan peringatan → teks, `<style>` dibuang, potong 192 KB → teks.
- Rakit akhir ≤ 512 KB / 20.000 tag; teks akhir.
- Header injection: subjek/nama dengan `\r\n`, U+2028, pengubah arah → 400; MIME hasil tanpa header
  sisipan.
- Kode verifikasi: HMAC, kedaluwarsa, 5 percobaan, perbandingan waktu-konstan; `threadKey`;
  `thread_root`.

**Integrasi api**
- **Tabel otorisasi** peran × jenis akun × level × endpoint 9B: `read` tidak bisa membuat draf/kirim
  (403); draf/outbox orang lain → 404 (termasuk Owner); akun pribadi orang lain → 404 di semua rute;
  alias bersama tanpa `mail.accounts.manage`/tanpa konfirmasi → 403; Kelola non-Admin tidak bisa
  menambah alias.
- Identitas: unik lintas akun/channel/pengirim sistem (409, juga skenario "pembaca `cs@` menambahkan
  `cs@` ke akun pribadi"), batas kirim verifikasi (429), kode salah/kedaluwarsa, `system_sender_conflict`,
  reset ke `unverified` saat server/alamat akun berubah.
- Kirim: `identity_unverified` 409; klik ganda bersamaan → satu outbox (200 `duplicate`); versi
  basi 409; `thread_has_new_messages` lalu `acknowledgeNewMessagesUntil`; batas penerima; jatah alamat
  baru diambil & dikembalikan saat batal/gagal validasi; batas harian pengguna menghitung email; rem
  darurat 423; antrean penuh 429.
- Batalkan: dari `pending`/`queued` → draf kembali; balapan batal vs klaim worker (tepat satu menang);
  `not_cancelable`.
- Lampiran: jenis diblokir (exe, docm, zip, doc lama, SVG, HTML) dari isi bernama `.pdf`; total >
  batas; `from-message` butuh hak `read` & menolak `blocked`/`warn`; inline hanya raster.
- Snippet: variabel di-escape, `missingVariables`, profil editor diterapkan; saran penerima tidak
  membocorkan korespondensi akun pribadi orang lain / kontak di luar cakupan.
- Pengaturan: menaikkan `maxRecipientsPerEmail` tanpa konfirmasi → 403.

**Integrasi worker** (server SMTP & IMAP uji)
- Kabel SMTP: Bcc tidak ada di header terkirim tetapi ada di `RCPT TO`; salinan Terkirim memuat `Bcc:`;
  `Message-ID` di domain identitas; `In-Reply-To`/`References`; tanpa `Auto-Submitted`/`X-Mailer`;
  amplop = alamat akun.
- Cek ulang: hak dicabut / identitas direset / akun diputus antara kirim & klaim → `failed` + draf
  kembali; 4xx → jadwal coba ulang; `4.7.x` → `throttled`; login ditolak → `blocked`; putus setelah
  DATA → `delivery_unknown` tanpa ulang; batas per jam menahan.
- Salinan Terkirim `auto`: ada di server → `server_saved`; tidak ada → `APPEND`; `none`.
- Draf server: `APPEND` + hapus UID lama dengan `UID EXPUNGE`; tanpa UIDPLUS tidak pernah `EXPUNGE`
  biasa; debounce 30 dtk / 2 menit.
- Verifikasi: email verifikasi lewat SMTP SISTEM (bukan akun); cocok di Kotak masuk → `verified`
  (`mailbox`); salinan di folder Terkirim/Draf TIDAK memverifikasi; cadangan `SEARCH`.
- Presence: TTL 45 dtk, event hanya ke pemegang `read`, tidak ke pengguna tanpa akses.

**E2E (Playwright, 390 px & 1440 px, terang & gelap)**
- Tulis baru → kirim → toast **Batalkan** → draf terbuka lagi; kirim tanpa batal → muncul di Terkirim.
- Balas semua (cip Kepada/Cc benar), teruskan dengan lampiran asli, unggah lampiran + tolakan jenis.
- Verifikasi alias dengan kode (SMTP sistem uji); "Dari" nonaktif sebelum terverifikasi.
- Dua konteks peramban: "Dimas sedang membalas…" muncul & hilang; email baru di utas → dialog sebelum
  kirim.
- Konflik versi dua tab; HP: jendela tulis layar penuh + FAB.

## 18. Keputusan (untuk dipindah ke `DECISIONS.md`)

1. **Verifikasi identitas wajib untuk SEMUA identitas (utama & alias), tanpa jalan pintas Owner.**
   Email verifikasi dikirim lewat **Email pengirim sistem** (rute MX asli, bukan SMTP akun yang bisa
   dikuasai pendaftar); bukti = `Message-ID` rahasia ditemukan di kotak surat akun itu sendiri (folder
   masuk, bukan Terkirim/Draf/Sampah) ATAU kode 6 digit dimasukkan (pola "kirim sebagai" Gmail).
   Menutup sisa risiko S4 9A-1.
2. **Verifikasi tidak tersedia bila kotak surat akun = Email pengirim sistem** (`system_sender_conflict`)
   — salinan otomatis di Terkirim akan membocorkan kode ke pembaca akun.
3. **Alamat identitas unik di organisasi** (akun Email lain, Channel Email + alias, Email pengirim
   sistem), dua arah, di bawah advisory lock 9A. Mencegah pemegang hak Baca kotak bersama
   "meminjam" alamatnya lewat akun pribadi.
4. **Alias akun bersama = `mail.accounts.manage` + konfirmasi identitas** (setara alias channel 9.0 R7);
   akun pribadi = pemilik. Nama tampilan, `Reply-To` (domain sama), tanda tangan bersama = level Kelola.
   Matriks izin tidak berubah.
5. **`mail_outbox` tabel terpisah dari `email_outbound` 9.1** (bukan `source = 'mail'` di tabel yang
   sama): email pribadi tim tidak boleh bocor ke Riwayat kirim API, webhook `email.*`, pencocokan
   bounce/balasan channel; batasan & status berbeda (masa batal, salinan Terkirim). Logika yang sama
   dipakai ulang lewat fungsi core (klasifikasi SMTP, jadwal coba ulang, MIME), dan **batas per jam
   akun satu sumber** (`email_sender_settings` jenis `account`, menghitung kedua tabel).
6. **Batalkan kirim = baris outbox `pending` dengan `send_after`**, bukan job tertunda di Redis:
   pembatalan = pembaruan bersyarat di database, worker mengklaim dengan `SKIP LOCKED` hanya setelah
   `send_after`; tick 2 dtk. Lama jeda per pengguna 5–30 dtk (bawaan 10). "Kirim sekarang" tersedia.
   Pembatalan juga boleh saat `queued` (tertahan batas), tidak saat `sending`.
7. **Draf tetap ada sampai `sent`** (dikunci `sending`); batal/gagal mengembalikan draf apa adanya +
   `last_send_error`. Idempotensi kirim = satu outbox aktif per draf (indeks unik) + `baseVersion`.
8. **Draf: database = kebenaran**; simpan otomatis debounce 2 dtk/maks. 5 dtk ke database, salinan ke
   folder Draf server debounce 30 dtk & maks. sekali per 2 menit (lampiran tidak diunggah ulang terus),
   ganti salinan lama lewat UID; draf > 30 MB tidak disalin. "Lanjutkan" draf aplikasi lain → 9C.
9. **Kutipan email asli tidak pernah masuk editor** (tampil lewat iframe dokumen ber-token 9A); saat
   kirim dirakit server dari HTML tampilan tersimpan dengan gambar dibuang, tautan menipu dicabut,
   `<style>` dibuang, ≤ 192 KB (cadangan teks).
10. **Editor tanpa gambar jarak jauh**: `img` hanya `cid:` (unggahan draf / logo tanda tangan) — editor
    di origin aplikasi tidak pernah memuat server pihak ketiga.
11. **Profil HTML editor lebih sempit** dari profil keluar 9.1 (tanpa `<style>`/`class`, gaya terbatas);
    profil keluar 9.1 tetap lapis akhir.
12. **Tanda tangan bersama (per akun) + pribadi (per pengguna per akun)**, variabel `{{nama_agen}}`
    dkk., logo PNG ≤ 320 px di database (inline `cid:`), bawaan baru vs balasan per identitas +
    pilihan pribadi di `mail_user_preferences`.
13. **Lampiran tulis = daftar izin 9.1** (arsip & Office lama ditolak), total bawaan **20 MB** (bisa
    diatur ≤ 25) — PRD menyebut 25 MB, diturunkan karena base64 menambah ±33% dan banyak penyedia
    menolak pesan > 25 MB setelah dikodekan.
14. **Batas**: penerima per email bawaan 50 (1–100, menaikkan = konfirmasi); per akun per jam = batas
    pengirim 9.1 (100 penerima); **satu batas harian per pengguna** untuk pesan Inbox + email (per
    penerima); jatah **alamat baru 200/hari/pengguna** (Redis, refund) tanpa mensyaratkan
    `inbox.initiate` — CS memang boleh menulis email ke siapa pun dari akun yang ia punya hak kirim.
15. **"Alamat baru" = tidak ada di `mail_correspondents` akun itu** (diisi dari From email masuk yang
    tidak `fail` + penerima email terkirim); tabel yang sama memberi pelengkap otomatis.
16. **Presence lewat HTTP heartbeat 20 dtk + TTL 45 dtk di Redis**, event WS ke pemegang `read` akun
    bersama; soket WS tetap satu arah. Kunci utas 9B = `thread_root` (akar `References`), `threadKey`
    opak ber-HMAC; 9C membangun utas penuh di atasnya.
17. **Peringatan email baru di utas ditegakkan server** (409 `thread_has_new_messages` + konfirmasi
    `acknowledgeNewMessagesUntil`), bukan hanya bilah di web.
18. **Salinan Terkirim `auto`** = cari `Message-ID` di Terkirim dulu, `APPEND` hanya bila belum ada
    (Gmail/Microsoft 365 menyimpan sendiri) — tanpa daftar host penyedia.
19. **Amplop `MAIL FROM` = alamat akun**, header `From` = identitas (alias). Email manusia **tanpa**
    `Auto-Submitted`, `X-Mailer`, tanda terima baca, atau pelacak.
20. **Balas hanya dari akun yang sama**; teruskan boleh dari akun lain yang ber-hak kirim (butuh hak
    baca di akun asal). Awalan `Re:`/`Fwd:` tidak diterjemahkan.
21. **FK `mail_account_id` yang tertinggal di 9.1** (`email_sender_settings`, `api_key_email_senders`)
    ditambah di 0038; `email_outbound` menyusul 9E.

## 19. Pertanyaan terbuka & catatan untuk agen lain

- **Tidak ada yang memblokir 9B.** Untuk Tobing (tidak mendesak, catat di BUTUH-TOBING bila perlu):
  (a) alamat tanpa kotak surat (mis. `noreply@`) tidak bisa diverifikasi → tidak bisa dipakai sebagai
  "Dari" di menu Email (tetap bisa lewat Channel/API 9.1) — perlu "verifikasi manual Owner" nanti?;
  (b) apakah Email pengirim sistem Sky Tech memakai kotak surat yang juga akan dihubungkan sebagai akun
  Email (mis. `cs@`)? Bila ya, verifikasi akun itu terkunci (`system_sender_conflict`) sampai Email
  pengirim diganti ke `noreply@`.
- **`security`**: (1) risiko lebih luas di luar 9B — bila kotak surat Email pengirim sistem (yang
  mengirim tautan reset password & undangan) juga dihubungkan sebagai akun Email bersama, salinan email
  keamanan di Terkirim (Gmail/M365) terbaca pembaca akun itu. Usul: larang/peringatkan di 9A/9B
  (keputusan 2 hanya menutup jalur verifikasi). (2) Sisa risiko Rendah: alamat yang meneruskan salinan
  ke kotak bersama memungkinkan pembaca kotak bersama melihat kode verifikasi alamat itu (teks email
  menyebut peminta & akun). (3) Uji header injection lewat `References` email masuk.
- **`devops`**: tidak ada rute ber-`frame-ancestors` baru; antrian baru `mail-send`; berkas sementara
  `mail-out/` ikut volume media (tidak masuk backup? — `.eml` ≤ 7 hari, lampiran draf ikut backup).
- **`frontend`**: kontrak UI di §6 (simpan otomatis, konflik), §8 (cid ↔ pratinjau), §9.1 (toast batal),
  §10 (menu `/`), §11 (presence/bilah utas), §6.5 (peringatan); mockup keadaan **Tulis**.
- **Peta dokumen `CLAUDE.md`** (ditambah orkestrator): `docs/KONTRAK-API-EMAIL-TULIS.md` — Kontrak modul
  Email 9B: identitas & verifikasi, tanda tangan, draf (+ salinan server), lampiran, kirim/batalkan
  kirim/outbox, salinan Terkirim, template di editor, presence & peringatan utas, batas.

## 20. Penyimpangan implementasi (backend 9B)

- **Migrasi `0039_mail_tulis`** (bukan 0038 — nomor itu dipakai `0038_mail_kuota_cache_gambar` 9A-2).
- **FK `set null` satu kolom**: `mail_outbox.identity_id/draft_id/sent_message_id`, `mail_drafts.source_message_id`,
  `mail_identities.default_signature_*_id`, `mail_draft_attachments.source_attachment_id` (FK komposit `set null`
  juga mengosongkan `organization_id`). `mail_drafts.template_id` tanpa FK. Isolasi organisasi di service.
- **Folder media `email-out/`** untuk lampiran draf & `.eml` (`mail-out/` belum didukung `MediaStore`; CHECK menerima
  keduanya). `.eml` tanpa akhiran `.eml`.
- **Galat**: `errorDetailSchema` mendapat isian opsional `attemptsLeft`, `currentVersion`, `updatedAt`, `count`,
  `latestReceivedAt`, `messageIds`, `cause`. Tanpa konfirmasi identitas (tambah alias bersama, menaikkan batas) →
  **400** `VALIDATION_ERROR` (pola `requireIdentityConfirmation` yang ada), password salah → 403.
- **Kuota unggah 500 MB/24 jam** dihitung dari lampiran unggahan yang masih ada (database) DITAMBAH unggahan ≤ 24 jam
  yang sudah dihapus (sorted set Redis per pengguna) — review 9B R5.
- **Verifikasi**: setelah email verifikasi terkirim, salinan terenkripsi DIHAPUS utuh (review 9B S1) — tidak ada lagi
  cadangan `UID SEARCH HEADER Message-ID` ke server akun; job `mail-identity-verify-check` hanya mencocokkan email yang
  sudah tersinkron di folder masuk (lokal). Tanpa produsen antrean (tes) email verifikasi TIDAK dikirim ulang oleh tick.
- **Kutipan**: bila isi email asli belum/tidak lagi di cache (`mail_message_bodies`), email dikirim TANPA kutipan
  (bukan menunggu pengambilan isi). Zona waktu kutipan salinan draf server = `Asia/Jakarta` (worker tidak tahu zona
  organisasi); email terkirim memakai zona organisasi.
- **Lampiran asli `loading`** diselesaikan malas saat draf dibuka/dicek/dikirim (bukan oleh job ambil lampiran 9A).
- **Presence**: anggota yang pengguna nonaktif disaring di tick; event saat masuk dikirim api, saat keluar/kedaluwarsa
  oleh api (DELETE) atau tick worker 15 dtk.
- **Batas per jam akun** dihitung dari `mail_outbox` saja (`email_outbound` pengirim `acc_` menyusul 9E).
- **Akun diputus**: outbox `pending/queued` dibatalkan, draf + lampiran dibuang seketika di api.
- **Belum dibuat (menyusul)**: job `mail-correspondents-backfill` (isi awal dari email lama; saat ini korespondensi
  terisi dari email masuk baru & email terkirim), notifikasi `blocked` ke pemegang Kelola (saat ini Owner / pemilik
  akun pribadi), batas "maks. sekali per 24 jam" notifikasi blocked (saat ini sekali per kejadian blocked),
  penghapusan baris `mail_correspondents` saat kontak dihapus (UU PDP), dan pelepasan `blocked` lewat "Lanjutkan"
  9.1 untuk pengirim `acc_` (saat ini lewat simpan ulang kredensial akun).
- **Bentuk respons yang perlu diketahui web** (skema = `packages/shared/src/mail-compose.ts`):
  `GET /mail/recipients/suggest` → `{ suggestions: [...] }` (bukan array polos); `PUT/DELETE …/presence` →
  `{ threadKey, users }` (tanpa diri sendiri); `DELETE …/attachments/:id` → `{ deleted, draft: { version } }`;
  `POST …/attachments/from-message` → **200** `{ attachments, skippedAttachments, draft: { version } }`;
  `DELETE /mail/identities/:id` → `{ deleted, movedDrafts }`; `DELETE /mail/signatures/:id` → `{ deleted }`;
  `MailSignature` punya `editable`; draf/identitas punya `cannotSendReason` (`identity_unverified` ·
  `level_insufficient` · `account_deleting` · `account_unavailable`); kirim klik ganda → 200 `{ outbox, duplicate: true }`.
  `POST …/attachments` menerima `inline` lewat isian multipart **atau** `?inline=1`.
  `MailAccount` (9A) kini juga `sentCopyMode`, `warnExternalRecipients`, `warnings[]`
  (`system_sender_conflict`, `identity_unverified`); PATCH akun menerima `sentCopyMode`/`warnExternalRecipients`
  (level Kelola). `MailSettings` juga `maxRecipientsPerEmail`, `maxAttachmentTotalMb` (PUT: opsional,
  menaikkan butuh `confirmation`). Detail email 9A: `threadKey` + `composing[]`; daftar folder Draf: `draftId`
  (hanya draf milikku).
- **Perbaikan review keamanan 9B (2026-11-23) — perubahan bentuk API untuk web** (migrasi `0040_mail_review_9b`):
  - `MailIdentity.approval: { state: 'not_required' | 'pending' | 'approved' | 'rejected', decidedAt }` (S3).
    `verification.unavailableReason` bisa juga `approval_pending` / `approval_rejected` (pesan di
    `MAIL_VERIFICATION_UNAVAILABLE_MESSAGES`); `cannotSendReason` (identitas & draf) bisa `identity_not_approved`.
    Teks `system_sender_conflict` diganti: kini berlaku untuk SELURUH organisasi (kotak surat Email pengirim sistem
    terhubung sebagai akun Email mana pun).
  - Rute baru (Owner/Admin, `mail.accounts.manage`): `GET /api/v1/mail/identity-approvals` →
    `{ approvals: [{ identityId, accountId, address, displayName, isPrimary, owner: { id, name } | null, createdAt }] }`
    (menunggu persetujuan, maks. 200); `POST /api/v1/mail/identities/:identityId/approval`
    `{ decision: 'approve' | 'reject', confirmation }` → 200 `{ identity }` · 400 tanpa konfirmasi · 403 bukan
    Owner/Admin (atau Admin memutuskan alamat akun pribadinya sendiri) · 404 identitas yang tidak perlu persetujuan.
  - Galat baru: 409 `system_sender_mailbox` (buat/ubah akun Email yang kotak suratnya = Email pengirim sistem;
    `PUT /settings/email` ke alamat/kotak surat akun Email yang ada); 409 `identity_not_approved` (kirim); 409
    `verification_unavailable` kini juga saat MASUKKAN KODE bila verifikasi terkunci (`details[].cause`), dan 409
    `address_in_use` saat mulai verifikasi identitas akun pribadi yang alamatnya kini dipegang organisasi. 409
    `address_in_use` untuk Owner/Admin menyebut pemegangnya (`details[].cause`: `system_sender` · `channel` ·
    `shared_identity` · `personal_identity`); Channel Email tetap `address_is_mail_account` dengan pesan yang menyebut
    pemegangnya.
  - Status outbox baru **`delivery_unknown`** (final, tidak diulang; `failureReason: 'delivery_unknown'`) di
    `MailOutboxItem.status` dan event WS `mail.outbox.updated` — web harus menganggapnya FINAL (toast kirim selesai,
    seperti `failed`) dan menampilkannya di baki `?state=failed`.
  - Salinan draf server (S6): draf berlampiran > 10 MB → `serverCopy.state: 'disabled'`; salinan bisa tetap `pending`
    lebih lama (lampiran > 1 MB yang tidak berubah disalin ulang paling sering tiap 30 menit; anggaran 50 MB/akun/jam).
  - Email verifikasi tidak lagi memuat nama pengguna / nama tampilan akun (R3).
