# 2. Pengaturan awal

Untuk Owner dan Admin. Kerjakan berurutan setelah wizard setup selesai. Semua pengaturan ada
di menu **Pengaturan**, bagian **Pengaturan organisasi**. Tidak ada yang perlu disunting di
berkas server.

> **Konfirmasi identitas.** Banyak perubahan penting (mengundang anggota, mengganti email
> pengirim, menyimpan kredensial channel, mengubah batas kirim, dan sejenisnya) meminta
> **password dan kode verifikasi** Anda sekali lagi. Ini disengaja, termasuk untuk Owner.

## 2.1 Nama aplikasi, logo, dan warna (white-label)

Nama aplikasi dan logo diatur di langkah **Tampilan** pada wizard setup
([Instalasi](01-instalasi.md#15-wizard-setup-owner)). Hasilnya tampil di halaman masuk, menu,
judul tab browser, ikon aplikasi yang dipasang di HP, dan email ke tim.

- **Nama aplikasi**: 2–40 karakter. Kosongkan untuk memakai nama bawaan.
- **Logo**: PNG, JPG, atau WebP, maksimal 256 KB. Bentuk melebar atau persegi dengan latar
  transparan paling rapi. SVG tidak diterima demi keamanan.
- **Nama perusahaan** (langkah Organisasi) tampil di halaman masuk sebagai
  "Masuk ke PT Contoh".

Keterbatasan versi ini (apa adanya):

- Belum ada menu untuk **mengubah nama aplikasi atau logo setelah wizard selesai**. Bila
  perlu diganti, hubungi tim Balesin.
- **Warna utama** belum bisa dipilih dari aplikasi; tampilan memakai warna bawaan.
- Tema terang/gelap diatur per perangkat oleh setiap pengguna di **Pengaturan → Tampilan**
  (Terang, Gelap, atau Ikuti sistem).

## 2.2 Email pengirim

Email pengirim dipakai untuk undangan tim, tautan atur ulang password, verifikasi email, dan
pemberitahuan keamanan ke Owner. Tanpa email pengirim, undangan tetap bisa dibuat tetapi
tautannya harus Anda salin dan kirim sendiri.

Buka **Pengaturan → Email pengirim**.

1. Pilih **Penyedia email**. Pilihan siap pakai mengisi host, port, dan keamanan secara
   otomatis:
   - **cPanel / IDCloudHost** — host biasanya `mail.<domain>`, port 465, SSL/TLS. Password =
     password akun email itu.
   - **Gmail / Google Workspace** — wajib memakai **app password** 16 karakter, bukan password
     akun Google. Aktifkan dulu Verifikasi 2 Langkah di Akun Google → Keamanan.
   - **Outlook / Microsoft 365** — admin Microsoft 365 harus mengaktifkan
     *Authenticated SMTP* untuk kotak surat ini; pakai app password bila akun memakai
     verifikasi dua langkah.
   - **Lainnya** — isi sesuai petunjuk penyedia email Anda.
2. Isi bagian **Pengirim**: **Nama pengirim** (mis. "Tim CS PT Contoh"), **Alamat email
   pengirim** (mis. `cs@contoh.co.id`), dan bila perlu **Alamat balas-ke**.
3. Setelah alamat diisi, aplikasi mencari server email domain Anda. Bila muncul **Saran
   pengaturan**, tekan **Pakai saran ini**.
4. Isi **Server SMTP**: Host SMTP, Port, Keamanan, Username (biasanya sama dengan alamat
   pengirim), dan Password atau App password.
5. Tekan **Tes koneksi**, lalu **Kirim email tes** ke alamat Anda sendiri.
6. Tekan **Simpan** dan konfirmasi identitas.

Status di menu Pengaturan berubah dari "Belum diatur" menjadi terhubung. Anda juga bisa
melihat **Pratinjau email** (undangan, atur ulang password, dan lainnya) yang memakai nama
aplikasi dan logo Anda.

Setiap perubahan email pengirim oleh Admin diberitahukan ke semua Owner lewat email.

## 2.3 Mengundang anggota tim

Buka **Pengaturan → Tim**.

1. Di **Undang anggota tim**, isi **Email** anggota.
2. Pilih **Peran**:
   - **Admin** — mengelola channel, pengguna, dan template. Wajib verifikasi dua langkah.
   - **Supervisor** — memantau semua chat, membuat broadcast, mengelola template. Wajib
     verifikasi dua langkah.
   - **CS** — membalas chat pelanggan dan mengurus tiket.
   - **Teknisi** — membalas chat yang ditugaskan kepadanya dan mengurus tiket miliknya.
3. Tekan **Kirim undangan** (bila email pengirim sudah diatur) atau **Buat tautan undangan**
   (bila belum), lalu konfirmasi identitas.
4. Bila memakai tautan: tekan **Salin tautan** dan kirim **langsung ke orangnya** lewat chat
   pribadi. Tautan setara kunci akses, hanya tampil sekali, dan berlaku **72 jam**.

Anggota membuka tautan, membuat password sendiri, lalu masuk. Admin dan Supervisor langsung
diminta mendaftarkan verifikasi dua langkah.

Di **Undangan terbuka** Anda bisa **Kirim ulang** (tautan lama otomatis tidak berlaku) atau
**Batalkan** undangan. Hanya Owner yang bisa mengelola undangan untuk peran Admin.

### Mengelola anggota

Di **Anggota tim**, buka nama anggota untuk:

- Mengubah **Peran**.
- **Atur ulang 2FA** bila ponsel anggota hilang atau aplikasi autentikatornya terhapus.
- **Buka lagi pendaftaran** verifikasi dua langkah bila batas waktunya lewat.
- **Buka kunci** akun yang terkunci karena salah password berulang.
- **Keluarkan semua sesi** anggota dari semua perangkat.
- Menonaktifkan akun di **Akses akun**. Anggota tidak pernah dihapus, hanya dinonaktifkan,
  sehingga riwayat chat tetap utuh.
- Mengatur **Departemen** anggota (lihat 2.4).

Admin hanya bisa mengelola Supervisor, CS, dan Teknisi. Akun Owner dan Admin dikelola Owner.

## 2.4 Departemen

Departemen mengelompokkan tim, misalnya "CS" dan "Teknisi". Lewati bagian ini bila tim Anda
masih kecil.

Buka **Pengaturan → Departemen → Tambah departemen**.

1. Isi **Nama departemen** dan **Deskripsi**.
2. Pilih **Channel bawaan**: chat baru dari channel ini langsung masuk departemen tersebut.
3. Pilih **Jam kerja**: **Ikut jam kerja organisasi**, atau **Jam kerja khusus** per hari.
4. Tekan **Simpan**.

Menambahkan anggota ke departemen: **Pengaturan → Tim → pilih anggota → Departemen**.
Untuk Supervisor dan CS, Anda bisa mencentang **Hanya lihat chat & tiket departemennya**.

> Anggota yang dibatasi ke departemen **tidak melihat chat tanpa departemen**. Pastikan
> setiap channel punya departemen bawaan supaya chat baru tidak terlewat.

Agen bisa memindahkan chat ke departemen lain dari menu chat (**Pindah departemen**).

## 2.5 Jam kerja dan pembagian chat

Buka **Pengaturan → Jam kerja & alokasi**.

**Jam kerja tim**

- **Setiap saat (24 jam)** atau **Sesuai jadwal** (atur jam per hari).
- **Hari libur**: tambahkan tanggal dan nama (mis. "Nyepi"). Di hari libur tim dianggap di
  luar jam kerja seharian.
- Jam kerja tim terpisah dari **jam kerja bot** (diatur per nomor, lihat
  [Bot, API, dan n8n](07-bot-api-n8n.md#71-bot-eksternal)).

**Pembagian chat**

| Pilihan | Cara kerja |
|---|---|
| **Ambil sendiri dari antrian** | Agen mengambil chat dari tab "Belum dilayani". Cocok untuk tim kecil. |
| **Bagi otomatis bergiliran** | Chat baru dalam jam kerja dibagikan ke agen yang tersedia, dimulai dari yang paling lama tidak mendapat chat. |

- **Kapasitas per agen**: maksimal chat terbuka yang dibagikan otomatis ke satu agen.
  Kosongkan untuk tanpa batas.
- **Agen untuk pembagian otomatis**: centang **Jangan beri chat otomatis** untuk agen yang
  dikecualikan. Owner dan Admin bawaannya dikecualikan. Agen sendiri bisa menyalakan atau
  mematikan **Tersedia** dari inbox.

**Pesan otomatis**

Dikirim sekali per percakapan baru dari pelanggan, selama sesi 24 jam masih terbuka.

| Pesan | Kapan | Variabel |
|---|---|---|
| **Sapaan (dalam jam kerja)** | Pelanggan menulis dalam jam kerja | `{nama}` |
| **Di luar jam kerja** | Pelanggan menulis di luar jam kerja atau hari libur | `{nama}` |
| **Saat ditangani agen** | Chat diambil atau ditugaskan ke agen | `{nama}`, `{agen}` |

Contoh: `Halo {nama}, {agen} akan membantu Anda ya.` Mengaktifkan atau mengubah teks pesan
otomatis butuh konfirmasi identitas, karena pesan dikirim dari nomor resmi ke semua pelanggan.

## 2.6 Keamanan akun (semua pengguna)

Setiap pengguna punya menu **Pengaturan → Keamanan akun**:

- **Verifikasi dua langkah**: wajib untuk Owner, Admin, dan Supervisor; disarankan untuk
  semua.
- **Kode cadangan**: tekan **Buat kode baru** bila hampir habis.
- **Email akun**: kirim email verifikasi.
- **Sesi aktif**: lihat perangkat yang sedang masuk, **Keluarkan semua sesi lain** bila ada
  yang tidak dikenal.

## 2.7 Audit log dan peringatan keamanan

- **Pengaturan → Audit log** mencatat siapa melakukan apa, kapan, dan dari IP mana. Bisa
  disaring dan diekspor CSV. Hanya Owner dan Admin yang bisa membuka.
- Bila ada kejadian penting (mis. email pengirim diubah, webhook ditolak berulang, password
  Owner diatur ulang dari server), Owner dan Admin melihat **banner peringatan keamanan** di
  atas aplikasi dengan tautan ke halaman terkait.

## 2.8 Pengaturan lain yang perlu diketahui

| Menu | Untuk apa | Dibahas di |
|---|---|---|
| **Channel** | Nomor WhatsApp, Telegram, email, Messenger, Instagram | [Bab 3](03-menghubungkan-channel.md) |
| **Template WhatsApp** | Pesan yang disetujui Meta | [Bab 5](05-template-dan-broadcast.md) |
| **Balasan cepat** | Teks siap pakai `/` | [Bab 4](04-inbox-untuk-agen.md#46-balasan-cepat) |
| **Atribut kontak** | Isian tambahan kontak (paket, ID pelanggan) | [Bab 6](06-kontak-tiket-laporan.md#62-atribut-kontak) |
| **Survei kepuasan (CSAT)** | Survei 1–5 setelah chat selesai | [Bab 6](06-kontak-tiket-laporan.md#65-survei-kepuasan-csat) |
| **Batas kirim** | Batas pesan keluar, rem darurat, pengaturan broadcast, tarif | [Bab 5](05-template-dan-broadcast.md#55-batas-kirim-dan-rem-darurat) |
| **API key**, **Webhook** | Integrasi n8n, bot, sistem lain | [Bab 7](07-bot-api-n8n.md) |
| **Konektor data**, **Alarm Telegram** | Penerima broadcast dari aplikasi billing; kabar ke grup Telegram | [Bab 5](05-template-dan-broadcast.md) |
| **Notifikasi** | Pemberitahuan chat baru di perangkat | [Bab 4](04-inbox-untuk-agen.md#410-notifikasi-dan-aplikasi-di-hp) |
