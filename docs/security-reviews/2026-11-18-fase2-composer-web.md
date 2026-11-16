# Review Keamanan — Fase 2: composer web (kirim, lampiran, media, kirim ulang)

- Tanggal: 2026-11-18
- Peninjau: agent `security`
- Cakupan: commit `abe3ae5` `feat(chat): composer — kirim teks, balas-kutip, reaksi, lampiran, media aman, kirim ulang, rem
  darurat`. Berkas yang diperiksa:
  - `apps/web/src/features/inbox/{Composer,ChatFooter,OutboxRows,MessageMedia,MessageTimeline,ChatRoom}.tsx`;
  - `outbox.ts`, `message-media.ts`, `attachments.ts`, `chat-actions.ts`, `use-sending-paused.ts`;
  - `apps/web/src/lib/api/{client,endpoints}.ts` (multipart + unduhan);
  - `e2e/stack/{env,fake-meta-data}.ts`, `e2e/tests/inbox-{balas.spec,bantu}.ts`.
- Acuan: `docs/KONTRAK-API-INBOX.md` "Ruang chat" (unduh media wajib CSRF → Blob), review web inbox Info 1, review ruang
  chat (header unduhan, `cleanFileName`), `docs/SECURITY.md` §7, §8, §10.
- Model ancaman:
  - pelanggan yang mengirim media/nama berkas/teks berbahaya;
  - situs lain (CSRF ke unggah/kirim/unduh);
  - komputer bersama (sisa data setelah keluar);
  - agen yang tanpa sengaja mengirim atas nama orang lain;
  - kebocoran data uji/rahasia lewat E2E.
- Lingkungan uji: Vitest + jsdom, API & WebSocket tiruan. Stack E2E/kritikus tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Media:**
  - selalu lewat `fetch` + `X-CSRF-Token` (`client.download`) → `Blob` → object URL, tidak pernah `<img src>` ke API;
  - object URL dicabut saat komponen dilepas (penjaga baru) dan 10 detik setelah unduhan;
  - gambar/stiker sebagai `<img>`, video/audio baru dimuat saat diminta, dokumen hanya kartu unduh;
  - tipe isi ditentukan server (hanya gambar/audio/video raster `inline`, selain itu `octet-stream`), dan SVG/HTML
    tidak pernah dirender;
  - nama unduhan dari `Content-Disposition` (RFC 5987) dengan pemisah path & karakter kendali dibuang.
- **Pratinjau lampiran lokal** hanya untuk `image/jpeg|png` (bukan SVG), lewat object URL yang dicabut saat
  diganti/dikirim/dibuang.
- **Teks:** isi composer, pesan, kutipan, dan error server semua teks React (penjaga baru: error berisi
  `<img onerror>` tetap teks).
- **Idempotensi & error:** `clientMessageId` = `crypto.randomUUID()` per item, dipakai ulang hanya untuk "Kirim ulang"
  item yang sama. Unggah/kirim/klaim lewat klien API ber-CSRF (multipart tanpa `content-type` manual). 423/409/429
  ditangani tanpa membocorkan data.
- **Storage:** tidak ada `localStorage`/`sessionStorage`/`console` di fitur composer.
- **E2E:** data Meta tiruan & media hanya angka/nama contoh, tanpa pola token. `MEDIA_DIR` E2E di folder sementara OS.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Cache modul tidak dibuang saat keluar/sesi habis: `outbox.ts` (draf & teks gagal kirim + `File`) dan `message-media.ts` (≤ 40 Blob media, mis. foto KTP). `clearAppData` hanya membuang cache Query, sedangkan `resetOutbox`/`clearMediaCache` hanya dipanggil tes. Pengguna berikutnya di tab yang sama melihat draf gagal pengguna sebelumnya dan bisa "Kirim ulang" atas namanya sendiri | Sekarang |
| R2 | Rendah | Cache media menyimpan sampai 40 Blob termasuk DOKUMEN (≤ 100 MB per berkas, ikut tersimpan saat diunduh). Memori tab bisa mencapai beberapa GB → tab macet/tumbang di HP | Sebelum produksi |
| Info 1–5 | Info | Lihat bagian C | — |

Tes baru di `apps/web/src/features/inbox/security-review-fase2-composer-web.test.tsx`: 2 penjaga (`it`) + 2 `it.fails`
(R1). Keduanya sudah dijalankan sebagai `it` dan gagal tepat di asersinya:
- draf A masih tampil untuk pengguna B: `expected <p … dir="auto"> to be null`;
- media pengguna B diambil dari memori tanpa permintaan ke server: `expected [] to have a length of 1`.

Temuan R1 review web inbox (cache setelah 404) sudah ditutup frontend (tes kini `it`).

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Media lewat fetch + CSRF → Blob → object URL | ✅ | `endpoints.inbox.media` = `client.download(…, { accept: '*/*' })` (header CSRF, `credentials: include`). `useMessageMedia` membuat object URL per pemakai. Tes lama (`src` = `blob:`, header CSRF ada) |
| Object URL dicabut | ✅ | `useMessageMedia` mencabut URL lama saat dimuat ulang dan saat dilepas. `downloadMessageMedia` mencabut setelah 10 detik. `removeOutboxItem`/`clearFile`/`pickFile` mencabut pratinjau. Penjaga baru: tutup chat → `revokeObjectURL(url)` |
| Batas cache 40 | ⚠️ R1/R2 | LRU sederhana per `messageId`. Tidak dibuang saat keluar (R1). Tidak dibatasi byte dan ikut menyimpan dokumen (R2) |
| Tipe berbahaya tidak inline (SVG/HTML) | ✅ | Hanya `kind` image/sticker yang jadi `<img>` (SVG di `<img>` pun tidak menjalankan skrip). Server menyajikan non-raster sebagai `application/octet-stream` + `attachment`, jadi Blob-nya bertipe biner dan membuka object URL di tab baru tidak merender HTML. Tidak ada `<iframe>/<object>/<embed>` |
| Nama unduhan dibersihkan | ✅ | `filenameFromDisposition`: `filename*` UTF-8 lebih dulu, karakter < 0x20 dan `\/:*?"<>\|` → `_`. Nama dari teks pesan hanya cadangan (sudah `cleanFileName` di server). Tes lama |
| Video/audio | ✅ | Dimuat hanya setelah tombol ditekan (tidak menguras jatah/memori), `controls`, dari object URL |
| Pratinjau lampiran lokal | ✅ | `guessMediaKind(file) === 'image'` (JPEG/PNG dari `OUTBOUND_MEDIA_LIMITS`), jadi SVG/HTML lokal tidak dipratinjau. Tanpa `FileReader`/data URL. `accept` = MIME yang didukung. Server tetap penentu (magic bytes) |
| Teks tetap teks | ✅ | `MessageTimeline`, `OutboxRows` (`item.error.message` sebagai teks), `ChatFooter` (`FormErrorNotice`). Penjaga baru: pesan error berisi `<img src=x onerror=…>` tampil sebagai teks, tanpa elemen `img[src=x]` |
| `clientMessageId` & optimistis | ✅ (R1) | UUID v4 per item. Outbox dikunci per `conversationId`. Hanya tampil di percakapan asalnya. Kirim ulang memakai ID yang sama (server idempoten per pengirim). Lintas SESI di tab yang sama → R1 |
| Retry/hapus outbox | ✅ | `sendOutboxItem` memakai ulang `mediaId` yang sudah terunggah (tanpa unggah ganda). `removeOutboxItem` mencabut pratinjau. "Kirim ulang" pesan server lewat `POST /messages/:id/retry` (CSRF) |
| Claim | ✅ | `endpoints.inbox.claim` POST ber-CSRF. Tombol hanya untuk `inbox.assign` (tes lama: Teknisi tidak melihatnya) |
| Error server sebagai teks | ✅ | Lihat atas. 429 → hitung mundur, 423 → banner rem, 409 `WINDOW_CLOSED` → percakapan diambil ulang |
| Data di storage | ✅ | Tidak ada `localStorage`/`sessionStorage`/`IndexedDB`/`console` di berkas composer. Draf hanya di state/memori (R1) |
| E2E `MEDIA_DIR` bersama & data Meta tiruan | ✅ (Info 4) | `E2E_MEDIA_DIR` = `os.tmpdir()/balesin-e2e-media` (di luar repo; berkas 0600, folder 0700 dari `MediaStore`). Nomor/nama tiruan (`10000000000001x`, "Maju Jaya …"). Pemindaian diff: tidak ada pola token (`EAA…`, `\d:AA…`, `ghp_`, `xox?-`) |

---

## B. Temuan

### R1 — Rendah — Draf outbox & cache media bertahan setelah keluar

**Bukti.**
- `outbox.ts` menyimpan `items` (Map modul) berisi teks, `File`, dan pratinjau.
- `message-media.ts` menyimpan `blobs` (Map modul, ≤ 40).
- `clearAppData` (`lib/api/queries.ts`) hanya `queryClient.removeQueries(...)`. `resetOutbox`/`clearMediaCache` hanya
  dipanggil di `test/setup.ts`.
- Tes `it.fails`: pengguna A gagal mengirim `DRAF-RAHASIA-AGEN-A-5519` → keluar → pengguna B masuk di tab yang sama,
  membuka chat yang sama → draf A tampil dengan "Kirim ulang". Media yang dibuka A diambil B dari memori tanpa
  permintaan ke server.

**Dampak.**
- Di komputer bersama, isi yang belum terkirim (bisa memuat data pelanggan) dan foto/dokumen pelanggan tetap di memori
  tab setelah keluar.
- Pengguna berikutnya yang boleh membuka percakapan yang sama bisa mengirim teks yang ditulis orang lain. Server
  mencatatnya sebagai pengirim B, karena idempotensi per pengirim membuat pesan baru.
- Media dari cache tidak melewati pemeriksaan cakupan server untuk pengguna kedua. Pengguna itu hanya meminta ID pesan
  yang ditampilkan REST kepadanya, jadi kebocoran langsung terbatas, tetapi foto/dokumen pelanggan tetap ada di memori
  tab setelah keluar.

**Perbaikan.**
- Panggil `resetOutbox()` + `clearMediaCache()` dari `clearAppData` (atau dari `endSession`, jalur logout, 401
  `onSessionExpired`, dan penggantian pengguna).
- Lebih baik lagi: kunci cache media dengan `organisasi:pengguna:messageId`.
- Ubah kedua `it.fails` menjadi `it`.

### R2 — Rendah — Cache media tanpa batas byte, ikut menyimpan dokumen

**Bukti.** `remember()` membatasi JUMLAH (40), bukan ukuran. `downloadMessageMedia` memakai `fetchMedia` yang sama,
jadi dokumen (≤ 100 MB) dan video (≤ 16 MB) ikut tersimpan.

**Dampak.** Beberapa dokumen besar → ratusan MB sampai GB di memori tab. Di HP, tab dimatikan browser. Ini soal
ketersediaan, bukan kebocoran.

**Perbaikan.**
- Jangan simpan hasil `downloadMessageMedia` (dokumen) di cache.
- Batasi total byte cache (mis. 50 MB) selain jumlah.
- Lewati cache untuk Blob > 5 MB.

---

## C. Info

1. **Pertahanan berlapis tipe Blob.** Web merender gambar dari Blob bertipe `Content-Type` server, yang tepercaya dan
   memakai daftar putih. Bila ingin tidak bergantung pada header, bungkus ulang `new Blob([blob], { type })` dengan
   tipe dari daftar putih klien (`image/jpeg|png|webp`, `video/mp4|3gpp`, `audio/*`), selain itu
   `application/octet-stream`.
2. **Pratinjau yang belum dikirim tidak dicabut saat composer dilepas** (mis. pindah chat dengan lampiran terpilih).
   Kebocoran memori kecil. Tambahkan cabut di cleanup `useEffect`.
3. **`autoPlay` video/audio** setelah pengguna menekan tombol. Aman (tidak memutar otomatis tanpa tindakan).
4. **`E2E_MEDIA_DIR` tidak dibersihkan** saat stack E2E direset (database & Redis dikosongkan, media menumpuk di folder
   sementara). Hanya data tiruan. Saran: hapus isinya di `start-backend.mjs` bersama reset database, dengan pengaman path
   di dalam `tmpdir()`.
5. **Draf composer** (teks yang belum dikirim) hanya di state komponen, sehingga hilang saat pindah chat. Bila kelak
   disimpan per percakapan, simpan di memori (bukan `localStorage`) dan bersihkan saat keluar (lihat R1).

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/inbox/security-review-fase2-composer-web` | 2 lulus + 2 `it.fails` (R1) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi R1 (draf tampil; media 0 permintaan) |
| `apps/web`: `vitest run src/features/inbox src/app` | 100 lulus + 2 `it.fails`, 7 berkas |
| ESLint + `tsc --noEmit` (apps/web) untuk berkas tes baru | bersih |
