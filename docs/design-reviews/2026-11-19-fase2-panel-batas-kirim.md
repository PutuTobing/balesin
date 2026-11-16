# Penilaian desain — Panel detail (butir 8), Batas kirim & rem darurat, Diagnosis webhook

- **Tanggal:** 2026-11-17 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `064ee6f` ("feat(inbox): panel detail (tag, kontak, catatan, berkas, log, data pribadi),
  Pengaturan → Batas kirim & rem darurat, diagnosis webhook"). Sesudahnya HEAD `0791763` (tes security saja).
- **Acuan:** `docs/DESIGN.md` §1 (token), §3, §4, §5; `docs/KONTRAK-API-INBOX.md`.
- **Screenshot:** `docs/design-reviews/2026-11-19-fase2-panel-batas-kirim/` (390 = terang | gelap berdampingan; 1440 per
  tema).

## Putusan: REVISI

Ketiga fitur ini terasa seperti produk jadi.

**Panel detail**
- Empat tab (Info, Catatan, Berkas, Log).
- Tag: pil dengan titik warna, "Tambah tag" bergaris putus, popover cari-atau-buat.
- Kontak: bagian Kontak lengkap dengan atribut; dialog Ubah kontak dengan atribut yang bisa ditambah/dihapus.
- Data pribadi (UU PDP): "Ekspor data kontak" dan "Hapus kontak" (berbingkai merah). Penghapusan memakai konfirmasi
  identitas dengan judul yang jujur ("Hapus kontak ini beserta datanya?") dan "Hapus permanen".
- Catatan internal bergaris kiri `--warning` dengan penulis dan waktu.
- Berkas: kontrol segmen Media/File/Ditandai.
- Log berupa linimasa dengan pil tag.

**Batas kirim**
- Kartu rem darurat dengan status yang jelas ("Pengiriman berjalan" / "Pengiriman sedang dihentikan · ditarik oleh Rina
  Kartika, hari ini, 04.24 · Alasan …").
- Alasan menarik rem bersifat opsional.
- Melanjutkan pengiriman memakai konfirmasi identitas.
- Bilah pemakaian berubah kuning di 84%, galat per isian, keadaan memuat dan gagal.

**Diagnosis webhook**
- Angka (diterima, diproses, menunggu, gagal, terakhir) dan dua keadaan: "Ada yang perlu dicek" dan "Belum ada data masuk".

Tidak ada teks < 4,5:1 di 124 varian yang diaudit, huruf 12/13/14/16/20, target ≥ 44 px kecuali satu (lihat laporan
penanganan T5).

Yang menahan ada empat:

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 2 Token | 3 | Tag berwarna **Ungu** dan **Toska** | `TagPicker.module.css`: `purple` → `--primary` (biru), `teal` → `--success` (hijau) + cincin. Pengguna memilih "Ungu" tetapi melihat titik biru bercincin — label dan warna tidak cocok, dan dua tag berbeda warna terlihat hampir sama |
| 2 | 4 Kerapian, 7 Aksesibilitas | 3 | Tab panel detail (`inbox-detail-catatan`, `-berkas`, `-log`) · 390 & 1440 | **Klik mouse** pada tab memunculkan cincin fokus kotak 2 px di dalam tab (terukur `:focus-visible = true` setelah `mouse.click`, 4 varian). Kotak itu menabrak garis bawah tab aktif; di foto setiap tab yang diklik terlihat "terpilih ganda" |
| 3 | 1 Hierarki | 3 | `nomor-webhook-diagnosis` · 390 & 1440 | Diagnosis — informasi yang paling bisa ditindaklanjuti — ada di **paling bawah** kartu Webhook, setelah URL, verify token, 3 kolom langganan, kotak info App Secret Proof, dan dua paragraf bantuan (1440: y ±480 setelah digulir ±1 layar; tidak ada di navigasi bagian). "Periksa lagi" tampil sebagai teks tanpa bingkai/ikon. Saat tanda tangan gagal, tidak ada tombol untuk langsung mengganti App Secret |
| 4 | 1 Hierarki | 3 | Bagian "Kontak" panel Info · 390 & 1440 | Tombol "Ubah kontak" (16 px semibold + ikon) lebih besar dari judul bagiannya "Kontak" (13 px). Hierarki terbalik dibanding bagian "Tag"/"Percakapan" yang tanpa tombol |

## Cara menilai

Worktree sementara dari HEAD, `pnpm install --frozen-lockfile`, API **3191**, web **5191**, database **`balesin_kd_e2e`**
(migrasi sampai `0020`), Redis **db 11**. 31 layar × 4 (**125 foto lulus**): `inbox-chat-detail-hp`, `inbox-detail-kontak`,
`-tag`, `-ubah-kontak`, `-hapus-kontak`, `-catatan`, `-berkas`, `-file`, `-ditandai`, `-log`, `batas-kirim` (+7 keadaan),
`nomor-webhook-diagnosis(-kosong)`, menu Pengaturan, plus verifikasi ruang chat & balasan cepat. Audit kontras / target /
teks terpotong 124 varian; uji klik mouse pada tab panel.

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Panel Info (`inbox-chat-detail-hp`, `inbox-detail-kontak`) | 390 · 1440 T/G | **3** | 4 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Tag + popover (`inbox-detail-tag`) | 390 · 1440 T/G | 5 | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| Ubah kontak (dialog) | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |
| Hapus kontak (dialog identitas) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Catatan | 390 · 1440 T/G | 5 | 5 | 5 | **3** | 5 | 5 | **3** | 5 | 4 | 5 |
| Berkas: Media / File / Ditandai | 390 · 1440 T/G | 5 | 5 | 5 | **3** | 5 | 5 | **3** | 5 | 4 | 5 |
| Log | 390 · 1440 T/G | 5 | 5 | 5 | **3** | 5 | 5 | **3** | 4 | 4 | 5 |
| `batas-kirim` (berjalan) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `-rem-ditarik`, `-tarik-rem`, `-lanjutkan` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `-isian-salah`, `-memuat`, `-gagal` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-webhook-diagnosis` | 390 · 1440 T/G | **3** | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-webhook-diagnosis-kosong` | 390 · 1440 T/G | **3** | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Menu Pengaturan (Balasan cepat, Batas kirim) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3 **pelanggaran**: warna tag Ungu/Toska memakai token lain (P1). Selebihnya bersih (ikon Lucide, satu tombol berwarna
  per dialog, bayangan hanya popover/dialog).
- §4: "Owner atau Admin di tempatmu" — lolos. Dialog tombol berwarna terakhir — lolos ("Hentikan pengiriman" merah,
  "Lanjutkan pengiriman" biru, "Hapus permanen" merah). Judul gagal "Batas kirim belum bisa dimuat" — lolos.

## Revisi, berurutan prioritas

### Wajib

**P1. Token palet tag ungu & toska**
— `packages/shared/src/design-tokens.ts`, `docs/DESIGN.md` §1 (tabel token turunan), `TagPicker.module.css`

Titik tag adalah elemen non-teks, jadi syaratnya ≥ 3:1 terhadap `--surface` (WCAG 1.4.11). Usulan (dihitung):

| Token | Terang | Kontras vs `--surface` #FFFFFF | Gelap | Kontras vs `--surface` #16202C |
|---|---|---|---|---|
| `--tag-purple` | `#7A52CC` | 5,4:1 | `#A98BF0` | 6,0:1 |
| `--tag-teal` | `#0B8A9E` | 4,1:1 | `#3CC4D6` | 7,8:1 |

- Ungu jelas berbeda dari `--primary` (#1167D8) dan toska (biru-hijau, ke arah sian) berbeda dari `--success`
  (#1F9D6B, hijau).
- Petakan juga warna tag lain secara eksplisit ke token yang ada: `gray` → `--ink-2`, `blue` → `--primary`, `green` →
  `--success`, `yellow` → `--warning`, `orange` → `--accent`, `red` → `--danger`.
- Hapus cincin pembeda sementara.
- Tambahkan kedua token ke `contrastPairs` sebagai pasangan non-teks (≥ 3:1) terhadap `surface`, `surface-2`, dan `bg`.
- Kriteria lolos: tag "Ungu" tampil ungu dan "Toska" tampil toska di terang & gelap; tes kontras hijau.

**P2. Cincin fokus tab hanya untuk keyboard**
— komponen tab panel detail (`ContactPanel.tsx`), `ContactPanel.module.css` (`.tab:focus-visible`, baris 161)

- Klik mouse memunculkan `:focus-visible`. Kemungkinan karena fokus dipindah secara terprogram setelah klik (mis.
  `tab.focus()` atau fokus ke panel). Jangan memindahkan fokus pada aktivasi pointer; fokus terprogram cukup untuk
  navigasi panah.
- Cincinnya juga diberi `border-radius: var(--radius-input)` supaya tidak berupa kotak tajam yang menabrak garis bawah.
- Kriteria lolos: setelah `mouse.click` pada tab, `:focus-visible` = false; dengan Tab/panah cincin tetap terlihat.

**P3. Diagnosis webhook di atas, dengan aksi**
— `apps/web/src/features/channels/WebhookPanel.tsx` / kartu diagnosis, `SectionNav.tsx`

- Pindahkan "Diagnosis 24 jam terakhir" ke **awal** kartu Webhook (di atas URL), atau jadikan kartu sendiri setelah
  Ringkasan dengan entri navigasi bagian "Diagnosis".
- "Periksa lagi" → tombol sekunder dengan ikon `refresh-cw` 16 px.
- Untuk tanda tangan gagal, tambahkan tombol **"Ganti App Secret"** di kotak "Ada yang perlu dicek" yang membuka form
  Kredensial Meta dengan isian App Secret terfokus (pola W2 halaman nomor).
- Kriteria lolos: di 1440 diagnosis terlihat tanpa menggulir melewati URL/token; tindakan perbaikan dapat dicapai satu
  klik.

**P4. "Ubah kontak" tidak mengalahkan judul bagiannya**
— `ContactPanel.tsx` / `.module.css` (kepala bagian Kontak)

- Tombol ukuran kecil: huruf 13 px semibold `--primary` (atau `--ink-2` + ikon 16 px), tinggi 32 px di desktop / 44 px
  area tekan di HP, sejajar garis dasar judul "Kontak".
- Kriteria lolos: ukuran huruf tombol ≤ ukuran judul bagian.

### Saran (tidak menahan)

- **P-S1.** Log: "menugaskan percakapan ke Agus dari Rina Kartika" → "mengalihkan percakapan dari Rina Kartika ke Agus".
- **P-S2.** Berkas → File: baris audio hanya tombol "Putar audio" tanpa bingkai, sedangkan dokumen dalam kartu. Samakan
  menjadi kartu "🎵 Pesan suara · dari pelanggan [Putar]" (ikon Lucide `music`, bukan emoji).
- **P-S3.** Menu Pengaturan baris "Batas kirim": saat rem ditarik tampilkan status "● Rem ditarik" (`--danger`) sebagai
  ganti "128 pesan dalam 24 jam", supaya Owner langsung melihatnya.
- **P-S4.** Popover tag: saat membuat tag baru, tawarkan pilihan warna (sekarang otomatis) begitu P1 selesai.

## Bersih-bersih

Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo: laporan ini + 26 screenshot, bagian "Putaran 3" laporan
ruang chat (+3 `p3-*.png`), bagian "Putaran 2" laporan penanganan & template (+6 `p2-*.png`). Tidak ada kode produk yang
diubah, tidak ada commit.
