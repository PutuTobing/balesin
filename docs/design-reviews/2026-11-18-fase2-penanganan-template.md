# Penilaian desain — Penanganan chat (butir 7) & Template percakapan (butir 9)

- **Tanggal:** 2026-11-18 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `78a46dc` ("feat(inbox): tandai selesai/buka lagi/alihkan/kembalikan, template "/" +
  Pengaturan → Template percakapan, revisi ruang chat C1–C7"). Selama penilaian HEAD maju ke `c90555f`.
- **Acuan:** `docs/DESIGN.md` §3, §4, §5; `docs/KONTRAK-API-INBOX.md` (claim/assign/unassign/resolve/reopen,
  `inbox/agents`); keputusan di `docs/DECISIONS.md`.
- **Screenshot:** `docs/design-reviews/2026-11-18-fase2-penanganan-template/` (390 = terang | gelap berdampingan; 1440
  per tema).

## Putusan: REVISI

Penanganan chat sudah rapi:
- **Kepala chat desktop:** "Tandai selesai" berbingkai di samping pil sesi, dan "⋮" membuka menu "Tindakan chat"
  (Tandai selesai, Tugaskan ke agen…, Kembalikan ke antrian), dengan isi yang mengikuti keadaan chat.
- **Dialog Tugaskan/Alihkan:** radio dalam kartu dengan nama, peran, dan beban ("4 chat terbuka"), tombol berwarna
  terakhir sesuai §4.
- **Footer:** chat selesai berisi penjelasan dan "Buka lagi"; chat milik agen lain menampilkan "Ditangani Agus · Ambil
  alih".

Template "/" bekerja sebagai combobox dengan petunjuk keyboard. Halaman pengaturannya punya pencarian, keadaan kosong
dengan ajakan, kartu dengan shortcut ber-*monospace*, statistik pemakaian, dialog ubah dengan sisip `{nama}`/`{agen}`,
dan dialog hapus yang menjelaskan akibatnya. Tidak ada teks < 4,5:1, tidak ada target < 44 px di HP, huruf 12–20.

Yang menahan ada empat:

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 8 Bahasa, 1 Hierarki | 3 | Template "/", Pengaturan → Template percakapan, footer/pesan sesi habis | Dua hal berbeda sama-sama disebut **"template"**: balasan cepat "/" milik tim, dan template pesan WhatsApp (perlu persetujuan Meta, satu-satunya cara membalas setelah sesi 24 jam habis). Di `inbox-chat-template` keduanya tampil bersamaan: teks merah "…atau **kirim template**" tepat di atas daftar berjudul "**Template percakapan**". CS akan mencoba "/salam" untuk chat yang sesinya habis dan gagal |
| 2 | 3 Tipografi | 3 | `pengaturan-template-percakapan` · 390 | Judul halaman terpotong "**Template per…**" (207 > 142 px) karena tombol "Tambah template" (176 px) duduk di kepala halaman. Di 1440 tombol yang sama di x 1240–1416, jauh dari kolom isi (88–760) |
| 3 | 4 Kerapian | 3 | Daftar template "/" · 390 | Judul tiap baris mulai di x berbeda: **84 / 107 / 107 / 99 px** (mengikuti panjang shortcut), begitu pula isi di bawahnya. Di 1440 sudah satu kolom (x 557) |
| 4 | 4 Kerapian | 3 | `pengaturan-template-percakapan-form` · 390 | Penghitung "78 / 3.500" duduk sebaris dengan tombol "+ {agen} Nama agen", jauh dari kotak isi. Teks bantu "Variabel yang tersedia: {nama} dan {agen}." mengulang dua tombol tepat di bawahnya |

## Cara menilai

Satu worktree dengan penilaian ruang chat putaran 2 (`2026-11-18-fase2-ruang-chat.md`): API 3191 / web 5191,
`balesin_kd_e2e`, Redis db 11. Layar `inbox-chat-tindakan`, `-alihkan`, `-agen-lain`, `-selesai`, `-template`,
`pengaturan-template-percakapan(-kosong, -form)` + 4 layar penilaian (`template-tidak-cocok`, `template-hapus`,
`tindakan-milik-lain`, `pengaturan-menu`) × 4. Diukur: kontras, target sentuh, teks terpotong, posisi judul di daftar
"/", lebar judul halaman dan letak tombol tambah.

## Tabel nilai

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `inbox-chat-tindakan` (menu) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-chat-alihkan` (dialog) | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 5 | 5 |
| `inbox-chat-agen-lain` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-chat-selesai` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 4 | 5 | **3** | 5 | 5 | 4 | 5 | 5 | 4 | 5 |
| `inbox-chat-template` | 1440 T/G | **3** | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | **3** | 4 | 5 |
| `pengaturan-template-percakapan` | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| `pengaturan-template-percakapan-kosong` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `pengaturan-template-percakapan-form` | 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | **3** | 5 | 5 | 5 | 4 | 4 | 5 |
| `template-hapus` (dialog) | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Menu Pengaturan (baris Template percakapan) | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 5 | 5 |

`inbox-chat-selesai` 390 bernilai 3 di Tipografi karena nama dan nomor terpotong di kepala chat — temuan CH1 di laporan
ruang chat.

## Larangan §3 dan istilah §4

- §3: bersih (ikon Lucide, satu tombol berwarna per dialog, warna token).
- §4: dialog dengan tombol berwarna terakhir dan Batal berbingkai — lolos. "Kembalikan ke antrian", "Tandai selesai",
  "Buka lagi", "Ambil alih" — kata kerja jelas. Rujukan istilah: lihat T1.

## Revisi, berurutan prioritas

### Wajib

**T1. Pisahkan nama "balasan cepat" dari "template WhatsApp"**
— `apps/web/src/i18n/id.ts` (`inbox.quickReplies`, `quickReplies.*`, baris menu Pengaturan), rute
`/pengaturan/template-percakapan`

- Ganti "Template percakapan" → **"Balasan cepat"** di seluruh UI: judul halaman, menu Pengaturan ("Balasan cepat ·
  Balasan siap pakai yang dipanggil dengan "/" di kolom chat · 4 balasan"), judul daftar "/" ("Balasan cepat"), tombol
  "Tambah balasan cepat", kosong "Belum ada balasan cepat", dialog "Ubah balasan cepat", "Hapus balasan cepat /salam?".
  Kata "template" disisakan untuk template pesan WhatsApp (sesi habis, broadcast). Rute boleh tetap (atau
  `/pengaturan/balasan-cepat` dengan pengalihan).
- Kriteria lolos: kata "template" tidak muncul di layar balasan "/" mana pun.

**T2. Judul halaman HP utuh, tombol tambah dekat isi**
— `apps/web/src/features/quick-replies/QuickRepliesPage.tsx`, `QuickReplies.module.css`

- Pindahkan tombol tambah dari kepala halaman ke baris pencarian di kolom isi (kanan kotak cari, 44 px). Di ≤ 640 px
  tombol jadi ikon `plus` 44 × 44 dengan `aria-label`, atau tombol penuh di bawah teks pengantar.
- Kriteria lolos: judul halaman tidak terpotong di 390; di 1440 tombol berada di dalam kolom 88–760.

**T3. Daftar "/" di HP rata satu kolom**
— `apps/web/src/features/inbox/QuickReplyPicker.module.css`

- Di ≤ 640 px susun dua baris: baris 1 = shortcut (mono `--primary`) + judul dipisah spasi tetap; baris 2 = isi, mulai
  di x yang sama dengan shortcut. Di desktop pertahankan kolom tetap.
- Kriteria lolos: di 390 isi semua baris mulai di x yang sama (± 1 px).

**T4. Formulir: penghitung di bawah kotak isi, tanpa teks ganda**
— `QuickRepliesPage.tsx` (dialog formulir)

- Satu baris di bawah kotak isi: kiri "Sisipkan:" + tombol `{nama}` dan `{agen}`, kanan penghitung "78 / 3.500". Hapus
  teks bantu "Variabel yang tersedia: …" (tombolnya sudah menjelaskan). Di 390 tombol boleh turun ke baris berikut,
  penghitung tetap di kanan baris pertama, sejajar tepi kanan kotak isi.
- Kriteria lolos: penghitung berada tepat di bawah kotak isi (≤ 8 px) dan rata kanan dengan kotak isi.

### Saran (tidak menahan)

- **T-S1.** Dialog Tugaskan: cincin pilihan kartu radio yang terpilih terpotong di sisi atas (wadah daftar
  `overflow: hidden`). Beri `padding: 2px` pada wadah atau `outline-offset: -2px`.
- **T-S2.** Daftar "/" dengan "/zzz" di foto tetap menampilkan semua template karena mock `quick-replies` mengabaikan
  `q` (`qa-tester`: buat mock menyaring, lalu foto keadaan "Tidak ada template untuk …").
- **T-S3.** Pada chat selesai di HP, "Buka lagi" hanya ada di menu "⋮". Tampilkan juga di footer (lihat CH-S1 laporan
  ruang chat).

## Bersih-bersih

Worktree dihapus (folder + `git worktree prune`), port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11
`DBSIZE` 0. Berkas repo: laporan ini + 15 screenshot di `docs/design-reviews/2026-11-18-fase2-penanganan-template/`.
Tidak ada kode produk yang diubah, tidak ada commit.
