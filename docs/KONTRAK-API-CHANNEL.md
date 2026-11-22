# Kontrak API — Channel WhatsApp Cloud API (Fase 2 butir 1–3)

Wizard koneksi WhatsApp (mode manual, teks `SETUP-META.md`), tes koneksi, URL webhook + verify token,
halaman nomor (kualitas, status, batas pesan), dan profil bisnis. **Hanya WhatsApp Cloud API resmi
Meta** (Graph API, host tetap `graph.facebook.com`).

Sumber kebenaran tipe: `packages/shared/src/channels.ts` (skema Zod, kode hasil, pesan, label) dan
`API_ROUTES.channels` di `packages/shared/src/api-routes.ts`. Semua path diawali `/api/v1`. Aturan
umum (cookie sesi, `X-CSRF-Token`, amplop error, 429 + `Retry-After`) sama dengan
`KONTRAK-API-AUTH.md` bagian "Aturan umum".

## Izin

| Siapa | Izin | Boleh |
|---|---|---|
| Semua peran yang melihat inbox (Owner, Admin, Supervisor, CS, Teknisi) | `inbox.view` | `GET /channels` saja: id, jenis, nama, aktif, nomor tampilan. Tanpa ID Meta, petunjuk rahasia, URL webhook. |
| Owner, Admin | `channels.manage` | Semua rute `/settings/channels…`, termasuk melihat verify token. |

Peran tanpa izin → 403 `FORBIDDEN` (pesan bawaan). Channel organisasi lain, channel terhapus, ID
asal, atau ID yang **bukan UUID** → 404 `NOT_FOUND` "Channel tidak ditemukan. Mungkin sudah dihapus."
— jawabannya sama persis (tanpa `details`), jadi format ID tidak pernah dijawab 400. `channelIdParamsSchema`
sengaja hanya `z.string()`; format diperiksa API sebelum query.

## Endpoint

| Metode & path | Request | Respons 2xx |
|---|---|---|
| GET `/channels` | – | `channelSummaryListResponseSchema` `{channels: [{id, type, name, enabled, displayPhoneNumber}]}` |
| GET `/settings/channels` | – | `channelSettingsListResponseSchema` `{channels: WhatsAppChannel[], canStoreSecrets, maxChannels}` |
| POST `/settings/channels` | `createChannelRequestSchema` `{type:'whatsapp', name, phoneNumberId, wabaId, accessToken, appSecret, confirmation?}` (`confirmation` wajib untuk semua peran, Owner juga) | **201** `createChannelResponseSchema` `{channel, webhook}` |
| GET `/settings/channels/:channelId` | – | `channelResponseSchema` `{channel}` |
| PATCH `/settings/channels/:channelId` | `updateChannelRequestSchema` (isian opsional + `confirmation`) | `{channel}` |
| DELETE `/settings/channels/:channelId` | `deleteChannelRequestSchema` `{password, code}` | `{status:'deleted'}` |
| POST `/settings/channels/:channelId/disable` | – | `{channel}` |
| POST `/settings/channels/:channelId/enable` | – | `{channel}` |
| POST `/settings/channels/:channelId/test` | – | `channelTestResultSchema` |
| GET `/settings/channels/:channelId/webhook` | – | `channelWebhookResponseSchema` |
| POST `/settings/channels/:channelId/webhook/verify-token` | – | `channelWebhookResponseSchema` (token baru) |
| GET `/settings/channels/:channelId/business-profile` | – (**wajib header CSRF**, lihat bawah) | `businessProfileResponseSchema` `{profile, fetchedAt}` |
| PUT `/settings/channels/:channelId/business-profile` | `updateBusinessProfileRequestSchema` | `updateBusinessProfileResponseSchema` `{status:'updated', profile \| null, fetchedAt \| null}` |

Susun path ber-`:channelId` dengan `apiPath(API_ROUTES.channels.test, { channelId })`.

### Bentuk `WhatsAppChannel` (`whatsAppChannelSchema`)

`id, type:'whatsapp', name, enabled, disabledAt, status ('connected'|'failed'|'untested'), phoneNumberId, wabaId,
accessTokenHint ('••••abcd'), appSecretHint, webhookUrl, lastTest {ok, code, message, testedAt} | null,
number WhatsAppNumberSummary | null, warnings [{code, message}], credentialsUpdatedAt, createdAt,
updatedAt`.

- Token System User, App Secret, dan verify token **tidak pernah** ada di objek ini. Tampilkan
  `accessTokenHint`/`appSecretHint` tersamar; isian ganti token di form selalu kosong.
- `status` hanya mencerminkan tes atas kredensial yang tersimpan SEKARANG. Mengganti token, App
  Secret, Phone Number ID, atau WABA ID mengembalikan `status: 'untested'`, `lastTest: null`,
  `number: null` — minta pengguna menekan "Tes koneksi" lagi.
- `enabled: false` = channel dinonaktifkan (tampilkan "Nonaktif" di atas status koneksi).
- `disabledAt` (ISO | `null`) = kapan dinonaktifkan, untuk "Dinonaktifkan sejak …". Selalu `null` bila
  `enabled: true`. Diisi saat `POST …/disable` (menonaktifkan lagi tidak menggeser waktunya),
  dikosongkan saat `POST …/enable`. Bisa `null` walau `enabled: false` bila waktunya tidak tercatat —
  tampilkan "Nonaktif" saja. Channel yang sudah nonaktif sebelum migrasi `0011` diisi `updated_at`
  terakhirnya.
- `number` (dari tes berhasil terakhir): `displayPhoneNumber`, `verifiedName`, `qualityRating`,
  `status`, `nameStatus`, `codeVerificationStatus`, `messagingLimit`, `throughputLevel`, `fetchedAt`.
  Nilainya mentah dari Meta — pakai `qualityRatingLabel`, `phoneNumberStatusLabel`,
  `messagingLimitLabel`, `nameStatusLabel` (nilai baru yang belum dikenal tampil apa adanya).
  Kualitas: GREEN = Tinggi, YELLOW = Sedang, RED = Rendah, NA/UNKNOWN = Belum dinilai.
- `warnings` (hanya bila tes terakhir berhasil): `number_not_connected`, `quality_low`,
  `quality_medium`, `display_name_not_approved`, dengan `message` siap tampil.

## Alur wizard (Pengaturan → Channel → WhatsApp → Tambah nomor)

Teks tiap langkah dari `SETUP-META.md`. Server tidak menyimpan langkah wizard — urutan di web.

1. **Buka wizard**: `GET /settings/channels`. Bila `canStoreSecrets: false`, nonaktifkan wizard dengan
   petunjuk "BALESIN_MASTER_KEY belum diisi di .env server". Bila `channels.length >= maxChannels`,
   tombol "Tambah nomor" nonaktif.
2. **Langkah 1–3** (siapkan Meta Business, buat aplikasi, pilih nomor): teks saja.
3. **Langkah 4 — Salin ID**: isian *Nama channel* (2–60 karakter, mis. "CS Utama"), *Phone Number ID*,
   *WhatsApp Business Account ID* (angka; spasi tepi dibuang).
4. **Langkah 5 — Token permanen**: isian *Token System User* (tipe password, tombol tampilkan). Spasi
   tepi/baris baru hasil tempel dibuang server.
5. **Langkah 6 — App Secret**: isian *App Secret* (tipe password). Lalu **simpan**:
   `POST /settings/channels`. Error 400 dipetakan ke isian lewat `details[].field` (`name`,
   `phoneNumberId`, `wabaId`, `accessToken`, `appSecret`).
   - **Semua peran wajib konfirmasi identitas, Owner juga** (review akhir Fase 1 S1) di langkah
     simpan: kirim `confirmation: { password, code }` (password + kode autentikator/kode cadangan
     pelaku), sama seperti ganti kredensial. Tanpa itu → 400 `details[0].field = "confirmation.password"`
     "Masukkan password-mu (dan kode verifikasi dua langkah) untuk menambahkan channel."; salah → 400
     `confirmation.password` / `confirmation.code`; 429 setelah 5 salah.
   - Nama channel (dan semua teks satu baris lain) menolak karakter tak terlihat: kendali C0/C1,
     pemisah baris Unicode, pengubah arah (U+202E, U+2066–U+2069), lebar-nol (U+200B, U+2060), BOM.
     ZWJ untuk emoji tetap boleh. Pesan: "Tidak boleh memuat baris baru atau karakter khusus tak
     terlihat."
6. **Langkah 7 — Pasang webhook**: tampilkan `webhook.callbackUrl` dan `webhook.verifyToken` dari
   respons 201 (atau `GET …/webhook`) masing-masing dengan tombol **Salin**, plus daftar
   `webhook.subscribeFields` (`messages`, `message_template_status_update`, `account_update`) untuk
   dicentang di Meta. Bila `webhook.warning` tidak `null`, tampilkan sebagai peringatan (API_URL bukan
   https publik — Meta akan menolak URL itu). Anjurkan juga mengaktifkan **"Require App Secret
   Proof"** di Aplikasi → Pengaturan → Lanjutan (Balesin selalu mengirim `appsecret_proof`).
   Penerima webhook (`/webhooks/whatsapp/:channelId`) sudah ada — lihat bagian "Penerima webhook".
   Tombol "Verifikasi dan simpan" di Meta berhasil bila verify token ditempel persis dan URL bisa
   dijangkau Meta (https publik).
7. **Langkah 8 — Tes**: tombol **"Tes koneksi"** → `POST …/test`. Tampilkan `message` apa adanya
   (hijau bila `ok`, merah bila tidak), lalu kartu nomor dari `number` dan `warnings`. Hasil gagal tetap
   **200** dengan `ok: false` (bukan error HTTP).
8. **Langkah 9 — Metode pembayaran**: teks saja.

Wizard yang ditutup di tengah setelah langkah 6: channel sudah tersimpan (status "Belum dites");
pengguna melanjutkan dari halaman nomor.

## Tes koneksi (`POST …/test`)

Server memakai kredensial TERSIMPAN (tidak menerima isian form), memanggil:
1. `GET /{phone-number-id}` (nama tampilan, kualitas, status, nama, batas pesan, throughput);
2. `GET /{waba-id}/phone_numbers` (memastikan nomor itu milik WABA yang diisi).

| `code` | Arti (pesan lengkap di `CHANNEL_TEST_MESSAGES`) | Arahkan pengguna ke |
|---|---|---|
| `ok` | Semua cocok | – |
| `token_invalid` | Token salah/dicabut/milik aplikasi lain (Meta 190/0) | Ganti token |
| `token_expired` | Token kedaluwarsa (190 + kedaluwarsa) | Buat token "Tidak pernah", ganti token |
| `app_secret_invalid` | `appsecret_proof` ditolak (App Secret bukan milik aplikasi token) | Ganti App Secret |
| `permission_denied` | Izin token kurang (3, 10, 200–299, 131005) | Aset & izin Pengguna Sistem |
| `phone_number_not_found` | Phone Number ID tidak ada / tidak bisa diakses | Periksa Phone Number ID |
| `waba_not_found` | WABA ID tidak ada / tidak bisa diakses | Periksa WABA ID |
| `phone_number_waba_mismatch` | Nomor bukan milik WABA itu | Salin keduanya dari halaman yang sama |
| `phone_not_registered` | Nomor belum terdaftar di Cloud API (133010, 131045) | WhatsApp Manager |
| `account_restricted` | Akun dibatasi kebijakan (368, 131031, …) | WhatsApp Manager |
| `rate_limited` | Meta membatasi laju (4, 80007, 80008, 130429, …) | Coba lagi nanti |
| `meta_unavailable` | Gangguan sementara Meta (1, 2, 131000, 5xx) — sudah diulang otomatis | Coba lagi nanti |
| `network_error` | Server tidak bisa menghubungi Meta | Admin server: internet keluar |
| `unexpected_response` | Jawaban Meta tak terbaca | Coba lagi / lapor |
| `secret_unavailable` | Kredensial tersimpan tak bisa dibuka (master key berubah) | Masukkan ulang token + App Secret |
| `unknown` | Ditolak tanpa alasan yang dikenali | Coba lagi |

Error HTTP: 404 (channel tidak ada), 429 setelah **10 tes per 5 menit per pengguna** ("Batas tes koneksi
(10 kali per 5 menit) sudah tercapai." — tanpa durasi tunggu; hitung mundur dari `Retry-After`). Hasil yang selesai setelah kredensial diganti di tengah jalan tidak mengubah status.
Satu tes paling lama **±25 detik** (tenggat total semua panggilan Meta-nya); bila Meta terlalu lambat,
hasilnya `network_error`. Tampilkan indikator proses selama itu.

## Ubah channel (`PATCH`)

- Kirim **hanya isian yang berubah**. Token/App Secret yang tidak dikirim tetap memakai yang tersimpan
  (tidak perlu mengisi ulang yang lain).
- **Ganti nama** (`name`): tanpa konfirmasi.
- **Ganti kredensial/ID** (`accessToken`, `appSecret`, `phoneNumberId`, `wabaId` — `CHANNEL_CREDENTIAL_FIELDS`)
  WAJIB `confirmation: { password, code }` (password + kode autentikator/kode cadangan pelaku). Nilai
  yang sama dengan yang tersimpan tidak dihitung sebagai penggantian.
  - Tanpa `confirmation` → 400, `details[0].field = "confirmation.password"`.
  - Password/kode salah → 400 `confirmation.password` / `confirmation.code`; 429 setelah 5 salah
    (ember yang sama dengan halaman Keamanan akun; kode salah ikut mengunci langkah kedua 15 menit).
- 409 `CONFLICT` field `phoneNumberId` bila nomor itu sudah menjadi channel lain.
- 400 "Tidak ada yang diubah" bila body kosong.

## Nonaktifkan / hapus

- `disable` / `enable`: tanpa konfirmasi, tercatat di audit. Idempoten. Keduanya diberitahukan ke Owner
  bila pelakunya selain Owner (lihat "Pemberitahuan ke Owner").
- `DELETE` dengan body `{password, code}` (konfirmasi identitas, error sama dengan di atas tetapi field
  `password`/`code` tanpa awalan). Hapus = kredensial **dimusnahkan** dari database (token, App Secret,
  verify token dikosongkan), channel hilang dari semua daftar. Nomor yang sama boleh ditambahkan lagi.
  Tampilkan dialog konfirmasi yang menjelaskan bahwa webhook di Meta perlu dicabut juga.

## Webhook (`GET …/webhook`, `POST …/webhook/verify-token`)

`{channelId, callbackUrl, verifyToken, verifyTokenRotatedAt, subscribeFields, warning}`.
- Hanya `channels.manage`. Verify token = 43 karakter acak (base64url), dibuat server per channel.
- **Buat ulang** (`POST …/verify-token`): token lama langsung tidak berlaku; tampilkan peringatan
  "Tempel verify token baru di Meta (WhatsApp → Konfigurasi → Webhook → Edit)". Tanpa konfirmasi
  identitas (tidak membuka rahasia baru apa pun selain yang memang ditampilkan ke peran ini).
- 503 bila verify token tersimpan tak bisa dibuka (master key berubah) → arahkan ke "Buat ulang".

## Diagnosis webhook (`GET …/webhook-health`)

`channels.manage`. → `{ health: { status, lastReceivedAt, lastProcessedAt, last24h: { received,
processed, skipped, pending, failed, rejected, expiredPending, signatureFailures }, stalledPending,
lastSignatureFailureAt, checkedAt } }` (`webhookHealthSchema`, `packages/shared/src/webhooks.ts`).
- Hitungan `webhook_events` channel ini 24 jam terakhir (menurut `received_at`): `failed` = gagal
  diproses; `rejected` = stub yang ditolak database (`rejected:*`, review N2); `expiredPending` = macet
  melewati retensi. `stalledPending` = `pending` lebih tua dari 10 menit (worker macet/mati).
- `signatureFailures` / `lastSignatureFailureAt` = POST dengan tanda tangan Meta salah/tidak ada
  (Redis, jendela tetap ±24 jam sejak kegagalan pertama).
- `status`: `attention` (ada gagal/ditolak/tanda tangan gagal/macet), `idle` (tidak ada kejadian 24
  jam — periksa langganan webhook di Meta), selain itu `ok`.
- HANYA angka & waktu: tanpa payload, wamid, nomor, atau IP. Channel terhapus/organisasi lain → 404.

## Profil bisnis (`…/business-profile`)

- **GET** wajib header `X-CSRF-Token` (rute ini memakai jatah batas laju dan memanggil Meta, jadi tidak
  boleh terpicu tautan dari situs lain) — panggil lewat `fetch`, bukan membuka URL.
- `profile`: `{about, address, description, email, websites[], vertical}`; isian kosong = `null`/`[]`.
- **PUT yang mengubah `websites`, `email`, `about` (Info), `address`, atau `description`** (termasuk
  mengosongkannya), oleh peran apa pun — Owner juga — wajib `confirmation: { password, code }` di body
  yang sama (`BUSINESS_PROFILE_CONFIRMED_FIELDS`; review akhir Fase 1 S1 + putaran 2 N1): tanpa itu →
  400 `confirmation.password` "Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengubah
  profil bisnis.", salah → 400 `confirmation.password`/`confirmation.code`, 429 setelah 5 salah. Hanya
  mengubah kategori (`vertical`) tidak butuh konfirmasi. Web: paling sederhana, minta konfirmasi setiap
  kali menyimpan profil bisnis. Profil bisnis tampil ke semua pelanggan, jadi teks/tautan di sana bisa
  dipakai menipu.
- Server membaca profil lama dulu (dicatat di audit), lalu mengirim perubahan, lalu membaca ulang.
  Bila profil lama tidak bisa dibaca → 502 dan tidak ada yang diubah. Satu PUT paling lama ±25 detik.
- **PUT**: kirim hanya isian yang diubah. `""`/`[]` = kosongkan di Meta. Batas (aturan Meta,
  `BUSINESS_PROFILE_LIMITS`): Info (`about`) 1–139 karakter satu baris dan tidak boleh dikosongkan;
  alamat ≤ 256 satu baris; deskripsi ≤ 512 (boleh berbaris); email ≤ 128; website ≤ 2, masing-masing
  ≤ 256 dan diawali `https://`/`http://`; kategori (`vertical`) dari `BUSINESS_VERTICALS`
  (label `BUSINESS_VERTICAL_LABELS`) atau `""`. Emoji boleh (server meng-escape sesuai saran Meta).
- Setelah berhasil, server membaca ulang profil: `profile: null` = perubahan sudah tersimpan di Meta
  tetapi pembacaan ulang gagal (tampilkan "Tersimpan. Muat ulang untuk melihat profil terbaru.").
- **Foto profil belum didukung** (butuh Resumable Upload API + App ID, dan gambar CDN Meta butuh
  penyesuaian CSP/proxy) — tampilkan "Ubah foto profil lewat WhatsApp Manager" untuk sementara.
- Error: 400 per isian; **502 `META_REQUEST_FAILED`** dengan `message` Indonesia yang menjelaskan
  penyebab + solusi (token kedaluwarsa, izin kurang, nomor tidak ditemukan, dsb.; `Retry-After` bila
  Meta membatasi laju); 503 bila kredensial tak bisa dibuka atau (oleh selain Owner) pemberitahuan ke
  Owner tidak bisa diantrekan; 429 setelah **30 permintaan profil per 5 menit per pengguna** ("Batas permintaan profil bisnis
  (30 kali per 5 menit) sudah tercapai.", hitung mundur dari `Retry-After`).

## Pemberitahuan ke Owner & ringkasan keamanan

Bila **Admin** (siapa pun selain Owner) melakukan salah satu perubahan di bawah, **semua Owner aktif**
menerima email (nama produk dari branding; isi: pelaku + perannya, channel, apa yang berubah, waktu,
IP, perangkat — tanpa nilai rahasia apa pun), dan kejadiannya muncul di ringkasan keamanan
(`GET /audit-logs/security-summary`, banner Owner/Admin) sebagai **`channel_changed` (`warning`)**,
atau **`business_profile_changed` (`warning`)** untuk profil bisnis. Perubahan yang sama oleh **Owner**
tidak dikirim lewat email, tetapi sejak review akhir Fase 1 tetap muncul di ringkasan keamanan dengan
`severity: "info"`.

| Perubahan (`change`) | Pemicu |
|---|---|
| `created` | `POST /settings/channels` |
| `credentials_changed` | `PATCH` yang benar-benar mengganti token, App Secret, Phone Number ID, atau WABA ID |
| `verify_token_rotated` | `POST …/webhook/verify-token` |
| `disabled` | `POST …/disable` (yang benar-benar mengubah status) |
| `enabled` | `POST …/enable` (yang benar-benar mengubah status) |
| `deleted` | `DELETE …/:channelId` |
| `business_profile_changed` | `PUT …/business-profile` (isian apa pun). Email memuat nilai lama → baru sebagai teks yang "dijinakkan" (`https[:]//contoh[.]com`), bukan tautan. Kejadian ringkasan keamanan: `business_profile_changed` |

- **Tidak** diberitahukan lewat email: ganti nama saja, tes koneksi, dan perubahan oleh Owner (Owner:
  kejadian `info` di ringkasan keamanan; ganti nama saja dan tes koneksi: hanya audit).
- Profil bisnis: audit + antrean dicatat sebelum perubahan dikirim ke Meta; email baru dikirim ±30 detik
  kemudian, dan dilewati bila Meta menolak perubahan itu (baris audit
  `channel.business_profile_update_failed`). Kejadian di ringkasan keamanan tetap muncul (percobaan
  oleh selain Owner).
- Pemberitahuan diantrekan di dalam transaksi penyimpanan. Bila antrean tidak bisa dipakai, perubahan
  Admin **dibatalkan** → **503 `SERVICE_UNAVAILABLE`** "Perubahan channel belum disimpan karena
  pemberitahuan ke Owner tidak bisa dikirim sekarang. Coba lagi beberapa saat lagi." Tampilkan
  `message` apa adanya; tidak ada yang berubah, pengguna cukup mencoba lagi. Perubahan oleh Owner tidak
  terpengaruh.
- Rincian kejadian di ringkasan keamanan (`details`): `change`, `name`, `phoneNumberId`,
  `actorRole`, dan untuk `credentials_changed` juga `changedFields` (teks JSON nama isian, mis.
  `'["phoneNumberId","accessToken"]'`). `subject` selalu `null`; `actor` = pelakunya. Label:
  `SECURITY_EVENT_LABELS.channel_changed` ("Channel diubah"), label tiap perubahan
  `CHANNEL_CHANGE_LABELS`, label isian `CHANNEL_CREDENTIAL_FIELD_LABELS`. `channel_changed` mencakup
  enam aksi audit (`CHANNEL_CHANGE_AUDIT_ACTIONS` selain profil bisnis), jadi tautan dari banner cukup
  memakai saringan `targetType=channel` + tanggal.
- `business_profile_changed`: `details` = `name`, `phoneNumberId`, `changedFields` (teks JSON, mis.
  `'["websites"]'`, label `BUSINESS_PROFILE_FIELD_LABELS`), `actorRole`. Nilai lama/baru ada di Audit
  log (aksi `channel.business_profile_updated`). Label `SECURITY_EVENT_LABELS.business_profile_changed`
  ("Profil bisnis WhatsApp diubah").
- `counts` di ringkasan keamanan selalu memuat kunci `channel_changed` dan `business_profile_changed`
  (rekaman/mock respons harus ikut memuatnya — skema `counts` lengkap per jenis).

## Audit (tanpa rahasia)

`channel.created`, `channel.updated` (`changedFields`: nama isian saja, mis. `["accessToken"]`),
`channel.disabled`, `channel.enabled`, `channel.deleted`, `channel.tested` (`code`, `metaCode`,
kualitas, status nomor), `channel.webhook_verify_token_rotated`, `channel.business_profile_updated`
(`changedFields`, `previous` dan `next` = nilai lama/baru isian yang diubah sebagai teks — website
dipisah koma, kosong = `""`; data publik), `channel.business_profile_update_failed` (`auditLogId` =
baris perubahan yang ditolak Meta, `kind`, `metaCode`). Target `channel` + ID channel. Saringan Audit
log `targetType=channel`.

Aksi yang bisa diberitahukan ke Owner (lihat bagian sebelumnya) juga memuat `actorRole`,
`ownersNotified` (`true` = pelakunya selain Owner dan Owner diberi tahu), dan `change`. Ganti nama
saja hanya memuat `actorRole`.

## Rahasia & keamanan (ringkas)

- Token, App Secret, verify token: AES-256-GCM (`BALESIN_MASTER_KEY`), AAD = organisasi + kolom + ID
  channel. Respons hanya `••••` + 4 karakter terakhir (token/App Secret). Log/audit tidak pernah memuat
  nilainya, URL berisi query, maupun `appsecret_proof`.
- Klien Graph API terpusat (`@balesin/core` `createMetaGraphClient`): versi dari `META_GRAPH_VERSION`
  (bawaan `v26.0`), token di header `Authorization`, `appsecret_proof` di setiap panggilan, batas waktu
  10 dtk per percobaan, 3 percobaan dengan backoff untuk gangguan sementara, tenggat total per operasi
  (tes koneksi / profil bisnis ±25 dtk), hormati batas laju Meta. Masa dingin batas laju per kredensial
  (hash token) + objek Meta + kelompok operasi (pengelolaan vs pengiriman pesan), paling lama 60 menit.
- Host Meta tidak bisa diubah dari UI. `META_GRAPH_BASE_URL` (server Meta tiruan) hanya diterima di
  development/test dan hanya alamat loopback; production menolak start. Penjaga yang sama ada di klien
  Graph API sendiri (api maupun worker): host selain `graph.facebook.com` ditolak kecuali loopback +
  NODE_ENV development/test.
- Menambah channel dibatasi 20 per organisasi; pembuatan bersamaan diurutkan dengan kunci per
  organisasi (tidak bisa melewati batas).

## Perubahan review keamanan akhir Fase 1 (S1, R3)

- `POST /settings/channels` dan `PUT …/business-profile` yang mengubah `websites`/`email` kini wajib
  `confirmation` untuk **Owner juga** (sebelumnya hanya selain Owner). Error sama: 400
  `confirmation.password` / `confirmation.code`, 429 setelah 5 salah.
- `channel_changed` dan `business_profile_changed` di ringkasan keamanan kini juga mencakup perubahan oleh
  Owner (`severity: "info"`; oleh selain Owner tetap `warning`).
- Semua aksi tulis channel (buat, ubah, nonaktifkan/aktifkan, hapus, buat ulang verify token, profil
  bisnis) memeriksa ulang pelaku di transaksi terakhir: akun dinonaktifkan / sesi dicabut di tengah jalan
  → 401 `UNAUTHENTICATED`; peran tidak lagi memegang `channels.manage` → 403 `FORBIDDEN` "Wewenangmu baru
  saja berubah, jadi perubahan ini tidak disimpan. Muat ulang halaman untuk melihat aksesmu sekarang."
- Putaran 2 (N1): konfirmasi profil bisnis kini juga untuk Info, alamat, dan deskripsi (lihat bagian
  Profil bisnis); hanya kategori yang bebas konfirmasi.

## Penerima webhook (Fase 2 butir 3)

Dipanggil **Meta**, bukan web. Path di luar `/api/v1` (`WEBHOOK_ROUTES.whatsapp` di
`packages/shared/src/api-routes.ts`): `<API_URL>/webhooks/whatsapp/<channelId>` — persis `webhookUrl` /
`webhook.callbackUrl`. **Publik** (tanpa sesi, cookie, CSRF; Meta tidak mengirim `Origin`). Keaslian
dari verify token (GET) dan tanda tangan App Secret (POST) — `:channelId` hanya menunjuk channel mana
yang rahasianya dipakai, bukan autentikasi.

### Jabat tangan — `GET /webhooks/whatsapp/:channelId`

Meta memanggilnya saat pengguna menekan **"Verifikasi dan simpan"** di Meta App Dashboard
(WhatsApp → Konfigurasi → Webhook): `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.

| Kasus | Jawaban |
|---|---|
| `hub.mode = subscribe`, verify token = milik channel (perbandingan waktu-konstan), `hub.challenge` cocok `^[A-Za-z0-9_-]{1,128}$` | **200** `text/plain; charset=utf-8`, isi = `hub.challenge` apa adanya (`nosniff`, `no-store`) |
| Selain itu (token salah, mode lain, challenge berisi karakter lain/terlalu panjang, parameter ganda/hilang) | **403** `FORBIDDEN` "Permintaan webhook ditolak." — tanpa alasan, tanpa memantulkan apa pun |
| Channel tidak ada / ID bukan UUID / channel terhapus | **404** `NOT_FOUND` "Alamat webhook tidak dikenal." |
| Verify token tersimpan tak bisa dibuka (master key kosong/berubah) | **503** — perbaiki master key atau buat ulang verify token |
| Batas laju (lihat bawah) | **429** + `Retry-After` |

Channel **nonaktif** tetap bisa diverifikasi (webhook boleh dipasang sebelum channel diaktifkan).
`HEAD` tidak didukung (404).

### Notifikasi — `POST /webhooks/whatsapp/:channelId`

`Content-Type: application/json` (selain itu **415**), body **≤ 3 MiB** (batas payload Meta 3 MB;
lebih → **413** sebelum diperiksa). Urutan pemeriksaan:

1. **Sebelum body dibaca**: batas laju per IP; channel ada dan tidak terhapus (**404**); sumber ini
   belum terlalu sering ditolak **tanda tangan POST-nya** untuk channel ini (**429**). Jabat tangan GET
   yang gagal tidak pernah menahan POST.
2. **Tanda tangan**: `X-Hub-Signature-256: sha256=<64 heks>` = HMAC-SHA256 atas **body mentah** (byte
   persis kiriman Meta) dengan **App Secret channel**, dibandingkan waktu-konstan. Header tidak ada,
   format lain, header ganda, atau tidak cocok → **403** "Permintaan webhook ditolak." (sama untuk
   semua alasan). Body **tidak** di-`JSON.parse` sebelum tanda tangan lolos. App Secret tak bisa
   dibuka → **503**.
3. `JSON.parse` (kunci `__proto__`/`constructor` dibuang; setiap teks — nilai **dan** kunci objek —
   dibersihkan: `\u0000` dibuang, surrogate tunggal → U+FFFD, karena `jsonb` menolak keduanya) lalu
   dipecah per kejadian dengan skema **toleran** (`@balesin/core` `splitWhatsAppWebhook`): isian baru
   dari Meta dipertahankan, bagian yang rusak dibuang tanpa menggagalkan bagian lain. `timestamp` di
   atas tahun 2100 (`WEBHOOK_MAX_UNIX_SECONDS`) = bagian rusak. Paling banyak **10.000 kejadian** dan
   **50 `phone_number_id` berbeda** per notifikasi; kelebihannya dibuang (`overLimit`, log `warn`).
   Body bertanda tangan sah tetapi bukan JSON / bukan `object: "whatsapp_business_account"` / bersarang
   terlalu dalam → **200**, diabaikan (dicatat `warn`).
4. **Routing per kejadian** — Meta mengirim notifikasi SEMUA nomor milik satu aplikasi ke satu URL:
   - `metadata.phone_number_id` + `entry[].id` (WABA) = channel di URL → channel itu;
   - nomor milik channel **lain di organisasi yang sama** yang WABA-nya cocok **dan App Secret-nya
     sama** (tanda tangan tadi juga sah untuknya) → disimpan untuk channel itu (semua channel saudara
     dimuat dengan **satu** query `inArray`);
   - selain itu (App Secret beda, nomor/WABA tak dikenal, channel organisasi lain) → **dibuang**
     (log `warn` berisi jumlah saja);
   - field tingkat WABA selain `messages` (`message_template_status_update`, `account_update`, …): hanya
     bila `entry[].id` = WABA channel di URL.
5. Kejadian untuk channel **nonaktif** → dibuang (tidak disimpan), tetap **200** supaya Meta berhenti
   mengirim ulang. Kejadian dengan `timestamp` **lebih dari 8 hari** lalu → dibuang (lebih lama dari
   jendela kirim ulang Meta 7 hari; mencegah pemutaran ulang rekaman lama). `timestamp` **lebih dari
   1 jam di masa depan** → dibuang (`future`, log `warn`). Cap waktu payload hanya dipakai untuk dua
   pemeriksaan ini: **jendela 24 jam dan SLA (butir berikutnya) wajib memakai `received_at`** (jam
   server), bukan `occurred_at`.
6. Simpan ke `webhook_events` (idempoten, lihat bawah) → antre job `webhooks:whatsapp-event` berisi
   `{organizationId, eventId}` saja → **200** `{"status":"received"}`. Target < 1 detik.
7. Baris yang **ditolak database karena datanya** (kelas error 22 / CHECK `23514` / Invalid Date)
   → bagian 500 baris itu diulang **per baris**, baris yang tetap gagal dilewati (log `warn`: jumlah +
   kode Postgres, tanpa isi), sisanya tersimpan dan dijawab **200**. Database (koneksi/sementara) atau
   antrean gagal → **503**. Meta mengirim ulang; kejadian yang sudah tersimpan tidak tergandakan dan
   yang masih `pending` diantre ulang.

| Kasus | Jawaban | Disimpan |
|---|---|---|
| Tanda tangan sah, kejadian untuk channel ini/saudaranya | 200 | ya (`pending`; field lain `skipped`) |
| Tanda tangan sah, kiriman ulang (duplikat) | 200 | tidak (yang `pending` diantre ulang) |
| Tanda tangan sah, nomor/WABA bukan milik channel ini | 200 | tidak |
| Tanda tangan sah, channel (tujuan) nonaktif | 200 | tidak |
| Tanda tangan sah, kejadian basi (> 8 hari) / masa depan (> 1 jam) / melewati batas per notifikasi / ditolak database karena datanya | 200 | tidak (bagian lain tetap) |
| Tanpa / salah tanda tangan (channel aktif maupun nonaktif) | 403 | tidak |
| Channel tidak ada / terhapus | 404 (tanpa memeriksa rahasia) | tidak |
| Body > 3 MiB / content-type bukan JSON | 413 / 415 | tidak |
| Batas laju | 429 + `Retry-After` | tidak |
| Rahasia tak bisa dibuka / database / antrean gagal | 503 | (bisa sudah tersimpan `pending`) |

### Idempotensi (`webhook_events`, unik `(channel_id, dedup_key)`)

| Jenis (`kind`) | Sumber | `dedup_key` | Arti |
|---|---|---|---|
| `message` | `value.messages[]` | `m:<wamid>` | pesan masuk unik per (channel, wamid) |
| `status` | `value.statuses[]` | `s:<wamid>:<status>` | unik per (channel, wamid, status): `sent`, `delivered`, `read`, `played`, `failed` (nilai baru tetap disimpan) |
| `error` | `value.errors[]` | `e:` + SHA-256 isi | error tingkat sistem/aplikasi/akun |
| `other` | field selain `messages` | `o:<field>:` + SHA-256 isi | disimpan `skipped`, belum diproses; payload hanya `{ wabaId, valueSha256 }` (S4) |

Kolom: `organization_id`, `channel_id` (channel pemilik nomor, FK komposit ke `channels`), `source`
(`whatsapp`), `kind`, `field`, `dedup_key`, `external_id` (wamid), `payload` (bagian yang sudah
divalidasi — **tanpa** header, tanda tangan, App Secret), `occurred_at` (cap waktu Meta),
`received_at`, `status` (`pending`/`processed`/`failed`/`skipped`), `attempts`, `last_error` (kode
singkat, bukan pesan mentah), `processed_at`, `contact_id` (diisi worker), `payload_purged_at`.
Baris tidak dihapus; **payload** kejadian yang selesai dikosongkan setelah retensi organisasi (bawaan
8 hari) — lihat `docs/KONTRAK-API-INBOX.md` bagian Retensi. Baris yang ditolak database disimpan
sebagai stub tanpa payload (`failed`, `last_error = 'rejected:<kode>'`, review N2).

### Worker (`apps/worker/src/queues/webhooks.ts`)

Job = ID kejadian (ID job `wa-event-<eventId>`, jadi mengantre ulang tidak menggandakan). Worker
mengunci baris (`FOR UPDATE`), memproses hanya yang `pending`, menormalisasi
(`normalizeInboundMessage` / `normalizeStatusUpdate` / `normalizeWebhookFailure` di `@balesin/core`),
meneruskan ke `InboundEventHandlers`, lalu `processed`. Gagal → `attempts`+1, `last_error`, diulang
**8 kali** dengan jeda eksponensial mulai 5 dtk (±10 menit); percobaan terakhir atau payload rusak →
`failed`. Sebelum memproses, channel diperiksa ulang **di transaksi yang sama** (baris channel
`FOR SHARE`): sudah dinonaktifkan/dihapus sejak diterima → `skipped`, `last_error = 'channel_inactive'`,
hasil job `{status: 'skipped', reason: 'channel_inactive'}`, handler tidak dipanggil. Pemroses bawaan
(`createInboundHandlers`) membuat kontak/percakapan/pesan, memperbarui jendela 24 jam (dari
`received_at`), dan status pesan keluar — lihat `docs/KONTRAK-API-INBOX.md`. Unduh media dan
WebSocket menyusul.

### Batas laju & penyalahgunaan

| Ember | Kunci | Batas | Dihitung dari |
|---|---|---|---|
| `webhook-ip` | IP | 3.000 / menit | semua permintaan |
| `webhook-tak-dikenal-ip` | IP | 30 / 10 menit | ID channel yang tidak pernah ada (channel terhapus tidak dihitung); **hanya menahan ID tak dikenal berikutnya**, tidak pernah channel yang ada |
| `webhook-tolak-jabat-tangan-ip` | IP + channel | 20 / 10 menit | jabat tangan GET ditolak; hanya menahan **GET** |
| `webhook-tolak-ip` | IP + channel | 20 / 10 menit | tanda tangan POST ditolak; hanya menahan **POST** |
| `webhook-channel` | channel | 12.000 / menit | notifikasi bertanda tangan sah |

Ember "ditolak" hanya diisi kegagalan, jadi kiriman sah Meta tidak pernah tertahan karena percobaan
palsu dari IP lain. Ember dipisah per metode: siapa pun yang punya aplikasi Meta bisa membuat server
Meta mengirim jabat tangan GET yang gagal ke URL kita (dari IP yang sama dengan notifikasi sah), jadi
kegagalan GET tidak boleh menahan POST. **Wajib**: `TRUST_PROXY` diisi IP reverse proxy (mis. vm-nginx) supaya IP yang
dihitung adalah IP Meta/penyerang, bukan IP proxy — tanpa itu semua kiriman terlihat dari satu IP dan
batas per IP menjadi batas bersama.

**Kejadian keamanan**: **10 tanda tangan salah dalam 10 menit pada satu channel** (semua IP) → audit
`channel.webhook_signature_rejected` (tanpa pelaku; IP = pengirim terakhir; `details`: `channelId`
(untuk tautan banner ke channel; baris lama memakai `target_id`), `name`,
`phoneNumberId`, `failures`, `windowMinutes`, `reason`, `distinctSources` (jumlah IP berbeda dalam
jendela, maks. 256 dihitung), `topSource` (awalan IP terbanyak: IPv4 `/24`, IPv6 `/64` — bukan
alamat lengkap), `topSourceFailures`) dan kejadian **`webhook_signature_failed`
(`warning`)** di `GET /audit-logs/security-summary` — paling banyak sekali per jam per channel. Label
`SECURITY_EVENT_LABELS.webhook_signature_failed` ("Webhook WhatsApp ditolak berulang"). Artinya salah
satu: App Secret di Balesin tidak sama dengan aplikasi Meta (pesan tidak masuk sama sekali — periksa
Pengaturan → Channel), atau ada pihak yang mencoba memalsukan pesan masuk. Jabat tangan yang salah
tidak memicu kejadian ini (biasanya salah tempel). `counts` ringkasan keamanan kini juga memuat kunci
`webhook_signature_failed` (rekaman/mock harus ikut memuatnya). Banyak sumber berbeda (IP Meta) =
kemungkinan besar App Secret salah; satu sumber = kemungkinan orang dalam yang tahu ID channel.

**Penjaga `TRUST_PROXY`**: di production dengan `TRUST_PROXY=false`, permintaan pertama yang datang
dari alamat privat/loopback **dengan** `X-Forwarded-For` menulis log `error` sekali per proses (alamat
proxy saja, isi header tidak dibaca) — tanda Balesin di belakang proxy tetapi IP klien tidak terbaca.

### Log & privasi

Log hanya memuat ID channel, jumlah kejadian (tersimpan/duplikat/dibuang), dan alasan penolakan.
**Tidak pernah**: body mentah, isi pesan, nomor/nama pelanggan, header tanda tangan, verify token
(query string tidak di-log), App Secret. Isi pesan hanya ada di `webhook_events.payload` (data
pribadi, UU PDP).

### Alat uji

`apps/api/src/testing/fake-meta-webhooks.ts` (diekspor ulang dari `testing/fake-meta.ts`):
`textMessageNotification`, `imageMessageNotification`, `unsupportedMessageNotification`,
`mediaMessageNotification(kind)`, `locationMessageNotification`, `reactionMessageNotification`,
`interactiveReplyNotification`, `buttonMessageNotification`,
`statusNotification({wamid, status})`, `errorNotification`, `templateStatusNotification`,
`combinedNotification`, `signedWebhook` (body + header seperti Meta), `deliverWhatsAppWebhook(url, …)`
(HTTP sungguhan ke stack E2E, hanya ke loopback), `handshakeQuery(verifyToken)`. Bentuknya mengikuti
contoh resmi Meta; tidak pernah memanggil Meta.

## Akses per channel (tahap 9.0, semua jenis channel)

PRD-EMAIL §4.10 baris "Akses per channel". Berlaku untuk **semua** channel — WhatsApp, Telegram,
Email, Messenger, Instagram — dengan satu pasang rute yang sama. Sumber tipe:
`packages/shared/src/channel-access.ts`; route `API_ROUTES.channels.access`.

### Model

- Per channel: `mode` **`all`** ("Semua tim", bawaan, = perilaku sebelum tahap 9.0) atau
  **`restricted`** ("Hanya departemen/pengguna tertentu") + daftar departemen + daftar pengguna.
- **Owner/Admin selalu melihat semua channel** (`CHANNEL_ACCESS_EXEMPT_ROLES`); merekalah juga
  pengelolanya (`channels.manage`), jadi tidak ada yang bisa mengunci dirinya sendiri.
- Supervisor/CS/Teknisi berhak atas channel `restricted` bila terdaftar **langsung** ATAU **anggota**
  salah satu departemen yang terdaftar. Keanggotaan departemen dibaca segar (keluar dari departemen =
  akses langsung hilang).
- `restricted` dengan kedua daftar kosong = hanya Owner/Admin (juga hasilnya bila departemen satu-
  satunya dihapus — gagal tertutup).
- Penegakan = **IRISAN** dengan cakupan peran (Teknisi `assigned`) dan "akses hanya departemen
  sendiri": channel boleh + departemen tidak boleh → tetap tersembunyi.
- **Hanya pengguna bersesi.** API key / bot (n8n, lapisan MobiChat, API publik v1) tidak terpengaruh
  (cakupan organisasi seperti sebelumnya).

### Endpoint (`channels.manage`)

| Metode & path | Request | Respons 200 |
|---|---|---|
| GET `/settings/channels/:channelId/access` | – | `channelAccessResponseSchema` |
| PUT `/settings/channels/:channelId/access` | `updateChannelAccessRequestSchema` (CSRF; `confirmation` bila melonggarkan) | `updateChannelAccessResponseSchema` = `{ access, releasedConversations }` |

```jsonc
// PUT body — mengganti SELURUH aturan
{ "mode": "restricted", "departmentIds": ["<uuid>"], "userIds": ["<uuid>"],
  "confirmation": { "password": "…", "code": "123456" } }   // confirmation: hanya bila melonggarkan
// atau
{ "mode": "all", "confirmation": { … } }   // daftar wajib kosong/tidak dikirim (daftar + "all" → 400)

// respons PUT (GET: tanpa releasedConversations)
{
  "releasedConversations": 2,
  "access": {
    "channelId": "<uuid>",
    "mode": "restricted",
    "departments": [{ "id": "<uuid>", "name": "Tagihan", "memberCount": 3 }],
    "users": [{ "id": "<uuid>", "name": "Sinta", "role": "cs", "active": true }],
    "exemptRoles": ["owner", "admin"]
  }
}
```

- Validasi: ID duplikat dibuang (huruf kecil); maks. 50 departemen, 500 pengguna; isian asing → 400.
  Departemen harus milik organisasi; pengguna harus milik organisasi **dan aktif** → selain itu 400
  `VALIDATION_ERROR` (`details[].field` = `departmentIds` / `userIds`). Owner/Admin boleh ada di daftar
  (tidak berpengaruh selama perannya kebal).
- Channel organisasi lain / terhapus / ID bukan UUID → 404 "Channel tidak ditemukan." (seragam).
- Batas laju PUT 30/menit per pengguna. Pelaku diperiksa ulang di transaksi
  (`assertActorStillAuthorized`); baris channel dikunci.
- **Konfirmasi identitas (review 9.0 R3)** — wajib bila perubahan MELONGGARKAN
  (`channelAccessLoosens`): `restricted → all`, atau menambah departemen/pengguna ke channel yang
  SUDAH terbatas. Tanpa/keliru → 400 `VALIDATION_ERROR` (`details[].field` = `confirmation.password` /
  `confirmation.code`, sama dengan konfirmasi lain). Mempersempit (`all → restricted` walau dengan
  daftar, mencabut) tidak perlu. Aturan berubah di antara pemeriksaan dan penyimpanan sehingga kini
  melonggarkan tanpa konfirmasi → 409 "Akses channel ini baru saja diubah…".
- **Percakapan dilepas (review 9.0 R4)** — percakapan `served` channel itu yang pemegangnya kini tanpa
  akses (bukan Owner/Admin) kembali ke antrian (`unserved`, kejadian `unassigned` dengan pelaku =
  pengubah, webhook `conversation.unassigned`, event real-time, push "antrian"). Jumlahnya di
  `releasedConversations` (UI: "N percakapan dikembalikan ke antrian"). Sama halnya saat pengguna
  dikeluarkan dari departemen yang memberinya akses (`PUT /settings/department-access/:userId`).
- Audit `channel.access_updated` (hanya bila ada perubahan): `previousMode`, `mode`,
  `addedDepartments`/`removedDepartments`/`addedUsers`/`removedUsers` (`{id, name}`, maks. 50 per
  daftar), jumlah akhir, `loosened`, `releasedConversations`, `actorRole`. Audit
  `department.access_updated` kini juga memuat `restrictedChannelsGained` (`{id, name}` channel
  terbatas yang terbuka lewat departemen yang baru ditambahkan) dan `releasedConversations`.
- Setelah disimpan: event `access.changed` untuk setiap Supervisor/CS/Teknisi aktif → socket inbox
  mereka menerima `resync` (daftar dimuat ulang tanpa percakapan yang kini terlarang).

### Yang ditegakkan (pengguna tanpa akses)

| Tempat | Perilaku |
|---|---|
| `GET /conversations`, `/conversations/counts`, cari `q`, saringan `channelId` | Percakapan channel itu tidak ikut (hitungan tab juga) |
| Detail, pesan, catatan, log, unduh media, HTML email, tandai pesan, tandai dibaca | 404 seragam "Percakapan/Pesan tidak ditemukan." |
| Kirim, kirim ulang, ambil, tugaskan, kembalikan, selesai, buka lagi, saklar bot, catatan, pindah departemen | 404 seragam (tidak ada perubahan) |
| `GET /channels` (pemilih channel: saringan inbox, "Percakapan baru", kirim template) | Channel itu tidak tercantum |
| `POST /conversations/start` (template) | Dijawab sama dengan channel yang tidak ada |
| Broadcast: buat/ubah/ajukan dengan channel itu | 404 "Nomor WhatsApp pengirim tidak ditemukan." |
| Broadcast: daftar; semua rute `/broadcasts/:broadcastId…` milik channel itu | Tidak tercantum; 404 seragam |
| WebSocket inbox | Event percakapan channel itu tidak dikirim — termasuk `conversation.removed` (hapus kontak, pindah departemen, agen lama) |
| Notifikasi Web Push | Tidak dikirim ke pengguna itu |
| Laporan kinerja, biaya, ekspor CSV (semua jenis), CSAT | Data channel itu tidak dihitung (saringan `channelId` channel terlarang = kosong) |
| Ekspor data kontak (`/contacts/:id/export`) | Percakapan & pesan channel itu tidak ikut; respons `partial: true`, `partialReason` (teks Indonesia), `excludedConversations` (jumlah) + sama di audit `contact.exported` — ekspor UU PDP lengkap = Owner/Admin |
| Tiket (detail, daftar, Kanban) | `conversation: null` + `conversationUnavailable: true` ("Percakapan terkait tidak tersedia") |
| Kontak (Teknisi, cakupan `assigned`) | Penugasan di channel terlarang tidak membuka kontaknya |
| Penugasan `POST …/assign` (sasaran) | 400 "Agen ini tidak punya akses ke channel percakapan ini." (juga lewat API key) |
| `GET /inbox/agents?channelId=` | Hanya agen yang berhak atas channel itu; channel yang tidak boleh dilihat pemanggil → 404 |
| Round-robin | Agen tanpa akses dilewati (percakapan tetap di antrian bila tidak ada yang berhak) |
| Buka lagi | Pemegang lama yang kini tanpa akses → percakapan kembali ke antrian |

Tidak diubah: kontak/CRM tetap lintas channel (kontak terlihat, percakapan channel terlarangnya
tidak); template Meta (`templates.manage`) tidak dibatasi per channel.

Penegakan memakai principal EKSPLISIT (review 9.0 R2): `PermissionGrant.principal` = `'user'` |
`'apiKey'`; `channelAccessSql(org, { kind: 'user', userId } | { kind: 'apiKey' }, channelId)` menolak ID
yang bukan pengguna organisasi itu (gagal tertutup) dan hanya melewati API key yang dinyatakan.
