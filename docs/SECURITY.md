# Standar Keamanan — Balesin

Dipakai agent `security` sebagai checklist. Temuan Tinggi/Kritis = tugas belum selesai.

## 1. Autentikasi
- Password: **argon2id**, minimal 10 karakter, cek terhadap daftar password umum.
- Sesi: cookie `HttpOnly; Secure; SameSite=Lax`, ID sesi acak 256-bit disimpan ter-hash
  di DB; rotasi saat login & ganti peran; kedaluwarsa idle 12 jam, absolut 30 hari.
- **CSRF**: token double-submit untuk semua request yang mengubah data dari browser.
- **2FA TOTP** wajib untuk Owner/Admin/Supervisor; kode cadangan sekali pakai (ter-hash).
- Rate limit login per IP & per akun; kunci 15 menit setelah 5 gagal; notifikasi email.
- **Undangan**: token acak, disimpan ter-hash, sekali pakai, 72 jam, terikat ke email.
- **Reset password**: token ter-hash, sekali pakai, 30 menit; respons sama untuk email
  terdaftar/tidak (cegah enumerasi); semua sesi lain dicabut setelah reset.
- Tidak ada pendaftaran publik. Wizard setup Owner hanya bisa jalan sekali (terkunci
  setelah Owner dibuat) dan sebaiknya memakai token setup dari installer.

## 2. Otorisasi
- RBAC sesuai matriks di `PRD.md` §4, **dicek di server** di setiap endpoint (bukan cuma
  disembunyikan di UI). Tes otomatis untuk setiap peran × endpoint sensitif.
- Semua query difilter `organization_id`.
- Teknisi hanya bisa membaca/membalas percakapan yang di-assign atau terkait tiketnya.

## 3. Rahasia
- Token Meta, App Secret, password SMTP/IMAP, token Telegram: dienkripsi **AES-256-GCM**
  dengan master key dari env (`BALESIN_MASTER_KEY`), tidak pernah dikirim ke frontend
  (UI hanya menampilkan 4 karakter terakhir).
- Tidak ada rahasia di log, pesan error, atau repo. `.env` di `.gitignore`.
- API key: format `blsn_<prefix>_<secret>`, simpan hash saja, bisa dicabut, punya scope
  & tanggal kedaluwarsa opsional, catat terakhir dipakai.

## 4. Webhook masuk (Meta & lainnya)
- Verifikasi `X-Hub-Signature-256` (HMAC-SHA256 dengan App Secret) pada **raw body**,
  perbandingan waktu-konstan. Tolak tanpa signature.
- `hub.verify_token` acak per channel.
- Idempotensi via ID pesan/event; abaikan duplikat.
- Batas ukuran body; balas cepat, proses di worker.
- Anjurkan pengguna mengaktifkan "Require App Secret Proof" di app Meta.

## 5. Penyalahgunaan pengiriman (melindungi nomor & saldo Meta)
- Izin per peran (CS tidak bisa broadcast).
- Broadcast > ambang (default 50) wajib disetujui Admin/Owner.
- Batas harian pesan keluar per pengguna & per organisasi (bisa diatur).
- **Rem darurat**: jika pesan keluar per menit > N× rata-rata 7 hari atau > batas mutlak,
  hentikan antrian kirim otomatis, kirim alarm (Telegram/email), butuh Admin untuk lanjut.
- Semua pesan keluar tercatat (pengirim, waktu, tujuan, isi/ template).
- API key untuk bot bisa dibatasi: hanya balas percakapan yang sudah ada (tidak bisa
  memulai percakapan ke nomor baru / broadcast).

## 6. Webhook keluar & SSRF
- Ditandatangani `X-Balesin-Signature: t=<unix>,v1=<hmac>`; retry dengan backoff.
- URL tujuan divalidasi; IP privat/loopback/link-local **diblokir kecuali** masuk daftar
  allowlist yang diatur Admin (dibutuhkan untuk n8n di LAN Sky Tech).
- Konektor sumber data broadcast mengikuti aturan yang sama.

## 7. Upload & media
- Validasi tipe dengan sniffing isi, bukan ekstensi; batas ukuran sesuai batas Meta.
- File disajikan dengan `Content-Disposition` aman dan header `X-Content-Type-Options`;
  SVG upload tidak dirender inline.
- Nama file disanitasi; disimpan dengan nama acak.

## 8. Web
- Header: CSP ketat (tanpa inline script), HSTS, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
- Escape semua konten pesan (pesan pelanggan = input tidak tepercaya). Render link
  dengan `rel="noopener noreferrer"`.
- Validasi semua input dengan Zod di server.
- CORS hanya untuk origin aplikasi sendiri.

## 9. Infrastruktur
- VM Balesin tanpa IP publik; hanya proxy (vm-nginx) yang boleh menjangkau port aplikasi.
- Postgres & Redis tidak terekspos ke luar jaringan Docker; Redis dengan password.
- Container berjalan non-root, filesystem read-only bila memungkinkan.
- Backup DB harian terenkripsi + uji restore; retensi 14 hari.
- Update OS & image rutin; `pnpm audit` / Dependabot di CI; kunci versi dependency.
- Rekomendasi untuk Sky Tech (di luar repo): Proxmox, Zabbix, GenieACS UI, dan panel admin
  lain tidak dibuka ke internet tanpa lapisan akses tambahan (VPN/allowlist).

## 10. Privasi data
- Data pelanggan (nomor, isi chat, foto KTP, bukti transfer) adalah data pribadi
  (UU PDP). Akses dibatasi peran, tercatat di audit log, bisa diekspor/dihapus per
  kontak, retensi media dapat diatur.

## 11. Proses review `security`
Setiap tugas: baca diff → cek checklist relevan → jalankan `pnpm audit` & tes otorisasi →
tulis temuan ke `docs/security-reviews/<tanggal>-<tugas>.md` dengan level
(Kritis/Tinggi/Sedang/Rendah) + saran perbaikan.
