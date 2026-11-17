# Review keamanan — Fase 5 backend: CRM, tiket, departemen, laporan, CSAT

- Commit: `c5668a3` (`feat(crm): Fase 5 backend — kontak (atribut, impor/ekspor, gabung), tiket multi-board, departemen, laporan & biaya Meta, CSAT`)
- Kontrak: `docs/KONTRAK-API-CRM-TIKET.md`, `docs/KONTRAK-API-LAPORAN.md`; DECISIONS 2026-11-21
- Peninjau: subagent `security`
- Model ancaman: pegawai (CS/Teknisi) yang ingin melihat percakapan di luar cakupannya; akun CS dibobol;
  API key bot bocor; pelanggan yang mengirim jawaban CSAT buatan; pengguna laporan yang membebani DB.

## Putusan: **AMAN** (dengan 1 temuan Sedang yang sebaiknya segera diperbaiki)

Tidak ada temuan Kritis/Tinggi. 1 Sedang (S1: batas departemen bisa ditembus lewat tiket milik sendiri),
beberapa Info. Perubahan inti cakupan (`scopeCondition`) sendiri benar dan dibaca segar dari database.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| `scopeCondition` departemen | `apps/api/src/modules/auth/permission-grant.ts` (`departmentRestricted`, `departmentNarrowed`) | Hanya izin `DEPARTMENT_SCOPED_PERMISSIONS` (inbox.view/reply/assign, tickets.manage) bercakupan `all` yang disempitkan; tanda dibaca di query yang SAMA (tanpa cache sesi → pencabutan langsung berlaku); hanya Supervisor/CS (Owner/Admin penuh walau tanda tertinggal); percakapan tanpa departemen hanya terlihat bila dipegang/terkait tiket. CS bertanda: daftar tanpa percakapan departemen lain, detail 404 (tes baru) |
| Cek in-memory (hub/worker) | `packages/db/src/access.ts` | `departmentAccessOf` & `openTicketHoldersOf` dibaca segar per batch/kirim; padanan SQL |
| Teknisi "terkait tiket" | `tickets.service.ts`, `tickets.integration.test.ts:166-297` | hanya tiket TERBUKA yang ia pegang; hilang saat tiket ditutup; Teknisi tidak bisa mengubah penanggung jawab/tautan (`ticket.own.restricted_fields`); tiket buatannya selalu miliknya dan tautan hanya ke data yang ia lihat (tes lama) |
| Kontak — ekspor massal | `crm.routes.ts:156-180` | `contacts.export` + konfirmasi identitas + batas; CSV kebal rumus; audit tanpa data pribadi (tes lama) |
| Kontak — gabung | `crm.routes.ts:258-285`, `crm.service.ts` | `contacts.manage` + konfirmasi identitas + 30/jam; identitas WhatsApp berbeda / percakapan terbuka di channel sama / lintas organisasi ditolak (tes lama) |
| Atribut kustom | `attributes.service.ts`, `packages/shared/src/crm.ts` | kelola = `settings.workspace.manage`; nilai divalidasi & dibakukan per jenis; atribut disimpan sebagai ARRAY `{ key, value }` (bukan objek berkunci) → `__proto__`/`constructor` tidak bermakna |
| Laporan | `reports.routes.ts:31-34`, `reports.service.ts:46-81` | `reports.view` (CS/Teknisi `own`), organisasi = cakupan `all`; `statement_timeout` 8 dtk, rentang ≤ 92 hari, 30 baca/menit; nama kolom SQL dari konstanta internal; ekspor CSV `requireCsrf`, 10/jam, diaudit, kebal injeksi rumus (tes lama) |
| CSAT | `apps/worker/src/inbound/csat-replies.ts` | skor HANYA dari ID baris `csat:<survei>:<1–5>` (regex ketat), survei milik kontak + channel pengirim, `sent`, ≤ 24 jam; judul/teks balasan diabaikan; komentar ≤ 500 karakter dibersihkan; pengaturan Owner/Admin, tautan ditolak, diaudit; survei dikirim lewat jalur kirim biasa (rem darurat berlaku) |
| API key tiket | `public-tickets.routes.ts` | `tickets:read`/`tickets:write`; data organisasi key; webhook `ticket.*` |

---

## B. Temuan

### S1 (Sedang) — CS bertanda departemen menembus batas departemen lewat tiket miliknya

- Bukti:
  - `permission-grant.ts` `departmentNarrowed`: akses "terkait tiket" (`linkedTicketHolder`) berlaku juga
    untuk pengguna bertanda departemen;
  - kontak sengaja TIDAK dibatasi departemen (`DEPARTMENT_SCOPED_PERMISSIONS` tanpa `contacts.view`), jadi
    CS bertanda bisa menautkan kontak mana pun ke tiket;
  - CS bertanda boleh membuat tiket di board departemennya (atau board lain asalkan memegangnya sendiri,
    `departments.integration.test.ts:283-290`) dengan `assigneeUserId` = dirinya.
- Akibat: satu `POST /tickets { boardId, assigneeUserId: dirinya, contactId: X }` membuka SEMUA percakapan
  kontak X — termasuk percakapan departemen lain dan riwayat lama yang sudah selesai (detail + pesan).
  Tercatat sebagai tiket, tetapi batas "akses hanya departemen sendiri" yang diatur Owner tidak berlaku.
- Perbaikan (pilih yang sederhana):
  1. untuk pengguna bertanda departemen, akses "terkait tiket" hanya ke percakapan yang departemennya
     termasuk departemen pengguna (atau tanpa departemen), bukan semua percakapan kontak; ATAU
  2. saat menautkan kontak/percakapan ke tiket, pengguna bertanda hanya boleh menaut percakapan yang SUDAH
     ia lihat, dan akses tiket hanya ke percakapan yang ditautkan eksplisit (bukan seluruh kontak).
- Tes: `it.fails` "S1: CS bertanda tidak bisa membuka percakapan departemen lain…"
  (`apps/api/src/modules/departments/security-review-fase5-akses.integration.test.ts`) — gagal di
  `expected 200 to be 404`.

---

## C. Info

1. **API key `tickets:write` bisa menaut kontak mana pun DAN menetapkan penanggung jawab** (mis. Teknisi)
   → membuka seluruh riwayat percakapan kontak itu untuk Teknisi tersebut. Key dibuat Owner/Admin dan
   diaudit; pertimbangkan melarang key menetapkan `assigneeUserId` ke pengguna bercakupan `assigned`/`own`,
   atau mencatat kejadian keamanan bila tiket dari key memberi akses Teknisi.
2. **Pengguna yang dipindah keluar departemen tidak menerima `conversation.removed`** dari hub real-time:
   data yang sudah tampil tetap di layar sampai dimuat ulang; event baru tidak lagi dikirim, REST menolak.
   Tidak ada kebocoran data baru; kirim sinyal `resync`/`conversation.removed` saat akses berubah agar UI
   rapi.
3. **Impor kontak memakai izin `contacts.export`** (Owner/Admin/Supervisor) — lebih ketat dari
   `contacts.manage`, jadi aman, tetapi namanya menyesatkan. Mode `update` dapat menimpa nama/email/atribut
   ribuan kontak TANPA konfirmasi identitas (hanya diaudit sekali); pertimbangkan konfirmasi untuk impor
   non-`dryRun` atau setidaknya untuk mode `update`.
4. **Gabung kontak (permanen) tersedia untuk CS** (`contacts.manage`) sementara hapus kontak hanya
   Owner/Admin. Konfirmasi identitas + 30/jam membatasi, tetapi akun CS dibobol bisa mengacak CRM secara
   permanen. Pertimbangkan `contacts.delete` untuk gabung.
5. **Laporan**: 30 baca/menit × hingga 8 dtk per query per pengguna — beberapa pengguna laporan dapat
   memegang banyak koneksi pool DB. Pertimbangkan batas laporan berjalan bersamaan per organisasi.
6. **Komentar CSAT** = pesan pelanggan berikutnya dalam jendela survei; bisa memuat data pribadi (alamat,
   nomor) dan ikut laporan/ekspor. Ekspor sudah kebal rumus; cukup dicatat di kebijakan retensi.
7. **Pohon kerja**: perubahan `packages/shared/src/departments.ts` dkk. (jam tim, belum di-commit) membuat
   `tsc` apps/api gagal (`teamHours`). Bukan dari commit ini.
8. **`pnpm audit`**: 1 high `picomatch` (build-only, sudah dicatat DECISIONS) + 2 moderate dev-only.

---

## D. Tes penjaga

Berkas baru: `apps/api/src/modules/departments/security-review-fase5-akses.integration.test.ts` — 1 `it`
(CS bertanda tidak melihat percakapan departemen lain: daftar & detail 404) + 1 `it.fails` (S1).

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| Tes penjaga | 1 lulus + 1 `it.fails` (salinan tanpa `.fails` gagal tepat di `expected 200 to be 404`, sudah dihapus) |
| `apps/api`: `vitest run src/modules/departments src/modules/tickets src/modules/contacts src/modules/reports src/modules/realtime permission-grant rbac-matrix` | 79 lulus + 1 `it.fails`, 12 berkas |
| `apps/worker`: `vitest run src/queues src/inbound` | 124 lulus |
| `packages/shared`: `vitest run` | 150 lulus |
| `tsc` apps/worker | bersih; apps/api gagal hanya karena pohon kerja (Info 7) |
| `pnpm audit` | 1 high build-only + 2 moderate dev-only |
