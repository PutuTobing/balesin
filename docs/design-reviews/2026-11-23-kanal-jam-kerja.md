# Penilaian desain — Channel lain, inbox multi-channel, Jam kerja & alokasi, saklar "Tersedia"

- **Tanggal:** 2026-11-19 · **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** HEAD `15d977b` (UI ada di `9aeb2f1`).
- **Cara:**
  - Worktree terisolasi dari HEAD: API 3191 / web 5191, `balesin_kd_e2e` migrasi sampai `0030`, Redis db 11, 2 worker.
  - 13 layar `e2e/capture/screens-kanal.ts` × 390/1440 × terang/gelap.
  - Foto tinggi tambahan (390 × 2600/5200, 1440 × 2000/3600), karena halaman Pengaturan menggulir di dalam kontainer
    sehingga `fullPage` hanya memotret satu layar.
  - Audit terukur di 360/390/1440, terang/gelap: kontras teks, target sentuh sampai 4 tinggi layar ke bawah, teks
    terpotong, scroll horizontal.
- **Screenshot:** `docs/design-reviews/2026-11-23-kanal-jam-kerja/`.

## Putusan: REVISI

Fondasinya benar dan aman:
- Rahasia tidak pernah ditampilkan lagi (token "••••Xk2Q").
- Wizard Telegram 3 langkah jelas dan menyebut bentuk token.
- Email punya status verifikasi pengirim yang terlihat. "Verifikasi pengirim gagal — alamat pengirim bisa palsu. Jangan
  proses permintaan sensitif tanpa konfirmasi lain." adalah peringatan yang tepat di tempat yang tepat.
- Versi HTML email dibuka di dialog terpisah dengan penjelasan "mode aman".
- Messenger/IG jujur soal App Review dan dibuat nonaktif.
- Pesan otomatis meminta konfirmasi identitas.

Audit:
- Tidak ada teks < 4,5:1.
- Tidak ada scroll horizontal.
- Tidak ada target < 44 px di layar baru.
- Token warna/spasi bersih: tidak ada hex/rgba atau spasi di luar token di `Connections.module.css`,
  `EmailMessage.module.css`, `Workspace.module.css`.

Yang menahan adalah kerapian tata letak dan kejelasan keadaan:
- ikon channel di daftar chat memecah baris;
- saklar "Tersedia" hanya ikon;
- baris jam kerja di 1440 terbelah;
- daftar agen tidak konsisten dan bisa menampilkan keadaan yang bertentangan;
- detail channel di HP memecah nilai panjang;
- beberapa teks salin-tempel dan satu kata Inggris (§3).

| # | Kriteria | Nilai | Layar | Sebab (terukur) |
|---|---|---|---|---|
| 1 | 4 Kerapian, 9 Profesional | 2 | Daftar chat (`inbox-*`) · 390 & 1440 T/G | Ikon channel (Telegram/Email) jatuh ke baris sendiri di tengah baris meta, lalu nama channel di baris berikutnya ("@andika_dps · Belum dilayani ·" / ikon / "Bot CS Maju Jaya"). Baris Telegram/Email ±1,6× lebih tinggi dari baris WhatsApp |
| 2 | 1 Hierarki, 7 Aksesibilitas, 9 Profesional | 2 | `inbox-tersedia` · 390 & 1440 | Saklar "Tersedia" hanya ikon orang hijau (`UserCheck`) di samping ikon saring. Keadaan hanya terbaca lewat `aria-label`/tooltip. Agen tidak tahu ia sedang menerima chat otomatis atau tidak |
| 3 | 4 Kerapian | 2 | `jam-kerja` · 1440 T/G | Jam mulai di x≈250, "–" di x≈370, jam selesai di x≈720. Celah ±350 px membuat jam selesai terbaca seperti kolom lain |
| 4 | 4 Kerapian, 8 Bahasa | 3 | Daftar agen di `jam-kerja` · 390 & 1440 | Baris Rina/Sari: kotak centang turun ke baris kedua. Baris Made/Citra: kotak di kanan. Rina tampil "✓ Tersedia" **dan** "✓ Jangan beri chat otomatis" sekaligus |
| 5 | 3 Tipografi, 4 Kerapian | 3 | `channel-email`, `-messenger`, `-telegram` · 390 | Isian dua kolom memecah nilai: ":993" mulai di baris baru, "," sendirian satu baris di daftar field Messenger, alamat webhook 5 baris di setengah lebar |
| 6 | 1 Hierarki, 4 Kerapian | 3 | `channel-lain` · 390 & 1440 | Ilustrasi "Belum ada nomor WhatsApp" memenuhi layar pertama (±470 px di 390), padahal 3 channel lain sudah terhubung. Judul "Tambah channel" menempel ±8 px di bawah baris Messenger tanpa garis/jarak |
| 7 | 8 Bahasa (§3) | 3 | Wizard Email/Messenger, detail Messenger, konfirmasi pesan otomatis | "mis. "Bot Telegram CS"" muncul di wizard Email dan Messenger. Judul peringatan diulang di kalimat pertamanya. "**Field** yang dilanggan" (Inggris, dan "dilanggan" tidak baku). Dialog konfirmasi memberi dua instruksi beruntun dan menyebut "nomor resmi" untuk pesan yang juga terkirim ke Telegram/email |

## Tabel nilai

T/G = terang dan gelap bernilai sama kecuali disebut.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `channel-lain` | 1440 T/G | **3** | 5 | 5 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| | 390 T/G | **3** | 5 | 4 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| `channel-lain-kosong` | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-telegram-baru` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `channel-email-baru` | 390 · 1440 T/G | 5 | 5 | 4 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| `channel-messenger-baru` | 390 · 1440 T/G | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |
| `channel-telegram` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | 4 | 5 | 5 | 5 | 4 | 4 | 5 |
| `channel-email` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | **3** | 5 | 5 | 5 | 4 | **3** | 5 |
| `channel-messenger` | 1440 T/G | 4 | 5 | 4 | 4 | 5 | 5 | 5 | **3** | 4 | 5 |
| | 390 T/G | 4 | 5 | **3** | **3** | 5 | 5 | 5 | **3** | **3** | 5 |
| Daftar chat multi-channel (`inbox-tersedia`) | 390 · 1440 T/G | **3** | 5 | 4 | **2** | 5 | 5 | **3** | 5 | **2** | 5 |
| `inbox-telegram` | 390 · 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| `inbox-email` | 390 · 1440 T/G | 4 | 5 | 5 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| `inbox-email-html` | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `jam-kerja` | 1440 T/G | 4 | 5 | 5 | **2** | 5 | 4 | 5 | 4 | **3** | 5 |
| | 390 T/G | 4 | 5 | 5 | **3** | 5 | 4 | 5 | 4 | **3** | 5 |
| `jam-kerja-konfirmasi` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **3** | 4 | 5 |

Catatan nilai:
- `inbox-telegram`/`inbox-email` mewarisi butir 1 dari daftar chat di 1440. Di 390, chat terbuka sendiri.
- Kriteria 6 `jam-kerja` bernilai 4: keadaan kosong/gagal daftar agen ada di teks (`agentsEmpty`, `agentsFailed`)
  tetapi belum difoto.

## Larangan §3 dan istilah §4

- **§3 dilanggar sekali:** "Field yang dilanggan" (English nyasar) di detail Messenger/Instagram (K7).
- "app password" di pengantar Email perlu padanan Indonesia (K7).
- "Page Access Token", "App Secret", "Verify token" diterima: nama isian resmi di dasbor Meta yang harus dicocokkan
  pengguna, dan sudah dipakai di wizard WhatsApp yang lolos.
- Selain itu bersih:
  - Ikon Lucide (Instagram memakai `Camera`, bukan logo merek).
  - Warna dari token (`--success-ink`, `--danger-ink`, `--warning-ink`).
  - Tanpa gradien.
  - Satu tombol berwarna per kartu/dialog.
- Empat kartu "Hubungkan …" (ikon + judul + 1 kalimat) diterima: kartu itu pemilih jenis dan dibedakan lencana "Butuh
  App Review Meta". Jangan tambah kartu serupa di tempat lain.
- §4:
  - "kamu/-mu" konsisten.
  - "Owner dan Admin" sudah benar.
  - Tombol berwarna terakhir di dialog konfirmasi (atas di HP), sudah benar.
  - Di **halaman** wizard HP urutannya "Batal" lalu "Hubungkan" (berwarna di bawah). §4 hanya mengatur dialog. Lihat
    saran K-S6.

## Revisi

### Wajib (urut prioritas)

**K1. Ikon channel sebaris dengan nama channel di daftar chat** — `apps/web/src/features/inbox/ConversationItem.tsx`
(blok `.metaRest`), `ConversationList.module.css` (`.meta`, `.metaRest`, `.metaChannelIcon`)

- Penyebab: `.meta` memakai `white-space: pre`, `.metaRest` tidak `nowrap`, dan `Icon` dirender sebagai blok.
- Perbaikan:
  - Bungkus ikon + nama channel dalam `<span className={styles.metaChannel}>` dengan
    `display: inline-flex; align-items: center; gap: var(--space-4); white-space: nowrap; min-width: 0`.
  - `.metaRest { display: inline-flex; align-items: center; min-width: 0; overflow: hidden; }`. Nama channel di span
    sendiri dengan `overflow: hidden; text-overflow: ellipsis`.
  - Ikon 16 px, `flex: none`, warna `--ink-2`. Hapus `vertical-align: -3px`.
- Kriteria lolos:
  - Di 390 dan 1440 baris Telegram/Email setinggi baris WhatsApp (±1 px).
  - Baris meta tetap satu baris, dengan bagian akhir berelipsis bila sempit.

**K2. Saklar "Tersedia" yang terbaca tanpa hover** — `apps/web/src/features/workspace/AvailabilityToggle.tsx`,
`Workspace.module.css` (`.availability`)

- Ganti `IconButton` dengan tombol ber-teks `role="switch"` + `aria-checked`:
  - Bulatan 8 px (`--success` saat aktif, `--ink-2` berbingkai saat mati).
  - Teks **"Tersedia"** / **"Tidak tersedia"**, 13 px.
  - Tinggi `--size-touch`, radius pill, bingkai `--line`, latar `--surface`.
- Dikecualikan Owner/Admin: tombol nonaktif bertuliskan **"Tidak ikut pembagian"** dengan `title` berisi alasannya.
- Di HP lebar boleh dipadatkan menjadi bulatan + "Tersedia" (tanpa ikon orang). Tetap ≥ 44 × 44.
- Kriteria lolos: di `inbox-tersedia` 390 dan 1440, keadaan ketersediaan terbaca sebagai teks di kepala daftar chat.

**K3. Jam mulai dan selesai berdampingan di 1440** — `apps/web/src/features/departments/Departments.module.css`
(`.day`, ±baris 229)

- Grid `8rem minmax(0, 7rem) auto minmax(0, 7rem)` meregang di kartu lebar. Tambahkan `justify-content: start;` pada
  `.day`, atau ganti dengan `grid-template-columns: 8rem 7rem 1rem 7rem`.
- Komponen ini juga dipakai dialog Departemen. Pastikan di sana tetap rapi.
- Kriteria lolos: di `jam-kerja` 1440 jarak "–" ke jam selesai ≤ 12 px, sama dengan jarak jam mulai ke "–".

**K4. Daftar agen: satu tata letak, tanpa keadaan bertentangan** — `WorkspaceSettingsPage.tsx` (daftar agen),
`Workspace.module.css` (`.agent`, `.agentToggles`)

- Tata letak:
  - `.agent { display: grid; grid-template-columns: minmax(0, 1fr) auto; }` di ≥ 641 px. Kontrol selalu di kanan.
  - `.agentMeta` satu baris berelipsis.
  - Di ≤ 640 px kontrol selalu di baris kedua, untuk semua agen.
- Kontrol: ganti dua kotak centang ("Tersedia" + "Jangan beri chat otomatis") dengan satu sakelar positif **"Ikut
  pembagian otomatis"**. Status ketersediaan tampil sebagai teks di meta: "Tersedia" (`--success-ink`) / "Tidak
  tersedia" (`--ink-2`) / "Tidak ikut pembagian".
- Bila Owner/Admin memang perlu mengubah "Tersedia" milik agen lain, jadikan kontrol kedua yang **nonaktif** saat agen
  tidak ikut pembagian.
- Kriteria lolos:
  - Di 1440 keempat baris contoh punya kontrol di posisi x yang sama.
  - Tidak ada baris yang menampilkan "Tersedia" dan "dikecualikan" sama-sama tercentang.

**K5. Detail channel di HP: satu kolom, nilai panjang utuh** — `channels/connections/ConnectionPage.tsx` (`Fact`,
daftar `subscribeFields`), `Connections.module.css` (`.row` ±baris 195, `@media` ±baris 381)

- Di `@media (max-width: 640px)`: `.row { grid-template-columns: minmax(0, 1fr); }`. Satu fakta per baris.
- IMAP: jangan gabung host, keamanan, username, dan folder dalam satu kalimat bertitik tengah. Tampilkan
  `mail.majujaya.co.id:993` (mono) di baris pertama, lalu "SSL/TLS · cs@majujaya.co.id · folder INBOX" di baris kedua
  (`--ink-2`, 13 px).
- Field webhook Messenger/IG: render sebagai `<ul>` satu field per baris (mono 13 px) atau chip kecil, **tanpa koma**.
- Alamat webhook: lebar penuh, `overflow-wrap: anywhere`, tombol "Salin" sejajar kiri dengan teks (lihat F-S12 di
  laporan Fase 5).
- Kriteria lolos: di `channel-email`, `-messenger`, `-telegram` 390 tidak ada baris yang dimulai tanda baca (":", ",")
  dan alamat webhook ≤ 3 baris.

**K6. Halaman Channel: channel yang ada dulu, WhatsApp kosong jadi ringkas** — `channels/ChannelsPage.tsx`,
`channels/connections/ConnectionsSection.tsx`, `Connections.module.css` (`.addTitle` ±baris 55)

- Bila sudah ada channel lain, keadaan kosong WhatsApp jangan tampil sebagai ilustrasi layar penuh. Jadikan baris
  ringkas di daftar yang sama:
  - Ikon WhatsApp generik (`MessageCircle`).
  - Teks "WhatsApp · Belum terhubung".
  - Tombol berbingkai "Hubungkan nomor".
- Ilustrasi besar hanya untuk instalasi tanpa channel sama sekali (`channel-lain-kosong`).
- Jarak daftar → "Tambah channel": `margin-top: var(--space-24)` plus garis bawah pada baris terakhir daftar, atau
  pisahkan "Tambah channel" ke kartu sendiri.
- Kriteria lolos:
  - Di `channel-lain` 390 baris channel pertama terlihat di layar pertama (tepi atas ≤ 300 px).
  - Di 1440 ada ≥ 24 px antara baris Messenger dan "Tambah channel".

**K7. Teks** — `apps/web/src/i18n/id.ts` (blok channel ±baris 2925–3030; `workspace` ±baris 1520)

- `nameHint`: buat per jenis.
  - Telegram: "mis. "Bot Telegram CS"".
  - Email: **"mis. "Email CS""**.
  - Messenger: **"mis. "Messenger Maju Jaya""**.
  - Instagram: **"mis. "Instagram Maju Jaya""**.
  - Atau netral: **"Nama yang tampil di inbox dan saringan."**
- Peringatan Messenger/IG (wizard dan detail): judul tetap "Butuh App Review Meta". Isinya jangan mengulang judul:
  **"Meta harus menyetujui izin pages_messaging untuk aplikasimu. Channel dibuat nonaktif; aktifkan setelah disetujui
  dan tes koneksi berhasil."**
- `subscribeFields`: "Field yang dilanggan" → **"Event webhook yang dicentang di Meta"**.
- `emailIntro`: "pakai app password" → **"pakai sandi aplikasi (app password)"**.
- `trustedHint`: hapus "Opsional." di awal (label sudah bertanda "Opsional").
- `autoConfirmBody` (konfirmasi pesan otomatis): **"Pesan ini dikirim otomatis ke pelanggan baru di semua channel."**
  Hapus "Masukkan password dan kode verifikasi untuk melanjutkan.", karena dialog identitas sudah menulis "Konfirmasi
  dulu bahwa ini memang kamu."
- Kriteria lolos:
  - Tidak ada "Bot Telegram CS" di wizard Email/Messenger.
  - Tidak ada kata "Field" di UI.
  - Judul peringatan tidak diulang di kalimat pertama.

**K8 (`qa-tester`). Bukti foto identitas channel** — `e2e/capture/mocks-inbox.ts` (mock `GET /contacts/:id` ±baris 761),
`e2e/capture/screens-kanal.ts`, `e2e/capture/capture.spec.ts`

- Mock kontak lengkap tidak meneruskan `channelHandle`/`channelType`. Akibatnya kepala chat Telegram hanya
  bertuliskan "Telegram" (tanpa "@andika_dps"), panel detail tanpa handle, dan Email bertuliskan "Belum diisi" untuk
  kontak yang datang lewat email. Kodenya (`contactIdentity`) sudah mendukung handle. Lengkapi mock, lalu foto ulang.
- `inbox-telegram` gagal difoto di 390 (2 dari 2 percobaan, terang & gelap). Penyebab: `waitFor` cocok dengan cuplikan
  di daftar yang tersembunyi. Pakai `'text=… >> visible=true'`.
- `fullPage: true` tidak berguna di halaman Pengaturan karena yang menggulir kontainer dalam: foto `jam-kerja` dan
  `channel-email-baru` terpotong di layar pertama. Tambah opsi `tall: true` (viewport setinggi isi) di `capture.spec.ts`.
- Kriteria lolos:
  - `inbox-telegram` 390/1440 menampilkan "@andika_dps · Telegram" di kepala chat.
  - `inbox-email` menampilkan "rudi.hartono@gmail.com" di kepala chat dan panel detail.

### Saran (tidak menahan)

- **K-S1. Iframe HTML email.**
  - Isi email tampil dengan font bawaan peramban (Times) dan kotak putih terang di mode gelap.
  - Sisipkan `<style>` dasar di `srcdoc` sebelum isi email:
    `body{margin:12px;font:14px/1.45 system-ui,sans-serif;color:#14202E;background:#FFFFFF}`. Warna literal di sini
    sengaja meniru `--ink`/`--surface` terang, karena iframe tidak mewarisi CSS variables.
  - Tetap putih di mode gelap (email dirancang untuk latar putih), tetapi beri label kecil di atas iframe: "Tampilan
    asli email".
  - Kurangi tinggi iframe ke tinggi isi (maks 70vh) supaya tidak ada bidang putih kosong ±700 px.
- **K-S2. Kepala dan composer email.**
  - Placeholder composer email "Tulis pesan…" → **"Tulis balasan email…"**.
  - Tampilkan subjek balasan ("Re: Tagihan November tidak bisa dibuka") sebagai baris kecil di atas composer.
- **K-S3. Halaman Jam kerja.**
  - Ada tiga tombol berwarna "Simpan" (satu per kartu). Tampilkan berwarna hanya bila kartunya diubah. Selain itu
    berbingkai, atau nonaktif dengan teks "Tersimpan".
  - Teks bantuan "Kapasitas per agen" terjepit selebar isian (3 baris, pola F-S8 CSAT). Biarkan selebar kartu.
  - Pesan otomatis: kotak centang biru selebar penuh 'Kirim pesan "Sapaan (dalam jam kerja)"' lalu label "Isi pesan:
    Sapaan (dalam jam kerja)" mengulang nama. Jadikan judul kecil "Sapaan (dalam jam kerja)" dengan sakelar "Aktif" di
    kanan, lalu textarea berlabel "Isi pesan".
  - Kotak hari bergaya ubin biru terisi ×6 terlalu berat. Kotak centang biasa tanpa latar cukup.
- **K-S4. Detail Email.**
  - Kotak merah "Username atau password IMAP ditolak." di kartu Koneksi belum memberi jalan keluar, sedangkan versi di
    Tes koneksi sudah. Samakan: **"Username atau password IMAP ditolak. Periksa sandi aplikasi, lalu Ubah pengaturan."**
    dengan tautan ke "Ubah pengaturan".
- **K-S5. Detail Telegram.**
  - Status webhook "Terpasang · 14 Nov 2026, 11.12" berdampingan dengan tombol "Pasang webhook". Saat sudah terpasang,
    tulis **"Pasang ulang webhook"**.
  - Langkah wizard "kirim /newbot" sebaiknya `/newbot` dalam huruf mono.
  - "Webhook dipasang otomatis bila alamat server https publik" → **"Webhook dipasang otomatis bila server bisa diakses
    publik lewat https."**
- **K-S6. Urutan tombol halaman wizard di HP.** "Batal" di atas, "Hubungkan" di bawah. Di dialog (§4) yang berwarna di
  atas. Samakan halaman wizard dengan pola dialog (`flex-direction: column-reverse` di ≤ 640 px) atau catat pengecualian
  untuk halaman di DESIGN.md §4.
- **K-S7.** Daftar channel: meta Messenger terpotong "ID Halaman Facebook 104…" di 390. Pendekkan menjadi
  **"Messenger · Halaman 104523987612345"**.
- **K-S8.** Ikon WhatsApp di daftar chat: bila organisasi punya lebih dari satu jenis channel, tampilkan ikon untuk
  **semua** jenis termasuk WhatsApp. Sekarang hanya Telegram/Email yang berikon, sehingga baris WhatsApp terlihat
  "kurang satu elemen".

## Bersih-bersih

- Worktree dihapus (folder + `git worktree prune`; `git worktree list` hanya repo utama).
- Port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0, folder media `balesin-e2e-media-3191` dihapus.
- Berkas repo:
  - laporan ini + 24 screenshot;
  - bagian "Putaran 2" laporan Fase 5 (+14 `p2-*.png`);
  - bagian "Putaran 3" laporan broadcast (+2 `p3-*.png`).
- Tidak ada kode produk yang diubah, tidak ada commit.

---

# Putaran 2

- **Tanggal:** 2026-11-19 · **Penilai:** `kritikus-desain` · **Putaran:** 2
- **Kode yang dinilai:** `b785c4f` (revisi K1–K8). HEAD sekarang `5470c29`, tetapi commit itu tidak menyentuh berkas
  temuan di bawah (`ChatRoom.tsx`, `Connections.module.css`, `EmailMessage.*`, `contact-identity.ts`). Temuan berlaku
  untuk HEAD.
- **Cara:**
  - Worktree terisolasi dari `b785c4f`: API 3191 / web 5191, `balesin_kd_e2e`, Redis db 11.
  - 14 layar `screens-kanal.ts` + `tiket-*` + `broadcast-*` × 390/1440 × terang/gelap: 85/85 lulus.
  - Audit terukur di 360/390/1440 (terang, plus gelap di 390/1440) untuk 19 layar: kontras teks, ukuran huruf,
    target sentuh, scroll horizontal, posisi isian jam/sakelar/baris chat. 96/96 lulus.
  - Foto tinggi `broadcast-berjalan` (daftar penerima) dan `departemen-ubah` (K3 di dialog).
- **Screenshot:** berkas berawalan `p2-` di `docs/design-reviews/2026-11-23-kanal-jam-kerja/`.

## Putusan putaran 2: REVISI (tiga butir kecil, satu di antaranya regresi)

K1–K8 semuanya lolos. Hasil audit:
- tidak ada teks < 4,5:1;
- tidak ada scroll horizontal di 360, 390, maupun 1440;
- tidak ada target sentuh baru < 44 px (isian 42 px dalam bingkai 44 sudah diterima sejak Fase 1).

Yang menahan:
1. Usaha K-S6 membuat tombol halaman wizard di HP jadi dua balok setinggi 96 px yang berdampingan (K9).
2. Kepala chat desktop menyebut channel dua kali (K10). Ini baru terlihat setelah mock K8 dilengkapi.
3. Label "Tampilan asli email" menempel ke bingkai (K11).

| Butir | Hasil (terukur) | Status |
|---|---|---|
| **K1** ikon channel sebaris | Baris Telegram 85 px, Email 84 px, WhatsApp 83–86 px (390 & 1440). Ikon `Send`/`Mail` sebaris dengan nama channel; di 1440 ujungnya berelipsis ("Bot CS Maju …") | Lolos |
| **K2** saklar Tersedia ber-teks | `role="switch"`, 94 × 44 px, bulatan hijau + "Tersedia" di kepala daftar chat (390 & 1440, terang & gelap) | Lolos |
| **K3** jam berdampingan | `jam-kerja` 1440: jam mulai x 249–361, jam selesai x 385–497. Celah 24 px dengan "–" di tengah (±12 px tiap sisi). Dialog Departemen ikut rapi (657–769 / 793–905) | Lolos |
| **K4** daftar agen | Grid: kedua sakelar di x 459 dan 702 untuk keempat agen. Sakelar "Ikut pembagian otomatis" positif. "Tersedia" nonaktif saat agen tidak ikut (Rina). Status jadi teks di meta (hijau "Tersedia" / "Tidak tersedia" / "Tidak ikut pembagian"). Di 390 kontrol di baris kedua untuk semua agen. Tidak ada keadaan bertentangan | Lolos |
| **K5** detail channel HP | Satu kolom. IMAP: `mail.majujaya.co.id:993` (mono), lalu "SSL/TLS · cs@majujaya.co.id · folder INBOX". Event webhook Messenger berupa daftar mono tanpa koma. Alamat webhook 2 baris (Messenger & Telegram). Tidak ada baris yang dimulai tanda baca | Lolos |
| **K6** halaman Channel | WhatsApp menjadi kartu ringkas "WhatsApp · Belum terhubung" + "Hubungkan nomor" berbingkai. Baris channel pertama di 390 mulai ±310 px. Kartu WhatsApp ringkas (±125 px) dan baris Telegram sudah tampil di layar pertama; selisih 10 px dari target ≤ 300 diterima. Di 1440 ada garis + ±28 px sebelum "Tambah channel" | Lolos |
| **K7** teks | `nameHint` per jenis ("mis. "Email CS"", "mis. "Messenger Maju Jaya""). Isi peringatan tidak mengulang judul. "Event webhook yang dicentang di Meta". "sandi aplikasi (app password)" di pengantar. `trustedHint` tanpa "Opsional.". Konfirmasi pesan otomatis: satu kalimat + "Konfirmasi dulu bahwa ini memang kamu." | Lolos |
| **K8** foto identitas | `inbox-telegram` 390 lulus difoto. Kepala chat "Telegram · @andika_dps", panel "@andika_dps". `inbox-email` "rudi.hartono@gmail.com" di kepala chat dan panel. Foto `tall` memotret `jam-kerja` dan wizard Email utuh | Lolos |
| K-S2 composer email | "Tulis balasan email…". Baris subjek balasan di atas composer belum ada | Sebagian |
| K-S5 detail Telegram | "Pasang ulang webhook", `/newbot` mono, kalimat webhook diperbaiki | Lolos |
| K-S6 urutan tombol wizard HP | Dikerjakan, tetapi menimbulkan regresi K9 | Regresi |
| K-S7 meta Messenger | "Messenger · Halaman 104523987612345" utuh di 390 | Lolos |
| K-S1 iframe email | Label "Tampilan asli email" ada, tetapi menempel (K11). Isi masih Times, iframe masih ±512 px dengan bidang putih kosong | Sebagian |
| K-S3, K-S4, K-S8 | Belum dikerjakan | Tetap saran |

**Broadcast sekilas (sudah LOLOS, cek regresi):**
- **BC-S9:** judul kotak "Perlu persetujuan Owner atau Admin"; lencana kepala tetap "Menunggu persetujuan".
- **BC-S12:** nomor penerima "+62 812-3456-7890".
- **BC-S13:** judul "Penerima" sejajar bawah dengan saringan "Tampilkan".
- Kesimpulan: ketiganya lolos. Petak hasil, biaya, dan alasan gagal di 1440 tidak berubah. Tidak ada regresi
  (`p2-broadcast-persetujuan--390-terang.png`, `p2-broadcast-berjalan-tinggi--390-terang.png`).

### Wajib

**K9. Regresi: tombol halaman wizard di HP berdampingan setinggi 96 px** —
`apps/web/src/features/channels/connections/Connections.module.css:438-448` (dalam `@media (max-width: 640px)`
baris 413)

- Terukur di `channel-telegram-baru`, `-messenger-baru`, dan `-email-baru` (390 & 360, terang & gelap):
  - "Hubungkan" berukuran **179 × 96 px** (360: 164 × 96).
  - "Batal" ada di sebelah kirinya, sama tinggi.
  - Hasilnya dua balok raksasa (`p2-channel-telegram-baru--390-*.png`).
- Penyebab:
  - `.actions` diberi `flex-direction: column-reverse`, tetapi `flex-wrap: wrap` (baris 299) dan
    `.actions > * { flex: 1 1 100%; }` (baris 438–442) masih berlaku.
  - Dalam arah kolom, `flex-basis: 100%` menjadi **tinggi**, lalu `wrap` membuat setiap tombol menjadi kolom sendiri.
- Perbaikan, di blok `@media` yang sama:
  ```css
  .actions {
    flex-direction: column-reverse;
    flex-wrap: nowrap;
  }
  .actions > * {
    flex: none;
    width: 100%;
  }
  ```
  Pertahankan `flex: 1 1 100%` hanya untuk `.actionsStart > *` dan `.actionsSplit > *`, yang tetap baris.
- Kriteria lolos:
  - Di 360/390 "Hubungkan" 100% lebar × 44 px, di atas "Batal" yang juga 100% × 44 px, jarak `--space-8`.
  - Di 1440 tetap sebaris di kanan (sekarang 112 × 36, tidak berubah).

**K10. Kepala chat desktop menyebut channel dua kali** — `apps/web/src/features/inbox/ChatRoom.tsx:229-233`

- Terukur di `inbox-telegram` 1440: "Telegram · @andika_dps · **dari Telegram**". Di `inbox-email` 1440: "Email ·
  rudi.hartono@gmail.com · **dari Email**".
- Penyebab: `sub` berisi `CHANNEL_TYPE_LABELS[channelType]` **dan** `untrustedNameLabel(...)`. Untuk channel
  non-WhatsApp, label kedua juga "dari <channel>".
- Perbaikan: bila penanda nama tidak tepercaya ikut tampil (desktop, `!onOpenDetail`), jangan tulis jenis channel di
  depannya:
  ```ts
  const showUntrusted = untrusted && !onOpenDetail;
  const sub = [
    channelType !== 'whatsapp' && !showUntrusted ? CHANNEL_TYPE_LABELS[channelType] : null,
    identity.handle,
    showUntrusted ? untrusted : null,
  ].filter(Boolean);
  ```
- Hasil:
  - Desktop: "@andika_dps · dari Telegram" / "rudi.hartono@gmail.com · dari Email".
  - HP tetap "Telegram · @andika_dps".
  - Kontak yang sudah diberi nama oleh tim (tanpa penanda) tetap "Telegram · @andika_dps".
- Kriteria lolos: tidak ada nama channel yang muncul dua kali di subjudul kepala chat, di 390 maupun 1440.

**K11. Label "Tampilan asli email" menempel ke bingkai** — `apps/web/src/features/inbox/EmailMessage.tsx:111`,
`EmailMessage.module.css:87-91`

- Terukur di `inbox-email-html` 1440 terang/gelap: teks label 0 px dari garis kiri dan atas `.frameWrap`. Di dalam
  bingkai ia tidak punya padding, sedangkan isi email di bawahnya menjorok ±12 px.
- Perbaikan, pilih salah satu:
  - (disarankan) pindahkan `<p className={styles.frameLabel}>` ke **atas** `<div className={styles.frameWrap}>`,
    sejajar tepi kiri dialog. Ganti `margin-bottom` dengan `margin-top: var(--space-16)` dan hapus `margin-top` di
    `.frameWrap` (baris 57) supaya jaraknya tidak dobel.
  - atau jadikan pita kepala di dalam bingkai:
    `padding: var(--space-8) var(--space-12); margin: 0; border-bottom: 1px solid var(--line); background: var(--surface-2);`.
- Kriteria lolos: ada ≥ 8 px antara teks label dan garis bingkai terdekat, di 390 dan 1440, terang dan gelap.

### Saran (tidak menahan)

- **K-S1 (sisa).** Isi iframe masih Times dan tingginya tetap `min(60dvh, 32rem)`, sehingga ±60% bidangnya putih
  kosong untuk email pendek. Usul sebelumnya masih berlaku: sisipkan `<style>` dasar di `srcDoc` dan tinggi mengikuti
  isi (maks 70vh). Lihat `EmailMessage.module.css:68-73`.
- **K-S3.** Halaman Jam kerja:
  - Tiga tombol "Simpan" berwarna masih ada.
  - Hari kerja masih ubin biru terisi ×6 dan terlalu berat, terutama di 390 karena setiap hari jadi balok penuh.
  - Teks "Kapasitas per agen" masih terjepit 3 baris di 1440 (`WorkspaceSettingsPage.tsx:324-327`).
  - Kotak centang pesan otomatis masih mengulang nama di label "Isi pesan: …".
- **K-S4.** Kotak merah "Username atau password IMAP ditolak." di kartu Koneksi belum memberi jalan keluar. Selain
  itu, teks galat Tes koneksi masih "pakai app password". Sumbernya `packages/shared/src/channel-connections.ts:387`.
  Ganti dengan **"…aktifkan IMAP dan pakai sandi aplikasi (app password), bukan password akun biasa."** supaya sama
  dengan pengantar K7.
- **K-S8.** Baris WhatsApp di daftar chat masih tanpa ikon, padahal organisasi ini punya tiga jenis channel.
- **K-S9 (baru).** Meta agen di 1440 selalu terpotong ("Belum …", "Terakhir dapat c…") karena kolom teks hanya
  ±330 px. Dua pilihan:
  - pindahkan "Terakhir dapat chat …" ke baris kedua (`--ink-2`, 13 px);
  - atau beri `title` berisi meta lengkap pada `.agentMeta` (`Workspace.module.css:237`).
- **K-S10 (baru).** `apps/web/src/components/ui/Switch.module.css:92` dan `:97` memakai selektor
  `.row[aria-checked='true'] .track` dua kali. Gabungkan menjadi satu blok. Ini kerapian kode, tidak berdampak
  visual.
- **K-S11 (baru).** Panel detail Email memecah alamat menjadi "rudi.hartono / @gmail.com". Untuk nilai alamat email,
  pakai `overflow-wrap: anywhere` hanya bila lebih panjang dari kolom, atau tampilkan nilai di bawah label (satu kolom)
  di panel 360 px.
- **K-S12 (baru).** Dua tombol "Salin" di detail Messenger berbeda letak: alamat webhook di bawah dan menjorok ±10 px
  (pola F-S12), verify token di samping. Samakan, misalnya keduanya di bawah nilai dan rata kiri.

### Tabel nilai putaran 2

T/G = terang dan gelap bernilai sama.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `channel-lain` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-lain-kosong` | 390 · 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-telegram-baru`, `-messenger-baru`, `-email-baru` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | **2** | 5 | 5 | 5 | 5 | **2** | 5 |
| `channel-telegram` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `channel-email` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 5 |
| `channel-messenger` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Daftar chat (`inbox-tersedia`) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `inbox-telegram`, `inbox-email` | 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | **3** | **3** | 5 |
| | 390 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-email-html` | 390 · 1440 T/G | 5 | 5 | 4 | **3** | 5 | 5 | 5 | 5 | **3** | 5 |
| `jam-kerja` | 1440 T/G | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | 4 | 5 | 4 | 5 | 5 | 4 | 5 |
| `jam-kerja-konfirmasi` | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

**§3 dan §4:**
- §3 bersih. "Field" sudah hilang. Warna sakelar memakai token (`--primary`, `--on-primary`, `--ink-2`, `--surface-2`).
  Ikon Lucide. Tanpa gradien. Satu tombol berwarna per kartu/dialog.
- §4 lolos. Urutan tombol dialog konfirmasi sudah benar (berwarna di atas). Setelah K9 diperbaiki, halaman wizard ikut
  pola yang sama.

## Bersih-bersih putaran 2

- Worktree dihapus (`git worktree list` hanya repo utama).
- Port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0, folder `balesin-e2e-media-3191` dihapus.
- Berkas repo:
  - bagian ini + 18 `p2-*.png`;
  - bagian "Putaran 3" laporan Fase 5 (+4 `p3-*.png`).
- Tidak ada kode produk yang diubah, tidak ada commit.

---

# Putaran 3

- **Tanggal:** 2026-11-19 · **Penilai:** `kritikus-desain` · **Putaran:** 3 (verifikasi singkat)
- **Kode yang dinilai:** `dcf73d6` (revisi K9–K11, K-S9, K-S10, K-S12). HEAD sekarang `4306de7` (API merek) dan
  working tree punya perubahan `apps/web/src/brand/*`. Keduanya tidak menyentuh berkas yang dinilai di bawah
  (`features/inbox`, `features/channels`, `features/workspace`, `components/ui`), jadi temuan berlaku untuk HEAD.
- **Cara:**
  - Worktree terisolasi dari `dcf73d6`: API 3191 / web 5191, `balesin_kd_e2e`, Redis db 11.
  - 14 layar × 390/1440 × terang/gelap difoto: 10 layar kanal (`screens-kanal.ts`) serta pembanding regresi
    `inbox-chat`, `inbox-daftar` (WhatsApp), `channel-daftar`, dan `channel-lain`.
  - Audit terukur 14 layar di 360/390/1440, terang/gelap: posisi dan ukuran tombol wizard, teks kepala chat, jarak
    label ke bingkai, `title` meta agen, posisi "Salin", scroll horizontal, target sentuh. 141/141 lulus.
- **Screenshot:** berkas berawalan `p3-` di `docs/design-reviews/2026-11-23-kanal-jam-kerja/` (8 berkas).

## Putusan putaran 3: LOLOS

K9, K10, dan K11 tertutup di 360, 390, dan 1440, terang dan gelap. Hasil audit:
- tidak ada scroll horizontal;
- tidak ada target sentuh baru < 44 px (isian 42 px dalam bingkai 44 sudah diterima sejak Fase 1);
- token warna dan spasi tetap bersih.

Tidak ada regresi di inbox WhatsApp maupun halaman Channel. Semua kriteria ≥ 4 dan tidak ada pelanggaran §3.

| Butir | Hasil (terukur) | Status |
|---|---|---|
| **K9** tombol wizard HP | `channel-telegram-baru`, `-messenger-baru`, `-email-baru`: "Hubungkan" **324 × 44** di atas "Batal" 324 × 44, jarak 8 px (390). Di 360 keduanya 294 × 44, jarak 8. Di 1440 tetap sebaris di kanan: "Batal" 69 × 36, "Hubungkan" 112 × 36. Terang dan gelap sama (`Connections.module.css:449-458`) | Lolos |
| **K10** kepala chat 1440 | `inbox-telegram`: "@andika_dps · dari Telegram". `inbox-email`/`-html`: "rudi.hartono@gmail.com · dari Email". Nama channel muncul sekali. HP tetap "Telegram · @andika_dps" / "Email · rudi.hartono@gmail.com". Regresi WhatsApp: 1440 "+62 812-3456-7890 · dari WhatsApp", 390 "+62 812-3456-7890", sama seperti sebelumnya (`ChatRoom.tsx:230-235`) | Lolos |
| **K11** label "Tampilan asli email" | Label di atas bingkai, sejajar tepi kiri judul dialog (x 521 = x judul di 1440, x 41 = x judul di 390/360). Jarak label ke garis bingkai **24 px**, tidak lagi 0 (`EmailMessage.tsx:97-98`) | Lolos |
| K-S9 meta agen | Dikerjakan dengan pilihan `title` (`WorkspaceSettingsPage.tsx:562`). `title` memuat meta lengkap untuk keempat agen. Tampilan tetap berelipsis ("Belum …", "Terakhir dapat c…") di 1440 (kolom 313 px) dan 390 (294 px). Sesuai saran, tetapi lihat K-S15 | Lolos (sebagian) |
| K-S10 Switch | Kedua blok `.row[aria-checked='true'] .track` sudah digabung. Sakelar di `jam-kerja` dan "Tersedia" di daftar chat tampil sama seperti putaran 2 (bulatan kanan saat aktif) | Lolos |
| K-S12 tombol "Salin" | Alamat webhook dan verify token Messenger kini sama polanya: "Salin" di bawah nilai, x tombol sama (101 di 1440, 21 di 360/390). Jarak 4 px dari nilai | Lolos |
| K-S1, K-S3, K-S4, K-S8, K-S11 | Belum dikerjakan. Isi iframe masih Times; tinggi iframe 512 px (1440) dengan ±65% bidang putih untuk email pendek. Kapasitas per agen masih 3 baris | Tetap saran |

**Cek regresi:**
- `inbox-chat` dan `inbox-daftar` (WhatsApp) di 390/1440 terang/gelap tidak berubah: kepala chat, timer sesi,
  composer, banner "Ambil chat", dan panel detail "dari WhatsApp".
- `channel-daftar`: daftar nomor WhatsApp dan tombol "Tambah nomor" tetap sama.
- `channel-lain`: kartu WhatsApp ringkas, baris channel, dan ubin "Tambah channel" tetap sama.
- `.actions` yang diubah hanya dipakai `ConnectionWizardPage.tsx:140`. Dialog dan halaman wizard WhatsApp memakai
  modul CSS lain dan tidak tersentuh.

### Saran (tidak menahan)

- **K-S13 (baru) — jarak label HTML email.** Konten dialog memakai `gap: var(--space-16)` (`ConfirmDialog.module.css:27`).
  Karena itu `.frameLabel { margin-top: var(--space-16) }` dan `.frameWrapLabelled { margin-top: var(--space-8) }`
  (`EmailMessage.module.css:87-96`) **ditambahkan** ke gap. Hasilnya deskripsi→label 32 px dan label→bingkai 24 px,
  bukan 16/8 seperti yang dimaksud komentar di baris 93. Label masih terasa melayang di antara dua blok.
  - Perbaikan: bungkus label dan bingkai dalam `<figure className={styles.frameFigure}>` dengan
    `<figcaption className={styles.frameLabel}>`.
  - CSS: `.frameFigure { display: flex; flex-direction: column; gap: var(--space-8); margin: 0; }`.
  - Hapus `margin-top` di `.frameLabel` dan `.frameWrapLabelled`, juga `margin-top` di `.frameWrap` bila figure
    yang dipakai.
  - Hasil: deskripsi→label 16 px, label→bingkai 8 px.
- **K-S14 (baru) — "Salin" belum rata dengan teks nilai.** Ikon salin ada 5 px di kanan tepi teks nilai di atasnya
  (ikon x 38 vs nilai x 33 di 390; 118 vs 113 di 1440). Penyebabnya `margin-left: calc(var(--space-12) * -1)` di
  `Connections.module.css:336-338`, padahal padding kiri tombol ghost 16 px + garis 1 px. Ganti dengan
  `margin-left: calc(var(--space-16) * -1 - 1px)` (atau token padding tombol, bila ada) supaya ikon tepat di tepi
  teks seperti yang dijanjikan komentar baris 335. Jarak ikon ke tepi kotak tombol terukur 17 px.
- **K-S15 (lanjutan K-S9).** `title` tidak muncul di HP (sentuh) maupun lewat keyboard, jadi di 390 "Terakhir dapat
  chat …" tetap tidak terbaca. Untuk HP saja (`@media (max-width: 640px)`), biarkan `.agentMeta` membungkus:
  `white-space: normal;` (`Workspace.module.css:237-243`). Di HP baris agen sudah dua baris, jadi tambahan satu baris
  meta tidak merusak grid. Di 1440 elipsis + `title` sudah cukup.

### Tabel nilai putaran 3

Hanya layar yang dinilai ulang. Layar lain tetap seperti tabel putaran 2. T/G = terang dan gelap bernilai sama.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `channel-telegram-baru`, `-messenger-baru`, `-email-baru` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 (dan 360) T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `channel-messenger` | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-telegram`, `inbox-email` | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 390 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `inbox-email-html` | 390 · 1440 T/G | 5 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `jam-kerja` | 1440 T/G | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 4 | 4 | 5 | 4 | 5 | 5 | 4 | 5 |
| Regresi: `inbox-chat`, `inbox-daftar`, `channel-daftar`, `channel-lain` | 390 · 1440 T/G | tidak berubah dari penilaian lolos sebelumnya | | | | | | | | | |

**§3 dan §4:**
- §3 bersih. Tidak ada warna atau spasi di luar token di berkas yang berubah. Tidak ada English nyasar baru.
- §4 lolos. Halaman wizard di HP kini mengikuti pola dialog: tombol berwarna di atas, "Batal" berbingkai di bawah.

## Bersih-bersih putaran 3

- Worktree kritikus dihapus. `git worktree list` kini berisi repo utama dan `scratchpad/wt-sharp` milik agen lain,
  yang tidak disentuh.
- Port 3191/5191 kosong, `balesin_kd_e2e` di-drop, Redis db 11 `DBSIZE` 0, folder `balesin-e2e-media-3191` dihapus.
- Berkas repo: bagian ini + 8 `p3-*.png`.
- Tidak ada kode produk yang diubah, tidak ada commit.
