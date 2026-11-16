# Penilaian desain — Pengaturan → API key & Webhook

- **Tanggal:** 2026-11-17 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `4e53378`. Worktree terisolasi (3191/5191, `balesin_kd_e2e` migrasi sampai `0022`, Redis db 11);
  13 layar `screens-integrasi.ts` × 4 + audit HP 360/390 (lihat `2026-11-19-fase2-hp-penuh.md`).
- **Screenshot:** `docs/design-reviews/2026-11-19-fase3-api-key-webhook/`.

## Putusan: REVISI

Dua halaman teknis ini dibuat dengan hati-hati:

**API key**
- Peringatan "Berikan hanya ke integrasi tepercaya" di atas daftar.
- Kartu per key: awalan key bersifat *monospace*, izin sebagai pil, fakta lengkap (dibuat oleh, terakhir dipakai, berlaku
  sampai, batas harian, IP), status Aktif/Dicabut.
- Dialog Buat: izin bertingkat dengan nama teknis kecil dan penanda "sudah termasuk".
- Konfirmasi identitas sebelum dibuat.
- Kunci "hanya ditampilkan SEKALI" dengan Salin dan "Sudah saya simpan".
- Cabut dengan akibat yang jelas.

**Webhook**
- Kartu per penerima: URL, keterangan, pil kejadian, waktu rotasi rahasia, status termasuk "Dinonaktifkan otomatis" dengan
  penjelasan.
- Aksi: Kirim event tes, Riwayat, Ubah, ⋯ (Nonaktifkan, Buat rahasia baru, Hapus).
- Riwayat pengiriman: status berwarna, HTTP, durasi, percobaan, "Kirim ulang", dan penjelasan bila isi sudah dihapus.
- Jaringan privat berupa daftar CIDR.

Tidak ada scroll horizontal, tidak ada teks < 4,5:1. Menu ⋯ "Hapus" berwarna `--danger-ink`; dialog Cabut memakai pola
tombol berwarna terakhir.

| # | Kriteria | Nilai | Layar | Sebab |
|---|---|---|---|---|
| 1 | 3 Tipografi, 4 Kerapian | 3 | `webhook*` · 390 | URL penerima *monospace* dipecah per huruf di kolom sempit: "https://c / rm.contoh / .test/hoo / ks/whatsa / pp? / token=rah / asia-…" — **7+ baris** karena status "● Dinonaktifkan otomatis" berbagi baris dengan URL. URL pertama juga pecah di tengah domain ("majujaya.co.i / d/") |
| 2 | 8 Bahasa (§3 English nyasar) | 3 | `webhook*`, `api-key*` | Campur istilah: tombol "Kirim **event** tes", tetapi di tempat lain "kejadian" ("Kejadian yang dikirim", "3 jenis kejadian"); "**Potongan jawaban**" untuk isi respons HTTP sedangkan judul kartu "Riwayat pengiriman"; "Galat: **timeout**", "**http_404**" mentah |
| 3 | 1 Hierarki | 3 | `api-key-buat`, `webhook-tambah` · 1440 & 390 | Dialog lebih tinggi dari layar dan bergulir, tetapi tombol **Batal / Buat key** ada di dasar isi yang bergulir — di layar pertama tidak terlihat aksi apa pun (1440: dialog berakhir di "Batasi alamat IP"; 390: di "Masa berlaku"). Tidak ada tanda bahwa isi bisa digulir |

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `api-key` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 5 | 5 |
| `api-key-kosong`, `-memuat`, `-gagal` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `api-key-buat` | 390 · 1440 T/G | **3** | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `api-key-rahasia` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `api-key-cabut` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `webhook` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | **3** | 5 | 5 | 5 | **3** | 4 | 5 |
| `webhook-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `webhook-tambah` | 390 · 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `webhook-riwayat` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| `webhook-menu` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 |
| `webhook-jaringan-privat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |

## Larangan §3 dan istilah §4

- §3: **English nyasar** (W2). Selebihnya bersih (ikon Lucide, token, satu tombol berwarna per dialog).
- §4: tombol berwarna terakhir — lolos. Istilah teknis yang memang nama protokol (POST JSON, header X-Balesin-Signature,
  CIDR, HTTP, nama scope seperti `messages:send`, nama event `message.received`) diterima sebagai kode *monospace*.

## Revisi

### Wajib

**W1. URL webhook terbaca di HP** — `WebhooksPage.tsx`, `Integrations.module.css`

- Di ≤ 640 px pindahkan status ke baris sendiri di atas URL (atau di bawah keterangan), sehingga URL memakai lebar penuh
  kartu. Pecah URL hanya di batas wajar: `overflow-wrap: anywhere` diganti `word-break: break-all` hanya bila tanpa spasi
  panjang > lebar, dan batasi tampilan ke 2 baris (`-webkit-line-clamp: 2`) dengan URL lengkap di `title` + Riwayat/Ubah.
- Kriteria lolos: di 390 setiap URL contoh tampil ≤ 2 baris.

**W2. Satu istilah Indonesia** — `apps/web/src/i18n/id.ts` (bagian webhook)

| Sekarang | Ganti dengan |
|---|---|
| Kirim event tes | **Kirim kejadian tes** |
| Potongan jawaban | **Lihat respons penerima** (isi: "Potongan respons (maks. 1 KB)") |
| Galat: timeout | **Galat: waktu habis (10 detik)** |
| Galat: http_404 | **Galat: HTTP 404 (alamat tidak ditemukan)** — petakan kode galat umum (`timeout`, `http_4xx`, `http_5xx`, `dns`, `tls`, `connection_refused`) ke kalimat |

**W3. Tombol dialog panjang selalu terlihat** — `ApiKeyCreateDialog.tsx`, `WebhookFormDialog.tsx` (dan komponen dialog
bersama bila dipakai)

- Kaki dialog (Batal + tombol utama) menempel di dasar dialog (`position: sticky; bottom: 0` dengan latar `--surface` dan
  garis atas `--line`), isi di atasnya yang bergulir. Di HP dialog boleh setinggi layar penuh.
- Kriteria lolos: di 390 & 1440 tombol "Buat key" / "Simpan webhook" terlihat tanpa menggulir saat dialog terbuka.

### Saran

- **A-S1.** Pil izin panjang ("Kirim pesan di percakapan yang sudah ada (termasuk unggah media)") membuat kartu API key
  ramai; di kartu pakai label pendek ("Kirim pesan", "Ubah kontak"), kalimat lengkap di dialog.
- **A-S2.** Kartu key yang **Dicabut** sebaiknya diredupkan / dipindah ke bagian "Dicabut" yang bisa dilipat supaya key
  aktif lebih menonjol.
- **A-S3.** "Tindakan lain" (⋯) lebar 42 px → 44 px.

## Bersih-bersih

Lihat `2026-11-19-fase2-hp-penuh.md` (satu worktree untuk ketiga laporan; sudah dihapus, port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0). Tidak ada kode produk yang diubah, tidak ada commit.
