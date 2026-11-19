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
