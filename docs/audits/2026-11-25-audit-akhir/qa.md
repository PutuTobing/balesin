# Audit akhir rilis 1.0 — QA

- **Commit dinilai:** `ab1335f` (branch `dev`), dari git worktree sementara (sudah dihapus).
- **Tanggal:** 21 Nov 2026. Mesin pengembang Windows, 20 core. Selama audit ada agen lain yang
  menjalankan tes dan satu stack E2E lain (port 3191/5191), jadi mesin sering sibuk berat.
- **Hasil:** **BELUM LULUS.** Tidak ada temuan Kritis. Ada **2 temuan Tinggi**: E2E merah di HEAD
  karena `broadcast.spec.ts`, dan `pnpm format:check` gagal. Ada **3 temuan Sedang** dan beberapa
  temuan Rendah. Detailnya di bawah.

## 1. Ringkasan pemeriksaan

| Pemeriksaan | Hasil | Durasi | Catatan |
|---|---|---|---|
| `pnpm format:check` | **GAGAL** | 14 dtk | 1 berkas tidak rapi (T2). Di HEAD `dev` terbaru (`9727cdb`) berkas ini sudah rapi |
| `pnpm lint` | lulus | 137 dtk | |
| `pnpm check:deps` | lulus | <1 dtk | 639 paket, tanpa library WhatsApp tidak resmi |
| `pnpm typecheck` | lulus | 25 dtk | 7 paket |
| `pnpm build` | lulus | 31 dtk | ada peringatan Vite `configLoader: 'native'` (R4) |
| Vitest `packages/shared` | 163/163 | 2 dtk | |
| Vitest `packages/db` | 102/102 | 53 dtk | run pertama 6 gagal (hook/test timeout) karena Postgres dipakai bersama agen lain; lulus saat diulang (R2) |
| Vitest `packages/core` | 615/615 | 8 dtk | |
| Vitest `apps/worker` | 138/138 | 33 dtk | |
| Vitest `apps/web` | 905/905 | 63 dtk | lulus saat mesin senggang. Saat mesin sibuk, 4 lalu 23 tes gagal karena timeout `findBy` (R2) |
| Vitest `apps/api` (`--maxWorkers=3`) | 1104/1104 | 1400 dtk | 99 berkas |
| **Total unit/integrasi** | **3027 lulus** | | tidak ada `skip`/`todo`/`only` di tes unit |
| E2E Playwright (semua proyek) | lihat §2 | ±6 mnt/run | 349 tes: 285 jalan + 64 dilewati beralasan |
| Screenshot (`pnpm screenshots`) | 1408 lulus, 4 gagal, 5 goyah | 16 mnt | 1417 tes, sekitar 354 layar × 4 varian (R5) |
| Penjelajah layar sungguhan (390 & 1440) | bersih | 1,5 mnt/viewport | 45 + 43 halaman, §3 |

**Tes yang dilewati:** E2E punya 64 `test.skip` dan semuanya beralasan. Alasannya: hanya untuk
viewport tertentu (mis. "Keyboard fisik: desktop", "Khusus HP"), atau alur yang cukup diuji
sekali di desktop. `tim-tanpa-email.spec.ts:95,159` di-skip bersyarat bila tes sebelumnya gagal,
dan tidak pernah terpicu. Tidak ada skip tanpa alasan.

## 2. E2E penuh — tujuh run dan deteksi tes goyah

Stack standar: API 3100, web 5180, DB `balesin_e2e`, Redis db 14, Meta & channel tiruan. Tidak
ada panggilan ke Meta atau pelanggan sungguhan.

| Run | Konfigurasi | Hasil |
|---|---|---|
| A | standar, 10 worker, cache Vite kosong (worktree baru) | **gagal di `alur-awal`**: dokumen `GET /inbox` dari Vite dev butuh **218 dtk** (optimasi dependensi pertama di mesin sibuk), tes timeout 5 mnt, **347 tes tidak jalan** (D1) |
| B | standar, 10 worker | dihentikan: 19 dari 59 tes timeout saat "setting up context" (mesin jenuh, ada stack E2E agen lain). Tidak dipakai sebagai sinyal produk |
| 1 | standar, `--workers=5`, tanpa ubahan | 266 lulus, **2 gagal** (`aksesibilitas.spec.ts:73,83`, 429 laporan → S1), 17 tidak jalan karena dependensi |
| 2 | + izin 429 sementara di 2 tes a11y, + penjelajah | 271 lulus, **1 gagal** (`broadcast.spec.ts:156`, T1), 15 tidak jalan |
| 3 | sama dengan run 2 | 271 lulus, **1 gagal** (`broadcast.spec.ts:156`, sama persis), 15 tidak jalan |
| 4 | + perbaikan `draftCampaign` sementara | **hijau penuh**: 285 lulus + 2 penjelajah, 64 dilewati, 9,0 mnt |
| 5 | sama dengan run 4 (tanpa penjelajah) | 263 lulus, **3 gagal**: `crm.spec.ts:34` (S2), `sesi.spec.ts:43` (R1), `aksesibilitas.spec.ts:207` (429, S1); 19 tidak jalan |

**Tes goyah atau merah yang ditemukan:**

| Tes | Kejadian | Penyebab | Lihat |
|---|---|---|---|
| `broadcast.spec.ts:156` "CSV kecil → ajukan → terkirim…" | gagal 2/2 setiap kali jalan | asumsi tes salah: nomor bawaan tidak punya template | T1 |
| `aksesibilitas.spec.ts:73`, `:83`, `:207` | 3 kegagalan dalam 2 run | gerbang laporan 2 per organisasi → 429 | S1 |
| `crm.spec.ts:34` impor kontak | 1/5 | **bug produk**: race di halaman impor | S2 |
| `sesi.spec.ts:43` sesi dicabut | 1/5 | tes bergantung pada cache < 30 dtk; perilaku produk benar | R1 |
| `alur-awal.setup.ts:210` | 1 (run A) | Vite dev dengan cache kosong | D1 |

Semua ubahan tes di atas hanya ada di worktree sementara dan **tidak masuk repo**. Usulan
perbaikannya ada di tiap temuan.

## 3. Penelusuran layar (390 × 844 dan 1440 × 900)

1. **Penjelajah data sungguhan.** Spec sementara dijalankan setelah seluruh suite E2E, memakai
   sesi Owner dan data hasil suite. Rute statis dari `router.ts` ditambah semua tautan internal
   yang ditemukan, termasuk detail kontak, broadcast, tiket, board, nomor, channel lain, template,
   dan anggota tim. Hasil: **45 halaman di 1440 dan 43 di 390, semua bersih**. Tidak ada galat
   konsol, request ≥ 400, scroll horizontal, elemen keluar viewport, tombol/tautan tanpa nama,
   kata English/placeholder (Loading, Save, undefined, NaN, Lorem, …), atau teks "Sky Tech".
   Pengecualian yang wajar:
   - `/pengaturan/email`: "Blocked script execution in 'about:srcdoc'". Ini sisipan Playwright ke
     iframe pratinjau ber-sandbox, tanda sandbox bekerja. Fixture E2E juga mengabaikannya.
   - Kata "Edit" di halaman nomor adalah kutipan label menu Meta ("Webhook → Edit"). Ini
     disengaja.
2. **Foto 4 varian (390/1440 × terang/gelap).** Setiap foto juga diperiksa untuk scroll
   horizontal, teks English, dan merek. Hasil: **0 scroll horizontal, 0 teks English, 0 "Sky
   Tech"**. Semua galat konsol berasal dari respons tiruan yang memang disengaja untuk layar galat
   (401/403/404/409/410/429/500/502/503).
3. **Hardcode merek:** `grep` di `apps/*/src` dan `packages/*/src` bersih. "Sky Tech" hanya muncul
   di data tes. `PutuTobing/balesin` di `deploy/install.sh` dan `deploy/docker-compose.yml` adalah
   alamat rilis/registry vendor dan bisa diganti lewat `BALESIN_IMAGE_PREFIX`, jadi wajar.
4. **Teks UI:** tidak ada string English di `apps/web/src` maupun di pesan galat API.

## 4. Temuan

### Kritis
Tidak ada.

### Tinggi

**T1. E2E `broadcast.spec.ts` merah di HEAD: tes berasumsi nomor bawaan punya template disetujui**
(perbaikan di tes oleh **qa-tester/frontend**; usulan UX ada di R3)
- `e2e/tests/broadcast.spec.ts:119-125` (`draftCampaign`) menunggu
  `getByLabel('Template')` tampil **sebelum** memilih nomor pengirim. Wizard memakai
  `senders[0]` sebagai nomor bawaan (`apps/web/src/features/broadcast/BroadcastWizard.tsx:153-158`).
  Di urutan suite sekarang, nomor pertama adalah "Inbox E2E Bot" yang tidak punya template
  disetujui. Akibatnya yang tampil status "Belum ada template disetujui yang bisa dipakai untuk
  nomor ini." dan select Template tidak ada.
- Reproduksi: jalankan E2E penuh. Proyek `berurutan` → `CSV kecil → ajukan …` gagal di baris 121.
  Gagal 2/2. Karena itu `berurutan-hp` dan `dengan-email` (15 tes) **tidak pernah jalan**, sehingga
  CI merah.
- Usulan (sudah dicoba dan lulus di run 4):
  ```ts
  await expect(sender.or(template).first()).toBeVisible();
  if ((await sender.count()) > 0) await sender.selectOption(channelId);
  await expect(template.locator(`option[value="${templateId}"]`)).toHaveCount(1);
  ```

**T2. `pnpm format:check` gagal di `ab1335f`** (**backend**)
- `apps/api/src/modules/bot/security-review-bot-semua-channel.integration.test.ts:877` dan `:906`
  belum diformat Prettier. Langkah pertama `pnpm check`/CI gagal.
- Di HEAD `dev` terbaru (`9727cdb`) berkas ini **sudah rapi**. Pastikan `pnpm format:check` hijau
  sebelum tag rilis.

### Sedang

**S1. Gerbang laporan 2 permintaan per organisasi → 429 dan galat konsol saat beberapa orang
membuka Laporan bersamaan** (**backend** + **frontend**; perbaikan tes oleh **qa-tester**)
- `apps/api/src/modules/reports/reports.routes.ts:51` `REPORT_CONCURRENCY = { perOrganization: 2,
  global: 6 }`. Begitu ada 3 laporan berjalan di satu organisasi, permintaan berikutnya langsung
  ditolak `RATE_LIMITED` (429, `retryAfterSeconds: 5`). Web hanya `retry: 1` dengan jeda bawaan
  ±1 dtk (`apps/web/src/app/query-client.ts:9`) dan tidak membaca `Retry-After`. Akibatnya
  supervisor ketiga bisa melihat kartu galat laporan, dan konsol mencatat
  `Failed to load resource: 429`.
- Reproduksi: 3 tab atau 3 pengguna satu organisasi membuka `/laporan` pada saat yang sama, atau
  jalankan `aksesibilitas.spec.ts` dengan ≥ 5 worker. Gagal di run 1 (`:73`, `:83`) dan run 5
  (`:207`), dengan `http 429: /api/v1/reports/performance?...`.
- Usulan:
  - Web: untuk 429 laporan, ulangi sesuai `Retry-After` (2–3×) sebelum menampilkan galat.
  - Backend: pertimbangkan antre singkat (tunggu ≤ 2–3 dtk) alih-alih tolak segera, atau batas
    per-pengguna.
  - Tes: `aksesibilitas.spec.ts` sementara mengizinkan 429 di rute `/laporan`, atau menjalankan
    `/laporan` di proyek berurutan.

**S2. Impor kontak diam-diam membuang kolom atribut bila berkas dipilih sebelum daftar atribut
selesai dimuat** (**frontend**)
- `apps/web/src/features/contacts/ContactImportPage.tsx:54` mengambil `definitions` dari
  `useQuery(contactAttributesQuery).data ?? []`. Di `:84`, `guessImportMapping(found, definitions)`
  dipanggil **sekali** saat berkas dipilih. Kalau query belum selesai, `definitions = []`, kolom
  atribut (mis. `paket-xxx`) dipetakan "abaikan", dan tidak pernah ditebak ulang saat definisi
  tiba. Impor selesai "berhasil" tetapi atributnya **kosong** ("Belum diisi").
- Reproduksi: jalankan E2E `crm.spec.ts:34` di mesin sibuk (gagal 1/5, run 5). Hasilnya region
  "Atribut" berisi `Paket … : Belum diisi`, padahal CSV berisi `Gold`. Manual: throttle jaringan
  di DevTools → buka `/kontak/impor` → langsung pilih CSV berkolom atribut → Periksa → Impor.
- Usulan:
  - Nonaktifkan pemilih berkas sampai `contactAttributesQuery` sukses, atau tebak ulang pemetaan
    saat `definitions` berubah dan pengguna belum mengubah pemetaan.
  - Tambah tes unit untuk urutan "berkas dulu, definisi belakangan".

**D1. E2E rapuh pada cache Vite dingin dan di mesin sibuk** (**devops**)
- `e2e/viewports.ts` (`webServer`) menjalankan web lewat `vite` dev. Pada worktree atau checkout
  CI baru, permintaan dokumen pertama menunggu optimasi dependensi. Di run A ini butuh 218 dtk,
  sehingga `alur-awal` timeout dan **seluruh suite tidak jalan**. Dengan 10 worker di mesin sibuk,
  pembuatan context browser > 30 dtk (run B).
- Usulan:
  - Panaskan Vite sebelum tes (mis. `server.warmup` / `optimizeDeps.include` di
    `apps/web/vite.config.ts`, atau `curl` ke `/inbox` di `start` webServer).
  - Lebih baik lagi: E2E melawan `vite build` + `vite preview` agar mirip produksi.
  - Batasi `workers` lokal (mis. 5).

### Rendah

**R1. `sesi.spec.ts:43` bergantung pada cache < 30 dtk** (**qa-tester**). Halaman `/pengaturan`
me-refetch `settings/api-keys`, `webhooks`, `broadcast-connectors`, `alarms/telegram`, dan
`auth/2fa` lebih dulu (data sudah basi di mesin lambat). Respons 401 yang tidak terdaftar di
`expectHttpError` menggagalkan tes, lalu tes menunggu tautan "Email pengirim" yang sudah hilang
karena aplikasi sudah dialihkan ke `/masuk`. Perilaku produk **benar** (pesan "Sesimu sudah
berakhir…" tampil). Perbaiki tes: izinkan 401 untuk semua `/api/v1/*` setelah pencabutan, atau
langsung buka `/pengaturan/email` setelah mencabut.

**R2. Tes unit sensitif beban** (**frontend/backend**). `apps/web` gagal 4 tes, lalu 23 tes di
run berikutnya, saat mesin sibuk (`findBy*` default 1 dtk; mis. `AppShell.test.tsx` "pindah ke
Tiket/Laporan", `Connections.test.tsx` "hubungkan Telegram",
`security-review-web-kanal-jam-kerja.test.tsx`). Semuanya lulus 905/905 saat mesin senggang.
`packages/db` (`testing/cleanup.integration.test.ts`, `testing/guard.security.test.ts`,
`fase1-akun`, `migrations`) timeout 20/30 dtk saat Postgres dipakai bersama. Usulan: naikkan
`asyncUtilTimeout` RTL dan timeout tes db, atau batasi `maxWorkers` di skrip `test`.

**R3. Nomor pengirim bawaan di wizard broadcast bisa nomor tanpa template** (**frontend**).
`BroadcastWizard.tsx:158` memakai `senders[0]`, sehingga pengguna langsung disambut "Belum ada
template disetujui…" padahal nomor lain punya template. Usulan: pilih nomor pertama yang punya
template disetujui. Ini juga membuat T1 tidak terjadi.

**R4. Peringatan build Vite `configLoader: 'native'`** (**frontend**).
`packages/shared/src/branding.ts:3-4` mengimpor `./design-tokens` dan `./fields` tanpa ekstensi.
Belum memblokir, tetapi akan menjadi galat di Vite mayor berikutnya.

**R5. Skrip screenshot** (**frontend/qa-tester**)
- 4 layar gagal tetap: `inbox-chat-interaktif` dan `inbox-chat-interaktif-daftar` di 390. Tombol
  "Kirim tombol atau daftar pilihan" pindah ke menu "+" di HP. **Sudah diperbaiki di `dev`**
  (`openInteractiveDialog`, `e2e/capture/screens-inbox.ts`).
- 5 layar tamu 390-gelap goyah (timeout 30 dtk, lulus saat diulang).
- Layar `anggota*` memanggil endpoint yang tidak ditiru → 404 ke API sungguhan, sehingga kartu
  "Departemen" di foto memakai bingkai galat (`anggota-bawah--390-terang.png`). Foto ini tidak
  mewakili tampilan sebenarnya. Tambah tiruan departemen anggota di `e2e/capture/mocks-tim.ts`.

**R6. Catatan tampilan untuk kritikus-desain** (bukan bug fungsional):
- 390 `inbox-chat`: tombol "Ambil chat" di bilah bawah hanya berjarak ±12 px dari tepi kanan
  (gutter 16 px).
- 1440 `inbox-chat`: tab "Selesai" menempel tepi kolom daftar. Kemungkinan tab memang bisa
  digulir; pastikan ada isyarat gulir.

## 5. Kebersihan

- Worktree `C:/APP-CODDING/balesin-qa-audit` sudah di-`git worktree remove` dan isinya terhapus,
  termasuk semua ubahan tes sementara (izin 429, perbaikan `draftCampaign`, penjelajah
  `e2e/audit/`, log audit di `capture.spec.ts`). Yang tersisa hanya **folder kosong**
  `balesin-qa-audit/apps/api` dan `balesin-qa-audit/e2e`. Folder ini masih dikunci Windows oleh
  proses yatim dari run B yang tidak bisa diidentifikasi tanpa daftar proses (daftar proses
  ditolak izin). Folder bisa dihapus setelah proses itu berhenti atau setelah reboot.
- Stack E2E (API 3100, web 5180, kendali channel 43100, worker Redis db 14) sudah mati.
  Proses yatim dari run B yang dimatikan manual: server channel tiruan, worker, dan server Meta
  tiruan. Database `balesin_e2e` tetap ada; ia dibuat ulang setiap run.
- Tidak ada commit. Hanya berkas ini yang ditulis di working tree utama.

## Putaran 2 (penutupan) — HEAD `448df8a`

- **Hasil:** **BELUM LULUS. Ada 1 temuan baru level Tinggi** (P2-T1, tes unit api merah).
  Semua temuan putaran 1 tertutup: T1, T2, S1, S2, D1, R1, R3, R4, dan R5 (bagian foto interaktif).
  E2E penuh hijau dua kali berturut-turut.
- Dijalankan dari worktree baru di `448df8a` dengan cache Vite **dingin** (`apps/web/node_modules/.vite`
  belum ada). Config E2E standar, tanpa tambalan sementara. Worktree dan stack sudah dibersihkan.

### Ringkasan pemeriksaan

| Pemeriksaan | Hasil | Durasi |
|---|---|---|
| `pnpm format:check` | lulus (T2 tertutup) | 16 dtk |
| `pnpm lint` | lulus | 96 dtk |
| `pnpm check:deps` | lulus | 1 dtk |
| `pnpm typecheck` | lulus | 47 dtk |
| `pnpm build` | lulus, **tanpa** peringatan `configLoader` (R4 tertutup) | 21 dtk |
| Vitest shared / db / core / worker / web | 167 / 102 / 615 / 138 / 930, semua lulus | 2 / 21 / 7 / 17 / 51 dtk |
| Vitest api (`--maxWorkers=3`) | **1160 lulus, 1 gagal** (P2-T1), 103 berkas | 1290 dtk |
| **Total unit/integrasi** | **3112 tes, 1 gagal** | |
| E2E penuh run 1 (cache Vite dingin) | **285 lulus, 64 dilewati, 0 gagal, 0 goyah** | 7,4 mnt |
| E2E penuh run 2 (berturut-turut) | **285 lulus, 64 dilewati, 0 gagal, 0 goyah** | 6,5 mnt |

- **D1 terbukti tertutup.** Dengan cache dingin, `e2e/stack/start-web.mjs` memanaskan 458 modul dan
  15 dependensi dalam 2 × 2 dtk sebelum `BALESIN_E2E_WEB_SIAP`. Di putaran 1, dokumen pertama butuh
  218 dtk. Playwright memakai 5 worker dari `viewports.ts`.
- Log API/worker selama kedua run tidak berisi `level: error`/`fatal`.
- Tes yang dulu goyah atau merah semuanya lulus di kedua run: `broadcast.spec.ts:156` (T1),
  `aksesibilitas.spec.ts:73/83/207` (S1, laporan kini menunggu slot dan web mencoba ulang sesuai
  Retry-After), `crm.spec.ts:34` (S2), dan `sesi.spec.ts:43` (R1).
- Tes yang dilewati tetap 64 `test.skip`, semuanya beralasan.

### Temuan baru

**P2-T1 (Tinggi) — `forbidden-pattern.test.ts` merah: 403 langsung tanpa audit di
`outbound.service.ts`** (**backend**, review **security**)
- Penjaga pola `apps/api/src/modules/auth/forbidden-pattern.test.ts:47` (review RBAC R1) mewajibkan
  setiap 403 karena wewenang dilempar lewat `forbidByRule` (`modules/auth/access-denied.ts:185`)
  supaya penolakan akses selalu diaudit. Ada dua pelanggaran:
  - `apps/api/src/modules/messages/outbound.service.ts:829` →
    `throw new AppError('FORBIDDEN', { message: INITIATION_DENIED[initiates][initiation.actor] })`
    (kirim ke percakapan selesai/dingin tanpa izin `inbox.initiate` / scope `messages:initiate`).
  - `apps/api/src/modules/messages/outbound.service.ts:1338` →
    `throw new AppError('FORBIDDEN', { message: INITIATION_DENIED[initiates].user })`
    (kirim ulang).
- Asal: diperkenalkan di `584f040` (A1) dan diperluas di `33a5302`. Sejak itu `apps/api` merah dan CI
  ikut merah. Gagalnya deterministik karena tes ini memindai isi berkas.
- Reproduksi: `cd apps/api && pnpm vitest run src/modules/auth/forbidden-pattern.test.ts`.
- Usulan: ganti kedua `throw` dengan `forbidByRule(...)` memakai aturan baru di `ACCESS_RULES`
  (mis. "mulai percakapan tanpa izin"), supaya penolakan masuk audit/jejak keamanan. Kalau memang
  sengaja tidak diaudit, tambahkan berkas ke `ALLOWED` dengan alasan dan minta review `security`.
  Pilihan pertama lebih sesuai `docs/SECURITY.md`.

### Kebersihan putaran 2
- Worktree `balesin-qa-tutup` sudah dihapus. Stack E2E (3100/5180/43100, Redis db 14) sudah mati
  tanpa proses yatim.
- Folder kosong `balesin-qa-audit/{apps/api,e2e}` dari putaran 1 masih terkunci (lihat §5).
- Tidak ada commit dan tidak ada ubahan tes di putaran ini.
