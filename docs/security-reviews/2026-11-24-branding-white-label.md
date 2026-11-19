# Review keamanan: white-label merek (nama, warna, maskot, logo, ikon PWA dari logo)

- Commit: `4306de7` (`feat(api): pengaturan merek white-label — nama, logo, warna, nama maskot, ikon PWA dari logo`)
- Lingkup: `apps/api/src/modules/branding/*` (`logo.ts`, `icons.ts`, `branding.service.ts`,
  `branding.routes.ts`), `setup.service.ts` (logo di wizard), `email-settings.service.ts` (warna di
  email tes), `packages/shared/src/branding.ts`, migrasi `0031_branding_merek_ikon.sql`, dependensi
  baru `sharp` 0.35.5 (libvips 8.18.7)
- Acuan: `docs/SECURITY.md` §2, §7, §8, §9; `docs/KONTRAK-API-AUTH.md` ("Branding (publik)",
  "Pengaturan → Merek"); `docs/DECISIONS.md` 2026-11-24 (white-label, pertahanan dekoder)
- Peninjau: subagent `security`
- Model ancaman: (1) akun CS curian yang ingin mengubah merek / menyalahgunakan nomor resmi;
  (2) penyerang anonim di internet (rute publik `GET /branding*`, rute setup); (3) sesi Owner
  yang dibajak, yang ingin memakai email sistem / halaman masuk untuk phishing; (4) berkas gambar
  jahat (poliglot, bom dekompresi, eksploit decoder) yang menyerang libvips.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang. Ada 5 temuan Rendah (B1–B5) dan beberapa Info. Karena tidak
ada temuan Sedang ke atas, tidak ada tes `it.fails`. Yang ditambahkan adalah tes penjaga regresi
yang LULUS, `apps/api/src/modules/branding/security-review-branding.test.ts` (6 tes): poliglot
RIFF/WEBP+SVG, RIFF/WEBP+GIF, RIFF/WEBP+ftyp HEIF, tanda PNG+SVG, dan FFD8FF+SVG ditolak sebagai
"rusak" oleh loader hasil sniffing. Bom piksel di jalur isi ulang ikon (tanpa `inspectLogoImage`) tetap
ditolak `limitInputPixels`.

Keputusan untuk pertanyaan backend nomor 3: **`PATCH /settings/branding` TIDAK perlu
`requireIdentityConfirmation`**. Alasannya ada di B2, dan saran kontrol deteksinya juga di sana.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| RBAC | `branding.routes.ts:85,138-168`, `rbac-matrix.integration.test.ts`, `branding.integration.test.ts:145` | `GET`/`PATCH /settings/branding` = `organization.manage` (Owner saja). Admin/Supervisor/CS/Teknisi dapat 403, tanpa sesi 401, tanpa CSRF ditolak. Di dalam transaksi ada `assertActorStillAuthorized`, jadi peran yang dicabut di tengah jalan ikut tertahan. **Akun CS curian tidak punya jalur ke fitur ini.** Tes integrasi + matriks RBAC dijalankan: 17/17 lulus |
| Urutan biaya | `branding.routes.ts:159`, `branding.service.ts:329` | batas laju (20/10 menit/pengguna) dicek SEBELUM `prepareLogoUpload` (CPU). Gambar diolah di luar transaksi, jadi tidak ada kunci baris yang tertahan selama dekode |
| Rantai dekoder | `logo.ts:51-68`, `icons.ts:24-32,66-81` | base64 ber-regex → ≤ 256 KB → magic bytes PNG/JPEG/WebP = `contentType` → `metadata()` (header saja) dengan `format` = hasil sniffing → sisi ≤ 4096 → dekode dengan `limitInputPixels` 4096², `failOn:'error'`, `animated:false`, `sharp.cache(false)`. Ikon keluaran tanpa EXIF (`icons.test.ts:98`) |
| SVG/GIF/TIFF/HEIF tidak sampai ke loader | probe lokal + tes baru | libvips memilih loader dari isi buffer. Dengan prefiks PNG/JPEG/RIFF-WEBP yang diwajibkan sniffing, loader yang terpilih SELALU png/jpeg/webp, dan sisa berkas SVG/GIF/ftyp ditolak sebagai header rusak (`webp: unable to parse image`, `VipsJpeg: Unsupported marker`, `libpng read error`). librsvg, cgif, libtiff, dan libheif ada di biner prebuilt (`sharp.format`), tetapi tidak terjangkau dari jalur ini |
| Bom dekompresi | probe lokal + `icons.test.ts:117` + tes baru | PNG 15 KB yang mengaku 60000×60000 sudah ditolak di `metadata()` (`too_large`). Di jalur dekode, `limitInputPixels` menolak dalam ≤ 1 ms tanpa alokasi. Logo terberat yang sah (PNG 4096×4096 RGBA, 65 KB) butuh ±0,6 dtk CPU dan puncak RSS ±215 MB untuk luminans + 6 ikon (lihat B4) |
| Rute ikon publik | `branding.routes.ts:117-135`, `shared/branding.ts:150-158` | `:file` divalidasi `z.enum(BRAND_ICON_FILES)` (6 nama tetap) → tidak ada path traversal, berkas lain, atau injeksi header (`content-disposition` memakai nama dari enum). Isi diambil dari DB (bukan disk). `content-type` selalu `image/png`. `nosniff` (helmet, `security.ts:39`; tes `branding.integration.test.ts:204`). CORP `same-site` |
| Amplifikasi lewat ikon publik | `branding.service.ts:206-243,300-310` | dekode untuk permintaan anonim hanya terjadi di jalur isi ulang (logo tanpa ikon), SEKALI per `organizationId:sha256` per proses. Promise di-memo, termasuk yang gagal, dan permintaan bersamaan berbagi promise yang sama. Map hanya bertambah satu entri per logo yang pernah diunggah Owner, jadi terbatas. Permintaan biasa = 3 query PK/indeks, setara rute logo yang sudah ada |
| Cache | `branding.routes.ts:56-70` | `?v=` → `immutable` 1 tahun. Nilai `v` sembarang hanya memengaruhi cache browser si peminta sendiri, dan isinya selalu logo/ikon terkini. ETag dari sha256 |
| Validasi nama | `shared/branding.ts:41-64`, `fields.ts:14,24-41` | `singleLineText`: trim, panjang 2–40 / 2–30, tanpa Cc/Zl/Zp/Cf (kecuali ZWJ). Baris baru/RLO/zero-width ditolak, jadi tidak ada injeksi header email (subjek juga lewat `singleLine`) |
| XSS nama di email | `core/mail/templates.ts:182,232,251-253` | `productName` dan `organizationName` → `escapeHtml(singleLine(...))` di HTML. Versi teks polos = teks. Logo email hanya `cid:` (pola `^(cid:|data:image/(png|jpeg|webp);base64,)`) |
| XSS nama di web | `apps/web/src/brand/*` | dirender lewat JSX/atribut React. Tidak ada `dangerouslySetInnerHTML` di `apps/web/src`. Pratinjau email = `iframe sandbox srcdoc` |
| Injeksi CSS lewat warna | `shared/branding.ts:66,98-107`, `templates.ts:124-145`, `web/brand/BrandTheme.tsx` | `brandColorSchema` = `^#[0-9a-f]{6}$` setelah trim+lowercase, ditambah syarat kontras. Template email MEMVALIDASI ULANG `HEX_COLOR` sebelum menyisipkan ke `style` (lapis kedua untuk nilai lama di DB). Web memakai `style.setProperty` per variabel (CSSOM), bukan `<style>` sisipan |
| Wizard setup | `setup.service.ts:189-196` | `assertSetupToken` (waktu-konstan, batas laju per IP) → `assertOwnerPassword` → baru `prepareLogoUpload`. Anonim tanpa token tidak bisa memicu dekode. Setelah setup selesai, `alreadyCompleted` |
| Audit | `branding.service.ts:337-392` | `settings.branding.updated`: `changedFields`, nilai lama→baru untuk nama/warna/maskot (≤ 40 karakter, bukan data pribadi), logo hanya `{action, contentType, byteSize, width, height, sha256, replaced}` / `previousSha256`. Isi berkas tidak pernah dicatat. Simpan ulang tanpa perubahan tidak membuat entri audit. Log galat isi ulang hanya `err.name` |
| `GET /branding` publik | `branding.service.ts:262-285` | `mascotName` dan URL ikon (12 heksa sha256 logo) adalah hal yang memang tampil di halaman masuk/manifest. Logo sendiri sudah publik. Tidak ada ID internal, email, atau pengaturan. Info, bukan temuan |
| Migrasi | `0031_branding_merek_ikon.sql` | CHECK nama berkas (6 nilai), `byte_size = octet_length(data)`, maks. 1 MiB, FK cascade ke logo. `mascot_name` nullable |
| Rahasia | diff | tidak ada token/kredensial baru. Tidak ada yang dikirim ke browser atau log |
| Dependensi | `pnpm audit`, `apps/api/package.json:36` | `sharp` dipin persis `0.35.5` (libvips 8.18.7, libpng 1.6.58, libwebp 1.6.0, mozjpeg, rsvg 2.63.2, heif 1.23.5, tiff 4.7.2). `pnpm audit --prod`: **0 kerentanan**. `pnpm audit` total: 2 moderate dev-only (esbuild GHSA-67mh-4wv8-2f99, minimatch GHSA-g3hv-75wg-m249 lewat eslint), tidak terkait commit ini. Catatan: `pnpm audit` hanya melihat paket npm. CVE libvips/libpng/libwebp di dalam biner prebuilt tidak terdeteksi olehnya (lihat Info 1) |

---

## B. Temuan

### B1 — Rendah: jalur isi ulang ikon melewati `inspectLogoImage` (format = sniffing, sisi ≤ 4096)

- Bukti: `branding.service.ts:214-221`. `backfillIcons` membaca `organization_logos.data`, lalu
  langsung memanggil `renderBrandIcons(logo.data)`, TANPA `inspectLogoImage(data, contentType)`.
  Padahal DECISIONS menyebut rantai "format header sharp = sniff" sebagai invarian. Jalur ini dipicu
  oleh **permintaan anonim** `GET /branding/icons/:file` untuk logo lama yang dulu hanya lolos magic
  bytes (sebelum commit ini).
- Dampak: kecil. Logo lama tetap sudah lolos sniffing PNG/JPEG/WebP. Probe dan tes baru menunjukkan
  poliglot berprefiks itu tidak pernah dipilih loader lain, dan `limitInputPixels` masih membatasi
  memori. Yang hilang hanya lapis pertahanan berlapis (plus batas sisi: logo lama 1×16.777.216 piksel
  lolos ke dekoder).
- Perbaikan: di `backfillIcons`, pilih juga `contentType` dan panggil
  `inspectLogoImage(logo.data, contentType)` sebelum `renderBrandIcons`. Alternatif lain: jadikan
  `renderBrandIcons(data, expected)` yang memanggil `inspectLogoImage` sendiri, supaya tidak ada
  pemanggil yang bisa lupa.

### B2 — Rendah: `PATCH /settings/branding` tanpa konfirmasi identitas, sementara nama/logo tampil di email sistem

- Bukti: `branding.service.ts:327-395` (tanpa `requireIdentityConfirmation`).
  `apps/worker/src/queues/email.ts:262-300`: nama produk + logo ASLI disisipkan di semua email
  sistem (undangan, reset password, notifikasi keamanan), yang dikirim dari alamat pengirim resmi
  (SPF/DKIM lolos).
- Skenario: sesi Owner dibajak. Penyerang mengganti nama produk menjadi teks ajakan (40 karakter
  muat untuk "Akun dibekukan, hub. 0812xxxxxxx") dan logo menjadi gambar berisi instruksi. Lalu ia
  memicu reset password (rute publik) untuk email staf. Staf menerima email sah bermerek palsu.
- Kenapa tetap Rendah dan **tidak wajib konfirmasi** (keputusan):
  1. Hanya Owner (2FA wajib). Akun CS/Admin curian tidak bisa (tes RBAC).
  2. Penerimanya hanya anggota tim internal, bukan pelanggan. Merek tidak masuk ke pesan WhatsApp,
     template, broadcast, atau pesan otomatis, sehingga jalur nomor resmi tidak tersentuh. Ini beda
     dengan pesan otomatis (review jam kerja S1) dan email pengirim, yang memang wajib konfirmasi.
  3. Tautan di email selalu dari `APP_URL` (`assertHttpUrl`). Penyerang tidak bisa mengarahkan
     tombol ke domain lain, dan alamat pengirim diatur di Pengaturan Email, yang wajib konfirmasi.
  4. Perubahannya langsung terlihat oleh semua pengguna (judul, warna, logo aplikasi), bisa
     dibatalkan, dan diaudit dengan nilai lama→baru. Ini sesuai pola proyek: konfirmasi untuk
     kredensial, perluasan akses, aksi permanen, dan teks yang sampai ke pelanggan.
- Perbaikan (kontrol deteksi, disarankan dan murah):
  - (a) Jadikan `settings.branding.updated` kejadian keamanan tingkat `info` di banner Audit, atau
    tingkat `warning` bila `productName`/`mascotName` baru memuat angka ≥ 6 digit berturut-turut atau
    pola URL/domain (heuristik `riskyAdditions` dari pesan otomatis bisa dipakai ulang).
  - (b) Opsional: kirim email pemberitahuan ke Owner lain saat nama/logo berubah.

  Bila (a) dipakai dan nama berisiko, konfirmasi identitas boleh diwajibkan khusus untuk kasus itu,
  mengikuti pola `sensitiveAutoMessageChange`.

### B3 — Rendah: filter merek "WhatsApp" bisa dilewati (ZWJ, lebar penuh, homoglif, tanda baca lain)

- Bukti: `shared/branding.ts:25`, `/whats[\s._-]*app/i`, ditambah `fields.ts:14`, yang sengaja
  MENGIZINKAN U+200D (ZWJ). Hasil uji lokal (regex yang sama):
  - lolos (tidak ditolak): `Whats‍App` (tampil persis "WhatsApp"), `ＷｈａｔｓＡｐｐ` (lebar
    penuh), `WhаtsApp` (а Kiril), `Whats–App`, `Whats/App`, `Whats+App`;
  - ditolak: `WhatsApp`, `Whats App`.
- Dampak: kepatuhan merek dagang Meta (aturan keras CLAUDE.md), bukan celah serangan. Pelakunya
  pemilik instalasi sendiri. Berlaku juga di wizard setup.
- Perbaikan: sebelum dicocokkan, lakukan `value.normalize('NFKC')`, hapus `\p{Cf}` termasuk ZWJ, lalu
  cocokkan dengan `/whats\P{L}*app/iu` (abaikan semua non-huruf di antaranya). Untuk homoglif Kiril/
  Yunani, tambahkan peta konfusabel kecil (а→a, ѕ→s, р→p, һ→h, Ԝ→W) atau tolak nama yang mencampur
  aksara Latin dengan Kiril/Yunani. Tambahkan kasus di `packages/shared/src/branding.test.ts`.

### B4 — Rendah: biaya dekode per unggahan tanpa pembatas konkurensi proses

- Bukti: `icons.ts:89-147`. Satu logo = 7 dekode penuh (luminans + 6 ikon), tiap dekode membaca
  logo dari awal. Ukuran PNG 4096² RGBA: ±0,6 dtk CPU, puncak RSS ±215 MB (probe lokal). Batas laju
  20/10 menit dihitung per pengguna, sementara permintaan paralel diproses bersamaan di threadpool
  libuv + thread libvips.
- Dampak: Owner (atau pemegang token setup) bisa membuat lonjakan memori/CPU di server kecil dengan
  ±20 PATCH paralel. Butuh hak Owner, jadi Rendah.
- Perbaikan: (a) semafor proses `max 1` (atau 2) untuk `prepareLogoUpload`/`backfillIcons`;
  (b) dekode sekali ke ukuran kerja (mis. `resize(1024,1024,{fit:'inside', withoutEnlargement:true})`
  ke buffer PNG/raw) lalu buat 6 ikon dari buffer itu; atau (c) turunkan `LOGO_MAX_DIMENSION` untuk
  logo (2048 sudah lebih dari cukup untuk header 32 px dan ikon 512 px). Poin (c) memangkas memori
  puncak ±4×.

### B5 — Rendah: logo ASLI (bukan hasil olah ulang) tetap disajikan publik dan disisipkan di email

- Bukti: `branding.routes.ts:98-114` (`GET /branding/logo` mengirim `organization_logos.data` apa
  adanya) dan `worker/queues/email.ts:288` (lampiran `cid:`). Ikon sudah bersih (tanpa EXIF), tetapi
  logo aslinya tidak. Ini perilaku lama, bukan regresi.
- Dampak: metadata EXIF/XMP/GPS/nama perangkat pengunggah ikut terbuka ke publik dan ke penerima
  email. Data poliglot sesudah IEND/EOI ikut tersaji, walau aman karena `content-type` dari sniffing +
  `nosniff`.
- Perbaikan: karena `sharp` sudah ada, simpan logo hasil olah ulang. Contoh: dekode → `rotate()`
  (terapkan orientasi) → PNG/JPEG/WebP baru tanpa metadata (`keepMetadata` tidak dipanggil), di
  `prepareLogoUpload`. sha256/ETag dihitung dari hasil olahan.

---

## C. Info (tanpa tindakan wajib)

1. **CVE libvips di biner prebuilt**: `pnpm audit` tidak melihat isi `@img/sharp-*`. Tambahkan langkah
   CI/rutin: bandingkan `sharp.versions` (vips/png/webp/jpeg) dengan rilis keamanan, dan naikkan
   `sharp` saat ada patch. Versi sekarang (8.18.7 / libpng 1.6.58 / libwebp 1.6.0) adalah rilis terbaru
   yang diketahui peninjau. Pastikan juga image Docker memasang varian `@img/sharp-linux*` yang
   cocok (glibc/musl), supaya tidak ada fallback ke build lokal dengan libvips sistem yang lebih tua.
2. **CHECK 1 MiB ikon**: ikon 512 dari logo derau acak PNG 255×256 (≤ 256 KB) menghasilkan
   1.037.777 B, yaitu 99% dari batas CHECK `organization_logo_icons.byte_size ≤ 1048576`. Belum
   tembus dalam uji, tetapi bila tembus, `PATCH` akan menjadi 500 (transaksi batal, data aman), bukan
   400. Saran: periksa ukuran hasil di `renderIcon` lalu lempar `LogoImageError('unreadable')`, atau
   pakai `png({ palette: true })` sebagai cadangan.
3. **Memo kegagalan isi ulang** berlaku sampai proses restart, termasuk untuk galat DB sementara.
   Ikon bawaan dipakai, jadi ini hanya soal ketersediaan, dan memang disengaja (anti-amplifikasi).
4. **ETag ikon** tidak memuat `ICON_RENDER_VERSION`. Bila versi render dinaikkan, klien tanpa `?v=`
   bisa menerima 304 untuk ikon lama. Ini masalah kebenaran, bukan keamanan.
5. **Wizard setup**: `assertSetupToken` mengembalikan jatah batas laju saat token benar, jadi
   pemegang token bisa memanggil `complete` berulang (masing-masing memicu dekode) selama setup
   belum selesai. Pemegang token = admin instalasi, jadi dapat diterima.

---

## D. Tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `vitest run src/modules/branding/security-review-branding.test.ts src/modules/branding/icons.test.ts` | 15/15 lulus (6 tes baru) |
| `vitest run src/modules/branding/branding.integration.test.ts src/rbac-matrix.integration.test.ts` | 17/17 lulus |
| `eslint` + `tsc --noEmit` (apps/api) | bersih |
| `pnpm audit --prod` | 0 kerentanan |
| Probe lokal sharp (skrip di scratchpad, tanpa jaringan): poliglot, bom PNG 60000² / 4096×4097 / 1×16,7 jt, waktu & memori 4096², ukuran ikon dari derau | seperti tercatat di atas |

## E. Ringkasan untuk orkestrator

AMAN. Tidak ada Kritis/Tinggi/Sedang. B1–B5 Rendah. Prioritas perbaikan yang disarankan, semuanya
kecil: B1 (panggil `inspectLogoImage` di jalur isi ulang), B3 (normalisasi NFKC + hapus ZWJ di filter
merek), dan B2(a) (kejadian keamanan untuk perubahan merek).
