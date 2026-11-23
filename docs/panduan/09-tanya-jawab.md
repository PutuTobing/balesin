# 9. Tanya jawab dan pemecahan masalah

## Pesan dan channel WhatsApp

### Pesan pelanggan tidak masuk ke Inbox

Periksa berurutan:

1. **Pengaturan → Channel → pilih nomor → Diagnosis.**
   - "Belum ada data masuk 24 jam terakhir": Meta tidak mengirim apa pun. Periksa pengaturan
     webhook di aplikasi Meta (langkah 4–6 di bawah).
   - "Ada yang perlu dicek" dengan kiriman **ditolak karena tanda tangan Meta tidak cocok**:
     **App Secret** di Balesin tidak sama dengan milik aplikasi Meta. Tekan **Ganti App
     Secret**, tempel App Secret yang benar, lalu **Tes koneksi**. Banner keamanan biasanya
     juga menampilkan "Webhook WhatsApp ditolak berulang".
2. Pastikan channel tidak **Nonaktif** dan rem darurat tidak berpengaruh (rem hanya menahan
   pesan keluar, bukan pesan masuk).
3. Tekan **Tes koneksi** di halaman nomor. Bila gagal, baca pesan kesalahannya.
4. Di dasbor aplikasi Meta → WhatsApp → Konfigurasi → Webhook: pastikan **Callback URL** dan
   **Verify token** sama persis dengan yang tampil di Balesin.
5. Pastikan kolom webhook `messages`, `message_template_status_update`, dan `account_update`
   sudah **Berlangganan**.
6. Pastikan alamat Balesin bisa dibuka dari internet lewat `https://` (coba
   `https://cs.contoh.co.id/ready` dari jaringan seluler).
7. Bila memakai nomor tes Meta, hanya nomor yang terdaftar di daftar penerima uji yang bisa
   saling berkirim pesan.
8. Untuk admin server: nginx di depan yang membatasi ukuran body terlalu kecil bisa menolak
   webhook (gejala: kode 413). Lihat [Webhook ditolak dengan kode 413](#webhook-ditolak-dengan-kode-413).

### "Sesi 24 jam sudah habis" / pesan gagal karena lebih dari 24 jam

Ini aturan Meta, bukan kerusakan. Pesan biasa hanya boleh dikirim dalam 24 jam sejak pesan
terakhir pelanggan. Tekan **Kirim template** dan pilih template yang sudah disetujui Meta.
Begitu pelanggan membalas, Anda bisa mengirim pesan biasa lagi selama 24 jam.

Bila daftar template kosong, minta Owner/Admin/Supervisor membuat dan mengajukan template di
**Pengaturan → Template WhatsApp** (lihat [Bab 5](05-template-dan-broadcast.md)).

### "Token System User ditolak Meta (salah atau kedaluwarsa)"

Token di Balesin tidak lagi diterima Meta. Penyebab umum: token dibuat dengan masa berlaku
terbatas, pengguna sistem dihapus, atau aset dicabut.

1. Di Meta Business, buka Pengaturan Bisnis → Pengguna → **Pengguna Sistem**.
2. Buat token baru dengan masa berlaku **Tidak pernah** dan izin
   `whatsapp_business_messaging` serta `whatsapp_business_management`.
3. Di Balesin: **Pengaturan → Channel → pilih nomor → Kredensial Meta → Ganti kredensial**,
   tempel token baru, simpan.
4. Tekan **Tes koneksi**.

### "Token belum punya izin whatsapp_business_messaging"

Token dibuat tanpa izin yang lengkap. Buat ulang token dengan kedua izin di atas, atau tetapkan
ulang aset aplikasi dan akun WhatsApp ke pengguna sistem dengan kontrol penuh.

### "Metode pembayaran akun WhatsApp Business belum siap"

Tambahkan atau perbarui metode pembayaran di WhatsApp Manager → Pengaturan akun → Metode
pembayaran. Tanpa itu, template tidak bisa dikirim.

### Pesan gagal dengan alasan "nomor pelanggan tidak aktif di WhatsApp"

Nomor tujuan tidak memakai WhatsApp, belum menyetujui ketentuan terbaru, atau aplikasinya
terlalu lama. Hubungi pelanggan lewat kanal lain.

### Kualitas nomor turun / nomor dibatasi Meta

Lihat **Kualitas** di halaman nomor. Kualitas rendah biasanya karena banyak pelanggan memblokir
atau melaporkan pesan, terutama dari broadcast. Kurangi frekuensi broadcast, pakai kategori
yang tepat, kirim hanya ke pelanggan yang memang menunggu informasi, dan turunkan kecepatan
kirim. Broadcast otomatis dijeda bila kualitas turun (rem otomatis).

### Semua pesan keluar berhenti

Kemungkinan **rem darurat** ditarik (manual atau otomatis karena lonjakan pesan). Owner atau
Admin membuka **Pengaturan → Batas kirim**, membaca alasannya, memastikan penyebabnya sudah
aman, lalu menekan **Lanjutkan pengiriman**. Kemungkinan lain: **batas harian organisasi** atau
**batas harian per pengguna** tercapai.

### Template ditolak Meta

Baca **Alasan dari Meta** di halaman template. Yang paling sering:

- **Kategori tidak tepat** / **isi tidak cocok dengan kategori**: mis. ada kalimat promosi di
  template Utilitas. Pindah ke kategori Pemasaran atau hapus kalimat promosinya.
- **Format isi atau variabel tidak sesuai**: isi tidak boleh diawali/diakhiri variabel, dan
  contoh nilai variabel wajib diisi dengan contoh yang realistis.

Perbaiki, lalu **Ajukan perubahan**.

## Akun dan akses

### Owner lupa password dan email pengirim belum diatur

Jalankan di server:

```bash
sudo balesin reset-owner-password
```

Lihat [Pemeliharaan](08-pemeliharaan.md#85-owner-lupa-password). Verifikasi dua langkah tetap
aktif; masuk dengan kode autentikator atau kode cadangan.

### Ponsel dengan aplikasi autentikator hilang

- Masuk dengan salah satu **kode cadangan**, lalu daftarkan ulang di **Pengaturan → Keamanan
  akun**.
- Bila kode cadangan juga hilang: minta Owner atau Admin menekan **Atur ulang 2FA** pada akun
  Anda di **Pengaturan → Tim**. Untuk akun Owner, minta Owner lain.

### Anggota tidak menerima email undangan

1. Periksa folder spam.
2. Periksa **Pengaturan → Email pengirim**: status harus terhubung. Tekan **Kirim email tes**.
3. Di **Pengaturan → Tim → Undangan terbuka**, lihat status pengiriman email, lalu tekan
   **Kirim ulang**.
4. Bila email pengirim belum bisa dipakai, buat tautan undangan dan kirim langsung ke orangnya
   lewat chat pribadi.

### "Masuk dikunci sementara"

Terlalu banyak percobaan password salah. Tunggu hitung mundur di tombol selesai, atau minta
Owner/Admin menekan **Buka kunci** di halaman anggota.

### Anggota tidak bisa melihat chat tertentu

- **Teknisi** hanya melihat chat yang ditugaskan kepadanya.
- Anggota yang dibatasi ke departemen (**Hanya lihat chat & tiket departemennya**) tidak
  melihat chat departemen lain maupun chat **tanpa departemen**. Atur **Channel bawaan** di
  setiap departemen, atau pindahkan chat ke departemen yang benar.

### Saya tidak melihat menu Broadcast / Pengaturan tertentu

Menu mengikuti peran. Lihat tabel peran di [README](README.md#peran-dan-hak-akses-singkat).

## Notifikasi dan HP

### Notifikasi tidak muncul

1. **Pengaturan → Notifikasi**: status perangkat harus **Aktif di perangkat ini**. Tekan
   **Kirim notifikasi tes**.
2. Status **Diblokir browser**: izinkan notifikasi lewat ikon gembok di sebelah alamat situs,
   lalu muat ulang.
3. iPhone/iPad: notifikasi hanya bekerja bila aplikasi dipasang lewat Safari → **Bagikan →
   Tambah ke Layar Utama** dan dibuka dari ikon itu.
4. Periksa **Jam tenang** dan pilihan **Kirim notifikasi untuk**.
5. Periksa mode hemat baterai atau "Jangan ganggu" di HP.

### Notifikasi hanya bertuliskan "Pesan baru di inbox"

Itu bawaan demi privasi di layar kunci. Owner bisa menampilkan nama kontak dan cuplikan pesan
di **Pengaturan → Notifikasi → Isi notifikasi di organisasi**.

## Channel lain

### Bot Telegram tidak menerima pesan

- Tekan **Pasang webhook** di halaman channel Telegram, lalu **Tes koneksi**.
- Webhook Telegram butuh alamat `https://` publik.
- Pastikan token bot tidak dipakai aplikasi lain (satu bot hanya untuk satu aplikasi).
- Hanya chat pribadi ke bot yang masuk; pesan grup diabaikan.

### Email lama tidak masuk ke inbox

Disengaja: saat channel email pertama kali terhubung, Balesin mulai dari email terbaru supaya
inbox tidak dibanjiri email lama. Email balasan otomatis, pantulan, dan email sangat besar juga
dilewati.

### Tes koneksi email gagal

- IMAP wajib terenkripsi: port **993** (SSL/TLS) atau **143** (STARTTLS).
- Gmail dan Microsoft 365: aktifkan IMAP dan pakai **app password**, bukan password akun biasa.
- Bila host, port, keamanan, atau username diubah, password harus diisi ulang.

### Messenger atau Instagram tidak bisa diaktifkan

Kedua channel ini butuh **App Review Meta** yang disetujui lebih dulu, lalu tes koneksi yang
berhasil. Sebelum itu channel tetap **Nonaktif** dengan lencana **Butuh App Review Meta**.

## Menu Email

Masalah di menu **Email** (bukan Channel Email di Inbox) dibahas di
[Bab 10.10](10-modul-email.md#1010-tanya-jawab): tidak bisa mengirim karena alamat belum
diverifikasi atau belum disetujui, email baru tidak muncul, status "Password ditolak", dan "Ruang
cache email penuh". Galat tes koneksi akun email ada di
[Bab 10.2](10-modul-email.md#102-untuk-owner-dan-admin-menghubungkan-akun).

## Integrasi

### Webhook keluar "Dinonaktifkan otomatis"

Penerima gagal 20 kali berturut-turut. Buka **Riwayat** untuk melihat alasannya (mis. alamat
salah, sertifikat, server penerima mati). Perbaiki penerima, tekan **Aktifkan**, lalu **Kirim
kejadian tes**.

### Webhook ke n8n di jaringan lokal ditolak

Tambahkan rentang IP jaringan lokal di **Pengaturan → Webhook → Jaringan privat yang
diizinkan**, dan tulis alamat dengan **IP**, bukan nama host lokal.

### Integrasi tiba-tiba mendapat galat 401

API key dicabut, kedaluwarsa, atau salah salin. Buat key baru di **Pengaturan → API key** dan
perbarui di integrasi. Galat 403 berarti izin key kurang atau IP pemanggil di luar daftar yang
diizinkan.

## Server

Ringkasan cepat (rincian di bawah tabel):

| Gejala | Periksa |
|---|---|
| Installer berhenti di langkah "Menyalakan" | `sudo balesin logs migrate api` — pesannya berbahasa Indonesia dan menyebut variabel yang salah |
| Halaman 502 dari nginx perusahaan (mode A) | `curl http://<IP-server>:8080/ready` dari server reverse proxy; firewall server Balesin; IP server Balesin yang diisi saat instalasi |
| Koneksi inbox putus tiap ±60 detik | `proxy_read_timeout` di nginx depan harus > 30 detik (contoh: `3600s`) |
| Webhook Meta ditolak kode 413 | `client_max_body_size` untuk `/webhooks/` di nginx depan minimal `3m` (contoh: `4m`) |
| Semua login kena batas percobaan bersamaan | IP reverse proxy salah — `sudo bash install.sh --ubah-jaringan` |
| Owner lupa password, email pengirim belum diatur | `sudo balesin reset-owner-password` |
| Update gagal | Sudah dikembalikan otomatis; kirim `/opt/balesin/logs/update-gagal-*.log` ke tim Balesin |

### Installer berhenti di langkah "Menyalakan"

Jalankan `sudo balesin logs migrate api`. Pesan kesalahan berbahasa Indonesia dan menyebut
nama variabel di `/opt/balesin/.env` yang bermasalah. Perbaiki, lalu jalankan ulang installer
(aman, rahasia yang sudah ada tidak diganti).

### Halaman tidak bisa dibuka / galat 502

Jalankan `sudo balesin status` dan `sudo balesin logs api`. Untuk mode A:

1. Dari server reverse proxy, jalankan `curl http://<IP-server-Balesin>:8080/ready`. Harus
   menjawab `{"status":"ok", …}`.
2. Bila tidak menjawab, periksa [firewall Mode A](01-instalasi.md#firewall-untuk-mode-a)
   (IP reverse proxy harus diizinkan) dan alamat `upstream` di konfigurasi nginx.
3. Pastikan IP server Balesin yang diisi saat instalasi benar. Ubah dengan
   `sudo bash install.sh --ubah-jaringan`.

### Koneksi inbox sering terputus (pesan baru tidak muncul real-time)

Untuk mode A: batas waktu baca di nginx depan harus lebih dari 30 detik. Contoh konfigurasi
(`balesin-nginx.conf`) memakai 1 jam untuk `location = /api/v1/inbox/stream`:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Bila memakai konfigurasi nginx sendiri, pastikan juga header `Upgrade` dan `Connection`
diteruskan dan header `Origin` **tidak** diubah.

### Webhook ditolak dengan kode 413

Nginx di depan Balesin menolak kiriman Meta karena ukurannya melebihi batas. Untuk
`location /webhooks/`, isi `client_max_body_size` minimal `3m` (contoh konfigurasi: `4m`),
lalu `nginx -t && systemctl reload nginx`. Untuk unggah media dari aplikasi, contoh
konfigurasi memakai `101m`.

### Semua pengguna tiba-tiba terkunci bersamaan

Biasanya IP reverse proxy salah diisi, sehingga semua pengunjung tampak berasal dari IP yang
sama. Jalankan `sudo bash install.sh --ubah-jaringan` dan isi IP reverse proxy yang benar.

### Update gagal

Balesin sudah melakukan rollback otomatis. Kirim berkas
`/opt/balesin/logs/update-gagal-*.log` ke tim Balesin.

### "Server belum punya kunci enkripsi"

Muncul bila `.env` tidak berisi `BALESIN_MASTER_KEY`. Ini tidak terjadi pada instalasi lewat
installer. Bila Anda memindahkan server, pastikan `.env` lama ikut disalin. **Jangan** membuat
kunci baru bila sudah ada data; kredensial lama tidak akan bisa dibuka.
