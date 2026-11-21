# Review Keamanan — Fase 2: web inbox (daftar, ruang chat baca-saja, real-time)

- Tanggal: 2026-11-17
- Peninjau: agent `security`
- Cakupan: commit `1c767ec` `feat(inbox): daftar percakapan real-time, tab & hitungan, cari, saring, hitung mundur 24 jam,
  ruang chat baca-saja`. Berkas yang diperiksa:
  - `apps/web/src/features/inbox/**`: `MessageTimeline`, `message-content`, `ChatRoom`, `ContactPanel`,
    `ConversationItem`, `contact-identity`, `inbox-stream`, `use-inbox-stream`, `inbox-queries`, `inbox-search`,
    `inbox-filters`;
  - `apps/web/src/lib/api/endpoints.ts` (inbox);
  - `e2e/tests/{fixtures,pengguna}.ts` (`releaseInboxReadBudget`).
- Acuan: `docs/KONTRAK-API-INBOX.md` (Bentuk `Message`, Real-time), `docs/SECURITY.md` §2, §8, §10, review
  `2026-11-16-fase2-kontak-percakapan.md` (R2, Info 5–6), `2026-11-16-fase2-inbox-realtime.md` (Info 4).
- Model ancaman:
  - pelanggan yang mengendalikan nama profil, teks, nama berkas, isi iklan, lokasi, dan balasan tombol, dan mencoba
    XSS, tautan phishing aktif, atau penyamaran bidi;
  - situs lain yang mencoba membajak WebSocket atau memakai `?chat=` untuk open redirect;
  - komputer bersama (data inbox tersisa setelah keluar/sesi habis);
  - Teknisi yang percakapannya dialihkan.

  Kontras/aksesibilitas tidak termasuk.
- Lingkungan uji: Vitest + jsdom, API & WebSocket tiruan. Tes dijalankan di **worktree terlepas pada `e9a8098`** karena
  working tree utama berisi perubahan skema backend yang belum di-commit (`nameSource` di `packages/shared/src/inbox.ts`)
  yang sementara membuat tes inbox web gagal di working tree. Worktree sudah dihapus. Stack E2E tidak dipakai, kode
  produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Konten pelanggan selalu teks:**
  - semua isi pelanggan dirender sebagai teks React (ter-escape);
  - fitur inbox tidak memakai `dangerouslySetInnerHTML`, `innerHTML`, maupun `<a href>`;
  - `sourceUrl` iklan tampil sebagai teks dengan host ditonjolkan, bukan tautan;
  - nama berkas, lokasi, dan balasan tombol masuk ke label teks;
  - teks bebas memakai `dir="auto"`, yang membuat isolasi bidi;
  - nomor selalu tampil di samping nama yang bukan nomor (melawan penyamaran nama profil).
- **WebSocket:**
  - URL `ws(s)://<host halaman>/api/v1/inbox/stream` tanpa token (origin sama, cookie sesi);
  - event divalidasi skema dan ≤ 16 KiB, sehingga event berbentuk aneh diabaikan;
  - 4401/4403 → berhenti tanpa sambung ulang, lalu sesi diperiksa ulang;
  - socket ditutup saat halaman inbox dilepas (logout atau pindah).
- **Setelah keluar atau sesi habis**, cache Query dibuang (`clearAppData`, Fase 1). Penjaga baru membuktikan tidak ada
  query `inbox` atau isi pesan yang tersisa setelah 4401.
- **`?chat=`** hanya diterima bila UUID (selain itu diabaikan). Nilainya tidak pernah dipakai untuk navigasi keluar,
  jadi tidak ada open redirect.
- **`POST /read`** lewat klien API dengan `X-CSRF-Token` (tes lama), tanpa menyimpan data di storage, URL (hanya `tab`
  dan `chat` UUID), atau konsol.
- **Workaround E2E** (menghapus kunci `balesin:rl:inbox-*` di Redis E2E) hanya ada di `e2e/`. Tidak ada jalan pintas
  batas laju di kode api/worker/web.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Saat chat terbuka berubah 404 (dialihkan/dihapus), `forgetConversation` membuang pesan dan baris daftar, tetapi query detail percakapan (nama, nomor, cuplikan pesan terakhir) dan kontak (nomor, nama profil) tetap di cache memori sampai gc | Sekarang (kecil) |
| Info 1–6 | Info | Lihat bagian C | — |

Tes baru di `apps/web/src/features/inbox/security-review-fase2-inbox-web.test.tsx`: 4 penjaga (`it`) dan 1 `it.fails`
(R1). `it.fails` sudah dijalankan sebagai `it` dan gagal tepat di asersinya:
`expected { conversation: { …(14) } } to be undefined`.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Konten tak tepercaya tidak jadi HTML/tautan aktif | ✅ | `grep` fitur inbox: tidak ada `dangerouslySetInnerHTML`/`innerHTML`/`href=`/`window.open`. `MessageTimeline.tsx:117-154`: iklan = `<p>`/`<span>` teks, `linkHost` hanya untuk menonjolkan host http(s). `message-content.ts`: dokumen → label "Dokumen: <nama>", lokasi → "nama · alamat", tombol → judul (semua string). Penjaga baru: nama kontak `<a href="javascript:…">`, teks `<img onerror>`, nama berkas `<b>`, judul iklan `<i>`, lokasi `<u>`/`javascript:`, balasan tombol `<a href=//evil>` → tidak ada `a[href]` selain rute aplikasi/`#konten`, tidak ada `img/script/b/i/u`, tidak ada atribut berisi `javascript:` |
| `dir="auto"` / bidi | ✅ | Nama (daftar, kepala chat, panel kontak), cuplikan, teks pesan, kutipan, judul/isi iklan, label lampiran, detail: `dir="auto"` (elemen ber-`dir` = isolasi bidi di UA stylesheet). Server juga sudah membuang pengubah arah dari nama profil/username/nama berkas/URL (review kontak R2). URL iklan dalam `<span>` tanpa `dir`: aman karena `safeHttpUrl` menolak karakter tak terlihat |
| Penyamaran nama profil | ✅ | `contact-identity.ts`/`ConversationItem`: nomor selalu di samping nama yang bukan nomor, dengan penanda "dari WhatsApp" untuk nama profil (tes lama `kontak lengkap: nama tim > profil WhatsApp (+ penanda)…`) |
| Klien WebSocket | ✅ | `inboxStreamUrl` = protokol halaman + `location.host` + rute tetap, tanpa query/token (tes lama). `parseStreamEvent` membatasi ukuran + Zod. 4401/4403 → `stopped`, `onAuthClosed` → `refetchSession` (401 → halaman masuk). Jeda sambung ulang 1–30 dtk. Penjaga baru: 4401 → `/masuk`, tidak ada query `inbox` tersisa, tidak ada socket baru |
| Kebocoran lintas sesi setelah keluar | ✅ | `useLogout` → `endSession` + `clearAppData` (Fase 1). Sesi habis → jalur yang sama. Socket ditutup lewat cleanup `useEffect` saat `InboxScreen` dilepas |
| `?chat=<uuid>` | ✅ | `parseChatId`: hanya pola UUID (huruf kecil), selain itu `undefined`. Penjaga baru: `?chat=..%2F..%2Fauth%2Flogout` diabaikan, tidak ada permintaan ke path ber-`..` atau ke logout |
| 404 saat chat terbuka | ⚠️ R1 | Tampilan langsung "tidak tersedia" tanpa data lama (tes lama). Pesan + baris daftar dibuang, tetapi detail percakapan & kontak masih di cache |
| `POST /read` ber-CSRF | ✅ | `endpoints.inbox.markRead` = `POST` lewat `client.request` (header CSRF otomatis). Tes lama memeriksa `x-csrf-token`. Hanya saat chat terlihat (`visibilityState`) dan ada belum-dibaca |
| Storage / URL / konsol | ✅ | Tidak ada `localStorage`/`sessionStorage`/`console.*` di fitur inbox. Kata pencarian & saringan tidak ditulis ke URL (hanya `tab`, `chat`). Penjaga baru: isi pesan & nomor tidak ada di storage/lokasi router |
| Workaround E2E tidak terbawa ke produksi | ✅ (Info 5) | `releaseInboxReadBudget` hanya di `e2e/tests/pengguna.ts` (paket `e2e`, tidak di-bundle api/worker/web). `grep` `apps/*/src`: tidak ada bendera/env E2E yang melonggarkan batas laju |

---

## B. Temuan

### R1 — Rendah — Cache detail percakapan & kontak tersisa setelah 404

**Bukti.** `ChatRoom.tsx:57-60` memanggil `forgetConversation`, yang di `inbox-queries.ts` hanya melakukan
`removeQueries(messages)` + menyaring baris daftar. Query `inboxKeys.conversation(id)` (TanStack mempertahankan `data`
lama saat refetch gagal) dan `inboxKeys.contact(contactId)` tetap ada. Tes `it.fails` R1: setelah 404, `getQueryData`
detail masih berisi percakapan.

**Dampak.** Data yang sudah tidak boleh dilihat Teknisi (percakapan dialihkan) atau yang sudah dihapus (hapus kontak,
UU PDP) masih ada di memori tab sampai gc (5 menit) atau sampai keluar. Tampilan sudah tidak memakainya, jadi
risikonya hanya bagi orang yang membuka DevTools/ekstensi di perangkat itu. Kecil, tetapi bertentangan dengan maksud
"buang data lama".

**Perbaikan.** Di `forgetConversation` tambahkan `removeQueries({ queryKey: inboxKeys.conversation(id) })` dan
(bila diketahui) `removeQueries({ queryKey: inboxKeys.contact(contactId) })`. Panel kontak sebaiknya menampilkan keadaan
"tidak tersedia", bukan kerangka selamanya. Ubah `it.fails` R1 menjadi `it`.

---

## C. Info

1. **Unduh media (butir 6) belum ada di web.** Saat ditambahkan, ikuti kontrak: `fetch` + `X-CSRF-Token` → `Blob` →
   `URL.createObjectURL`. Jangan `<img src>` langsung ke API. Cabut object URL saat pesan dilepas. Jangan pernah
   menyisipkan media non-gambar inline. Nama berkas unduhan dari `Content-Disposition` server, bukan dari teks pesan.
2. **Teks pesan tidak dijadikan tautan** (termasuk URL di teks). Itu pilihan paling aman sekarang. Bila kelak ada
   "linkify", batasi ke http(s), tampilkan host, beri `rel="noopener noreferrer nofollow"` + `target="_blank"`, dan
   konfirmasi sebelum membuka host di luar daftar tepercaya.
3. **`replyTo`** hanya mencari pesan yang sudah dimuat (`byId`), dan server sudah membatasi tautan ke kontak yang sama
   (review kontak R1), jadi tidak ada pengambilan pesan lintas cakupan dari klien.
4. **Panel kontak menunggu selamanya** (kerangka) saat percakapan 404. UX, bukan keamanan (lihat R1).
5. **Pengaman skrip E2E.** `releaseInboxReadBudget` dan `resetRedis` (`flushdb`, sudah ada sejak Fase 0) memakai
   `E2E_REDIS_URL`/`REDIS_URL` yang bisa diganti lewat env. Salah isi (mis. menunjuk Redis produksi) akan menghapus
   kunci batas laju, bahkan seluruh DB Redis. Saran: tolak host selain `localhost`/`127.0.0.1`/`::1` dan DB index 0,
   seperti `assertTestDatabaseUrl` untuk Postgres.
6. **Working tree saat review.** Perubahan backend yang belum di-commit menambah `nameSource`/`waUsername` wajib pada
   `contactSummarySchema`. `fake-inbox.ts` dan tes inbox web perlu diperbarui bersamaan, kalau tidak respons tiruan
   ditolak skema ("Jawaban server tidak bisa dibaca"). Tes review ini sudah memakai `...fakeConversation().contact`
   sehingga ikut menyesuaikan.

---

## D. Hasil tes yang dijalankan

| Perintah (worktree terlepas di `e9a8098`, sudah dihapus) | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/inbox/security-review-fase2-inbox-web` | 4 lulus + 1 `it.fails` (R1) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi R1 (detail percakapan masih di cache) |
| `apps/web`: `vitest run src/features/inbox src/app` | 79 lulus + 1 `it.fails`, 5 berkas |
| `tsc --noEmit` (apps/web), ESLint, Prettier untuk berkas tes baru | bersih |
