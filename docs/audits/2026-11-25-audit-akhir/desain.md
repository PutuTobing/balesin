# Audit akhir sebelum rilis 1.0 — Desain

- **Penilai:** `kritikus-desain` · Fase 7 butir 6 · tanggal kerja 2026-11-19 s.d. 2026-11-21 (berkas bertanggal 2026-11-25)
- **Kode yang dinilai:** branch `dev` commit **`ab1335f`**. Dipotret dari git worktree sementara
  (`C:/APP-CODDING/balesin-kd-audit`), bukan dari working tree utama.
- **Stack terpisah:** API **3191**, web **5191**, database **`balesin_kd_e2e`**, Redis **db 11**. Timeout
  `webServer` dilonggarkan ke 400 detik. Stack QA (3100/5180) berjalan bersamaan dan tidak disentuh.
- **Perubahan yang hanya ada di salinan worktree:**
  - `e2e/stack/env.ts` membaca `E2E_DATABASE_NAME`;
  - `e2e/viewports.ts` memakai timeout 400 detik;
  - spec khusus penilai `e2e/capture/kd-ukur.spec.ts`. Spec ini mengukur di DOM setiap layar:
    - scroll horizontal dan elemen yang keluar viewport;
    - target sentuh < 44 px;
    - ukuran font di luar skala 12/13/14/16/20/24/32;
    - keluarga font;
    - ukuran dan stroke ikon Lucide;
    - tombol tanpa nama;
    - warna teks, latar, dan garis di luar token tema aktif;
    - emoji;
    - kata Inggris yang lazim nyasar;
    - nama produk atau "Sky Tech" di teks.

  Spec yang sama juga memotret ulang `inbox-chat-interaktif(-daftar)` di HP (lihat R7).
- **Foto:** suite `pnpm screenshots` penuh dijalankan: **1.417 foto**. Hasilnya 1.411 lulus, 2 flaky lulus saat
  diulang, dan 4 gagal (R7). Semua foto berukuran 390×844 dan 1440×900, terang dan gelap.
- **Pengukuran DOM:** 390 terang, semua layar. Untuk 390 gelap dan 1440 gelap hanya sampel layar inti (lihat
  §C).
- **Foto bukti:** `docs/audits/2026-11-25-audit-akhir/desain/`, 23 berkas.
- **Pembersihan:** setelah selesai, stack dimatikan, `balesin_kd_e2e` di-drop, Redis db 11 dikosongkan, dan
  worktree dihapus (lihat §E).

## Putusan: **LOLOS BERSYARAT untuk rilis 1.0** (tidak ada Kritis/Tinggi)

Setiap layar sudah lolos sendiri-sendiri. Ada 21 laporan di `docs/design-reviews/`, semua berakhir LOLOS, dan
audit ini tidak menemukan regresi pada layar-layar itu. Hal-hal berikut bersih di **semua** layar yang diukur:

- **Token:** tidak ada warna, ukuran font, atau keluarga font di luar token (0 temuan dari 300+ layar). Penjaga
  `styles/css-guard.test.ts` bekerja.
- **Ikon:** Lucide 16/20 px dengan stroke 1,75 (0 penyimpangan).
- **Teks:** tidak ada emoji sebagai ikon (emoji yang muncul hanyalah isi pesan dan reaksi pelanggan). Tidak ada
  "Sky Tech". Tidak ada teks Inggris nyasar. Nama produk selalu dari pengaturan merek.
- **Tata letak HP:** tidak ada scroll horizontal di 390. Tidak ada target sentuh < 44 px di luar dua kasus yang
  sudah diterima sebelumnya.
- **Mode gelap:** konsisten di Inbox, Broadcast, Kontak, Tiket, Laporan, Template, dan API key.

Celahnya ada **di antara layar**. Empat pola dikerjakan berbeda-beda dari satu layar ke layar lain, jadi
aplikasi terasa disusun oleh beberapa tangan. Kalau dinilai sebagai satu produk, kriteria 4 (Kerapian) bernilai
**3** untuk empat pola itu (Sedang). Tidak satu pun menghalangi pemakaian di HP atau desktop, dan tidak satu pun
melanggar §3 secara harfiah. D2 paling dekat dengan larangan "elemen tidak sejajar ke grid"; alasan levelnya ada
di bawah. Saran: kerjakan D1–D4 sebelum menandai `v1.0.0`, karena semuanya perubahan CSS atau penempatan
komponen yang kecil. Butir Rendah boleh ikut rilis 1.0.1.

| ID | Level | Ringkas | Agen |
|---|---|---|---|
| D1 | **Sedang** | Tombol "buat/tambah" utama punya 5 penempatan berbeda di halaman daftar (kepala halaman, toolbar kiri, toolbar kanan, ikon saja, kaki daftar) | frontend |
| D2 | **Sedang** | Di HP, panah kembali pada ±40 sub-halaman (Pengaturan/*, Detail kontak, kampanye, template, tiket) bergeser 8 px ke kiri dari garis 16 px. Judulnya ikut bergeser. Halaman Tiket/Laporan/Pengaturan tepat 16 px | frontend |
| D3 | **Sedang** | Tombol simpan form: di sebagian halaman rata kiri (Alarm, Batas kirim, Notifikasi), di sebagian lain rata kanan (Jam kerja, CSAT, Tim) | frontend |
| D4 | **Sedang** | Keadaan kosong halaman tidak seragam: posisi di 1440 (tengah halaman atau tengah kolom), ilustrasi (ada atau tidak), dan Laporan yang kosongnya tidak sejajar dengan saringannya | frontend |
| R1 | Rendah | Kata kerja tombol buat tidak seragam ("Buat …" / "Tambah …" / "… baru"). Balasan cepat memakai dua kata kerja di satu halaman. Channel memakai "Tambah nomor" dan "Hubungkan nomor" | frontend |
| R2 | Rendah | "Ekspor", "Ekspor CSV", dan "Unduh CSV" dipakai untuk aksi yang sama | frontend |
| R3 | Rendah | "Ubah kontak" berwarna `--primary` 13 px di panel inbox, tetapi tombol ghost `--ink` 14 px di Detail kontak | frontend |
| R4 | Rendah | Ikon hapus di Departemen berwarna `--danger-ink`, di Konektor/Atribut/Balasan cepat berwarna `--ink-2` | frontend |
| R5 | Rendah | Laporan → Kinerja: 7 kartu dalam grid 3 kolom, jadi kartu "Bot" sendirian di baris ketiga | frontend |
| R6 | Rendah | Panel detail inbox (1440): label 7,5 rem membuat email patah di "@" dan label "Nama profil WhatsApp" jadi dua baris. Detail kontak menampilkan data yang sama secara bertumpuk | frontend |
| R7 | Rendah | Skrip foto `inbox-chat-interaktif(-daftar)` gagal di HP karena tombolnya di HP ada di menu "+". Layarnya sendiri sehat (foto ulang penilai) | qa-tester |
| R8 | Rendah | Sisa saran lama yang belum dikerjakan (F-S12, BC-S12, BC-S13, S5 Merek) | frontend |

---

## A. Temuan Sedang

### D1 — Tempat tombol "buat/tambah" utama berbeda di setiap halaman daftar

Bukti: `desain/broadcast-daftar--390-terang.png`, `desain/konektor-data--390-terang.png`,
`desain/pengaturan-balasan-cepat--390-terang.png`, `desain/tiket-kanban--390-terang.png`,
`desain/template-daftar--1440-terang.png`, `desain/broadcast-daftar--1440-terang.png`,
`desain/departemen--1440-terang.png`.

| Halaman | Penempatan sekarang | Kode |
|---|---|---|
| Tiket | Kepala halaman, kanan ("Tiket baru") | `apps/web/src/features/tickets/TicketsPage.tsx:88` |
| Kontak | Kepala halaman ("Impor", "Ekspor") | `apps/web/src/features/contacts/ContactsPage.tsx:74` |
| Broadcast | Toolbar isi. Di 1440 ada di kanan (saringan di kiri); di 390 turun ke kiri di bawah saringan | `apps/web/src/features/broadcast/BroadcastPage.tsx:44-51,98`; `Broadcast.module.css:36-42` |
| Konektor data | Baris sendiri, rata **kanan** di 390 dan 1440 | `apps/web/src/features/broadcast/ConnectorsPage.tsx:129`; `Broadcast.module.css:44-47` |
| Template WhatsApp | Baris tiga tombol rata **kiri** di 1440. Ini satu-satunya halaman yang tombol utamanya di kiri | `apps/web/src/features/templates/TemplatesPage.tsx:107-125` |
| Balasan cepat | Di samping kolom cari. Di 390 tampil sebagai **tombol ikon "+" saja**, satu-satunya tombol utama tanpa label di aplikasi | `apps/web/src/features/quick-replies/QuickRepliesPage.tsx:66-77,131` |
| Departemen | **Kaki** daftar, kiri, sesudah semua kartu (perlu digulir) | `apps/web/src/features/departments/DepartmentsPage.tsx:188` |
| API key, Webhook, Channel | Kepala kartu daftar, kanan | `ApiKeysPage.tsx:60`, `WebhooksPage.tsx:59`; Channel `ConnectionsSection` |

Dampaknya, pengguna yang berpindah dari Broadcast ke Template ke Balasan cepat harus mencari tombol utama di tempat
yang berbeda setiap kali. Kriteria 1 (aksi utama jelas dalam 3 detik) dan kriteria 4 bernilai **3** bila
halaman-halaman ini dinilai sebagai satu sistem.

**Perbaikan (dua aturan saja; catat di `docs/DESIGN.md` §2):**

1. **Halaman yang isinya satu daftar** (Broadcast, Template, Konektor, Balasan cepat, Departemen, Tiket):
   - Tombol utama "Buat …" pindah ke `Page actions`, kanan kepala halaman, sama seperti `TicketsPage.tsx:88`.
     Pola yang sudah ada: tampilkan hanya bila daftar tidak kosong; saat kosong, tombol ada di `EmptyState`.
   - Template: hanya "Buat template" yang ke kepala halaman. "Pakai preset" dan "Sinkron dari Meta" tetap di
     toolbar isi sebagai tombol sekunder rata kanan.
   - Balasan cepat: buang tombol ikon saja di baris cari (`QuickRepliesPage.tsx:66-77`). Kolom cari jadi
     selebar penuh.
   - Departemen: buang `.footer` (`DepartmentsPage.tsx:188`).
   - Di ≤ 640 px label tetap tampil. Bila judul + tombol tidak muat, pakai label pendek **"Buat"** dengan ikon
     `Plus`, lewat kunci baru `addShort` di `i18n/id.ts`. Jangan pakai tombol ikon saja.
2. **Halaman berisi beberapa kartu** (API key, Webhook, Channel): tetap di kepala kartu daftar, kanan. Pola ini
   sudah benar dan konsisten.

### D2 — Panah kembali di HP keluar dari garis 16 px pada sub-halaman

Bukti: `desain/hp-panah-kembali-perbandingan.png`. Enam kepala halaman 390 ditumpuk; garis merah ada di x = 16
px.

Hasil ukur piksel tepi kiri ikon panah di 390:

| Halaman | Tepi kiri panah | Tepi kiri judul |
|---|---|---|
| Tiket, Laporan, Pengaturan (induk `more`) | **19,5 px** (ikon jatuh di garis 16 px, sesuai komentar kode) | 52,5 |
| API key, Keamanan, Tim, Detail kontak, kampanye Broadcast (induk `settings`/`contacts`/`broadcast`/…) | **11,5 px** | 48,5 |

Penyebabnya: `.backAlways { margin-left: calc(var(--space-8) * -1); }` di
`apps/web/src/components/ui/Page.module.css:24-31` masih berlaku di HP. Aturan HP `.back` (`:81-93`) mengganti
lebar dan tinggi tetapi tidak mengganti margin. `.header:has(.backAlways) { gap: var(--space-8) }` (`:39-41`) juga
mengalahkan `gap: var(--space-4)` HP (`:76`). Pengukuran DOM mencatat tautan "Kembali ke …" mulai di x = −4 px pada
semua sub-halaman Pengaturan.

**Kenapa Sedang dan bukan Tinggi:**
- Pergeserannya konsisten 8 px, bukan jarak acak.
- Tidak ada yang bertabrakan atau terpotong; target sentuh tetap 44 px.
- Tetapi ini menyentuh ±40 layar, dan berpindah antar-menu membuat panah dan judul "meloncat" 4–8 px.

**Perbaikan** (di dalam `@media (max-width: 640px)` pada `Page.module.css`, sesudah aturan `.back`):

```css
.back { margin-left: 0; }
.header:has(.back) { gap: var(--space-4); }
```

Hasil yang diharapkan: ikon panah di 16 px dan judul di 52 px di **semua** halaman. Tambahkan foto
`fokus-navigasi` + satu sub-halaman ke tes penjaga bila ada.

### D3 — Tombol simpan form rata kiri di sebagian halaman, rata kanan di sebagian lain

Bukti: `desain/alarm-telegram--1440-terang.png` (kiri), `desain/notifikasi--1440-terang.png` (kiri),
`desain/csat-pengaturan--1440-terang.png` (kanan, dengan "Terakhir diubah" di kiri), Jam kerja (kanan). Di 390,
Alarm Telegram selebar penuh sedangkan CSAT tetap kecil di kanan.

| Rata kiri | Rata kanan |
|---|---|
| `features/broadcast/TelegramAlarmPage.tsx:214` (`Broadcast.module.css:339-344`) | `features/workspace/Workspace.module.css:68-71` (Jam kerja, `WorkspaceSettingsPage.tsx:116,473`) |
| `features/notifications/NotificationsPage.tsx:175,325,439` (`Notifications.module.css:57-61`) | `features/reports/CsatSettingsPage.tsx:141-149` (`.formFoot`) |
| `features/sending-limits/SendingLimitsPage.tsx:168,403` (`SendingLimits.module.css:95-99`) | `features/team/TeamPage.tsx:293` ("Kirim undangan") |

**Perbaikan:**

1. Buat satu komponen `FormActions` di `apps/web/src/components/ui/` yang mengikuti aturan dialog §4 ("tombol
   berwarna selalu terakhir"):
   - desktop: `display:flex; justify-content:flex-end; align-items:center; gap: var(--space-8)`, dengan slot
     kiri opsional `meta` untuk "Terakhir diubah …" (`margin-right:auto`);
   - ≤ 640 px: `flex-direction: column-reverse; align-items: stretch`, sehingga tombol utama di atas dan
     selebar penuh, sama seperti dialog di HP.
2. Pakai `FormActions` di keenam tempat di tabel, lalu di Merek, Email pengirim, dan Batas kirim bila belum.
3. Tambahkan satu kalimat di `docs/DESIGN.md` §4: "Tombol simpan form: kanan di desktop, selebar penuh di atas
   pada HP."

### D4 — Keadaan kosong halaman tidak seragam

Bukti: `desain/kontak--1440-terang.png` dan `desain/broadcast--1440-terang.png` (bandingkan posisi horizontal),
`desain/laporan--1440-terang.png`, `desain/pengaturan-balasan-cepat-kosong--390-terang.png`.

- **Posisi di 1440:**
  - Kontak dan Tiket memusatkan keadaan kosong di tengah **seluruh** area konten (±750 px dari kiri).
  - Broadcast, Template, dan Balasan cepat memusatkannya di tengah **kolom isi** ±790 px (±470 px dari kiri).
  - Akibatnya ilustrasi "meloncat" ±280 px saat berpindah Kontak → Broadcast di rail.
- **Laporan:** tab dan saringan rata kiri, tetapi ilustrasi kosongnya dipusatkan ke lebar penuh. Keadaan kosong
  tidak sejajar dengan isi di atasnya.
- **Ilustrasi:**
  - Halaman daftar Kontak, Tiket, Broadcast, Template, Channel, dan Laporan punya ilustrasi.
  - Balasan cepat (`QuickRepliesPage.tsx`, sekitar `:110-118`), Konektor data (`ConnectorsPage.tsx:126`), dan
    Departemen (`DepartmentsPage.tsx:113`) tidak punya.
  - Ketiganya adalah halaman kosong satu daftar yang setara.

**Perbaikan:**

1. Keadaan kosong **halaman** selalu ditaruh di dalam kolom isi yang sama dengan konten saat terisi (lebar
   maks. kolom halaman itu), lalu dipusatkan di kolom itu. Untuk Kontak, Tiket, dan Laporan, bungkus
   `EmptyState` dengan kontainer yang `max-width`-nya sama dengan `.content` halaman Broadcast
   (`Broadcast.module.css`, kelas `.content`), atau pakai satu token lebar kolom baru `--size-column`.
2. Laporan: taruh `EmptyState` di dalam kontainer kartu (`Reports.module.css` `.card`) di bawah saringan, rata
   dengan kartu KPI saat terisi.
3. Beri ilustrasi pada tiga halaman tadi dari set yang sudah ada di
   `apps/web/src/components/illustrations/illustrations.tsx`:
   - Balasan cepat: pose chat seperti Inbox kosong;
   - Konektor: pose tautan seperti Broadcast;
   - Departemen: pose tim seperti Kontak.

   Keadaan kosong **di dalam kartu** (API key, Webhook, Undangan terbuka) tetap tanpa ilustrasi; itu sudah
   benar.

---

## B. Temuan Rendah

- **R1 — Kata kerja tombol buat.**
  - Teks sekarang (`apps/web/src/i18n/id.ts`):
    - "Buat …": `:828` "Buat kampanye", `:3723` "Buat template", "Buat API key";
    - "Tambah …": `:785` "Tambah atribut", `:1147` "Tambah konektor", `:1623` "Tambah departemen", `:3189`
      "Tambah nomor", `:3671` "Tambah balasan cepat", "Tambah webhook";
    - "… baru": `:1238` "Board baru", `:1240` "Tiket baru".
  - Balasan cepat memakai "Tambah balasan cepat" (`:3671`) dan "Buat balasan cepat pertama" (`:3673`) di
    halaman yang sama.
  - Channel memakai "Tambah nomor" (`:3189`), padahal keadaan kosongnya "Hubungkan nomor pertama" dan menu
    Pengaturan "Hubungkan".
  - **Ganti:**
    - **"Buat …"** untuk semua objek baru: "Buat atribut", "Buat konektor", "Buat departemen", "Buat balasan
      cepat", "Buat webhook", "Buat tiket", "Buat board".
    - **"Hubungkan nomor"** untuk `:3189`.
    - "Tambah" hanya untuk menempelkan sesuatu ke objek yang ada: "Tambah tag", "Tambah kolom", "Tambah hari
      libur".
- **R2 — Ekspor dan Unduh.**
  - Sekarang: `id.ts:613` "Ekspor" (Kontak), `:696` "Unduh CSV" (tombol konfirmasi ekspor kontak), `:998`
    "Ekspor CSV" (Broadcast), `:1799` "Unduh CSV" (Laporan), `:2632` "Ekspor CSV" (Audit).
  - **Ganti:**
    - semua tombol yang membuat berkas dari data → **"Ekspor CSV"** (`:613`, `:696`, `:1799`);
    - "Unduh" hanya untuk berkas yang sudah ada (media, `:389`; kode cadangan `.txt`, `:2298`).
- **R3 — "Ubah kontak" tampil dua gaya.**
  - `apps/web/src/features/inbox/ContactPanel.module.css:524-529` menimpa tombol ghost menjadi `color:
    var(--primary)` dan 13 px.
  - `features/contacts/ContactDetailPage.tsx:149-153` memakai ghost standar (`--ink`, 14 px).
  - Hapus `color` dan `font-size` di `.sectionHead .sectionAction`; pertahankan `height`/`padding`. Bukti:
    `desain/inbox-detail-kontak--390-terang.png` dan `desain/kontak-detail--390-terang.png`.
- **R4 — Warna ikon hapus.**
  - `features/departments/DepartmentsPage.tsx:136-140` memberi `className={styles.danger}` (`--danger-ink`) pada
    `IconButton` Trash2.
  - Konektor (`ConnectorsPage.tsx:149`), Atribut (`AttributeManager.tsx:128`), dan Balasan cepat memakai
    `--ink-2`. Kalimat konfirmasi sudah merah, jadi ikonnya tidak perlu.
  - Buang `styles.danger` di Departemen. Bukti: `desain/departemen--390-terang.png`.
- **R5 — Kartu KPI yatim.**
  - `features/reports/PerformanceReport.tsx:188` memakai `.tiles` 3 kolom (`Reports.module.css:146-150`) untuk 7
    kartu, sehingga "Bot · 133" sendirian di baris ketiga dengan 2/3 baris kosong
    (`desain/laporan-kinerja--1440-terang.png`).
  - Pakai `.tilesFour` di ≥ 1280 px. Hasilnya 4 + 3, dan "Bot" berdampingan dengan "Dibalas tim".
  - Pilihan lain: gabungkan "Dibalas tim" dan "Bot" dalam satu kartu "Ditangani oleh" (402 tim · 133 bot).
- **R6 — Panel detail inbox.**
  - `features/inbox/ContactPanel.module.css:65-71` (`grid-template-columns: 7.5rem minmax(0,1fr)`) menyisakan
    ±160 px untuk nilai di panel 340 px. Akibatnya "budi.santoso / @contoh.id" patah dan label "Nama profil /
    WhatsApp" jadi dua baris (`desain/inbox-chat--1440-terang.png`).
  - Di panel desktop, tumpuk label di atas nilai: `grid-template-columns: minmax(0,1fr)`, label 12 px `--ink-2`,
    jarak 2–4 px. Ini sama dengan Detail kontak (`Contacts.module.css`), jadi data yang sama tampil sama di dua
    tempat.
- **R7 — Skrip foto interaktif di HP.**
  - `e2e/capture/screens-inbox.ts:641` dan `:657` mengklik tombol "Kirim tombol atau daftar pilihan". Di ≤ 640 px
    tombol itu ada di menu "Tambah lampiran atau pesan khusus" → item "Pesan dengan pilihan".
  - Akibatnya 4 foto gagal di setiap run, dan regresi pada dialog ini di HP tidak akan terlihat.
  - Tambahkan cabang: bila tombol tidak terlihat, buka menu "+" lalu klik `menuitem` "Pesan dengan pilihan".
  - Penilai sudah memotret ulang dengan cara itu: `desain/inbox-chat-interaktif--390-terang.png` dan
    `desain/inbox-chat-interaktif-daftar--390-terang.png`. Dialognya sehat di HP: kontrol segmen jelas,
    hitungan "2 dari 3 tombol", kaki menempel dengan "Kirim" di atas dan "Batal" di bawah sesuai §4.
- **R8 — Sisa saran lama** (dari laporan per layar, masih terlihat di `ab1335f`):
  - F-S12: tombol ghost "Hapus tenggat" menjorok di Detail tiket;
  - BC-S12: nomor penerima broadcast tidak diformat "+62 812-…";
  - BC-S13: judul "Penerima" tidak sejajar dengan saringan;
  - S5 Merek: "Kode warna" tertutup navigasi bawah setelah difokus di 390.

  Rincian perbaikannya ada di `2026-11-22-fase5-crm-tiket-laporan.md`, `2026-11-21-fase4-broadcast.md`, dan
  `2026-11-24-merek.md`.

---

## C. Rubrik per area (DESIGN §5)

T/G = terang/gelap sama kecuali disebut. Nilai lintas layar memperhitungkan D1–D4.

| Area (layar) | Ukuran · tema | 1 Hier. | 2 Token | 3 Tipo | 4 Rapi | 5 Resp. | 6 Keadaan | 7 A11y | 8 Bahasa | 9 Prof. | 10 Cepat |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Inbox daftar (`inbox-daftar`, tab, cari, saring) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Ruang chat + composer (`inbox-chat*`) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Panel kontak (`inbox-detail-*`) | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| | 1440 T/G | 5 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Balasan cepat di composer (`inbox-chat-balasan-cepat*`) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Kirim template / percakapan baru (dialog) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Pesan interaktif (dialog, foto ulang penilai) | 390 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Broadcast daftar | 390 T/G | 4 | 5 | 5 | **3** (D1) | 5 | 5 | 5 | 5 | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Broadcast wizard / detail kampanye | 390 · 1440 T/G | 5 | 5 | 5 | 4 (D2 di 390) | 5 | 5 | 5 | 5 | 5 | 5 |
| Kontak daftar / detail / impor | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 |
| Tiket kanban / daftar / detail | 390 · 1440 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Laporan kinerja / biaya | 390 T/G | 5 | 5 | 5 | 4 | 5 | 5 | 5 | 4 (R2) | 5 | 5 |
| | 1440 T/G | 4 | 5 | 5 | **3** (R5 + D4) | 5 | 4 | 5 | 4 | 4 | 5 |
| Template WhatsApp daftar / editor | 1440 T/G | 4 | 5 | 5 | **3** (D1) | 5 | 5 | 5 | 5 | 4 | 5 |
| | 390 T/G | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| Pengaturan: menu, Channel, Merek, Tim, Jam kerja, CSAT, Notifikasi, Alarm, Batas kirim | 390 T/G | 5 | 5 | 5 | **3** (D2, D3) | 5 | 5 | 5 | 5 | 4 | 5 |
| | 1440 T/G | 5 | 5 | 5 | **3** (D3) | 5 | 5 | 5 | 5 | 4 | 5 |
| Pengaturan: Balasan cepat, Konektor, Departemen, Atribut | 390 T/G | 4 | 5 | 5 | **3** (D1, D2) | 5 | 4 (D4) | 5 | 4 (R1) | 4 | 5 |
| | 1440 T/G | 4 | 5 | 5 | **3** (D1) | 5 | 4 | 5 | 4 | 4 | 5 |
| API key, Webhook | 390 · 1440 T/G | 5 | 5 | 5 | 4 (D2 di 390) | 5 | 5 | 5 | 5 | 5 | 5 |
| Masuk, setup, undangan, lupa/atur ulang password, 2FA, verifikasi email | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Keadaan kosong halaman (Kontak, Tiket, Laporan, Broadcast, Template, Balasan cepat) | 1440 T/G | 5 | 5 | 5 | **3** (D4) | 5 | 4 | 5 | 5 | 4 | 5 |
| | 390 T/G | 5 | 5 | 5 | 4 | 5 | 4 | 5 | 5 | 4 | 5 |
| Memuat / gagal / 404 / server mati | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Dialog konfirmasi identitas (password + kode, 12 varian) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Merek kustom → masuk & inbox (white-label) | 390 · 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

**Cakupan pengukuran DOM:**

- **390 terang, semua layar `screens.ts`:**
  - 0 scroll horizontal;
  - 0 font di luar skala;
  - 0 warna di luar token (kecuali ubin pratinjau gelap di Merek, yang memang sengaja);
  - 0 ikon menyimpang;
  - 0 emoji sebagai ikon.
- **Target sentuh < 44 px**, hanya dua kasus yang sudah diterima sebelumnya:
  - `<input>` 42 px di dalam `.control` 44 px; kotaknya sendiri 44 px, `Field.module.css:155-160`;
  - "Tampilkan password" 44×42.

  Dua catatan pengukur lain ternyata benar karena area ketuknya diperluas dengan `::after`:
  - judul kartu Kanban (322×20); seluruh kartu jadi area ketuk, `Tickets.module.css:371-377`;
  - chip "Hapus saringan …" (117×28); area tekan 44 px, `InboxFilterMenu.module.css:139-143`.
- **Kata Inggris:** semuanya wajar:
  - "Edit": kutipan nama tombol di dasbor Meta;
  - "Failed": ada di "Detail teknis" yang tertutup;
  - "reset"/"Reset": nama berkas lampiran dan judul tiket contoh;
  - "Anda": isi email pelanggan.
- **Warna "di luar token" di layar Merek:** hanya ubin pratinjau "Mode gelap", yang memang sengaja memakai token
  gelap di halaman terang.
- **"Balesin" di teks:** hanya muncul sebagai nama produk bawaan dari pengaturan merek (Merek kosong). Dengan
  merek diisi, teks itu berganti, sudah dibuktikan di `2026-11-24-merek.md`. Tidak ada "Sky Tech".
- **Mode gelap:** diukur pada sampel **30 layar inti** di 390 gelap dan 1440 gelap: Inbox, composer, panel,
  dialog template, Broadcast, Kontak, Tiket, Laporan, Template, API key, Webhook, Pengaturan, Jam kerja, Merek,
  masuk, undangan, setup, dialog identitas, Channel, Notifikasi, CSAT, Balasan cepat, Departemen.
  - 0 warna di luar token, kecuali ubin pratinjau terang di Merek, yang sengaja;
  - 0 font di luar skala, 0 ikon menyimpang, 0 scroll horizontal.
  - Kontrol 36 px di 1440 memang sesuai token `size.control` untuk pointer halus. Di 390 semuanya ≥ 44.
  Pemeriksaan visual montase gelap untuk Inbox, Broadcast, Kontak, Tiket, Laporan, Template, API key, masuk,
  undangan, dan setup tidak menemukan teks yang tenggelam.

## D. Daftar larangan §3

| Larangan | Status |
|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih (diukur) |
| Semua tombol pill besar, bayangan tebal | Bersih. Tombol radius 6, pill hanya untuk lencana dan chip |
| Kartu ikon + judul + 1 kalimat berulang tanpa hierarki | Bersih. Menu Pengaturan punya status per baris, dan "Tambah channel" punya deskripsi spesifik |
| English nyasar, Lorem, "Welcome back!" | Bersih (diukur) |
| Ukuran font tidak konsisten, jarak acak, tidak sejajar grid | Font dan jarak bersih (diukur). Penyimpangan sejajar: **D2** (8 px, sistematis, bukan acak), dicatat sebagai Sedang |
| Warna di luar token | Bersih (diukur) |

§4 istilah:
- "verifikasi dua langkah", "atur ulang", "masuk/keluar", "Owner atau Admin di tempatmu", "… belum bisa dimuat",
  dan "balasan cepat" vs "template" konsisten di `id.ts` (dihitung: 64× "belum bisa dimuat", 0× "gagal dimuat",
  0× "Anda", 0× "login/logout/reset" di teks UI).
- Pengecualian: kata kerja tombol (R1) dan Ekspor/Unduh (R2).

## E. Pembersihan

- Stack 3191/5191 dimatikan.
- Database `balesin_kd_e2e` di-drop dan Redis db 11 dikosongkan (`DBSIZE` 0).
- Worktree `C:/APP-CODDING/balesin-kd-audit` dihapus (`git worktree remove --force`).
- Berkas yang ditambahkan ke working tree utama: laporan ini + 23 foto di `desain/`. Tidak ada kode yang diubah
  dan tidak ada commit.
