# Panduan Pengguna Balesin

Panduan ini untuk perusahaan yang memasang Balesin di server sendiri (self-hosted):
pemilik akun (Owner), Admin, Supervisor, CS, dan Teknisi. Panduan ini bukan dokumentasi
pengembang.

Balesin adalah inbox bersama untuk tim layanan pelanggan. Satu nomor resmi perusahaan
(lewat **WhatsApp Cloud API resmi Meta**) bisa dibalas banyak orang sekaligus. Telegram dan
email juga bisa masuk ke inbox yang sama.

> **Nama aplikasi di layar Anda bisa berbeda.** Balesin bisa diberi nama dan logo
> perusahaan Anda (white-label). Kalau di layar tertulis nama lain, itu tetap aplikasi yang
> sama. Nama menu dan tombol di panduan ini sama persis dengan yang tampil di aplikasi.

## Daftar isi

| No | Berkas | Isi |
|---|---|---|
| 1 | [Instalasi](01-instalasi.md) | Persyaratan server, perintah pemasangan, pilihan jaringan, wizard setup Owner, domain dan HTTPS |
| 2 | [Pengaturan awal](02-pengaturan-awal.md) | Nama dan logo, email pengirim, undang anggota tim, peran, departemen, jam kerja, verifikasi dua langkah |
| 3 | [Menghubungkan channel](03-menghubungkan-channel.md) | Nomor WhatsApp (Cloud API Meta), Telegram, Email, Messenger dan Instagram |
| 4 | [Inbox untuk agen](04-inbox-untuk-agen.md) | Tab inbox, ambil dan alihkan chat, sesi 24 jam, balasan cepat `/`, template, catatan, tag, notifikasi di HP |
| 5 | [Template dan broadcast](05-template-dan-broadcast.md) | Membuat dan mengajukan template ke Meta, kampanye broadcast, persetujuan, rem darurat |
| 6 | [Kontak, tiket, dan laporan](06-kontak-tiket-laporan.md) | Kontak dan impor, tiket dengan Kanban, laporan kinerja, biaya pesan Meta, survei CSAT |
| 7 | [Bot, API, dan n8n](07-bot-api-n8n.md) | API key, webhook keluar, bot eksternal, mode kompatibel MobiChat |
| 8 | [Pemeliharaan server](08-pemeliharaan.md) | Perintah `balesin`: update, backup, restore, status, log, pemulihan password Owner |
| 9 | [Tanya jawab](09-tanya-jawab.md) | Masalah yang sering terjadi dan cara mengatasinya |

## Siapa membaca apa

| Peran | Bacaan wajib | Bacaan tambahan |
|---|---|---|
| **Admin server / tim TI** | 1, 8, 9 | 3 (bagian webhook) |
| **Owner** | 1 (bagian wizard), 2, 3, 8 (bagian keamanan) | Semua |
| **Admin** | 2, 3, 5, 7 | 6, 9 |
| **Supervisor** | 4, 5, 6 | 9 |
| **CS** | 4 | 6 (kontak dan tiket) |
| **Teknisi** | 4 (bagian "Untuk Teknisi") | 6 (tiket) |

## Peran dan hak akses singkat

| Kemampuan | Owner | Admin | Supervisor | CS | Teknisi |
|---|:-:|:-:|:-:|:-:|:-:|
| Kelola channel dan kredensial Meta | Ya | Ya | – | – | – |
| Undang dan nonaktifkan anggota | Ya | Ya | – | – | – |
| API key dan webhook | Ya | Ya | – | – | – |
| Email pengirim | Ya | Ya | – | – | – |
| Batas kirim, rem darurat, pengaturan broadcast | Ya | Ya | – | – | – |
| Buat broadcast | Ya | Ya | Ya | – | – |
| Setujui broadcast besar | Ya | Ya | – | – | – |
| Kelola template WhatsApp dan balasan cepat | Ya | Ya | Ya | – | – |
| Lihat semua chat | Ya | Ya | Ya | Ya | Hanya yang ditugaskan |
| Mulai percakapan baru ke nomor | Ya | Ya | Ya | – | – |
| Ambil, tugaskan, alihkan chat | Ya | Ya | Ya | Ya | Hanya mengembalikan chat miliknya |
| Impor dan ekspor kontak | Ya | Ya | Ya | – | – |
| Hapus kontak | Ya | Ya | – | – | – |
| Kelola tiket | Ya | Ya | Ya | Ya | Tiket miliknya |
| Lihat laporan organisasi dan biaya Meta | Ya | Ya | Ya | Kinerja sendiri | Kinerja sendiri |
| Audit log | Ya | Ya | – | – | – |

Menu yang tidak sesuai peran Anda tidak akan tampil. Kalau Anda butuh akses tambahan, minta
Owner atau Admin di tempat Anda.

## Istilah yang dipakai

| Istilah | Arti |
|---|---|
| **Chat / percakapan** | Satu sesi obrolan dengan satu pelanggan di satu channel. Setelah ditandai selesai, pesan baru dari pelanggan membuka chat baru. |
| **Channel** | Jalur masuk pesan: nomor WhatsApp, bot Telegram, kotak masuk email, dan seterusnya. |
| **Sesi 24 jam** | Aturan Meta: pesan biasa ke pelanggan WhatsApp hanya boleh dikirim dalam 24 jam sejak pesan terakhir pelanggan. Di luar itu hanya template. |
| **Template** | Pesan WhatsApp yang sudah **disetujui Meta**. Dipakai untuk menyapa di luar sesi 24 jam dan untuk broadcast. |
| **Balasan cepat** | Teks siap pakai milik tim Anda, dipanggil dengan mengetik `/` di kolom chat. Tidak perlu persetujuan Meta. |
| **Broadcast / kampanye** | Satu template dikirim ke banyak pelanggan sekaligus. |
| **Rem darurat** | Tombol untuk menghentikan semua pesan keluar seketika. |
| **Verifikasi dua langkah (2FA)** | Kode 6 digit dari aplikasi autentikator di ponsel, selain password. |
