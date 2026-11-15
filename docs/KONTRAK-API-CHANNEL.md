# Kontrak API — Channel WhatsApp Cloud API (Fase 2 butir 1–2)

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

Peran tanpa izin → 403 `FORBIDDEN` (pesan bawaan). Channel organisasi lain, channel terhapus, atau ID
asal → 404 `NOT_FOUND` "Channel tidak ditemukan. Mungkin sudah dihapus."

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

`id, type:'whatsapp', name, enabled, status ('connected'|'failed'|'untested'), phoneNumberId, wabaId,
accessTokenHint ('••••abcd'), appSecretHint, webhookUrl, lastTest {ok, code, message, testedAt} | null,
number WhatsAppNumberSummary | null, warnings [{code, message}], credentialsUpdatedAt, createdAt,
updatedAt`.

- Token System User, App Secret, dan verify token **tidak pernah** ada di objek ini. Tampilkan
  `accessTokenHint`/`appSecretHint` tersamar; isian ganti token di form selalu kosong.
- `status` hanya mencerminkan tes atas kredensial yang tersimpan SEKARANG. Mengganti token, App
  Secret, Phone Number ID, atau WABA ID mengembalikan `status: 'untested'`, `lastTest: null`,
  `number: null` — minta pengguna menekan "Tes koneksi" lagi.
- `enabled: false` = channel dinonaktifkan (tampilkan "Nonaktif" di atas status koneksi).
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
   *Catatan*: penerima webhook (`/webhooks/whatsapp/:channelId`) dibangun di tugas berikutnya; sampai
   itu ada, tombol "Verifikasi" di Meta akan gagal.
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
