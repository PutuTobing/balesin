# Design System & Rubrik — Balesin

Tujuan: aplikasi terlihat **dibuat oleh tim produk sungguhan**, bukan template AI.
Nuansa: rapi, hangat, percaya diri, sedikit playful (Gen Z) tanpa norak. Maskot Kak Sky
dipakai di momen tertentu, bukan di semua layar.

## 1. Token (sumber kebenaran: `packages/shared/design-tokens.ts` → CSS variables)

Warna dasar sementara; disesuaikan dengan logo final di `assets/brand/` (tugas
`kritikus-desain` setelah logo masuk).

| Token | Terang | Gelap | Pemakaian |
|---|---|---|---|
| `--bg` | `#F6F4EF` (kertas hangat) | `#0F1620` | latar aplikasi |
| `--surface` | `#FFFFFF` | `#16202C` | kartu, panel |
| `--surface-2` | `#EFECE5` | `#1C2735` | hover, area sekunder |
| `--ink` | `#14202E` | `#E8EDF3` | teks utama |
| `--ink-2` | `#4A5869` | `#9FB0C3` | teks sekunder |
| `--line` | `#E2DED5` | `#263345` | garis |
| `--primary` | `#1167D8` (Biru Langit) | `#4D9BFF` | aksi utama, link |
| `--accent` | `#FF7A59` (Senja) | `#FF8F72` | aksen kecil, badge baru, maskot |
| `--success` | `#1F9D6B` | `#3CC48D` | terkirim, selesai |
| `--warning` | `#D99413` | `#F2B544` | jendela 24 jam hampir habis |
| `--danger` | `#D64545` | `#F07070` | gagal, hapus |
| bubble keluar | `#E3EEFF` | `#1B3557` | pesan dari tim |
| bubble masuk | `--surface` | `--surface` | pesan pelanggan |

Kontras teks minimal **4.5:1** (cek otomatis).

**Tipografi**: *Plus Jakarta Sans* (UI, dirancang di Indonesia), *JetBrains Mono*
(ID pelanggan, kode, token terpotong). Self-host font (bukan CDN).
Skala: 12 / 13 / 14 (dasar) / 16 / 20 / 24 / 32. Inbox memakai 14px; jangan > 16px
untuk isi pesan. Line-height 1.45 untuk teks, 1.2 untuk judul.

**Spasi**: kelipatan 4px (4, 8, 12, 16, 24, 32, 48). **Radius**: 6 (input), 10 (kartu),
16 (bubble), 999 (pill). **Bayangan**: maksimal 2 level, halus.

**Ikon**: satu set saja (Lucide), stroke 1.75, ukuran 16/20.

**Gerak**: 120–200ms, ease-out; hormati `prefers-reduced-motion`.

## 2. Pola layar
- **Desktop ≥ 1024px**: rail navigasi ikon (64px) · daftar percakapan (360px) · ruang chat ·
  panel detail (340px, bisa disembunyikan).
- **HP ≤ 640px**: navigasi bawah (Inbox, Kontak, Broadcast, Lainnya); daftar → chat →
  detail sebagai layar bertumpuk dengan gesture kembali; composer menempel di bawah dan
  aman dari keyboard; target sentuh ≥ 44px.
- Tablet: dua kolom.
- Status kosong, loading (skeleton, bukan spinner di tengah), error: semua dirancang,
  memakai ilustrasi Kak Sky bila tersedia.

## 3. Larangan (ciri "kodingan AI" yang harus dihindari)
- Gradien ungu-biru generik, glassmorphism berlebihan, emoji sebagai ikon.
- Semua tombol berbentuk pill besar, bayangan tebal di mana-mana.
- Kartu dengan ikon + judul + 1 kalimat diulang-ulang tanpa hierarki.
- Teks English nyasar ("Submit", "No data"), Lorem ipsum, "Welcome back!".
- Ukuran font tidak konsisten, jarak acak, elemen tidak sejajar ke grid.
- Warna di luar token.

## 4. Gaya bahasa UI
Bahasa Indonesia santai-profesional, singkat. "Belum ada chat. Tenang, Kak Sky jaga
inbox-nya." Tombol: kata kerja jelas ("Kirim", "Ambil chat", "Tandai selesai").
Pesan error menjelaskan solusi ("Token Meta kedaluwarsa. Buat token baru di Pengaturan →
Channel").

## 5. RUBRIK `kritikus-desain`

Nilai 1–5 per kriteria, untuk setiap layar di **390×844** dan **1440×900**, terang & gelap.
**Lolos** = semua kriteria ≥ 4 dan tidak ada pelanggaran §3.

1. **Hierarki** — satu fokus utama per layar, judul/aksi utama jelas dalam 3 detik.
2. **Konsistensi token** — hanya warna/spasi/radius/font dari token.
3. **Tipografi** — skala benar, tidak ada teks terpotong/meluap, panjang baris wajar.
4. **Kerapian** — sejajar grid, jarak konsisten, tidak ada elemen bertabrakan.
5. **Responsif** — tidak ada scroll horizontal, target sentuh ≥ 44px, keyboard HP tidak
   menutupi composer.
6. **Keadaan** — kosong / loading / error / sukses sudah dirancang.
7. **Aksesibilitas** — kontras ≥ 4.5:1, fokus keyboard terlihat, label untuk ikon.
8. **Bahasa** — Indonesia natural, tidak ada English nyasar, tidak kaku.
9. **Kesan profesional** — terlihat seperti produk jadi, bukan template; detail kecil
   (avatar, badge, timestamp, status centang) dipoles.
10. **Kecepatan terasa** — tidak ada lompatan layout (CLS), interaksi langsung terasa.

Output kritikus: tabel nilai + daftar perbaikan konkret (file/komponen + apa yang
diubah) + screenshot sebelum/sesudah di `docs/design-reviews/`.
