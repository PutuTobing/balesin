# Review Keamanan — Fase 2 butir 4: kontak & percakapan otomatis, jendela 24 jam

- Tanggal: 2026-11-16
- Peninjau: agent `security`
- Cakupan: commit `b03de89` `feat(inbox): kontak & percakapan otomatis dari webhook, jendela 24 jam, retensi payload`.
  Berkas utama:
  - worker: `apps/worker/src/inbound/{contacts,handlers}.ts`, `apps/worker/src/queues/{maintenance,webhooks}.ts`;
  - api: `apps/api/src/modules/{inbox,contacts}/**`, perubahan `webhooks/webhook-events.repo.ts` (stub N2);
  - paket bersama: `packages/core/src/meta/{contact-identity,webhook-payload}.ts`,
    `packages/db/src/schema/{contacts,conversations,messages,webhook-events,organizations}.ts` + `drizzle/0012_…sql`,
    `packages/shared/src/inbox.ts`.
- Acuan: `docs/KONTRAK-API-INBOX.md`, `docs/DECISIONS.md` (8 baris 2026-11-16 butir 4), `docs/SECURITY.md` §2, §10, PRD §4
  (cakupan Teknisi), review webhook `2026-11-16-fase2-webhook.md` (S4, N1, N2, R4).
- Model ancaman:
  - (a) pelanggan WhatsApp mana pun, yang mengendalikan isi pesan, nama profil, username, dan isi media/iklan;
  - (b) pemegang App Secret (channel buatan sesi Admin curian + konfirmasi);
  - (c) akun CS/Teknisi yang dibobol, yang ingin membaca percakapan di luar cakupan atau organisasi lain, atau membuat
    inbox lambat;
  - (d) pelanggan yang ingin menyerobot identitas/percakapan pelanggan lain.
- Lingkungan uji: Postgres/Redis dev (database sementara per berkas tes). Stack E2E tidak dipakai, kode produk tidak
  diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Identitas pelanggan** hanya berasal dari payload bertanda tangan Meta (`from`/`from_user_id`). Pelanggan tidak bisa
  memalsukannya.
- **Nomor didaur ulang** dilepas dari kontak lama, sehingga pemilik baru tidak masuk ke riwayat pemilik lama.
- **Cakupan dan isolasi:**
  - semua query API memakai `grant`, dan cakupan Teknisi disaring di SQL;
  - data di luar cakupan, organisasi lain, ID tak dikenal, dan ID bukan UUID dijawab 404 yang sama;
  - FK komposit `(organization_id, …)` mengunci isolasi di tingkat DB.
- **Isi respons:** tidak memuat BSUID, payload mentah, ID media Meta, `sha256`, `ctwaClid`, maupun `sourceId`.
- **Log:** hanya berisi ID, tanpa nama, nomor, BSUID, atau isi pesan (ada penjaga baru).
- **Jendela 24 jam** dihitung dari `received_at` dengan `greatest`, sehingga tidak bisa dimundurkan cap waktu payload.
- **Urutan kunci** worker dan `deleteContactData` bebas deadlock (analisis di A.1), dan handler tidak menyentuh
  `channels` (N1).

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Balas-kutip/reaksi ditautkan ke pesan **kontak lain** di channel yang sama (cocok wamid saja) | Sebelum UI menampilkan kutipan/reaksi pada pesan sasaran |
| R2 | Rendah | `referral.sourceUrl` (skema apa pun, termasuk `javascript:`) dan `media.filename` (pengubah arah U+202E, `../`) disimpan & dikirim ke web apa adanya | Sebelum layar inbox / unduh media |
| R3 | Rendah | Pencarian `q` (`ILIKE '%…%'` di 4 kolom, tanpa indeks trigram) + daftar tanpa batas laju per pengguna. Akun curian bisa membebani DB dengan pencarian beruntun | Sebelum layar inbox dipakai luas |
| R4 | Rendah | Kontak hanya-nomor (tanpa BSUID) menerima BSUID pertama yang datang dengan nomor itu, jadi nomor daur ulang bisa masuk ke riwayat pemilik lama | Saat impor kontak/kirim ke nomor (CRM, broadcast) dibangun |
| R5 | Rendah | Baris `webhook_events` (+ `contact_id`, `external_id`, waktu) tidak pernah dihapus, dan `pending` macet menyimpan payload sampai 30 hari (> retensi 8 hari) | Sebelum produksi |
| Info 1–8 | Info | Lihat bagian C | — |

Tes baru di `apps/worker/src/inbound/security-review-fase2-kontak.integration.test.ts`: 1 penjaga (`it`) dan
4 `it.fails` (R1 ×2, R2 ×2). Setiap `it.fails` sudah dijalankan sebagai `it` dan gagal tepat di asersinya:
- R1: `expected '<uuid pesan Ani>' to be null`;
- R2: `expected 'javascript:alert(document.cookie)' to be null` dan `expected '../tagihan‮fdp.exe' not to match`.

---

## A. Penilaian 8 hal yang diminta backend

1. **`deleteContactData` — DITERIMA.**
   - **Urutan kunci.** Worker: kejadian `FOR UPDATE` → channel `FOR SHARE` → advisory identitas → kontak `FOR UPDATE`
     → percakapan `FOR UPDATE` → pesan. `deleteContactData`: `UPDATE webhook_events` (kunci baris kejadian) → advisory
     → kontak `FOR UPDATE` → hapus pesan/percakapan/kontak.
     - Worker hanya memegang SATU baris kejadian (miliknya) dan tidak pernah meminta baris kejadian lain, jadi siklus
       tidak mungkin.
     - Bila `UPDATE` bertemu baris yang sedang dikunci worker, ia menunggu. Setelah worker commit, Postgres menilai
       ulang `WHERE` (READ COMMITTED). Baris itu kini `contact_id = kontak ini`, sehingga tetap ikut dikosongkan.
     - Pesan yang dibuat worker itu terhapus karena penghapusan baru berjalan setelah advisory didapat.
     - Langkah `lateEvents` menutup celah kejadian yang dikaitkan di antara dua langkah.
     - Pesan baru yang datang setelah penghapusan membuat kontak baru. Itu benar: pelanggan menghubungi lagi.
   - **Pencocokan JSON payload** hanya untuk baris `contact_id IS NULL` + belum dikosongkan + `message`/`status`, dan
     dibatasi organisasi. Ini tidak menyentuh kejadian yang sudah dikaitkan ke kontak LAIN.
     - Kelebihannya: kejadian belum-dikaitkan milik orang lain yang memakai nomor yang sama (nomor daur ulang, BSUID
       beda) ikut dikosongkan, dan yang `pending` → `skipped`. Pesan terakhir orang itu bisa hilang. Ini kasus tepi
       (kejadian `pending`/`failed` saat penghapusan) dan arahnya menghapus lebih banyak, bukan membocorkan. Info 1.
     - Tidak ada indeks untuk ekspresi JSON. Pemindaian dibatasi `payload_purged_at IS NULL` (± 8 hari terakhir),
       jadi cukup.
   - **Kosongkan payload alih-alih hapus baris — tepat.** Kunci dedup tetap, jadi kiriman ulang Meta tidak
     menghidupkan kontak. Yang tersisa hanya pseudonim (`external_id` wamid, waktu), dan `contact_id` dikosongkan.
     Lihat R5 untuk umur baris.

2. **Advisory lock `hashtextextended` 64-bit, format diduplikasi api/worker — DITERIMA (Info 2).**
   - Tabrakan hash 64-bit hanya membuat dua identitas berbeda saling menunggu, bukan bertukar data. Kemungkinannya
     dapat diabaikan.
   - Kunci memuat organisasi + jenis channel + jenis identitas, dan diurutkan sebelum diambil, jadi tidak ada deadlock
     antar-identitas.
   - Duplikasi format dijaga tes `kunci advisory identitas sama dengan worker`. Lebih aman bila dipindah ke satu
     tempat (`@balesin/db` atau `@balesin/core`) beserta fungsi `lockContactIdentities`, sehingga hapus kontak dan
     modul CRM berikutnya (ubah nomor, gabung duplikat) memakai fungsi yang sama, bukan salinan.

3. **Pencarian `q` — escape BENAR, kinerja → R3.** `likePattern` meng-escape `\`, `%`, `_` (backslash = escape bawaan
   `ILIKE`). Nomor hanya dicari bila `q` murni digit/pemisah. `q` dibatasi 1–100 karakter, dan pola tanpa wildcard
   tidak bisa dibuat patologis. Masalahnya ada di skala, lihat R3.

4. **Job retensi — DITERIMA, catatan R5.**
   - Satu query lintas organisasi dengan `make_interval(days => o.webhook_payload_retention_days)`. Nilai itu
     dibatasi CHECK 1–90 dan dibaca dari DB, bukan input.
   - `FOR UPDATE … SKIP LOCKED` tidak menunggu worker dan aman bila ada lebih dari satu proses worker. Indeks parsial
     `webhook_events_retention_idx (received_at) WHERE payload_purged_at IS NULL` mendukungnya.
   - Batas 50 × 1.000 per jam berarti lebih dari ±1,2 juta kejadian/hari akan menumpuk. Itu terlihat dari umur
     payload, jadi pantau saja.
   - `pending` > 30 hari dan pertumbuhan tabel → R5.

5. **Stub N2 memakai kunci dedup yang sama — DITERIMA.** Stub hanya terjadi untuk baris yang datanya ditolak DB
   (penerima sudah menjawab 200, jadi Meta tidak mengirim ulang). Kunci yang terpakai mencegah duplikat tanpa jejak
   bila ada kiriman ulang. Pihak luar tidak bisa "menduduki" kunci dedup pesan orang lain: untuk itu perlu payload
   bertanda tangan dengan wamid yang sama dan data yang sengaja ditolak, padahal reviver membersihkan teks. Stub yang
   ikut ditolak (mis. `dedup_key` melanggar CHECK) tercatat `log.error`.

6. **Tes api mengimpor kode worker lewat path relatif — DITERIMA (Info 3).** `tsup` api hanya mem-bundle dari
   `src/index.ts`, jadi kode worker tidak ikut ke image api. Risikonya hanya impor serupa yang tidak sengaja muncul di
   berkas non-tes. Tambahkan aturan ESLint `no-restricted-imports` (pola `**/worker/src/**`) untuk `apps/api/src/**`
   kecuali `*.test.ts`.

7. **`referral.sourceUrl` & `media.filename` apa adanya → R2.** Kontrak memang mewajibkan web menampilkan keduanya
   sebagai teks. Tetapi server adalah tempat termudah untuk menjamin itu sekali untuk semua klien (web, compat
   MobiChat, n8n).

8. **Aturan kontak (daur ulang nomor, tanpa gabung otomatis) — DITERIMA, catatan R4.**
   - Penyerobotan oleh pelanggan tidak mungkin, karena `from`/`from_user_id` diisi Meta. Pesan dari pemilik baru nomor
     daur ulang (BSUID berbeda) membuat kontak baru, dan nomornya dilepas dari kontak lama (tes
     `nomor didaur ulang…`).
   - Kontak BSUID + kontak hanya-nomor tidak digabung, yang memang lebih aman.
   - Celah sisa: kontak **hanya-nomor** tanpa BSUID mengadopsi BSUID pertama → R4.

## A2. Pemeriksaan umum

| Fokus | Status | Bukti |
|---|---|---|
| RBAC & cakupan Teknisi | ✅ | `inbox.view`/`contacts.view` = `[Y,Y,Y,Y,'assigned']` (`permissions.ts:169,173`). `permissionGrant` + `scopeCondition` di setiap query (`inbox.repo.ts`). Pesan dibaca hanya setelah percakapannya lolos cakupan (`inbox.routes.ts:160-167`). Tes `Teknisi hanya melihat percakapan & kontak yang di-assign…`, RBAC matrix |
| 404 seragam & IDOR lintas organisasi | ✅ | `requireUuid` → 404, filter `grant.organizationId` + FK komposit. Tes `data organisasi lain dan ID bukan UUID → 404 yang sama`. `channelId` filter `z.uuid()` + organisasi. Kursor divalidasi pola ketat (waktu + UUID) dan dipakai sebagai parameter, bukan teks SQL |
| Respons tanpa BSUID/payload/ID media | ✅ | `toContact` tanpa `waBsuid`. `storedMediaSchema` tanpa `metaMediaId`/`sha256`. `storedReferralSchema` tanpa `sourceId`/`ctwaClid`. JSON divalidasi ulang di `inbox-view.ts` (bentuk rusak → `null`) |
| Log tanpa isi/PII | ✅ | Log handler/kontak/retensi hanya memuat `organizationId`, `contactId`, `eventId`, dan jumlah. Penjaga baru memeriksa nama, nomor, BSUID, dan isi dua pelanggan |
| Jendela 24 jam dari `receivedAt` | ✅ | `handlers.ts:290-304` (`greatest(last_inbound_at, received_at) + 24 jam`). Reaksi/sistem tidak memperpanjang. `occurred_at` tampilan dijepit ≤ `received_at` |
| Pemalsuan identitas / menyerobot percakapan | ✅ (dengan R4) | Identitas dari payload bertanda tangan. Format BSUID/E.164 divalidasi (`contact-identity.ts`), yang tidak sah → `failed` tanpa membuat kontak. Satu percakapan terbuka per kontak × channel (indeks unik parsial) + kontak `FOR UPDATE`. Nama profil dibersihkan karakter tak terlihat, dan `name` tim tidak pernah ditimpa |
| `pnpm audit` | ✅ | 2 moderate dev-only yang sama (`esbuild` via drizzle-kit, `minimatch` via eslint) |

---

## B. Temuan

### R1 — Rendah — Balas-kutip/reaksi bisa menaut pesan kontak lain

**Bukti.** `messageIdByWamid` (`handlers.ts:105-124`) hanya mencocokkan organisasi + channel + wamid, lalu hasilnya
masuk ke `replyToMessageId`/`reactionToMessageId` (`handlers.ts:264-278`). Kedua tes `it.fails` R1 menunjukkan pesan
Budi tertaut ke pesan Ani.

**Dampak.** Pelanggan biasa praktis tidak bisa memicu ini. WhatsApp hanya mengizinkan membalas/bereaksi pada pesan di
obrolannya sendiri, dan wamid pesan orang lain tidak diketahui. Pemegang App Secret (atau keanehan klien/Meta) bisa.
Akibatnya:
- `replyTo.messageId`/`reaction.messageId` menunjuk pesan di luar cakupan Teknisi;
- bila UI kelak menampilkan kutipan (mengambil isi pesan sasaran) atau menempelkan reaksi ke pesan sasaran, isi atau
  emoji milik pelanggan lain muncul di percakapan yang salah.

**Perbaikan.** Tambahkan `eq(messages.contactId, contact.id)` (atau `conversationId` yang sama untuk reaksi) pada
pencarian sasaran. Bila tidak cocok, simpan `reply_to_wamid` saja dengan `replyToMessageId = null`. Untuk endpoint
"ambil pesan yang dikutip" nanti, tetap periksa cakupan percakapan pesan sasaran.

### R2 — Rendah — `sourceUrl` & `filename` dari pelanggan dikirim apa adanya

**Bukti.** `extrasOf` menyimpan `message.referral` mentah (`handlers.ts:98`). `normalizeInboundMessage` hanya membatasi
panjang `source_url` (2.048). `media.filename` ≤ 1.024 tanpa pembersihan. `toMessage` meneruskan keduanya
(`inbox-view.ts:119-124,146`). Tes `it.fails` R2: `javascript:alert(document.cookie)` tersimpan, dan
`../tagihan‮fdp.exe` tersimpan (tampil sebagai "tagihanexe.pdf").

**Dampak.**
- `sourceUrl`: bila suatu klien (web, n8n, mode compat) merendernya sebagai `href`, terjadi XSS lewat `javascript:` atau
  phishing.
- `filename`: pengubah arah menyamarkan ekstensi (`.exe` tampil sebagai `.pdf`), sehingga CS bisa tertipu membuka
  berkas. `../` berbahaya bila nama berkas kelak dipakai untuk path penyimpanan atau `Content-Disposition` tanpa
  pembersihan.

**Perbaikan** (server, sekali untuk semua klien):
- `sourceUrl` hanya diterima bila `new URL()` sah dengan protokol `https:`/`http:`; selain itu `null`.
- `filename` dibersihkan:
  - `cleanCustomerText`, yang membuang pengubah arah/lebar-nol;
  - buang `/`, `\`, NUL, dan karakter kendali;
  - potong ke `basename`;
  - batasi 255.
- Saat unduh media: `Content-Disposition` memakai `filename*` ter-encode RFC 5987, `Content-Type` dari hasil deteksi,
  dan nama di storage selalu ID buatan server.
- Web tetap merender sebagai teks.

### R3 — Rendah — Pencarian inbox tanpa indeks & tanpa batas laju

**Bukti.** `searchCondition` = `ILIKE '%q%'` pada `name`, `profile_name`, `wa_username` + `LIKE` pada `phone`
(`inbox.repo.ts:67-84`). Tidak ada indeks `pg_trgm`. Rute `GET /conversations` tidak memakai `limiter`. Pencarian yang
jarang cocok memaksa Postgres memindai semua percakapan/kontak organisasi (join + urut `last_message_at`).

**Dampak.** Akun yang punya `inbox.view` (termasuk CS curian) bisa mengirim pencarian beruntun/paralel. Pada ratusan
ribu kontak, setiap permintaan butuh ratusan ms CPU DB, sehingga inbox dan worker webhook ikut lambat. Kebocoran data
tidak terjadi.

**Perbaikan.**
- Indeks GIN `gin_trgm_ops` pada `lower(name)`, `lower(profile_name)`, `lower(wa_username)` (ekstensi `pg_trgm`) dan
  pada `phone`, atau kolom `search_text` gabungan + satu indeks trigram.
- Batas laju per pengguna untuk `q` (mis. 60/menit) lewat `RateLimiter` yang sudah ada.
- Minimal 2–3 karakter untuk teks.
- Pertimbangkan `statement_timeout` untuk query inbox (mis. 3 detik).

### R4 — Rendah — Kontak hanya-nomor mengadopsi BSUID pertama

**Bukti.** `resolveWhatsAppContact` (`contacts.ts:150-201`): bila BSUID belum dikenal dan nomor cocok ke kontak tanpa
BSUID, `existing = byPhone` lalu `changes.waBsuid = identity.bsuid`.

**Dampak.** Saat ini kontak hanya-nomor hampir tidak mungkin ada (BSUID selalu dikirim Meta). Kelak kontak bisa dibuat
dari impor CSV, form CRM, atau kirim/broadcast ke nomor. Bila nomornya sudah didaur ulang operator, pengirim baru
(orang lain) dilekatkan ke kontak lama beserta seluruh riwayat dan nama tim-nya. CS bisa membalas dengan data pelanggan
lama (tagihan, alamat) ke orang yang salah.

**Perbaikan** (saat fitur pembuat kontak hanya-nomor dibangun): lekatkan BSUID ke kontak hanya-nomor hanya bila
kontaknya punya pesan masuk WhatsApp sebelumnya, atau baru dibuat dalam jangka pendek (mis. 30 hari). Selain itu buat
kontak baru dan tandai "mungkin duplikat" untuk digabung manual. Tampilkan juga penanda di UI saat identitas WhatsApp
kontak baru saja dilekatkan.

### R5 — Rendah — Umur baris `webhook_events` & `pending` macet

**Bukti.** Retensi hanya mengosongkan `payload`, dan baris tidak pernah dihapus (`maintenance.ts`, kontrak "Kunci dedup
tetap"). `pending` > 30 hari baru dikosongkan (`STALE_PENDING_DAYS`).

**Dampak.**
- Tabel tumbuh tanpa batas (± 300 B/baris; 1 juta kejadian/hari ≈ 100 GB/tahun beserta indeks).
- Metadata `contact_id` + waktu + wamid (data pribadi pseudonim: kapan seseorang menghubungi) tersimpan selamanya.
- Payload `pending` macet bertahan sampai 30 hari, melewati retensi 8 hari yang diatur organisasi.

**Perbaikan.**
- Hapus baris yang `received_at` lebih tua dari `max(retensi, 8 hari) + margin` (mis. 35 hari). Dedup hanya perlu
  melewati jendela kirim ulang Meta 7 hari dan jendela basi penerima 8 hari.
- Lakukan per batch `SKIP LOCKED` di job yang sama, atau partisi bulanan di masa depan.
- Turunkan `STALE_PENDING_DAYS` ke `retensi organisasi` (min. 8). Job `pending` sudah habis percobaannya dalam
  ±10 menit, jadi 30 hari tidak menambah peluang pulih.

---

## C. Info

1. Kelebihan `deleteContactData` lewat pencocokan nomor pada kejadian belum-dikaitkan (A.1). Bila kontak punya BSUID,
   pertimbangkan mencocokkan nomor hanya untuk payload yang tidak memuat `from_user_id` berbeda.
2. Satukan `contactIdentityLockKey`/`lockContactIdentities` di paket bersama (A.2).
3. Aturan ESLint `no-restricted-imports` untuk mencegah impor worker dari kode api non-tes (A.6).
4. `messages.reply_to_message_id`/`reaction_to_message_id` FK hanya ke `messages.id` (bukan komposit organisasi).
   Worker selalu mencari di organisasi yang sama, dan R1 mempersempit ke kontak. Bila nanti ada jalur tulis lain, pakai
   FK komposit `(organization_id, …)` seperti kolom lain.
5. Nama profil WhatsApp dikendalikan pelanggan dan bisa diganti kapan saja (mis. "Admin Sky Tech",
   "Budi — pelanggan lama"). UI inbox sebaiknya selalu menampilkan nomor/username di samping nama profil dan menandai
   "nama dari WhatsApp" bila `name` tim belum diisi (rekayasa sosial terhadap CS).
6. Teks pesan (`text`) tidak dibersihkan dari pengubah arah. Itu benar untuk isi chat (bahasa RTL sah), tetapi web
   wajib merendernya dalam elemen `dir="auto"`/`unicode-bidi: isolate` supaya tidak "membalik" UI di sekitarnya.
7. Status pesan keluar dicocokkan wamid + channel + arah keluar tanpa memeriksa `recipient_id` = kontak. Ini aman karena
   wamid keluar dibuat Meta dan hanya kita yang mengetahuinya.
8. Teknisi dapat melihat kontak bila ADA percakapan kontak itu yang pernah di-assign kepadanya (termasuk yang sudah
   selesai). Ini sesuai PRD §4, tetapi pastikan "lepas assign" juga mencabut akses bila itu yang diharapkan Tobing (catat
   di DECISIONS saat butir assign dibangun).

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/worker`: `vitest run src/inbound/security-review-fase2-kontak` | 1 lulus + 4 `it.fails` |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | 4 gagal tepat di asersi R1/R2 (lihat atas) |
| `apps/worker`: `vitest run src/inbound src/queues` | 95 lulus + 4 `it.fails`, 10 berkas |
| `apps/api`: `vitest run src/modules/inbox src/rbac-matrix src/modules/webhooks` | 70/70 lulus, 5 berkas |
| `packages/db`: `vitest run src/inbox` | 11/11 lulus |
| `packages/core`: `vitest run src/meta` | 106/106 lulus |
| ESLint + Prettier + `tsc --noEmit` (apps/worker) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild` via drizzle-kit, `minimatch` via eslint) |
