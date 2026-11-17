# Penilaian desain — Template WhatsApp (Fase 4)

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `f185b2a` ("feat(template): UI template Meta, kirim template & percakapan baru; revisi bot B1–B3").
  HEAD utama sudah `0b32ce3`; pekerjaan backend Fase 5 yang belum di-commit tidak ikut.
- **Cara:** worktree terisolasi (API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0025`, Redis db 11), 3 worker.
  `template-daftar`, `-kosong`, `-preset`, `-baru`, `-ditolak`, `-ditinjau`, `-otp`, `inbox-kirim-template`,
  `inbox-pilih-template`, `inbox-percakapan-baru`, `inbox-chat(-ketik)` × 390/1440 × terang/gelap: **153 uji lulus**
  (foto + audit kontras, target sentuh, teks terpotong, lebar composer).
- **Screenshot:** `docs/design-reviews/2026-11-21-fase4-template/`.

## Putusan: REVISI

Fitur template dibuat matang.

**Halaman "Template WhatsApp"**
- Pengantar jujur yang membedakan template dari balasan cepat "/".
- Tiga aksi: Buat template (primary), Pakai preset, Sinkron dari Meta.
- Saringan nomor, status, dan kategori.
- Kartu template: nama *monospace*, status berwarna (Disetujui / Menunggu tinjauan Meta / Ditolak + "Alasan dari Meta: …"),
  kategori, bahasa, nomor, kualitas, dan lencana "Ada perubahan belum diajukan".

**Formulir buat/ubah**
- Pratinjau gelembung WhatsApp yang hidup, termasuk tombol.
- Daftar "1 hal perlu dibereskan sebelum diajukan" vs "Siap diajukan".
- Kategori dan bentuk variabel sebagai segmen.
- Contoh nilai variabel wajib.
- Aturan tombol dijelaskan ("Maksimal 10 tombol: 2 tautan, 1 telepon, 1 salin kode").
- Isian terkunci saat ditinjau, dengan alasan.
- OTP dengan pengaturan khusus.

**Di Inbox**
- Footer sesi habis kini punya jalan keluar nyata: tombol "Kirim template".
- Pemilih template + isian nilai dengan contoh + pratinjau.
- "Mulai percakapan baru" dari ikon tulis di kepala daftar, dengan batas harian disebut.

**Keadaan kosong**
- Tiga jalan keluar. Ilustrasi netral diterima — sama dengan "belum memilih chat"; ganti dengan ilustrasi khusus begitu
  aset Kak Sky ada.

Audit: tidak ada teks < 4,5:1, tidak ada scroll horizontal, kaki dialog menempel di semua dialog panjang.

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 5 Responsif, 1 Hierarki | 3 | Composer HP (`inbox-chat`, `-ketik`, semua ruang chat) · 390 | Tiga ikon kiri (lampiran, pesan pilihan, template) + kirim menyisakan kotak tulis **158 px** di 390 (±128 px di 360) — sekitar 17 karakter per baris, kalimat CS rata-rata 60–120 karakter jadi 4–7 baris. Ikon "pesan pilihan" (daftar centang) dan "template" (tata letak) tidak punya label dan sulit dibedakan maknanya |
| 2 | 9 Profesional, 8 Bahasa | 3 | `inbox-kirim-template`, `template-baru`, `inbox-percakapan-baru` | Pratinjau menampilkan variabel kosong mentah: "sebesar **{{3}}** jatuh tempo pada **{{4}}**", "teknisi kami **{{2}}** akan datang pada **{{3}}**". Pelanggan tidak pernah melihat `{{n}}`; di pratinjau ini terbaca seperti galat |
| 3 | 5 Responsif | 3 | `template-daftar` · 390 | Tautan nama template ("Buka template tagihan_jatuh_tempo") **240 × 20 px** — satu-satunya jalan membuka template di HP |

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `template-daftar` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| `template-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `template-preset` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `template-baru` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 |
| `template-ditolak`, `-ditinjau`, `-otp` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-pilih-template` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-kirim-template` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | **3** | 5 |
| `inbox-percakapan-baru` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 |
| Composer HP 3 ikon | 390 T/G | **3** | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| Composer desktop | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3: bersih. "Template", "OTP", nama template dan `{{1}}` adalah istilah Meta/kode.
- §4: tombol berwarna terakhir — lolos. Catatan: isi preset "Kode verifikasi" berbunyi "*{{1}}* adalah kode verifikasi
  **Anda**", sedangkan daftar dan OTP memakai "kamu" (isi pesan ke pelanggan, bukan teks UI — samakan saja, lihat saran).

## Revisi

### Wajib

**TM1. Composer HP: satu tombol "+" untuk lampiran, pesan pilihan, template** — `Composer.tsx`, `Composer.module.css`

- Usulan (lebih sederhana dari dua alternatif): di ≤ 640 px ganti tiga ikon dengan satu tombol **"+"** (44 × 44,
  `aria-label` "Tambah lampiran atau pesan khusus") yang membuka lembar bawah berisi tiga baris berlabel:
  ikon Lucide `paperclip` **Lampiran**, `list-checks` **Pesan dengan pilihan**, `layout-template` **Template
  WhatsApp** (masing-masing ≥ 48 px, dengan keterangan satu baris). Desktop tetap tiga ikon (ruang cukup, kotak tulis 468 px)
  tetapi beri `title`/tooltip.
- Kotak tulis HP menjadi ±246 px (390) / ±216 px (360).
- Kriteria lolos: lebar kotak tulis ≥ 240 px di 390 dan ≥ 210 px di 360; ketiga fitur terjangkau dalam dua ketukan dengan
  label teks.

**TM2. Variabel kosong di pratinjau tampil sebagai tempat isian** — komponen pratinjau template (dipakai `template-baru`,
dialog Kirim template, Mulai percakapan baru)

- Ganti `{{n}}` kosong dengan chip "Nilai 3" (latar `--warning` 15 % / garis putus `--warning`, teks `--warning-ink`)
  atau, bila contoh ada, tampilkan contohnya dengan gaya redup ("Rp150.000" `--ink-2` miring). Untuk variabel bernama:
  "{{nama}}" → chip "nama".
- Kriteria lolos: tidak ada teks `{{` di pratinjau mana pun saat ada isian kosong.

**TM3. Nama template dapat diketuk di HP** — kartu `template-daftar`

- Jadikan seluruh kartu tautan (dengan tombol hapus tetap terpisah) atau beri tautan nama `min-height: 44px`.
- Kriteria lolos: target buka template ≥ 44 px tinggi di 390.

### Saran (tidak menahan)

- **TM-S1.** Ikon hapus (tempat sampah) di setiap kartu daftar memberi bobot sama pada aksi berbahaya; pindahkan "Hapus template" ke
  halaman ubah saja (sudah ada di sana, `template-otp`).
- **TM-S2.** Preset "Kode verifikasi": samakan sapaan menjadi "kamu" seperti pratinjau OTP.
- **TM-S3.** "Ganti template" di dialog Mulai percakapan baru tampil sebagai teks tebal tanpa bingkai, jauh di kanan;
  jadikan tombol sekunder kecil sebaris dengan nama template.
- **TM-S4.** Dialog Kirim template 1440: "← Pilih template lain" dan nama template berada di dua ujung baris; letakkan
  nama di bawah tautan kembali (seperti di 390) supaya terbaca sebagai satu kelompok.
- **TM-S5.** Kosong: ganti ilustrasi netral dengan ilustrasi Kak Sky/template begitu aset siap.

## Bersih-bersih

Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo: laporan ini + 15 screenshot; bagian "Putaran 2" laporan
bot/interaktif/MobiChat (+7 `p2-*.png`). Tidak ada kode produk yang diubah, tidak ada commit.
