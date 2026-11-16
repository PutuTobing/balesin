# Penilaian desain — Pengaturan → Notifikasi & PWA (Fase 2 butir 10)

- **Tanggal:** 2026-11-17 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `9778d3d` ("feat(pwa): notifikasi push & PWA installable, Pengaturan → Notifikasi; revisi panel
  detail P1–P4"). HEAD utama sudah maju ke `cbb5809`; pekerjaan backend yang belum di-commit tidak ikut.
- **Acuan:** `docs/DESIGN.md` §3, §4, §5.
- **Screenshot:** `docs/design-reviews/2026-11-19-fase2-notifikasi-pwa/` (390 = terang | gelap berdampingan; 1440 per
  tema).

## Putusan: REVISI (satu butir bahasa)

Halaman ini rapi dan jujur soal keadaan perangkat.

**Kartu "Perangkat ini"**
- Status ringkas di kanan atas: "○ Belum aktif", "● Aktif", "● Diblokir", "○ Tidak didukung".
- Izin browser baru diminta setelah tombol ditekan, dan halaman mengatakan itu ("Browser akan menanyakan izin setelah kamu
  menekan tombol di bawah.").
- Ada "Kirim notifikasi tes" + "Lepas perangkat ini" dengan konfirmasi "Notifikasi tes dikirim ke 2 perangkat…".
- Tiga keadaan khusus punya panduan yang bisa diikuti:
  - diblokir: ikon gembok → Izin situs → Notifikasi → Izinkan;
  - iPhone/iPad: Bagikan → Tambah ke Layar Utama;
  - browser tidak didukung: daftar browser yang didukung.

**Preferensi**
- Kartu pilihan bercentang dengan latar `--primary-soft` saat aktif.
- Bagian Owner "Isi notifikasi di organisasi" menjelaskan risikonya ("bisa terbaca di layar kunci") dan bawaannya aman.
- Kerangka memuat dan keadaan gagal dirancang.

**Banner "Versi baru tersedia"**
- Banner ringkas di atas semua halaman dengan "Muat ulang" dan tutup, plus penenang "Draf yang belum terkirim tetap aman."

Audit otomatis 5 layar × 4 (`notifikasi`, `-aktif`, `-tes-terkirim`, `-diblokir`, `-ios`): tidak ada teks < 4,5:1, huruf
12/13/14/16/20. Kotak centang 20 × 20 px tetapi seluruh kartu adalah label (target ±60 px) — diterima. Isian jam 42 px di
bingkai 44 — pola yang sudah diterima.

| # | Kriteria | Nilai | Layar | Sebab |
|---|---|---|---|---|
| 1 | 8 Bahasa (§4) | 3 | Semua layar `notifikasi*` · 390 & 1440 | Sapaan bercampur di kartu yang sama. Label memakai "**saya**" ("Pesan baru di chat yang **saya** tangani", "Chat ditugaskan ke **saya**"), tetapi keterangan di bawahnya "…mengalihkan chat ke **kamu**", dan judul kartu "…semua perangkat**mu**". §4: sapaan "kamu/-mu" |

## Cara menilai

Worktree terisolasi dari `9778d3d`: API **3191**, web **5191**, `balesin_kd_e2e` (migrasi sampai `0021`), Redis **db 11**.
Layar `screens-notifikasi.ts` (8 keadaan + `pembaruan-versi`) × 4 dengan perangkat tiruan (Notification, PushManager,
service worker), ditambah foto bagian Owner di bawah halaman. Audit kontras/target untuk 5 layar pertama × 4 (sisa layar
dinilai dari foto; spek audit dihentikan karena lambat, lihat Bersih-bersih).

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `notifikasi` (belum aktif) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `notifikasi-aktif`, `-tes-terkirim` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 | 5 |
| `notifikasi-diblokir` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 | 5 |
| `notifikasi-ios` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `notifikasi-tidak-didukung` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `notifikasi-memuat` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `notifikasi-gagal` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| Bagian Owner "Isi notifikasi di organisasi" | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `pembaruan-versi` (banner) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

## Larangan §3 dan istilah §4

- §3: bersih (ikon Lucide lonceng, kirim, info, peringatan, putar-ulang; warna token; satu tombol berwarna per kartu).
- §4: sapaan **gagal** (N1). Judul gagal "Preferensi notifikasi belum bisa dimuat" — lolos.

## Revisi

### Wajib

**N1. Sapaan "kamu/-mu" konsisten**
— `apps/web/src/i18n/id.ts` (bagian notifikasi)

| Sekarang | Ganti dengan |
|---|---|
| Pesan baru di chat yang saya tangani | **Pesan baru di chat yang kamu tangani** |
| Chat ditugaskan ke saya | **Chat ditugaskan ke kamu** |

- Keterangan "Saat orang lain menugaskan atau mengalihkan chat ke kamu." boleh tetap.
- Kriteria lolos: kata "saya" tidak muncul di halaman Notifikasi.
- (Catatan: saringan Inbox "Ditangani saya" adalah label menu dari sudut pandang pengguna dan sudah diterima. Bila ingin
  seragam penuh, ganti juga dengan "Ditangani kamu".)

### Saran (tidak menahan)

- **N-S1.** Dua tombol simpan di satu halaman berbeda bobot: "Simpan preferensi" (primary) dan "Simpan pengaturan
  organisasi" (berbingkai). Keduanya menyimpan kartu masing-masing — samakan (dua-duanya primary di kartunya, atau
  keduanya sekunder bila tidak ada perubahan).
- **N-S2.** Bagian Owner: tambahkan lencana kecil "Hanya Owner" di judul supaya jelas mengapa anggota lain tidak
  melihatnya.
- **N-S3.** iOS: status "○ Tidak didukung" menyesatkan karena notifikasi didukung setelah aplikasi dipasang. Ganti dengan
  "○ Perlu dipasang". Tebalkan nama tombol Safari (**Bagikan**, **Tambah ke Layar Utama**) seperti langkah wizard
  channel.
- **N-S4 (`qa-tester`).** Belum ada foto "Jam tenang" aktif dengan isian jam (klik pada label di spek saya tidak
  mencentangnya). Tambahkan layar `notifikasi-jam-tenang` di `screens-notifikasi.ts`.

## Bersih-bersih

Spek audit dihentikan setelah 5 layar × 4 (lambat), lalu server 3191/5191 dipastikan mati. Worktree dihapus (folder +
`git worktree prune`; `git worktree list` hanya repo utama), `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas
repo: laporan ini + 13 screenshot, bagian "Putaran 2" laporan panel & batas kirim (+8 `p2-*.png`), bagian "Putaran 3"
laporan penanganan & template (+1 `p3-*.png`). Tidak ada kode produk yang diubah, tidak ada commit.
