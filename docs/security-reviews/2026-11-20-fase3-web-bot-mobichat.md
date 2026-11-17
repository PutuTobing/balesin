# Review keamanan — Fase 3 web: UI bot, pesan interaktif, webhook MobiChat

- Commit: `4162349` (`feat(web): UI bot & pesan interaktif, webhook mode MobiChat, revisi HP/integrasi, perbaikan bug status gagal`)
- Cakupan: `features/channels/BotCard.tsx`, `bot-form.ts`; `features/inbox/HandlingActions.tsx`,
  `InteractiveDialog.tsx`, `MessageTimeline.tsx`, `message-content.ts`; `features/integrations/
  WebhookFormDialog.tsx`, `WebhooksPage.tsx`; `features/auth/session.ts`; `vite.config.ts`; perubahan
  stack E2E (`e2e/stack/env.ts`, `start-backend.mjs`, `e2e/tests/owner-kedua.ts`, `playwright.config.ts`).
- Peninjau: subagent `security`
- Model ancaman: perangkat bersama / ekstensi yang membaca DOM, storage, atau cache; isi tombol/daftar dari
  bot atau pelanggan yang memuat HTML; akun CS dibobol; konfigurasi dev yang terbawa ke produksi.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang/Rendah. Hanya Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Kartu bot channel | `ChannelPage.tsx` (`useCan('integrations.manage')`), `BotCard.tsx:97,253-266` | dirender hanya untuk `integrations.manage` (halaman nomor sendiri `channels.manage`); mematikan bot lewat `ConfirmDialog` (danger) yang menjelaskan percakapan bot diserahkan ke tim; server penegak (review bot) |
| Aksi bot di ruang chat | `HandlingActions.tsx` | Seluruh menu hanya bila `inbox.reply`; "Ambil alih" hanya bila `inbox.assign`; "Serahkan ke tim" hanya saat status `bot`; "Kembalikan ke bot" bila bukan bot & belum selesai — server memutuskan (409 bot channel mati / 403 chat agen lain), pesan server tampil apa adanya (tes lama) |
| Isi interaktif keluar | `MessageTimeline.tsx` `InteractiveChoices`, `message-content.ts` | judul bagian, baris, deskripsi, footer, `buttonText`, header = node teks React (`dir="auto"`); tidak ada `href`/HTML. Tes baru dengan `"><img onerror>` di semua isian daftar → tidak ada elemen tersuntik |
| Balasan pelanggan (tak tepercaya) | `message-content.ts`, `MessageTimeline.tsx` | `interactive { id, title, description }` + teks ditampilkan sebagai teks; `id` tidak dipakai untuk URL/aksi (tes baru) |
| Penyusun interaktif | `InteractiveDialog.tsx` | validasi skema bersama (batas Meta) sebelum kirim; server memvalidasi ulang (review bot) |
| API key MobiChat | `WebhookFormDialog.tsx:41-90,329-340`, `components/ui/Field.tsx:195-206` (`SecretField`: `type=password`, `autocomplete=new-password`, abaikan pengelola sandi) | Isian TAK TERKENDALI dibaca lewat ref saat simpan lalu dikosongkan; jawaban server hanya `apiKeyLast4` + status. Tes lama: setelah buat/ganti key `expectSecretNowhere` (cache Query & mutasi, storage, console, DOM/atribut, nilai isian). Tes baru: SELAMA dialog konfirmasi identitas terbuka, setelah DIBATALKAN (tanpa permintaan terkirim), dan setelah server MENOLAK key (400) — key tidak ada di mana pun |
| Ganti key / alamat balik / URL | `WebhookFormDialog.tsx:128-160` | wajib konfirmasi identitas; peringatan `http://` (`httpUsed`) |
| Rotasi `revokePrevious` | `WebhooksPage.tsx:213-229,365-400` | opsi di dialog lalu `IdentityDialog` (konfirmasi tetap wajib); rahasia baru lewat `SecretDialog` sekali (review integrasi web) |
| Logout | `features/auth/session.ts` | `cancelQueries()` sebelum sesi dicabut — permintaan yang masih berjalan tidak mengisi ulang cache dengan data setelah keluar (perbaikan, bukan risiko) |
| `BALESIN_DEV_NO_HMR` | `apps/web/vite.config.ts:25`, `e2e/viewports.ts:36` | hanya di blok `server` (dev server Vite); tidak memengaruhi `vite build`, tidak di Dockerfile/compose. Aman |
| Folder media per stack | `e2e/stack/env.ts`, `start-backend.mjs` | `balesin-e2e-media-<port>` di `tmpdir`, penjaga nama + lokasi sebelum mengosongkan (tidak bisa menghapus folder lain) |
| Owner kedua E2E | `e2e/tests/owner-kedua.ts` | menulis langsung ke database E2E (`balesin_e2e`, `E2E_DATABASE_NAME`) lewat `e2eSql`; hanya kode tes, password = password Owner E2E tiruan; tidak ikut build produk |
| Sink berbahaya | grep berkas web yang diubah | tanpa `innerHTML`/`dangerouslySetInnerHTML`/`window.open`/`console.*`/storage; `href` hanya `#id` statis & `/api/docs` statis |

---

## B. Temuan

Tidak ada.

## C. Info

1. **Komentar `WebhookFormDialog` sedikit berlebihan**: key MobiChat memang tidak di DOM/cache/storage,
   tetapi SEMPAT di state React (`confirming.body.mobichat.apiKey`) selama dialog konfirmasi terbuka —
   dibuang saat konfirmasi selesai, dibatalkan, atau gagal. Tidak terlihat dari luar proses (hanya
   React DevTools/memori); cukup perbaiki komentar.
2. **"Kembalikan ke bot" tampil untuk semua pemegang `inbox.reply`** termasuk pada chat agen lain; server
   menolak bila tidak berhak (403 + audit). Bisa disembunyikan bila `assignee` ≠ diri sendiri dan tidak
   punya `inbox.assign` (kosmetik).
3. **`e2eSql`** menyambung ke `E2E_ADMIN_DATABASE_URL` dengan nama database tetap `balesin_e2e`; tetap
   jalankan stack E2E hanya di mesin pengembang/CI (sudah begitu).

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/security-review-fase3-web-bot-mobichat.test.tsx` — 3 `it`:
key MobiChat tidak ada di DOM/isian/cache/storage/console selama konfirmasi & setelah dibatalkan (tanpa
permintaan); setelah server menolak key (400); isi daftar interaktif keluar + balasan pelanggan berisi HTML
tampil sebagai teks.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run` berkas penjaga + `src/features/integrations` + `BotInteractive` + `BotCard` + `src/features/auth` | 51 lulus, 7 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
