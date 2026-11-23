# 10. Modul Email

Untuk semua yang memakai menu **Email**: Owner dan Admin yang menghubungkan akun, serta CS,
Supervisor, dan anggota lain yang membaca dan membalas email. Menu Email bisa dipakai di komputer
maupun HP.

## 10.1 Apa itu menu Email

Menu **Email** adalah kotak surat lengkap di dalam aplikasi: beberapa akun email (mis. `cs@`,
`billing@`, dan akun pribadi Anda) dibaca, dirapikan, dan dibalas dari satu tempat. Semua aksi
tersinkron dua arah dengan server email, jadi tampil sama di webmail atau aplikasi email lain.

Menu Email **terpisah** dari Channel Email di Inbox:

| | Channel Email di Inbox ([Bab 3.3](03-menghubungkan-channel.md#33-email-imap-masuk-smtp-keluar)) | Menu Email |
|---|---|---|
| Cocok untuk | Email pelanggan yang ingin diperlakukan seperti chat | Surat-menyurat: vendor, mitra, kantor pajak, pelanggan korporat, internal |
| Tampilan | Bubble chat per percakapan, tab Belum dilayani/Dilayani/Selesai | Daftar email + panel baca + jendela tulis |
| Folder | Satu folder yang diambil berkala | Semua folder server: Kotak masuk, Terkirim, Draf, Spam, Sampah, Arsip, dan folder sendiri |
| Ambil, alihkan, tiket, tag | Ya | Belum |

Satu alamat hanya bisa dipakai di salah satunya. Bila alamat sudah menjadi Channel Email, wizard
menolak dengan pesan "Alamat ini sudah dipakai sebagai Channel Email di Inbox."

**Siapa yang melihat menu Email**: Owner dan Admin, anggota yang boleh menghubungkan akun pribadi
(Supervisor dan CS), dan siapa pun yang diberi akses ke minimal satu akun bersama. Teknisi tidak
melihat menu Email sampai diberi akses ke akun bersama.

## 10.2 Untuk Owner dan Admin: menghubungkan akun

Buka **Pengaturan → Akun email**, lalu tekan **Hubungkan akun email** (juga bisa dari tombol
**Hubungkan akun email** di kolom folder menu Email). Wizard punya 4 langkah.

**Langkah 1: Penyedia**

1. Isi **Alamat email**. Aplikasi mencoba mengenali host dan port secara otomatis begitu Anda
   pindah dari kolom itu (atau tekan ikon **Kenali pengaturan server** di ujung kolom).
2. Atau pilih kartu penyedia:
   - **cPanel / IDCloudHost** — email hosting dengan domain sendiri. Host diisi `mail.<domain>`,
     IMAP port 993 dan SMTP port 465 (SSL/TLS). Bila ragu, buka cPanel → Email Accounts →
     Connect Devices.
   - **IMAP lain** — server apa pun yang mendukung IMAP + SMTP dengan password (IMAP 993 SSL/TLS,
     SMTP 587 STARTTLS sebagai bawaan).
   - **Microsoft 365 / Outlook**, **Google Workspace / Gmail**, dan **POP3** masih **Segera
     hadir**. Sementara itu, Gmail bisa dihubungkan lewat **IMAP lain**: aktifkan IMAP di
     Gmail, buat sandi aplikasi, lalu isi host `imap.gmail.com` (993, SSL/TLS) dan
     `smtp.gmail.com` (465, SSL/TLS) secara manual.

**Langkah 2: Detail akun**

- **Nama akun** (tampil di menu Email, mis. "CS" atau "Billing") dan **Nama pengirim** (dilihat
  penerima).
- **Username** (biasanya alamat email lengkap) dan **Password atau sandi aplikasi**. Password
  disimpan terenkripsi dan tidak pernah ditampilkan lagi.
- **Server masuk (IMAP)** dan **Server keluar (SMTP)**: Host, Port, Keamanan. Koneksi wajib
  terenkripsi: IMAP 993 (SSL/TLS) atau 143 (STARTTLS), SMTP 465 (SSL/TLS) atau 587 (STARTTLS).
- Centang **Pakai username dan password yang sama dengan server masuk** bila SMTP memakai login
  yang sama.
- Akun dengan verifikasi dua langkah (mis. Gmail atau Yahoo) biasanya meminta **sandi
  aplikasi**, bukan password biasa. Tekan **Panduan pengaturan server** untuk petunjuknya.

**Langkah 3: Tes koneksi**

Tekan **Tes koneksi**. Masuk (IMAP) dan keluar (SMTP) dites terpisah; tidak ada email yang
dikirim saat tes. Hasil yang lolos menampilkan jumlah folder, folder khusus yang dikenali, apakah
email baru masuk seketika (IMAP IDLE) atau dicek tiap 2 menit, dan kapasitas kotak surat.

Galat yang sering muncul:

| Pesan | Yang perlu dilakukan |
|---|---|
| Server email masuk (IMAP) tidak ditemukan | Periksa penulisan host, mis. `mail.perusahaan.co.id` |
| Server menolak sambungan … di port ini / Sambungan aman … gagal | Cocokkan port dan keamanan: 993 atau 465 dengan SSL/TLS, 143 atau 587 dengan STARTTLS |
| Server IMAP/SMTP tidak merespons | Periksa host dan port. Untuk SMTP, bisa jadi jaringan server aplikasi memblokir port 465/587 keluar; tanyakan ke penyedia hosting atau VPS |
| Sertifikat keamanan server … tidak valid | Pakai nama host resmi dari penyedia email, bukan alamat IP |
| Username atau password akun email ditolak server | Periksa username (alamat lengkap) dan password |
| Penyedia email meminta sandi aplikasi | Buat sandi aplikasi di pengaturan keamanan akun email, tempel di kolom password |
| Akses IMAP belum diaktifkan di akun email ini | Aktifkan IMAP di pengaturan penyedia, lalu tes ulang |
| Microsoft 365 mematikan SMTP AUTH untuk kotak surat ini | Minta admin Microsoft 365 mengaktifkan *Authenticated SMTP* |
| Alamat server … tidak boleh dipakai | Pakai nama host publik dari penyedia email. Server email di jaringan lokal harus didaftarkan dulu di **Pengaturan → Webhook → Jaringan privat yang diizinkan** |
| Kotak surat hampir atau sudah penuh | Kosongkan kotak surat atau tambah kuotanya di penyedia |

Perbaiki isian di langkah **Detail akun**, lalu tekan **Tes ulang**.

**Langkah 4: Akses & tampilan**

1. Pilih **Akun bersama** (dipakai tim) atau **Akun pribadi** (hanya Anda).
2. Untuk akun bersama, atur **Siapa yang boleh mengakses** (lihat 10.3).
3. Pilih **Warna akun** (titik penanda asal email di daftar gabungan), **Ambil email sejak**
   (30 hari, 90 hari, 1 tahun terakhir, atau semua email), dan bila perlu **Foto atau logo**.
4. Tekan **Simpan & mulai sinkron**. Akun bersama meminta konfirmasi identitas; server dites
   ulang sebelum disimpan.

Sinkron awal berjalan di latar belakang; folder muncul di menu Email dalam beberapa saat. Email
yang lebih lama dari jangkauan sinkron bisa diambil nanti dengan mengubah **Ambil email sejak** di
halaman akun.

> **Langkah wajib setelah wizard**: alamat akun harus **diverifikasi** sebelum bisa dipakai
> mengirim. Buka halaman akun, bagian **Alamat pengirim**, tekan **Verifikasi** (lihat 10.6).

**Halaman akun** (klik akun di **Pengaturan → Akun email**): status sinkron, **Sinkron
sekarang**, **Jeda sinkron** / **Lanjutkan sinkron**, **Tes koneksi**, bagian **Tampilan &
sinkron** (nama, warna, nama pengirim, jangkauan sinkron, **Cek folder lain tiap** 1–60 menit,
bawaan 5), **Foto atau logo**, **Alamat pengirim**, **Tanda tangan**, **Pengiriman**, dan **Server
& password** (**Ubah server atau password**). **Putuskan** menghapus password dan semua email yang
tersimpan di aplikasi; email di server tidak disentuh, dan akun bisa dihubungkan lagi kapan saja.

Di bagian bawah **Pengaturan → Akun email**, Owner dan Admin juga bisa mengatur **Pengaturan
email** untuk seluruh organisasi: **Simpan isi email yang tidak dibuka selama** (7–3.650 hari,
bawaan 90) dan **Jendela sinkron untuk akun baru**.

## 10.3 Akun bersama, akun pribadi, dan hak akses

| | Akun bersama | Akun pribadi |
|---|---|---|
| Siapa yang menghubungkan | Owner dan Admin | Pemiliknya sendiri (Owner, Admin, Supervisor, CS) |
| Siapa yang membaca isinya | Owner, Admin, dan yang diberi akses | Hanya pemiliknya |
| Yang dilihat Owner/Admin | Semuanya | Hanya alamat dan status ("Isinya hanya bisa dibaca pemiliknya.") |

Hak per akun bersama:

| Hak | Bisa |
|---|---|
| **Baca** | Membaca, menandai dibaca, dan membintangi |
| **Baca & kirim** | Juga menulis, membalas, meneruskan, memindah, mengarsipkan, dan menghapus ke Sampah |
| **Kelola** | Juga mengubah nama, warna, foto, dan sinkron akun, menghapus permanen, memverifikasi alamat pengirim, dan mengatur tanda tangan bersama |

Owner dan Admin otomatis punya hak **Kelola** di semua akun bersama. Hanya Owner dan Admin yang
bisa mengubah siapa yang punya akses.

Ada dua tempat mengatur akses:

- **Dari sisi akun**: halaman akun → bagian **Akses** → **Tambah orang atau departemen**, pilih
  hak tiap orang/departemen, lalu **Simpan akses**. Hak lewat departemen berlaku untuk semua
  anggota departemen itu.
- **Dari sisi anggota**: **Pengaturan → Tim → pilih anggota → Akses email**. Pilih hak untuk tiap
  akun bersama (atau **Tanpa akses langsung**), lalu **Simpan akses email**. Bagian ini juga
  menunjukkan **Hak efektif** (yang tertinggi dari hak langsung dan hak lewat departemen) dan
  apakah menu Email sudah tampil untuk anggota itu.

Menambah orang atau menaikkan hak meminta konfirmasi identitas.

## 10.4 Email pengirim sistem: pakai alamat terpisah

**Email pengirim** (Pengaturan → Email pengirim, [Bab 2.2](02-pengaturan-awal.md#22-email-pengirim))
adalah alamat yang dipakai aplikasi untuk mengirim tautan reset password, undangan tim, dan **kode
verifikasi alamat pengirim** di menu Email.

Pakai **alamat khusus** untuk Email pengirim, mis. `noreply@perusahaan.co.id`, dan **jangan**
hubungkan kotak surat yang sama sebagai akun di menu Email. Alasannya: salinan email yang
dikirim bisa tersimpan di folder Terkirim kotak surat itu, sehingga tautan reset password,
undangan, dan kode verifikasi bisa terbaca oleh siapa pun yang punya akses ke akunnya.

Aplikasi menjaga aturan ini dua arah:

- Menghubungkan kotak surat yang sedang dipakai sebagai Email pengirim ditolak: "Kotak surat ini
  dipakai sebagai Email pengirim sistem …".
- Mengganti Email pengirim ke kotak surat yang sudah terhubung di menu Email juga ditolak.
- Bila keduanya terlanjur sama, verifikasi alamat **dikunci di seluruh organisasi** dan halaman
  akun menampilkan **Akun ini juga dipakai sebagai Email pengirim sistem** dengan tombol **Buka
  Email pengirim**. Ganti Email pengirim ke kotak surat lain atau putuskan akun itu.

Email pengirim juga **wajib sudah diatur**. Tanpa itu, verifikasi tidak bisa dimulai: "Atur Email
pengirim di Pengaturan dulu supaya email verifikasi bisa dikirim."

## 10.5 Menyetujui alamat pengirim

Bila anggota menghubungkan **akun pribadi** yang memakai **domain organisasi** (mis.
`dimas@perusahaan.co.id`), atau menambah alias berdomain organisasi di akun pribadinya, alamat itu
harus disetujui Owner atau Admin sebelum bisa diverifikasi dan dipakai mengirim. Ini mencegah
orang mengirim atas nama alamat kantor tanpa sepengetahuan pengelola. Owner dan Admin menerima
email pemberitahuan.

1. Buka **Pengaturan → Akun email**. Bagian **Alamat pengirim menunggu persetujuan** tampil bila
   ada yang menunggu.
2. Periksa alamat dan pemiliknya ("Akun pribadi …").
3. Tekan **Setujui** atau **Tolak**, lalu konfirmasi identitas.

Setelah disetujui, pemilik akun pribadi memverifikasi alamatnya seperti biasa. Alamat yang ditolak
berstatus **Ditolak Owner/Admin** dan tidak bisa dipakai mengirim. Admin tidak bisa memutuskan
alamat akun pribadinya sendiri.

## 10.6 Alamat pengirim dan verifikasi

Email hanya bisa dikirim dari alamat yang **sudah diverifikasi**, termasuk oleh Owner dan Admin.
Verifikasi membuktikan bahwa alamat itu benar milik Anda atau tim Anda, supaya tidak ada yang bisa
mengirim sebagai `direktur@…` hanya karena mengetahui password server email.

Kelola di halaman akun → bagian **Alamat pengirim** (butuh hak **Kelola**). Setiap alamat punya
status **Terverifikasi**, **Menunggu verifikasi**, **Belum diverifikasi**, atau **Menunggu
persetujuan**.

**Memverifikasi**

1. Tekan **Verifikasi**. Email verifikasi dikirim lewat Email pengirim sistem ke alamat itu.
2. **Otomatis**: bila email verifikasi masuk ke kotak surat akun ini, alamat biasanya
   terverifikasi dalam beberapa detik ("Terverifikasi otomatis lewat kotak surat").
3. **Dengan kode**: bila kotak surat alamat itu ada di tempat lain (mis. alias "kirim sebagai"),
   buka email verifikasinya dan masukkan **Kode 6 angka**, lalu tekan **Verifikasi kode**. Kode
   berlaku 30 menit, maksimal 5 percobaan. Tekan **Kirim ulang kode** bila perlu (maksimal 3 kali
   per alamat per 24 jam).

Alamat tanpa kotak surat (mis. `noreply@` yang tidak bisa menerima email) tidak bisa
diverifikasi, jadi tidak bisa dipakai sebagai **Dari** di menu Email.

Verifikasi **diulang** bila alamat akun, host, port, atau username server diubah. Mengganti
password saja tidak mengulang verifikasi.

**Alias**

Alias adalah alamat lain yang emailnya juga masuk ke akun ini, atau yang boleh dipakai "kirim
sebagai" di penyedia email Anda (mis. `tagihan@` di akun `billing@`).

1. Tekan **Tambah alias**, isi **Alamat alias**, **Nama pengirim**, dan bila perlu **Alamat
   balas-ke** (harus satu domain dengan alamat pengirim).
2. Konfirmasi dengan password Anda (alias akun bersama, hanya Owner/Admin).
3. Verifikasi dimulai otomatis.

Maksimal 20 alias per akun. Pastikan penyedia email mengizinkan alias itu sebagai pengirim; bila
tidak, email gagal dengan "Server email menolak alamat Dari ini." Menu titik tiga di setiap alamat
berisi **Ubah** (nama pengirim, alamat balas-ke, tanda tangan bawaan) dan **Hapus alias**.

## 10.7 Tanda tangan, pengiriman, dan preferensi menulis

**Tanda tangan** (halaman akun → **Tanda tangan**)

- **Bersama**: dipakai semua orang yang mengirim dari akun ini (butuh hak **Kelola**). Tekan
  **Buat tanda tangan bersama**.
- **Pribadimu**: hanya untuk Anda di akun ini (butuh hak **Baca & kirim**). Tekan **Buat tanda
  tangan pribadi**.
- Isi **Nama tanda tangan** (hanya terlihat di aplikasi, mis. "Formal") dan **Isi tanda tangan**.
  Variabel: `{{nama_agen}}` (nama pengirim), `{{alamat_pengirim}}`, `{{nama_organisasi}}`,
  `{{logo}}`. Satu tanda tangan bersama bisa memuat nama tiap agen.
- **Logo**: PNG, JPEG, atau WebP maks. 1 MB, dikecilkan otomatis ke lebar 320 px. Pakai `{{logo}}`
  di isi.
- Tanda tangan bawaan per alamat (**Tanda tangan email baru** dan **Tanda tangan balasan**) diatur
  lewat **Ubah** di bagian Alamat pengirim.

**Pengiriman** (halaman akun → **Pengiriman**, hak **Kelola**; berlaku untuk semua yang mengirim
dari akun ini)

- **Salinan email terkirim**: **Otomatis (disarankan)** menyimpan salinan ke Terkirim hanya bila
  server belum menyimpannya sendiri, **Selalu simpan ke Terkirim**, atau **Jangan simpan salinan**.
- **Peringatkan bila ada penerima di luar domain kantor**. Domain kantor = domain semua alamat
  pengirim akun email dan channel Email.

**Preferensi menulis** (**Pengaturan → Akun email**, berlaku untuk semua akun yang bisa Anda
pakai)

- **Waktu untuk membatalkan kirim**: 5, 10 (bawaan), 15, 20, atau 30 detik.
- **Format email baru**: **Teks berformat** atau **Teks biasa**.

## 10.8 Membaca email

Menu Email terdiri dari kolom folder, daftar email, dan panel baca. Di HP, ketuk **Buka folder dan
akun** untuk memilih folder; panel baca terbuka penuh dan **Kembali ke daftar email** membawa Anda
kembali.

**Tampilan di kolom folder**

| Tampilan | Isi |
|---|---|
| **Semua kotak masuk** | Kotak masuk semua akun yang boleh Anda buka, digabung |
| **Belum dibaca** | Email yang belum dibuka dari semua akun |
| **Berbintang** | Email yang Anda beri bintang |
| Folder per akun | Kotak masuk, Draf, Terkirim, Arsip, Spam, Sampah, dan folder sendiri, dengan jumlah belum dibaca |

- Di tampilan gabungan, **titik warna** menandai akun asal. Chip seperti "ke billing@" berarti email
  masuk lewat alias atau alamat lain milik akun itu.
- Daftar dikelompokkan **Hari ini**, **Kemarin**, **Minggu ini**, dan **Lebih lama**. Di komputer,
  pakai panah atas/bawah untuk berpindah dan Enter untuk membuka.
- Kaki kolom folder menunjukkan status sinkron, mis. "Tersinkron · 2 menit lalu" atau "1 akun
  perlu perhatian".

**Panel baca**

- Kepala email menampilkan pengirim, penerima (kepada, cc, balas ke), waktu, dan baris
  **Diterima di** *nama akun* · **dikirim ke** *alamat*.
- **Lencana pengirim**: **Terverifikasi** (SPF, DKIM, atau DMARC pengirim lolos pemeriksaan),
  **Belum terverifikasi**, atau **Gagal verifikasi**. Email yang gagal mendapat kotak merah
  **Pengirim email ini tidak lolos pemeriksaan**; hati-hati dengan tautan dan lampirannya.
- **Periksa dulu sebelum menanggapi**: peringatan bila nama pengirim mirip orang/organisasi Anda
  tetapi dikirim dari luar, alamat pengirim mirip domain Anda, ada tautan yang teksnya beda dengan
  tujuannya, atau ada lampiran berisiko yang diblokir.
- Email yang terlalu besar (lebih dari 25 MB) hanya diambil teksnya: **Email ini terlalu besar
  untuk dibuka utuh**. Buka lewat webmail penyedia untuk melihat semuanya.

**Gambar dari luar**

Gambar dari internet **disembunyikan** supaya pengirim tidak tahu kapan Anda membuka email.
Tekan **Tampilkan gambar** untuk email ini, atau **Selalu dari pengirim ini** untuk pengirim
tepercaya. Bila pengirimnya gagal pemeriksaan keaslian, gambar tetap disembunyikan dan pilihan
"Selalu dari pengirim ini" tidak tersedia. Gambar diambil lewat server aplikasi, bukan langsung
dari browser Anda.

**Tautan yang mencurigakan**

Bila teks tautan berbeda dengan alamat tujuannya, mengekliknya membuka halaman **Periksa tautan ini
dulu** yang menampilkan **Teks yang tampil di email**, **Tautan sebenarnya membuka**, dan **Domain
tujuan**. Pilih **Kembali ke Email** bila ragu, atau **Tetap buka tautan** bila yakin aman.

**Lampiran**

- Tekan ikon unduh di kartu lampiran. Lampiran yang belum tersimpan di aplikasi diambil dulu dari
  server (**Menyiapkan…**).
- **Diblokir**: program (mis. `.exe`, `.bat`, `.js`), dokumen Office bermakro (mis. `.docm`,
  `.xlsm`), dokumen Office format lama, serta halaman web dan SVG (`.html`, `.svg`). Berkas
  seperti ini sering dipakai menyebarkan virus. Minta pengirim mengirim ulang dalam bentuk PDF.
- **Berkas arsip** (ZIP, RAR, 7z) bisa diunduh setelah konfirmasi **Unduh berkas arsip ini?** →
  **Tetap unduh**. Buka hanya bila Anda mengenal pengirimnya.
- Lampiran lebih dari 50 MB tidak bisa diunduh lewat aplikasi; buka lewat webmail penyedia.

**Aksi email** (bilah di atas panel baca; yang tampil menyesuaikan hak dan folder)

| Aksi | Hak minimal | Keterangan |
|---|---|---|
| **Tandai belum dibaca** / **Tandai sudah dibaca** | Baca | |
| **Beri bintang** / **Hapus bintang** | Baca | |
| **Arsipkan** | Baca & kirim | Dipindah ke folder Arsip (dibuat otomatis bila belum ada) |
| **Hapus** | Baca & kirim | Dipindah ke Sampah |
| **Tandai spam** / **Bukan spam** | Baca & kirim | Bukan spam mengembalikan email ke Kotak masuk |
| **Pindahkan ke folder** | Baca & kirim | Pilih folder tujuan |
| **Hapus permanen** | Kelola | Hanya di Sampah dan Spam; email dihapus dari server dan tidak bisa dikembalikan |

Semua aksi juga berlaku di server email, jadi tercermin di webmail dan aplikasi email lain.

## 10.9 Menulis, membalas, dan meneruskan

Butuh hak **Baca & kirim** di akun yang dipakai. Bila hak Anda hanya Baca, panel baca menampilkan
"Kamu hanya punya hak baca di akun ini."

**Membuka jendela tulis**

- Email baru: tekan **Tulis email** di kolom folder (di HP: tombol **Tulis**).
- Balasan: di kepala panel baca tekan **Balas**, **Balas semua**, atau **Teruskan**. Balasan selalu
  dikirim dari akun yang sama dengan email aslinya; meneruskan boleh dari akun lain yang Anda punya
  hak kirim.
- Di komputer, jendela tulis **mengambang** di kanan bawah: **Perkecil**, **Perbesar**, atau
  **Tutup (draf disimpan)**. Maksimal 3 jendela sekaligus. **Esc** memperkecil jendela.
- Di HP, jendela tulis **layar penuh**; tombol kirim dan lampiran ada di bilah atas.

**Dari, Kepada, Cc, Bcc**

- **Dari**: pilih alamat pengirim. Alamat yang belum bisa dipakai tampil nonaktif dengan
  keterangan **Verifikasi alamat ini dulu**, **Menunggu verifikasi**, atau **Menunggu persetujuan
  Owner/Admin**. Mengganti ke akun lain membuat draf baru dengan isi yang sama.
- **Kepada**: ketik nama atau alamat; saran muncul dari kontak dan alamat yang pernah berkirim
  email. Tekan Enter, koma, atau titik koma untuk menambah alamat. Tekan **Cc/Bcc** untuk
  menampilkan kolom tembusan.
- Penerima **Bcc** tidak terlihat oleh penerima lain. **Balas semua** tidak pernah menyertakan
  penerima Bcc email asli dan tidak menyertakan alamat akun Anda sendiri.

Peringatan yang mungkin muncul di bawah kolom penerima:

| Peringatan | Arti |
|---|---|
| "45 dari maks. 50 penerima" | Batas penerima per email (Kepada + Cc + Bcc) bawaan 50 |
| "Ada penerima di luar domain kantor. Periksa lagi sebelum mengirim." | Muncul bila pengaturan **Pengiriman** akun menyalakan peringatan luar domain |
| "Bcc lebih dari 10 alamat. Untuk kirim massal, pakai Broadcast." | Menu Email bukan untuk kirim massal |
| "Balasan akan dikirim ke … (alamat balas-ke), bukan ke alamat pengirim." | Alamat balas-ke email asli berbeda domain dengan pengirimnya; pola penipuan yang umum |
| "… alamat baru. Sisa jatah alamat baru hari ini: …" | Jatah email ke alamat yang belum pernah berkirim email dengan akun ini: 200 per orang per hari |

**Editor**

- Bilah format: **Tebal**, **Miring**, **Garis bawah**, **Daftar berpoin**, **Daftar bernomor**,
  **Tautan**, **Kutipan**, **Sisipkan gambar**, dan pilihan **Teks biasa** / **Teks berformat**.
- Gambar yang ditempel dari web atau Word tidak ikut ("Gambar dari luar tidak ikut ditempel.
  Unggah gambarnya."). Pakai **Sisipkan gambar** (PNG, JPEG, GIF, atau WebP, maks. 5 MB).
- Saat membalas, email asli disertakan sebagai kutipan yang bisa dilipat (**Tampilkan kutipan
  email …**). Tekan **Jangan sertakan kutipan** bila tidak perlu.

**Template**

Ketik `/` di isi email atau tekan **Sisipkan template**. Daftar berisi **Balasan cepat** (variabel
`{nama}` dan `{agen}` terisi otomatis) dan **Template email** yang sudah terbit di **Pengaturan →
Template email**. Bila template butuh isian, muncul formulir **Lengkapi template …**; isi yang
wajib lalu tekan **Sisipkan**.

**Tanda tangan**

Tanda tangan bawaan disisipkan otomatis. Tekan **Tanda tangan** untuk menggantinya di email ini:
**Tanpa tanda tangan**, tanda tangan **Bersama**, atau **Pribadimu**.

**Lampiran**

- Tekan **Lampirkan berkas** atau seret berkas ke jendela tulis.
- Boleh: PDF, gambar, dokumen Office tanpa makro (`.docx`, `.xlsx`, `.pptx`), CSV, dan TXT. Berkas
  lain, termasuk ZIP dan dokumen Office format lama, ditolak.
- Maksimal 20 berkas dan total 20 MB per email. Untuk berkas besar, bagikan tautan.
- Saat meneruskan, lampiran asli ikut otomatis. Lampiran yang diblokir, tidak boleh dikirim, atau
  terlalu besar tidak ikut, dengan keterangan **Sebagian lampiran asli tidak ikut diteruskan**.

**Draf tersimpan otomatis**

- Draf disimpan otomatis selama Anda mengetik dan saat jendela ditutup. Status di kaki jendela:
  "Draf tersimpan · 09.41", **Menyimpan draf…**, atau "Draf belum tersimpan. Dicoba lagi otomatis."
- Salinan draf juga disimpan ke folder **Draf** di server email. Pada akun bersama, salinan ini
  terlihat oleh semua yang punya akses ke akun itu (sifat kotak surat bersama). Hanya Anda yang
  bisa melanjutkan dan mengirim draf milik Anda.
- Buka draf dari folder Draf untuk melanjutkan menulis. Maksimal 100 draf per orang.
- **Buang draf** (ikon tempat sampah di kaki jendela) menghapus isi, lampiran, dan salinan di
  server.
- Bila draf yang sama diubah di tab atau perangkat lain, muncul **Draf ini diubah di tab atau
  perangkat lain**. Pilih **Muat versi terbaru** atau **Timpa dengan versi ini**; versi yang tidak
  dipilih akan tertimpa.

**Mengirim dan membatalkan**

1. Tekan **Kirim** (atau **Ctrl+Enter**). Aplikasi bisa bertanya dulu: **Kirim tanpa subjek?** atau
   **Belum ada lampiran** (bila Anda menulis "terlampir" tetapi belum melampirkan apa pun). Pilih
   **Tetap kirim** atau **Kembali menulis**.
2. Jendela tertutup dan muncul pemberitahuan "Email akan dikirim dari …" dengan hitung mundur.
3. Tekan **Batalkan** sebelum hitungan habis: "Pengiriman dibatalkan. Draf dibuka lagi." Atau
   tekan **Kirim sekarang** untuk melewati jeda.

Lama jeda diatur di **Preferensi menulis** (bawaan 10 detik).

**Status setelah dikirim**

| Pemberitahuan | Arti dan yang perlu dilakukan |
|---|---|
| **Email terkirim.** | Selesai |
| **Email tertahan** | Menunggu dan dikirim otomatis. Alasannya tertulis, mis. batas kirim per jam akun (bawaan 100 penerima per jam), server meminta jeda, rem darurat ditarik, atau password SMTP ditolak |
| **Email gagal dikirim.** | Alasan tertulis di bawahnya. Tekan **Buka draf**, perbaiki, lalu kirim lagi. Jendela tulis menampilkan **Gagal dikirim** dan alasannya |
| **Status pengiriman tidak pasti.** | Sambungan putus tepat saat email diserahkan ke server. Email mungkin sudah sampai. **Jangan langsung kirim ulang**: cek folder Terkirim atau tanyakan penerima dulu |
| "Email terkirim, tetapi … alamat ditolak server." | Sebagian penerima ditolak. Jangan kirim ulang ke semua; kirim terpisah ke alamat yang ditolak setelah diperbaiki |
| "Email terkirim, tetapi salinannya gagal disimpan di folder Terkirim." | Email tetap sampai; hanya salinannya yang tidak tersimpan |

Batas harian **500 penerima per orang per 24 jam** berlaku gabungan untuk pesan Inbox dan email
menu Email (lihat [Bab 5](05-template-dan-broadcast.md)).

**Kerja tim di utas yang sama**

- Bila rekan sedang menulis balasan untuk email yang sama, panel baca menampilkan "Dimas sedang
  membalas…". Koordinasikan dulu supaya pengirim tidak dibalas dua kali.
- Bila ada email baru di utas saat Anda menulis, jendela tulis menampilkan **Ada email baru di utas
  ini.** dengan tombol **Lihat**.
- Saat Anda menekan Kirim dan ada email baru yang belum Anda lihat, muncul dialog **Ada email baru
  di utas ini**. Pilih **Lihat dulu** untuk membacanya, atau **Tetap kirim**.

## 10.10 Tanya jawab

**Tidak bisa mengirim: "Alamat … belum diverifikasi"**

Buka **Pengaturan → Akun email → pilih akun → Alamat pengirim**, lalu tekan **Verifikasi** (atau
tombol **Verifikasi alamat** di jendela tulis). Hanya pemegang hak **Kelola** yang bisa
memverifikasi; bila hak Anda kurang, minta Owner atau Admin. Bila muncul pesan bahwa verifikasi
dikunci atau Email pengirim belum diatur, lihat 10.4.

**Tidak bisa mengirim: "Menunggu persetujuan Owner/Admin"**

Alamat akun pribadi Anda memakai domain organisasi. Minta Owner atau Admin menyetujuinya di
**Pengaturan → Akun email** (lihat 10.5), lalu verifikasi alamatnya.

**"Belum ada alamat pengirim untukmu"**

Anda belum punya hak **Baca & kirim** di akun mana pun. Minta Owner atau Admin menambah hak Anda.

**Email baru tidak muncul**

- Cek status akun di **Pengaturan → Akun email** atau kaki kolom folder. **Dijeda** → tekan
  **Lanjutkan sinkron**. **Gagal tersambung** → tekan **Lihat masalah**. **Pemilik nonaktif** →
  sinkron akun pribadi berhenti saat pemiliknya dinonaktifkan.
- Kotak masuk biasanya masuk dalam hitungan detik. Bila server tidak mendukung IMAP IDLE, kotak
  masuk dicek tiap 2 menit, dan folder lain sesuai **Cek folder lain tiap** (bawaan 5 menit).
  Tekan **Sinkron sekarang** untuk mengambil seketika.
- Akun yang baru terhubung masih **Sinkron awal**. Daftar terisi bertahap.
- Email lama di luar jangkauan sinkron belum diambil. Ubah **Ambil email sejak** di halaman akun.

**Status "Password ditolak"**

Server email menolak password yang tersimpan, biasanya karena password diganti di penyedia atau
sandi aplikasi dicabut. Tekan **Perbarui password** di **Pengaturan → Akun email**, isi password
baru, lalu simpan; server dites ulang sebelum disimpan. Akun bersama hanya bisa diperbarui Owner
atau Admin. Selama password ditolak, email keluar tertahan ("Password SMTP akun ini ditolak") dan
gagal bila tidak diperbaiki dalam 24 jam.

**"Ruang cache email penuh" saat mengunduh lampiran**

Aplikasi menyimpan salinan isi dan lampiran email yang pernah dibuka, dengan batas 2 GB per akun
dan 20 GB per organisasi. Saat penuh, lampiran baru belum bisa diunduh lewat aplikasi; buka lewat
webmail penyedia. Owner atau Admin bisa memperkecil **Simpan isi email yang tidak dibuka selama**
di **Pengaturan → Akun email → Pengaturan email** supaya cache lama dibersihkan lebih cepat. Email
di server tidak terpengaruh.

**Tes koneksi gagal**

Lihat tabel galat di 10.2. Untuk Gmail, aktifkan IMAP dan pakai sandi aplikasi. Untuk Microsoft
365, admin harus mengaktifkan *Authenticated SMTP*.

## 10.11 Akan datang

Fitur berikut belum tersedia dan direncanakan di tahap berikutnya:

- **Cari dan saring** email, **label**, pengelompokan **utas** lengkap, pilih banyak + aksi massal,
  pintasan keyboard, membuat/mengganti nama folder sendiri, notifikasi email di HP, serta panel
  kontak dan **Buat tiket** dari email.
- **Aturan otomatis**, menugaskan email ke anggota, tunda, balasan otomatis, Cc/Bcc bawaan per
  alamat, dan meneruskan sebagai lampiran.
- **Masuk dengan Microsoft** (Microsoft 365 / Outlook) dan **Masuk dengan Google** (Google
  Workspace), POP3, **jadwalkan kirim**, serta API dan webhook untuk akun di menu Email.
