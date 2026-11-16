# Penilaian desain — Pengaturan → Channel (Fase 2 butir 1–2)

- **Tanggal:** 2026-11-16 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `60be001` ("feat(channel): Pengaturan → Channel, wizard WhatsApp 9 langkah, halaman nomor &
  profil bisnis"), branch `dev`. Selama penilaian HEAD maju ke `8f42de8` (review security + `disabledAt` di API);
  perubahan `apps/web` di antaranya hanya berkas tes (`security-review-fase2-channel-web.test.tsx`,
  `test/fake-api.ts`), jadi foto tetap mewakili tampilan yang berlaku.
- **Acuan:** `docs/DESIGN.md` §5 (rubrik), §3 (larangan), §4 (gaya bahasa & istilah tetap), `docs/SETUP-META.md`
  (isi wizard), standar laporan `2026-11-15-tim-audit.md`.
- **Screenshot bukti:** `docs/design-reviews/2026-11-16-fase2-channel/` (390 = terang | gelap berdampingan, skala 1×;
  1440 per tema). Nama berkas = nama layar di `e2e/capture/screens-channel.ts`.

## Putusan: REVISI

Fitur ini dikerjakan dengan serius. Wizard punya daftar langkah dengan centang di desktop dan bilah 9 segmen di HP,
error per isian dengan ringkasan, konfirmasi identitas sebelum menyimpan rahasia, tombol "Tes koneksi" yang menjadi
tombol utama sebelum dites lalu turun jadi sekunder setelah berhasil, dan dialog "Tinggalkan" yang memakai pola
`ConfirmDialog` yang sudah ada. Daftar channel tidak melompat sama sekali saat dimuat (Δ 0 px untuk 0/1/4 nomor).
Semua keadaan (kosong, tanpa kunci enkripsi, batas, memuat, gagal, tidak ditemukan, nonaktif, belum dites, dibatasi)
dirancang. Tidak ada scroll horizontal, tidak ada warna di luar token (selain miniatur tema yang sudah diterima),
fokus keyboard terlihat di semua kontrol yang dicoba. Nama produk di teks UI diambil dari pengaturan merek.

Yang menahan ada sembilan, semuanya terukur:

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 1 Hierarki, 8 Bahasa | 3 | `nomor-gagal-tes`, `nomor-tes-dibatasi`, `nomor-nonaktif` · 390 & 1440 | Kepala kartu bilang **"● Gagal"** / **"○ Nonaktif"**, tiga baris di bawahnya fakta **"Status nomor: Terhubung"**. Dua status berbeda, label mirip, saling bertentangan di layar pertama |
| 2 | 1 Hierarki | 3 | `nomor-gagal-tes`, `nomor-tes-dibatasi` · 390 & 1440 | Pesan gagal menyuruh "ganti token di pengaturan channel" — pengguna sudah di sana. Satu-satunya tombol berwarna adalah "Tes koneksi" (mengulang tes dengan token yang sama). "Ganti kredensial" ada di kartu ke-5, setelah Webhook, Profil bisnis, dan Nama channel (2–3 layar gulir) |
| 3 | 2 Token, 3 Tipografi | 3 | `nomor-profil`, `nomor-profil-konfirmasi`, `nomor-ganti-kredensial`, `nomor-hapus` · semua ukuran | `<select>` "Kategori" memakai **Arial** (computed `font-family`). `styles/base.css` me-reset `font` hanya untuk `button` dan `input`, bukan `select`. Berlaku untuk semua `SelectField` di aplikasi (Audit, Email pengirim, Setup, Tim, Detail anggota) |
| 4 | 7 Aksesibilitas, 5 Responsif | 3 | `nomor-profil` · 1440 terang & 390 | Tautan "Buka WhatsApp Manager" di kotak catatan foto: `--primary` di atas `--surface-2` = **4,50:1** — kombinasi yang dilarang `DESIGN.md` §1 untuk teks kecil (13 px). Di 390 target sentuhnya **175 × 19 px** |
| 5 | 3 Tipografi | 3 | `nomor-profil`, `nomor-bawah` · 390 | Isian "Info" satu baris memotong teks: isi **488 px** di kotak **298 px** ("Internet cepat untuk rumah dan kantor. B…") |
| 6 | 8 Bahasa (§3) | 3 | `wizard-webhook`, `nomor-webhook`, `wizard-tes-gagal`, `wizard-tinggalkan` | English nyasar: "Langganan **field** ini", "…pada ketiga **field** ini", "Tinggalkan **wizard**?", "…setelah **wizard** ini". Plus "Dibaca dari Meta **Hari ini**, 10.59" (huruf besar di tengah kalimat; §4 memakai bentuk inline) |
| 7 | 10 Kecepatan terasa | 3 | `nomor-memuat` (buka langsung / muat ulang) · 390 & 1440 | Label asli di kerangka bergeser saat data tiba: "Kualitas" **+16,3**, "Batas pesan" **+20,7**, "Tes terakhir" **+43,8** (1440) / **+62,7 px** (390). Channel nonaktif: **+168 … +242 px**. Channel belum dites: kelima label hilang diganti kotak info |
| 8 | 8 Bahasa, 1 Hierarki | 3 | `pengaturan-channel` · 390 & 1440 | Ringkasan menu "**4 nomor · ● Gagal**" saat hanya 1 dari 4 gagal — terbaca "semua channel gagal" |
| 9 | 4 Kerapian | 3 | `nomor-bawah`, `nomor-profil-gagal`, `nomor-ganti-kredensial` · 1440 | Empat letak aksi berbeda di satu layar: "Ganti kredensial" kanan-atas kepala kartu, "Simpan nama" kanan sebaris isian, "Nonaktifkan channel" kiri di bawah teks, "Hapus channel" kanan sebaris teks dan **merah penuh** — satu-satunya tombol merah penuh di halaman mana pun (Detail anggota memakai tombol sekunder + `dangerText`) |

Revisi W1–W9 di bawah menutup semuanya; sisanya saran.

## Cara menilai

1. **Foto (terisolasi).** Git worktree sementara dari `60be001` di scratchpad, `pnpm install --frozen-lockfile`,
   stack terpisah: API **3191**, web **5191**, database **`balesin_kd_e2e`**, Redis **db 11** (salinan
   `e2e/stack/env.ts` di worktree membaca `E2E_DATABASE_NAME`; berkas repo tidak diubah). `pnpm screenshots` untuk
   34 layar `screens-channel.ts` + `pengaturan-owner` + 6 layar tambahan khusus penilaian (banner
   `webhook_signature_failed` di Inbox dan Channel, wizard langkah 2/3/4 tanpa galat): **165/165 lulus**.
   Semua 41 layar dibuka satu per satu (390 terang|gelap berdampingan, 1440 per tema untuk layar kunci).
2. **Ukur.** Spek Playwright di luar repo memakai `screens.ts`/`mocks-channel.ts` apa adanya (**197 uji lulus**,
   lalu 49 uji ulang dengan jeda 800 ms untuk menyingkirkan warna transisi tombol):
   - audit generik 41 layar × 4: scroll horizontal, ukuran & keluarga huruf, warna di luar token, kontras teks
     terhadap latar efektif, teks/isian terpotong, target sentuh di 390;
   - kerangka → isi dengan respons **ditahan lalu dilepas**: halaman nomor (terhubung, gagal, belum dites, nonaktif),
     daftar (0/1/4 nomor);
   - **tes koneksi berhasil dengan server yang ikut berubah** (mock `nomor-tes-berhasil` statis, lihat Q1);
   - fokus keyboard (Tab) di daftar dan halaman nomor.
3. **Kode dibaca seperlunya:** `ChannelPage.tsx` (`SummaryCard`), `TestPanel.tsx`, `channel-cache.ts`,
   `ChannelsMenuStatus.tsx`, `channel-status.ts`, `ChannelsSkeleton.tsx`, `ChannelWizardPage.tsx` (dialog),
   `BusinessProfileCard.tsx`, `Channels.module.css` (`.photoNote`), `components/ui/ConfirmDialog.tsx`,
   `styles/base.css`, `components/ui/Field.module.css`, `SecurityBanner.tsx`, `i18n/id.ts` (`channels`),
   `packages/shared/src/channels.ts` (`CHANNEL_STATUS_LABELS`, `META_ERROR_MESSAGES`).

### Hasil ukur (fakta)

| Yang diukur | Hasil |
|---|---|
| Scroll horizontal | Tidak ada (164 foto) |
| Ukuran huruf | 12 / 13 / 14 / 16 / 20 saja |
| Keluarga huruf | Plus Jakarta Sans; JetBrains Mono untuk ID, URL, token, nama izin, kode. **Arial di `<select>`** (W3) |
| Warna di luar token | Tidak ada setelah transisi selesai (hanya miniatur tema di Pengaturan, sudah diterima) |
| Kontras teks terendah | **4,50** — tautan `--primary` di `.photoNote` (`--surface-2`), 1440 terang (W4). Lainnya ≥ 4,5 |
| Teks terpotong | Isian "Info" di 390: 488 > 298 px (W5). Lainnya hanya teks `sr-only` |
| Target sentuh 390 | Tombol & baris daftar ≥ 44. Isian 42 di bingkai 44 (sudah diterima sebelumnya). **Di bawah 44:** tautan "Buka WhatsApp Manager" di profil bisnis **175 × 19** (W4) |
| Fokus keyboard | Semua tautan/tombol: `outline 2px` `--primary`, `:focus-visible` benar. Isian: cincin lewat border (pola Field yang sudah ada) |
| Daftar, kerangka → isi | "WhatsApp" dan "Tambah nomor" **Δ 0** untuk 0/1/4 nomor, 390 & 1440 |
| Nomor, kerangka → isi | Lihat W7. Kerangka hanya tampil saat buka langsung/muat ulang; dari daftar data awal diambil dari cache |
| Panjang halaman nomor | **2706 px** di 1440 (3,2 layar), **3592 px** di 390 (4,9 layar) |
| Lebar kolom | Pengaturan 672 px (88–760), Channel & nomor 704 px (88–792), wizard 704 px + daftar langkah 240 px (352–1056). Ruang kosong kanan di halaman nomor 1440: **624 px** |
| Tes berhasil (server berubah) | Kepala jadi "● Terhubung", fakta nomor muncul, kotak "Belum dites" hilang, hasil di bawah tombol — benar. Foto `nomor-tes-berhasil` menampilkan "Belum dites" + "Koneksi berhasil" karena mock tidak ikut berubah (Q1), **bukan** bug produk |

## Tabel nilai

Kriteria: 1 Hierarki · 2 Token · 3 Tipografi · 4 Kerapian · 5 Responsif · 6 Keadaan · 7 Aksesibilitas · 8 Bahasa ·
9 Profesional · 10 Kecepatan. **T/G** = terang & gelap bernilai sama kecuali disebut. Nilai < 4 ditebalkan.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `pengaturan-channel` (menu + status) | 390 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `channel-daftar` | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `channel-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-kosong-tanpa-kunci` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `channel-batas` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-memuat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-gagal` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| Wizard langkah 1–3 (`wizard-meta-business`, aplikasi, nomor) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `wizard-salin-id-galat` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `wizard-token` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `wizard-app-secret` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `wizard-konfirmasi` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `wizard-webhook` | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| `wizard-tes-berhasil` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `wizard-tes-gagal` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `wizard-pembayaran` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `wizard-tinggalkan` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 | 5 |
| `wizard-tanpa-kunci` | 390 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `nomor` (terhubung, layar pertama) | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `nomor-webhook`, `nomor-buat-ulang-token` | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| `nomor-profil`, `nomor-profil-konfirmasi` | 390 T/G | 4 | **3** | **3** | 4 | **3** | 5 | **3** | 4 | 4 | 5 |
| | 1440 terang | 4 | **3** | **3** | 4 | 5 | 5 | **3** | 4 | 4 | 5 |
| | 1440 gelap | 4 | **3** | **3** | 4 | 5 | 5 | 4 | 4 | 4 | 5 |
| `nomor-profil-gagal` | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | 4 | 4 | 5 |
| `nomor-bawah`, `nomor-ganti-kredensial` | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-hapus` (dialog) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-gagal-tes` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | **3** | **3** | 5 |
| `nomor-belum-dites` / tes berhasil (server berubah) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `nomor-tes-dibatasi` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `nomor-nonaktif` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `nomor-tidak-ditemukan` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-memuat` (buka langsung) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | **3** |
| Banner `webhook_signature_failed` (Inbox, Channel) | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |

Catatan gelap: tidak ada perbedaan nilai kecuali W4 (di gelap `--primary` #4D9BFF di `--surface-2` #1C2735 lolos).

## Larangan §3

| Larangan | Status | Bukti |
|---|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih | Ikon Lucide (smartphone, check, copy, external-link, info, triangle-alert, circle-alert, shield-alert, eye). Ilustrasi kosong/gagal/tidak ditemukan memakai warna token |
| Tombol pill besar, bayangan tebal | Bersih | Tombol radius 6. Bayangan hanya dialog |
| Kartu ikon + judul + 1 kalimat berulang | Bersih | Kartu halaman nomor berisi berbeda (ringkasan berfakta, URL/token, form profil, form nama, fakta kredensial, zona akses) |
| Teks English nyasar, Lorem, "Welcome back!" | **Pelanggaran** | "Langganan field ini", "ketiga field ini", "Tinggalkan wizard?", "setelah wizard ini" (W6). Istilah Meta yang memang nama kolom di Meta ("Phone Number ID", "Callback URL", "Verify token", "App Secret", "System User") diterima |
| Ukuran font tidak konsisten, jarak acak | **Pelanggaran ringan** | Huruf `<select>` Arial berbeda dari isian lain (W3); letak aksi kartu acak di 1440 (W9) |
| Warna di luar token | Bersih | Lihat Hasil ukur |

## Istilah & pola §4

| Aturan | Status |
|---|---|
| "kamu/-mu", tanpa "Anda" | Lolos ("timmu", "Facebook-mu", "akunmu") |
| Tombol berwarna terakhir, batal berbingkai | Lolos untuk `IdentityDialog` (Simpan channel, Simpan profil, Hapus channel) dan "Buat ulang verify token". "Tinggalkan wizard?" memakai pola `ConfirmDialog` bawaan (aksi aman berwarna, fokus awal di "Tetap di sini") yang sama dengan "Tinggalkan kode cadangan?" — diterima |
| Judul gagal "… belum bisa dimuat" | Lolos ("Channel belum bisa dimuat", "Profil bisnis belum bisa dimuat") |
| Judul batas "… dibatasi sementara", hitung mundur m:ss di tombol | Lolos ("Tes koneksi dibatasi sementara", "Coba lagi dalam 3:04") |
| Waktu lampau "Hari ini, 03.47" / inline huruf kecil | **Gagal** di "Dibaca dari Meta Hari ini, 10.59" (W6). Banner sudah benar ("…, hari ini, 10.11") |
| Nama produk dari pengaturan merek | Lolos (`${product}` di catatan appsecret_proof). `BALESIN_MASTER_KEY` adalah nama variabel server, bukan nama produk |

## Penilaian independen: halaman nomor di 1440 ("satu kolom 44rem, sisi kanan kosong")

Terukur: kolom 704 px, kosong kanan 624 px, tinggi 2706 px (3,2 layar). **Lebar satu kolom diterima** — sama dengan
Pengaturan, Tim, Keamanan, dan Detail anggota (yang lolos putaran lalu), dan form panjang memang paling enak dibaca
di ±44rem. Dua kolom akan membuat halaman ini satu-satunya yang berbeda. Yang **tidak** diterima adalah letak aksi
yang acak di dalam kolom itu (W9). Ruang kanan sebaiknya dipakai untuk navigasi bagian (S1), bukan dibiarkan.

## Revisi, berurutan prioritas

### Wajib (menyebabkan nilai < 4)

**W1. Pisahkan status channel dari status nomor di Meta**
— `packages/shared/src/channels.ts` (`CHANNEL_STATUS_LABELS`), `apps/web/src/features/channels/NumberFacts.tsx`,
`apps/web/src/i18n/id.ts` (`channels.number.status`)

- `CHANNEL_STATUS_LABELS.failed`: `'Gagal'` → **`'Koneksi gagal'`** (tampil di kepala kartu, daftar, menu).
- Label fakta `'Status nomor'` → **`'Status di Meta'`**.
- Di bawah grid fakta tambahkan satu baris `--ink-2` 13 px: **"Data dari Meta, dibaca {formatDateTimeInline(number.fetchedAt)}."**
  (mis. "Data dari Meta, dibaca hari ini, 10.11.") — supaya jelas fakta ini bisa basi bila tes terakhir gagal.
- Kriteria lolos: di `nomor-gagal-tes`, `nomor-tes-dibatasi`, `nomor-nonaktif` tidak ada kata status yang sama
  muncul dua kali dengan arti berbeda tanpa keterangan sumber.

**W2. Aksi utama saat tes gagal = memperbaiki, bukan mengulang**
— `apps/web/src/features/channels/ChannelPage.tsx` (`SummaryCard`, `Notice` "Tes terakhir gagal"),
`CredentialsCard.tsx`, `i18n/id.ts` (`channels.wizard.steps.test.failedHint`)

- Bila `lastTest.code` ∈ `token_invalid`, `token_expired`, `app_secret_invalid`, `permission_denied`, `not_found`,
  `invalid_parameter`: beri `Notice` `actions` berisi tombol **primary "Ganti kredensial"** yang menggulir ke
  `CredentialsCard`, membuka form ganti, dan memfokuskan isian yang relevan (Token untuk `token_*`/`permission_denied`,
  App Secret untuk `app_secret_invalid`, Phone Number ID untuk `not_found`/`invalid_parameter`). Angkat state
  `editing` ke `ChannelPage` atau pakai callback + `ref`.
- Dalam kasus itu `TestPanel` memakai `variant="secondary"` (sekarang `primary` karena status ≠ connected).
- Wizard (`failedHint`) ganti dengan: **"Isian yang sudah tersimpan diganti dari halaman nomor. Tekan Lanjut sampai
  selesai, lalu pilih “Ganti kredensial” di sana."**
- Kriteria lolos: di `nomor-gagal-tes` tombol berwarna satu-satunya di layar pertama adalah "Ganti kredensial", dan
  menekannya menampilkan isian Token terfokus tanpa gulir manual.

**W3. `<select>` mewarisi huruf aplikasi**
— `apps/web/src/styles/base.css`

```css
select,
textarea {
  margin: 0;
  color: inherit;
  font: inherit;
}
```

- Kriteria lolos: `getComputedStyle(select).fontFamily` diawali "Plus Jakarta Sans" di Kategori profil bisnis,
  saringan Audit, Email pengirim, Setup, Tim, Detail anggota. Periksa ulang tinggi kontrol tetap 42/44 px.

**W4. Tautan di catatan foto profil: kontras & target sentuh**
— `apps/web/src/features/channels/Channels.module.css` (`.photoNote`), `BusinessProfileCard.tsx` (baris 323–326)

- Ganti latar `.photoNote` dari `var(--surface-2)` ke `var(--surface)` dengan `border: 1px solid var(--line)`
  (tautan `--primary` di `--surface` = 5,3:1). Jangan memakai `--primary` untuk teks di `--surface-2` (aturan §1).
- Di ≤ 640 px jadikan tautan `display: inline-flex; align-items: center; min-height: var(--size-touch)` (44 px).
- Kriteria lolos: kontras tautan ≥ 5:1 di terang; target ≥ 44 px tinggi di 390.

**W5. Isian "Info" tidak memotong teks di HP; label pakai istilah Meta**
— `BusinessProfileCard.tsx` (isian `about`), `i18n/id.ts` (`channels.profile.about`, `websites`, `website`)

- Pakai `TextareaField` 2 baris (`rows={2}`, `resize: none`, maks 139 karakter tetap) untuk Info, supaya isi
  62 karakter terlihat utuh di 390.
- Label: `'Info'` → **`'Tentang'`** (istilah Meta di info kontak), `'Website'`/`` `Website ${index}` `` →
  **`'Situs web'`** / **`` `Situs web ${index}` ``**.
- Kriteria lolos: tidak ada isian yang `scrollWidth > clientWidth` di `nomor-profil` 390.

**W6. Hapus English nyasar dan perbaiki waktu inline**
— `apps/web/src/i18n/id.ts`, `BusinessProfileCard.tsx` (baris 245)

| Kunci | Sekarang | Ganti dengan |
|---|---|---|
| `channels.webhook.fieldsTitle` | Langganan field ini | **Kolom webhook yang perlu dilanggani** |
| `channels.webhook.fieldsHint` | Setelah verifikasi, di daftar Kolom webhook klik Berlangganan pada ketiga field ini. | **Setelah verifikasi, klik Berlangganan pada ketiga kolom ini di daftar Kolom webhook.** |
| `channels.wizard.leave.title` | Tinggalkan wizard? | **Batal menambah nomor?** |
| `channels.wizard.steps.test.failedHint` | …setelah wizard ini. | lihat W2 |
| `channels.profile.fetchedAt` + pemanggil | `Dibaca dari Meta ${formatDateTime(...)}` → "Dibaca dari Meta Hari ini, 10.59" | pakai **`formatDateTimeInline`** → "Dibaca dari Meta hari ini, 10.59" |

- Kriteria lolos: kata "field" dan "wizard" tidak muncul lagi di nilai string blok `channels` di `id.ts` (komentar boleh).

**W7. Kerangka halaman nomor tidak memuat label yang bergeser**
— `apps/web/src/features/channels/ChannelsSkeleton.tsx` (`ChannelDetailCardsSkeleton`), `Channels.module.css`

- Hanya render kepala kartu (ikon, nama, nomor, lencana) dengan **tinggi sama persis** seperti isi: sekarang kepala
  kerangka **16,3 px lebih pendek** (samakan tinggi `.skeletonBigName` dengan `line-height` `.summaryName`, dan
  `.skeletonMeta`/`.skeletonBadge` dengan baris 20 px plus jarak yang sama).
- **Buang** grid label fakta dan kerangka tombol dari kerangka: keberadaan dan letaknya bergantung data (belum dites →
  tidak ada fakta; nonaktif → kotak di atasnya; gagal → kotak di bawahnya). Isi kartu cukup tumbuh ke bawah.
- Kriteria lolos: tidak ada elemen kerangka yang bergeser > 4 px setelah data tiba untuk channel terhubung, gagal,
  belum dites, dan nonaktif, di 390 & 1440.

**W8. Ringkasan menu menyebut jumlah yang bermasalah**
— `apps/web/src/features/channels/ChannelsMenuStatus.tsx`, `i18n/id.ts` (`channels`)

- Bila hanya sebagian channel aktif berstatus terburuk, tampilkan jumlahnya: **"4 nomor · ● 1 koneksi gagal"**,
  **"3 nomor · ● 2 belum dites"**. Bila semua sama atau hanya 1 nomor: **"1 nomor · ● Koneksi gagal"**,
  **"4 nomor · ● Terhubung"**. Tambah `menuWorst: (count: number, label: string) => ...` di `id.ts` (label huruf kecil
  setelah angka).
- Tetap pendek (komentar `menuHint`: jangan membuat petunjuk patah baris; ukur di 1440 sebaris dengan "Nomor
  WhatsApp untuk inbox").

**W9. Satu aturan letak aksi di halaman nomor**
— `CredentialsCard.tsx`, `ChannelPage.tsx` (`dangerZone`, baris 456–461), `Channels.module.css`

- Aturan: **aksi kartu (bukan submit form) di kiri bawah isi kartu**, seperti "Tes koneksi", "Buat ulang verify token",
  "Nonaktifkan channel". Tombol submit form tetap kanan bawah form ("Simpan profil", "Simpan kredensial"); "Simpan
  nama" sebaris isian diterima.
- "Ganti kredensial": pindah dari kepala kartu kanan ke bawah grid fakta, kiri.
- "Hapus channel": pindah ke bawah deskripsinya, kiri, dan pakai pola Detail anggota: `<Button>` sekunder dengan
  `className={styles.dangerText}` (`color: var(--danger-ink)`), bukan `variant="danger"` penuh. Merah penuh hanya di
  tombol konfirmasi dialog.
- Kriteria lolos: di `nomor-bawah` 1440 semua tombol aksi kartu sejajar di x = 113 (tepi isi kartu).

### Saran (tidak menahan)

- **S1. Navigasi bagian di 1440.** Di ≥ 1280 px pakai ruang kanan (624 px) untuk daftar tautan bagian yang
  menempel (`position: sticky; top: var(--space-24)`): Ringkasan · Webhook · Profil bisnis · Nama channel ·
  Kredensial Meta · Akses channel, dengan bagian aktif ditandai `--primary-soft`. Halaman 3,2 layar jadi bisa
  dilompati; kolom 44rem tetap.
- **S2. Langkah Pasang webhook** (`wizard.steps.webhook`): ubah paragraf intro yang memuat 4 instruksi menjadi
  `GuideSteps` bernomor seperti langkah lain (1 Buka WhatsApp → Konfigurasi → Webhook → Edit; 2 Tempel URL & verify
  token; 3 Tekan Verifikasi dan simpan; 4 Berlangganan 3 kolom). `savedNote` cukup satu baris `--success-ink`
  tanpa kotak, supaya URL naik ±60 px di 390.
- **S3. Banner `webhook_signature_failed`**: aksinya sekarang "Periksa di Audit log", padahal perbaikannya
  "ganti App Secret". Tambahkan `channelId` ke `details` kejadian (backend) lalu tautan **"Periksa channel CS
  Utama"** → `/pengaturan/channel/$id`. Pertimbangkan lencana "Webhook ditolak" di baris daftar channel itu.
- **S4. Daftar di HP** tidak punya chevron, padahal baris menu Pengaturan di HP punya. Tampilkan chevron 16 px juga
  di ≤ 640 px.
- **S5. Ganti kredensial**: sembunyikan grid fakta (Phone Number ID, WABA ID, petunjuk token) selama form terbuka —
  nilainya muncul dua kali.
- **S6. Lebar kolom**: Pengaturan 672 px vs Channel 704 px (tepi kanan 760 vs 792). Samakan ke satu `max-width`.
- **S7. `wizard-tanpa-kunci` 1440**: kotak kosong di tengah lebar penuh (x 752), sedangkan versi di halaman Channel
  di tengah kolom (x 440). Taruh di kolom konten yang sama.
- **S8. Instruksi kunci enkripsi**: beri perintah siap salin `openssl rand -base64 32` (dengan tombol Salin) di
  `noMasterKeyBody`.
- **S9. Nama tombol/menu Meta di langkah wizard** ("Buat Aplikasi", "Business", "Tampilkan", "Verifikasi dan simpan")
  ditebalkan lewat `RichText`, seperti di `SETUP-META.md`, supaya mudah dicocokkan dengan layar Meta.
- **S10. `SETUP-META.md` meminta ilustrasi/screenshot per langkah.** Belum ada. Tambahkan ilustrasi kecil atau catat
  keputusan menundanya di `docs/DECISIONS.md`.
- **S11. Dialog hapus channel**: sebutkan nasib riwayat chat dari nomor ini (tetap tersimpan atau ikut hilang).
- **S12. Baris status bertumpuk di daftar 1440**: titik "● Terhubung" dan "● Kualitas Tinggi" rata kanan sehingga
  titiknya tidak sejajar (x 651 vs 626). Rata kiri dalam kolom status, atau satu baris "Terhubung · Kualitas Tinggi".

### Untuk `qa-tester`

- **Q1.** `e2e/capture/screens-channel.ts` → `nomor-tes-berhasil`: `channelDetail` statis menjawab GET channel
  `untested` setelah tes, jadi foto menampilkan "Belum dites" + "Koneksi berhasil" bersamaan. Buat mock-nya
  ikut berubah setelah `POST …/test` (status `connected` + `number`), seperti yang saya pakai untuk mengukur.
- **Q2.** Tambah foto `nomor-memuat` per status (gagal, nonaktif, belum dites) dan foto langkah wizard 2–4 tanpa
  galat (sekarang hanya ada di spek penilaian saya).

## Bersih-bersih

Worktree sementara dihapus (`git worktree remove` + hapus folder + `prune`; `git worktree list` hanya repo utama),
port 3191/5191 kosong, database `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo yang ditulis hanya
laporan ini dan folder screenshot `docs/design-reviews/2026-11-16-fase2-channel/` (23 berkas, 3,4 MB). Tidak ada
kode produk yang diubah, tidak ada commit.

---

# Putaran 2

- **Tanggal:** 2026-11-16 · **Penilai:** `kritikus-desain` · **Putaran:** 2
- **Kode yang dinilai:** `df8a0d7` ("fix(channel): revisi desain putaran 1 (W1–W9), navigasi bagian, isian rahasia tak
  terkendali"), difoto dari HEAD `4bfd1d9` (sesudahnya hanya tes security). Stack E2E utama (3100/5180) tidak
  disentuh.
- **Screenshot sesudah:** berkas berawalan `p2-` di `docs/design-reviews/2026-11-16-fase2-channel/`.

## Putusan putaran 2: REVISI (satu regresi kecil)

W1–W9 semuanya memenuhi kriteria lolosnya, S1/S2/S4–S9/S12 dikerjakan, dan tidak ada pelanggaran §3 lagi. Yang menahan
tinggal **satu regresi baru** dari S8: di `wizard-tanpa-kunci` paragraf penjelasan pecah menjadi lima baris terpisah
(lihat R1). Perbaikannya satu baris. Setelah R1 diperbaiki, layar Channel **LOLOS**; cukup foto ulang
`wizard-tanpa-kunci` 390/1440 terang/gelap.

## Cara menilai

1. **Foto.** Worktree sementara dari HEAD di scratchpad, `pnpm install --frozen-lockfile`, API **3191**, web **5191**,
   database **`balesin_kd_e2e`**, Redis **db 11**. 38 layar `screens-channel.ts` (termasuk foto baru wizard langkah
   2–4, `wizard-salin-id`, `nomor-gagal-tes-perbaiki`) + banner `webhook_signature_failed` + `pengaturan-owner`:
   **187/187 lulus**. Layar kunci dibuka satu per satu (390 terang|gelap berdampingan, 1440 per tema).
2. **Ukur** (spek di luar repo, **187 lulus**): audit generik 40 layar × 4 setelah jeda 800 ms; kerangka → isi halaman
   nomor (terhubung, gagal, belum dites, nonaktif) dengan respons ditahan lalu dilepas; lebar **1024 × 768** untuk
   halaman nomor, daftar, wizard, Pengaturan (terang & gelap); lompat lewat navigasi bagian dengan keyboard.

## Hasil ukur revisi

| Revisi | Kriteria lolos | Hasil | Status |
|---|---|---|---|
| **W1** status | tidak ada status sama dengan arti berbeda tanpa sumber | Kepala "● Koneksi gagal"; fakta "Status di Meta"; baris "Data dari Meta, dibaca hari ini, 10.42." Nonaktif: kotak "Dinonaktifkan sejak kemarin, 09.42" | Lolos |
| **W2** aksi saat gagal | satu tombol berwarna "Ganti kredensial"; membuka form + fokus | Tombol primary di kotak gagal; "Tes koneksi" sekunder. `nomor-gagal-tes-perbaiki`: form terbuka, isian **Token System User** terfokus, fakta kredensial disembunyikan (S5). Petunjuk wizard baru tampil | Lolos |
| **W3** huruf `<select>` | Plus Jakarta Sans | Keluarga huruf di 160 foto: Plus Jakarta Sans + JetBrains Mono saja (Arial hilang) | Lolos |
| **W4** tautan foto profil | kontras ≥ 5:1, target ≥ 44 di 390 | `.photoNote` di `--surface` + garis; tidak ada teks < 4,5:1 di layar mana pun; tautan tidak lagi masuk daftar target < 44 | Lolos |
| **W5** isian Tentang | tidak ada isian terpotong di 390 | Textarea 2 baris "Tentang" memuat teks utuh; label "Situs web 1/2". Satu-satunya "terpotong" adalah legenda `sr-only` | Lolos |
| **W6** bahasa | tanpa "field"/"wizard"; waktu inline huruf kecil | "Kolom webhook yang perlu dilanggani", "Batal menambah nomor?", "Dibaca dari Meta hari ini, 11.30" | Lolos |
| **W7** kerangka nomor | tidak ada elemen kerangka bergeser > 4 px | Kartu: atas 80, kiri 88, lebar 672 **Δ 0**. Kepala: nama (y 105, tinggi 24), nomor (133; 20,3), lencana (157,3; 24), bawah kepala 181,3 — **Δ 0** untuk terhubung, gagal, belum dites, nonaktif × 390/1440 × terang/gelap (16 varian). Isi lain tumbuh di bawah kepala | Lolos |
| **W8** ringkasan menu | jumlah yang bermasalah disebut | "4 nomor · ● 1 koneksi gagal", sebaris di 1440 | Lolos |
| **W9** letak aksi | semua aksi kartu sejajar tepi isi | Tes koneksi, Buat ulang verify token, Ganti kredensial, Nonaktifkan channel, Hapus channel semua di **x 113** (1440) / **x 33** (390). "Hapus channel" berbingkai dengan teks `--danger-ink`; merah penuh hanya di dialog | Lolos |
| **S1** navigasi bagian | — | Menempel di kanan (x 784–976), bagian aktif `--primary-soft`. Enter pada "Profil bisnis": kartu itu naik ke atas dan menerima fokus, penanda ikut pindah | Baik |
| **1024 × 768** | tanpa scroll horizontal, tidak bertabrakan | Nomor: kolom 88–760 + navigasi 784–976 (sisa kanan 48). Wizard: daftar langkah 88–328, kartu 352–1000 (sisa 24, sama dengan tepi kiri). Daftar & Pengaturan 88–760. Tidak ada scroll horizontal / teks terpotong / kontras < 4,5 di terang & gelap | Lolos |
| Lebar kolom (S6) | — | Pengaturan, Channel, dan nomor kini sama 672 px (42rem) | Baik |

Pemeriksaan generik: tidak ada scroll horizontal (160 foto); ukuran huruf 12/13/14/16/20; tidak ada warna di luar token
(kecuali miniatur tema, sudah diterima); tidak ada teks aktif < 4,5:1; tautan panduan wizard di 390 kini setinggi 44 px.

## Tabel nilai putaran 2

Semua layar putaran 1 kini ≥ 4 di 390/1440 × terang/gelap, **kecuali**:

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `wizard-tanpa-kunci` | 390 · 1440 T/G | 4 | 5 | **2** | **2** | 5 | 5 | 5 | 4 | **3** | 5 |

Layar yang di putaran 1 bernilai < 4, sesudah revisi:

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `pengaturan-channel` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `wizard-webhook`, `nomor-webhook` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `wizard-tes-gagal`, `wizard-tinggalkan` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-profil`, `nomor-profil-konfirmasi` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-profil-gagal`, `nomor-bawah`, `nomor-ganti-kredensial` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-gagal-tes`, `nomor-gagal-tes-perbaiki` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 |
| `nomor-tes-dibatasi` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `nomor-nonaktif` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-memuat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |

## Revisi putaran 2

### Wajib

**R1. Paragraf "Token Meta belum bisa disimpan" di wizard pecah per potongan**
— `apps/web/src/features/channels/ChannelWizardPage.tsx` (± baris 79–83), `Channels.module.css` (`.blockedBody`)

- Sebab: `.blockedBody` adalah `display: flex; flex-direction: column; gap: 16px`, dan `<RichText>` mengembalikan
  *fragment*. Setiap potongan teks dan setiap `<code>` jadi item flex sendiri: "BALESIN_MASTER_KEY" / "belum diisi di
  berkas" / ".env" / "server, jadi token…" tampil sebagai baris-baris terpisah berjarak 16 px
  (`p2-wizard-tanpa-kunci--390.png`, `p2-wizard-tanpa-kunci--1440-gelap.png`). Di halaman Channel (dalam `Notice`) teks
  yang sama tampil benar.
- Perbaikan: bungkus teks dalam satu paragraf:

  ```tsx
  <div className={styles.blockedBody}>
    <p>
      <RichText text={t.channels.list.noMasterKeyBody} />
    </p>
    <MasterKeyCommand />
  </div>
  ```

- Kriteria lolos: di `wizard-tanpa-kunci` 390 & 1440 paragraf mengalir sebagai satu blok rata tengah dengan `<code>`
  sebaris, lalu baris perintah + Salin di bawahnya.

### Saran (tidak menahan)

- **P2-S1. Penanda navigasi bagian setelah "Ganti kredensial".** Di `nomor-gagal-tes-perbaiki` 1440 form Kredensial
  terbuka dan terfokus, tetapi penanda masih di "Nama channel" (kartu Kredensial mulai di y 414, di bawah garis 40% =
  360). Gulir dengan `block: 'start'` atau set bagian aktif ke `kredensial` saat tombol itu ditekan.
- **P2-S2. Teks bantuan webhook di halaman nomor**: "Ganti App Secret di Kredensial Meta pada halaman nomor." tampil
  di halaman nomor itu sendiri. Di halaman nomor pakai "Ganti App Secret di kartu Kredensial Meta di bawah." (wizard
  tetap kalimat lama).
- **P2-S3 (`qa-tester`).** Mock `channelDetail`/`channelTest`: `number.fetchedAt` = 1 jam lalu, sehingga
  `nomor-gagal-tes` menampilkan data "dibaca hari ini, 10.42" *setelah* tes gagal pukul 08.42, dan
  `nomor-tes-berhasil` menampilkan "dibaca 10.42" padahal tes berhasil pukul 11.42. Server hanya memperbarui data nomor
  lewat tes berhasil, jadi samakan `fetchedAt` dengan `testedAt` tes berhasil terakhir.
- S3 (channel di banner webhook), S10 (ilustrasi per langkah), S11 (nasib riwayat chat saat hapus) tetap terbuka
  sebagai saran.

## Bersih-bersih putaran 2

Worktree sementara dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191
kosong, database `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo yang ditulis: bagian ini dan 21 berkas
`p2-*.png`. Tidak ada kode produk yang diubah, tidak ada commit.
