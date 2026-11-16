# Review Keamanan — Fase 2 butir 6: ruang chat (backend)

- Tanggal: 2026-11-17
- Peninjau: agent `security`
- Cakupan: commit `908e3da` `feat(chat): kirim pesan & media lewat worker, unduh media aman, jendela 24 jam di server`.
  Berkas yang diperiksa:
  - api: `apps/api/src/modules/messages/{outbound.routes,outbound.service,media-store}.ts`,
    `apps/api/src/queues/message-queue.ts`, `apps/api/src/modules/contacts/contacts.repo.ts` (media saat hapus kontak);
  - worker: `apps/worker/src/queues/messages.ts`, `apps/worker/src/config.ts`;
  - core: `packages/core/src/meta/{graph-client,media-sniff,messaging,env}.ts`;
  - shared & db: `packages/shared/src/outbound.ts`, `packages/db/src/schema/media-files.ts` + `drizzle/0014_…sql`.
- Acuan: `docs/KONTRAK-API-INBOX.md` "Ruang chat", DECISIONS 2026-11-16 (9 baris butir 6), `docs/SECURITY.md` §3, §5,
  §6, §7, §10, PRD §4.
- Model ancaman: akun CS curian (atau Teknisi) yang ingin
  - memakai nomor perusahaan untuk spam/penipuan atau mengirim berkas berbahaya ke pelanggan;
  - membuat api tumbang;
  - membaca media di luar cakupan.

  Pelanggan juga dihitung sebagai pihak tak tepercaya, karena ia mengirim media yang kelak dibuka CS. Pihak luar mencoba
  SSRF atau mencuri token Meta.
- Lingkungan uji: Postgres/Redis dev + server Meta TIRUAN lokal (database sementara per berkas, awalan Redis acak).
  Stack E2E (3100/5180) tidak dipakai, kode produk tidak diubah, Meta sungguhan tidak dipanggil.

## Putusan: AMAN

Tidak ada temuan Kritis atau Tinggi.

- **Kirim pesan:**
  - butuh `inbox.reply` + cakupan percakapan (Teknisi: hanya yang di-assign), CSRF, dan batas laju per pengguna dan
    per organisasi;
  - jendela 24 jam ditegakkan di server (409), lalu worker memeriksa ULANG channel, pengirim (aktif + izin + cakupan),
    jendela, media, dan nomor;
  - `delivery_unknown` tidak diulang otomatis.
- **Unggah:**
  - jenis ditentukan dari magic bytes, dengan batas Meta per jenis;
  - nama berkas dibersihkan, disimpan dengan nama acak `uploads|inbound/<uuid>`;
  - kunci penyimpanan divalidasi pola + `relative()`, sehingga traversal tidak mungkin;
  - `mediaId` hanya milik pengunggah di channel yang sama.
- **Unduh:**
  - hanya `https://lookaside.fbsbx.com` (atau server tiruan loopback di luar produksi), `redirect: 'manual'`, maks.
    100 MB;
  - token hanya di header `Authorization`;
  - CSRF wajib, cakupan lewat percakapan;
  - header `nosniff`, CSP `default-src 'none'; sandbox`, CORP `same-origin`;
  - `Content-Type` dari deteksi isi (bukan dari Meta); selain gambar/audio/video raster → `octet-stream` + `attachment`.
- **Token Meta** tidak masuk URL, log, respons, maupun error. Fake Meta ditolak di produksi (`parseMetaGraphBaseUrl`,
  sekarang juga di worker).

Ada dua temuan **Sedang**. Keduanya soal ketersediaan dan penyalahgunaan nomor, dan wajib dibereskan sebelum produksi.
S2 sudah dicatat backend sebagai "menyusul".

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| S1 | Sedang | Unggahan (≤ 100 MB) dan unduhan media masuk (≤ 100 MB) dibaca utuh ke memori, tanpa single-flight dan tanpa batas konkurensi. Akun CS curian bisa membuat proses api kehabisan memori (OOM) dan seluruh inbox tumbang | Sebelum produksi |
| S2 | Sedang | Belum ada batas harian per pengguna/organisasi maupun rem darurat (SECURITY §5). Akun CS curian bisa mengirim ±43.000 pesan/hari (30/menit) ke semua pelanggan yang menulis dalam 24 jam terakhir (phishing dari nomor resmi). Organisasi: 600/menit | Sebelum produksi (bersama Pengaturan → Batas kirim) |
| R1 | Rendah | Dokumen Office hanya diperiksa tanda tangan wadahnya. ZIP apa pun bernama `.docx/.xlsx/.pptx` dan CFB apa pun (termasuk ber-makro VBA) bernama `.doc/.xls/.ppt` diterima, lalu dikirim dari nomor perusahaan | Sebelum produksi |
| R2 | Rendah | "Kirim ulang" menimpa `senderUserId` tanpa jejak. Pengirim asli (penulis teks) hilang dari catatan pesan keluar (SECURITY §5 "semua pesan keluar tercatat (pengirim …)"), dan kunci idempotensi ikut berpindah pemilik | Sekarang (kecil) |
| R3 | Rendah | Worker tidak "mengklaim" pesan sebelum memanggil Meta (`pending` → kirim → simpan wamid). Job yang tersendat (stalled) atau dobel bisa mengirim pesan GANDA ke pelanggan | Sebelum volume tinggi |
| R4 | Rendah | Pembersih media hanya menghapus berkas + `storage_key`. `filename` (mis. "KTP_Budi.jpg") dan `sha256` tetap di `media_files` selamanya. Setelah hapus kontak, berkas di disk masih ada ≤ 1 jam | Sebelum produksi |
| Info 1–8 | Info | Lihat bagian C | — |

Tes baru:
- `apps/api/src/modules/messages/security-review-fase2-ruang-chat.integration.test.ts`: 3 penjaga + 1 `it.fails` (S1);
- `packages/core/src/meta/security-review-fase2-ruang-chat.test.ts`: 1 penjaga + 2 `it.fails` (R1).

Setiap `it.fails` sudah dijalankan sebagai `it` dan gagal tepat di asersinya:
- S1: `expected [ …(2) ] to have a length of 1 but got 2`, yaitu dua unduhan dan dua baris `media_files` untuk satu
  pesan;
- R1: `expected { mimeType, kind } to be null`, dua kali.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Batas laju kirim | ✅ (S2) | `kirim-pengguna` 30/menit, `kirim-organisasi` 600/menit (sebelum query apa pun). Kirim ulang memakai ember yang sama. Unggah 20/menit, unduh 120/menit per pengguna |
| Cakupan Teknisi | ✅ | `findConversation(grant)` / `scopedMessage` (join percakapan + `conversationScope`) untuk kirim, kirim ulang, unggah, unduh. Worker: `permissionScope(sender.role,'inbox.reply')` + `isWithinScope(…, assignee)`. Tes lama + penjaga baru (Teknisi unduh/unggah di luar cakupan → 404, tanpa panggilan Meta) |
| Jendela 24 jam di server + worker | ✅ | `send`/`retry` → 409 `WINDOW_CLOSED`. Worker `prepare` → `window_closed`. Jendela dari `received_at` (butir 4) |
| Magic bytes & batas ukuran | ✅ (R1) | `detectMedia` (JPEG/PNG/WebP/PDF/OGG/AMR/MP3/AAC/ISO-BMFF/ZIP+CFB menurut ekstensi/TXT UTF-8) + `checkOutboundMedia` (batas Meta per jenis; stiker/WebP tidak bisa diunggah). Isi HTML/SVG/EXE berkedok ditolak (tes lama) |
| Nama berkas & path traversal | ✅ | `cleanFileName` (tanpa karakter tak terlihat/pengubah arah, basename, ≤ 255). Path = `MEDIA_DIR/<folder>/<randomUUID>` dengan `STORAGE_KEY_PATTERN` + `resolve/relative`. Mode 0600, flag `wx`. Penjaga baru: `../x`, `uploads/../../etc/passwd`, `/etc/passwd`, `uploads/abc` → ditolak sebelum menyentuh disk |
| Berkas poliglot | ✅ | Yang dikenali sebagai gambar/audio/video disajikan dengan tipe hasil deteksi + `nosniff` + CSP `sandbox` + CORP `same-origin`. Poliglot JPEG/HTML tidak pernah ditafsirkan sebagai halaman. PDF/dokumen/tak dikenal → `octet-stream` + `attachment`. Sinkron MPEG/ADTS (`0xFF 0xE?/0xF?`) sangat longgar (Info 2), tetapi dampaknya sama: disajikan sebagai audio |
| SSRF unduh | ✅ | `meta.download`: URL harus `https:` + host persis `lookaside.fbsbx.com` (atau origin server tiruan bila `baseUrl` bukan graph.facebook.com, yang hanya mungkin di luar produksi), tanpa userinfo, `redirect: 'manual'` (3xx → gagal). `Content-Length` > batas ditolak sebelum dibaca. Aliran dihentikan saat melewati 100 MB. Tes `unduh hanya dari lookaside…` |
| 100 MB, timeout 90 dtk sinkron | ⚠️ S1 | Lihat B.S1 |
| Header respons unduhan | ✅ | `content-type` dari daftar putih `INLINE_MEDIA_TYPES` (tanpa SVG/HTML/PDF). `content-disposition` RFC 6266/5987 (ASCII cadangan tanpa `"`/`\`). `nosniff`, CSP `sandbox`, `private, max-age=300`, CORP |
| Token Meta | ✅ | Hanya `Authorization: Bearer` (unduh) dan klien Graph terpusat (`appsecret_proof`). Log unduhan hanya `operation`/`status`/`bytes`. URL lookaside (berisi parameter bertanda tangan) tidak di-log dan tidak disimpan. Error ke klien = `META_ERROR_MESSAGES` |
| Idempotensi `clientMessageId` | ✅ (R2) | Dicari per (organisasi, pengirim, kunci). Pelanggaran unik saat balapan → kembalikan baris yang sudah ada. ID yang sama untuk percakapan lain → 409 |
| Unggahan hanya milik pengunggah | ✅ | `mediaFiles.uploadedByUserId = grant.userId` + channel sama + belum kedaluwarsa/dihapus (penjaga baru: CS memakai `mediaId` Owner → 404, tanpa job) |
| Retensi & pembersihan media; hapus kontak | ✅ (R4) | `expiresAt` = retensi organisasi (unggahan ≤ 29 hari). `purgeExpiredMedia` tiap jam (api). `deleteContactData` memajukan `expiresAt` media pesan kontak itu |
| `delivery_unknown` tidak diulang otomatis | ✅ | Worker: `network_error` → `delivery_unknown` (bukan lempar ulang). Hanya `rate_limited`/`temporarily_unavailable` yang diulang BullMQ (Info 4). Klien Graph tidak mengulang `POST /messages` |
| Isi pesan tidak di log/audit | ✅ | Log api/worker hanya `messageId`, `type`, `reason`, `kind`, `metaCode`, jumlah byte. Tes lama memeriksa teks rahasia tidak muncul di log |
| Fake Meta tidak aktif di produksi | ✅ | `metaGraphEnvShape(production)` dipakai api DAN worker: di produksi `META_GRAPH_BASE_URL` ditolak (konfigurasi gagal). `fake-meta.ts` hanya di `testing/` (tidak ikut bundle) |
| Dependensi baru | ✅ | `@fastify/multipart` 10.1.8 (`@fastify/busboy` 3.2.5), didaftarkan HANYA di plugin rute ini dengan `files: 1, fields: 0, parts: 1, fileSize: 100 MB`. `pnpm audit`: 2 moderate dev-only yang sama |

---

## B. Temuan

### S1 — Sedang — Media dibaca utuh ke memori tanpa single-flight & tanpa batas konkurensi

**Bukti.**
- Unggah: `part.toBuffer()` (`outbound.routes.ts:176`) membaca hingga `MAX_UPLOAD_BYTES` (100 MB) ke memori, dan baru
  SESUDAHNYA jenis + batas per jenis diperiksa (gambar ≤ 5 MB pun dibaca sampai 100 MB dulu). Batas laju
  (20/menit) dihitung saat permintaan masuk, jadi 20 unggahan paralel lolos bersamaan (≈ 2 GB).
- Unduh: `meta.download` mengumpulkan semua potongan ke `chunks` lalu `Buffer.concat` (≤ 100 MB per permintaan,
  `graph-client.ts`). `outbound.service.ts` `media()` tidak punya kunci per pesan, sehingga permintaan bersamaan untuk
  media yang belum di-cache mengunduh semuanya. Tes `it.fails` S1: 3 GET bersamaan → 2 unduhan + 2 baris `media_files`
  + 2 berkas di disk untuk satu pesan.
- Unduhan sinkron di dalam permintaan, hingga 90 detik, dan tidak dibatalkan bila klien memutus.

**Skenario.** Penyerang (sebagai "pelanggan") mengirim dokumen 100 MB ke nomor bisnis. Dengan akun CS curian ia lalu
memanggil `GET /messages/<id>/media` paralel (batas 120/menit) dan/atau 20 unggahan 100 MB paralel. Memori proses api
naik beberapa GB → OOM / GC macet → seluruh inbox, webhook Meta, dan login ikut tumbang. Bisa diulang. Jatah Meta juga
terbuang.

**Perbaikan.**
1. **Unggah:** alirkan `part.file` ke berkas sementara di `MEDIA_DIR/tmp` (nama acak, 0600). Deteksi jenis dari
   64 KiB pertama, lalu hentikan segera begitu melewati batas jenis itu (gambar 5 MB, audio/video 16 MB). Unggah ke
   Meta dari aliran berkas.
2. **Unduh:** single-flight per `(organization_id, message_id)`. Pilihannya `Map<string, Promise>` di proses ditambah
   `pg_advisory_xact_lock`/baris `media_files` berstatus `downloading` lintas proses. Alirkan ke berkas sementara,
   bukan `Buffer`. Batalkan bila klien memutus (`request.raw.on('close')` → `AbortController`). Pertimbangkan
   memindahkan unduhan ke job worker (api menjawab 202 "sedang disiapkan").
3. **Batas konkurensi global** per proses (mis. maks. 4 unggahan + 4 unduhan berjalan; sisanya 429/503
   "coba lagi") dan per pengguna (maks. 2 berjalan).
4. Ubah `it.fails` S1 menjadi `it`.

### S2 — Sedang — Belum ada batas harian & rem darurat (SECURITY §5)

**Bukti.** Hanya batas per menit (`SEND_USER_RULE` 30, `SEND_ORGANIZATION_RULE` 600). DECISIONS 2026-11-16 "Batas
kirim": batas harian yang bisa diatur dan rem darurat menyusul.

**Dampak.** Akun CS curian bisa mengirim ±43.000 pesan/hari (atau organisasi ±864.000/hari) ke pelanggan yang
jendelanya terbuka, berupa tautan phishing atau berkas dari nomor resmi. Akibatnya kualitas nomor turun, nomor bisa
diblokir Meta, dan pelanggan tertipu. Jendela 24 jam membatasi penerima ke pelanggan yang baru menghubungi, sehingga
dampaknya lebih kecil daripada broadcast (bukan Tinggi). Tetapi SECURITY §5 menjadikan batas harian + rem darurat
standar wajib.

**Perbaikan (wajib sebelum produksi):**
- batas harian per pengguna dan per organisasi yang bisa diatur lewat UI (`sending.limits.manage`, PENGATURAN-UI),
  dengan bawaan yang konservatif (mis. 500/pengguna/hari);
- rem darurat (> N× rata-rata 7 hari atau batas mutlak) yang menghentikan antrean `messages` dan memberi alarm ke Owner;
- batas per percakapan (mis. 20 pesan/menit ke satu pelanggan) untuk menahan spam ke satu orang.

Catat sebagai syarat rilis di ROADMAP/BUTUH-TOBING bila belum.

### R1 — Rendah — Office hanya diperiksa tanda tangan wadah

**Bukti.** `media-sniff.ts:88-95`: ZIP + ekstensi `docx/xlsx/pptx` → dokumen Office; CFB + `doc/xls/ppt` → dokumen.
Tes `it.fails` R1: ZIP berisi `payload/setup.exe` bernama `tagihan.docx` diterima, dan CFB dengan aliran
`_VBA_PROJECT`/`Macros` bernama `tagihan.doc` diterima.

**Dampak.** Akun CS curian bisa mengirim arsip program atau dokumen ber-makro ke pelanggan dari nomor resmi
perusahaan, yang sangat dipercaya pelanggan. Meta tidak memindai makro.

**Perbaikan.**
- ZIP: pastikan ada entri `[Content_Types].xml` + folder sesuai ekstensi (`word/`, `xl/`, `ppt/`) dan tidak ada
  `vbaProject.bin`. Cukup membaca direktori pusat ZIP, tanpa membongkar.
- CFB: tolak bila direktori memuat nama aliran `_VBA_PROJECT`, `VBA`, atau `Macros` (UTF-16LE).
- Opsional: pengaturan organisasi "izinkan format Office lama" (bawaan mati).

### R2 — Rendah — Kirim ulang menimpa pengirim tanpa jejak

**Bukti.** `retry()` mengubah `senderUserId: grant.userId` (`outbound.service.ts` retry). Tidak ada audit, log, atau
kolom penulis asli.

**Dampak.**
- Teks yang ditulis A tercatat dikirim B. Investigasi "siapa yang mengirim pesan penipuan ini" bisa salah orang. B
  bisa "mencuci" pesan gagal A, dan A bisa menyangkal.
- Kunci idempotensi A berpindah ke B. Bila klien A mengulang POST yang sama (jaringan putus) setelah B
  mengirim ulang, A tidak menemukan kuncinya dan pesan baru dibuat → pesan ganda (kasus tepi).

**Perbaikan.**
- Simpan `author_user_id` (tetap) dan `last_sent_by_user_id`, atau catat log/audit `message.retried`
  (`messageId`, `previousSenderUserId`, `actor`, `attempt`).
- Cari idempotensi berdasarkan penulis asli.
- Tampilkan "dikirim ulang oleh …" di UI.

### R3 — Rendah — Tidak ada klaim sebelum memanggil Meta

**Bukti.** `processSendMessageJob`: baca `pending` & `wamid IS NULL` → `prepare` → `sendWhatsAppMessage` → simpan
`wamid`. Tidak ada `UPDATE … SET status='sending' WHERE status='pending' RETURNING` sebelum panggilan.

**Dampak.**
- Job yang dianggap tersendat oleh BullMQ (event loop macet > `lockDuration`, proses mati setelah Meta menerima tetapi
  sebelum `wamid` tersimpan) dijalankan ulang, lalu mengirim pesan GANDA ke pelanggan.
- Hal yang sama terjadi bila dua job untuk pesan yang sama berjalan bersamaan (mis. diantre ulang manual).

**Perbaikan.**
- Sebelum memanggil Meta, klaim atomik: `status = 'sending'` (atau kolom `sending_started_at`).
- Job yang menemukan `sending` tanpa `wamid` menandai `delivery_unknown` (pengguna memutuskan), bukan mengirim lagi.

### R4 — Rendah — Sisa metadata media & jeda hapus kontak

**Bukti.**
- `purgeExpiredMedia` hanya `storageKey = null, deletedAt = now()`. `filename`, `sha256`, `metaMediaRef`, `sizeBytes`
  tetap selamanya.
- `deleteContactData` hanya memajukan `expiresAt`, sehingga berkas tetap di disk sampai pembersih berikutnya
  (≤ 1 jam).
- Unggahan yang tidak pernah dikirim tidak terkait pesan, sehingga hapus kontak tidak menyentuhnya. Ia ikut retensi
  biasa.

**Dampak.**
- Nama berkas sering memuat data pribadi ("KTP_Budi_Santoso.jpg", "bukti-transfer-0812…").
- `sha256` memungkinkan mencocokkan berkas yang pernah dimiliki.
- UU PDP / SECURITY §10: setelah dihapus/kedaluwarsa, data harus benar-benar hilang.

**Perbaikan.**
- Saat purge, kosongkan `filename`, `sha256`, `metaMediaRef`, atau hapus barisnya setelah tidak dirujuk pesan.
- `deleteContactData` menghapus berkas segera setelah commit (atau mengantre job hapus berisi ID), lalu
  mengosongkan metadata yang sama.

---

## C. Info

1. **Unggahan ke Meta sinkron** (timeout 60 dtk) di dalam permintaan. Ikut tertangani S1 butir 3 (batas konkurensi).
   `requestTimeout` server 30 dtk berlaku untuk MENERIMA body, sehingga unggahan 100 MB lewat jaringan lambat bisa 408
   (fungsional, bukan keamanan).
2. **Deteksi MP3/AAC longgar.** Byte awal `0xFF 0xE?`/`0xFF 0xF?` diterima sebagai audio. Unggahan sampah tetap
   dikirim ke Meta (yang menolaknya). Unduhan disajikan sebagai audio + `nosniff` + `sandbox`, jadi aman. Saran: periksa
   2–3 header frame berurutan.
3. **Nama/alamat lokasi** dari agen tidak menolak `\u0000`. jsonb menolak → 500 (bukan 400). Tambahkan aturan "tanpa
   NUL" yang sama dengan teks.
4. **`temporarily_unavailable` (5xx Meta) diulang BullMQ.** 5xx pada `POST /messages` secara teori bisa terjadi setelah
   Meta menerima, sehingga bisa terjadi pesan ganda kecil kemungkinannya. Sesuai panduan Meta (kode 1/2 = coba lagi),
   jadi bisa diterima. R3 membantu mendeteksinya.
5. **`media_files` lintas proses api:** pembersih tiap jam berjalan di setiap proses api tanpa `SKIP LOCKED`. Aman
   (`rm` dengan `force`, pembaruan idempoten), hanya kerja ganda.
6. **Unduh media untuk channel nonaktif** tetap diizinkan (hanya terhapus yang ditolak). Itu memakai token channel yang
   sengaja dinonaktifkan Owner, mungkin karena insiden. Pertimbangkan menolak unduhan baru (yang sudah di-cache tetap
   bisa dibaca) saat channel nonaktif.
7. **Tanda dibaca ke Meta tidak dikirim** (DECISIONS). Ini mengurangi kebocoran perilaku ke pelanggan. Bila kelak
   diaktifkan, harus lewat pengaturan organisasi.
8. **Batas `limit` daftar pesan & unggah per percakapan** tidak ada (hanya per pengguna). Sudah memadai untuk butir ini.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/messages/security-review-fase2-ruang-chat` | 3 lulus + 1 `it.fails` (S1) |
| `packages/core`: `vitest run src/meta/security-review-fase2-ruang-chat` | 1 lulus + 2 `it.fails` (R1) |
| Keduanya dengan `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi S1 (2 baris `media_files`) dan R1 (terdeteksi sebagai dokumen) |
| `apps/api`: `vitest run src/modules/messages src/rbac-matrix src/modules/inbox src/modules/realtime` | 63 lulus + 1 `it.fails`, 6 berkas |
| `apps/worker`: `vitest run src/queues/messages` | 7/7 lulus |
| `packages/core`: `vitest run src/meta` | 119 lulus + 2 `it.fails`, 7 berkas |
| ESLint + Prettier + `tsc --noEmit` (api, core) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild` via drizzle-kit, `minimatch` via eslint), tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan commit `6d609c5`

### Putusan putaran 2: AMAN

- **Tertutup:** S1, R1, R2, R4 (bagian kode), Info 3, Info 6.
- **S2 tertutup untuk lingkup butir ini.** Batas harian pengguna/organisasi, batas per percakapan, rem darurat manual,
  audit + banner + email Owner. Rem darurat OTOMATIS (> N× rata-rata 7 hari) ditunda ke butir broadcast (DECISIONS) dan
  tetap **syarat rilis broadcast**.
- **R3 tertutup** dengan satu catatan baru, R5 (Rendah).
- **R4** hapus-berkas-segera setelah "Hapus kontak" menunggu endpoint CRM (DECISIONS mewajibkan memanggil
  `purgeExpiredMedia` setelah commit).

Ketiga tes yang dulu `it.fails` kini `it` dan lulus. Asersi tidak dilemahkan: diff hanya menghapus `.fails` dan komentar
"saat ini …"; `toHaveLength(1)` dan `toBeNull()` tetap. Tidak ada temuan Sedang ke atas.

| # | Status | Bukti |
|---|---|---|
| S1 | ✅ | Unggah: `part.file` dialirkan ke `MEDIA_DIR/tmp` (`MediaWriter`, 0600). Jenis dari 64 KiB pertama → `writer.maxBytes` dipersempit ke batas jenis (gambar 5 MB, …) → `MediaTooLargeError` → 413. Unggah ke Meta dari `openAsBlob` (tidak dimuat). Unduh: `meta.download` dengan `sink` ke disk. Single-flight per `(organisasi, pesan)` di proses. Dibatalkan bila semua peminta memutus (`reply.raw` `close`). Lintas proses: `FOR UPDATE` pada baris pesan, salinan proses lain dipakai dan milik sendiri dihapus. `ConcurrencyGate` 4/proses + 2/pengguna → 429. Tes S1 (3 GET bersamaan → 1 baris) kini `it` dan lulus |
| S1 celah lintas proses | ✅ diterima | Paling banyak satu unduhan per proses untuk pesan yang sama. Memori tidak lagi bergantung ukuran berkas. Cukup |
| S2 | ✅ | `assertCanSend` (kirim & kirim ulang): rem → 423 `SENDING_PAUSED`. COUNT 24 jam pengguna/organisasi (indeks parsial baru `messages_outbound_*`) → 429 + audit/email Owner sekali per 24 jam. `kirim-percakapan` per percakapan. Worker memeriksa rem lagi (`sending_paused`). Tarik rem = `sending.limits.manage` TANPA konfirmasi (arah aman, cepat), lalu audit + banner + email semua Owner. Lanjutkan (`sending.resume`) & ubah batas = konfirmasi identitas + `assertActorStillAuthorized`. Nilai batas di DB (CHECK rentang), bukan `.env` |
| S2 COUNT tanpa kunci | ✅ diterima (Info P2-1) | Kelebihan saat balapan dibatasi 30/menit per pengguna dan 600/menit per organisasi |
| R1 | ✅ | ZIP: EOCD dari ujung berkas, direktori pusat ≤ 8 MB, `offset + size` ≤ posisi EOCD, ZIP64 ditolak. Wajib `[Content_Types].xml` + folder sesuai ekstensi. Ditolak bila ada `vbaProject.bin`/`vbaData.xml`/ekstensi program. CFB: seluruh berkas dipindai per potongan (dengan sambungan antarpotongan) untuk `_VBA_PROJECT`/`Macros`/`VBA`. Dokumen masuk yang gagal → disajikan biner. Dua tes R1 kini `it` dan lulus |
| R2 | ✅ | `sender_user_id` = penulis tetap (idempotensi). `last_sent_by_user_id` = penekan "Kirim ulang", FK komposit. Worker memeriksa `lastSentByUserId ?? senderUserId` |
| R3 | ✅ (R5) | Klaim atomik `send_claimed_at` sebelum Meta. Klaim ditemukan tanpa wamid → `delivery_unknown`. Klaim dilepas hanya pada `rate_limited`/`temporarily_unavailable`. Kirim ulang mengosongkan klaim |
| R4 | ✅ (sebagian) | `purgeExpiredMedia` mengosongkan `filename`, `sha256` (nol), `metaMediaRef`. Hapus kontak memajukan kedaluwarsa. Hapus berkas seketika menunggu endpoint CRM (DECISIONS) |
| Info 3 / Info 6 | ✅ | NUL di nama/alamat lokasi → 400. Unduhan BARU dari channel nonaktif/terhapus → 404 (cache tetap bisa dibaca) |

### Catatan baru

**R5 — Rendah — Klaim yang masih berjalan dianggap macet.**
- **Bukti.** `processSendMessageJob` (`apps/worker/src/queues/messages.ts`): klaim tanpa wamid → langsung
  `markFailed(… 'delivery_unknown')`, tanpa melihat umur klaim. Bila job yang sama dijalankan ulang BullMQ (stalled)
  SEMENTARA percobaan pertama masih memanggil Meta, job kedua menandai pesan gagal. Percobaan pertama lalu tidak bisa
  menyimpan wamid (`WHERE status = 'pending'`). Pesan yang sebenarnya terkirim tampil "gagal, mungkin terkirim", status
  webhook berikutnya tidak tertaut, dan agen terdorong "Kirim ulang" → pesan ganda (manual).
- **Tes.** `it.fails` baru di `apps/api/src/modules/messages/security-review-fase2-ruang-chat.integration.test.ts`
  (klaim baru diambil → job kedua `failed`, bukan `skipped`), gagal tepat di asersi
  `expected 'failed' to be 'skipped'`.
- **Perbaikan.**
  - Klaim yang lebih muda dari batas waktu panggilan Meta (mis. < 2 menit) → `skipped` (`not_pending`) dan pesan
    dibiarkan `pending`. Biarkan percobaan pertama menyelesaikan; pemeriksa berkala menandai `delivery_unknown` bila
    klaim > 2 menit tanpa wamid.
  - Penyimpanan wamid percobaan pertama sebaiknya juga berhasil bila pesan sudah ditandai `delivery_unknown`
    (`status IN ('pending','failed') AND failure_reason = 'delivery_unknown'`), supaya pesan yang terkirim pulih.

**Info P2-1.** Hitungan harian per pengguna memakai penulis (`sender_user_id`). Kirim ulang oleh pengguna lain tidak
memakai jatah harian penekannya. Kirim ulang dibatasi 5 percobaan, hanya pesan gagal, dan tetap kena batas per menit,
jadi efeknya kecil. COUNT tanpa kunci bisa sedikit melampaui batas (dibatasi batas per menit).

**Info P2-2.** Setelah 413/415, sisa aliran unggahan DIKURAS (`resume`) sampai batas `fileSize` multipart (100 MB). Itu
memakai bandwidth, tetapi tidak memakai memori. Bisa diterima. Alternatif: tutup koneksi (`request.raw.destroy()`)
setelah balasan 413.

**Info P2-3.** Dokumen Office modern dengan objek OLE tertanam (`word/embeddings/oleObject*.bin`, paket berisi program)
masih lolos. Ini vektor malware klasik, tetapi butuh klik ganda + peringatan Office. Pertimbangkan menolak
`embeddings/*.bin` pada unggahan keluar.

**Info P2-4.** Rem darurat bisa ditarik berulang oleh sesi Admin curian (tanpa konfirmasi). Setiap tarikan diaudit
dan diemailkan, dan melanjutkan butuh konfirmasi. Arah aman, jadi bisa diterima.

### Tes putaran 2

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/messages/security-review-fase2-ruang-chat` | 4 lulus (termasuk S1 yang kini `it`) + 1 `it.fails` (R5) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi R5 (`'failed'` ≠ `'skipped'`) |
| `packages/core`: `vitest run src/meta src/mail` (termasuk 2 tes R1 yang kini `it`) | 190/190 lulus |
| `apps/api`: `vitest run src/modules/inbox src/modules/messages src/modules/sending-limits src/rbac-matrix src/modules/realtime src/modules/audit` | 106 lulus + 1 `it.fails` |
| `apps/worker`: `vitest run src/queues/messages src/queues/email` | 25/25 lulus |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
