# Penilaian desain — UI Fase 5: Kontak, Tiket, Departemen, Laporan, CSAT

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** HEAD `2a09122` (UI Fase 5 ada di `3a18705`).
- **Cara:**
  - Worktree terisolasi: API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0030`, Redis db 11, 3 worker.
  - 22 layar `e2e/capture/screens-crm.ts` × 390/1440 × terang/gelap.
  - Layar tambahan khusus penilaian, hanya di worktree:
    - Kanban: fokus keyboard pada pegangan, dan kartu diangkat dengan keyboard (Spasi → → → ↓).
    - Bagian bawah: laporan kinerja, laporan biaya, detail tiket, detail kontak.
    - Laporan "Lihat sebagai tabel".
    - Pengaturan → Tim → anggota (kartu Departemen).
    - Inbox → Tindakan chat → Pindah departemen.
  - Audit terukur di 360/390/1440, terang/gelap: kontras teks, target sentuh sampai 4 tinggi layar ke bawah, teks
    terpotong, scroll horizontal.
- **Screenshot:** `docs/design-reviews/2026-11-22-fase5-crm-tiket-laporan/`.

## Putusan: REVISI

Fase 5 dibangun di atas pola yang sudah matang. Pengantar halaman jujur, keadaan kosong/memuat/error dirancang, dan
istilah "kamu" serta "Owner atau Admin" konsisten.

**Kontak**
- Saringan tag, atribut, dan "Mungkin duplikat".
- Peringatan duplikat dengan jalan keluar "Gabung kontak".
- Impor "Periksa dulu" yang tidak menyimpan apa pun.

**Laporan**
- Grafik SVG punya tabel alternatif.
- Biaya Meta selalu berlabel "Perkiraan".

**Seret-lepas Kanban**
- Bisa dipakai dengan keyboard:
  - Spasi mengangkat kartu; panah kiri/kanan pindah kolom, atas/bawah mengubah urutan.
  - Spasi/Enter meletakkan, Escape membatalkan.
  - Setiap langkah diumumkan `aria-live`.
- Fokus mengikuti kartu yang pindah kolom.
- Cincin fokus 2 px `--primary` terlihat jelas (`tiket-kanban-keyboard-*.png`).
- Ada menu "Pindah ke…" di setiap kartu sebagai alternatif.

Audit:
- Tidak ada scroll horizontal di 360/390/1440.
- Tidak ada teks < 4,5:1. Satu temuan 3,98:1 pada "Periksa dulu" (gelap) adalah warna di tengah transisi saat tombol
  berganti dari primary ke secondary setelah pemeriksaan, bukan keadaan diam.

Yang menahan ada di empat area:
- **Bahasa:** kategori Inggris di laporan biaya, melanggar §3.
- **HP:**
  - Tabel laporan memotong kolom kunci.
  - Kanban menghabiskan lebih dari separuh layar untuk kontrol.
  - Target < 44 px.
- **Teks terpotong:** judul tiket di detail kontak, "Tambah kolom" di 1440.
- **Keputusan yang sulit dibuat:** dialog gabung dua kontak bernama sama tanpa pengenal.

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 8 Bahasa (§3) | 3 | `laporan-biaya` · semua ukuran | Tabel kategori "**Marketing**", "**Utility**", "Autentikasi". Di halaman template kategori yang sama tertulis "Pemasaran" / "Utilitas" |
| 2 | 5 Responsif, 1 Hierarki | 3 | Laporan biaya + kinerja · 390/360 | Tabel bergulir menyamping tanpa tanda. Kolom **Biaya** terpotong ("Rp 70▌"); "Respons pertama (median)" dan "CSAT" di Per agen, serta "Rata-rata respons perta▌" di tabel tren tidak terlihat |
| 3 | 1 Hierarki, 5 Responsif | 3 | `tiket-kanban` · 390 | Kartu pertama baru mulai di ±495 px dari 844. Di atasnya: board, Kanban/Daftar, Atur board/Board baru, 2 saringan, "Pilih kolom", lalu kepala kolom yang mengulang "Baru 2" |
| 4 | 5 Responsif | 3 | Kanban 390/360 | Judul kartu (satu-satunya tautan ke detail) **322 × 20 px**. Item menu "Pindah ke…" **198 × 36 px**. Pegangan seret tampil di HP padahal seret dimatikan (`draggable={!isHp}`) |
| 5 | 4 Kerapian | 3 | `tiket-kanban` · 1440 | "+ Tambah kolo▌" terpotong di tepi kanan: 4 kolom × 18rem + celah mendorong tombol keluar wadah gulir |
| 6 | 3 Tipografi | 3 | `kontak-detail` · 1440/390 | Judul tiket terhimpit lencana: "Internet putus ..." hanya **110 px** di 1440, "Internet putus sej…" di 390 |
| 7 | 1 Hierarki, 9 Profesional | 3 | `kontak-gabung` | Dua opsi sama-sama "Budi Santoso". Yang lama hanya "Dibuat 23 Mar 2026", padahal punya email `budi.santoso@gmail.com`. Pengguna memilih kontak yang **dihapus permanen** tanpa bisa membedakannya |
| 8 | 4 Kerapian | 3 | `tiket-daftar` · 1440 | Kolom kanan zigzag: "Mendesak" mulai di x≈1990, "Normal" di 2200 / 2017, "Tinggi" di 1870 / 2214. Prioritas, tenggat, dan avatar tidak sejajar antarbaris |
| 9 | 5 Responsif | 3 | 390/360 | Kontak & percakapan di `tiket-detail` **126 × 16** dan **90 × 16**; chip anggota di `departemen` **155–277 × 32**; "Ubah tarif di Pengaturan → Batas kirim" **310 × 35** |
| 10 | 8 Bahasa | 3 | Departemen, Tim, Tiket | Satu tanda akses disebut tiga cara: "hanya departemen sendiri" (pengantar), "Hanya departemen ini" (lencana), "Hanya lihat chat & tiket departemennya" (kotak centang) |

## Tabel nilai

T/G = terang dan gelap bernilai sama kecuali disebut.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `kontak-daftar` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `kontak-kosong`, `kontak-memuat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `kontak-detail` | 1440 T/G | 4 | 5 | **3** | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `kontak-gabung` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 4 | **3** | 5 |
| `kontak-impor` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `atribut-kontak`, `-tambah` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 4 | 5 |
| `tiket-kanban` | 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | 4 | **3** | 5 | 4 | 5 | 4 | 5 |
| `tiket-kanban-pindah` | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | 4 | **3** | 5 | 4 | 5 | 4 | 5 |
| Kanban keyboard (angkat, fokus) | 1440 T | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 5 |
| `tiket-daftar` | 1440 T/G | 5 | 5 | 5 | **3** | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 4 | 5 | 5 | 4 | 4 | 5 |
| `tiket-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `tiket-detail` | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| `tiket-baru` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 |
| `tiket-atur-board` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 4 | 5 |
| `departemen` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 5 | **3** | 5 | 5 | **3** | 4 | 5 |
| `departemen-ubah` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 |
| Anggota → Departemen | 1440 T | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| Pindah departemen (inbox) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `laporan-kinerja` | 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 4 | 5 | 4 | 4 | **3** | 5 | 5 | 4 | 4 | 5 |
| `laporan-biaya` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | 4 | **3** | 5 | 5 | **3** | 4 | 5 |
| `laporan-saya` | 390 · 1440 T/G | 5 | 5 | 4 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `laporan-berat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `csat-pengaturan` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3 **dilanggar sekali:** "Marketing", "Utility" (English nyasar) di `laporan-biaya` (F1). Selain itu bersih:
  - Ikon Lucide, warna hanya dari token (grafik `--primary` + `--tag-teal`, prioritas `--danger-ink` / `--warning-ink`).
  - Tanpa gradien atau glassmorphism.
  - Satu tombol berwarna per kartu/dialog.
- §4 lolos:
  - Tombol berwarna terakhir di dialog.
  - "Owner atau Admin", "kamu/-mu".
  - Judul gagal "Laporan belum bisa dimuat".
- §4 temuan:
  - "Dihitung **Hari ini**, 10.34" memakai huruf besar di tengah kalimat (pola §4 "Hari ini, 03.47" hanya untuk awal
    baris/label).
  - Istilah pembatasan departemen tidak tunggal (F9).

## Revisi

### Wajib (urut prioritas)

**F1. Kategori biaya dalam bahasa Indonesia** — `apps/web/src/i18n/id.ts` (`reports.categories`, ±baris 1654)

- `MARKETING: 'Pemasaran'`, `UTILITY: 'Utilitas'` (sama dengan `templates`, ±baris 3520). Sekalian rapikan kalimat di
  laporan biaya:
  - "Sumber tarif: Perkiraan bawaan: tarif Meta …" (dua titik dua beruntun) → **"Sumber tarif: perkiraan bawaan
    (tarif Meta untuk nomor Indonesia per 30 Sep 2026). Periksa rate card resmi Meta lalu sesuaikan."**
  - "Dihitung Hari ini, 10.34" → **"Dihitung hari ini, 10.34"**.
- Kriteria lolos: tidak ada "Marketing"/"Utility" di UI. Kalimat sumber tarif hanya punya satu ":".

**F2. Tabel laporan terbaca di HP** — `apps/web/src/features/reports/ReportBits.tsx` / `CostsReport.tsx`,
`Reports.module.css` (`.tableScroll`, `.table`)

- Di `@media (max-width: 640px)` ubah setiap baris tabel menjadi blok bertumpuk:
  - `thead` disembunyikan.
  - `td` `display: flex; justify-content: space-between`.
  - Label kolom dari `data-label` lewat `td::before { content: attr(data-label); color: var(--ink-2) }`.
  - Sel pertama (Agen/Kategori/Tanggal/Tag) menjadi judul blok, `font-weight: semibold`.
- Bila tetap bergulir, minimal:
  - Bekukan kolom pertama (`position: sticky; left: 0; background: var(--surface)`).
  - Beri bayangan tepi kanan sebagai tanda bisa digulir.
  - Pindahkan **Biaya** menjadi kolom kedua di tabel template.
- Kriteria lolos di 390 dan 360, tanpa gulir menyamping:
  - Biaya setiap kategori terlihat.
  - Respons pertama dan CSAT setiap agen terlihat.
  - Rata-rata respons pertama di tabel tren terlihat.

**F3. Kanban di HP: kartu bisa diketuk, menu cukup besar, tanpa pegangan palsu** — `KanbanBoard.tsx` (`TicketCard`,
`MoveMenu`), `Tickets.module.css`

- Jadikan seluruh kartu area ketuk ke detail. Pakai pola tautan yang direntang: `.cardTitle::after { content: '';
  position: absolute; inset: 0 }` dengan `.card { position: relative }`. Pegangan dan tombol "Pindah ke…" diberi
  `position: relative; z-index: 1` supaya tetap bisa diketuk terpisah.
- `.menuItem` di `@media (max-width: 640px), (pointer: coarse)`: `min-height: var(--size-touch)`.
- Di HP pegangan seret tidak punya fungsi sentuh. Sembunyikan `.handle` di `(pointer: coarse)` dan biarkan menu
  "Pindah ke…" sebagai jalan pindah. Pegangan tetap ada untuk keyboard/mouse di desktop.
- Menu "Pindah ke…" harus menandai kolom sekarang:
  - Tampilkan "Baru · sekarang" dengan bulatan terisi, nonaktif.
  - Jangan pakai ikon centang-lingkaran untuk "Selesai" di daftar yang berbentuk pilihan radio. Sekarang "Selesai"
    satu-satunya yang tampak tercentang dan terbaca seperti pilihan aktif. Ganti dengan teks kecil "kolom selesai".
- Kriteria lolos:
  - Audit 390/360 di `tiket-kanban*`: tidak ada target < 44 px.
  - Kolom sekarang terlihat berbeda di menu.

**F4. Kanban HP: kartu pertama di paruh atas layar** — `TicketsPage.tsx` (bilah alat), `KanbanBoard.tsx`

- Rapikan bilah alat di ≤ 640 px:
  - "Atur board" + "Board baru" masuk ke satu tombol "⋯ Board" (44 × 44) di baris pemilih board.
  - Penanggung jawab + Prioritas masuk ke tombol **"Saring"** dengan chip aktif di bawahnya (pola `InboxFilterMenu`).
  - Kepala kolom tidak diulang di bawah "Pilih kolom": cukup jumlah dan menu kolom di kanan pemilih.
- Kriteria lolos: di 390 × 844 tepi atas kartu pertama ≤ 400 px (sekarang ±495 px).

**F5. "Tambah kolom" tidak terpotong di 1440** — `Tickets.module.css` (`.column`, `.addColumn`) atau `TicketsPage.tsx`

- Pilih salah satu:
  - Kolom `flex: 0 0 17rem` (4 kolom + tombol muat di 1.328 px).
  - Pindahkan "Tambah kolom" ke bilah alat di samping "Atur board".
  - Beri `.kanban` `padding-inline-end: var(--space-16)` dan `scroll-padding` supaya tepi kanan selalu jatuh di antara
    elemen, bukan di tengah kata.
- Kriteria lolos: board 4 kolom di 1440 × 900 tidak memotong teks di tepi wadah.

**F6. Judul tiket utuh di detail kontak / panel chat** — `LinkedTickets.tsx`, `Tickets.module.css` (`.linkedItem`,
`.linkedTitle`)

- `.linkedTitle { flex: 1 1 100%; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; }`.
- Nomor tiket dan meta (prioritas · kolom) satu baris di bawah judul.
- Kriteria lolos: judul ≤ 60 karakter tidak berelipsis di 1440 dan 390 (contoh "Internet putus sejak pagi, lampu LOS
  merah").

**F7. Gabung kontak: opsi bisa dibedakan** — `MergeDialog.tsx`

- Setiap opsi menampilkan minimal satu pengenal: nomor, lalu email, lalu `@username`, lalu channel. Tambahkan jumlah
  percakapan/tiket bila tersedia ("3 chat · 1 tiket").
- Kalimat bawah: "Data kontak yang dipertahankan menang; isian kosongnya diisi dari kontak lain." → **"Bila isian
  berbeda, data kontak yang dipertahankan dipakai. Isian yang kosong diisi dari kontak lain."**
- Pola yang sama berlaku di `kontak-daftar`: baris tanpa nomor menampilkan "WhatsApp" saja. Tampilkan email/username
  di sana.
- Kriteria lolos: kedua opsi di `kontak-gabung` menampilkan pengenal yang berbeda.

**F8. Target sentuh di HP** — `TicketDetailPage.tsx` (Rincian: tautan Kontak/Percakapan), `Departments.module.css`
(`.member`), `CostsReport.tsx` (tautan tarif), `ContactDetailPage.tsx` ("Lihat kontak lainnya")

- `min-height: var(--size-touch)` + `display: inline-flex; align-items: center` di ≤ 640 px / `(pointer: coarse)` untuk:
  - tautan Rincian tiket;
  - chip anggota (`.member`, sekarang `min-height: 2rem`);
  - tautan "Ubah tarif di Pengaturan → Batas kirim".
- Kriteria lolos: audit 390/360 di layar Fase 5 tidak menemukan target < 44 px, selain isian 42 px dalam bingkai 44
  yang sudah diterima.

**F9. Satu istilah untuk pembatasan departemen** — `apps/web/src/i18n/id.ts` (±baris 1441, 1550, 1558, 1587, 1597,
1617)

- Pakai satu keluarga kata. Usulan:
  - Kotak centang: "Hanya lihat chat & tiket departemennya" (tetap).
  - Lencana: **"Terbatas ke departemen"**.
  - Kalimat pengantar: **"anggota yang dibatasi ke departemennya"**.
- Di kartu Departemen anggota, pisahkan kotak centang pembatasan dari daftar departemen. Beri garis pemisah dan subjudul
  kecil **"Batas akses"**. Sekarang kotak itu tampak seperti departemen ketiga.
- Kriteria lolos: frasa "hanya departemen sendiri" dan "Hanya departemen ini" tidak muncul lagi.

**F10. Kolom kanan Daftar tiket sejajar** — `TicketList.tsx`, `Tickets.module.css` (`.listLink`)

- Ganti `display: flex` dengan grid: `grid-template-columns: minmax(0, 1fr) 7rem 13rem 2.5rem` (judul+meta · prioritas
  · tenggat · avatar). Sel kosong tetap memegang tempat.
- Kriteria lolos: di `tiket-daftar` 1440 tepi kiri label prioritas, ikon tenggat, dan avatar sejajar (±1 px) di semua
  baris.

### Saran (tidak menahan)

- **F-S1. Petunjuk terlihat saat kartu diangkat dengan keyboard.** Petunjuk sekarang hanya untuk pembaca layar. Tampilkan
  strip kecil di atas board selama `grab` aktif: **"← → pindah kolom · ↑ ↓ ubah urutan · Spasi letakkan · Esc
  batal"**. Cincin fokus pada pegangan juga menempel ke "#241". Beri `margin-inline-end: var(--space-4)` pada
  `.handle`.
- **F-S2.** Ikon tombol "Pindah ke…" (`MoveRight` →) di pojok kartu terbaca seperti "buka". Ganti `ArrowRightLeft`, atau
  pakai `MoreHorizontal` dengan judul menu "Pindah ke…".
- **F-S3.** Penanggung jawab kosong tampil sebagai lingkaran putus-putus berisi "-". Ganti ikon `UserPlus` 16 px
  `--ink-2` dengan `title`/label "Belum ada penanggung jawab".
- **F-S4. Detail tiket.**
  - Tenggat tampil dua kali (isian native "18/11/2026 13:44" dan "18 Nov, 13.44" di bawahnya). Teks bawah lebih
    berguna sebagai status: "Lewat tenggat" / "3 jam lagi".
  - "Hapus tenggat" (ghost) menjorok 28 px dari tepi isian.
  - "Hapus tiket" sejajar dengan "Ubah" di kepala halaman. Pindahkan ke menu "⋯" (pola TM-S1).
  - Di HP "Rincian" (kolom, penanggung jawab) berada di bawah semua komentar. Taruh di atas tab Komentar/Riwayat.
- **F-S5. Laporan.**
  - "1 j 30 mnt", "2 j" → **"1 jam 30 mnt"**, **"2 jam"** ("j" bukan singkatan lazim).
  - Petak "Dibalas tim 402" berketerangan "Selesai oleh bot saja: 133 · Diserahkan bot ke tim: 188", isi yang bukan
    tentang tim. Jadikan petak sendiri "Bot".
  - Di HP "Unduh CSV" berada di tengah sendirian di bawah judul kartu. Ratakan kiri atau taruh di kanan judul.
  - Petak biaya "Percakapan 1.386 / Ditagih 386" → **"Percakapan layanan"** supaya tidak tertukar dengan kolom "Ditagih"
    template di bawahnya.
- **F-S6. Detail kontak.**
  - Baris lepas "dari WhatsApp" di bawah "WhatsApp · Dibuat …" membingungkan. Tulis **"Nama dari profil WhatsApp"** atau
    jadikan lencana di samping nama.
  - "Lihat kontak lainnya" (ghost) tidak sejajar dengan teks peringatan (menjorok di 390). Jadikan tautan teks sejajar
    atau tombol berbingkai seperti "Gabung kontak".
  - Judul "Data pribadi" 13 px, padahal kartu lain 20 px.
  - Atribut tanpa definisi tampil sebagai kunci huruf kecil "kota". Beri penanda "(atribut bebas)".
- **F-S7. Atribut kontak & Atur board.**
  - ↑ di baris pertama dan ↓ di baris terakhir harus nonaktif.
  - Kotak centang "kolom selesai" tanpa label terlihat: beri judul kolom kecil "Selesai" atau teks di sampingnya.
  - Ikon hapus merah di setiap baris memberi bobot berlebih. Pakai `--ink-2`, warna bahaya cukup di dialog konfirmasi.
- **F-S8. CSAT:** teks bantuan "Jarak antar-survei" terjepit selebar isian (3 baris). Biarkan selebar kartu.
- **F-S9. Ubah departemen:** "Chat **BARU** dari pelanggan …" → "Chat **baru** dari pelanggan …" (tebal bila perlu
  penekanan, bukan huruf besar).
- **F-S10.** Petak hasil impor memakai label di atas angka, petak broadcast memakai angka di atas label. Samakan satu
  pola.
- **F-S11 (`qa-tester`, data contoh).**
  - `laporan-kinerja`: rentang "7 hari terakhir · 12–18 Nov" tetapi grafik 14 batang (5–18 Nov).
  - `laporan-saya`: "41 jawaban dari 64 survei" tetapi sebaran berjumlah 121.
  - `laporan-biaya`: Utility "Gratis 210" > Terkirim − Ditagih (54).
  - `kontak-daftar`: kontak bernama "+62 813-3801-4422" dengan nomor "+62 812-3003-9595".
  - Zona waktu "Asia/Makassar" di satu layar dan "Asia/Jakarta" di layar lain.
- **F-S12.** Isian tanggal/jam native menampilkan "dd/mm/yyyy --:--" dan "13:44" (titik dua) mengikuti locale OS.
  Terima untuk sekarang. Bila nanti ada pemilih tanggal sendiri, pakai format §4 ("pukul 13.44").

## Bersih-bersih

- Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama).
- Port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0.
- Berkas repo:
  - laporan ini + 41 screenshot;
  - bagian "Putaran 2" laporan broadcast (+10 `p2-*.png`);
  - bagian "Putaran 3" laporan template (+5 `p3-*.png`).
- Tidak ada kode produk yang diubah, tidak ada commit.

---

# Putaran 2

- **Tanggal:** 2026-11-19 · **Penilai:** `kritikus-desain` · **Putaran:** 2
- **Kode yang dinilai:** HEAD `15d977b` (revisi UI Fase 5 ada di `9aeb2f1`).
- **Cara:**
  - Worktree terisolasi dari HEAD: API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0030`, Redis db 11, 2 worker.
  - 22 layar `e2e/capture/screens-crm.ts` × 390/1440 × terang/gelap.
  - Foto tinggi tambahan (390 × 2600 dan 1440 × 2000) supaya tabel laporan, detail tiket, dan Atur board terlihat utuh.
  - Kanban keyboard di 1440: fokus pegangan, Spasi, lalu →.
  - Audit terukur di 360/390/1440, terang/gelap: kontras teks, target sentuh sampai 4 tinggi layar ke bawah, teks
    terpotong, scroll horizontal.
- **Screenshot:** berkas berawalan `p2-` di `docs/design-reviews/2026-11-22-fase5-crm-tiket-laporan/`.

## Putusan putaran 2: REVISI (satu butir kecil)

Semua revisi wajib F1–F10 lolos dan sebagian besar saran ikut dikerjakan. Audit: tidak ada teks < 4,5:1 dan tidak ada
scroll horizontal di 360, 390, maupun 1440. Yang tersisa satu regresi kecil di 360 px (F11).

| Butir | Hasil (terukur) | Status |
|---|---|---|
| **F1** bahasa laporan biaya | Tabel kategori "Pemasaran", "Utilitas", "Autentikasi". "Sumber tarif" menjadi label sendiri dan kalimatnya hanya punya satu ":". "Dihitung hari ini, 11.14" | Lolos |
| **F2** tabel laporan di HP | Di 390 setiap baris menjadi blok bertumpuk: nama kategori/agen sebagai judul, label kiri, nilai kanan. Biaya setiap kategori, Respons pertama, dan CSAT per agen terlihat tanpa gulir menyamping (`p2-laporan-*-tabel--390-terang.png`) | Lolos |
| **F3** Kanban HP | Seluruh kartu bisa diketuk (tautan direntang). Item menu "Pindah ke…" setinggi 44 px. Pegangan seret tersembunyi di layar sentuh. Kolom sekarang ditandai "● Baru · sekarang", dan "Selesai" diberi catatan "kolom selesai" (`p2-tiket-kanban-pindah--390-terang.png`) | Lolos |
| **F4** kartu pertama di paruh atas | Tepi atas kartu pertama ±306 px dari 844 (sebelumnya ±495). Tombol "⋮" board dan "Saring" menggantikan dua baris kontrol | Lolos |
| **F5** "Tambah kolom" di 1440 | Teks utuh. Kolom 17rem; 4 kolom + tombol muat di 1440 | Lolos |
| **F6** judul tiket di detail kontak | "Internet putus sejak pagi, lampu LOS merah" turun 2 baris tanpa elipsis. Nomor dan prioritas pindah ke baris meta | Lolos |
| **F7** gabung kontak | Opsi pertama "+62 812-3000-7919", opsi kedua "budi.santoso@gmail.com". Kalimat bawah sudah diganti sesuai usulan | Lolos |
| **F8** target sentuh | Tautan Kontak/Percakapan di detail tiket, chip anggota departemen, dan "Ubah tarif di Pengaturan → Batas kirim" ≥ 44 px di 390/360 | Lolos (lihat F11) |
| **F9** istilah pembatasan | Lencana "Terbatas ke departemen". Pengantar "anggota yang dibatasi ke departemennya". Subjudul "Batas akses" | Lolos |
| **F10** daftar tiket sejajar | Di semua baris, prioritas mulai di x≈1690, tenggat di x≈1908, dan avatar di x≈2325 (koordinat foto). Sel kosong tetap memegang tempat | Lolos |
| S1 petunjuk keyboard | Strip "← → pindah kolom · ↑ ↓ ubah urutan · Spasi letakkan · Esc batal" tampil selama kartu diangkat. Pegangan tidak lagi menempel ke "#241" | Lolos |
| S2 ikon "Pindah ke…" | `ArrowRightLeft` | Lolos |
| S3 penanggung jawab kosong | Ikon `UserPlus` dalam lingkaran putus-putus | Lolos |
| S4 detail tiket | Di HP, Rincian sudah di atas komentar. Tiga hal belum dikerjakan: tenggat masih tampil dua kali ("19/11/2026 14:07" dan "19 Nov, 14.07"), "Hapus tenggat" masih menjorok, "Hapus tiket" masih sejajar dengan "Ubah" | Sebagian |
| S5 laporan | "1 jam 30 mnt" dan petak "Bot" tersendiri sudah ada. "Unduh CSV" di HP masih menjorok sendirian di bawah judul kartu | Sebagian |
| S6 detail kontak | "Nama dari profil WhatsApp" dan "kota (atribut bebas)" sudah ada. Dua hal tersisa: judul "Data pribadi" masih 13 px, dan "Lihat kontak lainnya" tanpa ikon di samping "Gabung kontak" yang berikon | Sebagian |
| S7 Atur board | Kotak centang berlabel "Selesai", ikon hapus `--ink-2` | Lolos |
| S9 departemen | "Chat baru dari pelanggan…" | Lolos |
| S11 data contoh | 7 batang untuk "7 hari terakhir"; "121 jawaban dari 186 survei" sama dengan jumlah sebaran; Utilitas Gratis 54 = 1.420 − 1.366 | Lolos |

### Wajib

**F11. Tombol baris kolom di Atur board menyusut di 360 px** — `BoardSettingsPage.tsx`, `Tickets.module.css`
(`.columnRowActions`, ±baris 986 dan `@media` ±baris 1256)

- Terukur di `tiket-atur-board` 360 (terang & gelap): Naikkan, Turunkan, Ganti nama, dan Hapus kolom berukuran
  **36 × 44 px** di setiap baris. Di 390 masih 44 × 44.
- Penyebab: kotak centang "Selesai" yang baru diberi label (saran F-S7) membuat baris lebih lebar, lalu tombol ikon ikut
  menyusut (`flex-shrink`).
- Perbaikan:
  - `.columnRowActions > button { flex: none; width: var(--size-touch); }`.
  - Biarkan kotak "Selesai" yang menyusut (`min-width: 0`), atau di ≤ 400 px pindahkan kotak itu ke baris sendiri di
    bawah nama kolom.
- Kriteria lolos: audit 360/390 `tiket-atur-board` tidak menemukan target < 44 px.

### Saran (tidak menahan)

- **F-S12. Tombol ghost menjorok dari garis teks (pola berulang).**
  - Contoh: "Unduh CSV" dan "Lihat sebagai tabel" di laporan HP, "Hapus tenggat", "Buat tiket", dan juga di layar kanal
    ("Lihat versi HTML", "Salin").
  - Ikon tombol mulai 24–32 px di kanan tepi teks di atasnya karena padding tombol.
  - Di kelompok kartu, pakai satu varian "ghost rata kiri", misalnya
    `margin-inline-start: calc(-1 * var(--space-12))` pada `Button variant="ghost"` di dalam `.cardBody`, atau taruh
    tombol di kanan judul kartu (seperti di 1440).
- **F-S13. Kanban HP.**
  - Dua tombol "⋮" bersebelahan berbeda gaya: menu board berbingkai 44 × 44, menu kolom tanpa bingkai. Samakan
    (berbingkai).
  - Segmen Kanban/Daftar setinggi ±54 px, tombol "Saring" di sampingnya 44 px. Samakan tinggi ke `--size-touch`.
  - "#241" (12 px) duduk ±3 px lebih tinggi dari "● Mendesak". Gunakan `align-items: baseline` di kepala kartu.
- **F-S14.** Daftar tiket 390: judul tetap satu baris berelipsis ("Internet putus sejak pagi, lampu LO…"). Pakai
  `-webkit-line-clamp: 2` seperti F6.
- **F-S15.** Sisa S4, S5, dan S6 di atas.
- **F-S16.** `laporan-biaya`: "rate card" masih bahasa Inggris. Usulan:
  **"Periksa daftar tarif resmi Meta (rate card) lalu sesuaikan."**

### Tabel nilai putaran 2

T/G = terang dan gelap bernilai sama.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `kontak-daftar`, `-kosong`, `-memuat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `kontak-detail` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `kontak-gabung` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `kontak-impor` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `atribut-kontak`, `-tambah` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `tiket-kanban` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `tiket-kanban-pindah` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |
| Kanban keyboard | 1440 T | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `tiket-daftar` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 5 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `tiket-kosong`, `tiket-baru` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `tiket-detail` | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `tiket-atur-board` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 360 T/G | 5 | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| `departemen`, `departemen-ubah` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `laporan-kinerja` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `laporan-biaya` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `laporan-saya`, `laporan-berat` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `csat-pengaturan` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |

**§3 dan §4:**
- §3 bersih: kategori sudah berbahasa Indonesia, ikon Lucide, warna dari token, satu tombol berwarna per kartu/dialog.
- §4 lolos.
