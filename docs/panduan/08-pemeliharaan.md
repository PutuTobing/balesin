# 8. Pemeliharaan server

Untuk admin server. Semua perintah dijalankan di server Balesin dengan `sudo`. Folder
instalasi ada di `/opt/balesin`.

## 8.1 Daftar perintah `balesin`

| Perintah | Fungsi |
|---|---|
| `sudo balesin status` | Ringkasan layanan, kesehatan, versi, backup terakhir, sisa disk, dan peringatan konfigurasi |
| `sudo balesin logs [layanan] [-f]` | Log layanan (`api`, `worker`, `web`, `postgres`, `redis`, `caddy`, …). `-f` untuk mengikuti log secara langsung |
| `sudo balesin version` | Versi yang terpasang |
| `sudo balesin backup` | Backup database + media sekarang |
| `sudo balesin restore <berkas>` | Memulihkan dari backup |
| `sudo balesin update [versi]` | Naik versi dengan backup dan rollback otomatis |
| `sudo balesin reset-owner-password [email]` | Mengganti password Owner dari server |
| `sudo balesin setup-token` | Menampilkan alamat dan token wizard setup |
| `sudo balesin start` / `stop` / `restart` | Menyalakan, menghentikan, menjalankan ulang layanan |

Hanya satu perintah pengubah (backup, restore, update, start, stop) yang berjalan dalam satu
waktu, jadi backup harian tidak bertabrakan dengan update.

## 8.2 Update ke versi baru

```bash
sudo balesin update          # versi terbaru
sudo balesin update 1.0.1    # versi tertentu
```

Yang terjadi (6 langkah, tampil di layar):

1. Pemeriksaan awal (disk minimal 2 GB, database berjalan), unduh berkas rilis, lalu periksa
   checksum dan **tanda tangan digital** rilis. Tanda tangan tidak valid atau berkas rilis tidak
   bisa diunduh = update dibatalkan tanpa mengubah apa pun.
2. **Backup penuh** otomatis (berkas `…-sebelum-update-v<versi>.tar.enc`).
3. Tarik image versi baru. Bila gagal, berhenti tanpa mengubah apa pun.
4. Perbarui struktur database dalam satu transaksi. Bila gagal, dibatalkan seluruhnya dan versi
   lama tetap berjalan.
5. Nyalakan versi baru, tunggu semua layanan sehat.
6. Simpan nomor versi baru dan berkas pendukungnya.

**Rollback otomatis**: bila versi baru tidak sehat di langkah 5 (atau pembaruan database gagal
setelah sebagian diterapkan), Balesin kembali ke versi lama sendiri. Bila struktur database
sudah berubah, database dipulihkan dari backup langkah 2. Log kegagalan disimpan di
`/opt/balesin/logs/update-gagal-<versi>-<waktu>.log`.

**Tidak ada perintah `balesin rollback`**, dan `update` ke versi yang lebih lama ditolak.
Perintah `restore` hanya mengembalikan **data** (database dan media) ke saat backup dibuat;
aplikasi tetap memakai versi yang sedang terpasang, dan struktur database otomatis diperbarui
lagi ke versi itu. Jadi bila update sudah dinyatakan berhasil tetapi Anda menemukan masalah di
versi baru, jangan mencoba turun versi sendiri: hubungi tim Balesin, perbaikan dikirim sebagai
versi baru.

Tips:

- Jalankan update di **jam sepi**. Bila rollback sampai memulihkan database, pesan yang masuk
  selama beberapa menit proses update bisa hilang. Setelah rollback, periksa chat terbaru di
  inbox dan di WhatsApp Manager.
- Pengguna yang sedang membuka aplikasi melihat **Versi baru tersedia** dan cukup menekan
  **Muat ulang**.

## 8.3 Backup

- **Backup harian otomatis** berjalan pukul **02.30** (dipasang installer).
- Backup manual: `sudo balesin backup`.
- Lokasi: `/opt/balesin/backups/`. Setiap backup terdiri dari **tiga berkas**:
  `….tar.enc` (isi terenkripsi), `….tar.enc.hmac` (penanda keaslian), dan
  `….tar.enc.sha256` (pemeriksa kerusakan). Salin ketiganya bersama-sama.
- Isinya: seluruh database (termasuk audit log) dan media chat.
- Backup disimpan 14 hari, lalu dihapus otomatis.

**Wajib dilakukan**

1. Salin folder backup ke **luar server** setiap hari (mis. `rsync` ke NAS atau penyimpanan
   lain).
2. Simpan salinan berkas **`/opt/balesin/.env`** di tempat aman terpisah, mis. password
   manager perusahaan. Berkas ini berisi `BALESIN_MASTER_KEY` (pembuka token Meta, password
   SMTP, dan rahasia lain) dan `BACKUP_PASSPHRASE` (pembuka backup). **Tanpa berkas ini,
   backup tidak bisa dibuka.**
3. Uji restore minimal **sebulan sekali** di server cadangan.

## 8.4 Restore (memulihkan)

```bash
sudo balesin restore /opt/balesin/backups/<nama-berkas>.tar.enc
```

1. Ketik `PULIHKAN` untuk konfirmasi.
2. Balesin membuat backup pengaman dulu, memeriksa keaslian berkas, lalu memulihkan ke database
   sementara. Database yang sedang berjalan baru ditukar bila pemulihan berhasil.
3. Layanan dinyalakan ulang dan diperiksa kesehatannya.

Memulihkan ke **server baru**: salin `.env` lama ke `/opt/balesin/.env` **sebelum** menjalankan
installer, jalankan installer, lalu `restore`. Backup dari versi yang lebih baru dari versi
terpasang ditolak; update dulu ke versi itu.

## 8.5 Owner lupa password

Bila email pengirim sudah diatur, Owner cukup memakai **Lupa password?** di halaman masuk.

Bila email pengirim belum diatur (atau email tidak bisa diterima), atur ulang dari server:

```bash
sudo balesin reset-owner-password                       # bila Owner hanya satu
sudo balesin reset-owner-password owner@contoh.co.id    # bila Owner lebih dari satu
```

1. Ketik `RESET` untuk konfirmasi.
2. Ketik password baru dua kali (tidak tampil di layar). Aturannya sama dengan aplikasi
   (minimal 10 karakter).

Efeknya: semua sesi Owner itu dikeluarkan, kunci login dilepas, tercatat di Audit log, dan Owner
menerima email pemberitahuan bila email pengirim sudah diatur. Semua Owner dan Admin juga
melihat banner peringatan keamanan. **Verifikasi dua langkah tidak dimatikan**: Owner tetap
masuk dengan kode autentikator atau kode cadangan.

Anggota lain (Admin, Supervisor, CS, Teknisi) yang lupa password memakai **Lupa password?**
atau meminta Owner/Admin. Bila ponselnya hilang, Owner atau Admin menekan **Atur ulang 2FA** di
**Pengaturan → Tim → pilih anggota**.

## 8.6 Memantau kesehatan

- `sudo balesin status` setiap kali ada keluhan. Perhatikan peringatan tentang setup, IP proxy,
  backup terakhir, dan sisa disk.
- Pantau sisa disk: media chat (foto, video, dokumen) bertambah terus.
- Alamat `https://cs.contoh.co.id/ready` bisa dipakai alat pemantau (uptime monitor); jawaban
  sehat berisi `"status":"ok"`.
- Di aplikasi, halaman **Pengaturan → Channel → nomor → Diagnosis** menunjukkan apakah Meta
  masih mengirim data.

## 8.7 Keamanan dasar server

- **Berkas `.env` adalah semua rahasia.** Izinnya harus `600` milik root. Jangan disalin ke
  tiket, chat, atau email.
- **Jangan pernah mengganti `BALESIN_MASTER_KEY`** setelah ada data. Semua kredensial tersimpan
  dan API key akan tidak bisa dipakai.
- **Jangan menambahkan pengguna ke grup `docker`**. Anggota grup itu setara root dan bisa membaca
  semua rahasia. Kelola server dengan `sudo`.
- Mode A: pastikan port aplikasi (bawaan 8080) hanya bisa dijangkau reverse proxy (lihat
  [Instalasi](01-instalasi.md#mode-a--reverse-proxy-yang-sudah-ada)).
- Aktifkan pembaruan keamanan otomatis sistem operasi (`unattended-upgrades`) dan jalankan
  `balesin update` secara rutin.
- Wajibkan verifikasi dua langkah untuk semua anggota yang memegang akses penting, dan tinjau
  **Audit log** serta banner peringatan keamanan secara berkala.
- Bila banner menyebut "password Owner diatur ulang dari server" padahal bukan tim TI Anda,
  segera ganti password server dan periksa siapa yang punya akses `sudo`.

## 8.8 Lisensi perangkat lunak pihak ketiga

Balesin memakai pustaka sumber terbuka. Daftar lengkap beserta teks lisensinya ada di berkas
`THIRD-PARTY-NOTICES.txt` pada halaman rilis, dan di dalam setiap image:

```bash
sudo docker compose --project-directory /opt/balesin -f /opt/balesin/docker-compose.yml \
  --env-file /opt/balesin/.env exec api cat /app/THIRD-PARTY-NOTICES | less
```

Pengolahan gambar memakai libvips (lewat sharp) yang berlisensi GNU LGPL v3. Pustaka itu ditaut
dinamis dan boleh Anda ganti dengan versi lain yang kompatibel. Kode sumbernya tersedia di
github.com/lovell/sharp-libvips (versi persisnya tercantum di berkas di atas).
