# Review Keamanan — Fase 2: penanganan chat & template "/" (web)

- Tanggal: 2026-11-18
- Peninjau: agent `security`
- Cakupan: commit `78a46dc` `feat(inbox): tandai selesai/buka lagi/alihkan/kembalikan, template "/" + Pengaturan → Template
  percakapan, revisi ruang chat C1–C7`. Berkas yang diperiksa:
  - inbox: `apps/web/src/features/inbox/{HandlingActions,QuickReplyPicker,Composer,ChatRoom,MessageTimeline}.tsx`,
    `quick-replies.ts`, `inbox-queries.ts`, `message-media.ts`;
  - pengaturan: `apps/web/src/features/quick-replies/**`, `apps/web/src/features/settings/SettingsPage.tsx`;
  - inti: `apps/web/src/app/router.ts`, `apps/web/src/lib/api/{endpoints,queries}.ts`;
  - E2E: `e2e/stack/start-backend.mjs`.

  Verifikasi R1/R2 composer ada di "Putaran 2" `2026-11-18-fase2-composer-web.md`.
- Acuan: `docs/KONTRAK-API-INBOX.md` "Penanganan percakapan", "Quick reply", review backend butir 7 & 8–9, review
  composer web.
- Model ancaman:
  - template yang ditanam akun Supervisor/Admin curian (HTML/tautan/variabel);
  - Teknisi yang mencoba aksi/halaman di luar izinnya;
  - data lama yang tetap tampil setelah akses dicabut;
  - skrip E2E yang menghapus folder salah.
- Lingkungan uji: Vitest + jsdom, API tiruan. Stack E2E/kritikus tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, Sedang, atau Rendah baru.

- **Penanganan chat:** tindakan tampil sesuai izin `useCan` (`inbox.reply` untuk selesai/buka lagi/kembalikan
  milik sendiri, `inbox.assign` untuk alihkan/kembalikan milik orang lain). Server tetap penentu (403/404/409). Jawaban
  `{ conversation: null }` → `forgetConversation` (pesan, detail, kontak, baris daftar dibuang) lalu chat ditutup. 409
  → pesan server sebagai teks + muat ulang detail. Daftar agen hanya dimuat bila `inbox.assign`, jadi Teknisi tidak
  memicu 403 (penjaga baru).
- **Template "/":**
  - judul & isi template dari server dirender sebagai teks (`dir="auto"`), tanpa tautan aktif (penjaga baru dengan
    `<img onerror>`, `<b>`, URL);
  - klien TIDAK mengganti `{nama}`/`{agen}`: memilih template memanggil `POST /quick-replies/:id/use` (CSRF,
    cakupan dicek server) dan memasukkan teks jawaban ke composer;
  - agen melihat teks sebelum mengirim lewat endpoint kirim biasa.
- **Pengaturan → Template percakapan:** rute `beforeLoad: guardPermission('quick_replies.manage')`, menu hanya untuk
  pemegang izin. Validasi klien hanya kemudahan (server memvalidasi shortcut/variabel/panjang). Penjaga baru: Teknisi
  dialihkan tanpa memanggil API template.
- **E2E `resetMediaDir`:** hanya folder bernama `balesin-e2e-media` di bawah `os.tmpdir()` (Info 1).

| # | Level | Ringkas |
|---|---|---|
| Info 1–3 | Info | Lihat bagian B |

Tes baru di `apps/web/src/features/inbox/security-review-fase2-penanganan-template-web.test.tsx`, 4 penjaga, semua
lulus:
- template berbahaya tetap teks, dan isi composer = jawaban server (CSRF);
- Teknisi tidak memanggil `/inbox/agents`;
- Teknisi dialihkan dari halaman template tanpa panggilan API;
- `safeBlob` membungkus SVG/HTML/tanpa tipe → `octet-stream`, `IMAGE/PNG; …` → `image/png`.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Tindakan sesuai izin | ✅ | `HandlingActions.tsx`: tanpa `inbox.reply` tidak ada menu. "Kembalikan" hanya bila `inbox.assign` atau chat milik sendiri. "Alihkan" hanya `inbox.assign`. Agen dimuat `enabled: open`, dan pemicunya hanya untuk `inbox.assign`. `ChatRoom`/`InboxScreen` `enabled: canAssign`. Tes lama `InboxHandling.test.tsx` |
| `{ conversation: null }` membuang cache | ✅ | `onSuccess` → `forgetConversation` (sejak perbaikan review web inbox R1 juga detail & kontak) → `onClosed`. Tes lama "kembalikan oleh Teknisi → chat ditutup" |
| 409 | ✅ | Pesan server ditampilkan (`onError`), detail percakapan dimuat ulang. Tes lama "409 konflik" |
| Isi template tetap teks | ✅ | `QuickReplyPicker.tsx` merender `item.title`/`item.body` sebagai teks. Penjaga baru |
| Tidak ada eksekusi variabel di klien | ✅ | `Composer.tsx` → `endpoints.quickReplies.use(id, { conversationId })` → `setText(filled)`. Tidak ada `replace` variabel di klien. `slashQuery` hanya `^/[^\s/]{0,50}$`. Penjaga baru: composer = jawaban server, permintaan ber-CSRF |
| Guard rute `quick_replies.manage` | ✅ | `router.ts` `quickRepliesRoute.beforeLoad`. `SettingsPage` `useCan('quick_replies.manage')`. Tes lama (CS dialihkan) + penjaga baru (Teknisi, tanpa panggilan API) |
| Validasi | ✅ | Formulir memakai aturan bersama (shortcut, panjang, variabel dikenal). Server memvalidasi ulang (400) dan mengaudit isi (`quick_reply.*`, `quick_reply_risky`) |
| R1/R2 composer | ✅ | Lihat "Putaran 2" laporan composer web |
| `start-backend.mjs` | ✅ (Info 1) | `resetMediaDir`: `path.resolve(MEDIA_DIR)`, wajib `basename === 'balesin-e2e-media'` dan berada di bawah `os.tmpdir()`, lalu `rm -r` |

---

## B. Info

1. **Pemeriksaan "di bawah tmpdir" memakai `startsWith`** tanpa pemisah path: `C:\…\Temp2\balesin-e2e-media` juga
   lolos. Karena nama folder wajib `balesin-e2e-media` dan skrip hanya untuk dev, risikonya praktis nol. Lebih rapi:
   `const rel = path.relative(os.tmpdir(), resolved); rel && !rel.startsWith('..') && !path.isAbsolute(rel)`. Di
   Windows bandingkan tanpa beda huruf.
2. **Pilihan template memakai jatah `quick-reply-pakai`** (240/menit) setiap kali dipilih, termasuk bila agen
   membatalkan. Wajar.
3. **Isi template bisa memuat tautan** (sengaja, mis. tautan resmi perusahaan). Tidak dijadikan tautan aktif di web.
   Penjagaan terhadap tautan yang ditanam penyerang ada di server (audit isi + `quick_reply_risky`, lihat R2 review
   push untuk pola TLD).

---

## C. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/inbox/security-review-fase2-penanganan-template-web` | 4/4 lulus |
| `apps/web`: `vitest run src/features src/app src/lib` | 434/434 lulus, 35 berkas (termasuk 2 tes R1 composer yang kini `it`) |
| ESLint + `tsc --noEmit` (apps/web) | bersih |
