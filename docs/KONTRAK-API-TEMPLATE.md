# Kontrak — Template pesan Meta (Fase 4)

Template WhatsApp milik WABA, dikelola lewat channel. Skema Zod: `packages/shared/src/templates.ts`
(isi, validasi, pemetaan ke/dari komponen Meta), `template-presets.ts` (preset industri). Alamat:
`API_ROUTES.templates`, `API_ROUTES.inbox.start`, `API_ROUTES.publicApi.templateMessage`. Kode:
`apps/api/src/modules/templates/`, `packages/core/src/meta/templates.ts` (Graph), `packages/db/src/
templates.ts` (sinkron & status, dipakai api + worker). Tabel `message_templates` (migrasi 0024).

## Izin (PRD §4)

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/templates?channelId=&status=&category=&q=` | `inbox.reply` | Daftar (agen memilih template); `DELETED` disembunyikan kecuali diminta `status` |
| `GET /api/v1/templates/:id` | `inbox.reply` | |
| `POST /api/v1/templates` | `templates.manage` | Draf `{ channelId, name, language (bawaan id), category, content }` → **201**. Nama+bahasa kembar di nomor itu → 409 |
| `PATCH /api/v1/templates/:id` | `templates.manage` | `{ name?, language?, category?, content? }`. Nama/bahasa tetap setelah diajukan; kategori template disetujui tetap; `PENDING`/`PENDING_DELETION`/`DELETED` → 409. Template sudah di Meta → `localChanges: true` (perlu diajukan) |
| `POST /api/v1/templates/:id/submit` | `templates.manage` | Validasi lokal (400 + `details[].field`) → belum di Meta: `POST /{waba}/message_templates`; sudah: `POST /{template-id}` (ubah). → `PENDING` (atau status jawaban Meta) |
| `DELETE /api/v1/templates/:id` | `templates.manage` | Sudah di Meta → `DELETE /{waba}/message_templates?name=&hsm_id=` (hanya bahasa itu; tidak ada di Meta = lanjut); lalu baris dihapus. `{ deleted: true }` |
| `POST /api/v1/templates/sync` | `templates.manage` | `{ channelId? }` (bawaan semua channel WhatsApp aktif) → `{ channels: [{ channelId, ok, error, created, updated, removed }] }`. 6/menit/organisasi |
| `GET /api/v1/templates/presets` | `templates.manage` | Preset industri |
| `POST /api/v1/templates/presets/:presetId` | `templates.manage` | `{ channelId, name?, language? }` → draf `source: preset` |
| `POST /api/v1/conversations/start` | `inbox.initiate` | Mulai percakapan ke nomor (bisa baru) dengan template — lihat "Kirim" |

Tulis = CSRF (hook auth), 60/menit/pengguna. Audit (`targetType: template`, TANPA isi): `template.created/
updated/submitted/deleted`, `template.synced` (jumlah per sinkron).

## Bentuk

`MessageTemplate`: `{ id, channelId, wabaId, metaTemplateId, name, language, category (MARKETING|UTILITY|
AUTHENTICATION), status (DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED|IN_APPEAL|PENDING_DELETION|DELETED|
LIMIT_EXCEEDED|ARCHIVED), rejectedReason, qualityScore (GREEN|YELLOW|RED|UNKNOWN|null), content, source (meta|
balesin|preset), presetKey, localChanges, lastSyncedAt, submittedAt, createdAt, updatedAt }`.

`content` (format Balesin):

```json
{ "parameterFormat": "positional" | "named",
  "header": null | { "format": "TEXT", "text": "≤ 60", "example": "…" } | { "format": "IMAGE" | "VIDEO" | "DOCUMENT" },
  "body": { "text": "≤ 1.024, variabel {{1}} atau {{nama}}", "examples": { "1": "Budi" } },
  "footer": null | { "text": "≤ 60" },
  "buttons": [ { "type": "QUICK_REPLY", "text": "≤ 25" } | { "type": "URL", "text", "url", "example"? }
             | { "type": "PHONE_NUMBER", "text", "phoneNumber": "+62…" } | { "type": "COPY_CODE", "example": "≤ 15" } ],
  "authentication": null | { "addSecurityRecommendation": true, "codeExpirationMinutes": 1–90 | null } }
```

### Validasi lokal (`validateTemplate`, sebelum Meta)

- Nama `^[a-z0-9_]+$` ≤ 512; bahasa `id`, `en_US`, … .
- Bernomor: `{{1}}…{{n}}` berurutan tanpa lompatan; bernama: huruf kecil/angka/`_`, diawali huruf; tidak
  dicampur.
- Isi tidak boleh diawali/diakhiri variabel; dua variabel tidak berdampingan; **contoh nilai wajib** untuk
  setiap variabel (body & judul).
- Judul teks ≤ 1 variabel; catatan kaki tanpa variabel.
- Tombol ≤ 10: URL ≤ 2 (satu `{{1}}` hanya di AKHIR URL + contoh URL lengkap), telepon ≤ 1, salin kode ≤ 1;
  balasan cepat harus berkelompok.
- AUTHENTICATION: hanya pengaturan OTP (body/tombol salin kode dibuat Meta), tanpa judul/footer/tombol
  sendiri.
- Judul gambar/video/dokumen BELUM bisa diajukan dari Balesin (butuh unggahan contoh Meta) → buat di WhatsApp
  Manager lalu sinkron; template seperti itu tetap bisa DIKIRIM.

Galat Meta → Indonesia: subkode terdokumentasi (`2388024` nama+bahasa sudah ada, `2388023` nama sedang
dihapus), parameter tidak valid lainnya → "Meta menolak template ini…" (400), sisanya pesan umum Meta (502/
429/…). Teks mentah Meta tidak pernah dikirim ke klien.

## Status & sinkron

- **Webhook** `message_template_status_update` / `message_template_quality_update` /
  `template_category_update` (dilanggankan di SETUP-META): penerima menyimpan HANYA isian template
  (`StoredOtherEvent.template`: ID, nama, bahasa, event, alasan, kualitas, kategori) → worker
  `applyTemplateUpdate` memperbarui SEMUA baris organisasi dengan WABA + ID Meta itu. `REINSTATED`/
  `UNPAUSED` → `APPROVED`; `FLAGGED` → kualitas `RED`. Field WABA lain tetap `skipped` tanpa isi.
- **Sinkron manual** (endpoint) dan **berkala** (job maintenance `template-sync`, tiap 6 jam, semua channel
  WhatsApp aktif): `GET /{waba}/message_templates` berhalaman (100/halaman, maks. 50 halaman) →
  `upsertSyncedTemplates`: buat/perbarui per (channel, nama, bahasa); yang sudah di Meta tetapi tidak
  ada lagi → `DELETED` (baris disimpan). Isi lokal yang belum diajukan (`localChanges`) tidak ditimpa.
  Gagal satu channel tidak menghentikan channel lain (log: jenis + kode Meta saja).

## Kirim

**Ke percakapan** — `POST /conversations/:id/messages` (web, `inbox.reply` + cakupan) dan
`POST /api/v1/public/conversations/:id/messages` (`messages:send`):

```json
{ "type": "template", "clientMessageId": "…", "templateId": "uuid",
  "parameters": { "header": { "text"?: "…", "mediaId"?: "uuid unggahan" },
                  "body": { "1": "Budi" } | { "nama": "Budi" },
                  "buttons": { "0": "nilai {{1}} URL / kode salin" } } }
```

- **Satu-satunya jenis yang boleh di luar jendela 24 jam** (api & worker). Template harus `APPROVED` dan
  milik WABA channel percakapan (selain itu 409). Setiap variabel wajib; nilai tanpa baris baru/tab/> 4
  spasi berturut-turut (aturan Meta) → 400 `parameters.body.<nama>`. Judul media = unggahan pengirim yang
  sama di channel yang sama, jenisnya cocok. Template OTP: `body.1` = kode (tombol salin kode memakai kode
  yang sama).
- Disimpan `type: template`, `text` = isi body yang sudah diisi, `extras.template` (nilai tervalidasi),
  **`messages.template_id` + `template_category` (kategori saat dikirim — dasar laporan biaya per
  kategori; TITIK KAIT laporan & estimasi biaya broadcast)**. Respons `Message.template`
  `{ templateId, name, language, category }`. Rem darurat, batas harian (pengguna/key/organisasi), batas
  per percakapan tetap berlaku. Worker membangun `template.components` (header/body/tombol).

**Mulai percakapan (nomor bisa baru)** — `POST /api/v1/conversations/start` (`inbox.initiate`):
`{ channelId, phone ("0812…", "62…", "+62…"), clientMessageId, templateId, parameters }` → **202**
`{ message, conversationId }` (diulang dengan `clientMessageId` sama → 200, percakapan sama). Kontak
dibuat bila belum ada; percakapan terbuka dipakai, selain itu dibuat `served` **dipegang pemula**. Batas:
`mulai-percakapan` 200/24 jam per pengguna + batas kirim biasa.

**API v1** — `POST /api/v1/public/messages/template` (`messages:initiate`, scope baru; aplikasi billing/
notifikasi): `{ channelId, phone, templateId | name + language (bawaan id), parameters }` + header
`Idempotency-Key` → **202** `{ message, conversationId }`. Percakapan terbuka dipakai; bila tidak ada,
percakapan terakhir kontak itu, atau dibuat **`resolved`** (pesan sistem — tidak menambah antrian; balasan
pelanggan membuka sesi baru). Batas harian PER KEY berlaku.

Mode kompatibel aplikasi billing (`API-MOBICHAT-MAPPING.md` §4, vendor Qiscus) = butir mode tangkap
(menunggu BUTUH-TOBING #10) dan akan memakai jalur kirim yang sama.

## Preset industri

`TEMPLATE_PRESETS` (kode, generik white-label — tanpa nama perusahaan, URL, atau nomor): ISP — tagihan
jatuh tempo, pembayaran diterima, layanan diisolir, aktif kembali, gangguan jaringan, gangguan pulih, tiket
perbaikan dibuat, jadwal teknisi, pelanggan baru, penawaran upgrade (MARKETING), kode verifikasi
(AUTHENTICATION). Semua lolos `validateTemplate` (dites). Klinik & sekolah menyusul.

## Keamanan (review template 2026-11-20)

- **Kode OTP (AUTHENTICATION, S1)**: `messages.text` selalu `Kode verifikasi: ••••••` — kode tidak pernah
  masuk riwayat, pencarian, pratinjau, ekspor kontak, webhook keluar, MobiChat, atau API baca. Nilainya
  hanya di `extras.template` (`sensitive: true`) sampai worker selesai mencoba kirim (berhasil / gagal
  final / dilewati), lalu dikosongkan; hanya ulangan otomatis (Meta belum memproses) yang menyimpannya.
  Pesan OTP tidak bisa "Kirim ulang" (409, kirim kode baru).
- **Pemeriksaan sebelum membuat apa pun (R1)**: mulai percakapan / API v1 memeriksa idempotensi → template
  & nilai variabel → rem darurat + batas harian (pengguna/key/organisasi) SEBELUM kontak/percakapan dibuat.
  Jatah `mulai-percakapan` dipotong hanya untuk permintaan baru yang lolos (Info 5).
- Nilai variabel: tanpa karakter kontrol (`\p{Cc}`: baris baru, CR, tab, …), U+2028/U+2029, atau > 4 spasi
  berturut-turut (Info 4).
- Nomor lokal `0…` memakai kode negara bawaan `62` (`DEFAULT_COUNTRY_CALLING_CODE`); TITIK KAIT pengaturan
  organisasi untuk white-label (Info 3, butuh migrasi — menyusul).
- Percakapan baru dari API key berstatus `resolved` (tidak terlihat di antrian, Info 2): pemantauannya lewat
  batas harian per key (audit `sending.limit_reached` target `api_key` + banner keamanan) dan aktivitas key
  (`lastUsedAt`); laporan aktivitas per key menyusul bersama laporan.

