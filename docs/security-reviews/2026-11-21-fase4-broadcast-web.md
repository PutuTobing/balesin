# Review keamanan — Fase 4 web: UI broadcast, konektor data, alarm Telegram

- Commit: `83a4e87` (`feat(broadcast): UI broadcast — daftar, wizard, detail & laporan, persetujuan, konektor data, alarm Telegram; revisi template TM1–TM3`)
- Cakupan: `apps/web/src/features/broadcast/*` (`BroadcastPage`, `BroadcastWizard`, `BroadcastCampaignPage`,
  `BroadcastSettingsCard`, `ConnectorsPage`, `TelegramAlarmPage`, `broadcast-logic.ts`,
  `broadcast-queries.ts`), rute `app/router.ts`, menu `components/shell/nav-items.ts`,
  `lib/api/endpoints.ts`. Pohon kerja `apps/web` = HEAD.
- Peninjau: subagent `security`
- Model ancaman: akun CS/Supervisor dibobol; isi CSV/konektor buatan pelanggan atau sistem billing
  (nama kolom, nilai, label sumber) yang memuat HTML; ekstensi peramban/perangkat bersama yang membaca
  DOM/storage/cache; rahasia (header konektor, token bot Telegram) tertinggal di peramban.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang/Rendah. Hanya Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Guard rute | `app/router.ts:215-245` (`/broadcast*` → `navPermission('/broadcast')` = `broadcast.send`), `:375-395` (konektor & alarm → `integrations.manage`) | CS & Teknisi dialihkan dari Broadcast, Konektor data, Alarm TANPA satu pun permintaan ke API-nya (tes baru) |
| Persetujuan | `BroadcastCampaignPage.tsx:244-300` | tombol Setujui/Tolak hanya untuk `broadcast.approve` dan BUKAN pembuat (`createdBy.id !== sesi`); setujui & lanjutkan lewat `IdentityDialog`; lanjut dari rem otomatis/darurat dinonaktifkan tanpa `sending.resume` (tes lama). Server tetap penegak (`broadcast.approve.own`, `broadcast.resume.brake`) |
| Data CSV/penerima sebagai teks | `BroadcastWizard.tsx`, `BroadcastCampaignPage.tsx` | nama kampanye, nama kolom, label sumber (nama berkas), alasan penolakan, alasan gagal laporan & per penerima = node teks React. Tes baru dengan `"><img onerror>` di semua isian itu → tidak ada elemen tersuntik |
| Unggah berkas | `endpoints.ts` (multipart) | dikirim apa adanya; jenis/ukuran/parsing di server (thread terisolasi, review broadcast putaran 2) |
| Ekspor CSV | `BroadcastCampaignPage.tsx:293-303`, `endpoints.ts:1016-1019` (`client.download`, header CSRF + ulang sekali bila basi) | hanya `contacts.export`, tidak saat `pending_approval`; Blob URL dicabut segera setelah klik; tidak ada data di URL/storage (tes lama "ekspor CSV lewat GET ber-CSRF ke Blob") |
| Header rahasia konektor | `ConnectorsPage.tsx:234-320,382-390` (`SecretField` + ref) | isian tak terkendali, dibaca saat simpan, dikosongkan setelah tersimpan; jawaban server hanya `authHeaderTail`; peringatan parameter rahasia di URL (tes lama `expectSecretNowhere` setelah simpan) |
| Token Telegram | `TelegramAlarmPage.tsx:67-120,175-180` (`SecretField` + ref) | token dibaca saat simpan, hanya di state `pending` selama dialog konfirmasi, dibuang sesudahnya; isian dikosongkan setelah tersimpan; "kosongkan untuk tetap memakai" → token tidak dikirim. Tes baru: SELAMA dialog konfirmasi terbuka dan SETELAH dibatalkan, token tidak ada di cache Query/mutasi, storage, console, maupun HTML (atribut/teks); tidak ada PUT terkirim |
| Kartu Broadcast di Batas kirim | `BroadcastSettingsCard.tsx` | `sending.limits.manage`; Admin melihat bahwa melonggarkan hanya Owner (tes lama); server penegak |
| Sink berbahaya | grep `features/broadcast/*` | tanpa `innerHTML`/`dangerouslySetInnerHTML`/`href` dinamis/`window.open`/`console.*`/storage; satu `createObjectURL` untuk unduhan ekspor |

---

## B. Temuan

Tidak ada.

## C. Info

1. **Token Telegram / nilai header tetap di isian bila konfirmasi dibatalkan atau server menolak** (nilai
   properti `value` input sandi tak terkendali, bukan atribut HTML) supaya pengguna bisa mencoba lagi;
   hilang saat halaman ditinggalkan. Perilaku formulir yang wajar.
2. **Komentar komponen `TelegramAlarmPage`**: token sempat di state React `pending` selama dialog
   konfirmasi (dibuang sesudahnya) — sama dengan pola formulir webhook MobiChat; tidak terlihat dari luar
   proses.
3. **Data pelanggan di laporan** (nomor penerima, alasan gagal) dimuat ke cache Query selama halaman
   kampanye terbuka — wajar untuk tampilan; tidak disimpan ke storage.
4. **`pnpm audit`**: 1 high `picomatch` (build-only, DECISIONS) + 2 moderate dev-only — tidak berubah.

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/broadcast/security-review-fase4-broadcast-web.test.tsx` — 3 `it`:
isi kampanye/kolom CSV/label sumber/alasan penolakan/alasan gagal berisi HTML tampil sebagai teks; token
Telegram tidak bocor selama konfirmasi & setelah dibatalkan (tanpa PUT); CS & Teknisi dialihkan dari
Broadcast, Konektor data, Alarm tanpa memanggil API-nya.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/broadcast src/features/sending-limits src/features/settings` (+ penjaga baru) | 29 lulus, 4 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 1 high build-only + 2 moderate dev-only (tidak berubah) |
