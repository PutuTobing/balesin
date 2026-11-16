# Review keamanan — Fase 2 web: panel detail, Batas kirim & rem darurat, diagnosis webhook, banner

- Commit: `064ee6f` (`feat(inbox): panel detail (tag, kontak, catatan, berkas, log, data pribadi), Pengaturan → Batas kirim & rem darurat, diagnosis webhook`)
- Cakupan: `apps/web` saja (backend rute-rute ini sudah direview: kontak/percakapan, hapus/ekspor, batas kirim)
- Peninjau: subagent `security`
- Model ancaman: akun CS dibobol; penyerang memasukkan HTML/skrip lewat data yang tampil ke Owner
  (nama tag, atribut, catatan, alasan rem, `details` kejadian keamanan) atau ingin data ekspor tertinggal
  di peramban.

## Putusan: **AMAN**

Tidak ada temuan Kritis, Tinggi, Sedang, atau Rendah. Ada 4 catatan Info. Tidak ada `dangerouslySetInnerHTML`,
`innerHTML`, `href` dinamis, `window.open`, `console.*`, atau penulisan storage di berkas yang diubah.

---

## A. Yang diperiksa

| Area | Bukti | Hasil |
|---|---|---|
| Ekspor kontak | `apps/web/src/features/inbox/ContactPrivacy.tsx:39-53`, `apps/web/src/lib/api/endpoints.ts:549-553` | `client.request(..., { csrf: true })` → header `X-CSRF-Token` (pola GET berefek samping, sesuai R1 hapus/ekspor). Data hanya di memori → `Blob` → `URL.createObjectURL` → `<a download>` yang langsung dilepas; URL blob dicabut setelah 10 detik. Alamat permintaan hanya `contactId`, tanpa query. Nama berkas `kontak-<nomor urut>.json` (bukan nomor telepon). Tidak ada localStorage/sessionStorage/IndexedDB; tidak ada persistensi cache TanStack Query |
| Hapus kontak | `ContactPrivacy.tsx:58-65,99-111` | `IdentityDialog requireCode` → `DELETE` dengan `{ confirmation }`; setelah sukses cache kontak & percakapan dibuang. Tombol hanya bila `contacts.delete` (server tetap penegak) |
| Data tampil sebagai teks | `TagPicker.tsx:16-34`, `PanelTabs.tsx:206,348-375`, `ContactEditDialog.tsx` | nama tag, catatan sesi, catatan & atribut kontak, nama pelaku log: node teks React. Warna tag hanya `data-color` (enum palet), bukan `style` |
| Log | `PanelTabs.tsx:348-375` | hanya label jenis, nama pelaku, NAMA isian yang berubah (`CONTACT_FIELD_LABELS`), tanpa nilai |
| Bintang | `MessageTimeline.tsx:114,333-339`, `ChatRoom.tsx` | menu hanya bila `canReply`; server `PUT/DELETE star` = `inbox.reply` + cakupan (`apps/api/src/modules/inbox/panel.routes.ts:142-150`) |
| Batas kirim: guard | `apps/web/src/app/router.ts` (`guardPermission('sending.limits.manage')`), `SettingsPage.tsx:62,183` | Owner/Admin; Supervisor/CS dialihkan (tes lama). Menu hanya dirender bila punya izin |
| Tarik rem | `SendingLimitsPage.tsx:220-284` | dialog alasan (≤ 200, `pauseSendingRequestSchema`), TANPA konfirmasi identitas (arah aman) |
| Lanjutkan & ubah batas | `SendingLimitsPage.tsx:98-112,195-206,330-345,410-423` | `IdentityDialog requireCode`; tombol lanjutkan hanya bila `sending.resume`; galat konfirmasi dilempar ulang ke dialog |
| Alasan rem dari pengguna lain | `SendingLimitsPage.tsx:126-136`, `ChatFooter.tsx:63-79`, `use-sending-paused.ts:6-14` | teks + `dir="auto"`. Alasan/pelaku hanya dimuat oleh pemegang `sending.limits.manage`; agen lain hanya mendapat `paused` boolean (`/inbox/sending-status`) |
| Input angka | `parse-limit.ts` | hanya `^\d{1,9}$` setelah membuang titik/spasi; batas akhir divalidasi Zod & server |
| Kartu diagnosis webhook | `apps/web/src/features/channels/WebhookHealthCard.tsx` | hanya hitungan & waktu, tanpa payload; kueri hanya di halaman nomor (`channels.manage`) |
| Banner → channel | `apps/web/src/features/security-banner/SecurityBanner.tsx` (+`UUID` regex, `canChannels`) | `details.channelId` wajib string + UUID sebelum dipakai sebagai `params` TanStack Link, plus izin `channels.manage`. Jalur relatif / URL penuh / non-string → tidak ada tautan (tes baru) |
| Banner → Batas kirim | sama | tautan statis `/pengaturan/batas-kirim`, hanya bila `sending.limits.manage` |
| Buka lagi di HP | `ChatFooter.tsx:100-110,165-185` | dirender setelah cek `canReply`; server `reopen` = `inbox.reply` (`assignment.routes.ts:105`) |

---

## B. Temuan

Tidak ada.

## C. Info

1. **Data ekspor tetap di cache mutasi** (`useMutation` `data`) sampai komponen dilepas + `gcTime`. Hanya di
   memori tab itu; tidak bocor ke storage. Bila ingin ketat: `exportData.reset()` setelah unduhan dibuat.
2. **Berkas unduhan berisi data pribadi di folder Unduhan perangkat.** Melekat pada fitur (permintaan akses
   data UU PDP); teks `privacyHint` sebaiknya mengingatkan untuk menghapus berkas setelah dikirim ke
   pelanggan.
3. **Log panel menampilkan "sistem" untuk perubahan lewat API key**. Ini konsekuensi R2 review API publik
   (`contact_events` tanpa `api_key_id`), bukan masalah web.
4. **Sisi klien bukan penegak.** Semua guard di commit ini (rute, menu, tombol) cerminan izin server; server
   sudah diuji di review backend masing-masing (403/404 + cakupan).

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/security-review-fase2-panel-batas-kirim.test.tsx` (8 `it`, semua regresi):

- nama tag, catatan kontak, kunci & nilai atribut dengan `<img onerror>` tampil sebagai teks, tanpa elemen tersuntik;
- ekspor: header `X-CSRF-Token`, tanpa query, tidak menulis `Storage`, tidak mencetak data ke console, tautan blob dilepas dari DOM;
- alasan & nama penarik rem berisi HTML tampil sebagai teks;
- CS tidak meminta `GET /settings/sending-limits` walau rem ditarik (alasan/pelaku tidak sampai ke CS);
- banner: `channelId` UUID → `href=/pengaturan/channel/<id>`; `../tim`, URL penuh, angka → tanpa tautan channel.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/security-review-fase2-panel-batas-kirim.test.tsx` | 8 lulus |
| `apps/web`: `vitest run ContactPanel, sending-limits, security-banner, ChannelPage, InboxHandling` | 65 lulus, 5 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 2 moderate dev-only (esbuild via drizzle-kit, minimatch via eslint), tidak ada yang baru |
