# Review keamanan — Fase 3 web: Pengaturan → API key & Webhook

- Commit: `4e53378` (`feat(web): tampilan HP penuh, Pengaturan → API key & Webhook, revisi notifikasi N1`)
- Cakupan: `apps/web/src/features/integrations/*` (`ApiKeysPage`, `ApiKeyCreateDialog`, `SecretDialog`,
  `WebhooksPage`, `WebhookFormDialog`, `WebhookDeliveriesDialog`), rute & menu Pengaturan,
  `lib/use-visual-viewport.ts` (sekilas), perbaikan R1 PWA.
- Peninjau: subagent `security`
- Model ancaman: perangkat bersama / ekstensi peramban yang membaca storage atau DOM, rahasia yang
  tertinggal di cache aplikasi, HTML/skrip dari URL/potongan jawaban penerima webhook, akun CS dibobol.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang/Rendah. Hanya Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Rahasia tampil sekali | `SecretDialog.tsx`, `ApiKeysPage.tsx:42,119-145`, `ApiKeyCreateDialog.tsx:94-96`, `WebhooksPage.tsx:51,153-160,209-214`, `WebhookFormDialog.tsx:65` | Dibuat/dirotasi lewat panggilan `endpoints.*` langsung (BUKAN `useMutation`/`useQuery`), rahasia hanya di `useState` halaman → `SecretDialog` sebagai TEKS `<code>`; "Selesai" → `setSecret(null)`. Daftar diperbarui dengan `invalidateQueries` (respons daftar tidak memuat rahasia). Tes baru: selama dialog terbuka dan setelah ditutup rahasia tidak ada di cache Query, cache mutasi, `Storage.setItem`, atribut DOM mana pun, maupun `console.*`; setelah ditutup tidak ada di DOM sama sekali. Berlaku untuk `blsn_live_` dan `whsec_` (rotasi) |
| Salin | `components/ui/CopyButton.tsx:56` | `navigator.clipboard.writeText(text)`; tidak menaruh nilai di atribut/`title` |
| Konfirmasi identitas | `ApiKeyCreateDialog`, `WebhooksPage` (`IdentityDialog requireCode`) | buat key, buat webhook, ganti URL, rotasi, allowlist = konfirmasi; cabut key, nonaktif, hapus webhook = dialog biasa (arah aman) — sesuai kontrak (tes lama) |
| Data tampil sebagai teks | `ApiKeysPage`, `WebhooksPage`, `WebhookDeliveriesDialog.tsx:58,117-136` | nama key, pembuat, URL webhook (`description` dialog), keterangan, kode galat, potongan jawaban (`<pre>{…}</pre>`) = node teks React. Tes baru dengan `"><img onerror>` di nama key, pembuat, URL, keterangan, dan potongan → tidak ada elemen tersuntik |
| Tautan dokumentasi | `ApiKeysPage.tsx:288-296` | `href` statis `API_DOCS_ROUTES.page`, `target="_blank"` + `rel="noopener noreferrer"` |
| Guard rute & menu | `app/router.ts` (`guardPermission('api_keys.manage')`, `'integrations.manage'`), `SettingsPage.tsx` | Owner/Admin saja; CS & Supervisor dialihkan TANPA satu pun permintaan ke `/settings/api-keys` atau `/settings/webhooks` (tes baru) |
| Allowlist CIDR | `WebhooksPage.tsx:357-420` | textarea → `PUT` + konfirmasi; validasi akhir di server (hanya CIDR privat — review webhook keluar) |
| Sink berbahaya | grep berkas yang diubah | tanpa `innerHTML`/`dangerouslySetInnerHTML`/`window.open`/`console.*`/storage baru; satu-satunya `href` lain = `#konten` statis |
| `use-visual-viewport.ts` | | hanya `style.height`/`transform` dari angka `visualViewport`; tidak ada masukan pengguna. Tidak relevan keamanan |
| PWA R1 | `sw/push-payload.ts` `resolveAppUrl` | menolak pathname `//…` atau berisi `\` setelah normalisasi, mengembalikan `origin + pathname + search` ternormalisasi; tes penjaga kini `it` (lihat Putaran 2 laporan PWA) |

---

## B. Temuan

Tidak ada.

## C. Info

1. **Potongan jawaban di riwayat** ditampilkan apa adanya ke Owner/Admin (aman sebagai teks). Bila penerima
   memantulkan body webhook format MobiChat, potongan bisa berisi API key — lihat **S1** di
   `2026-11-19-fase3-kompat-mobichat.md` (perbaikan di worker; UI tidak perlu berubah selain menampilkan
   `[DISENSOR]`). Respons riwayat juga tersimpan di cache Query selama dialog terbuka.
2. **Formulir web belum mendukung format MobiChat** (tempel API key ke webhook). Saat ditambahkan: isian
   key wajib `type="password"`/`autocomplete="off"`, tidak disimpan di state setelah terkirim, dan
   jawaban hanya `apiKeyLast4` — tambahkan tes penjaga yang sama (`expectSecretNowhere`).
3. **Papan klip** tetap menyimpan rahasia setelah disalin (melekat pada fitur salin); teks dialog sudah
   mengingatkan untuk menyimpannya di tempat aman.
4. **URL webhook lengkap** (bisa memuat token penerima di path/query) tampil ke Owner/Admin di daftar dan
   judul riwayat — wajar untuk pengelola; audit tetap hanya host.

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/integrations/security-review-fase3-integrasi.test.tsx` — 4 `it`:
rahasia API key sekali (tidak di cache/mutasi/storage/atribut/console; hilang setelah ditutup); CS &
Supervisor dialihkan tanpa permintaan API; URL/keterangan/potongan sebagai teks; rotasi `whsec_` sekali
dengan pemeriksaan yang sama.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run …/security-review-fase3-integrasi.test.tsx` | 4 lulus |
| `apps/web`: `vitest run src/features/integrations src/sw src/features/settings src/features/security-banner src/features/notifications` | 63 lulus, 7 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
