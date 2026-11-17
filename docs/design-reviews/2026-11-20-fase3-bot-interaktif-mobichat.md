# Penilaian desain — Bot, pesan interaktif, webhook mode MobiChat (Fase 3)

- **Tanggal:** 2026-11-17 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `4162349` ("feat(web): UI bot & pesan interaktif, webhook mode MobiChat, …"). Worktree terisolasi
  (API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0024`, Redis db 11); pekerjaan broadcast backend yang belum
  di-commit tidak ikut.
- **Layar:** `nomor-bot`, `nomor-bot-mati`, `inbox-chat-bot`, `inbox-chat-interaktif`, `inbox-chat-interaktif-daftar`,
  `inbox-chat-pilihan`, `webhook-mobichat-tambah`, `webhook-mobichat`, `webhook-rotasi` × 390/1440 × terang/gelap, foto +
  audit kontras / target sentuh / teks terpotong.
- **Screenshot:** `docs/design-reviews/2026-11-20-fase3-bot-interaktif-mobichat/`.

## Putusan: REVISI

Fitur Fase 3 masuk dengan pola yang sudah konsisten:

**Kartu Bot di halaman nomor**
- Masuk navigasi bagian ("Bot").
- Status "● Memegang chat baru" / "○ Mati".
- Penjelasan jujur kapan bot benar-benar memegang chat ("hanya bila ada webhook aktif yang menerima Pesan masuk dari
  pelanggan").
- Segmen "24 jam / Jadwal" dan batas waktu menunggu balasan bot.

**Ruang chat milik bot**
- Footer "Chat ini sedang dipegang bot. [Ambil alih]" (sekunder).
- "Serahkan ke tim" di kepala desktop.
- Pesan bot dengan tombol yang terlihat seperti di WhatsApp, label "Bot CS Maju Jaya", dan "Balasan tombol" dari pelanggan.

**Dialog "Pesan dengan pilihan"**
- Segmen "Tombol balasan / Daftar pilihan".
- Penjelasan aturan 24 jam.
- Penghitung per isian dan kaki dialog menempel.

**Webhook MobiChat**
- Segmen format Standar/MobiChat.
- Peringatan "Alamat http:// tidak terenkripsi".
- Lencana "MobiChat" di kartu.
- Galat "API key webhook ini sudah dicabut… Ganti lewat Ubah".
- Dialog rotasi rahasia dengan opsi "cabut rahasia lama sekarang".

Audit: tidak ada teks < 4,5:1, tidak ada scroll horizontal, tidak ada target < 44 px (kecuali "Tampilkan password",
sudah diterima).

| # | Kriteria | Nilai | Layar | Sebab |
|---|---|---|---|---|
| 1 | 4 Kerapian, 1 Hierarki | 3 | `nomor-bot` · 1440 & 390 | Jadwal bot: label "Mulai / Selesai" diulang di **setiap** hari (5× di foto). Di 390 setiap hari memakan ±190 px (hari + 2 isian bertumpuk), 7 hari ≈ 1.300 px sebelum batas waktu dan tombol simpan. Tidak ada cara menyalin jam ke hari lain, padahal contoh (Senin–Jumat 17.00–23.59) sama semua |
| 2 | 3 Tipografi | 3 | `inbox-chat-interaktif-daftar` · 1440 | Isian "Pilihan 1" sebaris dengan "Keterangan (opsional)" hanya ±128 px: nilai "Rumahan 20 Mbps" terpotong "**Rumahan 20 Mt**" saat diketik. Di 390 isian ditumpuk dan lebar penuh — sudah benar |
| 3 | 8 Bahasa, 1 Hierarki | 3 | `webhook-mobichat-tambah` · 390 & 1440 | (a) Teks bantu URL tetap "**Wajib https.** …" padahal isian berisi `http://192.168.10.5…` dan kotak peringatan di bawahnya menerima http untuk jaringan privat — dua pesan bertentangan. (b) Istilah Inggris di kalimat: "**Body** seperti webhook MobiChat …", "API key untuk **workflow**" |

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `nomor-bot` | 1440 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| `nomor-bot-mati` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-chat-bot` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-chat-interaktif` (tombol) | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `inbox-chat-interaktif-daftar` | 1440 T/G | 5 | 5 | **3** | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `inbox-chat-pilihan` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `webhook-mobichat-tambah` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `webhook-mobichat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `webhook-rotasi` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3: **English nyasar** ("Body", "workflow" di kalimat — B3). Selebihnya bersih (ikon Lucide, token, satu tombol
  berwarna per dialog). Nama field `mobichat_base_url`, `mobichat_api_key`, scope dan kode diterima sebagai *monospace*.
- §4: tombol berwarna terakhir; "kamu/-mu" — lolos.

## Revisi

### Wajib

**B1. Jadwal bot ringkas** — komponen kartu Bot (`apps/web/src/features/channels/…Bot…`), CSS terkait

- Desktop: satu baris judul kolom "Hari · Mulai · Selesai" di atas daftar, lalu baris per hari tanpa label berulang
  (label tetap ada untuk pembaca layar lewat `aria-label` "Mulai Senin").
- HP: per hari satu baris "☑ Senin   17:00 – 23:59" (dua isian jam sebaris, masing-masing ±120 px, cukup untuk "23:59").
- Tambahkan aksi kecil "Samakan jam ke semua hari aktif" di bawah hari pertama.
- Hari yang tidak dicentang tidak menampilkan isian (sudah).
- Kriteria lolos: di 390 tujuh hari muat ≤ 7 × 56 px; label "Mulai/Selesai" terlihat sekali.

**B2. Pilihan daftar tidak terpotong di desktop** — dialog "Pesan dengan pilihan" (bagian daftar)

- Tumpuk "Pilihan n" dan "Keterangan (opsional)" juga di desktop (dialog hanya ±400 px), atau beri Pilihan
  `flex: 1 1 60%` dan Keterangan baris kedua.
- Kriteria lolos: nilai 24 karakter (batas pilihan) terlihat utuh di 1440.

**B3. Teks MobiChat konsisten dan berbahasa Indonesia** — `i18n/id.ts` (webhook mode MobiChat), formulir webhook

- Teks bantu URL mengikuti isinya: bila skema `http://`, ganti teks bantu menjadi "http:// hanya boleh untuk alamat di
  daftar jaringan privat." (dan biarkan kotak peringatan), bila `https://` pakai teks yang sekarang.
- "Body seperti webhook MobiChat + mobichat_base_url dan mobichat_api_key, untuk workflow n8n lama." →
  **"Isi kiriman sama dengan webhook MobiChat (ditambah `mobichat_base_url` dan `mobichat_api_key`), untuk alur n8n
  lama."**
- "API key untuk workflow" → **"API key untuk alur n8n"**.

### Saran (tidak menahan)

- **B-S1.** Tombol di gelembung pesan bot (`inbox-chat-pilihan`) tampil seperti tombol yang bisa diklik agen (latar
  `--surface`, teks `--primary`). Bila tidak interaktif, beri gaya berbeda (garis putus / ikon panah balas, teks
  `--ink-2`) supaya agen tidak mencoba mengekliknya.
- **B-S2 (`qa-tester`).** Mock `inbox-chat-pilihan`: balasan pelanggan pukul 08.10 tampil di bawah pesan bot pukul
  08.11 (urutan waktu terbalik). Buat balasan setelah pesan bot.
- **B-S3.** Penghitung karakter di bawah setiap isian (0/60, 0/24, 15/24, 0/72) ramai; tampilkan hanya saat isian
  terfokus atau ≥ 80% batas.
- **B-S4.** Dialog rotasi: kotak centang "Cabut rahasia lama sekarang" berbobot sama dengan teks biasa; beri warna
  `--danger-ink` pada label saat dicentang dan ubah tombol "Lanjut" menjadi "Buat rahasia baru".

## Bersih-bersih

Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo: laporan ini + 13 screenshot; bagian "Putaran 2" di
laporan HP penuh (+2 `p2-*.png`) dan API key & Webhook (+5 `p2-*.png`). Tidak ada kode produk yang diubah, tidak ada
commit.
