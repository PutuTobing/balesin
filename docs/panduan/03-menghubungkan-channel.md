# 3. Menghubungkan channel

Untuk Owner dan Admin. Semua channel diatur di **Pengaturan → Channel**. Halaman ini punya
dua bagian: **WhatsApp** (nomor lewat Cloud API resmi Meta) dan **Channel lain** (Telegram,
Email, Messenger, Instagram). Semua channel masuk ke inbox yang sama.

Semua token, password, dan App Secret disimpan **terenkripsi** di server, tampil tersamar
(mis. ••••1234), dan tidak pernah ditampilkan lagi. Menyimpan kredensial selalu meminta
konfirmasi identitas.

## Perbandingan kemampuan channel

| | WhatsApp | Telegram | Email | Messenger / Instagram |
|---|:-:|:-:|:-:|:-:|
| Masuk ke inbox, ambil/alihkan/selesai, tag, catatan, tiket | Ya | Ya | Ya | Ya |
| Aturan sesi 24 jam | Ya | Tidak | Tidak | Ya |
| Template, broadcast, mulai percakapan baru, survei CSAT | Ya | Tidak | Tidak | Tidak |
| Jenis pesan keluar | Semua (teks, media, lokasi, tombol, daftar, template) | Teks, media, lokasi, tombol | Teks dan lampiran | Teks dan media |
| Status | Siap dipakai | Siap dipakai | Siap dipakai | **Menunggu App Review Meta** (nonaktif bawaan) |

## 3.1 WhatsApp (Cloud API resmi Meta)

Balesin hanya memakai **WhatsApp Cloud API resmi dari Meta**. Satu channel = satu nomor.
Nomor yang dipakai **tidak boleh** sedang aktif di aplikasi WhatsApp atau WhatsApp Business di
HP.

Yang perlu disiapkan sebelum mulai:

- Akun Facebook yang menjadi **admin portofolio bisnis** perusahaan di Meta Business.
- Disarankan bisnis sudah **diverifikasi** (Pengaturan Bisnis → Pusat Keamanan). Tanpa
  verifikasi, batas pesan dan nama tampilan lebih terbatas.
- Nomor telepon yang bisa menerima SMS/telepon OTP.
- Kartu atau metode pembayaran untuk Meta (untuk mengirim template).

Buka **Pengaturan → Channel → Tambah nomor**. Wizard **Tambah nomor WhatsApp** punya 9 langkah;
setiap langkah punya tautan langsung ke halaman Meta dan tombol **Salin**.

1. **Meta Business** — masuk ke business.facebook.com dengan akun admin portofolio bisnis.
2. **Aplikasi Meta** — di developers.facebook.com buka **Aplikasi Saya → Buat Aplikasi**, pilih
   tipe **Business**, hubungkan ke portofolio bisnis, lalu tambahkan produk **WhatsApp**.
3. **Pilih nomor** — untuk uji coba pakai nomor tes dari Meta. Untuk produksi, tambahkan nomor
   sendiri, verifikasi dengan OTP, lalu atur PIN verifikasi dua langkah nomor itu.
4. **Salin ID** — isi **Nama channel** (mis. "CS Utama"; hanya terlihat tim), lalu salin
   **Phone Number ID** dan **WhatsApp Business Account ID** dari WhatsApp → Konfigurasi API.
5. **Token permanen** — di Pengaturan Bisnis → Pengguna → **Pengguna Sistem**, tambah pengguna
   sistem berperan Admin, tetapkan aset (aplikasi + akun WhatsApp, kontrol penuh), lalu buat
   token dengan masa berlaku **Tidak pernah** dan izin `whatsapp_business_messaging` serta
   `whatsapp_business_management`. Tempel ke **Token System User**.
6. **App Secret** — di dasbor aplikasi Meta: Pengaturan Aplikasi → Dasar → **Tampilkan** di
   samping App Secret. Tempel ke **App Secret**, lalu tekan **Simpan channel** dan konfirmasi
   identitas. Channel tercatat dengan status "Belum dites".
7. **Webhook** — setelah channel disimpan, Balesin membuat **URL webhook** dan **Verify token** khusus channel ini.
   Di dasbor aplikasi Meta buka WhatsApp → Konfigurasi → Webhook → **Edit**, tempel URL
   webhook ke *Callback URL* dan verify token ke *Verify token*, tekan **Verifikasi dan
   simpan**, lalu klik **Berlangganan** untuk tiga kolom: `messages`,
   `message_template_status_update`, dan `account_update`.
   Disarankan juga mengaktifkan **Require App Secret Proof** (Aplikasi → Pengaturan → Lanjutan).
8. **Tes koneksi** — tekan **Tes koneksi**. Balesin mengambil nama tampilan, kualitas, dan batas
   pesan dari Meta (paling lama sekitar 25 detik). Lalu kirim pesan dari HP ke nomor itu;
   pesan harus muncul di Inbox.
9. **Pembayaran** — tambahkan metode pembayaran di WhatsApp Manager → Pengaturan akun →
   Metode pembayaran, supaya bisa mengirim template.

Tekan **Selesai** di langkah terakhir. Kualitas nomor, profil bisnis, dan kredensial bisa
dikelola dari halaman nomor. Template yang sudah ada di Meta ikut disinkronkan otomatis.

### Beberapa nomor

Anda bisa menambah lebih dari satu nomor (mis. "CS Utama" dan "Penagihan"). Bila beberapa
nomor berada di **aplikasi Meta yang sama**, Meta hanya punya satu Callback URL per aplikasi:
pakai URL webhook dari salah satu channel dan **App Secret yang sama** di semua channel nomor
itu. Pesan tetap diarahkan ke channel yang benar.

### Halaman nomor

Klik nomor di **Pengaturan → Channel** untuk membuka halamannya:

- **Ringkasan**: kualitas nomor (tinggi/sedang/rendah), status di Meta, batas pesan, nama
  tampilan, tes terakhir.
- **Diagnosis**: berapa kiriman dari Meta yang diterima, diproses, atau ditolak dalam 24 jam
  terakhir (tanpa isi pesan). Pakai ini bila pesan tidak masuk.
- **Bot**: bot eksternal untuk nomor ini (lihat [Bab 7](07-bot-api-n8n.md#71-bot-eksternal)).
- **Nama channel**: ganti nama yang tampil di inbox.
- **Kredensial Meta**: tekan **Ganti kredensial** untuk mengganti token atau App Secret.
  Status kembali ke "Belum dites" sampai Anda menekan **Tes koneksi** lagi.
- **Profil bisnis**: Tentang, Alamat, Deskripsi, Email, Situs web (maks. 2), Kategori.
  Perubahan langsung dikirim ke Meta dan terlihat semua pelanggan. Foto profil sementara
  diubah lewat WhatsApp Manager.
- **Akses channel**: **Nonaktifkan channel** untuk menghentikan sementara pesan masuk dan
  keluar. **Hapus channel** untuk menghapus permanen.

## 3.2 Telegram

1. Di Telegram, buka **@BotFather**, kirim `/newbot`, ikuti petunjuknya, lalu salin **API
   Token**. Satu bot hanya bisa dipakai satu aplikasi; jangan pakai bot yang sama dengan
   sistem lain.
2. Di **Pengaturan → Channel**, bagian **Channel lain**, tekan **Tambah channel → Hubungkan
   Telegram**.
3. Isi **Nama channel** (mis. "Bot Telegram CS") dan **Token bot**.
4. Tekan **Hubungkan**, lalu konfirmasi identitas.
5. Di halaman channel, bagian **Webhook**, tekan **Pasang webhook**.
6. Tekan **Tes koneksi**, lalu kirim pesan ke bot dari akun Telegram pribadi.

Catatan:

- Webhook hanya bisa dipasang bila Balesin sudah punya alamat `https://` publik.
- Hanya chat pribadi ke bot yang masuk ke inbox; pesan grup diabaikan.
- Telegram tidak punya aturan sesi 24 jam, tetapi template dan broadcast tidak tersedia.

## 3.3 Email (IMAP masuk, SMTP keluar)

Email pelanggan diambil berkala dari kotak masuk, lalu dibalas dari inbox.

1. Untuk Gmail atau Microsoft 365: aktifkan IMAP di akun itu dan buat **app password**.
2. **Pengaturan → Channel → Tambah channel → Hubungkan Email**.
3. Isi **Nama channel**, **Alamat email channel** (mis. `cs@contoh.co.id`), dan **Nama
   pengirim** yang tampil di kotak masuk pelanggan.
4. Bagian **Email masuk (IMAP)**: Host IMAP, Port, Keamanan, Username, Password, **Folder**
   (bawaan INBOX), **Cek email tiap (menit)** (1–60), dan pilihan **Tandai email sudah dibaca
   di server setelah diambil**. Koneksi wajib terenkripsi: port 993 (SSL/TLS) atau 143
   (STARTTLS).
5. Bagian **Email keluar (SMTP)**:
   - **Pakai email pengirim sistem** — dikirim dari alamat di Pengaturan → Email pengirim;
     balasan pelanggan tetap kembali ke alamat channel ini.
   - **Akun SMTP sendiri** — dikirim langsung dari alamat channel ini; isi host, port,
     keamanan, username, dan password SMTP.
6. (Opsional) **Server verifikasi tepercaya**: biarkan kosong kecuali disarankan tim TI.
7. Tekan **Hubungkan**, lalu **Tes koneksi** (memeriksa email masuk dan email keluar).

Catatan:

- Saat pertama terhubung, Balesin mulai dari email **terbaru**; isi kotak masuk lama tidak
  diimpor.
- Email balasan otomatis, pantulan (bounce), email lebih dari 25 MB, dan lampiran berbahaya
  dilewati. Jumlahnya tampil di **Email dilewati** pada halaman channel.
- Isi HTML email ditampilkan dalam mode aman (tanpa skrip dan gambar luar). Tekan **Lihat
  versi HTML** untuk melihat tampilan aslinya.

## 3.4 Facebook Messenger dan Instagram DM

Kedua channel ini **sudah disiapkan tetapi nonaktif bawaan**. Meta mewajibkan **App Review**
(izin `pages_messaging` untuk Messenger dan `instagram_manage_messages` untuk Instagram)
sebelum aplikasi Anda boleh membalas pesan pelanggan sungguhan. Proses App Review dilakukan di
akun Meta Anda dan bisa memakan waktu beberapa hari sampai minggu.

Langkah bila App Review sudah disetujui:

1. **Pengaturan → Channel → Tambah channel → Hubungkan Messenger** (atau **Hubungkan
   Instagram**).
2. Isi **ID Halaman Facebook** (dan **ID akun Instagram** untuk Instagram), **Page Access
   Token** dari Pengguna Sistem (jangan token pribadi), dan **App Secret**.
3. Tekan **Hubungkan**. Channel tersimpan dalam keadaan **Nonaktif** dengan lencana
   **Butuh App Review Meta**.
4. Di halaman channel, salin **Alamat webhook** dan **Verify token** ke pengaturan webhook
   aplikasi Meta, lalu langgani field yang tercantum.
5. Tekan **Tes koneksi**. Setelah berhasil, tekan **Aktifkan**.

Mengganti kredensial Meta menonaktifkan channel lagi sampai dites ulang. Untuk Messenger dan
Instagram berlaku aturan 24 jam seperti WhatsApp; versi ini belum mendukung pengiriman di luar
24 jam (tag pesan Meta).

## 3.5 Fitur yang belum tersedia

- **Embedded Signup** (pop-up "Masuk dengan Facebook") dan **Coexistence** (memakai nomor yang
  sama di aplikasi WhatsApp Business HP) belum tersedia. Hubungkan nomor lewat wizard manual di
  atas.
- Panggilan suara WhatsApp belum tersedia.
