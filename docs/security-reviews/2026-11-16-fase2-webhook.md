# Review Keamanan — Fase 2 butir 3: Penerima webhook WhatsApp

- Tanggal: 2026-11-16
- Peninjau: agent `security`
- Cakupan: commit `4642360` `feat(webhooks): penerima webhook WhatsApp — tanda tangan, idempotensi, worker`.
  Berkas: `apps/api/src/modules/webhooks/**`, `apps/api/src/queues/webhook-queue.ts`, `apps/worker/src/queues/webhooks.ts`,
  `packages/core/src/meta/{webhook-signature,webhook-payload}.ts`, `packages/core/src/queues.ts`,
  `packages/db/src/schema/webhook-events.ts` + `drizzle/0010_webhook_masuk_whatsapp.sql`, `packages/shared/src/webhooks.ts`,
  `apps/api/src/testing/fake-meta-webhooks.ts`, perubahan di `apps/api/src/app.ts`, `apps/api/src/config.ts` (TRUST_PROXY).
- Acuan: `CLAUDE.md`, `docs/SECURITY.md` §4 & §10, `docs/ARCHITECTURE.md` §4, `docs/KONTRAK-API-CHANNEL.md` bagian
  "Penerima webhook", `docs/DECISIONS.md` (baris 2026-11-16 webhook & TRUST_PROXY), bagian D review
  `2026-11-15-fase2-channel-whatsapp.md`.
- Model ancaman: (a) penyerang tanpa akun di internet, termasuk yang memakai aplikasi Meta miliknya sendiri; (b) akun **CS**
  yang dibobol (bisa `GET /channels`, jadi tahu **ID channel**); (c) sesi Admin curian. Tujuannya: memalsukan pesan masuk
  untuk menipu CS, membuat inbox buta (pesan pelanggan tidak masuk), atau membocorkan isi pesan / App Secret.
- Lingkungan uji: Postgres/Redis dev (database sementara per berkas tes, awalan Redis acak). Meta tidak pernah dipanggil;
  notifikasi ditandatangani sendiri dengan `fake-meta-webhooks.ts`. Stack E2E (3100/5180, `balesin_e2e`, Redis db 14)
  tidak disentuh. Tidak ada perubahan kode produk.

## Putusan: AMAN

Tidak ada temuan Kritis atau Tinggi. Pesan masuk **tidak bisa dipalsukan** tanpa App Secret channel. HMAC dihitung atas
byte mentah sebelum `JSON.parse`, dibandingkan waktu-konstan, dan bentuk header diperiksa ketat. Body yang belum lolos
tanda tangan tidak pernah ditafsirkan. Routing ke channel lain hanya terjadi bila organisasi, WABA, dan App Secret sama.
Kunci idempotensi menahan pemutaran ulang. Isi pesan, App Secret, verify token, dan header tanda tangan tidak masuk log,
Redis, maupun `failedReason`.

Ada empat temuan **Sedang**. Semuanya soal **ketersediaan/kehilangan pesan** dan **privasi**, bukan pemalsuan. S1 dan S2
murah diperbaiki dan sebaiknya ditutup di butir ini. S3 wajib dibereskan sebelum produksi. Bila S3 salah konfigurasi
dan S1 belum diperbaiki, siapa pun bisa membuat **semua** webhook tertahan dengan 30 permintaan per 10 menit (level Tinggi).

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| S1 | Sedang | Jabat tangan GET yang gagal (bisa dipicu **lewat server Meta** oleh siapa pun yang punya aplikasi Meta) mengisi ember yang juga menahan POST notifikasi sah dari IP Meta yang sama | Sekarang |
| S2 | Sedang | Satu kejadian "beracun" (`\u0000`, surrogate tunggal, timestamp di luar rentang) membuat INSERT seluruh notifikasi gagal → 503 terus → Meta menyerah setelah 7 hari; pesan lain di notifikasi itu ikut hilang | Sekarang |
| S3 | Sedang | `TRUST_PROXY` bawaan `false` di produksi, tanpa penjaga. Di belakang vm-nginx semua kiriman tampak dari satu IP, jadi akun CS (tahu ID channel) atau orang asing bisa menahan semua webhook | Sebelum produksi (wajib) |
| S4 | Sedang | Isi pesan pelanggan disimpan selamanya di `webhook_events.payload` (tanpa penghapusan berkala, tidak ikut ekspor/hapus per kontak) — UU PDP, SECURITY §10 | Sebelum produksi / butir kontak |
| R1 | Rendah | Akun CS bisa memicu kejadian keamanan `webhook_signature_failed` (banner `warning`) sekali per jam per channel, dan dengan itu "memakai" jatah alarm satu jam | Kapan saja |
| R2 | Rendah | Tanpa batas jumlah kejadian / `phone_number_id` berbeda per notifikasi: notifikasi 3 MB bertanda tangan sah = puluhan ribu query routing berurutan | Sebelum produksi |
| R3 | Rendah | Worker tidak memeriksa ulang apakah channel masih hidup/aktif saat memproses kejadian `pending` | Butir kontak/percakapan |
| R4 | Rendah | Timestamp di masa depan diterima; error/field lain tanpa timestamp tidak pernah "basi" | Butir kontak/percakapan & retensi |
| Info 1–8 | Info | Lihat bagian C | — |

Tes baru di `apps/api/src/modules/webhooks/security-review-fase2-webhook.integration.test.ts`: 4 penjaga regresi + 5
`it.fails` (S1 ×2, S2 ×3). Setiap `it.fails` sudah saya jalankan sebagai `it` biasa. Semuanya gagal pada asersi yang
dimaksud, bukan error lain: S1 `expected 429 to be 200` (`RATE_LIMITED`), S2 `expected 503 to be 200`
(`SERVICE_UNAVAILABLE`).

---

## A. Verifikasi syarat bagian D (review channel 2026-11-15) dan klaim backend

| Syarat D | Status | Bukti |
|---|---|---|
| D.1 Tanda tangan atas raw body, `timingSafeEqual`, tidak parse sebelum lolos | ✅ | Parser `parseAs: 'buffer'` khusus cakupan rute (`whatsapp-webhook.routes.ts:61-68`); `verifyMetaWebhookSignature` dipanggil sebelum `parseWebhookJson` (`whatsapp-webhook.service.ts:135-152`); pola `^sha256=([0-9a-fA-F]{64})$`, panjang buffer sama, `timingSafeEqual` (`webhook-signature.ts:57-67`); header ganda (array) → `malformed`. Tes penjaga: JSON rusak + tanda tangan salah → 403, bukan 400/500 |
| D.2 Batas body, 200 cepat, job berisi ID saja | ✅ | `bodyLimit` 3 MiB di parser dan rute (`routes.ts:64,104`); `admit` di `onRequest` sebelum body dibaca; job `{organizationId, eventId}` `strictObject` (`queues.ts:43-47`), `jobId = wa-event-<id>` |
| D.3 Jabat tangan: mode, verify token waktu-konstan, pola challenge, `text/plain` + `nosniff`, batas laju | ✅ (dengan catatan) | `parseWebhookHandshake` (`webhook-signature.ts:86-102`), `constantTimeEqual` atas digest SHA-256 (`crypto.ts:35-39`), `reply.type('text/plain; charset=utf-8')`, `exposeHeadRoute: false`. **Catatan**: D.3 meminta audit bila gagal berulang; implementasi sengaja hanya `warn` (biasanya salah tempel). Bisa diterima, tetapi lihat S1: kegagalan GET justru ikut menahan POST |
| D.4 Jangan percaya `:channelId` saja; routing per `phone_number_id` + WABA; saudara hanya bila App Secret sama | ✅ | `targetFor`/`siblingFor` (`service.ts:167-198`), `findLiveChannelByPhoneNumberId` difilter organisasi (`webhook-events.repo.ts:34-52`); field lain hanya bila WABA = channel URL |
| D.5 Idempotensi; status per `(wamid,status)`; event terlalu tua | ✅ (dengan catatan) | Indeks unik `(channel_id, dedup_key)` + `ON CONFLICT DO NOTHING` (`repo.ts:84-94`); > 8 hari dibuang (`service.ts:205`). Dedup Redis tidak dibuat (cukup indeks unik — Info 6). Lihat R4 untuk timestamp masa depan/null |
| D.6 Terhapus 404 tanpa memeriksa rahasia; nonaktif 200 dibuang | ✅ | `webhook-guard.ts:244-249`, `service.ts:216-219` |
| D.7 Log tanpa raw body/isi pesan | ✅ | Log hanya `channelId`, jumlah, alasan. `last_error` = kode singkat (`errorCodeOf`), `failedReason` = pesan baru tanpa isi (`worker webhooks.ts:183-191`); `cause` di log lewat `describeError` yang membuang parameter query Drizzle (`redact.ts`). Tes privasi log lulus |
| D.8 Worker & klien Graph | n/a | Worker belum memanggil Graph API; syarat R1/R6 lama tetap berlaku untuk butir unduh media/kirim pesan |
| D.9 R2 (buat channel butuh konfirmasi) | ✅ | `channels.service.ts:451-452` mewajibkan `confirmation` (password + 2FA) |

Klaim backend yang saya nilai sendiri:

1. **`findChannelForWebhook` tanpa filter organisasi dari sesi** — **benar dan bisa diterima**. Rute ini publik dan tidak
   punya sesi. ID di URL hanya memilih rahasia mana yang dipakai. Semua query berikutnya (saudara, simpan, worker)
   memakai `organizationId` dari baris channel, dan FK komposit `(organization_id, channel_id)` mencegah baris
   lintas organisasi (`0010_…sql`). Info 1.
2. **`TRUST_PROXY` salah → DoS** — **benar, dan lebih luas dari yang diakui**. Lihat S1 + S3. Ember `webhook-tak-dikenal-ip`
   hanya butuh ID acak, jadi ID channel pun tidak diperlukan.
3. **Isi pesan di `payload` tanpa penghapusan berkala** — **benar** → S4.
4. **Audit `channel.webhook_signature_rejected` bisa dipicu siapa pun yang tahu ID channel** — **benar**. Akun CS tahu ID
   lewat `GET /channels` → R1.
5. **Channel dengan App Secret penyerang bisa memasukkan pesan** — **benar, dan termitigasi** oleh konfirmasi identitas saat
   membuat channel serta pemberitahuan `channel_changed` ke Owner. Pesan palsu hanya masuk ke channel milik penyerang
   sendiri, karena routing ke saudara mensyaratkan App Secret yang sama. Info 2.
6. **Routing lintas channel bila organisasi + WABA + App Secret sama** — **benar dan aman**. Tanda tangan yang sama
   memang sah untuk keduanya. Pemutaran ulang lintas channel tetap diarahkan ke pemilik nomor dan tertahan kunci
   idempotensi channel itu.

---

## B. Temuan

### S1 — Sedang — Kegagalan jabat tangan (bisa dipicu lewat server Meta) menahan notifikasi sah

**Bukti**
- `webhook-guard.ts:236-237`: `admit` mengintip `WEBHOOK_UNKNOWN_CHANNEL_RULE` per **IP saja** untuk SEMUA permintaan.
  Ember ini terisi oleh GET/POST ke ID tak dikenal (`:245`).
- `webhook-guard.ts:251` + `:258`: ember `webhook-tolak-ip` (IP + channel) terisi oleh **jabat tangan GET yang gagal**
  (`service.ts:122,127` → `recordRejection(..., 'handshake_invalid')`). Ember yang sama diintip untuk **POST** notifikasi.
- Tes `it.fails` (dijalankan sebagai `it`): 20 GET verify token salah dari `META_IP`, lalu POST bertanda tangan sah dari
  `META_IP` → **429**. 30 GET ke ID acak dari `META_IP`, lalu POST sah ke channel yang ada → **429**.

**Skenario.** Penyerang tidak butuh akun Balesin. Ia cukup punya akun developer Meta gratis. Ia memanggil
`POST /{app-id}/subscriptions` (atau menekan "Verifikasi dan simpan") berulang kali dengan `callback_url` = URL webhook
korban (ID asli bocor dari akun CS, atau ID acak) dan verify token asal. Setiap panggilan membuat **server Meta**
mengirim GET jabat tangan yang gagal ke Balesin, dari IP keluar Meta. Itu IP yang sama (AS32934) yang mengantar
notifikasi sah. Setelah 20 (per channel) atau 30 (semua channel) kegagalan per IP dalam 10 menit, notifikasi sah dari IP
itu dijawab 429 selama 10 menit. Meta mengirim ulang dengan jeda makin panjang, jadi pesan pelanggan **terlambat**. Bila
serangan terus berjalan selama 7 hari, pesan **hilang**. Seberapa efektif serangan ini bergantung pada besar kumpulan IP
Meta (belum diketahui), karena itu levelnya Sedang. Bila S3 salah konfigurasi (semua tampak dari IP vm-nginx), cukup
30 permintaan dari mana saja dan jalurnya tidak perlu lewat Meta → Tinggi.

**Perbaikan**
1. Pisahkan ember per metode. Kegagalan GET (jabat tangan, ID tak dikenal lewat GET) hanya mengisi dan hanya diperiksa
   untuk **GET**. POST hanya ditahan oleh kegagalan **tanda tangan POST**. Server Meta tidak pernah mengirim POST bertanda
   tangan salah untuk aplikasi orang lain, karena langganan baru aktif setelah verifikasi lolos.
2. `webhook-tak-dikenal-ip` jangan menahan channel yang **ada**. Periksa ember itu hanya ketika ID tidak ditemukan
   (balas 429/404 tanpa query untuk ID berikutnya yang juga tak dikenal), atau simpan cache negatif ID tak dikenal di
   Redis. Pencarian satu baris per primary key sudah dibatasi `webhook-ip` 3.000/menit. Enumerasi UUIDv7 (74 bit acak)
   tidak realistis, jadi ember ini tidak perlu memblokir channel yang sah.
3. Ubah dua `it.fails` S1 menjadi `it`.

### S2 — Sedang — Satu kejadian "beracun" menggagalkan seluruh notifikasi

**Bukti**
- Skema toleran menerima teks apa pun (`webhook-payload.ts:49,60-67,70-86`). `\u0000` dan surrogate tunggal (`\ud800`)
  lolos. Postgres `jsonb` menolak keduanya (22P05/22P02).
- `unixSeconds` versi angka tanpa batas atas (`webhook-payload.ts:48`): `9007199254740991` → `new Date(…)` = Invalid
  Date. Pemeriksaan basi (`service.ts:205`) melewatkannya (`NaN < oldest` = false), lalu Drizzle melempar `RangeError`
  saat serialisasi.
- `insertWebhookEvents` memasukkan 500 baris per pernyataan (`repo.ts:82-94`). Satu baris gagal → seluruh notifikasi
  503 (`service.ts:250-254`). Meta mengirim ulang byte yang sama → gagal lagi, sampai 7 hari, lalu dibuang.
- Tes `it.fails` ×3 (dijalankan sebagai `it`): notifikasi berisi 1 pesan biasa + 1 pesan beracun → **503**, pesan biasa
  tidak tersimpan.

**Dampak.** Pelanggan mana pun yang bisa membuat Meta meneruskan teks berisi NUL atau surrogate terpotong (lewat isi
pesan, nama profil, atau `referral.body` iklan yang dipotong di tengah emoji) bisa membuat pesannya sendiri **dan pesan
lain yang ikut di batch yang sama** tidak pernah masuk inbox. Tidak ada alarm. Log hanya mencatat 503. Varian timestamp
hanya bisa dipicu pemegang App Secret (Rendah), tetapi penyebab dan perbaikannya sama.

**Perbaikan**
1. Bersihkan sebelum simpan. Telusuri payload: buang `\u0000` dan ganti surrogate tunggal dengan U+FFFD
   (`str.toWellFormed()`, Node 20+), di nilai **dan** kunci objek. Atau tolak bagian itu sebagai `invalid`.
2. Batasi `unixSeconds` angka (mis. `.max(4_102_444_800)` = 2100) dan tolak bila `Number.isNaN(date.getTime())`.
3. Jaring pengaman. Bila INSERT per bagian gagal dengan kelas 22 (data exception), ulangi per baris. Baris yang tetap
   gagal dicatat sebagai `invalid` (log jumlah + kode), lalu jawab 200 untuk sisanya. Hanya error koneksi/kapasitas yang
   pantas dijawab 503.
4. Ubah tiga `it.fails` S2 menjadi `it`.

### S3 — Sedang (wajib sebelum produksi) — `TRUST_PROXY` salah membuat batas per IP menjadi batas bersama

**Bukti.** `config.ts:144-147`: bawaan `false`, juga di produksi, dan tidak ada penjaga. `ARCHITECTURE.md` §5 Mode A:
Balesin di belakang vm-nginx. `DECISIONS.md` 2026-11-16 mencatat syarat ini untuk Fase 7, tetapi kode tidak menegakkannya.
`GET /channels` (izin `inbox.view`, semua peran) mengembalikan `id` channel (`shared/channels.ts:427-433`).

**Dampak bila salah konfigurasi.**
- Dari mana saja, 30 permintaan ke ID acak dalam 10 menit → semua webhook (semua channel) 429 selama 10 menit. Bisa
  diulang terus dengan ±3 permintaan/menit.
- Akun CS curian: 20 POST bertanda tangan salah ke ID channel asli → channel itu tertahan untuk semua kiriman Meta.
- Batas `webhook-ip` 3.000/menit menjadi batas untuk seluruh lalu lintas Meta (status broadcast bisa melewatinya).

**Perbaikan**
1. Installer/`balesin update` (devops, Fase 7) mengisi `TRUST_PROXY` sesuai mode (A: IP vm-nginx; B: Caddy lokal;
   C: cloudflared lokal) dan contoh nginx meneruskan `X-Forwarded-For` + `client_max_body_size 3m` untuk `/webhooks/`.
2. Penjaga di kode: di produksi, bila `TRUST_PROXY=false` dan permintaan datang dengan `X-Forwarded-For` dari alamat
   privat/loopback, tulis log `error` sekali dan tampilkan peringatan di pemeriksaan kesehatan/banner Owner ("Alamat IP
   klien tidak terbaca — atur TRUST_PROXY"). Salah konfigurasi jadi terlihat, bukan diam.
3. S1 butir 2 menghapus varian tanpa ID walaupun konfigurasi salah.

Catat di `docs/BUTUH-TOBING.md` / ROADMAP Fase 7 sebagai syarat rilis.

### S4 — Sedang — Isi pesan pelanggan disimpan tanpa batas waktu di `webhook_events`

**Bukti.** `payload` berisi isi pesan, nama profil, nomor/BSUID pelanggan, keterangan media, lokasi, dan `referral`
(`webhook-payload.ts:129-153`, `service.ts:229`). Baris `processed`/`skipped` tidak pernah dihapus atau dikosongkan
(KONTRAK "penghapusan berkala belum ada"). SECURITY §10 mewajibkan data pribadi bisa diekspor/dihapus per kontak dan
retensinya bisa diatur. Tabel ini menjadi salinan kedua isi chat yang mudah terlupa saat "hapus kontak".

**Perbaikan** (sebelum produksi; paling lambat bersama butir kontak/percakapan):
1. Job berkala di worker: setelah `processed`/`skipped`/`failed` ≥ 8 hari, kosongkan `payload` (mis. `{}` +
   `payload_purged_at`). Pertahankan `dedup_key`/`external_id` selama jendela idempotensi, lalu hapus barisnya setelah
   N hari (bisa diatur di UI, `PENGATURAN-UI.md`).
2. Hapus/ekspor per kontak ikut mencakup `webhook_events` (cocokkan `payload->message->from`/`from_user_id`, atau simpan
   kolom `contact_ref` ter-hash supaya bisa dicari tanpa membuka JSON).
3. Baris `other` (`skipped`) tidak perlu menyimpan isi lengkap sampai ada pemrosesnya. Simpan field + hash saja, atau
   beri masa simpan lebih pendek.

### R1 — Rendah — Akun CS bisa memicu alarm `webhook_signature_failed`

`webhook-guard.ts:265-294`: 10 POST tanda tangan salah dari IP mana saja (ID dari `GET /channels`) → audit +
kejadian `warning` di banner Owner/Admin, sekali per jam per channel. Bila S3 benar, IP CS sendiri baru tertahan setelah
20, jadi alarm pasti terpicu. Dampaknya kebisingan ("App Secret salah?") dan alarm sungguhan dalam jam itu tidak
tercatat ulang. **Perbaikan**: tampilkan di `details` jumlah IP berbeda dan IP terbanyak, supaya Owner bisa membedakan
"satu IP kantor" (orang dalam) dari "banyak IP Meta" (App Secret salah). Opsional: hitung ambang per IP-berbeda (≥ 3 IP).

### R2 — Rendah — Tanpa batas kejadian / nomor berbeda per notifikasi

`webhook-payload.ts:240-350`: `entry` ≤ 1.000 × `changes` ≤ 1.000, tetapi `messages`/`statuses`/`errors` tanpa batas.
`siblingFor` melakukan satu query per `phone_number_id` berbeda, berurutan (`service.ts:168-184`). Pemegang App Secret
(channel buatan penyerang lewat sesi Admin + konfirmasi) bisa mengirim notifikasi 3 MB berisi ±30 ribu `phone_number_id`
→ puluhan ribu query dalam satu permintaan, dikali 3.000 permintaan/menit. Kolam koneksi DB terkuras, aplikasi melambat
untuk semua orang. **Perbaikan**: batasi total kejadian per notifikasi (mis. 5.000; sisanya `invalid`) dan nomor
berbeda (mis. 50). Muat semua saudara dengan satu query `inArray(waPhoneNumberId, ids)`.

### R3 — Rendah — Worker tidak memeriksa ulang status channel

`apps/worker/src/queues/webhooks.ts:136-157`: kejadian `pending` tetap diproses walau channelnya sudah dinonaktifkan
atau dihapus (kredensial dimusnahkan) di antara penerimaan dan pemrosesan. Itu bisa terjadi berjam-jam bila worker mati.
Begitu handler mulai membuat percakapan/membalas otomatis, ini bisa menghidupkan lagi channel yang sengaja dimatikan
karena insiden. **Perbaikan** (butir kontak/percakapan): di transaksi yang sama, `SELECT … FROM channels WHERE id = ? AND
organization_id = ?`. Bila terhapus/nonaktif → `skipped` dengan `last_error = 'channel_inactive'`.

### R4 — Rendah — Timestamp masa depan diterima; error/field lain tidak pernah basi

`service.ts:205` hanya menolak yang terlalu tua. `occurredAt` masa depan (mis. tahun 2100) lolos. Kejadian `error`/`other`
ber-`occurredAt = null` tidak pernah basi, jadi setelah retensi S4 menghapus barisnya, rekaman lama bisa diputar ulang.
**Perbaikan**: tolak `occurredAt > receivedAt + 1 jam` sebagai `invalid`. Jendela 24 jam/SLA di butir berikutnya wajib
memakai `receivedAt` (server), bukan cap waktu payload. Retensi baris `e:`/`o:` minimal sama dengan jendela kirim ulang
Meta, dan kunci dedup-nya disimpan lebih lama daripada payload.

---

## C. Info (tidak perlu tindakan segera)

1. **Pengecualian filter organisasi** di `findChannelForWebhook` sudah benar (lihat A.1) dan terdokumentasi di repo.
2. **Pesan palsu lewat channel buatan sendiri** butuh sesi Admin + password + 2FA dan diberitahukan ke Owner. Inbox
   sebaiknya menampilkan nama channel di setiap percakapan (butir inbox), supaya CS tahu pesan datang dari nomor mana.
3. **Pencemaran prototipe**: reviver membuang `__proto__`/`constructor`. Pola `type` `^[a-z_]+$` masih menerima
   `"__proto__"`, sehingga `message["__proto__"]` = `Object.prototype` di `normalizeInboundMessage`. Sekarang tidak
   berbahaya (jenis `unknown`, tidak dibaca), tetapi lebih aman pakai `Object.hasOwn(message, rawType)` sebelum membaca
   `message[rawType]` dan `body[kind]` (interaktif). Tes penjaga ditambahkan.
4. **Enumerasi ID**: tak dikenal dan terhapus sama-sama 404. Channel yang ada menjawab 403 tanpa tanda tangan. Ini
   membedakan "ada" dari "tidak ada", tetapi UUIDv7 punya 74 bit acak, jadi enumerasi tidak realistis. Yang tahu ID
   (CS) memang sudah tahu.
5. **IPv6 /64**: Meta sering mengirim lewat IPv6 (`2a03:2880::/32`). Kunci /64 bisa menyatukan banyak server Meta ke
   satu ember `webhook-ip` 3.000/menit. Pantau 429 di log setelah broadcast pertama. Bila perlu, naikkan batas untuk
   alamat di rentang AS32934 (daftar diisi lewat UI/konfigurasi, bukan hardcode).
6. **Dedup Redis** (D.5) tidak dibuat. Indeks unik Postgres cukup. Untuk duplikat `pending` diantre ulang dengan
   `jobId` sama, BullMQ mengabaikan job yang masih tersimpan (`removeOnComplete` 24 jam), dan worker memeriksa status
   baris di bawah `FOR UPDATE`. Tes "dua job bersamaan → tepat sekali" lulus.
7. **Kunci dedup `e:`** berbasis hash isi. Dua error identik yang sah (mis. error akun yang sama dua hari berturut-turut)
   dianggap duplikat dan yang kedua dibuang. Ini fungsional, bukan keamanan. Pertimbangkan menambah tanggal (hari) ke
   isi hash.
8. **Interaksi hook global**: rute di luar `/api/v1` tetap melewati `securityPlugin` (helmet `nosniff`, CORS hanya
   origin app), hook akses (`PUBLIC`), dan 405. Parser `text/plain` dibuang global, dan parser `application/json` diganti
   hanya di cakupan plugin webhook (tidak bocor ke rute lain; tes rute lain tetap lulus). CSRF tidak relevan: tanpa
   cookie/sesi, dan `application/json` lintas situs butuh preflight yang ditolak CORS.

---

## D. Catatan untuk butir berikutnya (kontak, percakapan, media, inbox)

1. Handler di `InboundEventHandlers` memperlakukan semua isian sebagai **input pelanggan yang tidak tepercaya**:
   `from`/`wa_id` belum divalidasi sebagai nomor (hanya `≤ 64` karakter), nama profil boleh berisi karakter pengubah
   arah (R4 review channel). Normalisasi nomor (E.164) sebelum upsert kontak, dan jangan pernah mengirim balasan ke
   nomor yang tidak lolos validasi.
2. Unduh media hanya lewat **ID media** dan Graph API (host tetap). Jangan pernah mengikuti `link`/`url` dari payload
   (SSRF). `mime_type`/`filename` dari payload tidak tepercaya.
3. `referral.source_url` (iklan) ditampilkan sebagai teks yang dijinakkan atau tautan dengan peringatan, bukan tautan
   langsung.
4. Jendela 24 jam dari `receivedAt` (R4). Status hanya maju (`isStatusAdvance`) dan dicocokkan ke pesan keluar milik
   **channel yang sama**.
5. Retensi & hapus per kontak (S4) dirancang bersama tabel pesan.

---

## E. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/webhooks` (sebelum tes baru) | 28/28 lulus |
| `apps/api`: `vitest run src/modules/webhooks/security-review-fase2-webhook` | 4 lulus + 5 `it.fails` (diharapkan gagal) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | 5 gagal tepat di asersi: 429 (S1 ×2), 503 (S2 ×3) |
| `apps/api`: `vitest run src/rbac-matrix src/modules/auth/forbidden-pattern src/http src/security-review src/modules/channels/security-review src/modules/webhooks` | 201 lulus + 5 `it.fails`, 20 berkas. Satu putaran pertama sempat 12 gagal karena stack sedang sibuk, lalu dua putaran ulang bersih |
| `packages/core`: `vitest run src/meta` | 85/85 lulus |
| `apps/worker`: `vitest run src/queues` | 63/63 lulus (termasuk "dua job bersamaan → diproses tepat sekali") |
| `packages/db`: `vitest run src/webhook-events src/migrations` | 11/11 lulus |
| ESLint + `tsc --noEmit` (apps/api) + Prettier untuk berkas tes baru | bersih |
| `pnpm audit` | 2 **moderate**, keduanya dev-only: `esbuild` ≤ 0.24.2 (lewat `drizzle-kit` → `@esbuild-kit/*`, server dev) dan `minimatch` < 11.0.1 (lewat `eslint`/`typescript-eslint`). Tidak ada di dependensi runtime api/worker/web. Perbarui saat `drizzle-kit`/eslint merilis versi yang membawa perbaikannya |
