# Review Keamanan — Fase 2 butir 1–2: Channel WhatsApp Cloud API (backend)

- Tanggal: 2026-11-15 (dikerjakan 14 Nov malam)
- Peninjau: agent `security`
- Cakupan: commit `91ec7c2` (channel, kredensial terenkripsi, klien Graph API, tes koneksi, profil bisnis) dan
  `cfe195e` (pemberitahuan ke Owner). Berkas: `packages/core/src/meta/{graph-client,errors,whatsapp,credentials}.ts`,
  `packages/db/src/schema/channels.ts` + `drizzle/0008_channel_whatsapp_cloud_api.sql`,
  `apps/api/src/modules/channels/**`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/testing/fake-meta.ts`,
  `packages/shared/src/channels.ts`, `apps/worker/src/queues/email.ts` (`sendChannelChanged`), `packages/core/src/mail/templates.ts`
  (`renderChannelChangedEmail`), `apps/api/src/modules/audit/audit.service.ts` (`channel_changed`).
- Acuan: `CLAUDE.md` (aturan keras), `docs/SECURITY.md` §2–4, `docs/PENGATURAN-UI.md` §3, `docs/KONTRAK-API-CHANNEL.md`,
  `docs/DECISIONS.md` (baris Graph API & channel 2026-11-14), review `2026-11-14-fase1-rbac.md`.
- Model ancaman: penyerang memegang satu akun CS yang dibobol, atau sesi Admin curian (cookie, tanpa password/2FA),
  dan ingin memakai nomor WhatsApp perusahaan untuk spam/penipuan atau mencuri token Meta/App Secret.
- Lingkungan uji: Postgres/Redis dev (database sementara per berkas tes, Redis db 15 dengan awalan acak), server Meta
  TIRUAN lokal. Tidak ada panggilan ke graph.facebook.com. Stack E2E (3100/5180, `balesin_e2e`, Redis db 14) tidak disentuh.

## Putusan: AMAN

Saya tidak menemukan temuan Kritis atau Tinggi. Dengan akun **CS** yang dibobol, penyerang hanya bisa `GET /channels`
(nama, jenis, aktif, nomor tampilan). Semua rute lain 403. Dengan **sesi Admin curian**, penyerang tidak bisa membaca
token atau App Secret. Ia juga tidak bisa mengganti token, App Secret, atau ID Meta, dan tidak bisa menghapus channel
tanpa password + kode 2FA. Perubahan yang membelokkan pesan selalu diberitahukan ke Owner. Klien Graph API memakai host
tetap, segmen path tervalidasi, dan `appsecret_proof`. Token tidak pernah masuk URL, log, audit, antrean, maupun email.

Ada satu temuan **Sedang** (S1, profil bisnis) yang sebaiknya ditutup di butir ini atau paling lambat sebelum webhook/inbox
dirilis. Sisanya Rendah/Info.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| S1 | Sedang | Admin (sesi curian) bisa mengganti profil bisnis resmi (website/email/deskripsi) ke tautan penipuan tanpa konfirmasi, tanpa pemberitahuan ke Owner, dan audit tidak menyimpan nilai lama | Sekarang |
| R1 | Rendah | Masa dingin batas laju di memori dikunci hanya oleh ID objek Meta (bukan kredensial/channel), tanpa batas atas, dan berlaku untuk semua operasi | Sebelum worker kirim pesan memakai klien ini |
| R2 | Rendah | Membuat channel baru tidak butuh konfirmasi identitas. Channel dengan App Secret milik penyerang = penyerang bisa memalsukan pesan masuk ke inbox (setelah webhook ada) | Bersama butir webhook |
| R3 | Rendah | `enable` tidak diberitahukan: channel yang sengaja dinonaktifkan Owner bisa diaktifkan lagi diam-diam oleh Admin | Sekarang (kecil) |
| R4 | Rendah | Nama channel (dan teks satu baris lain) menerima karakter pengubah arah / lebar-nol (U+202E, U+200B, U+2066…, C1) yang tampil di email Owner dan inbox | Sekarang (shared, sekali untuk semua isian) |
| R5 | Rendah | Tidak ada tenggat total per permintaan: tes koneksi terburuk ±7 panggilan × (3 × 10 dtk + backoff) ≈ 3–4 menit memegang request | Bersama R1 |
| R6 | Rendah | "Dua lapis penjaga" `META_GRAPH_BASE_URL`: lapis kedua (`app.ts`) lebih lemah dari lapis pertama, dan klien sendiri menerima host http(s) apa pun | Sebelum worker memakai klien |
| Info 1–8 | Info | Lihat bagian C | — |

Tes baru (semua lulus; `it.fails` sudah saya pastikan gagal karena alasan yang dimaksud, yaitu asersi
pemberitahuan/kunci masa dingin, bukan error lain):
- `apps/api/src/modules/channels/security-review-fase2-channel.integration.test.ts`: 5 penjaga + 2 `it.fails` (S1, R3)
- `packages/core/src/meta/security-review-fase2.test.ts`: 2 penjaga + 1 `it.fails` (R1)
- `packages/shared/src/security-review-fase2-channel.test.ts`: 3 penjaga + 1 `it.fails` (R4)

---

## A. Verifikasi klaim backend

| Klaim / hal yang dinilai | Hasil | Bukti |
|---|---|---|
| Hanya Cloud API resmi, host tetap `https://graph.facebook.com` | **Benar.** Tidak ada library WhatsApp tidak resmi. Base URL lain hanya dari config | `graph-client.ts:27,185-206`; `scripts/check-forbidden-deps.mjs` |
| Path dari segmen tervalidasi (SSRF) | **Benar.** Segmen `^[A-Za-z0-9_]{1,64}$`. ID Meta di shared + CHECK DB hanya angka. Kunci query `^[a-z_]+$`, dan `access_token`/`appsecret_proof` ditolak sebagai kunci. Kursor `after` divalidasi, URL `paging.next` tidak diikuti | `graph-client.ts:104-105,226-240`; `whatsapp.ts:131-172`; `channels.ts:60-74`; migrasi 0008 `channels_wa_ids_numeric`. Tes baru: ID berisi `../me`, `123/messages`, `evil.com` ditolak skema |
| Token di header, `appsecret_proof` di setiap panggilan | **Benar.** Proof = HMAC-SHA256(token, App Secret) heks | `graph-client.ts:100-102,255-258,381-385` |
| Redirect ditolak, batas ukuran, timeout | **Benar.** `redirect: 'manual'`, lalu 3xx menjadi `unexpected_response`. `content-length` + hitungan aliran ≤ 1 MiB. `AbortSignal.timeout(10 dtk)` per percobaan | `graph-client.ts:157-175,267-273,329-342` |
| Retry hanya idempoten | **Benar.** GET atau `idempotent: true` (hanya `business_profile.update`, aman diulang). Jaringan putus pada POST lain tidak diulang | `graph-client.ts:386,411`; `whatsapp.ts:249-256` |
| Log tanpa token/URL/proof | **Benar.** Log memuat operasi, status, kode, fbtrace. `metaMessage` mentah ikut di-log, tetapi lewat redaksi logger (`EAA…`, `Bearer …`). Tes baru: pesan Meta "Malformed access token EAA…" tidak bocor ke log | `graph-client.ts:347-359`; `redact.ts:124,130` |
| Error Meta tidak dipantulkan mentah ke klien | **Benar.** `MetaApiError.message` = `META_ERROR_MESSAGES[kind]`. 502 profil bisnis & hasil tes memakai pesan Indonesia tetap | `errors.ts:156`; `channels.service.ts:221-229,651-658` |
| Rahasia AES-GCM, AAD organisasi + kolom + ID channel | **Benar** | `credentials.ts:12-51` |
| Ekor 4 karakter | **Benar** (≥ 12 karakter; 2 karakter untuk 8–11; tidak ada untuk < 8). App Secret 32 heks → 16 bit terbuka, sesuai SECURITY §3 | `crypto.ts:169-174`; `channel-view.ts:75-76` |
| Hapus lunak memusnahkan rahasia | **Benar**, dan dikunci CHECK DB `channels_deleted_without_secrets` | `channels.service.ts:583-592`; migrasi 0008. Catatan sisa di Info 4 |
| Respons tanpa rahasia; verify token hanya lewat rute webhook (`channels.manage`) | **Benar.** `toWhatsAppChannel` tidak membaca kolom terenkripsi. Respons Zod menyaring kunci tak dikenal. `cache-control: no-store` global | `channel-view.ts:62-96`; `http/security.ts:113`. Tes baru: GET daftar/satu channel/ringkasan tidak memuat token, App Secret, verify token. 400 validasi tidak memantulkan token/App Secret |
| `GET /channels` (`inbox.view`) | **Benar.** Hanya `id,type,name,enabled,displayPhoneNumber` | Tes baru (CS): kunci persis 5, tanpa Phone Number ID/WABA ID/URL webhook/petunjuk |
| `channels.manage` = Owner + Admin; IDOR lintas organisasi = 404 | **Benar.** Semua query `organization_id` + `deleted_at is null` | `permissions.ts:155`; `channels.repo.ts:10-11`; tes lama "IDOR" + matriks RBAC |
| `GET business-profile` dengan `requireCsrf` | **Benar.** Tanpa token CSRF, atau `Sec-Fetch-Site: cross-site` → 403, dan Meta tidak dipanggil | `auth.hook.ts:112-123`. Tes baru |
| Konfirmasi ulang untuk ganti kredensial/ID & hapus; PATCH parsial | **Benar, dan tidak bisa dilewati.** Nilai sama tidak dihitung, dan saat itu juga tidak ada yang ditulis (tidak ada audit/kolom yang berubah). Satu isian berbeda di antara nilai-nilai sama tetap 400 `confirmation.password`. Konfirmasi milik Owner tidak berlaku untuk sesi Admin | `channels.service.ts:328-353,458-509`. Tes baru "PATCH parsial" |
| Hasil tes basi tidak menimpa status kredensial baru | **Benar** (`credentialsUpdatedAt` sebagai syarat `UPDATE`) | `channels.repo.ts:88-112` |
| `META_GRAPH_BASE_URL` tidak bisa di production/UI | **Benar untuk jalur nyata.** `loadConfig` menolak start bila diisi di lingkungan production-like (`NODE_ENV` selain development/test), dan di luar itu hanya menerima loopback tanpa path. Tidak ada rute UI. Lapis kedua lebih lemah (R6) | `config.ts:111-126,164-169`; `env.ts:61-64`; `app.ts:270-272` |
| Pemberitahuan Owner: antre di dalam transaksi, 503 bila gagal | **Benar.** Bila transaksi batal setelah antre (jarang: commit gagal), worker tidak menemukan baris audit, mengulang, lalu melewati di percobaan terakhir. Tidak ada email palsu | `channel-change-notice.ts:45-68`; `email.ts` `sendChannelChanged` (cek `isFinalAttempt`). Tes lama "503" + worker "baris audit belum terlihat" |
| Payload antrean hanya ID; isi email dari audit; `changedFields` disaring | **Benar.** `strictObject` 3 UUID. Worker menyaring `changedFields` dengan `channelCredentialFieldSchema`, lalu memeriksa `change` ↔ `action` ↔ `ownersNotified`. Penerima dicek ulang (masih Owner, aktif) | `queues.ts` `channelChangedEmailPayloadSchema`; `email.ts` `sendChannelChanged` |
| Injeksi di subjek/isi email | **Aman.** Nama channel tanpa karakter kendali C0 (shared), `singleLine()` di template, HTML di-escape, subjek dikodekan nodemailer. Sisa: karakter bidi (R4) | `templates.ts:47-60,181,202` |
| Verify token | **Benar.** 32 byte acak → 43 karakter base64url (256 bit), per channel, dienkripsi. Buat ulang langsung mengganti dan diberitahukan. Tes baru: format, unik, berganti saat dibuat ulang | `credentials.ts:74-76`; `channels.service.ts:666-699` |
| Profil bisnis: validasi input ke Meta | **Benar secara teknis.** Panjang sesuai aturan Meta. Website hanya `http(s)://host.bertitik` tanpa `@`. Email `z.email`. Kategori dari enum. JSON di-escape ASCII. Tes baru: `javascript:`, `data:`, kredensial di URL, host tanpa titik, `//host` ditolak. Risiko penyalahgunaannya di S1 | `channels.ts:589-657` |
| Hitungan batas laju per pengguna | **Benar.** Tes 10/5 menit, profil 30/5 menit | `channels.routes.ts:47-57,234,280,298` |

---

## B. Temuan

### S1 — Sedang — Profil bisnis resmi bisa diganti ke tautan penipuan oleh Admin tanpa jejak yang memadai

**Bukti.** `channels.routes.ts:285-306` (`PUT …/business-profile`, cukup `channels.manage`), `channels.service.ts:713-747`.
Tidak ada konfirmasi identitas dan tidak ada `notifyOwners`. Audit `channel.business_profile_updated` hanya mencatat
`changedFields` (nama isian), tanpa nilai lama/baru (`channels.service.ts:729-733`). Di ringkasan keamanan juga tidak muncul.

**Dampak.** Profil bisnis (website, email, deskripsi, alamat) tampil ke **semua pelanggan** di WhatsApp, di bawah nama
bisnis yang sudah diverifikasi Meta. Konteks ini sangat dipercaya. Dengan sesi Admin curian, penyerang bisa:
1. mengganti `websites` ke `https://<perusahaan>-bayar.example` dan `email` ke alamat miliknya, lalu
2. mengarahkan pelanggan ke tautan itu ("cek profil kami untuk link pembayaran"). Ini skenario penipuan klasik
   tagihan ISP/pembayaran.

Owner tidak diberi tahu. Audit tidak bisa menunjukkan **apa** nilai yang dipasang atau nilai aslinya, jadi deteksi dan
pemulihan sulit. Polanya sama dengan S1 review RBAC (email pengirim). Untuk perubahan setara, sistem ini sudah memilih
memberi tahu Owner.

**Perbaikan yang disarankan.**
1. Catat nilai **lama dan baru** di metadata audit untuk isian yang diubah. Isian profil adalah data publik, bukan rahasia.
   Nilai lama didapat dengan membaca profil sebelum `POST`. Bila pembacaan gagal, catat `previous: null`.
2. Perubahan oleh selain Owner → `notifyOwners` dengan `change: 'business_profile_changed'`. Jenis ini ditambahkan ke
   `CHANNEL_CHANGE_KINDS`/`CHANNEL_CHANGE_AUDIT_ACTIONS`, ke email (tampilkan website/email baru sebagai teks, **bukan**
   tautan), dan ke ringkasan keamanan. Antre di dalam transaksi seperti yang lain. Karena `POST` ke Meta tidak bisa
   ditarik kembali, urutannya: audit + antre dalam transaksi → panggil Meta → bila Meta gagal, tandai audit
   `applied: false` (atau antre setelah Meta sukses, dengan 503 bila antrean mati *sebelum* memanggil Meta lewat cek
   kesehatan antrean).
3. Opsional, lebih kuat: perubahan `websites`/`email` wajib `confirmation` (password + kode 2FA), sama seperti kredensial.
4. Tes: `it.fails` "S1" di berkas tes API baru. Hapus `.fails` setelah diperbaiki.

### R1 — Rendah — Masa dingin batas laju terlalu kasar

**Bukti.** `graph-client.ts:224` (`Map` per proses), `242-244` (kunci = `path[0]`), `413-422` (diisi dari `waitSeconds`
tanpa batas atas), `122-147` (`Retry-After` sampai 999.999 detik, menit `estimated_time_to_regain_access` tanpa batas).

**Dampak.**
- Kuncinya tidak memuat kredensial, organisasi, atau channel. Batas laju yang dialami satu kredensial memblokir
  kredensial lain untuk ID objek yang sama di proses itu, tanpa memanggil Meta. Contohnya channel dengan WABA ID sama,
  atau organisasi lain di instalasi multi-organisasi yang mengisi ID milik korban (unik hanya per organisasi). Di
  instalasi satu organisasi dampaknya kecil. Tes `it.fails` R1 membuktikannya (`attempts: 0`).
- Kuncinya juga tidak membedakan operasi. Nanti di worker, batas laju dari `business_profile.read` (jenis use case
  *management*) akan ikut memblokir `POST /{phone}/messages` (*messaging*). Padahal Meta menghitungnya terpisah.
- Tanpa batas atas, header Meta yang aneh bisa "mendinginkan" nomor berhari-hari sampai proses dijalankan ulang.

**Perbaikan.** Kunci = `sha256(token).slice(0,16) + ':' + path[0] + ':' + kelompok operasi` (mis. `management` /
`messaging`). Batasi masa dingin, mis. maks. 15–60 menit (tunggu ulang setelah itu tidak berbahaya). Batasi ukuran
`Map` atau bersihkan entri kedaluwarsa. Saat worker kirim pesan dibangun, putuskan apakah masa dingin perlu dibagi
lewat Redis (api dan worker adalah proses berbeda).

### R2 — Rendah — Membuat channel tidak butuh konfirmasi identitas

**Bukti.** `channels.service.ts:404-456`. Owner diberi tahu (`created`), tetapi tidak ada `confirm()`. Keputusan
2026-11-14 hanya mewajibkan konfirmasi untuk ganti kredensial/ID dan hapus.

**Dampak.** Dengan sesi Admin curian, penyerang bisa menambah channel memakai nomor dan aplikasi Meta **miliknya**. Ia
memegang App Secret-nya, jadi setelah penerima webhook dibangun ia bisa **memalsukan pesan masuk** ke inbox perusahaan.
Contohnya "pelanggan" atau "direktur" yang meminta CS mengirim data atau mentransfer. Balasan CS di channel itu juga
keluar lewat nomor penyerang. Owner menerima email, jadi tidak diam-diam. Tetapi alasan konfirmasi pada "ganti App Secret"
("App Secret palsu memungkinkan pemalsuan webhook", DECISIONS 2026-11-14) juga berlaku persis untuk channel baru.

**Perbaikan.** Wajibkan `confirmation` di `POST /settings/channels` (wizard meminta password + kode di langkah simpan).
Bila tidak diinginkan, minimal: channel baru buatan selain Owner berstatus `enabled: false` sampai Owner menyetujui.

### R3 — Rendah — Mengaktifkan kembali tidak diberitahukan

**Bukti.** `channels.service.ts:547-576`. `enable` hanya mencatat `actorRole`, tanpa `notifyOwners`
(`566-572`). Kontrak: "Tidak diberitahukan: … `enable`".

**Dampak.** Misalkan Owner menonaktifkan channel karena token dicurigai bocor, atau saat investigasi Admin yang
mencurigakan. Admin itu bisa mengaktifkannya lagi tanpa Owner tahu, sehingga pengiriman (nanti broadcast/balasan)
berjalan lagi.

**Perbaikan.** Beri tahu Owner untuk `enable` oleh selain Owner, minimal bila penonaktifan terakhir dilakukan Owner.
Simpan `disabled_by_user_id` atau baca audit terakhir. Tes: `it.fails` "R3".

### R4 — Rendah — Karakter pengubah arah / lebar-nol lolos validasi teks satu baris

**Bukti.** `packages/shared/src/fields.ts:9-15`. `hasControlCharacters` hanya menolak `< 0x20` dan `0x7f`.
`singleLine()` di template (`templates.ts:57-60`) tidak membuang U+202E/U+2066–2069/U+200B/U+2060.

**Dampak.** Nama channel tampil di subjek dan isi email Owner ("Channel "CS Utama" dihapus oleh …") dan di inbox. RLO dan
lebar-nol bisa menyamarkan nama channel, atau membuat dua channel tampak bernama sama. Dampaknya kecil karena isinya
tetap teks yang di-escape. Hal yang sama berlaku untuk `about`/`address` profil bisnis dan isian satu baris lain di fase 1.

**Perbaikan.** Tolak kategori Unicode `Cc`, `Cf` (kecuali ZWJ U+200D untuk emoji), dan `Zl`/`Zp` di
`hasControlCharacters` (regex `/[\p{Cc}\p{Zl}\p{Zp}]|(?!‍)\p{Cf}/u`). Di template email, buang juga `\p{Cf}`.
Tes: `it.fails` "R4".

### R5 — Rendah — Tidak ada tenggat total per permintaan Graph

**Bukti.** `graph-client.ts:208-213,389-430`. Timeout 10 dtk per percobaan × 3 + backoff (0,5 + 1 dtk). `runTest`
memanggil sampai 2 (`phone_number.read` + fallback isian dasar) + 5 halaman WABA.

**Dampak.** Saat Meta lambat (tetapi tidak putus), satu `POST …/test` bisa memegang request ±3–4 menit, melewati
timeout proxy. Dengan 10 tes/5 menit per pengguna, dampaknya kecil, tetapi tetap pola DoS ringan dan pengalaman buruk.

**Perbaikan.** Tambahkan opsi `deadlineMs` per `request` (atau `AbortSignal` dari pemanggil), mis. 25 dtk untuk satu tes
koneksi, lalu hentikan retry bila sisa waktu < backoff.

### R6 — Rendah — Lapis kedua penjaga `META_GRAPH_BASE_URL` lebih lemah dari klaim

**Bukti.** `app.ts:270-272` hanya memeriksa `config.isProduction` (`NODE_ENV === 'production'` persis). Lapis pertama
memakai `isProductionLike` (semua selain development/test) + cek loopback (`config.ts:111-126`). `normalizeBaseUrl`
(`graph-client.ts:185-195`) menerima host http(s) apa pun.

**Dampak.** Untuk jalur nyata (`loadConfig`) aman. Tetapi `AppConfig` yang dirakit di luar `loadConfig` (atau worker
nanti, bila lupa memasang penjaga) bisa mengarahkan token Meta ke host lain, termasuk lewat `http` polos.

**Perbaikan.** Pindahkan penjaga ke klien. `createMetaGraphClient` menolak `baseUrl` selain `META_GRAPH_HOST` kecuali
host loopback, dan selalu menolak bila `NODE_ENV` production-like (atau terima opsi eksplisit
`allowLoopbackBaseUrl: true` yang hanya diisi config dev). Dengan begitu api dan worker otomatis terlindungi.

---

## C. Info (tidak perlu tindakan segera)

1. **Oracle kesamaan di PATCH.** Admin tanpa password bisa tahu apakah tebakan token/App Secret sama dengan yang tersimpan
   (200 tanpa konfirmasi vs 400). Tidak praktis: App Secret 128 bit, token ratusan karakter. Ini bisa dipakai memastikan
   bahwa token yang bocor dari tempat lain memang token yang dipakai Balesin, tetapi itu tidak menambah kemampuan.
   Perbandingannya sudah waktu-konstan (`crypto.ts:35-39`).
2. **Klik ganda `disable`.** `load()` di luar transaksi tanpa `FOR UPDATE` (`channels.service.ts:548-575`). Secara teori
   dua permintaan bersamaan menghasilkan dua audit + dua email. Uji lokal 4 permintaan paralel hanya menghasilkan 1
   audit/1 email. Perbaikan murah: `UPDATE … WHERE enabled = <lama>` lalu 0 baris = idempoten tanpa audit.
3. **Batas 20 channel** dihitung tanpa kunci (`channels.service.ts:413`). Pembuatan bersamaan bisa melewatinya sedikit.
   Gunakan `pg_advisory_xact_lock(organisasi)` seperti modul tim bila penting.
4. **Hapus lunak.** Teks sandi lama masih ada di tuple mati, WAL, dan backup (retensi 14 hari) sampai VACUUM/rotasi, dan
   bisa dibuka dengan master key yang sama. Wajar. Catat di panduan: setelah menghapus channel karena kebocoran, **cabut
   token di Meta** (dialog hapus sudah menyarankan mencabut webhook, tambahkan juga "cabut token Pengguna Sistem").
5. **`metaMessage` mentah di log** bergantung pada redaksi logger (`EAA…`, `Bearer`). Token System User selalu `EAA…`.
   Token yang bentuknya lain (mis. `appid|secret`) tidak terdeteksi pola itu. Bila ingin lebih ketat, ganti
   `metaMessage` dengan `info.metaMessage?.replaceAll(token, '[REDACTED]')` di klien, karena klien tahu tokennya.
6. **`pnpm audit`**: 2 *moderate*, keduanya dependensi pengembangan saja. `esbuild ≤ 0.24.2` lewat `drizzle-kit >
   @esbuild-kit/*` (GHSA-67mh-4wv8-2f99, server dev esbuild) dan `minimatch 7–11.0.0` lewat `eslint` (GHSA-g3hv-75wg-m249,
   ReDoS glob). Tidak ada di bundle produksi api/worker/web. Tidak ada temuan *high/critical*.
7. **Verify token terbaca Admin** sesuai desain. Nilainya hanya untuk jabat tangan verifikasi URL, bukan untuk memalsukan
   event (itu butuh App Secret). `GET …/webhook` tanpa `requireCsrf` tidak masalah karena tanpa efek samping, respons
   `no-store`, dan CORS hanya origin aplikasi.
8. **ID channel (UUIDv7) ada di URL webhook.** Tidak bisa ditebak secara praktis, tetapi juga bukan rahasia. Jangan
   pernah menjadikannya sebagai autentikasi (lihat D).

---

## D. Catatan untuk fase berikutnya (penerima webhook `/webhooks/whatsapp/:channelId`)

Wajib dipenuhi sebelum butir webhook dianggap selesai (SECURITY §4):

1. **Tanda tangan pada raw body.** Tangkap body sebagai `Buffer` sebelum di-parse JSON (content-type parser
   `parseAs: 'buffer'` khusus rute ini). Hitung `HMAC-SHA256(rawBody, App Secret channel)` dan bandingkan dengan
   `X-Hub-Signature-256: sha256=<hex>` memakai `timingSafeEqual` atas buffer heks yang panjangnya sudah dipastikan sama.
   Tanpa header, format salah, atau tidak cocok → 401/403 tanpa memproses. **Jangan** `JSON.parse` sebelum lolos.
2. **Batas ukuran body** khusus rute (mis. 1–3 MiB), balas **200 cepat** setelah verifikasi + simpan/antre. Proses di
   worker. Payload antrean berisi ID baris event mentah, bukan App Secret.
3. **Jabat tangan GET.** `hub.mode === 'subscribe'` + `constantTimeEqual(hub.verify_token, verify token terdekripsi)`.
   Pantulkan `hub.challenge` hanya bila cocok `^[A-Za-z0-9_-]{1,128}$`, dengan `content-type: text/plain` +
   `nosniff` (cegah XSS pantul). Batasi laju per IP, dan catat audit bila gagal berulang.
4. **Jangan percaya `:channelId` saja.** Meta mengirim event SEMUA nomor milik satu aplikasi ke satu URL callback per
   aplikasi. Cocokkan `entry[].id` (WABA) dan `changes[].value.metadata.phone_number_id` dengan channel. Bila nomornya
   milik channel lain di organisasi yang sama, arahkan ke sana **hanya jika** App Secret channel itu sama (tanda tangan
   yang sama sah). Selain itu buang + log `warn` (tanpa isi pesan).
5. **Idempotensi.** Indeks unik `(channel_id, wamid)` untuk pesan masuk. Status (`sent/delivered/read/failed`)
   idempoten per `(wamid, status)` dan tidak boleh mundur. Dedup ringan di Redis (TTL) sebelum antre. Tanda tangan
   Meta tanpa cap waktu, jadi replay ditangani idempotensi. Abaikan event yang terlalu tua.
6. **Channel terhapus/nonaktif.** Terhapus → 404 tanpa memeriksa rahasia (sudah dimusnahkan). Nonaktif → putuskan dan
   catat (mis. 200 tetapi dibuang), supaya Meta tidak terus mengulang.
7. **Log/privasi.** Jangan log raw body atau isi pesan (data pribadi, UU PDP). Cukup `channelRef`, jumlah entri, dan
   hasil verifikasi.
8. **Worker & klien Graph.** Worker memakai penjaga `META_GRAPH_BASE_URL` yang sama (lebih baik di klien, R6). Kunci
   masa dingin per kredensial + kelompok operasi (R1). `POST /messages` tidak diulang otomatis saat jaringan putus
   (sudah), dan idempotensi kirim lewat outbox sendiri. Batas & rem darurat SECURITY §5.
9. Setelah webhook ada, R2 menjadi lebih relevan (channel baru = sumber event tepercaya). Tutup bersamaan.

---

## E. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `packages/core`: `vitest run src/meta` | 51 lulus + 1 expected fail (R1) |
| `packages/shared`: `vitest run src/channels.test.ts src/security-review-fase2-channel.test.ts` | 8 + 3 lulus, 1 expected fail (R4) |
| `apps/api`: `vitest run src/modules/channels src/config.test.ts src/rbac-matrix.integration.test.ts --maxWorkers=3` | semua lulus (channels: 38 lulus + 2 expected fail S1/R3) |
| `apps/worker`: `vitest run src/queues/channel-change-email.integration.test.ts` | 5 lulus |
| `eslint`, `prettier --check`, `tsc --noEmit` (core, api, shared) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate (dev-only), 0 high/critical |
