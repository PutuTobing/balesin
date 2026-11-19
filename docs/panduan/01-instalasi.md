# 1. Instalasi

Bagian ini untuk admin server. Hasil akhirnya: Balesin berjalan di server Anda, bisa dibuka
lewat `https://` di domain perusahaan, dan akun Owner pertama sudah dibuat.

Perkiraan waktu: 30–60 menit, termasuk menyiapkan domain.

## 1.1 Persyaratan server

| Kebutuhan | Minimum | Disarankan |
|---|---|---|
| Sistem operasi | Ubuntu 24.04 LTS atau Debian (x86_64 / arm64) | Ubuntu 24.04 LTS |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 8 GB |
| Disk | 20 GB | 80 GB (media chat ikut tersimpan di sini) |
| Perangkat lunak | Docker Engine + Docker Compose ≥ 2.24, `openssl`, `curl` | Installer menawarkan memasang Docker bila belum ada |

Siapkan juga:

1. **Domain atau subdomain** khusus, misalnya `cs.contoh.co.id`.
2. **Akses root** (`sudo`) ke server.
3. Salah satu dari tiga cara jaringan di bawah (lihat 1.3).

> Meta hanya mau mengirim pesan pelanggan ke alamat `https://` yang bisa dijangkau dari
> internet. Tanpa domain ber-HTTPS, channel WhatsApp, Telegram, dan Messenger tidak bisa
> menerima pesan.

## 1.2 Menjalankan installer

Tim Balesin memberi Anda **alamat rilis** (tempat berkas `install.sh` berada). Jalankan di
server:

```bash
curl -fsSL https://<alamat-rilis>/install.sh | sudo bash
```

Installer berbahasa Indonesia dan berjalan dalam 8 langkah:

1. Memeriksa persyaratan server.
2. Menyiapkan folder `/opt/balesin`.
3. Menanyakan **mode jaringan** (A, B, atau C).
4. Membuat semua rahasia secara acak (kunci enkripsi, password database, token setup,
   passphrase backup). Anda tidak perlu mengarang password apa pun.
5. Mengunduh berkas rilis dan memeriksa keasliannya (checksum, dan tanda tangan bila tersedia).
6. Menarik image aplikasi.
7. Menyalakan layanan (database diperbarui otomatis).
8. Memasang **backup harian otomatis pukul 02.30**, lalu menampilkan **alamat wizard setup
   dan token setup**.

Catat alamat wizard dan token setup yang tampil di akhir. Kalau terlewat, tampilkan lagi
dengan:

```bash
sudo balesin setup-token
```

**Menjalankan ulang installer aman.** Rahasia yang sudah ada tidak diganti dan versi tidak
naik. Untuk naik versi pakai `sudo balesin update` (lihat [Pemeliharaan](08-pemeliharaan.md)).

## 1.3 Memilih mode jaringan

| Mode | Cocok bila | Yang ditanyakan installer |
|---|---|---|
| **A — Di belakang reverse proxy** | Perusahaan sudah punya server nginx (atau proxy lain) yang memegang HTTPS, dan server Balesin hanya punya IP privat | Domain, IP privat reverse proxy, IP server Balesin, port (bawaan 8080) |
| **B — Caddy bawaan** | Server Balesin punya IP publik sendiri | Domain, email untuk Let's Encrypt (opsional) |
| **C — Cloudflare Tunnel** | Domain dikelola di Cloudflare dan Anda tidak mau membuka port apa pun | Domain, token tunnel Cloudflare |

### Mode A — reverse proxy yang sudah ada

1. Jalankan installer, pilih **A**, isi domain, IP privat reverse proxy, IP server Balesin,
   dan port.
2. Di server reverse proxy, pasang contoh konfigurasi nginx yang ikut di rilis
   (`balesin-nginx.conf`). Ganti nama domain dan alamat `IP-server-Balesin:8080` sesuai
   milik Anda.
3. Buat sertifikat HTTPS (misalnya dengan certbot), lalu muat ulang nginx.
4. **Batasi port 8080** supaya hanya reverse proxy yang bisa membukanya. Perhatian: aturan
   `ufw` biasa **tidak berlaku** untuk port container Docker. Ikuti contoh skrip firewall
   `DOCKER-USER` di [panduan operasional deploy](../DEPLOY.md) §3.1, atau pakai firewall di depan VM.
5. Periksa: dari komputer lain di jaringan yang sama (bukan reverse proxy), membuka
   `http://<IP-server>:8080/health` harus **gagal / timeout**.

Jangan menambahkan header keamanan (CSP dan sejenisnya) di nginx Anda; Balesin sudah
memasangnya sendiri.

### Mode B — Caddy bawaan

1. Buat **A record** DNS: domain Anda → IP publik server.
2. Buka port **80** dan **443** di firewall.
3. Jalankan installer, pilih **B**. Sertifikat HTTPS dibuat otomatis saat domain pertama kali
   dibuka.

### Mode C — Cloudflare Tunnel

1. Di Cloudflare Zero Trust → **Networks → Tunnels**, buat tunnel jenis Cloudflared, salin
   tokennya.
2. Jalankan installer, pilih **C**, tempel token.
3. Di tunnel tersebut tambahkan **Public Hostname**: domain Anda → Service `HTTP` →
   `web:8080`.
4. Biarkan pengaturan HSTS di dasbor Cloudflare mati (Balesin sudah memasangnya).

Salah pilih mode atau IP proxy berubah? Jalankan:

```bash
sudo bash install.sh --ubah-jaringan
```

## 1.4 Memeriksa hasil instalasi

```bash
sudo balesin status
```

Semua layanan harus sehat. Dari luar, `https://cs.contoh.co.id/ready` harus menjawab
`{"status":"ok", …}`.

## 1.5 Wizard setup Owner

Buka `https://cs.contoh.co.id/setup` di browser. Wizard punya 6 langkah:

| Langkah | Isi | Wajib? |
|---|---|---|
| **Token setup** | Tempel token dari installer (`sudo balesin setup-token`). Salin persis, termasuk huruf besar-kecil. Bila Anda membuka tautan dari installer, token sudah terisi. | Wajib |
| **Organisasi** | Nama perusahaan (mis. "PT Contoh") dan zona waktu (WIB, WITA, WIT, dll.). Zona waktu dipakai untuk jam kerja, laporan, dan waktu di chat. | Wajib |
| **Akun Owner** | Nama lengkap, email, password (minimal 10 karakter) dua kali. | Wajib |
| **Tampilan** | Nama aplikasi (kosongkan untuk memakai nama bawaan) dan logo (PNG, JPG, atau WebP, maks. 256 KB). | Opsional, bisa **Lewati** |
| **Email pengirim** | Server SMTP untuk mengirim undangan dan tautan atur ulang password. Lihat [Pengaturan awal](02-pengaturan-awal.md#22-email-pengirim). | Opsional, bisa **Lewati** |
| **Ringkasan** | Periksa semua isian, tekan **Ubah** bila ada yang salah, lalu **Selesai dan masuk**. | – |

Setelah **Selesai dan masuk**, Anda langsung diminta mengaktifkan **verifikasi dua langkah**
untuk akun Owner:

1. Pasang aplikasi autentikator di ponsel (Google Authenticator, Microsoft Authenticator,
   Aegis, 1Password, dan sejenisnya).
2. Pindai kode QR yang tampil, atau ketik kodenya secara manual.
3. Masukkan 6 digit kode dari aplikasi.
4. **Simpan kode cadangan** yang tampil di tempat aman (password manager atau kertas di brankas).
   Kode cadangan dipakai bila ponsel hilang.

Setelah itu Anda masuk ke Inbox. Wizard setup tidak bisa dibuka lagi; anggota tim berikutnya
masuk lewat **undangan email**, bukan pendaftaran bebas.

> **Pesan "Setup belum bisa dimulai"** berarti server belum punya token setup. Ini hanya
> terjadi bila `.env` disunting manual. Jalankan ulang installer, atau hubungi tim Balesin.

## 1.6 Setelah instalasi

1. **Simpan salinan berkas `/opt/balesin/.env`** di tempat aman terpisah (password
   manager). Tanpa berkas ini, kredensial tersimpan dan backup **tidak bisa dibuka** bila
   server rusak.
2. Atur penyalinan folder `/opt/balesin/backups/` ke luar server (NAS atau penyimpanan lain).
3. Lanjutkan ke [Pengaturan awal](02-pengaturan-awal.md) dan
   [Menghubungkan channel](03-menghubungkan-channel.md).
