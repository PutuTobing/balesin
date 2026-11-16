# Audit desain — Tampilan HP penuh (Fase 2 butir 11)

- **Tanggal:** 2026-11-17 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `4e53378` ("feat(web): tampilan HP penuh, Pengaturan → API key & Webhook, revisi notifikasi N1").
- **Acuan:** `docs/DESIGN.md` §2 (HP ≤ 640 px: navigasi bawah, layar bertumpuk, composer menempel & aman dari keyboard,
  target ≥ 44 px), §3, §4, §5.
- **Screenshot:** `docs/design-reviews/2026-11-19-fase2-hp-penuh/` (390 = terang | gelap berdampingan; potongan 360).

## Cara menilai

Worktree terisolasi dari `4e53378`, API **3191**, web **5191**, `balesin_kd_e2e` (migrasi sampai `0022`), Redis **db 11**
(stack QA 3100/5180 tidak disentuh). `pnpm screenshots` **seluruh** daftar layar: **1649 lulus** (2 *flaky*, lulus saat
diulang), 275 layar × 4. Lalu **275 layar × 2 lebar (360 × 780 dan 390 × 844) = 550 audit**: scroll horizontal, elemen
yang keluar layar tanpa wadah gulir, target sentuh < 44 px (dengan pengecualian area tekan `::after` dan isian 42 px di
bingkai 44), teks terpotong, terlihat/tidaknya navigasi bawah. Ditambah uji keyboard (tinggi jendela menyusut 320 px seperti
Android `resizes-content`) dan kepala ruang chat di 360 untuk 4 jenis chat.

## Putusan: REVISI (satu butir kecil)

Hasilnya sangat baik untuk audit lintas 275 layar:

| Yang diukur | Hasil |
|---|---|
| Scroll horizontal | **0** dari 550 |
| Elemen keluar layar (tanpa wadah gulir) | **0** |
| Navigasi bawah | Tampil di semua layar aplikasi; disembunyikan dengan benar di 97 layar: ruang chat & detail bertumpuk (31), setup, masuk, 2FA, undangan, atur ulang password, verifikasi email (66) |
| Layar bertumpuk | Daftar → chat (kembali = tombol & riwayat) → Detail (`&detail=1`, judul "Detail" + kembali); fokus pindah ke judul chat dan kembali ke baris (lolos sejak putaran inbox) |
| Composer + keyboard | Jendela 800 → 480 px: kotak tulis & tombol kirim tetap di dasar (bawah 788 → **468**, jarak 12 px), kepala chat tetap di y 0, dokumen tidak tergulir; riwayat menyusut 602 → 282 px (360). iOS ditangani `useVisualViewportFit` |
| Safe-area | `viewport-fit=cover` + `env(safe-area-inset-*)` di rail, kepala, navigasi bawah, composer, setup, 2FA |
| Target < 44 px | 5 temuan kecil (tabel di bawah) |

**"… sedang disiapkan" (Kontak, Broadcast, Tiket, Laporan) — jujur dan rapi, diterima.** Judul menyebut keadaannya apa
adanya, isi menjelaskan *apa* fiturnya nanti tanpa menjanjikan tanggal, dan **Kontak** memberi jalan keluar nyata ("Buka
Inbox" — data kontak sudah bisa dikelola di panel detail). Ilustrasi berbeda per menu, pusat vertikal, terang & gelap
rapi. Tidak ada tombol palsu. Saran kecil: Broadcast/Tiket/Laporan tanpa aksi apa pun; bila ada pengganti sementara
(mis. Laporan → "Lihat Audit log" untuk Owner), tampilkan.

### Wajib

**H1. Nomor sebagai nama di kepala chat 360 tidak boleh terpotong**
— `apps/web/src/features/inbox/ChatRoom.tsx` (`ChatHeader`), `Chat.module.css`

- Chat dengan kontak tanpa nama + pil "Sesi habis" + "⋮" di 360: judul tampil "**+62 898-7654…**" (133 > 105 px,
  `kepala-chat-tanpa-nama--360-terang.png`). Nomor adalah identitas pelanggan (aturan `contact-identity.ts`: nomor tidak
  boleh hilang); di 390 masih utuh.
- Perbaikan: di ≤ 380 px pil sesi cukup ikon (jam / jam dicoret) 24 × 24 dengan `aria-label` lengkap, atau beri judul
  yang berupa nomor `flex-shrink: 0` dan biarkan pil yang mengecil ke ikon.
- Kriteria lolos: nomor Indonesia utuh di kepala chat 360 untuk chat bernama dan tanpa nama, sesi aktif dan habis.

### Saran (target sentuh kecil, tidak menahan)

| Elemen | Ukuran | Layar | Usulan |
|---|---|---|---|
| Tautan "Atur email pengirim" | 120 × 16 | `tim-tanpa-email` | `min-height: 44px` (pola `.guideLink`) |
| "Tindakan lain" (⋯) webhook | 42 × 44 | `webhook*` | lebar 44 |
| Segmen "Email" / "Teks polos" | ±150 × 42 | `email-pengirim-pratinjau*` | tinggi 44 |
| "Tampilkan password" | 44 × 42 | 47 layar dialog identitas | tinggi 44 (sudah diterima sebelumnya; rapikan bila sempat) |

- **H-S1.** Saat keyboard terbuka di 360, strip "Belum ada yang menangani… [Ambil chat]" (3 baris, ±128 px) memakan hampir
  separuh ruang riwayat (282 px). Ringkas strip menjadi satu baris "Belum ditangani · Ambil chat" selama kotak tulis
  terfokus.

## Tabel nilai (ringkas per kelompok, 360 & 390, terang & gelap)

| Kelompok | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Setup, masuk, 2FA, undangan, password | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Inbox daftar, cari, saring | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| Ruang chat, composer, detail | 5 | 5 | **3** (360) / 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| Kontak/Broadcast/Tiket/Laporan (disiapkan) | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 |
| Lainnya, Pengaturan & semua subhalaman | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 |

## Bersih-bersih

Worktree saya dihapus (folder + `git worktree prune`), port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11
`DBSIZE` 0. Worktree `wt-qa` milik QA dibiarkan. Tidak ada kode produk yang diubah, tidak ada commit.
