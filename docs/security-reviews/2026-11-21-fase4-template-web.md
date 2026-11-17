# Review keamanan — Fase 4 web: UI template Meta, kirim template, percakapan baru

- Commit: `f185b2a` (`feat(template): UI template Meta, kirim template & percakapan baru; revisi bot B1–B3`)
- Cakupan: `apps/web/src/features/templates/*` (`TemplatesPage`, `TemplateEditorPage`, `TemplateBubble`,
  `TemplatePicker`, `PresetDialog`, `template-fill.ts`, `template-form.ts`, `template-labels.ts`),
  `features/inbox/TemplateSendDialog.tsx`, `features/inbox/NewConversationDialog.tsx`, rute `app/router.ts`.
  `apps/web` di pohon kerja = HEAD (pekerjaan Fase 5 yang belum di-commit hanya di backend), jadi tes
  dijalankan langsung.
- Peninjau: subagent `security`
- Model ancaman: orang dalam / akun CS dibobol yang ingin membaca kode OTP pelanggan atau memulai
  percakapan ke nomor sembarang; isi template/alasan penolakan Meta/contoh nilai yang memuat HTML;
  ekstensi peramban atau perangkat bersama yang membaca DOM/storage/cache.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang/Rendah. Hanya Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Guard halaman template | `app/router.ts:290-322` (`guardPermission('templates.manage')` untuk daftar, baru, editor) | CS & Teknisi dialihkan (tes baru); daftar template untuk pemilih kirim tetap `inbox.reply` di server |
| Isi template sebagai teks | `TemplateBubble.tsx`, `TemplatesPage.tsx:356-357`, `TemplateEditorPage.tsx:769-770`, `template-labels.ts:11-13` | judul, isi, contoh, footer, teks tombol, alasan penolakan Meta (kode tak dikenal ditampilkan apa adanya sebagai teks) = node teks React / nilai isian. Tes baru dengan `"><img onerror>` di semua isian + alasan penolakan → tidak ada elemen tersuntik |
| Tombol URL di pratinjau | `TemplateBubble.tsx:95-110` | tombol dirender sebagai label + ikon, BUKAN `<a href>`; URL `javascript:…{{1}}` tidak pernah menjadi tautan (tes baru: tidak ada `a[href]` berskema `javascript:` atau memuat `{{1}}`) |
| Respons divalidasi | klien API (`endpoints.ts`, skema bersama) | isi template yang tidak sesuai skema (mis. `example: null`) ditolak klien — tidak dirender setengah |
| Kode OTP / nilai variabel | `TemplateSendDialog.tsx:39-90`, `template-fill.ts` | nilai hanya di `useState` dialog; dikirim lewat `endpoints.inbox.send` LANGSUNG (bukan `useMutation`), lalu dialog ditutup (state hilang) dan daftar pesan dimuat ulang dari server (teks tersamar `••••••`). Tes baru `expectSecretNowhere`: setelah terkirim kode TIDAK ada di cache Query/mutasi, storage, console, HTML dokumen, maupun nilai isian |
| Unggah judul media | `TemplateSendDialog.tsx:66-75` | unggahan memakai jalur unggah percakapan yang sama (aturan jenis/ukuran server); `mediaId` milik pengirim divalidasi server (review template) |
| Percakapan baru | `NewConversationDialog.tsx`, `InboxScreen.tsx:136` | tombol hanya untuk `inbox.initiate` (CS tidak melihat — tes lama); nomor diperiksa bentuk di klien lalu dinormalkan server; 429 batas harian & galat `phone` server tampil sebagai pesan (tes lama); template berjudul media dinonaktifkan (butuh unggahan dalam percakapan) |
| Sink berbahaya | grep `features/templates/*`, dua dialog | tanpa `innerHTML`/`dangerouslySetInnerHTML`/`href` dinamis/`window.open`/`console.*`/storage |

---

## B. Temuan

Tidak ada.

## C. Info

1. **Nilai isian terkendali React** (termasuk kode OTP) sempat ada di atribut `value` input selama dialog
   terbuka — perilaku normal formulir; hilang saat dialog ditutup. Bila ingin lebih ketat untuk OTP:
   `autoComplete="one-time-code"` tidak relevan (agen mengetik kode milik sistem lain) — cukup dibiarkan.
2. **Kode OTP tetap tercatat di permintaan jaringan** (DevTools tab Network peramban agen) — melekat pada
   pengiriman; agen yang mengirim kode memang mengetahuinya.
3. **`pnpm audit` kini 3 temuan**: baru `picomatch ≤ 4.0.7` (high, ReDoS extglob) lewat
   `apps/worker > tsup > sucrase > tinyglobby > fdir` — alat BUILD saja dengan pola glob milik kita, tidak
   menerima masukan pengguna dan tidak ikut runtime; belum ada versi perbaikan. Pantau `pnpm check:deps`.
   Dua moderate lama (esbuild via drizzle-kit, minimatch via eslint) tetap dev-only.

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/security-review-fase4-template-web.test.tsx` — 3 `it`: isi template /
alasan penolakan / contoh / tombol berisi HTML tampil sebagai teks dan tombol URL tidak menjadi tautan
(daftar + editor); CS & Teknisi dialihkan dari Pengaturan → Template; kode OTP tidak tersisa di
cache/storage/console/DOM/isian setelah terkirim.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run` berkas penjaga + `src/features/templates` + `TemplateSend` + `ChatComposer` | 41 lulus, 4 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 1 high (picomatch, build-only, lihat Info 3) + 2 moderate dev-only |
