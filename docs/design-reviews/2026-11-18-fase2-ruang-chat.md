# Penilaian desain — Ruang chat penuh (Fase 2 butir 6 web: composer, aksi pesan, media, kirim ulang)

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `abe3ae5` ("feat(chat): composer — kirim teks, balas-kutip, reaksi, lampiran, media aman, kirim
  ulang, rem darurat"), branch `dev`. HEAD sesudahnya `7bb149f` (hanya berkas tes security di `apps/web`).
- **Acuan:** `docs/DESIGN.md` §2 (HP: composer menempel di bawah, aman dari keyboard, target ≥ 44 px), §3, §4, §5;
  `docs/KONTRAK-API-INBOX.md` (kirim, 423 `SENDING_PAUSED`, 429, `failure.message`, klaim); `docs/DECISIONS.md`
  2026-11-13 baris 47 ("jangan menjanjikan sesuatu yang belum terjadi di layar").
- **Screenshot:** `docs/design-reviews/2026-11-18-fase2-ruang-chat/` (390 = terang | gelap berdampingan, skala 1×; 1440
  per tema).

## Putusan: REVISI

Dasarnya sudah terasa seperti produk sungguhan:
- **Composer:** tombol lampiran dan kirim 44 × 44 di HP, huruf 16 px di HP (iOS tidak memperbesar halaman saat
  mengetik), kotak tulis tumbuh sampai 160 px lalu bergulir, tombol kirim nonaktif saat kosong.
- **Pesan:** kutipan balasan di atas composer bisa ditutup, pratinjau lampiran (gambar asli + ukuran) dengan keterangan,
  pesan optimistis dengan ikon jam, nama agen pengirim ("👤 Citra" sebagai ikon orang + nama), menu aksi dengan 6 reaksi
  cepat + Balas.
- **Batas & gagal:** 429 dengan hitung mundur `0:42` di tempat tombol kirim (pola §4), item gagal dengan "Hapus" dan
  "Kirim ulang", teks gagal menjelaskan penyebab.
- **Media & sesi:** gambar dimuat aman dalam bingkai, dokumen dengan "Unduh", audio "Putar audio", footer sesi habis
  menjelaskan aturan 24 jam.

Ukuran huruf 12/13/14/16/20 saja, tidak ada teks < 4,5:1, tidak ada target < 44 px di HP.

Yang menahan ada tujuh:

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 6 Keadaan, 1 Hierarki | 3 | `inbox-chat-rem-darurat` · semua | Saat rem darurat ditarik, kotak tulis tetap bisa diisi **dan tombol "Kirim" aktif** (`disabled = false` setelah mengetik). Mengirim pasti berakhir 423 — banner menyebut pesan "tidak dikirim", tetapi kontrolnya mengajak mengirim |
| 2 | 6 Keadaan, 10 Kecepatan terasa | 3 | `kirim-gagal`, `inbox-chat-dibatasi` · semua | Setelah gagal (500/429) kotak tulis dikosongkan, tetapi item "Belum terkirim" + "Kirim ulang" **di luar layar** (riwayat tidak digulir ke bawah; terukur `timelineVisible: false` di 390 & 1440). Yang terlihat: kotak kosong + kotak merah "Pesan belum terkirim / Tutup" — terkesan teks hilang. Saat digulir manual, pesan yang sama muncul dua kali (di bawah item dan di kotak) |
| 3 | 1 Hierarki | 3 | Chat yang belum diambil (`inbox-chat`, `-balas`, `-lampiran`, …) · 390 & 1440 | Dua tombol berwarna penuh bertumpuk: "Ambil chat" (strip info) dan "Kirim". Di HP saat mengetik keduanya biru berjarak ±60 px. §5: satu fokus utama |
| 4 | 9 Profesional | 3 | Ruang chat · 390 | **14 tombol "⋯" (Aksi pesan) tampil terus** di samping setiap gelembung (di desktop hanya saat hover/fokus). Riwayat jadi ramai dan gelembung masuk menyempit ±44 px |
| 5 | 4 Kerapian | 3 | Pesan dokumen · 390 & 1440 | Nama berkas tampil dua kali: kartu "tagihan-novemb… [Unduh]" lalu baris "Dokumen: tagihan-november-2026.pdf" di bawahnya (di 390 versi kartu terpotong, versi teks utuh) |
| 6 | 4 Kerapian | 3 | Pesan gambar · 1440 | Gelembung gambar selebar ±482 px, gambarnya 280 × 210 → ±200 px kosong di kanan gambar; keterangan dan jam melebar mengikuti gelembung. Di 390 sudah pas |
| 7 | 8 Bahasa, 9 Profesional | 3 | `inbox-chat-sesi-habis` · semua | Tombol "Kirim template" **nonaktif** + "Kirim template hadir di pembaruan berikutnya." — janji fitur di layar produk white-label, bertentangan dengan keputusan 2026-11-13 (jangan menjanjikan yang belum ada) dan menjadi jalan buntu sebagai elemen paling menonjol di footer |

## Cara menilai

1. **Foto (terisolasi).** Worktree sementara dari `abe3ae5`, `pnpm install --frozen-lockfile`, API **3191**, web
   **5191**, database **`balesin_kd_e2e`** (migrasi sampai `0017`), Redis **db 11**. Layar `screens-inbox.ts` termasuk
   `inbox-chat-menu-pesan`, `-balas`, `-lampiran`, `-terkirim`, `-dibatasi`, `-rem-darurat`, `-sesi-habis`, ditambah 3
   layar penilaian: `kirim-gagal` (POST pesan → 500), `chat-milik-lain` (chat Dilayani oleh Agus, dibuka Owner),
   `composer-fokus`: **128 foto lulus**.
2. **Ukur** (31 uji lulus): kontras & target sentuh di 10 keadaan ruang chat × 4; geometri composer (tinggi kotak tulis,
   tombol, tinggi maksimal); kirim → 500 dan → 429: isi kotak tulis, ada/tidaknya item di riwayat, terlihat/tidak, ada
   "Kirim ulang"; rem darurat: kotak tulis dan tombol kirim setelah mengetik; ukuran gambar; kontak tanpa nama.

### Hasil ukur (fakta)

| Yang diukur | Hasil |
|---|---|
| Composer 390 | Kotak tulis 47 px (huruf **16 px**), bawahnya y 832 dari 844; "Lampirkan berkas" 44 × 44; "Kirim" 44 × 44 (nonaktif saat kosong); "Ambil chat" 106 × 44. Tumbuh sampai **160 px**, lalu bergulir |
| Composer 1440 | Kotak tulis 44 px (14 px); "Lampirkan berkas" 36 × 36; "Kirim" 44 × 44; "Aksi pesan" 36 × 36, **tidak terlihat** sampai hover/fokus (0 dari 14) |
| Aksi pesan 390 | **14 dari 14 terlihat** terus |
| Kirim → 500 | Kotak tulis kosong; item ada di riwayat dengan "Belum terkirim", "Terjadi kesalahan di server. Coba lagi.", "Hapus", "Kirim ulang" — **di luar layar** sampai digulir; kotak "Pesan belum terkirim / Tutup" di atas footer |
| Kirim → 429 | Sama + hitung mundur `0:42` di tempat tombol kirim |
| Rem darurat | Kotak tulis bisa diisi, **tombol Kirim aktif** setelah mengetik (4 varian) |
| Gambar | 280 × 210 (1440) / 278 × 209 (390); gelembung 1440 ±482 px |
| Kontras / huruf | Tidak ada teks < 4,5:1 di 10 keadaan × 4; huruf 12–20, hanya Plus Jakarta Sans di ruang chat |

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `inbox-chat` (belum diambil, composer kosong) | 1440 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| `inbox-chat-menu-pesan` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | **3** | 5 |
| `inbox-chat-balas`, `-lampiran`, `composer-fokus` | 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | 4 | 5 | 5 | 5 | 5 | **3** | 5 |
| `inbox-chat-terkirim` (optimistis) | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `kirim-gagal` (500) | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | **3** | 5 | 4 | 4 | **3** |
| `inbox-chat-dibatasi` (429) | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | **3** | 5 | 5 | 4 | **3** |
| `inbox-chat-rem-darurat` (423) | 390 · 1440 T/G | **3** | 5 | 5 | 4 | 5 | **3** | 5 | 5 | 4 | 5 |
| `inbox-chat-sesi-habis` (footer template) | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | **3** | 5 |
| `chat-milik-lain` (Dilayani agen lain) | 1440 T/G | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 |
| Media: gambar, dokumen, audio | 1440 T/G | 5 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | 4 | 5 |

## Larangan §3

| Larangan | Status | Bukti |
|---|---|---|
| Gradien, glassmorphism, emoji sebagai ikon | Bersih | Emoji hanya sebagai reaksi pesan (konten), ikon Lucide (klip, kirim, putar, unduh, balas, jam, tempat sampah, putar ulang) |
| Pill besar, bayangan tebal | Bersih | Bayangan hanya menu aksi |
| Kartu berulang tanpa hierarki | Bersih | |
| English nyasar | Bersih | "Tulis pesan…", "Ambil chat", "Kirim ulang", "Pesanan dari katalog" |
| Font tidak konsisten, elemen tidak sejajar | **Pelanggaran** | Nama dokumen ganda (W5), gelembung gambar melebar tanpa isi (W6) |
| Warna di luar token | Bersih | |

## Istilah & pola §4

| Aturan | Status |
|---|---|
| Hitung mundur 429 di tombol nonaktif, judul "… dibatasi sementara" | Lolos ("Pengiriman dibatasi sementara", `0:42`) |
| Pesan error menjelaskan solusi | Lolos untuk gagal sesi ("Pelanggan perlu membalas dulu, atau kirim template") dan rem darurat ("Owner atau Admin di tempatmu bisa melanjutkan…"). Untuk 500 masih "Terjadi kesalahan di server. Coba lagi." — wajar untuk galat tak terduga |
| "Owner atau Admin di tempatmu" | Lolos (banner rem darurat) |
| "kamu/-mu" | Lolos |

## Revisi, berurutan prioritas

### Wajib (menyebabkan nilai < 4)

**C1. Rem darurat menonaktifkan pengiriman**
— `apps/web/src/features/inbox/Composer.tsx`, `use-sending-paused.ts`

- Saat `paused`: tombol "Kirim" dan "Lampirkan berkas" `disabled` dengan `aria-describedby` ke banner. Kotak tulis
  boleh tetap bisa diisi (draf), placeholder "Pengiriman sedang dihentikan — tulis draf dulu".
- Kriteria lolos: di `inbox-chat-rem-darurat` setelah mengetik, `Kirim` nonaktif; tidak ada permintaan POST.

**C2. Pesan yang gagal selalu terlihat, sekali saja**
— `ChatRoom.tsx` (gulir riwayat), `OutboxRows.tsx`, `ChatFooter.tsx` (kotak "Pesan belum terkirim")

- Setiap kali pengguna mengirim (berhasil, gagal, atau dibatasi), gulir riwayat ke bawah sehingga item outbox
  terlihat, apa pun posisi gulir sebelumnya.
- Untuk gagal per pesan (500, `failure`), **hapus kotak "Pesan belum terkirim / Tutup"** di footer: keterangan di bawah
  item + "Hapus"/"Kirim ulang" sudah cukup. Untuk 429 kotak "Pengiriman dibatasi sementara" boleh tetap (karena
  berlaku untuk percakapan, bukan satu pesan) tanpa mengulang kalimat yang sama di bawah item.
- Kriteria lolos: setelah kirim → 500/429 di 390 & 1440, item "Belum terkirim" + "Kirim ulang" berada di area riwayat
  yang terlihat tanpa menggulir; satu kalimat galat per kejadian.

**C3. Satu tombol utama di footer**
— `ChatFooter.tsx` (strip "Chat ini belum ada yang menangani.")

- "Ambil chat" menjadi tombol **sekunder** (berbingkai, `variant="secondary"`, tinggi 36 px desktop / 44 px HP);
  "Kirim" tetap satu-satunya tombol berwarna penuh. Bila mengirim tidak mengambil chat secara otomatis, tulis di strip:
  "Belum ada yang menangani. Ambil supaya tim tahu kamu yang membalas."
- Kriteria lolos: di chat yang belum diambil hanya ada satu tombol `--primary` penuh di footer.

**C4. Aksi pesan di HP tanpa 14 tombol "⋯"**
— `MessageTimeline.tsx`, `Chat.module.css`

- Di `(hover: none)`: sembunyikan tombol "⋯" per gelembung; ketuk (atau tekan lama) gelembung membuka menu aksi
  (gelembung jadi pemicu dengan `aria-haspopup="menu"`, `aria-label` "Aksi untuk pesan pukul 21.48"). Tombol "⋯"
  hanya tampil untuk gelembung yang sedang terpilih/terfokus, tetap ≥ 44 px.
- Kriteria lolos: di `inbox-chat` 390 tidak ada "⋯" terlihat sebelum gelembung diketuk; menu tetap bisa dibuka lewat
  keyboard (fokus gelembung → Enter).

**C5. Nama dokumen sekali saja**
— `MessageMedia.tsx` / `MessageTimeline.tsx` (label "Dokumen: …")

- Bila kartu berkas tampil, jangan render baris "Dokumen: {nama}". Kartu: nama berkas boleh 2 baris (`-webkit-line-clamp:
  2`) supaya tidak terpotong di 390. Keterangan (caption) pengirim tetap tampil di bawah kartu bila ada.
- Kriteria lolos: nama berkas muncul satu kali per pesan dokumen, utuh atau 2 baris di 390.

**C6. Gelembung gambar seukuran gambarnya**
— `Chat.module.css` (gelembung media)

- Gelembung berisi gambar/stiker/video: `width: fit-content` dengan `max-width` = lebar bingkai media (280 px) + padding,
  sehingga keterangan dan jam membungkus mengikuti lebar gambar.
- Kriteria lolos: di 1440 lebar gelembung gambar ≤ lebar gambar + 24 px.

**C7. Footer sesi habis tanpa janji fitur**
— `ChatFooter.tsx`, `i18n/id.ts` (`windowClosed*`, "hadir di pembaruan berikutnya")

- Hapus tombol nonaktif "Kirim template" dan kalimat "Kirim template hadir di pembaruan berikutnya." Footer cukup judul
  + penjelasan: "Sesi 24 jam sudah habis · Pesan biasa hanya bisa dikirim dalam 24 jam sejak pesan terakhir pelanggan.
  Tunggu pelanggan membalas." Tombol template ditambahkan begitu fiturnya ada.
- Kriteria lolos: tidak ada tombol nonaktif tanpa jalan keluar dan tidak ada janji rilis di layar.

### Saran (tidak menahan)

- **CS1. Chat milik agen lain.** Owner/Admin bisa langsung mengetik di chat "Ditangani Agus" tanpa tanda apa pun di
  dekat composer. Tampilkan strip ringkas "Ditangani Agus · Ambil alih" (teks `takeOver` sudah ada) supaya tidak ada
  dua orang membalas pelanggan yang sama tanpa sadar.
- **CS2.** Pesan optimistis hanya berikon jam; tambahkan teks kecil "Mengirim…" selama > 2 detik supaya terlihat ada
  proses, dan foto keadaan "Hapus reaksi" di menu aksi (belum ada di daftar foto).
- **CS3.** Foto keadaan keyboard HP (composer + `visualViewport`) belum ada; tambahkan uji E2E yang memastikan kotak
  tulis tetap terlihat saat tinggi viewport menyusut ±300 px.
- **CS4.** Kotak "Pesan belum terkirim" memakai tombol "Tutup" tanpa bingkai yang menjorok (x 160); bila kotak itu
  dipertahankan untuk 429, samakan dengan pola `Notice` + aksi lain.

## Bersih-bersih

Worktree sementara dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191
kosong, database `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo yang ditulis: laporan ini + 20 screenshot
di `docs/design-reviews/2026-11-18-fase2-ruang-chat/`, serta bagian "Putaran 3" + 3 berkas `p3-*.png` di laporan Inbox.
Tidak ada kode produk yang diubah, tidak ada commit.

---

# Putaran 2

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 2
- **Kode yang dinilai:** `78a46dc` ("feat(inbox): tandai selesai/buka lagi/alihkan/kembalikan, template "/" +
  Pengaturan → Template percakapan, revisi ruang chat C1–C7"). Selama penilaian HEAD maju ke `c90555f` (fitur kontak
  lain); foto mewakili `78a46dc`.
- **Cara:** worktree sementara, API 3191 / web 5191, `balesin_kd_e2e` (migrasi sampai `0018`), Redis db 11. 25 layar
  (ruang chat + butir 7/9) × 4: **101 foto lulus**. Ukur: kepala chat HP (avatar, nomor), gambar & dokumen, kirim → 500
  (posisi "Kirim ulang"), rem darurat (tombol), kontras/target/teks terpotong di semua layar terang 390/1440.
- **Screenshot:** berkas berawalan `p2-`. Layar butir 7 & 9 dinilai di `2026-11-18-fase2-penanganan-template.md`.

## Putusan putaran 2: REVISI (dua sisa, satu regresi)

| Butir | Hasil | Status |
|---|---|---|
| **C1** rem darurat | Setelah mengetik draf: "Kirim" **nonaktif**, "Lampirkan berkas" **nonaktif**; draf tetap bisa ditulis | Lolos |
| **C2** gagal terlihat, sekali | Kotak "Pesan belum terkirim" di footer **hilang**; riwayat digulir ke item. Tetapi gulirnya berhenti di gelembung: "Kirim ulang" di 1440 di y 792, tepi bawah riwayat 782 (**tersembunyi**); di 390 y 701–745, tepi 715 (**terpotong**) | **Sebagian** (CH2) |
| **C3** satu tombol utama | "Ambil chat" berbingkai; "Kirim" satu-satunya tombol penuh. Teks strip: "Belum ada yang menangani. Ambil supaya tim tahu kamu yang membalas." | Lolos |
| **C4** "⋯" di HP | Tidak ada "⋯" yang terlihat sebelum gelembung diketuk | Lolos |
| **C5** nama dokumen | Nama berkas muncul **1 kali** per pesan dokumen | Lolos |
| **C6** gelembung gambar | Gambar 280 px, gelembung **306 px** (1440); 254/280 (390) | Lolos |
| **C7** footer sesi habis | Judul + penjelasan saja, tanpa tombol nonaktif dan tanpa janji rilis | Lolos |
| **CS1** chat milik agen lain | Strip "Ditangani Agus · Ambil alih" (tombol berbingkai) | Lolos |
| **CS4** | Kotak galat 500 dihapus (C2) | Lolos |
| Avatar kepala chat HP disembunyikan | **Tidak terjadi**: avatar masih tampil (`display: grid`, 32 px). `.headerAvatar { display: none }` di `Chat.module.css` kalah oleh aturan `display: grid` modul Avatar. Akibatnya nomor terpotong di **setiap** kepala chat 390: "+62 812-3456-78…" (115 > 111 px), dan pada chat selesai "Yohanes Sir…" + "+62 812-9999…" (91 px) | **Regresi** (CH1) |
| "Selesai · Agus" di tab Semua | Tampil ("+62 812-9999-8888 · Selesai · Agus · CS Maju Ja…") | Lolos |

Kontras: tidak ada teks < 4,5:1. Target sentuh 390: tidak ada < 44 px. Ukuran huruf 12/13/14/16/20.

## Revisi putaran 2

### Wajib

**CH1. Nomor di kepala chat HP terlihat utuh** — `ChatRoom.tsx` (`ChatHeader`), `Chat.module.css`

- Aturan `.headerAvatar { display: none }` tidak menang atas `display: grid` dari `Avatar.module.css` (urutan muat CSS).
  Jangan render avatar di ≤ 640 px (mis. `className` yang dikenal Avatar, atau render bersyarat lewat `useMediaQuery`),
  atau naikkan spesifisitas: `.header .headerAvatar { display: none; }`.
- Pada chat dengan pil sesi + "⋮", nama tetap boleh terpotong tetapi **nomor tidak boleh** (alasan keamanan
  `contact-identity.ts`): beri nomor `flex-shrink: 0` dan biarkan nama yang memendek.
- Kriteria lolos: di 390 nomor Indonesia utuh di kepala `inbox-chat`, `inbox-chat-agen-lain`, `inbox-chat-selesai`.

**CH2. "Kirim ulang" ikut terlihat setelah gagal** — `ChatRoom.tsx` (gulir setelah kirim), `OutboxRows.tsx`

- Gulir ke **bawah baris outbox** (bukan ke gelembung): `history.scrollTop = history.scrollHeight` setelah item gagal
  dirender (tunggu `requestAnimationFrame` setelah baris aksi masuk DOM).
- Kriteria lolos: setelah kirim → 500 di 390 & 1440, tombol "Kirim ulang" seluruhnya berada di dalam area riwayat.

### Saran

- **CH-S1.** Pada chat selesai di HP, "Buka lagi" hanya ada di menu "⋮" (di desktop tombol di kepala). Tampilkan
  tombol "Buka lagi" (sekunder) di footer "Chat ini sudah selesai…" pada ≤ 640 px.

## Bersih-bersih putaran 2

Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama), port 3191/5191 kosong,
`balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0. Berkas repo: bagian ini + 9 berkas `p2-*.png`. Tidak ada kode produk
yang diubah, tidak ada commit.
