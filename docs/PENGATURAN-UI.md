# Aturan: Semua Konfigurasi Lewat UI (tanpa sentuh kode)

Ditetapkan Tobing, 13 Nov 2026. **Wajib** untuk semua fase.

## Prinsip
- Semua koneksi (email, WhatsApp, Telegram, Facebook/Instagram, n8n, billing, alarm) diisi
  oleh pengguna **di menu aplikasi**, bukan di kode atau `.env`.
- `.env` hanya untuk hal infrastruktur yang dibuat otomatis oleh installer: URL aplikasi,
  database, Redis, `BALESIN_MASTER_KEY`, `SESSION_SECRET`, `SETUP_TOKEN`. Nilai `SMTP_*` di
  `.env.example` hanyalah **cadangan opsional**; sumber utama = pengaturan di UI (DB).
- Semua rahasia yang diisi lewat UI disimpan terenkripsi (lihat `SECURITY.md` §3), ditampilkan
  tersamar (••••1234), bisa diganti, tidak pernah dikirim balik ke browser.
- Setiap form koneksi punya: **panduan langkah demi langkah** (teks + gambar), **tombol
  "Tes koneksi"** dengan pesan hasil yang jelas dalam bahasa Indonesia, status
  (Terhubung / Gagal / Belum diatur) dan waktu tes terakhir.
- Perubahan pengaturan tercatat di audit log. Hanya Owner/Admin yang bisa mengubah.

## 1. Email pengirim sistem (undangan, reset password, notifikasi)
Lokasi: **Wizard setup langkah "Email"** dan **Pengaturan → Email pengirim**.
Field:
- Nama pengirim (mis. "Balesin Sky Tech"), Alamat email pengirim, Alamat balas-ke (opsional)
- Host SMTP, Port, Keamanan: **SSL/TLS (465) · STARTTLS (587) · Tanpa enkripsi (25)**
- Username (default = alamat email), Password / **App password**
- **Preset** satu klik yang mengisi host/port/keamanan: cPanel/IDCloudHost
  (`mail.<domain>`, 465 SSL), Gmail/Google Workspace (`smtp.gmail.com`, 587, wajib app
  password), Outlook/Microsoft 365 (`smtp.office365.com`, 587), Lainnya.
- **Deteksi otomatis**: setelah alamat email diisi, sarankan host dari domain (coba
  `mail.<domain>` dan `smtp.<domain>`).
- Tombol **"Kirim email tes"** ke alamat yang diisi admin.
- Template email (undangan, reset password, verifikasi) bisa dipratinjau; memakai logo &
  warna organisasi.

## 2. Email sebagai channel inbox (pesan masuk dari pelanggan)
Lokasi: **Pengaturan → Channel → Email**.
- Masuk: protokol **IMAP (disarankan) atau POP3**, host, port, keamanan (SSL/TLS/STARTTLS),
  username, password, folder (default INBOX), interval cek (mis. tiap 1 menit), opsi
  "tandai sudah dibaca" / "hapus dari server" (POP3).
- Keluar: SMTP (boleh "sama dengan email pengirim sistem" atau akun terpisah).
- Preset & deteksi otomatis sama seperti §1; tombol tes masuk & tes keluar.

## 3. WhatsApp (Meta Cloud API)
Lokasi: **Pengaturan → Channel → WhatsApp → Tambah nomor** (wizard, teks di `SETUP-META.md`).
- Field: nama channel, Phone Number ID, WhatsApp Business Account ID, token System User,
  App Secret. **URL webhook & verify token dibuat Balesin** dan ditampilkan dengan tombol
  "Salin".
- Tombol **"Tes koneksi"**: ambil profil nomor & status dari Graph API; tampilkan nama
  tampilan, kualitas, batas pesan.
- Setelah tersambung: sinkron template otomatis, tampil status webhook terakhir diterima.
- Halaman nomor: kualitas, status, edit profil bisnis (deskripsi, alamat, email, website,
  foto) langsung dari UI.

## 4. Lainnya (pola yang sama)
- **Telegram Bot** (channel & alarm): token bot, chat ID grup; tombol "Kirim pesan tes".
- **Bot eksternal / n8n**: Webhook URL, API key dibuat Balesin (salin/regenerasi), tombol
  "Kirim event tes".
- **Konektor billing** (sumber broadcast/data pelanggan): base URL, metode auth, pemetaan
  field; tombol "Tes ambil data".
- **Webhook keluar & allowlist IP privat**: semua dari Pengaturan → Integrasi.
- **Alarm**: ambang biaya pesan, ambang lonjakan kirim, tujuan alarm (Telegram/email).

## Definition of Done tambahan
Fitur integrasi belum selesai bila pengguna masih harus mengedit file atau kode untuk
memakainya. `qa-tester` wajib menguji alur pengisian lewat UI dari nol (E2E), termasuk
pesan error untuk input salah (host salah, port salah, password salah, token kedaluwarsa).
