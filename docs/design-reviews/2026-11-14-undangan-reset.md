# Penilaian desain — Tim, undangan, lupa/atur ulang password, verifikasi email, pratinjau template

- **Tanggal:** 2026-11-14 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `9ef14f8` ("layar Tim, terima undangan, lupa/atur ulang password, verifikasi email,
  pratinjau template") + `cf3d28e` (dokumen), branch `dev`. Selama penilaian HEAD maju ke `4141fcd`
  (API manajemen pengguna, **0 berkas `apps/web`**), jadi foto tetap mewakili tampilan yang berlaku.
- **Acuan:** `docs/DESIGN.md` §5 (rubrik) dan §3 (larangan), `docs/KONTRAK-API-AUTH.md` (undangan, atur
  ulang password, verifikasi email, pratinjau template), `docs/PENGATURAN-UI.md` §1, standar laporan
  `2026-11-13-auth-fase1.md` dan `2026-11-14-2fa.md`.

## Putusan: REVISI

Pekerjaan ini rapi di banyak tempat: semua layar memakai kerangka halaman masuk yang sudah LOLOS,
token di fragment langsung dibuang, judul difokus tanpa cincin, kerangka undangan CS / lupa password /
Tim / Keamanan **Δ 0 px**, pola kunci `m:ss` dipakai ulang, peringatan "sedang masuk sebagai" tampil
sejak awal (Δ 0), pratinjau email di `iframe sandbox` dengan pilihan Email / Teks polos, dan semua teks
Indonesia. Tidak ada pelanggaran §3. Yang menahan ada tiga, semuanya terukur:

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 10 Kecepatan terasa | 3 | `undangan-wajib-2fa` (Admin/Supervisor) · 390 & 1440 | Kotak "Peran Admin wajib verifikasi dua langkah…" disisipkan **di atas** isian Email setelah data undangan tiba: Email, Nama, Password, Ulangi, dan "Buat akun" melompat **143,5 px** (390) / **123,2 px** (1440). Di 390 subjudul juga 3 baris, kerangkanya 2 |
| 2 | 10 Kecepatan terasa | 3 | `atur-ulang-password-2fa`, `-kode-salah` · 390 & 1440 | Blok 2FA (kotak info + isian kode) disisipkan di atas tombol: "Simpan password baru" melompat **270,6 px** (390) / **250,3 px** (1440). Di 390 semua isian juga turun **20,3 px** (subjudul 3 baris, kerangka 2) — juga tanpa 2FA |
| 3 | 1 Hierarki (+ 9 Kesan di dialog tautan) | 3 | `tim-batalkan`, `tim-tautan-belum-disalin` · 390 & 1440 | Dua tombol **berisi warna** berdampingan di satu dialog: biru `--primary` + merah `--danger-ink` (terang `#1167D8` & `#C03535`, gelap `#4D9BFF` & `#F07070`). Tidak ada satu fokus. Di dialog batalkan, tombol biru terbesar justru "Jangan batalkan" — kebalikan niat orang yang baru menekan "Batalkan". Di dialog tautan ada empat warna peringatan sekaligus (kotak kuning, kotak merah, tombol merah, tombol biru) dan tombol "Kembali" tidak jelas kembali ke mana |

Revisi W1–W3 menutup semuanya; sisanya saran.

## Cara menilai

1. **Foto (terisolasi).** Git worktree sementara dari `cf3d28e` di scratchpad, `pnpm install
   --frozen-lockfile`, stack terpisah: API **3191**, web **5191**, database **`balesin_kd_e2e`**, Redis
   **db 11** (salinan `e2e/stack/env.ts` di worktree dibuat membaca `E2E_DATABASE_NAME`; berkas repo tidak
   diubah). `pnpm screenshots`: **485/485 lulus, 0 ulangan** (121 layar × 4 + sesi). Ke-39 layar baru
   dibuka satu per satu (390 terang|gelap berdampingan 1:1, 1440 per tema), ditambah lembar kontak 82
   layar lama (1440 terang, 390 gelap) untuk regresi.
2. **Ukur.** Spek Playwright di luar repo yang memakai `e2e/capture/screens.ts` + `mocks.ts` apa adanya:
   - audit generik 121 layar × 4 (**484/484 lulus**): scroll horizontal, ukuran & keluarga huruf, kontras
     teks terhadap latar efektif, warna terhitung vs token, teks terpotong, target sentuh di 390;
   - 13 skenario × 4 varian (**52/52 lulus**): kerangka → isi dengan respons API **ditahan lalu dilepas**
     (undangan CS, Admin, sedang masuk; atur ulang dengan/tanpa 2FA; lupa password; verifikasi email; Tim
     berisi & kosong; kartu Email akun), tinggi baris undangan + ukuran tombol, gaya huruf kartu, fokus
     setelah atur ulang berhasil, posisi halaman masuk, warna & fokus tombol dialog batalkan.
3. **Bersih-bersih.** Port 3191/5191 kosong, `balesin_kd_e2e` di-drop (tidak ada database `%kd%`), Redis
   db 11 `dbsize` 0, worktree dihapus (`git worktree list` hanya repo utama). Satu-satunya berkas repo
   yang ditulis: laporan ini.
4. **Kode dibaca seperlunya:** `TeamPage.tsx`, `Team.module.css`, `TeamSkeleton.tsx`, `LinkDialog.tsx`,
   `ConfirmDialog.tsx`, `InvitationPage.tsx`, `AuthLayout.tsx` + `.module.css`, `LinkProblem.tsx`,
   `ResetPasswordPage.tsx`, `EmailCard.tsx`, `EmailTemplatePreview.tsx`, `PasswordStrength.tsx`,
   `router.ts` (loader Tim & Keamanan), `i18n/id.ts` (`invitation`, `forgotPassword`, `resetPassword`,
   `verifyEmail`, `team`, `security.email`, `password`).

### Hasil ukur (fakta)

| Yang diukur | Hasil |
|---|---|
| Scroll horizontal | Tidak ada di 484 foto |
| Ukuran / keluarga huruf | 12 / 13 / 14 / 16 / 20 / 24 saja. Plus Jakarta Sans; JetBrains Mono untuk tautan undangan, kode, dan pratinjau teks polos |
| Warna di luar token | Tidak ada yang baru. Yang tercatat audit hanya warna **di tengah transisi** (tepi isian/kotak saat fokus berpindah, batang meter kekuatan) dan yang sudah diterima (miniatur tema, petak QR). Isi `iframe` pratinjau (email sungguhan, warna email) tidak dihitung |
| Kontras teks aktif terendah | Tidak ada teks aktif < 4,5:1 di layar baru. Di bawah 4,5:1 hanya label nonaktif (tombol hitung mundur, "Simpan" di `-env`, "Aktifkan" saat memuat — sudah diterima) dan menu yang tertangkap saat animasi muncul |
| Target sentuh 390 | Tombol 44 px; isian 42 di bingkai 44 (sudah diterima). Tautan sebaris "Atur email pengirim" 16–18 px (dikecualikan WCAG 2.5.8 karena sebaris, tetapi di kartu Email akun ia satu-satunya aksi — P5). Pilihan "Email / Teks polos" 42 px di bingkai 1 px (setara isian) |
| Baris undangan | Desktop 100–101 px (3 baris teks), 123 px dengan petunjuk "Email gagal terkirim"; tombol 108×36 + 93×36. HP 170–213 px, tombol 158×44 berdua |
| Tim kerangka → isi | Kartu undang Δ 0 (390 & 1440); kartu daftar Δ 0. Baris daftar pertama turun **4,8 px** (1440, lencana jumlah 24 px membuat judul lebih tinggi) / **23,6 px** (390, petunjuk daftar 2 baris, kerangkanya 1). Tim kosong Δ 0 |
| Undangan kerangka → isi | CS: semua isian & tombol **Δ 0** (390 & 1440). Sedang masuk: peringatan dan isian Δ 0. **Admin: Δ 143,5 / 123,2** |
| Atur ulang kerangka → isi | Tanpa 2FA: 1440 Δ 0, **390 Δ 20,3** (semua isian). **Dengan 2FA: tombol Δ 270,6 / 250,3** |
| Lupa password kerangka → isi | Δ 0 (390 & 1440) |
| Verifikasi email kerangka → berhasil | Tombol **+12,3 px** (390) / **−8 px** (1440) |
| Keamanan → kartu Email akun | Kartu 2FA Δ 0; kartu Email Δ 0–0,9, hanya tumbuh ke bawah (paling bawah halaman). Halaman menunggu status email di loader, jadi kerangka Keamanan tampil sampai keduanya tiba (W4 2FA tetap utuh) |
| Halaman masuk | `h1` 274 / 88 (1440 / 390) — sama dengan putaran sebelumnya. Tombol Masuk 570,3 / 379,5 (dulu 538,3 / 339,5) karena tautan "Lupa password?" ditambahkan dengan sengaja; bukan regresi |
| Fokus setelah atur ulang berhasil | Pindah ke halaman masuk dengan pesan dan email terisi, tetapi **`document.activeElement` = `BODY`** (4 varian) |
| Dialog batalkan undangan | Fokus awal di "Jangan batalkan" (aman, benar). Warna: "Batalkan undangan" `#C03535`/`#FFFFFF` 5,52:1 · "Jangan batalkan" `#1167D8`/`#FFFFFF` (terang); `#F07070`/`#0F1620` · `#4D9BFF`/`#0F1620` (gelap) |

## Tabel nilai

Kolom: **1** Hierarki · **2** Konsistensi token · **3** Tipografi · **4** Kerapian · **5** Responsif ·
**6** Keadaan · **7** Aksesibilitas · **8** Bahasa · **9** Kesan profesional · **10** Kecepatan terasa.
Nilai terang = gelap kecuali disebut. **Tebal** = di bawah 4. Kecepatan untuk layar isi diukur dari
perpindahan kerangka → isi layar itu.

| Kelompok layar (berkas screenshot) | Ukuran | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A. Tim** — `tim-daftar`, `-kosong`, `-admin`, `-tanpa-email`, `-terkirim`, `-isian-salah` | 390 / 1440 | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| **B. Tim memuat** — `tim-memuat` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 |
| **C. Dialog tautan** — `tim-tautan` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| **D. Tautan belum disalin** — `tim-tautan-belum-disalin` | 390 / 1440 | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 4 | **3** | 5 |
| **E. Batalkan undangan** — `tim-batalkan` | 390 / 1440 | **3** | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| **F. Pengaturan (Admin)** — `pengaturan-admin` | 390 / 1440 | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |
| **G. Undangan** — `undangan`, `-password-ditolak`, `-sedang-masuk` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| **H. Undangan wajib 2FA** — `undangan-wajib-2fa` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **3** |
| **I. Undangan memuat** — `undangan-memuat` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| **J. Tautan tidak berlaku / dibatasi** — `undangan-tidak-berlaku`, `undangan-terkunci`, `atur-ulang-password-tidak-berlaku` | 390 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 |
| **K. Lupa password** — `lupa-password`, `-terkirim`, `-terkunci`, `-memuat` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 |
| **L. Lupa password tidak tersedia** — `lupa-password-tidak-tersedia` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| **M. Atur ulang tanpa 2FA** — `atur-ulang-password` | 390 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 4 |
| | 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| **N. Atur ulang dengan 2FA** — `atur-ulang-password-2fa`, `-kode-salah`, `-memuat` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **3** |
| **O. Password diganti** — `masuk-password-diganti` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 5 |
| **P. Verifikasi email** — `verifikasi-email-berhasil`, `-tidak-berlaku`, `-memuat` | 390 / 1440 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 4 | 4 |
| **Q. Kartu Email akun** — `keamanan-email-belum`, `-terkirim`, `-terverifikasi` | 390 / 1440 | 4 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `keamanan-email-tanpa-pengirim` | 390 | 4 | 5 | 4 | 5 | 4 | 5 | 5 | 5 | 4 | 5 |
| | 1440 | 4 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| **R. Email pengirim** — `email-pengirim-pratinjau`, `-pratinjau-teks`, `-admin` | 390 / 1440 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 5 |

### Alasan nilai 4 (lolos, belum sempurna)

- **Bahasa 4 / Kesan 4 — G, H, M, N (dan wizard setup yang sudah LOLOS):** "Minimal 10 karakter." tertulis
  dua kali berturut-turut — di petunjuk isian (`PASSWORD_RULES_HINT`) dan di bawah meter kekuatan
  (`t.password.strength.empty`). Terbaca seperti bug. → S1.
- **Hierarki 4 / Kerapian 4 — A:** baris kedaluwarsa memakai "Kirim ulang" primer, jadi ada dua tombol
  biru di layar ("Kirim undangan" + baris itu). Bisa diterima karena memang aksi yang perlu, tetapi
  tidak ideal. Di desktop teks "Batalkan" (tombol ghost) berakhir 17 px sebelum tepi isi kartu, tidak
  segaris dengan tepi kanan "Kirim undangan".
- **Kesan 4 — A:** **jawaban kekhawatiran frontend soal tinggi baris:** 100 px untuk tiga baris (email ·
  peran + status · pengundang + masa berlaku) **diterima**. Ketiganya informasi yang dipakai untuk
  memutuskan kirim ulang/batalkan; memadatkannya ke dua baris di 672 px akan menumpuk status di sebelah
  email yang panjangnya tak tentu. Tidak direvisi. Nilai 4 karena status "kedaluwarsa sejak pukul 07.16"
  tanpa tanggal (hari ini), lihat P6.
- **Kecepatan 4 — B:** daftar turun 4,8 / 23,6 px (→ S3). **J 1440:** dari kerangka (`tall`, logo y 48)
  ke layar tautan tidak berlaku (form di tengah, logo y ±210) seluruh kolom melompat (→ P1). **M 390:**
  Δ 20,3 (ditutup oleh W2). **P:** Δ 12,3 / −8 (→ S4).
- **Bahasa 4 — C, D:** "…lewat jalur yang aman" di teks dialog diulang kotak peringatan "Kirim langsung
  ke orangnya lewat chat pribadi…" (→ S5). **K:** "Periksa email-mu" berdampingan dengan "nama dan
  emailmu" di petunjuk password (→ P4). **L:** judul "Atur ulang password belum tersedia" diulang di
  kalimat pertama isinya (→ S4). **P:** judul "Email sudah terverifikasi" diulang isinya "…sudah
  terverifikasi. Terima kasih!" (→ S4). **R:** email teks polos "password akun Balesin kamu" (→ P7).
- **Tipografi 4 — P:** kata yatim "kasih!" (390) dan "akun." (1440) di baris terakhir — hilang bersama
  teks baru S4. **Q:** kalimat penjelasan kartu Email 14 px, sedangkan deskripsi kartu saudaranya (2FA,
  kode cadangan) 13 px di halaman yang sama (→ S6).
- **Hierarki 4 — Q:** menu menyebut "Email, verifikasi dua langkah, dan kode cadangan", tetapi kartu Email
  ada paling bawah (→ P3). **Responsif 4 — Q tanpa pengirim, 390:** satu-satunya aksi kartu adalah tautan
  sebaris setinggi 18 px (→ P5).
- **Aksesibilitas 4 — O:** fokus jatuh ke `<body>` setelah password diganti (→ S2).
- **Kerapian 4 — F:** keterangan baris Pengaturan: "Untuk undangan tim, reset password, dan notifikasi."
  bertitik, dua baris lain tidak (→ P2).
- **Kesan 4** di layar lain: konsekuensi butir di atas; ilustrasi keadaan di dalam aplikasi masih
  placeholder (`BUTUH-TOBING.md` #5), sama dengan laporan sebelumnya.

## Larangan §3, satu per satu

| Butir | Hasil | Bukti |
|---|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih | Tidak ada `gradient`/`backdrop-filter` baru. Ikon Lucide (salin, peringatan, info, centang lingkaran, panah kembali, perisai) |
| Tombol pill besar, bayangan tebal | Bersih | Tombol radius 6; pil hanya lencana jumlah undangan (24 px) dan titik status. Bayangan hanya `--shadow-2` dialog yang sudah ada |
| Kartu ikon + judul + 1 kalimat berulang | Bersih | Tim: dua kartu dengan isi berbeda (form; daftar berbaris). Keamanan: tiga kartu dengan isi berbeda |
| Teks English nyasar, Lorem, "Welcome back!" | Bersih | "Owner", "Admin", "CS", "password", "email", "clipboard" istilah yang dipakai pengguna. Tidak ada "Anda". Isi `iframe` = email sungguhan berbahasa Indonesia |
| Ukuran font tidak konsisten, jarak acak | Bersih | Skala 12–24 saja; jarak antar-isian sama dengan halaman masuk/wizard. (Selisih 14 vs 13 px di kartu Email dicatat sebagai Tipografi 4, bukan pelanggaran skala) |
| Warna di luar token | Bersih | Lihat "Hasil ukur" |

## Kekhawatiran yang disebut frontend

1. **Baris undangan di desktop agak tinggi.** Terukur 100–101 px (123 px dengan petunjuk gagal kirim).
   **Diterima, tidak direvisi** — alasan di "Kesan 4 — A".
2. **"Minimal 10 karakter." ditulis dua kali (petunjuk + meter), sama dengan wizard setup.** **Diubah untuk
   keduanya** (satu komponen `PasswordStrength`) → S1. Wizard dulu lolos karena hal ini tidak sampai
   menurunkan nilai di bawah 4; sekarang polanya muncul di empat layar dan layak dibereskan sekali.
3. **Pemberitahuan 2FA di `/undangan` muncul setelah data tiba.** **Benar dan menjadi revisi wajib** — Δ
   143,5 / 123,2 px untuk seluruh form → W1.

## Revisi, berurutan dampak

### Wajib (menyebabkan nilai < 4)

**W1. Form undangan diam saat data tiba (Admin/Supervisor)**
— `apps/web/src/features/invitation/InvitationPage.tsx` (`AcceptForm`, `InvitationScreen`),
`apps/web/src/i18n/id.ts` (`invitation.subtitle`), `apps/web/src/features/auth/AuthLayout.module.css`

- Pindahkan `<Notice tone="info">{copy.twoFactor(…)}</Notice>` dari atas isian Email ke **antara
  "Ulangi password" dan tombol "Buat akun"**. Urutan baca jadi lebih tepat juga: pemberitahuan "kamu
  langsung diminta mendaftarkannya setelah akun dibuat" dibaca tepat sebelum menekan tombol.
- Selama memuat (`invitation === null`) render **hanya** isian Email, Nama, Password (+ meter), Ulangi;
  tombol "Buat akun" dan catatan kaki "Undangan berlaku sampai…" baru dirender setelah data tiba. Yang
  tampil di kerangka tidak pernah bergeser; yang bergantung data cukup muncul di bawahnya.
- Subjudul jadi satu kalimat — form sudah menjelaskan sisanya:
  `subtitle: (inviter, role, product) => \`${inviter} mengundangmu sebagai ${role} di ${product}.\``
  dan kerangka `loading={{ subtitleLines: 2 }}` tetap, ditambah tinggi minimum subjudul halaman `tall`
  sama dengan dua baris kerangka:
  ```css
  /* Halaman tautan panjang: subjudul minimal 2 baris supaya isian tidak bergeser saat data tiba. */
  .paneTall .subtitleReserve { min-height: calc(2 * var(--text-14) * var(--leading-text)); }
  ```
  (kelas dipasang pada `<p className={styles.subtitle}>` bila `tall`).

Kriteria lolos: antara `undangan-memuat` dan `undangan-wajib-2fa` (juga `undangan`), posisi y isian Email,
Nama, Password, Ulangi berbeda **≤ 4 px** di 390 dan 1440, terang & gelap (sekarang Δ 143,5 / 123,2). Kotak
2FA tampil di antara "Ulangi password" dan "Buat akun". Tidak ada elemen yang tampil di kerangka lalu
bergeser > 4 px.

**W2. Form atur ulang password diam saat data tiba (dengan & tanpa 2FA)**
— `apps/web/src/features/password-reset/ResetPasswordPage.tsx`, `i18n/id.ts` (`resetPassword.subtitle`)

- Pola yang sama dengan W1: selama memuat render hanya "Password baru" (+ meter) dan "Ulangi password
  baru"; blok 2FA (sudah di posisi yang benar), tombol "Simpan password baru", dan catatan kaki dirender
  setelah `inspect` tiba.
- Subjudul diringkas supaya 2 baris di 358 px untuk alamat email umum:
  `subtitle: (email) => \`Untuk akun ${email}. Semua perangkat yang sedang masuk akan dikeluarkan.\``
  + tinggi minimum dua baris seperti W1.

Kriteria lolos: antara `atur-ulang-password-memuat` dan `atur-ulang-password` / `-2fa`, y isian
"Password baru" dan "Ulangi password baru" berbeda **≤ 4 px** di 390 & 1440 (sekarang Δ 20,3 di 390);
tombol tidak tampil di kerangka sehingga tidak ada lagi lompatan 270,6 / 250,3 px.

**W3. Satu tombol berisi warna per dialog**
— `apps/web/src/components/ui/ConfirmDialog.tsx`, `apps/web/src/features/team/LinkDialog.tsx`,
`i18n/id.ts` (`team.linkDialog`, `team.list.keep`)

- `ConfirmDialog`: bila `confirmVariant === 'danger'`, tombol batal memakai `variant="secondary"` (fokus
  awal tetap di tombol batal — aman). Dialog lain (mis. "Tinggalkan kode cadangan?", konfirmasi
  `secondary`) tidak berubah.
  ```tsx
  <Button ref={cancelRef} variant={confirmVariant === 'danger' ? 'secondary' : 'primary'} onClick={onCancel}>
  ```
  Teks: `team.list.keep` "Jangan batalkan" → **"Kembali"** (tidak lagi memakai kata yang sama dengan
  aksi merusaknya).
- `LinkDialog` saat `confirming`: tombol primer = **`CopyButton` "Salin tautan"** (aksi yang sebenarnya
  dibutuhkan), tombol kedua = `variant="ghost"` dengan kelas teks bahaya (`color: var(--danger-ink)`, seperti
  `.revoke` di `Team.module.css`) berlabel **"Tutup tanpa menyalin"**. Hapus tombol "Kembali". Peringatan
  merah boleh tetap, tetapi `tone="warning"` (kotak kuning di atasnya sudah memakai nada itu; merah
  dicadangkan untuk kegagalan). Setelah tersalin, kembali ke pasangan normal ("Selesai" primer).

Kriteria lolos: di `tim-batalkan` dan `tim-tautan-belum-disalin` (390 & 1440, terang & gelap) tepat **satu**
tombol berlatar `--primary` atau `--danger-ink` per dialog; tidak ada tombol berlabel "Kembali" tanpa
tujuan; fokus awal tetap di aksi aman ("Kembali" di dialog batalkan, "Salin tautan" di dialog tautan).

### Disarankan kuat (tidak memblokir; menaikkan 4 → 5)

**S1. Meter kekuatan tidak mengulang petunjuk** — `apps/web/src/i18n/id.ts` (`password.strength.empty`)
"Minimal 10 karakter." → **"Ketik password untuk melihat kekuatannya."** Berlaku otomatis di wizard setup,
undangan, dan atur ulang password (satu komponen). Kriteria: di `setup-owner*`, `undangan*`,
`atur-ulang-password*` tidak ada kalimat yang tampil dua kali.

**S2. Fokus ke Password setelah password diganti** — `apps/web/src/features/auth/LoginPage.tsx` (penanganan
`login-notice` `password-reset`): saat email sudah terisi dari pesan atur ulang, fokuskan isian Password
(pola yang sama dengan "Kembali ke email dan password"). Kriteria: `masuk-password-diganti`
`document.activeElement` = `input[name=password]` di 4 varian (sekarang `BODY`).

**S3. Kerangka daftar Tim setinggi daftar jadi** — `apps/web/src/features/team/TeamSkeleton.tsx`,
`Team.module.css`: di kartu kedua tambahkan `<Skeleton className={styles.skeletonHintHp} />` (petunjuk 2
baris di HP, pola yang sudah dipakai kartu pertama); dan `.count { height: var(--size-icon-md); min-width:
var(--size-icon-md); }` (20 px) supaya judul tidak lebih tinggi dari judul kerangka (19,2 → 24 px sekarang).
Kriteria: y baris pertama daftar `tim-memuat` → `tim-daftar` berbeda ≤ 4 px (sekarang 4,8 / 23,6).

**S4. Teks layar tautan tanpa pengulangan** — `apps/web/src/i18n/id.ts` (+ kerangka `subtitleLines`)

| Tempat | Sekarang | Ganti |
|---|---|---|
| `verifyEmail.done` | "Email {email} sudah terverifikasi. Terima kasih!" | **"Mulai sekarang, pemberitahuan keamanan dan tautan atur ulang password dikirim ke {email}."** (judul tetap "Email sudah terverifikasi"; kerangka `subtitleLines: 2`, kriteria tombol Δ ≤ 4 px, sekarang 12,3 / −8) |
| `forgotPassword.unavailable` | "Atur ulang password lewat email belum tersedia karena email pengirim belum diatur. Minta Owner atau Admin di tempatmu untuk membantu." | **"Email pengirim di tempatmu belum diatur, jadi tautan atur ulang tidak bisa dikirim. Minta Owner atau Admin untuk membantu."** |

**S5. Dialog tautan tanpa nasihat ganda** — `team.linkDialog.body`: "Kirim tautan ini sendiri ke {email}
lewat jalur yang aman. …" → **"Kirim tautan ini sendiri ke {email}. Tautan hanya ditampilkan sekarang dan
berlaku 72 jam."** (cara kirim yang aman sudah dijelaskan di kotak "Tautan ini setara kunci akses").

**S6. Satu ukuran deskripsi kartu di Keamanan akun** — `apps/web/src/features/security/EmailCard.tsx` /
`Security.module.css`: kalimat "Verifikasi membuktikan…" dan "Email verifikasi belum bisa dikirim…" memakai
gaya deskripsi kartu yang sama dengan kartu 2FA dan kode cadangan (13 px, `--ink-2`). Kriteria: semua
paragraf penjelasan di `keamanan*` 13 px.

### Poles (kerjakan sekalian bila murah)

- **P1.** `LinkProblem`/`LinkFailed` menerima `tall` dan diteruskan dari `InvitationPage` dan
  `ResetPasswordPage`, supaya di desktop logo tidak melompat dari y 48 (kerangka) ke ±210 (tidak berlaku /
  dibatasi).
- **P2.** `settings`/`emailSettings` keterangan baris menu: hapus titik di "Untuk undangan tim, reset
  password, dan notifikasi." (dua baris lain tanpa titik).
- **P3.** `security.menuHint` "Email, verifikasi dua langkah, dan kode cadangan" → **"Verifikasi dua langkah,
  kode cadangan, dan email"** (urutan kartu), atau pindahkan kartu Email ke atas — pilih yang pertama, lebih
  murah dan tidak menyentuh kerangka W4 2FA.
- **P4.** `packages/shared/src/password.ts` `PASSWORD_RULES_HINT` "…nama dan emailmu." → "…nama dan
  email-mu." (sama dengan "email-mu", "password-mu", "email-nya" di tempat lain). Teks ini juga dipakai API
  → minta `backend`.
- **P5.** Kartu Email akun tanpa email pengirim (pengguna dengan izin `settings.email.manage`): ganti tautan
  sebaris "Atur email pengirim" dengan `Button asChild variant="secondary" size="md"` di bawah kalimatnya
  (44 px di HP). Kriteria: target ≥ 44 px di `keamanan-email-tanpa-pengirim` 390.
- **P6.** `team.list.expiredAt` saat tanggalnya hari ini: "kedaluwarsa sejak pukul 07.16" → "kedaluwarsa
  sejak hari ini pukul 07.16" (atau `formatTime` selalu dengan tanggal untuk masa lalu).
- **P7.** Template email (`packages/core/src/mail/templates.ts`, → `backend`): "…password akun Balesin kamu"
  → "…password akun Balesin-mu".
- **P8 (untuk `qa-tester`, bukan desain).** Foto `tim-terkirim` dan `tim-tautan` memperlihatkan "Belum ada
  undangan terbuka" setelah undangan dibuat: tiruan `GET /invitations` tetap kosong saat dimuat ulang.
  Tiruan sebaiknya memuat undangan yang baru dibuat supaya foto mencerminkan aplikasi sungguhan.

## Regresi pada layar yang sudah LOLOS

Tidak ditemukan.

- **Halaman masuk:** `h1` 274 / 88 tetap. Tautan baru "Lupa password?" rata kanan di bawah Password, 24 px
  (desktop) / 44 px (HP), membuat tombol Masuk turun 32 / 40 px — perubahan yang disengaja; semua keadaan
  `masuk*` tetap rapi di lembar kontak.
- **Wizard setup:** meter kekuatan kini komponen bersama `PasswordStrength`; tampilan `setup-owner-kuat` /
  `-lemah` sama (S1 berlaku juga di sini).
- **Keamanan akun:** kartu 2FA dan kode cadangan Δ 0 dari kerangka ke isi (W4 2FA utuh); kartu Email ikut di
  kerangka. `keamanan-terkunci` 390: kotak "Konfirmasi dikunci sementara" tetap di atas navigasi bawah.
- **Pengaturan / Lainnya / Email pengirim / shell Fase 0 / 2FA:** lembar kontak 82 layar (1440 terang, 390
  gelap) tidak berubah selain tambahan yang disengaja (baris Tim, kartu Pratinjau email, catatan Admin).
  Audit generik tanpa scroll horizontal, teks terpotong, atau warna baru di luar token.

## Syarat lolos putaran 2

1. W1–W3 memenuhi kriteria lolosnya masing-masing.
2. `pnpm screenshots` dipotret ulang; kelompok D, E, H, M, N dinilai ulang penuh (ukur ulang kerangka →
   isi dengan respons ditahan, dan warna tombol dialog), sisanya dicek regresi lewat lembar kontak.
3. Semua kriteria ≥ 4 di semua layar, tanpa pelanggaran §3.

S1–S6 murah dan langsung terasa; sebaiknya ikut di putaran yang sama. P1–P7 boleh menyusul (P4 dan P7 lewat
`backend`, P8 lewat `qa-tester`).
