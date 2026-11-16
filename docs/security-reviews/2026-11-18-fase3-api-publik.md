# Review keamanan — Fase 3: API publik v1 + API key + OpenAPI

- Commit: `2f2d311` (`feat(api): API publik v1 dengan API key bertingkat scope + OpenAPI /api/docs`)
- Kontrak: `docs/KONTRAK-API-PUBLIK.md`
- Peninjau: subagent `security`
- Model ancaman: penyerang memegang satu akun CS yang dibobol, atau satu API key yang bocor (mis. dari
  workflow n8n), dan ingin memakai nomor WhatsApp perusahaan untuk spam/penipuan atau mencuri token Meta.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi. Ada 3 temuan Rendah dan beberapa Info. Desain kunci (id + HMAC
berpepper, waktu-konstan, tampil sekali), autentikasi Bearer saja, scope per rute, cakupan organisasi,
dan semua rem pengiriman (rem darurat, jendela 24 jam, batas harian per key/organisasi/percakapan, cek
ulang di worker) berlaku. Akun CS curian tidak bisa membuat key (`api_keys.manage` = Owner/Admin +
konfirmasi identitas), jadi jalur "CS curian → key → spam" tertutup.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Format & hash kunci | `apps/api/src/modules/api-keys/api-key-token.ts:27-65` | id 8 byte (pencarian), rahasia 32 byte; tersimpan HMAC-SHA256(pepper, "id.rahasia"); pepper HKDF dari master key (info `balesin/api-key/v1`). HMAC (bukan argon2) tepat untuk rahasia 256 bit. `timingSafeEqual` dengan cek panjang. Bocornya isi DB saja tidak cukup untuk menguji tebakan |
| Tampil sekali | service/routes api-keys | 201 + `Cache-Control: no-store`; daftar tidak memuat rahasia; audit tanpa rahasia (tes lama + baru) |
| Tanpa master key | `api-key-auth.ts:84` | pepper `null` → semua key 401; buat key → 503 |
| Hanya Bearer | `auth.hook.ts:120-122`, `api-key-auth.ts:80` | cookie & CSRF diabaikan; sesi web (cookie + CSRF sah) di rute tulis publik → 401, tidak ada pesan terbuat (tes baru) |
| Origin asing | `auth.hook.ts` langkah 1 | Bearer sah + `Origin` asing pada POST → 403 (tes baru) |
| id sah + rahasia palsu | `api-key-auth.ts:84-98` | 401 (tes baru) |
| Dicabut/kedaluwarsa | `api-key-auth.ts` | 401 seketika; pesan yang sudah antre tetap tercatat milik key; worker `apps/worker/src/queues/messages.ts` memeriksa ulang key → `sender_not_allowed` |
| Scope bertingkat per rute | `public-api.routes.ts` (semua `requireApiKeyScope`) | baca ≠ tulis, kontak ≠ percakapan; `messages:send` tidak bisa kontak; `contacts:read` tidak bisa PATCH/tag/percakapan (tes baru) |
| Cakupan organisasi | `public-api.routes.ts:93` (`grantOf`) | key organisasi lain → 404 untuk percakapan/pesan/kirim/kontak; cari kontak kosong (tes baru) |
| IP allowlist | `api-key-token.ts:89-106`, `api-key-auth.ts:100` | gagal-tertutup (IP tak dikenal/tak sah → tolak), IPv4-mapped ditangani. `trustProxy: true` ditolak di produksi (`config.test.ts:285`), jadi `X-Forwarded-For` hanya dipercaya dari proxy terdaftar |
| Batas laju | `api-key-auth.ts:41-72,112` | 300/menit per key; 30 kegagalan/menit per IP; header kosong tidak dihitung (tes baru: 35 permintaan tanpa header lalu key sah → 200) |
| Redaksi log | `redact.ts` | rahasia key & `Authorization` tidak muncul di log untuk sukses, salah, dan buat key (tes baru) |
| Idempotensi per key | `public-api.routes.ts:115,260` | `clientMessageId` = turunan (apiKeyId, Idempotency-Key); key lain dengan nilai sama TIDAK menerima pesan key pertama (tes baru) |
| Pelaku | `outbound.service.ts` | `senderKind 'bot'`, `api_key_id` terisi, tidak mengisi `firstResponseAt` |
| Rem pengiriman | `sending-limits.service.ts:370-418` | rem darurat 423, batas harian per key (`dailySendLimit`), per organisasi, per percakapan/menit; jendela 24 jam 409; tidak ada `messages:initiate` → tidak bisa memulai ke nomor baru |
| Tag otomatis | `contacts.service.ts:239` | dibatasi 300 tag/organisasi, ≤ 20 per permintaan |
| `/api/docs` | `api-docs.routes.ts:83-105` | CSP `default-src 'none'; script-src 'self'`, tanpa skrip inline, render `textContent`; tidak memuat nama organisasi, email Owner, atau pola kunci (tes baru); bisa dimatikan (→ 404) |
| Kelola key | api-keys service/routes | Owner/Admin, konfirmasi identitas saat buat, maks 50 aktif, masa berlaku ≤ 2 tahun, cabut tanpa konfirmasi (arah aman), diaudit + kejadian keamanan `api_key_changed` |
| Pengecualian pola terlarang | `forbidden-pattern.test.ts` | hanya `modules/api-keys/api-key-auth.ts` (tempat membaca header `Authorization`), wajar |

---

## B. Temuan

### R1 (Rendah) — Kunci kegagalan per IP juga menolak key SAH dari IP itu

- Bukti: `apps/api/src/modules/api-keys/api-key-auth.ts:71-78`. `peek(API_KEY_FAILURE_RULE, ip)` dijalankan
  SEBELUM key diperiksa; setelah 30 key salah/menit dari satu IP, semua permintaan dari IP itu 429,
  termasuk key yang benar.
- Dampak: penyerang yang berbagi IP keluar dengan integrasi sah (n8n cloud, NAT kantor/ISP, CGNAT, proxy
  bersama) bisa menghentikan integrasi pelanggan cukup dengan mengirim 30 token acak per menit. Ini
  penolakan layanan, bukan kebocoran; rahasia 256 bit tidak bisa ditebak, jadi kuncian per IP tidak
  menambah keamanan untuk key sah.
- Perbaikan: periksa key dulu; bila sah, layani (dan jangan konsumsi kuota kegagalan). Kuncian per IP
  cukup berlaku untuk jalur gagal (hemat beban DB). Alternatif: hitung kegagalan per (IP, lookupKey).
- Tes: `it.fails` "R1: key SAH dari IP yang terkunci…" — saat ini gagal tepat di `expected 429 to be 200`.

### R2 (Rendah) — Jejak akuntabilitas perubahan kontak/tag lewat API tidak menyebut key mana

- Bukti: `apps/api/src/modules/contacts/contacts.service.ts:157-197,290` — `contact_events.actor_user_id = null`
  untuk API (tampil "sistem"), tabel `contact_events` tidak punya kolom `api_key_id`
  (`packages/db/src/schema/contact-events.ts:29`). Pesan sudah benar (`messages.api_key_id`), tetapi
  ubah nama/email/atribut/tag kontak lewat key tidak bisa ditelusuri ke key tertentu bila ada 2+ key.
- Juga: saat batas harian per key tercapai, audit dicatat (`targetType 'api_key'`) tetapi email ke Owner
  hanya dikirim bila `userId` ada (`sending-limits.service.ts:221`), jadi key yang tiba-tiba membanjiri
  hanya terlihat di Log.
- Perbaikan: tambah `api_key_id` (nullable, FK komposit organisasi) di `contact_events` dan isi dari
  `request.apiKey`; kirim notifikasi Owner juga untuk batas `api_key` (pelaku = nama key).
- Bukan Tinggi karena kontrak menyatakannya sengaja dan key hanya dibuat Owner/Admin. Tag yang dibuat
  otomatis tidak diaudit, sama seperti tag yang dibuat dari web (bukan regresi).

### R3 (Rendah) — Batas kirim per menit organisasi (600) tidak berlaku untuk API

- Bukti: `apps/api/src/modules/messages/outbound.routes.ts:47-50,118,143` hanya di rute web; rute kirim
  publik hanya memakai 300/menit per key (untuk semua permintaan) + batas per percakapan/menit +
  batas harian.
- Dampak: dengan banyak key (maks 50) atau key berbatas harian tinggi (sampai 100.000), laju kirim
  organisasi bisa jauh di atas 600/menit sampai batas harian organisasi tercapai. Dibatasi jendela 24 jam
  (hanya percakapan yang sudah ada), jadi bukan jalur spam ke nomor baru, tetapi bisa membakar kualitas
  nomor/tier Meta lebih cepat.
- Perbaikan: panggil `enforceRateLimit(SEND_ORGANIZATION_RULE, organizationId)` juga di
  `POST /public/conversations/:id/messages` (dan media), atau pindahkan ke `assertCanSend`.

---

## C. Info

1. **Pencarian publik tanpa `statement_timeout`.** `q` di `GET /public/contacts` (`public-api.routes.ts:359`)
   dan daftar percakapan memakai `ILIKE '%…%'` tanpa `withStatementTimeout` dan tanpa batas khusus
   pencarian seperti web (60/menit). Dibatasi 300/menit per key dan `q` ≤ 100 karakter; untuk organisasi
   besar sebaiknya diberi timeout yang sama dengan web.
2. **`TRUST_PROXY` salah set** (tidak memasukkan proxy depan) membuat semua klien tampak satu IP: kuota
   kegagalan jadi bersama (memperparah R1) dan allowlist IP key tidak berfungsi (gagal-tertutup, jadi
   aman tetapi integrasi ditolak). Sudah dicatat di review webhook; perlu ada di panduan instalasi.
3. **`/api/docs` publik** memperlihatkan bahwa instalasi ini Balesin beserta versi skema API (sidik jari
   produk). Bisa dimatikan Owner. `ensureEnabled` membaca DB di setiap permintaan tanpa sesi; ringan,
   tetapi bisa di-cache beberapa detik.
4. **Satu key melihat seluruh organisasi** (sesuai kontrak). Owner perlu tahu bahwa key `messages:send`
   setara akses baca semua percakapan; teks UI pembuatan key sebaiknya menyebutnya.
5. **Pohon kerja tidak bersih (bukan dari commit ini).** Perubahan belum di-commit untuk webhook keluar
   (`packages/shared/src/audit.ts` +24 baris: `webhook_changed`/`webhook_disabled`) membuat `tsc` apps/api
   gagal 3 galat di `audit.service.ts:76,219` dan tes lama "Owner/Admin + konfirmasi…"
   (`public-api.integration.test.ts:213`) gagal `ZodError` pada `securitySummaryResponseSchema`. Bukan
   regresi commit `2f2d311`; perlu dirapikan oleh tugas webhook keluar.

---

## D. Tes penjaga

Berkas baru: `apps/api/src/modules/public-api/security-review-fase3-api-publik.integration.test.ts`

- `it` (10): sesi web tanpa Bearer → 401; Origin asing → 403; id sah + rahasia palsu → 401; header kosong
  tidak dihitung; log bersih; scope per rute; key organisasi lain → 404; idempotensi per key; key dicabut;
  `/api/docs` tanpa data organisasi/rahasia.
- `it.fails` (1): R1.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run …/security-review-fase3-api-publik.integration.test.ts` | 10 lulus + 1 `it.fails` |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di R1: `expected 429 to be 200` |
| `apps/api`: `vitest run src/modules/public-api src/modules/api-keys …hapus-ekspor… forbidden-pattern` | 24 lulus + 1 `it.fails`; 1 gagal (Info 5, akibat pohon kerja) |
| ESLint berkas tes baru | bersih |
| `tsc --noEmit` apps/api | 3 galat, semuanya di `audit.service.ts` (Info 5), tidak ada di berkas tes baru |
| `pnpm audit` | 2 moderate dev-only (esbuild lewat drizzle-kit, minimatch lewat eslint), tidak ada yang baru |
