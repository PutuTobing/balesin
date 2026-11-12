# PRD — Balesin

Versi 1.0 · 13 November 2026 · Pemilik: Tobing

## 1. Ringkasan

Balesin adalah inbox CS bersama untuk tim: satu nomor WhatsApp resmi perusahaan dipakai
banyak orang (CS, supervisor, teknisi) sekaligus, dengan bot AI (lewat n8n), broadcast
template, CRM ringan, dan laporan. Pengganti MobiChat untuk Sky Tech, lalu dijual
self-hosted ke perusahaan lain.

**Masalah yang diselesaikan**
- WhatsApp biasa maksimal 4 perangkat tertaut dan nomor CS sering kena banned.
- Langganan platform pihak ketiga mahal dan datanya di luar kendali sendiri.
- Pelanggan bingung dengan banyak nomor (CS, teknisi). Balesin: **satu nomor resmi**,
  semua tim (termasuk teknisi) membalas dari nomor yang sama.

**Pengguna:** Owner, Admin, Supervisor, CS, Teknisi (lihat §4).

**Prinsip produk**
1. Tim Sky Tech sudah terbiasa dengan MobiChat → alur kerja inti dibuat **akrab**
   (tab inbox, panel detail kontak, label status), tapi desain & nama sendiri.
2. Cepat dipakai di HP (teknisi di lapangan) maupun desktop (CS di kantor).
3. Aman secara default (lihat `SECURITY.md`).
4. White-label: nama, logo, warna perusahaan pemakai.

## 2. Prioritas

- **WAJIB** = harus ada sebelum Sky Tech pindah dari MobiChat.
- **PENTING** = rilis berikutnya.
- **NANTI** = setelah produk stabil.

## 3. Fitur

### 3.1 Setup & akun
| Fitur | Prioritas |
|---|---|
| Wizard pertama kali: buat akun **Owner**, nama perusahaan, logo, warna, zona waktu (default Asia/Jakarta), SMTP pengirim | WAJIB |
| Login email + password, **2FA TOTP** (wajib untuk Owner/Admin/Supervisor) | WAJIB |
| **Undang anggota via email** (link sekali pakai, berlaku 72 jam) | WAJIB |
| Verifikasi email, **reset password via email** (link berlaku 30 menit) | WAJIB |
| Kelola sesi aktif (lihat & keluarkan perangkat), kunci akun sementara saat brute force | WAJIB |
| Profil pengguna: nama, foto, status (Online / Istirahat / Offline) | WAJIB |
| Audit log (siapa melakukan apa, kapan, dari IP mana) | WAJIB |

### 3.2 Channel (Integrasi)
| Fitur | Prioritas |
|---|---|
| **WhatsApp Cloud API — wizard manual** (Phone Number ID, WABA ID, token System User, App Secret; URL webhook & verify token dibuat Balesin, tinggal salin). Tes koneksi otomatis. | WAJIB |
| Beberapa nomor WhatsApp per instalasi (mis. CS utama, CS kedua) | PENTING |
| Telegram Bot | PENTING |
| Email (IMAP masuk + SMTP keluar) sebagai channel inbox | PENTING |
| Facebook Messenger & Instagram DM (Meta app sama, perlu App Review) | NANTI |
| **Embedded Signup (pop-up Meta) + Coexistence QR** — butuh Sky Tech jadi Meta Tech Provider | NANTI |
| Halaman Integrasi bergaya kartu: status Terhubung / Belum dikonfigurasi / Segera hadir | WAJIB |

### 3.3 Inbox (inti)
Diturunkan dari kebiasaan tim di MobiChat (lihat `docs/reference/mobichat/`).
| Fitur | Prioritas |
|---|---|
| Daftar percakapan dengan tab: **Semua · Bot · Belum dilayani · Dilayani · Selesai** | WAJIB |
| Pencarian percakapan/kontak, filter (channel, agen, tag, status) | WAJIB |
| Real-time (WebSocket): pesan baru, status terkirim/dibaca, siapa sedang mengetik/membuka | WAJIB |
| Penanda & **hitung mundur jendela 24 jam** WhatsApp; di luar jendela hanya bisa kirim template | WAJIB |
| Kirim/terima: teks, gambar, dokumen, **voice note/audio**, video, lokasi, stiker, reaksi, balas-kutip | WAJIB |
| Rekam voice note dari browser/HP | PENTING |
| Assign ke agen, ambil alih ("Ambil chat"), alihkan, **antrian terbuka** | WAJIB |
| Tandai Selesai / Buka lagi | WAJIB |
| Panel detail: info kontak, agen utama, peserta, **tag**, catatan sesi, media & file, pesan ditandai, log | WAJIB |
| Quick reply / template percakapan dengan `/` shortcut | WAJIB |
| Catatan internal (tidak terkirim ke pelanggan), mention rekan `@nama` | PENTING |
| Penanda pesan dari bot vs manusia vs broadcast | WAJIB |
| Notifikasi browser/PWA + suara | WAJIB |
| SLA: waktu respons pertama, peringatan chat menunggu terlalu lama | PENTING |
| Panggilan suara WhatsApp (Calling API) | NANTI |

### 3.4 Bot & otomasi
| Fitur | Prioritas |
|---|---|
| **Bot eksternal (n8n)** — mode kompatibel MobiChat agar workflow ULAN tinggal ganti URL (lihat `API-N8N.md`) | WAJIB |
| Aturan handoff: bot berhenti saat agen mengambil alih / bot minta handoff | WAJIB |
| Saklar bot per channel & per percakapan | WAJIB |
| Pesan otomatis: sapaan, di luar jam kerja (jam kerja per hari) | PENTING |
| Aturan otomasi sederhana (jika tag X → assign ke tim Y) | PENTING |
| Builder alur visual (pengganti "Flow"/WhatsApp Flow) | NANTI |
| AI agent bawaan dengan knowledge base | NANTI (Sky Tech pakai n8n) |

### 3.5 Template & broadcast
| Fitur | Prioritas |
|---|---|
| Sinkron template dari Meta, buat/ajukan template baru (Marketing/Utility/Authentication) dengan variabel `{{1}}` atau bernama | WAJIB |
| **Broadcast dengan variabel per penerima** (nama, ID pelanggan, nominal, jatuh tempo, link) | WAJIB |
| Sumber penerima: upload **Excel/CSV**, segmen kontak/tag, **tarik dari API billing** (SKY BILL dsb. lewat konektor) | WAJIB |
| Pemetaan kolom → variabel template, **pratinjau per penerima** | WAJIB |
| **Estimasi biaya** sebelum kirim (jumlah × tarif kategori) | WAJIB |
| Jadwal kirim, kecepatan kirim (throttle), batal/jeda | WAJIB |
| Persetujuan Admin untuk broadcast > ambang (default 50 penerima) | WAJIB |
| Laporan per kampanye: terkirim, dibaca, gagal + alasan, balasan | WAJIB |
| Cegah kirim dobel (penerima yang sama, template sama, dalam N jam) | WAJIB |
| Tampilan tabel & kanban kampanye | PENTING |

### 3.6 CRM
| Fitur | Prioritas |
|---|---|
| Kontak: nama (format bebas, mis. `ID+NAMA@AREA`), nomor, email, tag, atribut kustom, riwayat | WAJIB |
| Impor/ekspor kontak CSV/Excel | WAJIB |
| Penggabungan kontak duplikat | PENTING |
| **Tugas/Tiket** (mis. tiket perbaikan untuk teknisi): status, penanggung jawab, tenggat, terkait percakapan | PENTING |
| Data pelanggan dari sistem luar (billing) ditampilkan di panel detail lewat konektor | PENTING |

### 3.7 Laporan & biaya
| Fitur | Prioritas |
|---|---|
| Dashboard: percakapan masuk, waktu respons, beban per agen, bot vs manusia | PENTING |
| **Biaya pesan Meta**: jumlah pesan per kategori, sisa 1.000 pesan layanan gratis per nomor per bulan, perkiraan biaya bulan berjalan, ambang peringatan | WAJIB |
| Laporan template & kampanye | PENTING |
| Ekspor CSV | PENTING |

### 3.8 Pengaturan
Peran & akses, Organisasi (branding white-label), Alokasi agen (round-robin / manual),
Jam kerja, Template percakapan, Tag, Channel, API key & webhook, Notifikasi Telegram
untuk alarm sistem, Backup.

### 3.9 Aplikasi mobile
| Fitur | Prioritas |
|---|---|
| **PWA** (bisa di-install ke layar utama Android/iOS, push notification) | WAJIB |
| Aplikasi native Expo untuk Play Store / App Store | NANTI |

### 3.10 Produk self-hosted
| Fitur | Prioritas |
|---|---|
| Installer `curl -fsSL <url> \| bash` (Docker), secret dibuat otomatis | PENTING |
| `balesin update` (backup DB → tarik versi → migrasi), `balesin backup`, `balesin status` | PENTING |
| Mode jaringan: di belakang reverse proxy yang sudah ada / Caddy bawaan + IP publik / Cloudflare Tunnel | PENTING |
| Lisensi (kunci aktivasi) | NANTI |

## 4. Peran & hak akses

| Kemampuan | Owner | Admin | Supervisor | CS | Teknisi |
|---|:-:|:-:|:-:|:-:|:-:|
| Pengaturan organisasi, billing, lisensi | ✅ | – | – | – | – |
| Kelola channel & kredensial Meta | ✅ | ✅ | – | – | – |
| Undang/nonaktifkan pengguna | ✅ | ✅ | – | – | – |
| API key & webhook | ✅ | ✅ | – | – | – |
| Buat broadcast | ✅ | ✅ | ✅ | – | – |
| Setujui broadcast > ambang | ✅ | ✅ | – | – | – |
| Kelola template | ✅ | ✅ | ✅ | – | – |
| Lihat semua percakapan | ✅ | ✅ | ✅ | ✅ | – |
| Balas percakapan | ✅ | ✅ | ✅ | ✅ | hanya yang di-assign / terkait tiketnya |
| Kelola tiket | ✅ | ✅ | ✅ | ✅ | tiket miliknya |
| Lihat laporan | ✅ | ✅ | ✅ | milik sendiri | milik sendiri |
| Audit log | ✅ | ✅ | – | – | – |

Teknisi membalas **dari nomor perusahaan yang sama**; pesan diberi penanda nama
pengirim internal (opsional ditampilkan ke pelanggan sebagai "— Teknisi Arya").

## 5. Bukan cakupan v1
Pembayaran dalam aplikasi, marketplace plugin, multi-tenant SaaS terpusat (model v1 =
satu instalasi per perusahaan).

## 6. Ukuran keberhasilan
- Tim Sky Tech bisa berhenti memakai MobiChat tanpa kehilangan alur kerja.
- Bot ULAN (n8n) jalan di Balesin dengan perubahan workflow minimal.
- Waktu buka inbox < 1,5 detik di HP 4G; 0 temuan keamanan Tinggi/Kritis.
