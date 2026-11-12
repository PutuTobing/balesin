# Teks Wizard: Hubungkan WhatsApp (mode manual)

Dipakai `frontend` sebagai isi wizard di Pengaturan → Channel → WhatsApp. Tiap langkah
punya ilustrasi/screenshot dan tombol "Salin". Balesin menampilkan nilai yang sudah
dibuat otomatis (URL webhook & verify token).

1. **Siapkan Meta Business** — Masuk ke business.facebook.com dengan akun yang menjadi
   admin portofolio bisnis perusahaan. Disarankan sudah **verifikasi bisnis**
   (Pengaturan Bisnis → Pusat Keamanan).
2. **Buat aplikasi Meta** — developers.facebook.com → Aplikasi Saya → Buat Aplikasi →
   tipe *Business* → hubungkan ke portofolio bisnis → tambahkan produk **WhatsApp**.
3. **Pilih nomor** — Untuk uji coba pakai **nomor tes** dari Meta. Untuk produksi tambah
   nomor sendiri (nomor tidak boleh aktif di aplikasi WhatsApp biasa) dan verifikasi OTP;
   atur PIN two-step verification.
4. **Salin ID** — di WhatsApp → Konfigurasi API, salin **Phone Number ID** dan
   **WhatsApp Business Account ID** ke kolom Balesin.
5. **Buat token permanen** — Pengaturan Bisnis → Pengguna → **Pengguna Sistem** → Tambah
   (peran Admin) → Tetapkan aset: aplikasi + akun WhatsApp (kontrol penuh) → Buat token
   dengan izin `whatsapp_business_messaging` dan `whatsapp_business_management`, masa
   berlaku *Tidak pernah*. Tempel ke Balesin. (Token disimpan terenkripsi.)
6. **App Secret** — Aplikasi → Pengaturan → Dasar → *App Secret* → tempel ke Balesin
   (untuk memverifikasi webhook).
7. **Pasang webhook** — WhatsApp → Konfigurasi → Webhook → Edit → tempel **URL webhook**
   dan **Verify token** dari Balesin → Verifikasi → langganan field `messages`
   (dan `message_template_status_update`, `account_update`).
8. **Tes** — klik "Tes koneksi" di Balesin, lalu kirim pesan dari HP ke nomor tersebut.
   Pesan harus muncul di Inbox.
9. **Metode pembayaran** — tambahkan di WhatsApp Manager agar bisa mengirim template/
   melewati kuota gratis.

Pesan error yang wajib ditangani dengan bahasa jelas: token salah/kedaluwarsa, izin kurang,
Phone Number ID tidak cocok dengan WABA, webhook gagal verifikasi, nomor belum terdaftar.
