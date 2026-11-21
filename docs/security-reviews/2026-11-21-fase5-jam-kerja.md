# Review keamanan — Fase 5: Jam kerja, pesan otomatis, alokasi round-robin

- Sumber: pohon kerja (BELUM di-commit; bercampur pekerjaan Fase 6 Telegram/Email — hanya berkas di bawah
  yang dinilai): `apps/api/src/modules/workspace/*`, `apps/worker/src/queues/workspace.ts`,
  `packages/shared/src/workspace.ts`, `packages/db/src/workspace.ts`, migrasi `0028`
- Kontrak: `docs/KONTRAK-API-INBOX.md` bagian "Jam kerja, pesan otomatis, alokasi (Fase 5)"
- Peninjau: subagent `security`
- Model ancaman: sesi Admin/Owner dicuri (cookie, tanpa password) yang ingin memakai nomor perusahaan
  untuk menipu pelanggan; agen yang ingin mendapat percakapan di luar cakupannya; nama profil WhatsApp
  pelanggan yang memuat variabel/teks buatan.

## Putusan: **AMAN** (dengan 1 temuan Sedang yang sebaiknya diperbaiki)

Tidak ada temuan Kritis/Tinggi. 1 Sedang (S1: teks pesan otomatis ke semua pelanggan baru diubah tanpa
konfirmasi identitas dan tanpa jejak isi), beberapa Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Izin pengaturan | `workspace.routes.ts` | `settings.workspace.manage` (Owner/Admin); CS 403 (tes lama); tulis 30/menit; audit `settings.workspace.updated { changedFields }` & `agent_updated` |
| Saklar ketersediaan | `workspace.routes.ts:127-150` | `inbox.reply`, HANYA milik sendiri (tanpa parameter pengguna), batas laju; Teknisi 409; tidak diaudit (saklar harian) — dapat diterima |
| Round-robin: kelayakan | `apps/worker/src/queues/workspace.ts:110-175` | aktif, peran alokasi, 2FA aktif bila perannya wajib 2FA, `available`, tidak `excluded` (bawaan Owner/Admin dikecualikan), kapasitas `served` < `maxOpenPerAgent`, anggota departemen percakapan; percakapan TANPA departemen tidak ke pengguna bertanda departemen. Tes baru: CS bertanda departemen A tidak menerima percakapan departemen B maupun tanpa departemen, menerima departemen A |
| Round-robin: atomik | `workspace.ts:117-128,143-156` | percakapan & baris agen `FOR UPDATE SKIP LOCKED`, kapasitas dihitung di transaksi yang sama; hanya `unserved` (bot tidak diambil); pelaku sistem; webhook & push |
| Pesan otomatis: jalur kirim | `workspace.ts:260-345` | `sender_kind: system` lewat `processSendMessageJob` (rem darurat + klaim kirim), cek rem darurat & jendela 24 jam sebelum membuat pesan, sekali per sesi (`onConflictDoNothing` slot unik), dilewati dengan `skip_reason` |
| Variabel `{nama}` | `packages/shared/src/workspace.ts:137-146`, `workspace.ts:364-365` | nama tim → nama profil WA (tak tepercaya) dimasukkan SATU putaran: nama profil berisi `{agen}`/`{nama}` tidak diperluas lagi (tes baru); teks hanya dikirim ke pelanggan itu sendiri (tanpa lintas pelanggan); variabel lain ditolak 400 saat simpan |

---

## B. Temuan

### S1 (Sedang) — Teks pesan otomatis ke SEMUA pelanggan baru diubah tanpa konfirmasi dan tanpa jejak isi

- Bukti: `workspace.service.ts:140-165` — `PUT /settings/workspace` mengubah `autoMessages.*.text` &
  `enabled` hanya dengan sesi + CSRF; audit hanya `changedFields` (isi teks sengaja tidak dicatat, tes lama
  `workspace.integration.test.ts:85-93`); tidak ada kejadian keamanan, tidak ada pemeriksa tautan seperti
  `quick_reply_risky`.
- Dampak: sesi Admin/Owner yang dicuri (cookie saja, tanpa password/2FA) bisa mengganti sapaan menjadi
  pesan penipuan ("akun bermasalah, verifikasi di https://…", "transfer ke rekening …"). Pesan itu
  dikirim OTOMATIS dari nomor resmi ke setiap pelanggan yang memulai chat — tanpa persetujuan seperti
  broadcast — dan setelah dikembalikan, tidak ada catatan teks apa yang pernah dikirim (hanya pesan
  per percakapan).
- Perbaikan:
  1. konfirmasi identitas saat MENGAKTIFKAN atau MENGUBAH teks pesan otomatis (arah aman — mematikan —
     tanpa konfirmasi);
  2. catat teks lama & baru di audit (isi pengaturan organisasi, bukan data pelanggan) atau minimal hash
     + panjang;
  3. kejadian keamanan `warning` bila teks memuat tautan/nomor/rekening dan diubah selain Owner (pakai
     detektor `quick_reply_risky`).
- Tes: `it.fails` "S1: mengubah teks pesan otomatis… butuh konfirmasi identitas"
  (`apps/api/src/modules/workspace/security-review-fase5-jam-kerja.integration.test.ts`) — gagal di
  `expected 200 to be greater than or equal to 400`.

---

## C. Info

1. **Saklar ketersediaan tanpa audit**: agen bisa "menghilang" dari round-robin tanpa jejak — operasional,
   bukan keamanan; daftar agen di Pengaturan menampilkan statusnya.
2. **Excluded bawaan Owner/Admin**: bila Owner mematikan pengecualiannya, Owner menerima percakapan otomatis —
   pilihan sadar, diaudit.
3. **`{nama}` dari nama profil WA**: teks bebas pelanggan dikirim balik ke pelanggan itu sendiri (mis. nama
   profil berisi tautan akan muncul di sapaan). Tanpa dampak lintas pelanggan; bisa dibatasi panjang/
   dibersihkan dari URL bila ingin rapi.
4. **Pohon kerja belum di-commit**: hasil di bawah berlaku untuk pohon kerja saat ditinjau; ulangi tes
   penjaga setelah commit gabungan.

---

## D. Tes penjaga

Berkas baru: `apps/api/src/modules/workspace/security-review-fase5-jam-kerja.integration.test.ts` — 2 `it`
(variabel nama profil tidak diperluas lagi; round-robin menghormati departemen) + 1 `it.fails` (S1).

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| Penjaga jam kerja + penjaga akses Fase 5 | 4 lulus + 1 `it.fails` (salinan tanpa `.fails` gagal tepat di asersi S1, sudah dihapus) |
| `apps/api`: `vitest run src/modules/departments src/modules/tickets crm.integration src/modules/reports src/modules/workspace src/modules/realtime permission-grant` | 69 lulus + 1 `it.fails`, 11 berkas |
| `apps/worker`: `vitest run src/queues/workspace.integration.test.ts` | 7 lulus |
| ESLint berkas tes baru | bersih |

---

## Putaran 2 — verifikasi perbaikan (commit `f335d9c`)

| Butir | Bukti | Status |
|---|---|---|
| S1 teks pesan otomatis | `apps/api/src/modules/workspace/workspace.service.ts:160-175`: MENGAKTIFKAN atau MENGUBAH teks pesan otomatis wajib konfirmasi identitas (`workspace.auto_messages`); mematikan tidak (arah aman). `autoMessageAudit` (`:75-97`) mencatat teks lama & baru per jenis (≤ 1.000 karakter) + `risky`/`addedLinks`/`addedNumbers` (detektor balasan cepat) → kejadian keamanan `auto_message_risky` (warning, `apps/api/src/modules/audit/audit.service.ts:100,229`) untuk SIAPA PUN pengubahnya. Tes penjaga S1 `it.fails` → `it` dengan asersi IDENTIK (PUT tanpa konfirmasi ≥ 400, teks tidak berubah) dan lulus | **Tertutup** |

Hasil: `apps/api` `vitest run src/modules/workspace` lulus (bagian dari 95 lulus di laporan
`2026-11-22-fase6-channel.md`). Putusan tetap **AMAN**.
