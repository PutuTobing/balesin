# 7. Bot, API, dan n8n

Untuk Owner dan Admin, serta tim TI yang membuat integrasi. Bagian ini menjelaskan cara
menghubungkan bot (mis. alur n8n), aplikasi billing, atau CRM lain ke Balesin.

Gambaran singkat:

| Arah | Alat | Untuk |
|---|---|---|
| Balesin → sistem Anda | **Webhook** (Pengaturan → Webhook) | Memberi tahu n8n/bot/CRM saat ada pesan masuk, chat diambil, chat selesai, kontak berubah, tiket dibuat, dan seterusnya |
| Sistem Anda → Balesin | **API key** (Pengaturan → API key) | Membaca chat, mengirim balasan, mengirim template ke nomor, mengelola kontak dan tiket |
| Sistem Anda → Balesin (data penerima) | **Konektor data** | Menarik daftar penerima broadcast (lihat [Bab 5](05-template-dan-broadcast.md#56-konektor-data-penerima-dari-aplikasi-lain)) |

Dokumentasi teknis lengkap (OpenAPI) ada di `https://cs.contoh.co.id/api/docs` — ganti dengan
domain Anda. Halaman ini bisa dibuka tanpa masuk dan tidak memuat data organisasi. Owner atau
Admin bisa mematikannya di **Pengaturan → API key → Dokumentasi API**.

## 7.1 Bot eksternal

Bot eksternal adalah bot di luar Balesin (mis. alur n8n dengan AI) yang menjawab chat lebih
dulu, lalu menyerahkan ke tim bila perlu. Versi ini belum punya bot AI bawaan atau pembuat alur
visual; bot dibuat di n8n atau sistem lain.

Langkah menghubungkan bot ke nomor WhatsApp:

1. **Buat API key khusus bot** (7.2) dengan izin seperlunya, mis. **Kirim pesan**, **Tangani
   percakapan**, dan **Ubah kontak**. Batasi ke alamat IP server n8n.
2. **Tambah webhook** (7.3) ke alamat webhook n8n, centang kejadian **message.received**, dan
   nyalakan **Kirim pesan masuk hanya selama bot memegang chat** bila penerima hanya berperan
   sebagai bot.
3. **Aktifkan bot di nomor**: **Pengaturan → Channel → pilih nomor → Bot**:
   - Nyalakan **Aktifkan bot untuk nomor ini**.
   - **Jam kerja bot**: **24 jam** atau **Jadwal** per hari. Jam bot terpisah dari jam kerja
     tim, mis. bot 24 jam sementara tim hanya jam kantor.
   - **Batas waktu menunggu balasan bot (menit)**: bila bot tidak membalas selama ini, chat
     otomatis masuk antrian tim (1–1.440 menit).
   - Tekan **Simpan pengaturan bot**.

Saat bot aktif, chat baru di nomor itu masuk tab **Bot**. Chat pindah ke tim bila:

- bot menyerahkannya (lewat API),
- agen menekan **Ambil alih** / **Ambil alih dari bot**,
- bot tidak membalas dalam batas waktu.

Agen bisa mengembalikan chat ke bot lewat **Kembalikan ke bot**. **Mematikan bot** di nomor
menyerahkan semua chat yang sedang dipegang bot ke antrian tim.

Pengaturan bot di layar saat ini tersedia untuk nomor WhatsApp.

## 7.2 API key

Buka **Pengaturan → API key → Buat API key**.

1. **Nama**: untuk mengenali pemakainya, mis. "n8n produksi" atau "Aplikasi billing".
2. **Izin** (pilih seperlunya; izin yang lebih tinggi otomatis mencakup izin baca di bawahnya):

   | Izin | Arti |
   |---|---|
   | Baca percakapan | Daftar dan detail percakapan |
   | Tangani percakapan | Lepas bot ke antrian, tugaskan agen, tandai selesai, tulis catatan tim |
   | Baca pesan & statusnya | Riwayat pesan |
   | Kirim pesan di percakapan yang sudah ada | Membalas dalam sesi 24 jam, termasuk unggah media |
   | Kirim template ke nomor | Bisa memulai percakapan baru; dipakai aplikasi billing atau notifikasi |
   | Baca & cari kontak | |
   | Buat & ubah kontak, pasang/lepas tag | |
   | Baca & cari tiket serta board | |
   | Buat & ubah tiket, pindah kolom, tulis komentar | |

3. **Masa berlaku**: tanpa batas waktu, 30 hari, 90 hari, 1 tahun, atau tanggal tertentu.
4. **Batasi alamat IP** (disarankan): satu IP atau CIDR per baris, mis. `203.0.113.10`.
5. **Batas pesan per 24 jam** untuk key ini (bawaan 500, maks. 100.000).
6. Tekan **Buat key**, konfirmasi identitas.
7. **Salin API key sekarang**. Key hanya ditampilkan **sekali**. Simpan di kredensial n8n atau
   pengelola rahasia, lalu tekan **Sudah saya simpan**.

> **API key berlaku untuk seluruh organisasi.** Key yang boleh mengirim pesan juga bisa membaca
> **semua** percakapan, bukan hanya chat satu agen. Berikan hanya ke integrasi tepercaya,
> satu key untuk satu integrasi, supaya mudah dicabut.

Mencabut key: tekan **Cabut** di daftar. Integrasi yang memakainya langsung berhenti, termasuk
pesan yang masih mengantre.

Cara memakai key (contoh, untuk tim TI):

```bash
curl https://cs.contoh.co.id/api/v1/public/conversations \
  -H "Authorization: Bearer <API key Anda>"
```

Pesan yang dikirim lewat API key tercatat sebagai pengirim **Bot** di inbox dan di laporan
**Per bot**.

### Mengirim template dari aplikasi billing

Aplikasi lain (mis. aplikasi billing) bisa mengirim template yang sudah disetujui ke nomor
pelanggan lewat `POST /api/v1/public/messages/template` dengan key yang punya izin **Kirim
template ke nomor**. Rincian isian ada di `/api/docs`. Pesan ini tidak menambah antrian inbox;
balasan pelanggan membuka chat baru seperti biasa.

Aplikasi billing yang hanya bisa memakai format vendor tertentu (tanpa bisa diubah) belum
didukung langsung; mode tangkap format vendor masih dalam pengembangan.

## 7.3 Webhook keluar

Buka **Pengaturan → Webhook → Tambah webhook**.

1. **URL penerima**: wajib `https://`. Alamat jaringan lokal (mis. n8n di LAN) hanya boleh bila
   ada di **Jaringan privat yang diizinkan** di halaman yang sama; untuk alamat LAN gunakan IP,
   bukan nama host lokal.
2. **Keterangan** (opsional), mis. "n8n bot tagihan".
3. **Format**: **Standar** atau **MobiChat** (lihat 7.4). Format tidak bisa diubah setelah
   disimpan.
4. **Kejadian yang dikirim**: pilih yang perlu, atau **Pilih semua**. Tersedia antara lain
   pesan masuk, pesan terkirim, status pesan, percakapan dibuat/diambil/dilepas/selesai/dibuka
   lagi/diserahkan bot, kontak dibuat/diubah, dan tiket dibuat/diubah.
5. Tekan **Simpan**, konfirmasi identitas.
6. **Salin rahasia webhook sekarang** (hanya tampil sekali). Penerima memakai rahasia ini untuk
   memeriksa tanda tangan di setiap kiriman (header tanda tangan HMAC-SHA256; rinciannya di
   `/api/docs`).

Pengelolaan:

- **Kirim kejadian tes** untuk mencoba; hasilnya tampil di **Riwayat** dalam beberapa detik.
- **Riwayat pengiriman**: status Berhasil/Gagal/Menunggu, alasan gagal dalam bahasa Indonesia
  (mis. "waktu habis (10 detik)", "alamat harus https"), potongan respons penerima, dan tombol
  **Kirim ulang**. Isi kiriman disimpan 7 hari.
- Kiriman gagal dicoba ulang otomatis sampai 6 kali (30 detik sampai 2 jam). Setelah **20 kali
  gagal beruntun**, webhook **dinonaktifkan otomatis** dan semua Owner menerima email. Perbaiki
  penerimanya, lalu tekan **Aktifkan**.
- **Buat rahasia baru**: rahasia lama tetap ikut ditandatangani 24 jam supaya penerima sempat
  diperbarui. Centang **Cabut rahasia lama sekarang** bila rahasia lama bocor.

## 7.4 Mode kompatibel MobiChat

Untuk tim yang pindah dari MobiChat dan punya alur n8n lama. Tujuannya: alur cukup diganti
**alamat dasar** dan **API key**, tanpa ditulis ulang.

1. **Buat API key** khusus alur ini (7.2) dengan izin **Kirim pesan** dan **Tangani
   percakapan** (tambah **Ubah kontak** bila alur mengganti nama atau tag kontak), batasi ke IP
   server n8n.
2. **Tambah webhook** dengan **Format: MobiChat**. Mode ini hanya mengirim pesan masuk dari
   pelanggan.
   - **API key untuk alur n8n**: tempel API key utuh dari langkah 1. Key ini disisipkan ke
     setiap kiriman seperti perilaku MobiChat.
   - **Alamat aplikasi ini untuk n8n** (opsional): kosongkan untuk memakai alamat aplikasi.
     Untuk n8n di LAN tanpa DNS, pakai IP.
3. Di n8n, ganti alamat dasar MobiChat dengan alamat Balesin Anda, dan header `X-API-Key`
   dengan API key baru.

Endpoint yang didukung: riwayat pesan, kirim pesan (teks, media dari URL, tombol, daftar),
status percakapan, lepas/tugaskan agen, catatan percakapan, ganti nama kontak, tambah tag,
serta Bot API lama (`/api/bot/reply`). Daftar lengkapnya ada di dokumentasi API.

> **Risiko yang perlu diketahui**: dalam format MobiChat, API key ikut terkirim di isi webhook.
> Siapa pun yang bisa membaca riwayat eksekusi n8n bisa melihatnya. Karena itu gunakan key
> khusus dengan izin minimum, batas harian, dan pembatasan IP. Bila alamat memakai `http://`,
> key dikirim tanpa enkripsi; pakai hanya di jaringan lokal tepercaya.

## 7.5 Tips keamanan integrasi

- Satu integrasi = satu API key. Beri nama yang jelas.
- Selalu isi **Batasi alamat IP** bila alamat server integrasi tetap.
- Pakai masa berlaku untuk key uji coba.
- Periksa tanda tangan webhook di penerima dan tolak kiriman yang lebih tua dari 5 menit.
- Bila key atau rahasia bocor: **Cabut** key, **Buat rahasia baru** dengan **Cabut rahasia lama
  sekarang**, lalu periksa **Audit log**.
