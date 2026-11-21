# Penilaian desain — Broadcast (Fase 4)

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `83a4e87` ("feat(broadcast): UI broadcast — daftar, wizard, detail & laporan, persetujuan, konektor
  data, alarm Telegram; revisi template TM1–TM3"). HEAD utama sudah `e02f104`; backend WIP di working tree utama tidak
  ikut.
- **Cara:** worktree terisolasi (API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0027`, Redis db 11), 3 worker.
  `broadcast-kosong`, `-daftar`, `-baru`, `-penerima`, `-variabel`, `-kirim`, `-berjalan`, `-persetujuan`, `-dijeda`,
  `konektor-data`, `konektor-tambah`, `alarm-telegram(-aktif)`, `pengaturan-broadcast` × 390/1440 × terang/gelap + 360:
  **199 uji lulus** (foto + audit kontras, target sentuh, teks terpotong).
- **Screenshot:** `docs/design-reviews/2026-11-21-fase4-broadcast/`.

## Putusan: REVISI

Broadcast adalah fitur paling berisiko (biaya dan blokir nomor), dan UI-nya memperlakukannya dengan serius.

**Daftar kampanye**
- Kartu per kampanye: status berwarna (Berjalan / Menunggu persetujuan / Dijeda / Terjadwal / Selesai), template, nomor,
  jumlah penerima, bilah kemajuan, perkiraan biaya.

**Wizard 4 langkah (Dasar · Penerima · Isi pesan · Jadwal & kirim)**
- Sumber penerima: berkas / segmen kontak / konektor, dengan laporan baris yang tidak dipakai beserta penyebab yang bisa
  ditindaklanjuti ("format ilmiah Excel … ubah kolom menjadi Teks").
- Pemetaan variabel ke kolom + pratinjau dua penerima nyata.
- Kecepatan, anti-dobel, perkiraan biaya yang jujur ("Perkiraan, bukan tagihan resmi Meta"), ambang persetujuan dijelaskan.

**Detail kampanye**
- Jeda, Ekspor CSV, Batalkan.
- Petak hasil, biaya sebenarnya vs perkiraan, alasan gagal dengan kode Meta, alasan dilewati.
- Persetujuan: Setujui / Tolak dengan penjelasan ambang.
- Rem otomatis: kotak merah + "Lanjutkan" hanya untuk Owner/Admin.

**Konektor data dan Alarm Telegram**
- Konektor: rahasia di header, peringatan "Alamat ini memuat parameter yang tampak rahasia (api_key)".
- Alarm Telegram: panduan @BotFather, keadaan aktif dengan "Kirim pesan tes".

Audit: tidak ada teks < 4,5:1, tidak ada scroll horizontal.

| # | Kriteria | Nilai | Layar | Sebab |
|---|---|---|---|---|
| 1 | 6 Keadaan, 1 Hierarki | 3 | `broadcast-persetujuan` · 390 & 1440 | Kampanye yang **belum disetujui** menampilkan "Hasil kampanye": 836 dari 1.248 diproses, 96 terkirim, 19 gagal, biaya Rp 254.463, "Diperbarui otomatis selama kampanye berjalan". Penyetuju bisa mengira kampanye sudah terkirim |
| 2 | 8 Bahasa, 1 Hierarki | 3 | `broadcast-berjalan`, `-persetujuan`, `-dijeda` | Petak hasil tidak jelas eksklusif atau kumulatif: Terkirim **96**, Diterima **402**, Dibaca **299**, padahal biaya "untuk **701** pesan terkirim" — angka yang tidak cocok dengan petak mana pun (96 + 402 + 299 = 797). Orang membaca "96 terkirim" sebagai total pesan terkirim |
| 3 | 8 Bahasa, 4 Kerapian | 3 | `broadcast-penerima` · 390 & 1440 | Laporan baris dobel: daftar per baris ("Baris 18: Nomor tidak valid" …) lalu daftar ringkasan berisi hal yang sama ("Nomor tidak valid: 1" …) dengan tanda baca rusak "… lalu unggah ulang.**:** 1". Kalimat "Mengambil penerima lagi menggantikan daftar sebelumnya." kaku |
| 4 | 5 Responsif | 3 | `broadcast-baru`, `-penerima`, `-variabel` · 390/360; `broadcast-daftar` · 390 | Langkah wizard di HP hanya angka **40 × 44 px** tanpa label; tautan nama kampanye di daftar **296 × 20 px** (pola TM3 template) |

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `broadcast-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `broadcast-daftar` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| `broadcast-baru` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 4 | 5 |
| `broadcast-penerima` | 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | **3** | **3** | 5 | 5 | **3** | 4 | 5 |
| `broadcast-variabel` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 5 |
| `broadcast-kirim` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 5 | 5 |
| `broadcast-berjalan` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `broadcast-persetujuan` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | **3** | 5 | **3** | 4 | 5 |
| `broadcast-dijeda` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `konektor-data`, `konektor-tambah` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `alarm-telegram`, `-aktif` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `pengaturan-broadcast` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3: bersih (ikon Lucide, token, satu tombol berwarna per kartu/dialog).
- §4: "Owner atau Admin di tempatmu / selain kamu" — lolos. Tombol berwarna terakhir — lolos. "Anti-dobel" istilah buatan
  tetapi dijelaskan oleh pilihannya — diterima.

## Revisi

### Wajib

**BC1. Hasil kampanye hanya bila sudah mulai** — halaman detail kampanye

- Status Draf, Menunggu persetujuan, Terjadwal: ganti kartu "Hasil kampanye" dengan ringkasan rencana (penerima,
  perkiraan biaya, jadwal), tanpa bilah kemajuan dan petak. Tampilkan hasil mulai status Berjalan.
- Kriteria lolos: di `broadcast-persetujuan` tidak ada angka "diproses/terkirim/gagal" atau "biaya … terkirim".
- (`qa-tester`: mock `broadcast-persetujuan` memakai angka hasil kampanye berjalan; buat 0 / null untuk kampanye yang belum
  mulai.)

**BC2. Petak hasil yang tidak menyesatkan** — detail kampanye (`Hasil kampanye`)

- Tampilkan sebagai corong kumulatif (Terkirim total → Diterima → Dibaca → Dibalas, tiap angka mencakup tahap
  sesudahnya), plus Gagal / Dilewati / Sedang dikirim / Belum dikirim, **atau** beri judul kecil "Status terakhir per
  pesan" dan keterangan "angka tidak saling bertumpuk". Kalimat biaya merujuk angka yang sama dengan salah satu petak.
- Kriteria lolos: angka biaya dapat dicocokkan langsung dengan salah satu petak.

**BC3. Laporan berkas tanpa daftar ganda** — langkah Penerima (`broadcast-penerima`)

- Satu daftar saja: ringkasan per penyebab ("1 nomor tidak valid · baris 18") dengan baris contoh; bila > 5 baris per
  penyebab, tampilkan 3 baris + "dan n lainnya" + tautan unduh CSV baris bermasalah.
- Ubah "Mengambil penerima lagi menggantikan daftar sebelumnya." → **"Memilih sumber baru akan mengganti daftar penerima
  sekarang."**
- Kriteria lolos: setiap penyebab muncul sekali; tidak ada "…ulang.: 1".

**BC4. Target sentuh di HP** — wizard kampanye, daftar kampanye

- Langkah wizard HP: tinggi 44 dan lebar ≥ 44 (atau tampilkan hanya langkah aktif dengan label "2 · Penerima" + "Langkah 2
  dari 4", tanpa bulatan angka yang bisa diketuk).
- Daftar: jadikan seluruh kartu tautan (pola TM3).
- Kriteria lolos: tidak ada target < 44 px di `broadcast-*` 390/360.

### Saran (tidak menahan)

- **BC-S1.** Langkah Penerima di 390: segmen tiga pilihan pecah menjadi dua baris ("Konektor data" turun sendiri);
  ganti dengan `select` atau tumpuk vertikal penuh.
- **BC-S2.** Isi pesan: "3 penerima akan dilewati …: 3 datanya kosong, **0** memuat baris baru, tab, atau spasi berlebih" —
  sembunyikan penyebab bernilai 0.
- **BC-S3.** Dijeda: "Dijeda otomatis hari ini, 04.45. Dijeda otomatis demi keamanan." mengulang; cukup "Dijeda otomatis
  hari ini, 04.45 demi keamanan. …".
- **BC-S4.** Judul halaman berganti "Kampanye baru" (langkah 1) → "Kampanye" (langkah 2–4); samakan "Kampanye baru" sampai
  diajukan, lalu nama kampanye.
- **BC-S5.** Jadwal & kirim: label "Anti-dobel" muncul dua kali (judul kelompok dan label pilihan) — label kedua "Berlaku
  untuk".
- **BC-S6.** Alarm Telegram: judul kartu sama dengan judul halaman; judul kartu cukup "Bot & chat tujuan".
- **BC-S7 (`qa-tester`).** Semua kampanye contoh memakai template `tagihan_jatuh_tempo` (termasuk "Promo upgrade" dan "Info
  gangguan"); "Sumber sekarang: …xlsx" vs berkas terpilih "…csv". Samakan data contoh.

## Bersih-bersih

Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo: laporan ini + 19 screenshot; bagian "Putaran 2" laporan
template (+5 `p2-*.png`). Tidak ada kode produk yang diubah, tidak ada commit.

---

# Putaran 2

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 2
- **Kode yang dinilai:** HEAD `2a09122` (revisi broadcast ada di `3a18705`). Worktree terisolasi (API 3191 / web 5191,
  `balesin_kd_e2e` migrasi sampai `0030`, Redis db 11), 3 worker. Ke-14 layar `broadcast-*`, `konektor-*`,
  `alarm-telegram*`, `pengaturan-broadcast` × 390/1440 × terang/gelap, ditambah audit 360/390/1440 (kontras, target
  sentuh sampai 4 tinggi layar ke bawah, teks terpotong, scroll horizontal).
- **Screenshot:** berkas berawalan `p2-`.

## Putusan putaran 2: REVISI (satu butir kecil)

| Butir | Hasil | Status |
|---|---|---|
| **BC1** rencana sebelum berjalan | `broadcast-persetujuan`: kartu "Rencana kampanye" (1.248 penerima · Perkiraan biaya Rp 740.064 · Segera) + "Hasil pengiriman tampil di sini begitu kampanye mulai berjalan." Tidak ada bilah kemajuan, petak, atau "biaya … terkirim" | Lolos |
| **BC2** corong kumulatif | `broadcast-berjalan`: Terkirim **797** → Diterima **701** → Dibaca **299** → Dibalas **87**, lalu Gagal 19 · Dilewati 6 · Sedang dikirim 14 · Belum dikirim 412 (jumlah = 1.248; diproses 836 = 797 + 19 + 6 + 14). Keterangan "Angka bertingkat: …". Biaya "Rp 254.463 untuk **701** pesan yang diterima pelanggan" cocok dengan petak Diterima | Lolos |
| **BC3** satu daftar per penyebab | `broadcast-penerima`: "4 baris tidak dipakai (tidak dikirimi):" lalu satu baris per penyebab ("1 baris · Nomor tidak valid · Baris 18"). Tidak ada lagi "…ulang.: 1". Kalimat sumber diganti "Memilih sumber baru akan mengganti daftar penerima sekarang." | Lolos |
| **BC4** target HP | Langkah wizard HP hanya langkah aktif ("2 Penerima") + "Langkah 2 dari 4", tanpa bulatan yang bisa diketuk. Kartu daftar kampanye bisa diketuk seluruhnya | Lolos untuk yang disebut |
| S1 segmen sumber | Ditumpuk vertikal penuh di 390 | Lolos |
| S2 penyebab bernilai 0 | "3 penerima akan dilewati saat diajukan: 3 datanya kosong." | Lolos |
| S3 dijeda | "Dijeda otomatis hari ini, 10.35. Demi keamanan, hanya Owner atau Admin …" | Lolos |
| S4 judul wizard | "Kampanye baru" di semua langkah | Lolos |
| S5 anti-dobel | Label kedua "Berlaku untuk" | Lolos |
| S6 alarm Telegram | Judul kartu "Bot & chat tujuan" | Lolos |
| S7 data contoh | Template per kampanye beragam (`promo_upgrade_desember`, `gangguan_jaringan`); sumber `.xlsx` sama di ringkasan dan berkas terpilih | Lolos |

Tidak ada teks < 4,5:1, tidak ada scroll horizontal.

### Wajib

**BC5. Tautan "Buka chat" di daftar penerima** — `BroadcastCampaignPage.tsx` (daftar penerima),
`Broadcast.module.css` `.recipientLink`

- Terukur: **62 × 19 px** di `broadcast-berjalan`, `-dijeda`, `-persetujuan` · 390 dan 360, sekali per baris penerima.
  Butir ini terlewat di putaran 1 karena letaknya di bawah layar pertama.
- Perbaikan: di `@media (max-width: 640px), (pointer: coarse)` beri `.recipientLink { display: inline-flex;
  align-items: center; min-height: var(--size-touch); }`, atau jadikan seluruh baris penerima tautan ke chat (pola TM3)
  bila ada `conversationId`.
- Kriteria lolos: audit 390/360 tidak menemukan target < 44 px di `broadcast-*`.

### Saran (tidak menahan)

- **BC-S8 (`qa-tester`).** Mock `broadcast-persetujuan` memakai daftar `RECIPIENTS` yang sama dengan kampanye berjalan,
  sehingga kampanye yang **belum disetujui** menampilkan penerima berstatus "Dibaca · Dibalas hari ini, 10.39" dan
  "Diterima". Beri kampanye yang belum mulai penerima berstatus "Belum dikirim". Di UI, saringan "Tampilkan" boleh
  disembunyikan selama status Draf, Menunggu persetujuan, atau Terjadwal.
- **BC-S9.** `broadcast-persetujuan` 390: status "Menunggu persetujuan" muncul dua kali berturut-turut (lencana kepala
  kartu dan judul kotak peringatan). Judul kotak cukup "Perlu persetujuan Owner atau Admin".
- **BC-S10.** `broadcast-penerima`: nama berkas di samping "Pilih berkas" turun ±6 px dari garis tengah tombol; samakan
  `align-items: center`.
- **BC-S11.** Petak corong dan petak status memakai gaya yang sama. Pemisah tipis atau ikon panah kecil antar-petak
  corong akan membuat sifat "bertingkat" terlihat tanpa harus membaca keterangan. Keterangan juga belum menyebut Dibalas
  ("… Dibaca mencakup yang sudah dibalas").

---

# Putaran 3

- **Tanggal:** 2026-11-19 · **Penilai:** `kritikus-desain` · **Putaran:** 3
- **Kode yang dinilai:** HEAD `15d977b` (BC5 ada di `9aeb2f1`).
- **Cara:**
  - Stack dan worktree sama dengan putaran 2 Fase 5 (API 3191 / web 5191, `balesin_kd_e2e`, Redis db 11, 2 worker).
  - Layar `broadcast-berjalan`, `-dijeda`, `-persetujuan` × 390/1440 × terang/gelap.
  - Foto tinggi 390 × 2600 supaya daftar penerima terlihat.
  - Ukuran tautan "Buka chat" diukur langsung di DOM.
  - Audit target sentuh di 360/390.
- **Lingkup:** hanya BC5 dan BC-S8.
- **Screenshot:** berkas berawalan `p3-`.

## Putusan putaran 3: LOLOS

| Butir | Hasil (terukur) | Status |
|---|---|---|
| **BC5** "Buka chat" ≥ 44 px di HP | `broadcast-berjalan` dan `broadcast-dijeda` 390 terang/gelap: ketiga tautan **62 × 44 px** (sebelumnya 62 × 19). Di 1440 tetap 62 × 19 (penunjuk mouse, sesuai rancangan). Audit 360/390: tidak ada target < 44 px di `broadcast-*` selain `select` 42 px dalam bingkai 44 yang sudah diterima | Lolos |
| **BC-S8** penerima kampanye yang belum mulai | `broadcast-persetujuan`: kelima penerima berstatus "Belum dikirim", tanpa tautan "Buka chat" dan tanpa waktu dibaca/dibalas (`p3-broadcast-persetujuan--390-terang.png`). Saringan "Tampilkan" masih tampil; itu opsional | Lolos |

Tidak ada teks < 4,5:1, tidak ada scroll horizontal.

### Saran tersisa (tidak menahan)

- **BC-S9** belum dikerjakan: "Menunggu persetujuan" masih tampil dua kali berturut-turut (lencana kepala kartu dan judul
  kotak peringatan). Judul kotak: **"Perlu persetujuan Owner atau Admin"**.
- **BC-S12.** Nomor penerima di daftar tampil mentah ("+6281234567890"), sedangkan inbox dan kontak memformatnya
  ("+62 812-3456-7890"). Pakai formatter nomor yang sama.
- **BC-S13.** Judul "Penerima" turun ±12 px dari garis tengah saringan "Tampilkan" di sebelahnya. Pakai
  `align-items: end` atau letakkan label saringan di kanan judul, satu baris.
