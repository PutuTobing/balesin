# PRD — Modul Email (Kotak Surat Balesin)

Versi 1.0 · 22 November 2026 · Pemilik: Tobing · Fase roadmap: **9**
Desain acuan: `docs/design/email/mockup.html` (buka di browser; ada tab Kotak surat, Tambah akun, HP,
keadaan Baca/Tulis/Info kontak/Belum ada akun, dan tombol mode gelap). Screenshot terang & gelap:
`docs/design/email/shots/*.png`.

## 1. Ringkasan

Balesin mendapat menu baru **Email**: klien email lengkap ala Outlook di dalam Balesin. Tim bisa
menghubungkan **beberapa akun email sekaligus** (email hosting cPanel/IDCloudHost, Microsoft 365 /
Outlook, Google Workspace / Gmail, atau server IMAP/POP3 lain), lalu **membaca, membalas, menulis,
meneruskan, mengarsipkan, dan mencari email** dari semua akun di satu tempat.

Menu Email **terpisah dari Inbox** (WhatsApp/Telegram/dll.):

| | Inbox (sudah ada) | Email (baru) |
|---|---|---|
| Untuk | Chat pelanggan, cepat, per percakapan | Surat-menyurat: vendor, mitra, kantor pajak, pelanggan korporat, internal |
| Bentuk | Bubble chat | Daftar email + panel baca + editor surat |
| Folder | Tab status (Semua/Bot/Belum dilayani/…) | Folder server (Kotak masuk, Terkirim, Draf, Spam, Sampah, Arsip, folder sendiri) |
| Channel Email lama (Fase 6) | Tetap ada untuk email CS yang ingin diperlakukan seperti chat | — |

Prinsip:
1. **Semua pengaturan lewat UI** (`docs/PENGATURAN-UI.md`): akun ditambah dengan wizard, preset satu
   klik, deteksi otomatis, dan tombol tes. Tidak ada `.env`/kode.
2. **Aman**: kredensial & token OAuth terenkripsi, HTML email diisolasi, gambar jarak jauh diblokir
   bawaan, kirim hanya dari identitas yang sah, semua tercatat di audit log.
3. **Terasa seperti Outlook/Gmail**, tapi memakai design system Balesin (`docs/DESIGN.md`) — bukan
   tiruan tampilan pihak lain.
4. **Terhubung ke Balesin lain**: pengirim dikenali sebagai kontak CRM, email bisa dijadikan tiket,
   lompat ke chat WhatsApp kontak yang sama.

## 2. Pengguna & cerita pengguna

- **Owner/Admin**: "Saya menghubungkan `cs@`, `billing@`, dan akun Outlook kantor, lalu menentukan
  siapa saja yang boleh membaca dan mengirim dari tiap akun."
- **Supervisor/CS**: "Saya membuka menu Email, melihat semua kotak masuk yang boleh saya akses dalam
  satu daftar, membalas email vendor, dan menandai yang sudah beres."
- **Direktur**: "Akun Outlook pribadi saya hanya bisa saya sendiri yang lihat."
- **Teknisi**: tidak punya akses Email (bawaan), kecuali diberi akses ke akun bersama tertentu.

## 3. Prioritas
**WAJIB** = rilis pertama modul Email (9.0–9C, termasuk API 9.1). **PENTING** = rilis berikutnya (9D–9E). **NANTI**.

## 4. Fitur

### 4.1 Akun email (Pengaturan → Akun email, dan tombol "Tambah akun" di menu Email)
| Fitur | Prioritas |
|---|---|
| Wizard **Tambah akun** dengan pilihan penyedia berupa kartu: **Microsoft 365 / Outlook**, **Google Workspace / Gmail**, **cPanel / IDCloudHost**, **IMAP lain**, **POP3** | WAJIB |
| **Deteksi otomatis**: setelah alamat diketik, isi host/port/keamanan dari preset domain yang dikenal, lalu (opsional) autoconfig/ISPDB/SRV `_imaps._tcp`/`_submission._tcp`. Semua lookup lewat penjaga SSRF | WAJIB |
| IMAP (993 SSL/TLS atau 143 STARTTLS) + SMTP (465 SSL/TLS atau 587 STARTTLS), username + password / **sandi aplikasi** | WAJIB |
| POP3 (995 SSL/TLS) + SMTP: hanya folder Kotak masuk, opsi "simpan salinan di server" (bawaan nyala) dan "hapus dari server setelah N hari" | PENTING |
| **OAuth2 Microsoft** (Outlook.com & Microsoft 365) lewat **Microsoft Graph** (`Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`) — tombol "Masuk dengan Microsoft" | PENTING |
| **OAuth2 Google** (Workspace) lewat IMAP/SMTP XOAUTH2 (`https://mail.google.com/`). Gmail pribadi tetap bisa via sandi aplikasi | PENTING |
| Identitas & alias: satu akun bisa punya beberapa alamat "Dari" (alias/send-as), masing-masing nama pengirim + tanda tangan | WAJIB |
| Warna & nama tampilan akun (titik warna di daftar email gabungan) | WAJIB |
| Tes koneksi terpisah **Masuk** dan **Keluar** + pesan error berbahasa Indonesia (host/port salah, sertifikat, password/sandi aplikasi, IMAP belum diaktifkan, SMTP AUTH dimatikan di Microsoft 365, kotak penuh) | WAJIB |
| Status sinkron per akun: terakhir sinkron, error terakhir, jumlah email, ukuran; tombol "Sinkron sekarang", "Jeda", "Putuskan" | WAJIB |
| **Jenis akun**: *Pribadi* (hanya pemilik) atau *Bersama* (pengguna/departemen yang ditunjuk). Hak per orang: **Baca**, **Baca & kirim**, **Kelola** | WAJIB |
| Batas: satu alamat tidak boleh sekaligus menjadi Channel Email Inbox (Fase 6) dan akun Email — pesan jelas + tautan ke channel tersebut (v1; penyatuan = NANTI) | WAJIB |

### 4.2 Sinkronisasi (worker)
| Fitur | Prioritas |
|---|---|
| Daftar folder dari server, termasuk folder khusus (RFC 6154 `\Inbox \Sent \Drafts \Junk \Trash \Archive`) dipetakan ke nama Indonesia; folder sendiri tampil apa adanya | WAJIB |
| **IMAP IDLE** untuk Kotak masuk (email baru muncul < 10 dtk) + sinkron berkala folder lain (bawaan 5 mnt); Microsoft Graph: delta query + (opsional) langganan webhook | WAJIB |
| Sinkron awal: header **90 hari terakhir** (bisa diatur 30/90/365/semua) + isi diunduh saat dibuka/di latar belakang; email lebih lama diambil saat di-scroll/dicari | WAJIB |
| Aksi dua arah: baca/belum dibaca, bintang/flag, pindah folder, arsip, hapus (ke Sampah), spam — tercermin di server & aplikasi email lain | WAJIB |
| Ketahanan: `UIDVALIDITY` berubah → sinkron ulang folder, jeda bertambah saat gagal (maks. 1 jam), batas koneksi per akun, satu proses IDLE per akun | WAJIB |
| Ruang simpan: lampiran disimpan saat dibuka/diunduh (bukan semua di awal); retensi cache bisa diatur | WAJIB |

### 4.3 Daftar & baca email (menu Email)
| Fitur | Prioritas |
|---|---|
| Kolom kiri: **Semua kotak masuk** (gabungan), **Belum dibaca**, **Berbintang**, lalu per akun: folder + jumlah belum dibaca; bisa dilipat | WAJIB |
| Daftar email: avatar/inisial pengirim, nama, subjek, cuplikan, waktu relatif, ikon lampiran, bintang, titik warna akun (di tampilan gabungan), tebal = belum dibaca | WAJIB |
| Tab cepat: **Prioritas · Lainnya · Untuk saya** (lihat §4.7); Belum dibaca, Belum dibalas, Berlampiran ada di panel Saring (§4.5) | PENTING |
| **Asal email selalu terlihat**: titik warna + nama akun di daftar gabungan; chip **"ke billing@"** bila email masuk lewat alias/alamat lain dari akun itu (header `Delivered-To`/`X-Original-To`/`To`); di panel baca baris "Diterima di **CS Sky Tech** · dikirim ke **billing@skytech.net.id**" | WAJIB |
| Pengelompokan **utas (thread)** berdasarkan `Message-ID/In-Reply-To/References` + subjek (bisa dimatikan per pengguna) | WAJIB |
| Pilih banyak + aksi massal (tandai dibaca, arsip, hapus, pindah, spam) dengan pintasan keyboard (`j/k`, `e` arsip, `#` hapus, `r` balas, `a` balas semua, `f` teruskan, `c` tulis, `/` cari) | WAJIB |
| Panel baca: subjek, pengirim + **lencana verifikasi** (SPF/DKIM/DMARC, pakai verifikasi pengirim Fase 6 / `sender_verification`), Kepada/Cc, waktu, akun penerima | WAJIB |
| Isi HTML dirender di **iframe sandbox** (`sandbox` tanpa `allow-scripts`, CSP ketat), sudah disanitasi server; **gambar jarak jauh diblokir** + bilah "Tampilkan gambar" / "Selalu dari pengirim ini" (diambil lewat proksi server, bukan dari browser) | WAJIB |
| Peringatan: pengirim eksternal yang mirip nama internal, tautan yang teksnya beda dengan tujuannya, lampiran berbahaya (makro, executable) diblokir unduh | WAJIB |
| Lampiran: kartu berkas, pratinjau gambar/PDF, unduh, "Simpan ke kontak/tiket" | WAJIB |
| Aksi: Balas, Balas semua, Teruskan, Arsip, Hapus, Pindah ke, Tandai spam, Tandai belum dibaca, Cetak, Lihat sumber (header mentah) | WAJIB |
| Panel kanan (bisa ditutup): kartu **kontak CRM** pengirim (atau "Tambah ke kontak"), riwayat chat WhatsApp/Telegram singkat, tiket terkait, tombol **Buat tiket** & **Buka chat** | PENTING |

### 4.4 Tulis, balas, teruskan
| Fitur | Prioritas |
|---|---|
| Jendela tulis **mengambang** di kanan bawah (desktop) — bisa diperkecil, diperbesar layar penuh, beberapa draf sekaligus; layar penuh di HP | WAJIB |
| **Dari**: pilih akun/identitas yang boleh dipakai pengguna (hanya yang ia punya hak kirim) | WAJIB |
| Kepada/**Cc**/**Bcc** (tembusan & tembusan tersembunyi) dengan **pelengkap otomatis** dari kontak Balesin + alamat yang pernah dikirimi; validasi alamat; peringatan "penerima di luar domain" bila diatur | WAJIB |
| **Balas semua** mempertahankan Kepada/Cc asli tanpa alamat akun sendiri; Bcc email asli tidak pernah ikut. Bcc tidak muncul di header yang diterima siapa pun, hanya tersimpan di salinan Terkirim pengirim | WAJIB |
| Batas penerima per email (bawaan 50, Kepada+Cc+Bcc, ikut Batas kirim); peringatan bila Bcc > 10 ("gunakan Broadcast untuk kirim massal") | WAJIB |
| Cc/Bcc bawaan per identitas (mis. selalu Bcc ke `arsip@`) | PENTING |
| **Penanda tabrakan**: "Dimas sedang membalas…" di utas yang sama (real-time) + peringatan sebelum kirim bila ada email baru di utas sejak draf dibuka | WAJIB |
| Editor rich text (tebal, miring, garis bawah, daftar, tautan, kutipan, warna terbatas, gambar inline) + mode teks biasa; tempel dari Word dibersihkan | WAJIB |
| Lampiran: seret-lepas, maks. 25 MB total (bisa diatur), peringatan "kamu menulis 'terlampir' tapi belum ada lampiran" | WAJIB |
| **Tanda tangan** per identitas (rich text + logo), otomatis untuk email baru/balasan | WAJIB |
| Template email (variabel kontak `{nama}`, `{id_pelanggan}`) — memakai ulang modul Balasan cepat jenis "email"; panggil dengan `/` di editor | WAJIB |
| Draf tersimpan otomatis (tiap 5 dtk) ke folder Draf server (IMAP `APPEND` / Graph) | WAJIB |
| **Batalkan kirim** (jeda 10 dtk, bisa diatur 5–30) dan **Jadwalkan kirim** | WAJIB / PENTING |
| Salinan terkirim disimpan ke folder Terkirim bila server tidak otomatis (Gmail/Graph otomatis) | WAJIB |
| Header benar: `Message-ID` di domain akun, `In-Reply-To`/`References` saat membalas, kutipan email sebelumnya (bisa dilipat) | WAJIB |

### 4.5 Cari & saring
| Fitur | Prioritas |
|---|---|
| Kotak cari dengan saran; operator: `dari:`, `ke:`, `subjek:`, `ada:lampiran`, `sebelum:`, `sesudah:`, `akun:`, `folder:` | WAJIB |
| Indeks teks lokal (PostgreSQL full-text, bahasa `simple` + indonesia) untuk email yang sudah tersinkron; tombol "Cari juga di server" (IMAP `SEARCH`/Graph `$search`) untuk email lama | WAJIB |
| Panel **Saring** (multi-pilih, bisa digabung): Akun, Alamat tujuan/alias, Label, Belum dibaca, Berlampiran, Berbintang, Dari kontak/pelanggan, **Belum dibalas**, Ditugaskan ke, Status, rentang tanggal | WAJIB |
| **Tampilan tersimpan**: simpan kombinasi saringan (mis. "Tagihan belum dibalas"), disematkan di kolom folder dengan jumlahnya; bisa pribadi atau dibagikan ke tim | PENTING |
| Urutkan: terbaru, terlama, belum dibaca dulu, pengirim; kepadatan **Nyaman/Ringkas**; panel baca kanan/bawah/mati | PENTING |

### 4.6 Notifikasi
Email baru real-time lewat WebSocket, notifikasi PWA/browser per akun (bisa dibisukan per akun/folder),
penghitung belum dibaca di rail & navigasi bawah. **WAJIB**.

### 4.7 Email dalam jumlah banyak (memilah, kerja tim, membalas cepat)
Tujuan: kotak bersama yang menerima ratusan email per hari tetap rapi, tidak ada email yang terlewat,
dan tidak ada pengirim yang dibalas dua kali oleh dua orang.

**Memilah otomatis**
| Fitur | Prioritas |
|---|---|
| **Prioritas / Lainnya**: email otomatis, buletin, dan notifikasi sistem (header `List-Unsubscribe`, `Precedence: bulk/list`, `Auto-Submitted`, pengirim `noreply`) masuk tab **Lainnya**; email dari orang & kontak di **Prioritas**. Bisa dikoreksi per pengirim ("Selalu ke Prioritas") | PENTING |
| **Label berwarna** (palet warna tag yang sama dengan Inbox), satu email bisa banyak label; disinkronkan sebagai keyword IMAP / kategori Graph bila server mendukung | WAJIB |
| **Aturan** per akun, diurutkan, opsi "berhenti di aturan ini". Syarat: dari, ke/Cc, alamat tujuan, subjek, isi, ada lampiran, ukuran, akun. Aksi: beri label, pindah folder, tandai dibaca, bintang, **tugaskan** ke orang/departemen, teruskan ke alamat, buat tiket, jadikan percakapan Inbox CS, kirim webhook n8n, balas dengan template. Tombol **"Uji ke 50 email terakhir"** sebelum disimpan; jalan di worker untuk email baru | PENTING |
| Blokir pengirim/domain (langsung Spam); **Berhenti langganan** 1 klik (`List-Unsubscribe-Post`, RFC 8058) | PENTING |
| **Bersihkan dari pengirim ini**: arsip/hapus semua email pengirim itu sekaligus (konfirmasi + bisa dibatalkan) | PENTING |

**Kerja tim di akun bersama**
| Fitur | Prioritas |
|---|---|
| **Tugaskan** email/utas ke anggota tim atau departemen + **status** Terbuka / Menunggu balasan / Selesai; tab **Untuk saya**; utas yang dibalas pengirim kembali Terbuka | PENTING |
| **Catatan internal** di utas (tidak pernah terkirim ke pengirim) dan @sebut rekan → notifikasi + tab "Disebut" | PENTING |
| **Tunda** (snooze) sampai jam/tanggal tertentu; **pengingat tindak lanjut** bila email terkirim tidak dibalas dalam N hari | PENTING |
| Tanda **belum dibalas > N jam** (bisa diatur per akun, ikut Jam kerja) + ringkasan waktu balasan pertama per akun di Laporan | NANTI |

**Menerima & membalas lebih cepat**
| Fitur | Prioritas |
|---|---|
| **Balasan otomatis** per akun: tanda terima dan/atau di luar jam kerja (pakai Jam kerja yang sudah ada), maks. sekali per pengirim per 24 jam, tidak pernah membalas email otomatis/bulk/bounce (cegah loop), header `Auto-Submitted: auto-replied` | PENTING |
| Ringkasan utas & saran balasan AI (lewat n8n atau AI bawaan Fase 8) | NANTI |

**Tetap cepat walau email banyak**: daftar virtual (hanya baris yang terlihat dirender), halaman
berbasis kursor, jumlah belum dibaca dihitung server, sinkron bertahap per folder, indeks cari di
database. Target: akun dengan 50.000 email tetap membuka daftar < 300 ms dan berganti folder < 500 ms.

### 4.8 API kirim email untuk n8n, billing, dan aplikasi lain (tahap 9.1)
Tujuan: n8n/SKY BILL bisa mengirim **email tagihan, kode VA, QRIS, bukti bayar, atau invoice PDF**
lewat channel/akun email tertentu di Balesin — seperti API WhatsApp yang sudah ada. Bekerja dengan
**Channel Email Fase 6 yang sudah ada** (tidak menunggu menu Email 9A), lalu juga akun Email Fase 9.

| Endpoint (API publik v1, header `Authorization: Bearer blsn_live_…`) | Scope | Isi |
|---|---|---|
| `GET /api/v1/public/email/senders` | `email:send` | Daftar pengirim yang **boleh dipakai key ini**: `{ id, kind: channel\|account, name, address, aliases[] }` |
| `POST /api/v1/public/email/send` | `email:send` | Kirim satu email (lihat contoh) → **202** `{ id, status: "queued" }`. Header `Idempotency-Key` (mis. nomor invoice) mencegah kirim dobel bila n8n mengulang |
| `GET /api/v1/public/email/messages/:id` | `email:read` | Status: `queued` → `sent` / `failed` / `bounced` (+ alasan) |
| `GET /api/v1/public/email/templates` | `email:send` | Daftar template email + variabelnya |
| `POST /api/v1/public/email/messages/:id/reply` | `email:send` | Bot/n8n membalas email masuk di utasnya (dipakai §4.11) |

Contoh dari node HTTP Request n8n (tagihan + VA + QRIS + invoice PDF):
```json
POST /api/v1/public/email/send
Idempotency-Key: INV-2611-0873
{
  "senderId": "chn_billing",
  "to": [{ "email": "budi.santoso@surel.id", "name": "Budi Santoso" }],
  "cc": [], "bcc": [{ "email": "arsip@skytech.net.id" }],
  "templateId": "tagihan-bulanan",
  "variables": { "nama": "Budi", "id_pelanggan": "SKT-00873", "periode": "November 2026",
                 "total": "Rp185.000", "va_bri": "8808 1234 5678 9012", "jatuh_tempo": "25 Nov 2026" },
  "qris": { "payload": "00020101021226…6304ABCD", "cid": "qris" },
  "attachments": [{ "filename": "Invoice-INV-2611-0873.pdf", "url": "https://billing.btd.co.id/…/invoice.pdf" }],
  "conversation": "create",
  "metadata": { "invoice_id": "INV-2611-0873" }
}
```

| Fitur | Prioritas |
|---|---|
| Isi email dari **template Balesin** (`templateId` + `variables`) **atau** dari aplikasi luar (`subject` + `html` + `text`). Variabel di-escape HTML; HTML luar disanitasi (tanpa skrip/form/iframe) | WAJIB |
| **Template email** di Pengaturan → Template email: editor HTML/visual, variabel `{{nama}}`, pratinjau terang/gelap & HP, **kirim tes** ke alamat sendiri, riwayat versi. Preset ISP: Tagihan bulanan, Pengingat jatuh tempo, Kode VA, Pembayaran diterima, Isolir/aktif kembali | WAJIB |
| **QRIS**: kirim teks payload QRIS, Balesin membuat gambar QR (PNG) di server dan menyisipkannya inline (`<img src="cid:qris">`) + opsi lampiran. CRC payload diperiksa dulu; payload rusak → 400, bukan QR yang tidak bisa dibayar | WAJIB |
| Lampiran: `contentBase64`, `mediaId` (unggah dulu), atau `url` yang diambil server (hanya domain di **allowlist key**, mis. `billing.btd.co.id`; penjaga SSRF; maks. 10 berkas / 20 MB) | WAJIB |
| Kepada/Cc/Bcc (maks. 50 total), `replyTo`, alias pengirim yang sah, `scheduledAt` (jadwal kirim) | WAJIB / PENTING |
| `conversation: "create"`: email keluar dicatat sebagai percakapan di Inbox, jadi **balasan pelanggan masuk ke percakapan yang sama** dan bisa dijawab CS | WAJIB |
| Webhook keluar `email.sent`, `email.failed`, `email.bounced` (dari pesan gagal kirim/DSN), `email.replied` — memuat `metadata` dari pengirim supaya n8n tahu invoice mana | WAJIB |
| **Batas**: batas harian per key (yang sudah ada), batas per pengirim per jam (bawaan 100/jam, bisa diatur sesuai batas hosting), antrean + jeda otomatis saat server SMTP menolak, rem darurat ikut berlaku. Kirim massal promosi tetap lewat Broadcast | WAJIB |
| API key bisa **dibatasi ke pengirim tertentu** (key billing hanya boleh `billing@`), plus allowlist IP yang sudah ada | WAJIB |

### 4.9 Tampilan HP
Navigasi bawah menjadi **Inbox · Email · Kontak · Broadcast · Lainnya**. Layar bertumpuk: Folder/akun
(laci) → Daftar → Baca → Tulis (layar penuh). Geser kiri = arsip, geser kanan = tandai dibaca. Tombol
tulis mengambang (FAB) kanan bawah di atas navigasi. **WAJIB**.

### 4.10 Peningkatan Channel Email di Inbox (tahap 9.0 — dikerjakan dulu)
Channel Email Fase 6 (email diperlakukan seperti chat di Inbox) sudah dipakai Sky Tech. Saat ini
balasan hanya ke pengirim, dan alamat tujuan/Cc email masuk tidak disimpan. Tambahan:
| Fitur | Prioritas |
|---|---|
| Simpan & tampilkan **Kepada, Cc, dan alamat tujuan** (`Delivered-To`/`To`) di kepala tiap email masuk | WAJIB |
| Composer channel Email: tombol **Cc / Bcc**; **Balas semua** (isi Cc dari email terakhir, tanpa alamat channel sendiri) | WAJIB |
| Aturan izin: Cc/Bcc ke alamat yang sudah ada di utas = `inbox.reply`; menambah alamat **baru** = memulai percakapan (`inbox.initiate` + jatah harian, sama dengan aturan audit akhir A1); maks. 10 alamat tambahan per balasan; dicatat di audit log | WAJIB |
| Ikon + nama channel di daftar dan saringan **Channel** sudah ada; tambahkan saringan **Alamat tujuan** bila satu channel menerima beberapa alias | PENTING |
| **Akses per channel** (semua jenis channel, termasuk Email A/B): Pengaturan → Channel → [channel] → **Akses**: "Semua tim" (bawaan, perilaku sekarang) atau "Hanya departemen/pengguna tertentu". Pengguna di luar daftar tidak melihat percakapan, hitungan, notifikasi, hasil cari, dan laporan channel itu. Digabung (irisan) dengan cakupan peran & "akses hanya departemen sendiri". Owner/Admin selalu melihat semua | WAJIB |

### 4.11 Bot & AI agent membalas email saat CS tidak siaga
- **Channel Email di Inbox — sudah bisa sekarang**: bot eksternal per channel (n8n/ULAN) sudah
  berlaku untuk Email: Pengaturan → Channel → [Email] → Bot, atur **Jam kerja bot**, dan sebaiknya
  nyalakan "hanya pengirim terverifikasi". Bot menerima webhook, membalas lewat API, dan menyerahkan
  ke tim (`handoff`) bila tidak yakin.
- **Akun di menu Email (Fase 9)** — mode per akun:

| Mode | Perilaku | Prioritas |
|---|---|---|
| Mati | Bawaan | — |
| Balasan otomatis | Tanda terima / di luar jam kerja dari template (§4.7) | PENTING (9D) |
| Bot eksternal (n8n) | Webhook `mail.received` → n8n → `POST …/email/messages/:id/reply` | PENTING (9E) |
| AI agent bawaan | Bersama AI agent Fase 8 | NANTI |

Pagar pengaman untuk bot & AI: bawaan **"Draf saja"** (AI menyiapkan balasan, CS tinggal setujui);
kirim otomatis hanya bila dinyalakan, hanya di luar jam kerja, hanya ke pengirim terverifikasi
(SPF/DKIM/DMARC lolos), tidak membalas email otomatis/bulk/bounce, maks. 2 balasan bot per utas per
24 jam lalu diserahkan ke tim; email yang dibalas bot berlabel **"Dibalas bot"**. Isi email selalu
dianggap data, bukan perintah (anti *prompt injection*); data pelanggan hanya dicari berdasarkan
**alamat pengirim yang terdaftar di kontak**, bukan ID/nomor yang ditulis di isi email, supaya
penipu tidak bisa meminta tagihan orang lain.

### 4.12 Foto profil / logo akun email
| Fitur | Prioritas |
|---|---|
| **Di dalam Balesin**: unggah foto/logo per akun email dan per channel (tampil di kolom folder, daftar, jendela tulis, HP) | WAJIB (9A) |
| Logo di **kepala template email & tanda tangan** (selalu terlihat penerima di semua aplikasi) | WAJIB (9.1/9B) |
| **Asisten foto pengirim** (Pengaturan → Akun email → Foto di kotak masuk penerima): cek SPF/DKIM/DMARC domain, panduan langkah demi langkah per penyedia, ubah logo menjadi SVG Tiny PS persegi, sajikan di `https://<domain-balesin>/bimi/<domain>.svg`, buatkan isi TXT `default._bimi` untuk ditempel di DNS, lalu cek statusnya | PENTING (9E) |

Catatan penting (ditampilkan di asisten): foto di samping nama pengirim **ditentukan penyedia email
penerima, bukan isi email**, jadi Balesin tidak bisa memasangnya langsung.
- **Gmail**: cara gratis = buat akun Google memakai alamat email yang sudah ada (bukan alamat Gmail
  baru), verifikasi, lalu pasang foto; hanya penerima Gmail yang melihatnya. Cara resmi = BIMI.
- **BIMI** (Gmail, Apple Mail, Yahoo): butuh DMARC `p=quarantine`/`p=reject`, logo SVG Tiny PS, dan
  untuk Gmail/Apple **sertifikat berbayar** VMC (butuh merek terdaftar) atau CMC (hanya Gmail; logo
  sudah tampil di situs domain ≥ 12 bulan). Menaikkan DMARC harus bertahap — salah atur membuat email
  sah masuk spam.
- **Outlook/Microsoft 365**: belum mendukung BIMI; tidak ada cara dari sisi pengirim.

## 5. Hak akses (tambahan matriks `permissions.ts`)

| Izin | Owner | Admin | Supervisor | CS | Teknisi |
|---|:-:|:-:|:-:|:-:|:-:|
| `mail.accounts.manage` — tambah/ubah/hapus akun bersama, atur siapa boleh akses | ✅ | ✅ | – | – | – |
| `mail.view` — buka menu Email, **hanya akun yang ia punya hak** | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mail.send` — kirim, **hanya dari akun dengan hak "Baca & kirim"/"Kelola"** | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mail.private.own` — menghubungkan akun **pribadi** miliknya sendiri | ✅ | ✅ | ✅ | ✅ | – |

- Akses nyata ditentukan **per akun** (tabel `mail_account_access`: pengguna/departemen → Baca / Baca &
  kirim / Kelola). Owner & Admin otomatis berhak **Kelola** di semua akun **bersama**.
- Menu Email hanya tampil bila pengguna punya ≥ 1 akun yang bisa diakses atau boleh menghubungkan akun
  pribadi. Teknisi bawaan tidak punya akun apa pun → menu tidak tampil sampai diberi akses.
- Akun **pribadi** tidak bisa dibaca siapa pun selain pemiliknya, **termasuk Owner** (Owner/Admin hanya
  melihat alamat & status, dan bisa memutus akun itu bila pemiliknya keluar dari organisasi).
- **Siapa boleh membuka menu Email** dan **akun mana yang boleh dilihat** diatur dari dua tempat yang
  menampilkan data yang sama: Pengaturan → Akun email → [akun] → **Akses**, dan Pengaturan → Tim →
  [pengguna] → tab **Akses email** (daftar akun + hak, bisa diubah per pengguna). Contoh: pengguna CS
  hanya "Baca & kirim" di CS Sky Tech dan tidak melihat Billing; staf Finance hanya Billing.
- **Channel di Inbox** (WhatsApp/Telegram/Email A/B/…) memakai **Akses per channel** (§4.10) dengan
  pola yang sama.
- API key: scope baru `email:send`, `email:read` + daftar **pengirim yang diizinkan** per key.
- Mengubah matriks: catat di `DECISIONS.md` + perbarui `permissions.test.ts` + review `security`.

## 6. Data (ringkas)
`mail_accounts` (org, owner_user_id, jenis pribadi/bersama, provider, alamat, warna, auth: imap/smtp/
pop3/oauth terenkripsi, status sinkron), `mail_account_access`, `mail_identities` (alamat, nama,
tanda tangan), `mail_folders` (path, role, uidvalidity, uidnext, unread_count), `mail_messages`
(account, folder, uid, message_id, thread_id, from/to/cc/bcc, subject, snippet, date, flags, size,
has_attachments, body_text, body_html_sanitized, auth_result, search_vector), `mail_attachments`,
`mail_threads`, `mail_drafts`, `mail_outbox` (antrian kirim + batalkan/jadwal), `mail_remote_image_allow`.
Semua tabel memakai `organization_id`.

Pakai ulang dari Fase 6: klien IMAP/SMTP, sanitasi HTML, deteksi lampiran berbahaya, verifikasi
pengirim, penjaga SSRF host, enkripsi kredensial.

## 7. Keamanan (wajib lolos `security`)
- Kredensial, refresh token OAuth, dan sandi aplikasi dienkripsi (AES-256-GCM, master key); tidak
  pernah dikirim ke browser; tampil tersamar.
- TLS wajib untuk IMAP/POP3/SMTP; sertifikat diverifikasi; host di-resolve dan alamat privat/
  link-local/metadata cloud diblokir (kecuali allowlist Admin untuk mail server LAN).
- HTML email: disanitasi server + dirender di iframe sandbox tanpa skrip; CSS email dibatasi; tautan
  dibuka di tab baru `noopener noreferrer`; gambar jarak jauh lewat proksi server (mencegah pelacakan
  & bocor IP), bawaan diblokir.
- Lampiran: tipe dideteksi dari isi; executable/makro diblokir unduh; disajikan `attachment` +
  `nosniff`; batas ukuran.
- Kirim: hanya dari identitas akun yang terverifikasi; batas kirim per pengguna & per akun per jam
  (ikut pengaturan **Batas kirim**); semua kirim, hapus permanen, dan perubahan hak akses → audit log.
- OAuth: `state` + PKCE, redirect URI tetap `https://<domain>/api/v1/mail/oauth/<provider>/callback`,
  client ID/secret aplikasi Microsoft/Google diisi Owner/Admin di **Pengaturan → Integrasi** (self-hosted:
  tiap instalasi mendaftarkan aplikasinya sendiri; panduan bergambar di UI).
- API kirim email: key dibatasi ke pengirim & domain URL lampiran tertentu; `Idempotency-Key` wajib
  disarankan; variabel template di-escape; HTML luar disanitasi; QRIS divalidasi; semua kirim via API
  tercatat (key, pengirim, penerima tersamar sebagian, metadata) tanpa menyimpan isi lampiran di log.
- Bot/AI email: lihat pagar pengaman §4.11; tidak pernah mengirim lampiran atau data pelanggan lain.
- Privasi (UU PDP): ekspor & hapus seluruh data satu akun; retensi cache bisa diatur; akun pribadi
  terisolasi.

## 8. Desain (wajib ikut `docs/DESIGN.md`; acuan `docs/design/email/mockup.html`)
- **Desktop ≥ 1024**: rail 64px (ikon **Mail** baru di bawah Inbox) · kolom **Folder** 248px · kolom
  **Daftar email** 380px · **Panel baca** fleksibel (isi maks. 768px, di tengah) · panel **Info pengirim**
  320px (bawaan tertutup; saat dibuka, kolom Folder disembunyikan dan bisa dimunculkan lagi lewat tombol di
  kepala daftar, supaya panel baca tetap ≥ 600px di layar 1440px).
- Kotak balas cepat menempel di dasar panel baca (seperti composer Inbox); tombol "Balas" penuh membuka
  jendela tulis mengambang.
- **Tablet**: folder jadi laci; daftar + baca.
- **HP**: seperti §4.9.
- Titik warna akun memakai token tag (`tagBlue`, `tagTeal`, `tagPurple`, `accent`, `success`) —
  tidak menambah warna baru.
- Keadaan kosong berilustrasi Kak Sky: belum ada akun ("Hubungkan akun email pertamamu"), folder
  kosong ("Kotak masuk bersih. Saatnya ngopi."), hasil cari kosong.
- Skeleton saat memuat daftar & isi; tidak ada spinner di tengah layar.
- Kritikus menilai minimal: Daftar (gabungan & per akun), Baca (HTML + gambar diblokir + lampiran),
  Tulis (mengambang & layar penuh HP), Wizard Tambah akun (5 penyedia + tes), Pengaturan akun & hak.

## 9. Bukan cakupan v1
Kalender & kontak (CalDAV/CardDAV), S/MIME/PGP, Exchange EWS, aturan server (Sieve), penyatuan akun
Email dengan Channel Email Inbox, klien desktop/HP native.

## 10. Tahapan (ROADMAP Fase 9)
- **9.0** Peningkatan Channel Email di Inbox (§4.10): Kepada/Cc/alamat tujuan, Cc/Bcc & Balas semua,
  **akses per channel**.
- **9.1** API kirim email untuk n8n/billing (§4.8): pengirim, template email + preset ISP, QRIS,
  lampiran, status & webhook, batas per pengirim — memakai Channel Email yang sudah ada.
- **9A** Fondasi: skema data, akun IMAP/SMTP (cPanel/IMAP lain) + wizard + tes, sinkron folder &
  header, menu Email (daftar + baca, asal email terlihat), izin & akses akun, foto/logo akun di
  Balesin.
- **9B** Tulis/balas/teruskan, Cc/Bcc & Balas semua, draf, tanda tangan, identitas, template, batalkan
  kirim, lampiran, penanda tabrakan.
- **9C** Utas, cari + panel Saring, label, aksi massal & pintasan, notifikasi, panel kontak CRM,
  tampilan HP penuh.
- **9D** Email banyak & kerja tim (§4.7): Prioritas/Lainnya, aturan, tugaskan + status, catatan
  internal, tunda, balasan otomatis, tampilan tersimpan, blokir/berhenti langganan.
- **9E** OAuth Microsoft (Graph) & Google, POP3, jadwalkan kirim, API & webhook `mail.*` untuk akun
  Email, bot eksternal per akun, asisten foto pengirim (BIMI).
- **NANTI**: SLA di Laporan, AI agent bawaan & ringkasan/saran balasan (Fase 8), penyatuan akun Email
  dengan Inbox CS.

## 11. Ukuran keberhasilan
- Tim bisa memakai `cs@`/`billing@skytech.net.id` sepenuhnya dari Balesin tanpa membuka webmail cPanel.
- Email baru tampil < 10 dtk (IDLE); buka email < 1 dtk setelah tersinkron.
- 0 temuan keamanan Tinggi/Kritis; kritikus LOLOS di 390px & 1440px, terang & gelap.
