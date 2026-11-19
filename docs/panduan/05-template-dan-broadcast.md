# 5. Template dan broadcast

Untuk Owner, Admin, dan Supervisor. Template dan broadcast hanya berlaku untuk channel
**WhatsApp**.

## 5.1 Apa itu template

Template adalah pesan WhatsApp yang **sudah disetujui Meta**. Template dipakai untuk:

- menyapa pelanggan di luar sesi 24 jam,
- memulai percakapan ke nomor baru,
- broadcast ke banyak pelanggan,
- pengiriman otomatis dari aplikasi lain (mis. aplikasi billing) lewat API.

Template dibuat **per nomor** (tepatnya per akun WhatsApp Business nomor itu). Jangan
tertukar dengan **Balasan cepat** (`/`), yang hanya teks simpanan tim dan tidak perlu
persetujuan Meta.

Kategori template menentukan aturan dan biayanya:

| Kategori | Untuk | Catatan |
|---|---|---|
| **Utilitas** | Info layanan yang sedang berjalan: tagihan, pembayaran, gangguan, jadwal teknisi | Paling umum dipakai |
| **Pemasaran** | Promosi, penawaran, pengumuman | Biaya per pesan lebih tinggi |
| **Autentikasi** | Kode verifikasi sekali pakai (OTP) | Isi pesan dibuat Meta; Anda hanya mengisi kodenya saat mengirim |

## 5.2 Membuat dan mengajukan template

Buka **Pengaturan → Template WhatsApp**.

Tiga cara mendapatkan template:

- **Pakai preset** — draf siap pakai yang bisa diubah dulu sebelum diajukan. Versi ini
  menyediakan preset untuk usaha penyedia internet (ISP): Pengingat tagihan jatuh tempo,
  Pembayaran diterima, Layanan diisolir, Layanan aktif kembali, Gangguan jaringan massal,
  Gangguan sudah pulih, Tiket perbaikan dibuat, Jadwal kunjungan teknisi, Selamat datang
  pelanggan baru, Penawaran upgrade paket, dan Kode verifikasi (OTP). Preset tidak memuat nama
  perusahaan, tautan, atau nomor; lengkapi sendiri.
- **Buat template** — buat dari nol.
- **Sinkron dari Meta** — menarik template yang dibuat langsung di WhatsApp Manager. Sinkron
  juga berjalan otomatis setiap 6 jam.

Langkah membuat template:

1. Tekan **Buat template** (atau **Pakai preset**, pilih nomor di **Buat untuk nomor**, lalu
   **Pakai**).
2. **Identitas**: pilih **Nomor WhatsApp**, isi **Nama template** (huruf kecil, angka, dan
   garis bawah, mis. `tagihan_bulanan`), **Bahasa**, dan **Kategori**.
3. **Isi template**:
   - **Bentuk variabel**: **Bernomor `{{1}}`** atau **Bernama `{{nama}}`**.
   - **Judul**: Tanpa judul atau Teks. Judul gambar, video, atau dokumen dibuat di WhatsApp
     Manager lalu disinkron; template seperti itu tetap bisa dikirim dari aplikasi.
   - **Isi pesan**: tekan **Tambah variabel** untuk menyisipkan variabel. Isi tidak boleh
     diawali atau diakhiri variabel.
   - **Contoh nilai variabel**: wajib diisi; Meta memakainya saat meninjau.
   - **Catatan kaki** (opsional).
4. **Tombol** (opsional, maks. 10): **Balasan cepat**, **Tautan** (maks. 2; boleh diakhiri
   `{{1}}` untuk bagian yang berbeda per pelanggan), **Telepon** (maks. 1), **Salin kode**
   (maks. 1).
5. Lihat **Pratinjau** dan **Pemeriksaan**. Bereskan isian yang ditandai merah.
6. Tekan **Simpan draf**, lalu **Ajukan ke Meta**.

Meta biasanya memutuskan dalam beberapa menit sampai 24 jam. Status template:

| Status | Arti |
|---|---|
| **Draf** | Belum diajukan |
| **Menunggu tinjauan Meta** | Sedang ditinjau; belum bisa diubah |
| **Disetujui** | Siap dipakai di chat, broadcast, dan API |
| **Ditolak** | Alasan dari Meta tampil (mis. "kategori tidak tepat"). Perbaiki lalu ajukan lagi |
| **Dijeda Meta** / **Dinonaktifkan Meta** | Biasanya karena banyak pelanggan menandai sebagai spam. Periksa kualitas template |

Nama dan bahasa tidak bisa diubah setelah diajukan. Kategori template yang sudah disetujui
juga tidak bisa diubah. Menghapus template yang sudah ada di Meta ikut menghapusnya di Meta.

## 5.3 Membuat broadcast

Broadcast mengirim satu template yang disetujui ke banyak pelanggan, mis. pengingat tagihan
atau info gangguan.

Buka **Broadcast → Buat kampanye**. Ada 4 langkah:

**1. Dasar**

- **Nama kampanye** (hanya untuk tim, tidak terlihat pelanggan).
- **Kirim dari nomor**.
- **Template**: hanya template disetujui. Template OTP dan template berjudul
  gambar/video/dokumen tidak bisa dipakai untuk broadcast.

**2. Penerima** — pilih salah satu **Sumber penerima**:

| Sumber | Keterangan |
|---|---|
| **Unggah berkas** | CSV atau Excel (.xlsx), maks. 5 MB dan 20.000 baris. Baris pertama = judul kolom. Kolom nomor dikenali otomatis (nomor, no hp, wa, phone, …); bisa diganti di **Kolom nomor**. Nomor `08…` otomatis diubah ke `+628…`. |
| **Segmen kontak** | Kontak dengan tag tertentu (**Punya salah satu tag** / **Punya semua tag**), bisa ditambah syarat atribut kontak. Tekan **Ambil kontak**. |
| **Konektor data** | Daftar pelanggan dari aplikasi lain, mis. daftar penunggak dari aplikasi billing (lihat 5.6). Tekan **Ambil data**. |

**Hasil pemeriksaan** menampilkan jumlah penerima valid dan baris yang ditolak beserta
alasannya.

**3. Isi pesan** — isi setiap variabel template:

- **Dari kolom** — diambil dari kolom data penerima (mis. kolom `nama`, `nominal`,
  `jatuh_tempo`).
- **Teks tetap (sama untuk semua)**.

**Pratinjau beberapa penerima** menampilkan pesan yang sudah terisi. Penerima yang datanya
kosong atau melanggar aturan Meta dilewati.

**4. Jadwal & kirim**

- **Jadwal**: **Segera setelah diajukan** atau **Pada waktu tertentu** (zona waktu organisasi).
- **Kecepatan (pesan per detik)**: lebih lambat lebih aman untuk kualitas nomor.
- **Anti-dobel**: **Lewati nomor yang baru saja menerima broadcast** dalam rentang jam tertentu,
  untuk template yang sama saja atau broadcast apa pun.
- **Tag otomatis saat pelanggan membalas**: memasang tag pada penerima yang membalas,
  memudahkan tim menyaring balasan kampanye.
- **Perkiraan biaya**: jumlah pesan berbayar × tarif kategori. Ini perkiraan, bukan tagihan
  resmi Meta.

Tekan **Ajukan kampanye**, lalu konfirmasi identitas.

## 5.4 Persetujuan, jeda, dan laporan kampanye

**Persetujuan**

Bila total penerima tanpa persetujuan dalam 24 jam melebihi **ambang persetujuan** (bawaan
**50 penerima**), kampanye berstatus **Menunggu persetujuan**. Owner atau Admin **selain
pembuatnya** membuka kampanye, lalu menekan **Setujui** (dengan konfirmasi identitas) atau
**Tolak** (dengan alasan; kampanye kembali menjadi draf). Memecah kampanye menjadi beberapa
bagian kecil tidak menghindari persetujuan, karena hitungannya kumulatif.

**Status kampanye**: Draf → Menunggu persetujuan → Terjadwal → Berjalan → Selesai. Kampanye
juga bisa **Dijeda** atau **Dibatalkan**.

**Selama berjalan**

- **Jeda** menghentikan sementara; **Lanjutkan** melanjutkan.
- **Batalkan kampanye** membatalkan penerima yang belum dikirimi.
- Kampanye bisa **Sedang menunggu** dan lanjut sendiri bila kuota harian atau batas Meta
  tercapai.
- **Rem otomatis** menjeda kampanye bila banyak pesan gagal atau kualitas nomor turun. Kampanye
  yang dijeda otomatis hanya bisa dilanjutkan Owner atau Admin setelah memeriksa penyebabnya.

**Laporan kampanye** (diperbarui otomatis): Terkirim, Diterima, Dibaca, Gagal, Dibalas,
Dilewati; **Alasan gagal** beserta kode Meta; biaya; dan daftar **Penerima** per status
dengan tombol **Buka chat**. Tekan **Ekspor CSV** untuk mengunduh hasil per penerima (berisi
data pribadi pelanggan; simpan seperlunya).

## 5.5 Batas kirim dan rem darurat

Untuk Owner dan Admin. Buka **Pengaturan → Batas kirim**.

**Rem darurat**

- **Tarik rem darurat** menghentikan **semua** pesan keluar seluruh tim seketika, termasuk yang
  mengantre. Pakai bila ada yang tidak beres, mis. pesan terkirim ke banyak pelanggan tanpa
  sengaja. Isi alasan bila perlu.
- **Lanjutkan pengiriman** (hanya Owner atau Admin, dengan konfirmasi identitas) setelah
  penyebabnya diatasi.
- Rem juga bisa tertarik otomatis bila ada lonjakan pesan keluar non-broadcast yang tidak
  wajar (mis. integrasi yang bocor).

**Batas pesan keluar** (berlaku untuk balasan agen dan pesan otomatis):

| Batas | Bawaan |
|---|---|
| Batas harian organisasi | 5.000 pesan / 24 jam |
| Batas harian per pengguna | 500 pesan / 24 jam |
| Batas per percakapan per menit | 20 pesan |

**Broadcast** (di halaman yang sama): ambang persetujuan (bawaan 50), kecepatan maksimal
(bawaan 10 pesan/detik), **Cadangan kuota balasan CS** (bawaan 20% dari batas harian yang
tidak boleh dipakai broadcast), pengaturan rem otomatis, dan **Tarif perkiraan per pesan**
per negara dan kategori. Cocokkan tarif dengan rate card resmi Meta; tarif ini dipakai untuk
perkiraan biaya broadcast dan laporan biaya.

Melonggarkan pelindung (ambang atau kecepatan naik, cadangan turun, rem otomatis dimatikan)
hanya bisa dilakukan Owner. Semua perubahan tercatat di Audit log, dan Owner menerima email
saat rem ditarik atau batas harian tercapai.

## 5.6 Konektor data (penerima dari aplikasi lain)

Untuk Owner dan Admin. **Pengaturan → Konektor data → Tambah konektor**.

1. **Nama**, mis. "Pelanggan menunggak (billing)".
2. **Alamat (GET, JSON)**: alamat `https://` aplikasi Anda yang mengembalikan daftar pelanggan
   dalam JSON. Alamat jaringan lokal hanya boleh bila ada di daftar jaringan privat
   (**Pengaturan → Webhook**).
3. **Pakai header autentikasi** bila aplikasi Anda membutuhkan kunci: isi **Nama header**
   (mis. `Authorization` atau `X-Api-Key`) dan **Nilai header**. Jangan menaruh kunci di
   alamat.
4. **Jalur daftar data** (mis. `data.items`; kosongkan bila JSON-nya langsung berupa daftar)
   dan **Nama isian nomor** (mis. `no_hp`).
5. **Simpan**, lalu **Tes koneksi**.

Setiap isian lain di JSON bisa dipakai sebagai variabel template saat membuat broadcast.

## 5.7 Alarm Telegram

Kabar singkat ke grup Telegram tim saat rem darurat ditarik, rem otomatis bekerja, broadcast
dijeda otomatis, menunggu persetujuan, atau selesai. Alarm tidak memuat data pelanggan.

1. Buat bot di **@BotFather**, masukkan bot ke grup tim.
2. **Pengaturan → Alarm Telegram**: isi **Token bot** dan **ID chat** (grup diawali `-100…`,
   atau `@kanal`).
3. Centang **Kirim alarm ke chat ini**, tekan **Simpan**, lalu **Kirim pesan tes**.

Tanpa Alarm Telegram, kejadian tetap tercatat di Audit log dan banner keamanan.
