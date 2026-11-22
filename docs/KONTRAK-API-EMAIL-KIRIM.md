# Kontrak API — Kirim email lewat API (Fase 9, tahap 9.1)

API untuk n8n, aplikasi billing, dan sistem lain yang perlu mengirim **email tagihan, kode VA, QRIS,
bukti bayar, atau invoice PDF** lewat pengirim email milik organisasi — padanan
`POST /public/messages/template` untuk WhatsApp. Spesifikasi: `docs/PRD-EMAIL.md` §4.8, §4.12 (logo di
kepala template), §5 (scope), §7 (keamanan). Pola yang dipakai ulang: `docs/KONTRAK-API-PUBLIK.md`
(API key, scope, batas), `docs/KONTRAK-WEBHOOK-KELUAR.md` (outbox, tanda tangan, SSRF),
`docs/KONTRAK-API-TEMPLATE.md` (urutan pemeriksaan R1, mulai percakapan dari key),
`docs/KONTRAK-API-CHANNEL-LAIN.md` (Channel Email Fase 6).

Rencana lokasi kode (belum ada): skema Zod `packages/shared/src/email-send.ts` (kirim, status, pengirim,
webhook) dan `packages/shared/src/email-message-templates.ts` (template email + preset; BEDA dengan
`email-templates.ts` yang berisi email sistem undangan/reset). Api: `apps/api/src/modules/email-send/`
(rute publik + pengaturan pengirim), `apps/api/src/modules/email-message-templates/`. Core:
`packages/core/src/mail/qris.ts` (validasi + gambar QR), `packages/core/src/mail/outbound-html.ts`
(sanitasi HTML keluar, isi variabel, bingkai merek, versi teks). Worker:
`apps/worker/src/queues/email-outbound.ts`. Migrasi: nomor berikutnya setelah migrasi 9.0 (9.0 memakai
`0033`/`0034`; perkiraan `0035_email_kirim_api`).

## 0. Cakupan 9.1

| Masuk 9.1 | Ditunda |
|---|---|
| Pengirim jenis **Channel Email Fase 6** (`kind: channel`) | Pengirim jenis **akun Email Fase 9** (`kind: account`) — dibuka setelah 9B (identitas `mail_identities` + kirim SMTP akun); bentuk API sudah disiapkan |
| Kirim dari template Balesin atau dari HTML/teks luar, variabel, QRIS, lampiran (base64 / `mediaId` / URL ber-allowlist), Kepada/Cc/Bcc ≤ 50, `replyTo`, alias pengirim channel, `scheduledAt` + batal, `conversation: "create"`, `metadata`, `Idempotency-Key` | Webhook & API `mail.*` untuk akun Email (9E) |
| Status (`queued` → `sent`/`failed`/`bounced`), webhook `email.sent/failed/bounced/replied` | Bounce dari pengirim yang memakai SMTP sistem (lihat §5) |
| Pengaturan → **Template email** (draf, terbitkan, pratinjau, kirim tes, riwayat versi, 6 preset ISP) | Editor visual berbasis blok bisa menyusul di 9B; 9.1 cukup editor HTML + pratinjau |
| Batas per pengirim per jam (bawaan 100), antrean + jeda otomatis saat SMTP menolak, jeda/lanjut per pengirim, rem darurat | Salinan ke folder Terkirim server untuk pengirim channel (Channel Email tidak punya sinkron folder) |
| API key dibatasi ke pengirim tertentu + allowlist host URL lampiran | — |

## 1. Pengirim (sender)

Pengirim = sumber SMTP + alamat "Dari" yang sah. ID pengirim **berawalan jenisnya** supaya satu isian
cukup: `chn_<uuid channel>` (Channel Email) dan `acc_<uuid akun>` (akun Email bersama, setelah 9B).
Akun Email **pribadi** tidak pernah bisa menjadi pengirim API.

| Isian | Channel Email, SMTP `custom` | Channel Email, SMTP `system` |
|---|---|---|
| `From` | `fromName` channel + alamat channel (atau alias, §3.6) | Alamat **Email pengirim sistem** (Pengaturan → Email pengirim) |
| `Reply-To` | `replyTo` permintaan, bila kosong tidak ada | Selalu alamat channel (balasan pelanggan harus kembali ke kotak masuk channel) — `replyTo` lain → 400 |
| Envelope `MAIL FROM` | alamat channel | alamat sistem |
| Lacak bounce (`bounceTracking`) | ya — DSN kembali ke kotak masuk channel yang dipolling | **tidak** — DSN masuk ke kotak sistem yang tidak dibaca aplikasi |
| Alias | boleh (§3.6) | tidak |

Pengirim tidak bisa dipakai bila channel nonaktif/terhapus, kredensial SMTP tidak bisa dibuka, atau
status pengirim `blocked` (§4).

## 2. API key: scope & pembatasan

Scope baru di `API_KEY_SCOPES` (`packages/shared/src/api-keys.ts`):

| Scope | Arti | Termasuk |
|---|---|---|
| `email:read` | Baca status email yang dikirim lewat API, daftar pengirim & template | — |
| `email:send` | Kirim, batal, balas email; unggah lampiran | `email:read` |

- `email:send` **sendiri sudah memulai percakapan** (mengirim ke alamat mana pun), jadi rute email TIDAK
  meminta `messages:initiate`. Scope ini tidak memberi akses ke rute WhatsApp/percakapan lain.
- **Pengirim yang diizinkan wajib dipilih** (≥ 1) saat key memegang `email:*` — tidak ada pilihan
  "semua pengirim". Disimpan di `api_key_email_senders`. Pengirim yang dihapus ikut lepas dari key;
  key tanpa pengirim tersisa → semua kirim 403.
- **Allowlist host URL lampiran** (`api_keys.email_attachment_hosts`, ≤ 20): nama host persis
  (`billing.perusahaan.example`) atau wildcard satu tingkat ke atas (`*.perusahaan.example` = semua
  subdomain, BUKAN domain induknya), atau IP literal. Kosong = lampiran `url` ditolak. Host privat
  tetap butuh allowlist IP privat organisasi (Pengaturan → Integrasi, sama dengan webhook keluar).
- `allowedIps`, kedaluwarsa, cabut, dan `dailySendLimit` key yang sudah ada tetap berlaku.

Perubahan pengelolaan key (`api_keys.manage`, Owner/Admin):

| Endpoint | Perubahan |
|---|---|
| `POST /api/v1/settings/api-keys` | Tambahan `emailSenderIds?: string[]` (≤ 20, wajib ≥ 1 bila scope `email:*`; selain itu harus kosong) dan `emailAttachmentHosts?: string[]` |
| `PATCH /api/v1/settings/api-keys/:id` **(baru)** | `{ emailSenderIds?, emailAttachmentHosts?, confirmation }` — **selalu wajib konfirmasi identitas**. Scope tetap tidak bisa diubah (buat key baru). Audit `api_key.updated` + kejadian keamanan `api_key_changed` (`warning`) |
| `ApiKey` (respons) | Tambahan `emailSenders: [{ id, kind, name, address }]`, `emailAttachmentHosts: string[]` |

## 3. Endpoint publik

Semua di `/api/v1/public/email/*`, header `Authorization: Bearer blsn_live_…`, aturan autentikasi,
`Origin` asing, 401/403, dan 300 permintaan/menit per key sama dengan `KONTRAK-API-PUBLIK.md`. Respons
camelCase; galat `{ error: { code, message, details?, requestId } }` (§10).

| Endpoint | Scope | Isi |
|---|---|---|
| `GET /public/email/senders` | `email:read` | Pengirim yang boleh dipakai key ini |
| `POST /public/email/send` | `email:send` | Kirim satu email → **202** (baru) / **200** (ulangan `Idempotency-Key`) |
| `POST /public/email/media` | `email:send` | Unggah lampiran dulu (multipart) → **201** `{ media }` |
| `GET /public/email/messages/:id` | `email:read` | Status satu email |
| `POST /public/email/messages/:id/cancel` | `email:send` | Batalkan email `scheduled`/`queued` milik key ini |
| `GET /public/email/templates` | `email:read` | Template email yang sudah diterbitkan + variabelnya |
| `POST /public/email/messages/:id/reply` | `email:send` | Balas **email masuk** (pesan Inbox) di utasnya |

Cakupan data: key hanya melihat pengirim di daftarnya, dan hanya email (status) yang dikirim lewat
pengirim itu. `GET /messages/:id` untuk email pengirim lain = 404. Key lain yang berbagi pengirim
melihat ringkasan TANPA `bcc` (kosong), `metadata`, dan `idempotencyKey` (`null`) — isian itu hanya
untuk key pembuatnya (review 9.1 R1).

### 3.1 `GET /public/email/senders`

```json
{ "senders": [ {
  "id": "chn_6b1f…", "kind": "channel", "name": "Billing",
  "address": "billing@perusahaan.example", "fromAddress": "billing@perusahaan.example",
  "fromName": "Billing Perusahaan", "aliases": ["tagihan@perusahaan.example"],
  "replyToFixed": false, "bounceTracking": true,
  "hourlyLimit": 100, "sentLastHour": 37, "queued": 4,
  "state": "ok", "throttledUntil": null } ] }
```

`state`: `ok` · `throttled` (server SMTP meminta jeda, `throttledUntil` terisi) · `paused` (dijeda
Owner/Admin) · `blocked` (login SMTP ditolak / kredensial tidak terbuka — butuh perbaikan di
Pengaturan) · `disabled` (channel nonaktif). Email ke pengirim `throttled`/`paused`/`blocked` tetap
DITERIMA (masuk antrean, §4); `disabled` → 409.

### 3.2 `POST /public/email/send`

Header: `Content-Type: application/json`, `Idempotency-Key` (disarankan sangat, §3.8). Batas body
**28 MiB** (lampiran base64 20 MB + JSON); lebih → 413.

```ts
{
  senderId: string,                       // "chn_<uuid>"
  fromAddress?: string,                    // alamat pengirim atau salah satu alias (§3.6)
  fromName?: string,                       // ≤ 80, tanpa karakter kendali, tanpa "@", "<", ">"
  to: Recipient[],                         // ≥ 1
  cc?: Recipient[], bcc?: Recipient[],     // total Kepada+Cc+Bcc ≤ 50 setelah dedup
  replyTo?: string,                        // §3.6
  // Isi: PILIH SATU bentuk
  templateId?: string,                     // UUID atau slug ("tagihan-bulanan")
  variables?: Record<string, string | number | boolean | null>,
  subject?: string, html?: string, text?: string,   // bentuk luar
  layout?: "brand" | "none",               // bawaan: dari template; "none" untuk bentuk luar
  qris?: { payload: string, cid?: string /* "qris" */, attach?: boolean /* false */,
           filename?: string /* "QRIS.png" */, sizePx?: number /* 480, 240–1024 */ },
  attachments?: Attachment[],              // ≤ 10 berkas, total ≤ 20 MB
  scheduledAt?: string,                    // ISO; ≤ 30 hari ke depan; lampau/kini = kirim segera
  conversation?: "none" | "create",        // bawaan "none" (§3.7)
  metadata?: Record<string, string | number | boolean | null>   // §3.9
}
Recipient  = { email: string, name?: string }          // name ≤ 80
Attachment = { filename: string,                       // ≤ 200, dibersihkan (cleanFileName)
               contentBase64?: string, mediaId?: string, url?: string,   // TEPAT SATU
               inline?: boolean, cid?: string }        // inline gambar: dirujuk <img src="cid:…">
```

Respons **202**:

```json
{ "id": "5a0c…", "status": "queued", "senderId": "chn_6b1f…", "recipientCount": 2,
  "scheduledAt": null, "conversationId": "c81e…", "messageId": "9d2f…" }
```

`status` `queued` atau `scheduled`; `conversationId`/`messageId` (pesan Inbox) hanya bila
`conversation: "create"`, selain itu `null`.

**Urutan pemeriksaan** (pola R1 KONTRAK-API-TEMPLATE: tidak ada data dibuat sebelum lolos semua):
1. Autentikasi, scope `email:send`, `allowedIps` → 401/403.
2. Skema body (Zod) → 400.
3. **Idempotensi** (§3.8) → 200 ulangan / 409 bentrok. Sebelum mengambil URL apa pun.
4. Pengirim ada di daftar key → 403; pengirim `disabled` → 409.
5. Rem darurat organisasi → **423 `SENDING_PAUSED`**.
6. Batas harian key (`dailySendLimit`, 24 jam bergulir, **penerima email + penerima pesan lewat key
   yang sama dijumlah**; 1 email = jumlah penerimanya Kepada+Cc+Bcc setelah digabung — review 9.1 S2):
   hitungan + penerima email baru > batas → 429 + audit `sending.limit_reached` target `api_key` (pola
   lama). Antrean pengirim penuh (penerima menunggu + penerima baru > 24 × `hourlyLimit`) → 429.
7. Isi: template (ada, sudah terbit, tidak diarsip → 404/409) + variabel, ATAU subjek/HTML/teks luar.
8. QRIS (§3.4), penerima/`replyTo`/alias (§3.6), `conversation` (§3.7), `metadata`.
9. Lampiran (§3.5): base64 didekode & dicek isinya, `mediaId` dicari, URL dicek allowlist lalu diambil.
10. Render (§3.3): HTML final, versi teks, gambar inline; semua `cid:` yang dirujuk harus tersedia.
11. Satu transaksi: `email_outbound` + `email_outbound_attachments` (+ kontak, percakapan, pesan Inbox
    bila `create`). Worker mengambilnya dari database (§4) — api tidak bergantung pada Redis untuk
    menerima email.

### 3.3 Isi email & render

**Bentuk template**: `templateId` (+ `variables`); `subject`/`html`/`text` → 400 `content_conflict`.
**Bentuk luar**: `subject` (wajib) + `html` dan/atau `text` (minimal satu). Tidak ada keduanya → 400
`content_missing`.

Template memakai **versi terbit terakhir** (§7); versi yang dipakai dicatat di email
(`templateVersion`).

Variabel (`{{nama}}`, huruf kecil/angka/`_`, diawali huruf, ≤ 40):
- Nilai: string ≤ 1.000 karakter (angka/boolean diubah ke teks, `null` = kosong); tanpa karakter
  kendali selain baris baru, tanpa U+2028/U+2029.
- Di HTML: **selalu di-escape**; baris baru → `<br>`. Di subjek: baris baru ditolak.
- Di atribut `href`: hanya bila nilainya URL `https://` ≤ 2.000 karakter (selain itu 400
  `template_variable_invalid`). Variabel di atribut lain tidak didukung (ditolak saat template disimpan).
- Variabel wajib (`required`) tidak dikirim → 400 `template_variable_missing` (satu detail per variabel).
  Variabel opsional tidak dikirim = kosong. Kunci yang tidak dikenal template **diabaikan** (n8n boleh
  mengirim superset).
- Variabel bawaan (tidak boleh dideklarasikan): `{{nama_organisasi}}` (nama organisasi di Branding) dan
  `{{qris}}` (slot gambar QRIS; kosong bila `qris` tidak dikirim).

**Sanitasi HTML keluar** (`sanitizeOutboundEmailHtml`, profil BERBEDA dari sanitasi email masuk Fase 6,
yang membuang gaya & gambar): berlaku untuk HTML template saat disimpan DAN HTML luar saat dikirim.
- Boleh: elemen teks & struktur email (`table`, `tr`, `td`, `th`, `div`, `span`, `p`, `h1`–`h6`, `ul`,
  `ol`, `li`, `a`, `img`, `br`, `hr`, `strong`, `em`, `b`, `i`, `u`, `s`, `small`, `sup`, `sub`,
  `blockquote`, `pre`, `code`, `center`), atribut tata letak (`align`, `valign`, `width`, `height`,
  `bgcolor`, `border`, `cellpadding`, `cellspacing`, `colspan`, `rowspan`, `dir`, `lang`, `alt`,
  `title`), `style` (properti CSS dari daftar izin; tanpa `url()`, `expression`, `position: fixed`,
  `behavior`, `-moz-binding`), elemen `<style>` (tanpa `@import` dan `url()`).
- `href`: `https:`, `http:`, `mailto:`, `tel:`. `src` gambar: `cid:`, `https:`, `data:image/png|jpeg|gif`
  ≤ 100 KB.
- Dibuang: skrip, `on*`, `javascript:`, `iframe`, `object`, `embed`, `form`/input, `svg`, `math`,
  `link`, `meta`, `base`, media.
- HTML ≤ 512 KB, teks ≤ 256 KB, subjek 1–200 karakter setelah variabel diisi, tanpa CR/LF.
- Bila ada yang dibuang dari HTML **luar**, email tetap dikirim dan respons/status memuat
  `sanitized: true` (supaya integrator tahu).

**Bingkai merek** (`layout: "brand"`, bawaan untuk preset): tabel lebar maks. 600 px berisi kepala
(**logo organisasi** dari Branding sebagai gambar inline `cid:logo`, diubah ke PNG lebar ≤ 320 px —
WebP tidak dipakai karena banyak aplikasi email tidak mendukung; tanpa logo = nama organisasi),
garis warna utama Branding, isi, dan kaki (`footerText` template + nama organisasi). Ini pemenuhan
PRD §4.12 "logo di kepala template". Foto/avatar channel (9A) TIDAK dipakai di sini — itu tampilan di
dalam aplikasi.

**Versi teks**: `text` template/luar (variabel diisi tanpa escape) atau, bila kosong, dibuat dari HTML
(tag dibuang, tautan jadi `teks (url)`, gambar QRIS jadi "Pindai kode QRIS pada versi HTML email ini").

### 3.4 QRIS

`qris.payload`: teks QRIS (EMVCo MPM) 20–512 karakter ASCII cetak. Diperiksa SEBELUM apa pun dibuat:
1. Struktur TLV: tiap elemen = ID 2 digit + panjang 2 digit + nilai; harus habis tepat di akhir.
2. Diawali `000201`; elemen terakhir `63` panjang `04`.
3. **CRC-16/CCITT-FALSE** (polinom `0x1021`, awal `0xFFFF`, tanpa refleksi, tanpa XOR akhir) atas
   seluruh teks sampai dan termasuk `6304` = 4 karakter heksadesimal terakhir (huruf besar/kecil
   sama). Nilai uji: `"123456789"` → `29B1`.

Gagal → **400** `qris.payload` dengan `reason` `qris_invalid_format` atau `qris_crc_mismatch` — tidak
pernah membuat QR yang tidak bisa dibayar. Lolos → gambar **PNG** dibuat di api (koreksi galat M,
zona tenang 4 modul, `sizePx` bawaan 480) dan disisipkan inline dengan `Content-ID` = `qris.cid`
(bawaan `qris`, pola `^[A-Za-z0-9._-]{1,64}$`, tidak boleh bentrok dengan `cid` lampiran lain atau
`logo`). Template memakai slot `{{qris}}` (Balesin membuat `<img src="cid:qris" alt="Kode QRIS"
width="240">`); HTML luar merujuk `cid:<cid>` sendiri. `attach: true` = juga dilampirkan sebagai
berkas `filename` (tidak dihitung dalam 10 lampiran). Merujuk `cid:` QRIS tanpa mengirim `qris` → 400
`cid_missing`. Teks payload tidak pernah masuk log.

### 3.5 Lampiran

- **Tepat satu sumber** per lampiran → selain itu 400 `attachment_source_invalid`.
- `contentBase64`: base64 baku (tanpa awalan `data:`).
- `mediaId`: hasil `POST /public/email/media` oleh **key yang sama** untuk **pengirim yang sama**, belum
  kedaluwarsa (retensi media organisasi) → selain itu 400 `attachment_media_not_found`.
- `url`: host harus cocok `emailAttachmentHosts` key (sebelum DNS) → **403**
  `attachment_host_not_allowed`. Diambil dengan `fetchRemoteFile` (core) yang SAMA dengan webhook keluar:
  https wajib untuk alamat publik, IP privat hanya bila CIDR-nya di allowlist organisasi, port 80/443/
  5678/8080/8443, DNS sekali + soket ke IP terperiksa, redirect ≤ 3 dan **setiap lompatan diperiksa
  ulang terhadap allowlist host key + aturan SSRF**, tanpa cookie/kredensial, tenggat 15 dtk per berkas,
  maks. 3 berkas paralel, tenggat total permintaan 45 dtk. Gagal → 400 `attachment_fetch_failed`
  (`details[].message` menyebut sebabnya: tidak ditemukan, HTTP 4xx/5xx, terlalu lama, terlalu besar,
  alamat terlarang).
- Jenis dari **isi** (magic bytes), bukan nama/`Content-Type`. **Daftar izin** (review 9.1 R2): PDF,
  PNG/JPEG/GIF/WebP/BMP/TIFF, Word/Excel/PowerPoint (`doc`/`docx`/`xls`/`xlsx`/`ppt`/`pptx`) tanpa
  makro, CSV/TXT. Selain itu (berkas eksekusi, makro, HTML/SVG, skrip, pintasan, citra disk, arsip
  `zip`/`rar`/`7z`, audio/video, biner tak dikenal) → 400 `attachment_type_blocked`. Ekstensi nama berkas
  dipaksa sesuai jenis isi (mis. PDF bernama `foto.jpg` → `foto.pdf`; tanpa ekstensi → ditambahkan).
- Batas: ≤ 10 berkas (`attachments_too_many`), tiap berkas & total ≤ 20 MB setelah didekode
  (`attachment_too_large`). Gambar QRIS & logo tidak dihitung.
- `inline: true` + `cid` hanya untuk gambar raster; `cid` unik dalam satu email.
- Berkas disimpan di media store (`MEDIA_DIR`, nama acak, folder `email-out/`) SAAT diterima, jadi
  ulangan kirim/coba lagi tidak mengambil URL lagi. Isi lampiran tidak pernah di-log.

`POST /public/email/media` (multipart: isian `senderId` + `file` ≤ 20 MB) → **201**
`{ media: { id, filename, mimeType, sizeBytes, expiresAt } }`. Aturan jenis sama dengan di atas.
Disimpan di `media_files` (`channel_id` = channel pengirim, `uploaded_by_api_key_id`), **berlaku 24
jam** (isinya disalin ke `email-out/` saat email diterima). Kuota per key 500 MB / 24 jam → 429
`upload_quota` (review 9.1 R3).

### 3.6 Penerima, `replyTo`, alias

- Alamat: ASCII, ≤ 254 karakter, bagian lokal ≤ 64, domain berlabel valid dengan titik (domain IDN
  diubah ke punycode; bagian lokal non-ASCII/SMTPUTF8 belum didukung) → 400 `recipient_invalid`
  (`field: "cc.2.email"`).
- Dibandingkan tanpa beda huruf; alamat yang muncul lebih dari sekali **digabung** (prioritas
  Kepada > Cc > Bcc). Total setelah digabung ≤ 50 → selain itu 400 `too_many_recipients`. `to` ≥ 1.
- **Bcc** hanya di envelope SMTP, tidak pernah di header yang diterima siapa pun; disimpan di
  `email_outbound` untuk status.
- `replyTo`: satu alamat dengan **domain yang sama** dengan alamat pengirim (atau domain alias) →
  selain itu 400 `reply_to_not_allowed`. Pengirim SMTP sistem / `conversation: "create"`: hanya boleh
  kosong atau alamat channel (supaya balasan masuk ke percakapan).
- **Alias channel** (`fromAddress` ≠ alamat channel): HANYA alamat di daftar alias channel tahap 9.0
  (`channels.email_aliases`, alamat yang juga masuk ke kotak surat itu) yang **domainnya sama** dengan
  alamat channel, dan hanya untuk SMTP `custom`. Alias berdomain lain tetap berguna untuk "Alamat tujuan"
  9.0 tetapi tidak pernah boleh menjadi "Dari" (cegah penyamaran domain lain tanpa konfirmasi). Alamat
  lain → 400 `from_address_not_allowed`. Server SMTP penyedia tetap bisa menolak alias yang tidak
  diizinkan di akunnya → email `failed` `sender_rejected`.
- `fromName` berisi alamat email/`@` → 400 (cegah nama tampilan yang menyamar sebagai alamat lain).

### 3.7 `conversation: "create"`

Email keluar dicatat di **Inbox** supaya balasan pelanggan masuk ke percakapan yang sama dan bisa dijawab CS.
- Hanya pengirim `kind: channel` (akun Email tidak punya Inbox) → selain itu 400
  `conversation_requires_channel`. `to` tepat **1** alamat (Cc/Bcc boleh) → selain itu 400
  `conversation_requires_single_recipient`.
- Kontak dicari/dibuat per (organisasi, `email`, alamat huruf kecil); `to[0].name` hanya dipakai saat
  kontak BARU dibuat (nama dari tim tidak ditimpa).
- Percakapan (pola API template WhatsApp): percakapan terbuka kontak × channel dipakai; bila tidak ada,
  percakapan terakhir kontak itu di channel itu (status tetap); bila tidak ada sama sekali, dibuat
  **`resolved`** (tidak menambah antrian; balasan pelanggan membuka sesi baru `unserved` sesuai alur
  masuk Fase 6).
- Pesan Inbox: `direction: outbound`, `sender_kind: bot`, `api_key_id`, `type: text`, `text` = versi teks,
  `extras.email { subject, inReplyTo: null, references: [], attachments: [{ filename, sizeBytes }] }`,
  HTML tampilan di `message_email_bodies` (disanitasi ULANG dengan profil masuk Fase 6 — tampilan Inbox
  tidak memakai profil keluar), `wamid` = `Message-ID` email. Status pesan mengikuti email (`pending` →
  `sent`/`failed`), diperbarui worker di transaksi yang sama. Pesan ini TIDAK diproses antrian
  `messages` (worker email yang mengirim). Event WebSocket `message.created`/`message.status` dan webhook
  `message.sent`/`message.status` berlaku seperti pesan lain.
- Tanpa `create` (bawaan): tidak ada data Inbox. Balasan pelanggan tetap masuk ke Inbox channel sebagai
  percakapan biasa (channel memolling seluruh kotak masuk) dan tetap memicu `email.replied` (§5).

### 3.8 Idempotensi

- Header `Idempotency-Key`: 1–100 karakter ASCII cetak, per key (mis. nomor invoice). Tidak sah → 400
  (`location: headers`).
- Disimpan `(organization_id, api_key_id, idempotency_key)` unik + `request_hash` = SHA-256 JSON body
  yang dikanonisasi (kunci diurutkan).
- Kunci sama + hash sama → **200** dengan bentuk respons 202 berisi **status terkini** (juga bila email
  itu `failed` — kirim ulang dengan kunci baru). Kunci sama + body beda → **409 `CONFLICT`** reason
  `idempotency_key_reused`. Dua permintaan bersamaan → satu menang (indeks unik), yang lain membaca
  hasilnya.
- Berlaku selama baris email ada (180 hari, §11). Tanpa header = selalu email baru.

### 3.9 Metadata

Objek ≤ 20 kunci (`^[A-Za-z0-9_.-]{1,40}$`), nilai string ≤ 200 / angka / boolean / `null`, JSON total
≤ 2 KB → selain itu 400 `metadata_invalid`. Tidak pernah masuk ke isi/header email. Dikembalikan apa
adanya di status dan semua webhook `email.*` supaya n8n tahu invoice mana. Tidak di-log aplikasi;
tampil di Riwayat kirim API (§8.3).

### 3.10 `GET /public/email/messages/:id` — status

```json
{ "email": {
  "id": "5a0c…", "status": "sent", "source": "api",
  "sender": { "id": "chn_6b1f…", "kind": "channel", "address": "billing@perusahaan.example" },
  "from": "Billing Perusahaan <billing@perusahaan.example>",
  "to": [{ "email": "budi.santoso@contoh.example", "name": "Budi Santoso" }], "cc": [],
  "bcc": [{ "email": "arsip@perusahaan.example" }],
  "subject": "Tagihan November 2026 — PLG-00873",
  "template": { "id": "1e7d…", "slug": "tagihan-bulanan", "version": 3 },
  "sanitized": false, "idempotencyKey": "INV-2611-0873",
  "metadata": { "invoice_id": "INV-2611-0873" },
  "conversationId": "c81e…", "messageId": "9d2f…",
  "messageIdHeader": "<a1b2c3…@perusahaan.example>",
  "scheduledAt": null, "createdAt": "2026-11-25T02:00:00.000Z", "sentAt": "2026-11-25T02:00:04.000Z",
  "failedAt": null, "bouncedAt": null, "repliedAt": null, "canceledAt": null,
  "attempts": 1, "failure": null, "rejectedRecipients": [], "bounces": [] } }
```

| `status` | Arti |
|---|---|
| `scheduled` | Menunggu `scheduledAt` |
| `queued` | Di antrean (bisa tertahan batas per jam, jeda pengirim, atau rem darurat) |
| `sending` | Sedang diserahkan ke server SMTP |
| `sent` | Server SMTP menerima untuk minimal satu penerima (`rejectedRecipients` = yang ditolak) |
| `failed` | Gagal final; `failure { reason, message, smtpCode }` |
| `bounced` | Semua penerima memantul (DSN); sebagian saja → tetap `sent` dengan `bounces[]` |
| `canceled` | Dibatalkan sebelum dikirim |

`failure.reason`: `recipient_rejected` (semua penerima ditolak 5xx), `message_rejected` (5xx tingkat
pesan: ukuran/kebijakan/spam), `sender_rejected` (alamat Dari ditolak), `sender_unavailable` (pengirim
dinonaktifkan/dihapus/terblokir > 24 jam), `sender_not_allowed` (key dicabut/kedaluwarsa/kehilangan
scope atau pengirim), `sending_paused_expired` (tertahan rem darurat/jeda > 24 jam), `throttle_expired`
(tertahan penolakan SMTP > 24 jam), `delivery_unknown` (sambungan putus setelah isi terkirim — tidak
dicoba ulang, bisa saja sudah sampai), `attachment_unavailable`, `credentials_unavailable`. `message`
bahasa Indonesia dari daftar tetap; `smtpCode` = angka balasan SMTP saja (mis. 550) — teks balasan
server tidak pernah diteruskan. `bounces[]`: `{ recipient, status (mis. "5.1.1"), action: "failed",
receivedAt }`.

`POST /public/email/messages/:id/cancel` → `{ email }` dengan `status: canceled`; hanya key pembuatnya
dan hanya dari `scheduled`/`queued` (selain itu 409 `not_cancelable`). Pesan Inbox terkait (bila ada)
ditandai `failed` alasan `canceled` dan tidak ditampilkan sebagai gagal kirim (teks "Dibatalkan").

### 3.11 `GET /public/email/templates`

```json
{ "templates": [ {
  "id": "1e7d…", "slug": "tagihan-bulanan", "name": "Tagihan bulanan",
  "subject": "Tagihan {{periode}} — {{id_pelanggan}}", "version": 3, "layout": "brand",
  "hasQrisSlot": true, "updatedAt": "2026-11-20T08:00:00.000Z",
  "variables": [ { "name": "nama", "label": "Nama pelanggan", "required": true, "example": "Budi" },
                 { "name": "kode_va", "label": "Nomor VA", "required": false, "example": "8808 0000 0000 0001" } ] } ] }
```

Hanya template berstatus terbit dan tidak diarsip. Isi HTML tidak dikembalikan.

### 3.12 `POST /public/email/messages/:id/reply`

`:id` = ID **pesan Inbox** email masuk (dari `message.received`, atau `reply.messageId` webhook
`email.replied`). Dipakai bot/n8n (PRD §4.11).
- Pesan harus `inbound`, channel `email`, channel itu ada di daftar pengirim key → selain itu 404.
- Verifikasi pengirim email itu `fail` → **409** reason `sender_verification_failed` ("Pengirim email
  ini gagal verifikasi SPF/DKIM/DMARC, jadi tidak dibalas otomatis. Serahkan ke tim."). `unverified`
  diizinkan; bot WAJIB memperlakukannya sebagai tidak tepercaya (KONTRAK-WEBHOOK-KELUAR).
- Body: sama dengan `send` TANPA `senderId`, `to`, `conversation`, `scheduledAt`; `subject` opsional
  (bawaan `Re: <subjek asli>`); `cc` hanya alamat yang sudah ada di utas itu (Kepada/Cc email masuk
  tersebut) → selain itu 400 `cc_not_in_thread`. `Idempotency-Key`, `metadata`, `qris`, `attachments`,
  template berlaku.
- Kepada = alamat kontak percakapan. Header `In-Reply-To` = `Message-ID` email itu, `References` =
  rantainya (maks. 20). Selalu dicatat di percakapan Inbox (status percakapan tidak diubah; balasan ke
  percakapan `resolved` diizinkan karena `email:send` sudah memulai percakapan).
- → **202** `{ id, status, conversationId, messageId }`. Status & webhook sama dengan `send`.

## 4. Pengiriman (worker), batas per pengirim, jeda, rem darurat

- Worker `email-outbound` (job berkala tiap **5 dtk**, pola `webhooks-out`): klaim baris jatuh tempo
  (`status in (queued, scheduled)`, `next_attempt_at <= now()`) dengan `FOR UPDATE SKIP LOCKED`, maks.
  20 per putaran, lalu kirim. Tidak ada produsen antrian di api.
- **Pemeriksaan ulang sebelum kirim**: key masih aktif + scope + pengirim masih di daftar key (selain
  itu `failed` `sender_not_allowed`); channel aktif; kredensial terbuka; rem darurat; status pengirim.
- **Rem darurat** ditarik: baris tetap `queued` (ditahan, tidak gagal); > 24 jam tertahan → `failed`
  `sending_paused_expired`. Dilanjutkan → berjalan lagi.
- **Batas per pengirim per jam** (`email_sender_settings.hourly_limit`, bawaan **100**, 1–5.000) dihitung
  **per PENERIMA** (review 9.1 S2): jumlah `recipient_count` email `sent`/`sending`/`bounced` pengirim
  itu 60 menit bergulir (termasuk kirim tes). Email diklaim hanya bila jendela + penerimanya ≤ batas
  (email yang sendirian melebihi batas tetap boleh saat jendela kosong). Penuh → `next_attempt_at` =
  saat email tertua dalam jendela genap 1 jam. Urutan antre: `scheduledAt`/`created_at` (FIFO per
  pengirim). Rem otomatis organisasi (lonjakan per menit) ikut menghitung penerima email API.
- `fromName` pada pengirim SMTP **sistem** tidak bisa diganti (selain nama bawaan channel → 400
  `from_name_not_allowed`), karena akun itu juga mengirim email keamanan (review 9.1 R9).
- **Jeda otomatis saat SMTP menolak**: balasan sementara 421/450/451/452 atau sambungan ditolak/
  terlalu lama → email dicoba lagi (1, 5, 15, 30, 60 menit, lalu tiap jam, maks. 24 jam sejak dibuat →
  `throttle_expired`). Balasan yang menandakan pembatasan laju (421/451 dengan kode tambahan `4.7.x`,
  atau terlalu banyak sambungan) juga menyetel pengirim `throttled` (`throttled_until` = 5 menit, dua
  kali lipat tiap kejadian beruntun, maks. 60 menit) — SEMUA email pengirim itu menunggu.
- **Login ditolak / kredensial tidak terbuka** → pengirim `blocked` (`blocked_reason`), alarm Telegram
  (outbox `alarm_events`, teks tanpa data pelanggan) + email ke semua Owner + kejadian keamanan
  `email_sender_blocked` (`warning`). Email menunggu; diperbaiki (simpan kredensial channel / tombol
  "Lanjutkan") → jalan lagi; > 24 jam → `sender_unavailable`.
- 5xx per penerima → penerima itu masuk `rejectedRecipients`; semua ditolak → `failed`
  `recipient_rejected`. 5xx tingkat pesan → `failed` `message_rejected`/`sender_rejected`. Tidak ada
  coba ulang setelah isi pesan diterima server (koneksi putus setelah DATA = `delivery_unknown`).
- **MIME**: `Message-ID` baru di domain alamat Dari (`newOutboundMessageId`), `Date`, `From`, `To`, `Cc`,
  `Reply-To`, `Subject`, `Auto-Submitted: auto-generated` (RFC 3834 — mencegah balasan otomatis
  berantai; balasan manusia tidak terpengaruh), `multipart/alternative` (teks + HTML) dalam
  `multipart/related` (logo, QRIS, gambar inline) + `multipart/mixed` (lampiran). Transport nodemailer
  dengan akses berkas & URL dimatikan (isi hanya Buffer). Tanpa header pelacak buatan aplikasi.
- Aturan host/port/TLS SMTP = Fase 6 channel (`resolveMailHost`, port dari `allowedSmtpPorts`).
- Kirim tes template (§7) memakai jalur ini dengan `source: test` (tanpa key; dihitung batas per jam;
  tidak memicu webhook).

## 5. Bounce & balasan (perubahan pemroses masuk Channel Email Fase 6)

- **Bounce**: pemolling channel saat ini MELEWATI email bounce. Ditambah: email `multipart/report;
  report-type=delivery-status` (RFC 3464) dibaca dulu — `Message-ID` asli dari bagian
  `text/rfc822-headers`/`message/rfc822`, lalu per penerima `Final-Recipient`, `Action`, `Status`.
  Cadangan: email dari MAILER-DAEMON/postmaster tanpa laporan baku dicari `Message-ID` keluar di isinya.
  Cocok dengan `email_outbound.message_id_header` organisasi + channel itu dan `Action: failed` (5.x.x)
  → `bounces[]` ditambah, `bounced_at`, webhook `email.bounced`; semua penerima memantul → status
  `bounced`. `Action: delayed` diabaikan. Email bounce tetap tidak masuk Inbox (perilaku lama). DSN
  palsu hanya bisa memengaruhi email yang `Message-ID`-nya diketahui (bagian acak 128 bit).
- **Balasan** (`email.replied`): setelah email masuk disimpan, `In-Reply-To` + `References`-nya dicocokkan
  dengan `email_outbound.message_id_header` (organisasi + channel yang sama). Cocok → `replied_at` (yang
  pertama) dan webhook `email.replied` **per email balasan** (dedup per pesan Inbox). Balasan otomatis
  (`Auto-Submitted`, `Precedence`, dsb.) tetap dilewati pemroses → tidak memicu event.
- Pengirim SMTP `system`: bounce tidak terlacak (`bounceTracking: false`), balasan tetap terlacak
  (`Reply-To` = alamat channel).

## 6. Webhook keluar `email.*`

Event baru di `OUTGOING_WEBHOOK_EVENTS` (format **native** saja; label UI: "Email API terkirim",
"Email API gagal", "Email API memantul", "Email API dibalas"): `email.sent`, `email.failed`,
`email.bounced`, `email.replied`. Outbox `outgoing_events` mendapat kolom `email_outbound_id`
(+ `message_id` untuk balasan), ditulis di transaksi perubahan statusnya, hanya bila ada endpoint aktif
yang melanggan. Tanda tangan, coba ulang, nonaktif otomatis, retensi = KONTRAK-WEBHOOK-KELUAR. Email
`source: test` tidak memicu event. `data` dibangun saat dispatch:

```json
{ "id": "<uuid kejadian>", "event": "email.bounced", "created_at": "2026-11-25T02:07:10.000Z",
  "data": {
    "email": { "id": "5a0c…", "status": "bounced", "api_key": { "id": "…", "name": "Aplikasi billing" },
      "sender": { "id": "chn_6b1f…", "kind": "channel", "address": "billing@perusahaan.example" },
      "to": [{ "email": "budi.santoso@contoh.example", "name": "Budi Santoso" }], "cc": [], "bcc_count": 1,
      "subject": "Tagihan November 2026 — PLG-00873",
      "template": { "id": "1e7d…", "slug": "tagihan-bulanan", "version": 3 },
      "idempotency_key": "INV-2611-0873", "metadata": { "invoice_id": "INV-2611-0873" },
      "conversation_id": "c81e…", "message_id": "9d2f…", "message_id_header": "<a1b2c3…@perusahaan.example>",
      "created_at": "…", "sent_at": "…", "failure": null, "rejected_recipients": [] },
    "bounce": { "recipients": [{ "recipient": "budi.santoso@contoh.example", "status": "5.1.1" }] } } }
```

- `email.sent`: `data.email` saja. `email.failed`: `data.email.failure { reason, message, smtp_code }`.
- `email.replied`: `data.email` + `data.reply { message_id (pesan Inbox), conversation_id, from,
  received_at, sender_verification: pass|fail|unverified }`. **Isi balasan tidak dikirim** di event ini —
  ambil lewat `GET /public/conversations/:id/messages` (`messages:read`) atau pakai `message.received`.
  Selain `pass` = pengirim tidak tepercaya (aturan bot KONTRAK-WEBHOOK-KELUAR).
- Bcc tidak dibocorkan ke webhook (hanya `bcc_count`). Kunci payload snake_case seperti event lain.

## 7. API internal — Pengaturan → Template email

Izin **`templates.manage`** (Owner/Admin/Supervisor; nama izin sama dengan template Meta). Tulis =
CSRF, 60/menit/pengguna. Template punya **draf** (bebas disimpan) dan **versi terbit** (dipakai API).
**Menerbitkan wajib konfirmasi identitas** karena isinya langsung terkirim ke banyak pelanggan tanpa
peninjauan pihak ketiga (beda dengan template Meta).

| Endpoint | Isi |
|---|---|
| `GET /api/v1/settings/email-templates?q=&archived=` | `{ templates: [EmailTemplateSummary] }` |
| `POST /api/v1/settings/email-templates` | `{ name, slug, description?, draft? }` → **201** (draf kosong/berisi). Slug kembar → 409 |
| `GET /api/v1/settings/email-templates/:id` | `{ template }` dengan `draft` dan `published` (isi lengkap) |
| `PATCH /api/v1/settings/email-templates/:id` | `{ name?, description?, slug?, draft? }` — `draft` = `{ subject, html, text?, variables, layout, footerText? }`; menyimpan draf (tanpa konfirmasi). Slug hanya bisa diubah sebelum pernah terbit |
| `POST /api/v1/settings/email-templates/:id/publish` | `{ confirmation }` → draf jadi versi baru (`version` + 1), versi lama `superseded`. Validasi penuh (400 per isian). Isi berubah memuat **tautan/angka ≥ 8 digit baru** (`riskyAdditions` yang sama dengan balasan cepat/pesan otomatis) → kejadian keamanan **`email_template_risky`** (`warning`) + email semua Owner |
| `POST /api/v1/settings/email-templates/:id/archive` · `/unarchive` | Arsip = tidak bisa dipakai API (409 `template_archived`); baris & versi disimpan |
| `GET /api/v1/settings/email-templates/:id/versions` | `{ versions: [{ version, state, subject, createdBy, createdAt, publishedBy, publishedAt }] }` (maks. 50 terbaru) |
| `GET /api/v1/settings/email-templates/:id/versions/:version` | Isi lengkap versi itu |
| `POST /api/v1/settings/email-templates/:id/versions/:version/restore` | Salin versi itu ke draf (belum terbit) |
| `POST /api/v1/settings/email-templates/preview` | `{ subject, html, text?, layout, footerText?, variables?, sampleQris? }` → `{ subject, html, text, warnings[] }` — `html` = dokumen lengkap (logo & QRIS contoh sebagai `data:` URI), ditampilkan web di `<iframe sandbox srcdoc>` lebar 600 & 390 px, terang & gelap (`color-scheme` iframe; pratinjau gelap adalah perkiraan — tiap aplikasi email berbeda). Variabel tanpa nilai memakai `example` |
| `POST /api/v1/settings/email-templates/:id/test` | `{ senderId, which: "draft"\|"published", variables? }` → **202** `{ email }`. Penerima **selalu alamat akun pengguna itu sendiri** (tidak bisa diisi). 10/10 menit/pengguna. Subjek diberi awalan `[Tes] ` |
| `GET /api/v1/settings/email-templates/presets` | 6 preset ISP |
| `POST /api/v1/settings/email-templates/presets/:presetKey` | `{ name?, slug? }` → template baru berisi draf preset (`presetKey` dicatat) — tetap harus diterbitkan |

Validasi simpan draf/terbit: subjek 1–200 (variabel boleh), HTML lolos `sanitizeOutboundEmailHtml`
(yang dibuang dilaporkan sebagai `warnings`, saat terbit → 400 bila ada skrip/elemen terlarang supaya
editor tidak diam-diam kehilangan isi), `variables` = variabel yang dipakai di subjek/HTML/teks persis
(tidak boleh ada yang dideklarasikan tapi tidak dipakai, atau sebaliknya), tiap variabel
`{ name, label ≤ 60, required, example ≤ 200 }`, ≤ 30 variabel, nama bawaan tidak boleh
dideklarasikan, variabel di atribut selain `href` → 400, `footerText` ≤ 500. Slug
`^[a-z0-9]+(-[a-z0-9]+)*$` 2–64, tidak boleh berbentuk UUID, unik per organisasi (termasuk arsip).
Maks. 200 template per organisasi.

`EmailTemplate`: `{ id, slug, name, description, presetKey, archived, publishedVersion, lastUsedAt,
draft: TemplateContent | null, published: TemplateContent & { version, publishedAt, publishedBy } | null,
createdAt, updatedAt }`.

**Preset ISP** (generik white-label — tanpa nama perusahaan, URL, nomor; teks Indonesia santai-sopan;
`layout: brand`):

| `presetKey` / slug | Subjek | Variabel (✱ wajib) |
|---|---|---|
| `tagihan-bulanan` | Tagihan {{periode}} — {{id_pelanggan}} | nama✱, id_pelanggan✱, periode✱, total✱, jatuh_tempo✱, bank_va, kode_va, tautan_bayar + slot `{{qris}}` |
| `pengingat-jatuh-tempo` | Pengingat: tagihan {{id_pelanggan}} jatuh tempo {{jatuh_tempo}} | nama✱, id_pelanggan✱, total✱, jatuh_tempo✱, bank_va, kode_va, tautan_bayar + `{{qris}}` |
| `kode-va` | Nomor virtual account untuk pembayaranmu | nama✱, id_pelanggan✱, bank_va✱, kode_va✱, total✱, berlaku_sampai |
| `pembayaran-diterima` | Pembayaran {{periode}} sudah kami terima | nama✱, id_pelanggan✱, periode✱, total✱, tanggal_bayar✱, metode_bayar, nomor_transaksi |
| `layanan-diisolir` | Layanan internet {{id_pelanggan}} dihentikan sementara | nama✱, id_pelanggan✱, total✱, tautan_bayar, kontak_cs + `{{qris}}` |
| `layanan-aktif-kembali` | Layanan internet {{id_pelanggan}} aktif kembali | nama✱, id_pelanggan✱, paket |

Semua preset lolos validasi terbit (dites). Audit (tanpa isi HTML/subjek; metadata `templateId`,
`slug`, `version`, `changedFields`, `risky`): `email_template.created`, `.draft_saved` (paling sering
sekali per 10 menit per template per pengguna), `.published`, `.archived`, `.unarchived`, `.restored`,
`.test_sent`.

## 8. API internal — pengirim, batas, riwayat

### 8.1 Batas & jeda per pengirim — Pengaturan → Batas kirim → "Email per pengirim"

| Endpoint | Izin | Isi |
|---|---|---|
| `GET /api/v1/settings/email-senders` | `sending.limits.manage` | `{ senders: [{ id, kind, name, address, smtpMode, hourlyLimit, sentLastHour, queued, state, throttledUntil, blockedReason, pausedBy, pausedAt }] }` |
| `PUT /api/v1/settings/email-senders/:senderId` | `sending.limits.manage` | `{ hourlyLimit (1–5.000), confirmation? }` — **menaikkan** wajib konfirmasi, menurunkan tidak. Audit `settings.email_sender_limit.updated` `{ previous, next }` + email semua Owner bila dinaikkan oleh Admin |
| `POST …/:senderId/pause` | `sending.limits.manage` | `{ reason? ≤ 200 }` tanpa konfirmasi (arah aman). Email menunggu |
| `POST …/:senderId/resume` | `sending.resume` | `{ confirmation }` — juga melepas `blocked` (dicoba lagi; masih gagal → `blocked` lagi) dan `throttled` |

`blockedReason`: `smtp_auth_failed`, `credentials_unavailable`, `smtp_config_invalid`. Pesan Indonesia di
UI menautkan ke Pengaturan → Channel → [channel].

### 8.2 Alias channel

Tidak ada kolom/rute baru: alias yang boleh dipakai sebagai "Dari" diturunkan dari `aliases` channel
Email tahap 9.0 (`channels.email_aliases`) — yang berdomain sama dengan `emailAddress` dan hanya bila
SMTP `custom`. `GET /public/email/senders` menampilkan hasil saringan itu di `aliases`. Karena 9.0
mengubah alias TANPA konfirmasi identitas, saringan domain-sama inilah pagarnya; `channel.updated` (9.0)
tetap mencatat perubahan alias.

### 8.3 Riwayat kirim API — Pengaturan → API key → tab "Email terkirim"

`GET /api/v1/settings/email-outbound?apiKeyId=&senderId=&status=&from=&to=&cursor=&limit=` (`api_keys.manage`)
→ `{ emails: [{ id, status, source, apiKey { id, name } | null, sender, recipients (TERSAMAR), recipientCount,
subject, template, metadata, createdAt, sentAt, failure }], nextCursor }`. Penerima tersamar:
`bu***@co***.example` (2 huruf pertama bagian lokal + `***` @ 2 huruf pertama label domain + `***` +
akhiran). Isi HTML/teks & lampiran tidak pernah ditampilkan di sini.

## 9. Skema data (migrasi 9.1)

Semua tabel punya `organization_id` (FK `organizations`, `restrict`), FK komposit
`(organization_id, <id>)` ke tabel induk (pola yang ada), `created_at`/`updated_at`.

**`email_templates`** — `id`, `slug`, `name` (1–80), `description` (≤ 200), `preset_key`,
`published_version` (int, null), `draft_version_id` (null), `archived_at`, `last_used_at`,
`created_by_user_id`, `updated_by_user_id`. Unik `(organization_id, slug)`. Indeks
`(organization_id, archived_at, name)`.

**`email_template_versions`** — `id`, `template_id` (FK komposit, `cascade`), `version` (int ≥ 1; draf =
`0`), `state` (`draft`·`published`·`superseded`), `subject`, `html` (≤ 512 KB), `text` (≤ 256 KB, null),
`variables` jsonb (≤ 30), `layout` (`brand`·`none`), `footer_text`, `created_by_user_id`,
`published_by_user_id`, `published_at`. Unik `(template_id, version)`; unik sebagian satu `draft` per
template. Versi `superseded` lebih dari 50 terakhir dipangkas KECUALI dirujuk `email_outbound`.

**`email_outbound`** — `id`, `source` (`api`·`test`), `api_key_id` (null untuk tes), `created_by_user_id`
(tes), `sender_kind` (`channel`·`account`), `channel_id`, `mail_account_id` (9B+, CHECK tepat satu
sesuai `sender_kind`), `from_address`, `from_name`, `reply_to`, `to`/`cc`/`bcc` jsonb
(`[{ email, name }]`), `recipient_count` (1–50), `subject`, `html` & `text` (null setelah dipangkas),
`sanitized` bool, `template_id`, `template_version_id` (FK `set null`), `idempotency_key` (≤ 100),
`request_hash` (64 hex), `metadata` jsonb (≤ 2 KB, CHECK), `conversation_id`, `message_id` (pesan Inbox),
`contact_id`, `reply_to_message_id` (pesan Inbox yang dibalas, §3.12), `message_id_header`,
`status` (CHECK 7 nilai §3.10), `scheduled_at`, `next_attempt_at`, `attempts`, `sending_started_at`,
`sent_at`, `failed_at`, `failure_reason`, `smtp_code` (int), `rejected_recipients` jsonb, `bounces` jsonb,
`bounced_at`, `replied_at`, `canceled_at`, `body_purged_at`.
Indeks: unik sebagian `(organization_id, api_key_id, idempotency_key)` bila keduanya terisi; unik
`(organization_id, message_id_header)`; `(status, next_attempt_at)` sebagian `status in ('queued',
'scheduled')`; `(organization_id, channel_id, sent_at)` (batas per jam); `(organization_id, api_key_id,
created_at)` (batas harian key); `(organization_id, created_at desc, id desc)` (riwayat).

**`email_outbound_attachments`** — `id`, `email_outbound_id` (FK komposit, `cascade`), `position`,
`filename`, `content_type` (hasil deteksi), `size_bytes`, `sha256`, `storage_key` (null setelah
dipangkas), `source` (`base64`·`media`·`url`·`qris`·`logo`), `source_host` (host URL saja, tanpa
path/query), `inline` bool, `content_id`. CHECK ukuran ≤ 20 MB.

**`email_sender_settings`** — `id`, `sender_kind`, `channel_id` (unik), `mail_account_id` (unik),
`hourly_limit` (bawaan 100, CHECK 1–5.000), `state` (`ok`·`throttled`·`paused`·`blocked`),
`throttled_until`, `throttle_streak`, `blocked_reason`, `blocked_at`, `paused_by_user_id`, `paused_at`,
`pause_reason`, `updated_by_user_id`. Dibuat malas saat pertama dipakai (tanpa baris = `ok`, 100/jam).

**`api_key_email_senders`** — `api_key_id` (FK komposit, `cascade`), `sender_kind`, `channel_id`
(`cascade`), `mail_account_id` (`cascade`). Unik `(api_key_id, channel_id)` dan `(api_key_id,
mail_account_id)`; CHECK tepat satu.

Kolom tambahan: `api_keys.email_attachment_hosts text[]` (≤ 20); `outgoing_events.email_outbound_id`
(FK komposit, `cascade`);
`media_files` untuk unggahan `POST /public/email/media` memakai kolom yang ada.

## 10. Model galat

Amplop tetap `{ error: { code, message, details?, requestId } }`. **Tambahan kompatibel**:
`details[].reason` (string opsional, stabil, untuk mesin) di `errorDetailSchema`. Klien lama mengabaikan.

| HTTP | `code` | `reason` (di `details[]`) | Pesan (contoh) |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | `recipient_invalid` | "Alamat email ini tidak valid: periksa penulisan di Cc ke-3." |
| 400 | `VALIDATION_ERROR` | `too_many_recipients` | "Penerima maksimal 50 alamat (Kepada + Cc + Bcc). Untuk kirim massal, pakai Broadcast." |
| 400 | `VALIDATION_ERROR` | `content_missing` · `content_conflict` | "Isi email kosong. Kirim templateId, atau subject beserta html/text." · "Pilih satu: templateId ATAU subject/html/text, jangan keduanya." |
| 400 | `VALIDATION_ERROR` | `subject_invalid` | "Subjek wajib diisi (maks. 200 karakter, satu baris)." |
| 400 | `VALIDATION_ERROR` | `template_variable_missing` | "Variabel {{jatuh_tempo}} wajib diisi untuk template ini." |
| 400 | `VALIDATION_ERROR` | `template_variable_invalid` | "Nilai {{tautan_bayar}} harus alamat https:// yang lengkap." |
| 400 | `VALIDATION_ERROR` | `qris_invalid_format` · `qris_crc_mismatch` | "Teks QRIS tidak sesuai format standar." · "Kode cek (CRC) QRIS tidak cocok — teksnya rusak atau terpotong. Ambil ulang dari sistem pembayaran." |
| 400 | `VALIDATION_ERROR` | `cid_missing` | "HTML merujuk gambar cid:qris, tetapi gambarnya tidak dikirim." |
| 400 | `VALIDATION_ERROR` | `attachment_source_invalid` · `attachment_media_not_found` | "Setiap lampiran butuh tepat satu sumber: contentBase64, mediaId, atau url." · "Lampiran mediaId tidak ditemukan atau sudah kedaluwarsa." |
| 400 | `VALIDATION_ERROR` | `attachments_too_many` · `attachment_too_large` | "Lampiran maksimal 10 berkas." · "Total lampiran maksimal 20 MB." |
| 400 | `VALIDATION_ERROR` | `attachment_type_blocked` | "Jenis berkas ini tidak boleh dilampirkan (program, makro, HTML, atau arsip)." |
| 400 | `VALIDATION_ERROR` | `attachment_fetch_failed` | "Lampiran dari URL tidak bisa diambil: server menjawab 404." |
| 400 | `VALIDATION_ERROR` | `reply_to_not_allowed` · `from_address_not_allowed` | "Alamat balas-ke harus memakai domain pengirim." · "Alamat Dari ini bukan alamat atau alias pengirim." |
| 400 | `VALIDATION_ERROR` | `conversation_requires_channel` · `conversation_requires_single_recipient` | "Mencatat ke Inbox hanya bisa untuk pengirim Channel Email." · "Mencatat ke Inbox butuh tepat satu alamat di Kepada." |
| 400 | `VALIDATION_ERROR` | `cc_not_in_thread` | "Cc balasan hanya boleh alamat yang sudah ada di utas ini." |
| 400 | `VALIDATION_ERROR` | `metadata_invalid` · `scheduled_at_invalid` · `idempotency_key_invalid` | … |
| 401 | `UNAUTHENTICATED` | — | (sama dengan API publik) |
| 403 | `FORBIDDEN` | `scope_missing` · `ip_not_allowed` · `sender_not_allowed` · `attachment_host_not_allowed` | "API key ini tidak boleh mengirim lewat pengirim ini." · "Host lampiran ini tidak ada di daftar host yang diizinkan untuk API key ini." |
| 404 | `NOT_FOUND` | `template_not_found` · `email_not_found` · `message_not_found` | "Template email tidak ditemukan." |
| 409 | `CONFLICT` | `idempotency_key_reused` | "Idempotency-Key ini sudah dipakai untuk email lain dengan isi berbeda. Pakai kunci baru." |
| 409 | `CONFLICT` | `template_not_published` · `template_archived` | "Template ini belum pernah diterbitkan." · "Template ini diarsipkan." |
| 409 | `CONFLICT` | `sender_disabled` · `not_cancelable` · `sender_verification_failed` | "Channel pengirim sedang nonaktif." · "Email ini sudah dikirim, jadi tidak bisa dibatalkan." |
| 413 | `PAYLOAD_TOO_LARGE` | — | "Ukuran permintaan maksimal 28 MB." |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | — | |
| 423 | `SENDING_PAUSED` | — | (pesan rem darurat yang ada) |
| 429 | `RATE_LIMITED` | `daily_limit` · `sender_queue_full` · `rate` | "Batas harian API key ini (500) sudah tercapai." · "Antrean pengirim ini penuh. Tunggu, atau minta Owner/Admin menaikkan batas per jam." + `Retry-After` |
| 503 | `SERVICE_UNAVAILABLE` | `master_key_missing` | "Penyimpanan rahasia server belum siap." |

Pesan di atas mengikuti DESIGN §4 ("kamu", tanpa nama produk). Pesan galat server SMTP/HTTP pihak
ketiga tidak pernah diteruskan.

## 11. Audit, log, retensi

- **Catatan kirim** = baris `email_outbound` (key, pengirim, penerima, subjek, template + versi,
  metadata, status). Bukan baris `audit_logs` per email (bisa ribuan per hari); audit untuk
  perubahan konfigurasi dan kejadian batas: `api_key.updated`, `email_template.*`,
  `settings.email_sender_limit.updated`, `settings.email_sender.paused/resumed`,
  `sending.limit_reached` (target `api_key`). Kejadian keamanan:
  `api_key_changed`, `email_template_risky`, `email_sender_blocked`.
- **Log aplikasi** (pino): ID email, ID key, ID pengirim, jumlah penerima + penerima pertama TERSAMAR,
  status, `smtpCode`, durasi. TIDAK PERNAH: subjek, isi, variabel, metadata, payload QRIS, isi/nama
  lampiran, URL lampiran utuh (hanya host), header `Authorization`.
- **Retensi**: `html`, `text`, dan berkas lampiran dihapus 30 hari setelah status final (`body_purged_at`;
  lampiran `media_files` mengikuti retensi media organisasi, minimal sampai terkirim); baris dihapus
  setelah 180 hari (idempotensi ikut berakhir). Hapus kontak (UU PDP): email `conversation: create` ke
  kontak itu dipangkas isinya + penerimanya disamarkan; kejadian outbox ikut dibuang.
- Isi email luar dianggap data tak tepercaya: tampil di Inbox hanya lewat sanitasi masuk + iframe
  sandbox.

## 12. Contoh untuk tes kontrak (data fiktif)

**A. Kirim dengan template + QRIS + invoice URL + catat ke Inbox**

```http
POST /api/v1/public/email/send
Authorization: Bearer blsn_live_0123456789abcdef_<rahasia>
Content-Type: application/json
Idempotency-Key: INV-2611-0873
```
```json
{ "senderId": "chn_6b1f2c3d-0000-4000-8000-000000000001",
  "to": [{ "email": "budi.santoso@contoh.example", "name": "Budi Santoso" }],
  "bcc": [{ "email": "arsip@perusahaan.example" }],
  "templateId": "tagihan-bulanan",
  "variables": { "nama": "Budi", "id_pelanggan": "PLG-00873", "periode": "November 2026",
                 "total": "Rp185.000", "bank_va": "BRI", "kode_va": "8808 0000 0000 0001",
                 "jatuh_tempo": "25 Nov 2026" },
  "qris": { "payload": "00020101021226680016ID.CO.CONTOH.WWW01189360000000000000010215ID10200000000010303UMI52044899530336054061850005802ID5911TOKO CONTOH6007JAKARTA61051234563045195" },
  "attachments": [{ "filename": "Invoice-INV-2611-0873.pdf",
                    "url": "https://billing.perusahaan.example/invoice/INV-2611-0873.pdf" }],
  "conversation": "create",
  "metadata": { "invoice_id": "INV-2611-0873" } }
```
→ **202** `{ "id": "<uuid>", "status": "queued", "senderId": "chn_6b1f…0001", "recipientCount": 2,
"scheduledAt": null, "conversationId": "<uuid>", "messageId": "<uuid>" }`. CRC payload di atas
**valid** (`5195`).

**B. Ulangan persis** → **200** dengan `id` yang sama dan `status` terkini.
**C. Kunci sama, `total` diubah** → **409** `{ "error": { "code": "CONFLICT", "message": "Idempotency-Key ini
sudah dipakai untuk email lain dengan isi berbeda. Pakai kunci baru.", "details": [{ "location":
"headers", "field": "Idempotency-Key", "message": "…", "reason": "idempotency_key_reused" }], "requestId":
"…" } }`.
**D. CRC rusak** (ubah `5195` → `5196`) → **400** `VALIDATION_ERROR`, `details[0]` =
`{ "location": "body", "field": "qris.payload", "reason": "qris_crc_mismatch", "message": "Kode cek (CRC) QRIS
tidak cocok — …" }`; tidak ada baris dibuat (cek tabel `email_outbound` & `contacts` tetap).
**E. Host lampiran di luar allowlist** (`https://unduh.lain.example/x.pdf`) → **403** `FORBIDDEN`
`attachment_host_not_allowed`; tidak ada permintaan HTTP keluar.
**F. Bentuk luar + gambar inline**:
```json
{ "senderId": "chn_…0001", "to": [{ "email": "sari@contoh.example" }],
  "subject": "Bukti pembayaran PLG-00412",
  "html": "<p>Halo Sari,</p><p>Terima kasih, pembayaranmu sudah kami terima.</p><img src=\"cid:stempel\" alt=\"Lunas\"><script>alert(1)</script>",
  "attachments": [{ "filename": "stempel.png", "contentBase64": "iVBORw0KGgo…", "inline": true, "cid": "stempel" }] }
```
→ 202; status berikutnya `sanitized: true` (skrip dibuang); versi teks dibuat otomatis.
**G. Webhook `email.replied`**: `data.reply = { "message_id": "<uuid>", "conversation_id": "<uuid>",
"from": "budi.santoso@contoh.example", "received_at": "…", "sender_verification": "pass" }`.
**H. Balas email masuk**: `POST /public/email/messages/<id pesan masuk>/reply` `{ "templateId":
"pembayaran-diterima", "variables": { … } }` → 202; header `In-Reply-To` = `Message-ID` email masuk.

## 13. Keputusan (untuk dipindah ke `DECISIONS.md`)

1. **ID pengirim berawalan jenis** (`chn_`/`acc_`) — satu isian `senderId` untuk dua jenis pengirim;
   akun pribadi tidak pernah jadi pengirim API.
2. **`email:send` sudah termasuk memulai percakapan** dan mencakup `email:read`; tidak butuh
   `messages:initiate`. Rute email tidak memberi akses ke rute percakapan/WhatsApp. Daftar pengirim &
   template cukup `email:read` (PRD menulis `email:send`; key `email:send` tetap bisa karena tingkatan) —
   supaya key pemantau status tidak perlu hak kirim.
3. **Pengirim wajib dipilih per key** (tanpa "semua pengirim"); allowlist host URL lampiran per key,
   kosong = URL ditolak. `PATCH /settings/api-keys/:id` baru, selalu dengan konfirmasi identitas.
4. **Batas harian key dijumlah PER PENERIMA** dari pesan + email (1 email = jumlah penerimanya; review
   9.1 S2 mengganti "1 email = 1"); batas per pengirim per jam juga per penerima; rem otomatis
   organisasi ikut menghitung penerima email API. Batas organisasi harian WhatsApp TIDAK menghitung
   email. Rem darurat berlaku.
5. **Penerimaan selalu antre** (202) walau pengirim sedang dibatasi/dijeda/terblokir; yang ditolak saat
   menerima hanya rem darurat, batas harian key, dan antrean penuh (> 24 × batas per jam). Tertahan
   > 24 jam → gagal final.
6. **Worker memolling tabel `email_outbound`** (pola outbox `webhooks-out`), bukan antrian BullMQ dari
   api — email tidak hilang bila Redis/worker mati.
7. **Lampiran URL diambil saat diterima** (di api, sinkron, tenggat 45 dtk) supaya galat langsung
   terlihat n8n dan coba ulang tidak mengambil ulang; setiap redirect dicek ulang allowlist + SSRF.
   Arsip (zip/rar/7z) ditolak di v1.
8. **QRIS dirender di api** dengan `qrcode-generator` 2.0.4 (sudah dipakai web, lolos `check:deps`) +
   `sharp` (sudah di api) — tanpa dependensi baru. CRC-16/CCITT-FALSE + struktur TLV wajib lolos.
9. **Dua profil sanitasi HTML**: keluar (boleh gaya inline, `<style>`, tabel, gambar `cid:`/https) dan
   masuk Fase 6 (ketat). Salinan di Inbox selalu disanitasi profil masuk.
10. **Template email terpisah dari Balasan cepat** (tabel `email_templates` + versi). Draf bebas,
    **terbit wajib konfirmasi identitas** + deteksi tautan/angka baru (`email_template_risky`). Izin
    `templates.manage`. PRD §4.4 "template di editor tulis memakai Balasan cepat jenis email" (9B)
    tetap berlaku untuk cuplikan composer; 9B boleh menampilkan template email terbit di menu `/`.
11. **Bingkai merek memakai logo Branding organisasi** (PNG inline `cid:logo`), bukan avatar
    channel/akun.
12. **Idempotensi memeriksa isi** (hash body): kunci sama + isi beda = 409 (lebih ketat dari API pesan
    yang ada, karena email tagihan tidak boleh "diam-diam" memakai isi lama).
13. **`conversation: "create"` hanya untuk satu penerima Kepada & pengirim channel**; percakapan baru dari
    key = `resolved` (sama dengan template WhatsApp).
14. **`Reply-To` dibatasi domain pengirim**; nama tampilan tidak boleh memuat alamat. Alias "Dari" =
    alias channel 9.0 (`email_aliases`) yang berdomain sama + SMTP `custom` — tanpa daftar alias kedua.
15. **Bounce dari DSN RFC 3464** di kotak masuk channel; hanya pengirim SMTP `custom` yang terlacak.
    `email.replied` per balasan, tanpa isi.
16. **`details[].reason`** opsional ditambahkan ke amplop galat (kompatibel) — kode mesin yang stabil
    untuk integrator tanpa menambah `ERROR_CODES` baru.
17. Email API diberi `Auto-Submitted: auto-generated` (RFC 3834).
18. Retensi isi 30 hari, baris 180 hari; log tanpa subjek/isi/variabel/metadata/QRIS.

## 14. Pertanyaan terbuka

Tidak ada yang memblokir. Batas bawaan 100 email/jam per pengirim mengikuti PRD; batas sebenarnya
hosting Sky Tech (IDCloudHost) cukup diatur Owner/Admin di Pengaturan → Batas kirim setelah rilis.
