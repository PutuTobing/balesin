# Review keamanan — Fase 4: Broadcast / kampanye template

- Commit: `f0fad04` (`feat(broadcast): kampanye broadcast — impor CSV/XLSX/segmen/konektor, persetujuan, jadwal, throttle, rem otomatis, laporan, alarm Telegram`)
- Kontrak: `docs/KONTRAK-API-BROADCAST.md`, DECISIONS 2026-11-20
- Peninjau: subagent `security`
- Model ancaman (SECURITY §5): akun CS/Supervisor/Admin dibobol yang ingin memakai nomor perusahaan untuk
  spam/penipuan massal, atau melumpuhkan layanan; berkas impor buatan penyerang; konektor/Telegram sebagai
  jalur SSRF/kebocoran token; permintaan hapus data (UU PDP).

## Putusan: **PERBAIKI**

1 temuan **Tinggi** (T1: berkas XLSX ±1–40 KB memblokir proses API berjam-jam), 1 Sedang (S1: persetujuan
bisa dihindari dengan memecah kampanye), 1 Rendah (R1: hapus kontak tidak menghapus penerima yang belum
diproses), beberapa Info. Selebihnya desain rem pengiriman kuat.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Izin | `packages/shared/src/permissions.ts:170-171`, `broadcasts.routes.ts`, `rbac-matrix` | `broadcast.send` = Owner/Admin/Supervisor (CS & Teknisi 403 — tes baru untuk CS); `broadcast.approve` = Owner/Admin; pengaju/pembuat tidak boleh menyetujui (`broadcast.approve.own`, tes baru); ajukan/setujui/lanjutkan = konfirmasi identitas; jeda/batal tanpa (arah aman) |
| Pengaturan pelindung | `broadcast-settings.service.ts` | `sending.limits.manage` + konfirmasi; MELONGGARKAN (ambang/kecepatan naik, cadangan turun, rem otomatis dimatikan/dilonggarkan) hanya Owner (`broadcast.settings.loosen`, tes lama) |
| Rem & batas tanpa `assertCanSend` | `apps/worker/src/queues/broadcast.ts:321-400`, `processSendMessageJob` | kecepatan per kampanye ≤ plafon organisasi (≤ 20/dtk); berhenti MENUNGGU pada 80% batas harian organisasi (cadangan CS 20%) & 80% tier Meta per nomor; rem darurat organisasi diperiksa di `prepare` + `tick` menjeda kampanye; rem otomatis kampanye (lonjakan gagal, kode Meta tingkat akun, template/kualitas/channel) → lanjut butuh `sending.resume`. Jadi jumlah total pesan broadcast per hari tetap dibatasi batas harian organisasi |
| Anti-dobel | `broadcast.ts` (`recently_sent`, kunci identitas) | satu nomor sekali per kampanye (indeks unik) + 24 jam lintas kampanye |
| Template | `broadcasts.service.ts` | hanya `APPROVED` milik WABA nomor pengirim; OTP & judul media ditolak (409) |
| Impor — zip bomb | `recipient-import.ts:160-185` | `inflateRawSync` `maxOutputLength` + anggaran total 40 MB, ZIP64/terenkripsi/`.xls` ditolak (tes baru: 60 MB terbuka dari berkas < 5 MB → ditolak) |
| Impor — XXE/entitas | `recipient-import.ts:186-209` | bukan parser XML: DOCTYPE/ENTITY tidak pernah diperluas; hanya 5 entitas bawaan + numerik (tes baru) |
| Impor — CSV | `parseCsv` | pemindai karakter linear (tes baru: kutip tak tertutup 4 MB, 1 jt kutip kosong < 2 dtk) |
| Ekspor CSV | `broadcasts.service.ts:116-121,1535-1560` | `contacts.export`, GET ber-CSRF, 10/jam, diaudit; kolom hanya nilai sistem + nomor; sel diawali `= + - @ TAB CR` diberi `'` (tes baru) |
| Konektor REST | `connector-source.ts`, `packages/core/src/net/outgoing-webhook.ts` | `fetchRemoteFile` (SSRF webhook keluar: DNS sekali, alamat diperiksa, allowlist privat), `maxRedirects: 0`, 20 dtk, ≤ 5 MB; header auth terenkripsi, hanya ekor yang tampil; header tambahan hanya ke origin awal; ganti header/URL berheader = konfirmasi |
| Telegram | `packages/core/src/net/telegram.ts` | host dikunci `api.telegram.org` (lain hanya loopback tes), `redirect: 'error'`, 10 dtk, galat jadi kode (token tidak masuk log/pesan); token terenkripsi, hanya ekor; atur/hapus = konfirmasi; teks alarm tanpa data pelanggan |
| Rem darurat otomatis organisasi | `broadcast.ts` `broadcastGuard` | hanya pesan keluar NON-broadcast; pelaku kosong, audit `automatic`, alarm, email Owner; lanjut = `sending.resume` |
| Real-time | `apps/api/src/modules/realtime/inbox-stream.ts:281-286,352-370,458-484` | penggabungan per 250 ms tetap memakai saringan cakupan per klien; `resync` tanpa data; `peekMany` menutup socket sesi berakhir/2FA/peran tanpa `inbox.view` (gagal DB = coba lagi, perilaku lama) |
| OTP (template Info 1) | `maintenance.ts` `wipeStaleSensitiveTemplates` | nilai `sensitive` > 1 jam dikosongkan tiap 10 menit — **tertutup** |
| R4 kontak (BSUID) | `apps/worker/src/inbound/contacts.ts` | BSUID hanya dilekatkan bila kontak pernah menerima pesan masuk atau berumur ≤ 30 hari; webhook Meta bertanda tangan sehingga identitas tidak bisa dipalsukan penyerang |

---

## B. Temuan

### T1 (Tinggi) — XLSX buatan: tag pembuka tanpa penutup → regex kuadratik memblokir event loop API

- Bukti: `apps/api/src/modules/broadcasts/recipient-import.ts:262-297` —
  `/<si>([\s\S]*?)<\/si>/g`, `/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g`,
  `/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g`, `/<v>([\s\S]*?)<\/v>/` dijalankan atas isi terbuka hingga
  40 MB. Untuk SETIAP `<row`/`<si>` tanpa penutup, `[\s\S]*?` memindai sampai akhir teks → O(n²).
  Parsing berjalan SINKRON di proses API (`broadcasts.service.ts:733`).
- Ukuran: 80.000 `<row>` (400 KB terbuka, berkas ±1 KB) = **8,3 dtk** (diukur); waktu naik 4× per 2×
  ukuran → batas 40 MB (8 jt tag, berkas ±40 KB) ≈ puluhan ribu detik.
- Dampak: satu unggahan oleh pemegang `broadcast.send` (Supervisor ke atas — akun Supervisor dibobol
  cukup) membekukan SELURUH API: inbox semua agen, webhook Meta tidak dijawab (Meta mengulang lalu bisa
  menonaktifkan), sesi/real-time macet. Bisa diulang 30×/jam.
- Perbaikan (salah satu, sebaiknya 1 + 2):
  1. Ganti regex dengan pemindai linear berbasis `indexOf` (cari `<row`, lalu `</row>` dari posisi itu;
     bila tidak ada → tolak berkas), atau sebelum regex pastikan jumlah tag pembuka = penutup dan tolak
     bila tidak;
  2. jalankan parsing di `worker_threads` dengan batas waktu (mis. 5 dtk) supaya event loop API aman
     untuk parser apa pun.
- Tes: `it.fails` "T1: tag pembuka tanpa penutup…" (`security-review-fase4-broadcast.test.ts`) — gagal di
  `expected 8266.73 to be less than 500`.

### S1 (Sedang) — Persetujuan dihindari dengan memecah kampanye di bawah ambang

- Bukti: `broadcasts.service.ts:1009-1024` — `approvalRequired = remaining > approvalThreshold` per
  kampanye; tidak ada akumulasi per pengguna/organisasi. Broadcast juga tidak terkena batas harian per
  pengguna (`assertCanSend` dilewati).
- Dampak: akun Supervisor/Admin dibobol (password + 2FA) bisa mengirim template yang disetujui ke nomor
  sembarang sebanyak N × 50 per hari tanpa persetujuan siapa pun, hanya dibatasi 80% batas harian
  organisasi (bawaan ribuan). Konfirmasi identitas per kampanye dan audit tetap ada, tetapi "empat mata"
  (SECURITY §5) tidak berlaku.
- Perbaikan: hitung penerima kampanye yang dijadwalkan/berjalan/selesai TANPA persetujuan milik pengaju
  (atau organisasi) dalam 24 jam; bila total + kampanye baru > ambang → `pending_approval`. Opsional:
  batas harian per pengguna juga untuk broadcast.
- Tes: `it.fails` "S1: memecah kampanye…" — gagal di `expected ['scheduled','scheduled'] to include
  'pending_approval'`.

### R1 (Rendah) — Hapus kontak (UU PDP) tidak menghapus penerima yang belum diproses

- Bukti: `apps/api/src/modules/contacts/contacts.repo.ts` — penghapusan hanya
  `broadcast_recipients.contact_id = kontak`; baris dari impor CSV/konektor baru tertaut kontak SAAT
  diproses, jadi baris `pending`/`skipped` (nomor + data kolom: nama, tagihan, …) tetap ada; kampanye
  yang masih berjalan akan MEMBUAT ULANG kontak itu dan mengirim pesan.
- Perbaikan: saat hapus kontak, hapus juga baris penerima organisasi itu dengan `phone` = nomor kontak
  (semua status), atau tandai `cancelled` + kosongkan `data`.
- Tes: `it.fails` "R1: hapus kontak juga menghapus baris penerima…" — gagal di
  `expected [ {…} ] to have a length of +0 but got 1`.

---

## C. Info

1. **Rem darurat otomatis bisa dipicu sengaja**: > 400 pesan NON-broadcast/menit (mis. 2 API key bocor
   × 300/menit, atau banyak akun) menarik rem untuk seluruh organisasi sampai Owner melepasnya. Ini
   respons yang diinginkan (lebih aman berhenti), tetapi termasuk vektor DoS; alarm & email sudah ada.
2. **Admin dibobol bisa memenuhi "empat mata" sendiri** dengan mengundang akun Admin kedua lalu
   menyetujui. Butuh akses email undangan; kejadian keamanan undangan/peran sebaiknya `warning`.
3. **Retensi**: setelah 30 hari hanya `data` kolom yang dikosongkan; `phone` penerima disimpan selamanya
   untuk laporan. Pertimbangkan menyamarkan/menghapus nomor setelah retensi.
4. **URL konektor dengan rahasia di query** tetap tampil utuh di UI pengelola & riwayat audit hanya host.
   Kontrak sudah menyarankan header; tambahkan peringatan UI bila URL memuat query `token|key|secret`.
5. **R4 sisa**: kontak buatan API key (≤ 30 hari, nama/atribut pilihan pemegang key) akan menerima BSUID
   pemilik nomor asli saat ia menulis — data CRM bisa "ditanam" oleh key bocor. Dampak kecil (bukan akses
   data).
6. **Pohon kerja**: `packages/shared/src/permissions*.ts` berubah tanpa commit (pekerjaan lain); tes di atas
   dijalankan pada pohon kerja itu dan lulus.

---

## D. Tes penjaga

- `apps/api/src/modules/broadcasts/security-review-fase4-broadcast.test.ts` (unit) — 5 `it` + 1
  `it.fails`: zip bomb, entitas XML tidak diperluas, ZIP terenkripsi/.xls, CSV linear, ekspor CSV aman;
  `it.fails` T1.
- `apps/api/src/modules/broadcasts/security-review-fase4-broadcast.integration.test.ts` — 1 `it` + 2
  `it.fails`: CS 403 / Supervisor tak bisa menyetujui / pengaju tak bisa menyetujui sendiri; `it.fails`
  S1 & R1.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| Penjaga unit + integrasi | 6 lulus + 3 `it.fails` (salinan tanpa `.fails` gagal tepat di T1/S1/R1, sudah dihapus) |
| `apps/api`: `vitest run src/modules/broadcasts src/modules/contacts src/modules/realtime src/rbac-matrix…` | 76 lulus + 3 `it.fails`, 10 berkas |
| `apps/worker`: `vitest run src/queues src/inbound` | 123 lulus |
| `packages/core`: `vitest run src/net` | 23 lulus |
| `packages/shared`: `vitest run` | 140 lulus |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan (commit `6474d8e`)

| Butir | Bukti | Status |
|---|---|---|
| T1 regex kuadratik | `recipient-import.ts`: pemindai XML linear (`indexOf`) menggantikan regex `[\s\S]*?`; parsing dipindah ke `worker_threads` (`import-runner.ts`, `import-thread.ts`): batas parsing 10 dtk sejak thread siap, heap 256 MB (`resourceLimits`), thread gagal/kelewat batas di-`terminate` dan tidak dipakai ulang, gerbang maks. 2 per proses & 1 per pengguna → 429 `RATE_LIMITED` (tidak mengantre); `tsup` menghasilkan `dist/import-thread.js` di samping `dist/index.js`. Tes penjaga T1 `it.fails` → `it` dengan asersi IDENTIK (80.000 `<row>`/`<si>` < 500 ms memanggil `parseXlsx` langsung) dan lulus | **Tertutup** |
| S1 memecah kampanye | `broadcasts.service.ts` submit: kunci advisory per organisasi + jumlah `recipients` audit `broadcast.submitted` tanpa persetujuan 24 jam bergulir (organisasi) + kampanye baru > ambang → `pending_approval` (`approvalReason: cumulative`). Tes penjaga S1 `it.fails` → `it`, asersi IDENTIK, lulus | **Tertutup** |
| R1 hapus kontak | `contacts.repo.ts`: baris penerima organisasi dengan `contact_id` ATAU `phone` = nomor kontak dihapus (semua status), dikunci sebelum kunci identitas (urutan sama dengan worker). Tes penjaga R1 `it.fails` → `it`, asersi IDENTIK, lulus | **Tertutup** |
| Info 1 rem otomatis dipicu sengaja | `broadcast.ts` `broadcastGuard`: audit memuat `topSources` (≤ 5 ID pengguna/API key terbesar) | **Sebagian** (rem per sumber ditunda; tetap Info) |
| Info 3 retensi nomor | ditunda (butuh migrasi) | **Terbuka** (Info) |
| Info 4 rahasia di query URL konektor | `packages/shared/src/broadcasts.ts`: parameter bernama rahasia (`token`, `key`, `secret`, `password`, `sig`, `auth`, …, didekode) ditolak api, diperingatkan web | **Tertutup** |

### Pemeriksaan tambahan pemroses impor terisolasi

Tes baru `apps/api/src/modules/broadcasts/security-review-fase4-import-thread.test.ts` (3 `it`, lulus):

- **kelewat batas waktu** → `ImportError` Indonesia, thread dihentikan; impor berikutnya tetap jalan
  (pool tidak "keracunan");
- **gerbang**: impor kedua dari pengguna yang sama dan impor ketiga di proses yang sama DITOLAK SEKETIKA
  (`ImportBusyError` → 429), bukan mengantre; setelah selesai slot kembali;
- **event loop api tetap responsif** selama thread memproses berkas 19.000 baris (jeda timer < 1 dtk).

Penilaian DoS antrean thread: dua akun `broadcast.send` bisa memegang kedua slot paling lama 10 dtk per
unggahan; dibatasi 30 impor/jam/pengguna → hanya fitur IMPOR (broadcast & kontak Fase 5) yang bisa
tertunda sesaat, bukan API. Dapat diterima (Info).

**Info baru — thread mewarisi seluruh `process.env`.** `new Worker(...)` tanpa opsi `env` memberi thread
salinan semua variabel lingkungan (diverifikasi: thread membaca variabel induk), termasuk
`BALESIN_MASTER_KEY`/URL database. Thread hanya menjalankan pemindai JS murni (tanpa `eval`, tanpa I/O),
jadi tidak ada jalur kebocoran nyata; saran prinsip hak minimum: `env: {}` (atau hanya `NODE_ENV`) pada
`new Worker`.

**Catatan uji**: menjalankan seluruh `src/modules/broadcasts src/modules/contacts` bersamaan, tes
"alarm Telegram" sempat timeout 30 dtk (beban muat thread `tsx` di dev) dan `crm.integration` gagal
(pekerjaan Fase 5 yang belum di-commit di pohon kerja). Diulang tersendiri: `broadcasts.integration` +
penjaga integrasi = 19/19 lulus; penjaga unit + thread = 9/9 lulus. `tsc` apps/api pada pohon kerja: 0
galat.

Putusan Putaran 2: **AMAN** (tidak ada Tinggi/Kritis tersisa).
