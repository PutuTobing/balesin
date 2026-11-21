# Penilaian desain: kartu Bot di halaman channel lain (Telegram, Email, Messenger/Instagram)

- **Penilai:** `kritikus-desain` · **Putaran:** 1
- **Kode yang dinilai:** `035215c` ("feat(web): revisi Merek putaran 1 & kartu Bot untuk channel lain"), branch `dev`.
- **Cara memotret:** sama dengan putaran 2 review Merek (`2026-11-24-merek.md`):
  - worktree sementara;
  - API 3191, web 5191, DB `balesin_kd_e2e`, Redis db 11.
- **Layar frontend yang difoto:** `channel-telegram`, `channel-email`, `channel-messenger`, ditambah regresi WhatsApp
  `nomor-bot` dan `nomor-bot-mati`.
- **Layar tambahan penilai** (hanya di worktree):
  - `kd-channel-telegram-bot`: viewport digulir ke kartu Bot;
  - `kd-channel-email-bot-aktif`: Email, bot aktif, `receiverReady: true`.
- Semua difoto di 390 dan 1440, terang dan gelap.
- **Foto bukti:** `docs/design-reviews/2026-11-19-bot-channel-lain/` (10 foto, awalan `kd-` dibuang).

## Putusan: REVISI

Penempatan sudah benar: kartu Bot ada di antara "Tes koneksi" dan "Pengaturan". Gaya kartu juga sama persis dengan
kartu lain (`Channels.module.css` dan `Connections.module.css` punya `.card`/`.cardTitle`/`.hint` yang identik).
Teks "channel ini"/"nomor ini" tepat, dan kartu WhatsApp tidak mundur.

Yang menahan ada tiga, semuanya soal **kejujuran keadaan dan istilah**:
- status hijau bertentangan dengan peringatan di bawahnya;
- Messenger/Instagram dijanjikan "template" yang tidak ada;
- istilah "format native" tidak ditemukan di halaman Webhook.

## Temuan utama

| # | Kriteria | Nilai | Layar | Bukti |
|---|---|---|---|---|
| B1 | 6 Keadaan, 9 Profesional | **2** | `channel-telegram` semua ukuran (`channel-telegram--1440-terang.png`, `telegram-bot--390-gelap.png`) | Lencana status hijau **"Memegang chat baru"** tepat di atas peringatan **"Belum ada penerima bot"**, yang menulis "Chat baru tetap langsung masuk antrian tim". Keduanya tidak mungkin benar bersamaan, jadi Owner tidak tahu mana yang dipercaya. Status harus mengikuti `receiverReady` |
| B2 | 8 Bahasa, 6 Keadaan | **2** | `channel-messenger` (dan Instagram), semua ukuran (`channel-messenger--1440-terang.png`) | Teks sesi untuk Messenger: "Balasan bot ikut aturan sesi 24 jam: di luar 24 jam sejak pesan terakhir pelanggan, bot hanya bisa mengirim **template**." Isinya keliru: `channel-capabilities.ts` mencatat `templates: false` untuk Messenger/Instagram, dan tag pesan belum didukung v1 (`KONTRAK-API-CHANNEL-LAIN.md` baris 17). Ini juga melanggar istilah tetap DESIGN §4: "template" **hanya** untuk template WhatsApp |
| B3 | 8 Bahasa | **3** | `channel-telegram` peringatan, dan juga `receiverMissingWhatsApp` | "webhook aktif **format native**". Di Pengaturan → Webhook, format itu berlabel **"Standar"** (`id.ts:4018` `formats: { native: 'Standar', … }`). Owner yang menekan "Buka Pengaturan → Webhook" tidak akan menemukan kata "native". Istilahnya juga Inggris |

## Tabel nilai

T/G = terang/gelap sama.

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `channel-telegram` (bot aktif, tanpa penerima) | 1440 T/G | 4 | 5 | 4 | 4 | 5 | **2** | 5 | **3** | **2** | 5 |
| | 390 T/G | 4 | 5 | 4 | 4 | 5 | **2** | 5 | **3** | **2** | 5 |
| `channel-email` (bot mati) | 390 · 1440 T/G | 4 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-email` bot aktif + penerima siap | 390 · 1440 T/G | 4 | 5 | 4 | 4 | 5 | 4 | 5 | 5 | 4 | 5 |
| `channel-messenger` (bot mati) | 390 · 1440 T/G | 4 | 5 | 4 | 4 | 5 | **3** | 5 | **2** | **3** | 5 |
| `nomor-bot` / `nomor-bot-mati` (WhatsApp, regresi) | 390 · 1440 T/G | 4 | 5 | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 5 |

Catatan nilai:
- Kriteria 1 dan 3 bernilai 4 di semua layar. Kepala kartu terdiri dari dua paragraf petunjuk (hint umum 3 baris +
  catatan sesi 1-2 baris). Di 390 WhatsApp jumlahnya 8 baris sebelum saklar, dan antarparagraf hanya berjarak 4 px.
  Masih terbaca, tetapi padat. Lihat saran BS1.
- Kontras: judul peringatan `--warning-ink` di atas surface lolos di kedua tema. Lencana status memakai token status.
  Fokus keyboard memakai komponen bersama (Checkbox, Button, SegmentedControl) yang sudah lolos di review lain.
- 390: tidak ada scroll horizontal. "Buka Pengaturan → Webhook" dan saklar ≥ 44 px. Lencana status turun ke bawah
  petunjuk saat teksnya panjang. Ini wajar karena `flex-wrap`.
- Regresi WhatsApp: teks "nomor ini" tetap ada, dan jadwal/zona waktu/batas waktu tidak berubah. Catatan sesi 24 jam
  WhatsApp ("…bot hanya bisa mengirim template.") benar untuk WhatsApp.

## Daftar larangan §3

| Larangan | Hasil |
|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih |
| Semua tombol pill, bayangan tebal | Bersih |
| Kartu ikon + judul + 1 kalimat berulang | Bersih |
| Teks Inggris nyasar | **Melanggar (ringan)**: "format native" (B3) |
| Ukuran font/jarak tidak konsisten | Bersih |
| Warna di luar token | Bersih |

## Perbaikan wajib (untuk `frontend`)

### B1. Status mengikuti penerima bot

`apps/web/src/features/channels/BotCard.tsx:47-53`:
```ts
const status = !data
  ? null
  : !data.enabled
    ? { tone: 'neutral' as const, label: copy.statusOff }
    : data.receiverReady === false
      ? { tone: 'warning' as const, label: copy.statusNoReceiver }
      : data.activeNow
        ? { tone: 'success' as const, label: copy.statusOn }
        : { tone: 'warning' as const, label: copy.statusOutside };
```
- `apps/web/src/i18n/id.ts` blok `bot` (setelah `statusOff`, baris ±3511): `statusNoReceiver: 'Belum ada penerima'`.
- Tes `BotCard.test.tsx`: aktif + `receiverReady: false` → lencana "Belum ada penerima", bukan "Memegang chat baru".

### B2. Teks sesi 24 jam per jenis channel yang benar

`apps/web/src/i18n/id.ts` blok `bot` (baris ±3499), tambahkan:
```ts
windowNoteNoTemplate: (channel: string) =>
  `${channel} punya batas sesi 24 jam: di luar 24 jam sejak pesan terakhir pelanggan, bot belum bisa membalas sampai pelanggan mengirim pesan lagi.`,
```
`BotCard.tsx:63-69`:
```tsx
{channelType === 'whatsapp'
  ? copy.windowNote
  : channelHasCustomerWindow(channelType)
    ? copy.windowNoteNoTemplate(CHANNEL_TYPE_LABELS[channelType])
    : copy.noWindowNote(CHANNEL_TYPE_LABELS[channelType])}
```
Lebih bagus lagi bila memakai kapabilitas `templates` (`CHANNEL_CAPABILITIES[type].templates`), bukan
membandingkan `'whatsapp'`, supaya tetap benar bila tag pesan Meta didukung nanti.

Tes: Messenger dan Instagram → teks "belum bisa membalas", tanpa kata "template".

### B3. "native" → "Standar" (sama dengan halaman Webhook)

`apps/web/src/i18n/id.ts:3504-3507`:
```ts
receiverMissingWhatsApp:
  'Chat baru tetap langsung masuk antrian tim sampai ada webhook aktif yang menerima "Pesan masuk dari pelanggan" (format Standar atau MobiChat).',
receiverMissingOther:
  'Chat baru tetap langsung masuk antrian tim sampai ada webhook aktif format Standar yang menerima "Pesan masuk dari pelanggan". Format MobiChat hanya untuk WhatsApp.',
```
Periksa juga teks lain yang menyebut "native" ke pengguna: `grep -n "native" apps/web/src/i18n/id.ts`. Nama kunci di
kode tidak perlu diubah.

## Saran (tidak menahan)

- **BS1. Kepala kartu lebih ringkas.** Petunjuk umum (`bot.hint`, `id.ts` ±3495) diganti:
  > "Saat aktif, chat baru di ${place} dipegang bot dulu lewat webhook (n8n atau bot lain). Chat pindah ke tim saat bot
  > menyerahkannya, agen mengambil alih, atau bot tidak membalas dalam batas waktu."

  Beri jarak `var(--space-8)` antara petunjuk dan catatan sesi: kelas baru `.cardHead > .hint + .hint { margin-top:
  var(--space-4); }`, jadi total 8 px. Dengan begitu catatan sesi terbaca sebagai fakta terpisah, bukan kelanjutan
  kalimat.
- **BS2. Petunjuk "Bot hanya memegang chat bila ada webhook aktif…"** tetap tampil walaupun `receiverReady: true`
  (`kd-channel-email-bot-aktif`). Saat penerima sudah siap, pakai kalimat positif singkat, mis. "Ada webhook aktif yang
  menerima chat baru untuk bot.", atau sembunyikan.
- **BS3. Label tombol** "Buka Pengaturan → Webhook" berisi panah dan huruf kapital di tengah. Lebih natural:
  **"Buka pengaturan webhook"**.
- **BS4. Dua arti "24 jam"** berdekatan: opsi jam kerja bot "24 jam" dan catatan "sesi 24 jam". Pertimbangkan label
  opsi **"Sepanjang hari"** (`hoursAlways`). Ini menyentuh kartu WhatsApp juga, jadi bila diubah, foto ulang
  `nomor-bot`.

## Untuk putaran 2

Foto ulang `channel-telegram`, `channel-messenger`, `channel-email` (390 dan 1440, terang dan gelap), serta `nomor-bot`.
Pastikan:
- lencana Telegram "Belum ada penerima" (kuning);
- Messenger tanpa kata "template";
- tidak ada "native" di teks.

# Putaran 3

- **Penilai:** `kritikus-desain` · **Putaran:** 3 (penilaian kedua untuk kartu ini; nomornya mengikuti siklus
  Merek) · **Tanggal:** 2026-11-19
- **Kode yang dinilai:** `1e9afaf` ("fix(web): revisi Merek putaran 2 & kartu Bot …"), branch `dev`.
- **Cara memotret:** worktree sementara, API 3191, web 5191, DB `balesin_kd_e2e`, Redis db 11.
- **Layar frontend:** `channel-telegram`, `channel-email`, `channel-messenger`, `nomor-bot`, `nomor-bot-mati`.
- **Layar tambahan penilai** (hanya di worktree):
  - `kd-channel-email-bot-aktif`: Email, bot aktif, `receiverReady: true` (untuk cek BS2);
  - `kd-inbox-bot-menu-telegram` dan `kd-inbox-bot-menu-email`:
    - buka kartu Bot channel dulu, supaya cache pengaturan bot terisi;
    - pindah ke inbox lewat router;
    - buka menu "Tindakan chat";
    - Telegram = bot aktif tanpa penerima, Email = bot mati.
- Semua layar difoto di 390 dan 1440, terang dan gelap, dan semuanya lulus.
- **Foto bukti:** `docs/design-reviews/2026-11-19-bot-channel-lain/putaran-3/` (14 foto, awalan `kd-` dibuang).

## Putusan putaran 3: REVISI (1 perbaikan kecil di menu inbox)

Kartu Bot di ketiga channel **lolos**: B1–B3 dan BS1–BS4 beres, dan kartu WhatsApp tidak mundur.

Yang masih menahan hanya menu "Kembalikan ke bot" yang baru: di HP, alasan untuk Telegram terpotong.

### Verifikasi B1–B3, BS1–BS4

| # | Hasil | Bukti |
|---|---|---|
| B1 Lencana | **Beres** | Telegram aktif tanpa penerima kini berlencana kuning **"Belum ada penerima"**, selaras dengan peringatan di bawahnya (`channel-telegram--1440-terang.png`, `--390-gelap.png`) |
| B2 Sesi Messenger/IG | **Beres** | Teksnya kini "Messenger punya batas sesi 24 jam: … bot belum bisa membalas sampai pelanggan mengirim pesan lagi.", tanpa kata "template" (`channel-messenger--1440-gelap.png`, `--390-terang.png`). Pilihan teks memakai `CHANNEL_CAPABILITIES[type].templates` |
| B3 "Standar" | **Beres** | Teksnya kini "…webhook aktif format Standar…". Hasil `grep native id.ts` tinggal kunci kode `formats.native`/`descriptions.native` (`id.ts:4024-4026`), bukan teks yang dilihat pengguna |
| BS1 Kepala ringkas | **Beres** | Di 1440 petunjuk tinggal 3 baris, dan jaraknya ke catatan sesi 8 px. Catatan sesi kini terbaca sebagai fakta terpisah |
| BS2 Penerima siap | **Beres** | Tampil "Ada webhook aktif yang menerima chat baru untuk bot." (`channel-email-bot-aktif--390-terang.png`) |
| BS3 Label tombol | **Beres** | "Buka pengaturan webhook" |
| BS4 "Sepanjang hari" | **Beres** | Dipakai di Telegram, Email, dan WhatsApp (`nomor-bot--390-terang.png`, `--1440-gelap.png`) |

**Regresi WhatsApp: tidak ada.** Yang tetap utuh:
- teks "nomor ini";
- catatan sesi "…hanya bisa mengirim template." (benar untuk WhatsApp);
- lencana hijau "Memegang chat baru";
- kalimat positif saat penerima siap;
- jadwal, zona waktu, dan batas waktu.

## Temuan baru

| # | Kriteria | Nilai | Layar | Bukti |
|---|---|---|---|---|
| K1 | 4 Responsif, 6 Keadaan | **2** (390) · 4 (1440) | `inbox-bot-menu-telegram--390-gelap.png`, `--390-terang.png` | Menu "Tindakan chat" tidak punya batas lebar. Alasan "Belum ada penerima bot aktif untuk channel ini (Pengaturan → Webhook)." tampil satu baris, jadi menu melebar melewati tepi kanan layar 390. Teks terpotong di "(Pengaturan →" dan tepi kanan menu hilang. Akibatnya alasan yang seharusnya terbaca justru tidak terbaca. Di 1440 menu jadi ±460 px (`inbox-bot-menu-telegram--1440-terang.png`), jauh lebih lebar dari isi menu lainnya. Alasan Email pendek ("Bot belum aktif di channel ini."), jadi aman |

## Tabel nilai putaran 3

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `channel-telegram` (aktif, tanpa penerima) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `channel-email` (mati) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-email` aktif + penerima siap | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `channel-messenger` (mati) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-bot` / `nomor-bot-mati` (WhatsApp) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Menu "Kembalikan ke bot", Email (bot mati) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| Menu "Kembalikan ke bot", Telegram (tanpa penerima) | 1440 T/G | 4 | 5 | 4 | 4 | 5 | 5 | 5 | 4 | **3** | 5 |
| | 390 T/G | 4 | 5 | 4 | **2** | 5 | **2** | 5 | 4 | **3** | 5 |

Catatan: kriteria 3 bernilai 4 karena di item dua baris, ikon robot dipusatkan vertikal sehingga tidak sejajar
dengan baris label (lihat KS1).

## Daftar larangan §3

| Larangan | Hasil |
|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih |
| Semua tombol pill, bayangan tebal | Bersih |
| Kartu ikon + judul + 1 kalimat berulang | Bersih |
| Teks Inggris nyasar / Lorem | Bersih ("native" sudah hilang dari teks pengguna) |
| Ukuran font/jarak tidak konsisten | Bersih |
| Warna di luar token | Bersih (`.itemReason` memakai `--ink-2` dan `--text-12`) |

## Perbaikan wajib putaran 3 (untuk `frontend`)

### K1. Menu tindakan chat: batasi lebarnya, bungkus alasannya, pendekkan teksnya

1. Di `apps/web/src/features/inbox/HandlingActions.module.css:20-28` (`.menu`), tambahkan:
   ```css
   max-width: min(20rem, var(--radix-dropdown-menu-content-available-width));
   ```
   `20rem` = 320 px. Variabel Radix menjamin menu tidak melewati tepi layar di 390.
2. Di `apps/web/src/i18n/id.ts:498`, ganti teksnya supaya lebih pendek dan istilahnya sama dengan BS3:
   ```ts
   botResumeNoReceiver: 'Belum ada webhook penerima bot. Atur di pengaturan webhook.',
   ```
3. Tes `BotInteractive.test.tsx:105` sudah memakai kunci `h.botResumeNoReceiver`, jadi tidak perlu diubah. Pesan 409
   server di baris 81 terpisah dan boleh tetap.

Hasil yang diharapkan di 390:
- lebar menu ≤ 320 px, dengan tepi kanan berjarak 8 px dari tepi layar;
- alasan tampil 2 baris dan terbaca utuh.

## Saran (tidak menahan)

- **KS1. Ikon item dua baris.**
  - Di `HandlingActions.module.css:161`, untuk item yang berisi `.itemText`, sejajarkan ikon dengan baris label,
    bukan di tengah dua baris:
    ```css
    .item:has(.itemText) { align-items: flex-start; padding-block: var(--space-8); }
    .item:has(.itemText) > svg { margin-top: 2px; }
    ```
- **KS2. Alasan bergantung pada cache.**
  - Alasan hanya muncul bila pengaturan bot channel sudah ada di cache (`enabled: false` di `useQuery`,
    `HandlingActions.tsx:60-64`).
  - Akibatnya, agen yang belum pernah membuka Pengaturan → Channel tetap melihat item ini aktif, lalu baru mendapat
    409 saat menekannya.
  - Ini keputusan yang disengaja (supaya tidak ada permintaan tambahan). Catat di `docs/DECISIONS.md` bila belum.

## Untuk putaran 4

Foto ulang hanya `kd-inbox-bot-menu-telegram` (atau layar menu yang setara), di 390 dan 1440, terang dan gelap.
Pastikan:
- menu tidak melewati tepi layar;
- alasan terbaca utuh.

Kartu Bot channel tidak perlu difoto ulang.

---

# Putaran 4 — 2026-11-19 (commit `531cabc`)

- Diperiksa di worktree sementara dengan stack terpisah: API 3191, web 5191, database `balesin_kd_e2e`, Redis db 11.
- Layar yang difoto, masing-masing di 390 dan 1440, terang dan gelap:
  - `inbox-bot-menu` (baru di `e2e/capture/screens-kanal.ts:538`);
  - `channel-email`, kini bot aktif dengan penerima siap, sehingga sakelar baru tampil;
  - `channel-telegram`, `nomor-bot`, dan `nomor-bot-mati` untuk cek regresi.
- Semua 21 foto berhasil diambil.
- **Foto bukti:** `docs/design-reviews/2026-11-19-bot-channel-lain/putaran-4/` (10 foto).

## Putusan putaran 4: LOLOS

### Verifikasi K1 dan KS1

| # | Hasil | Bukti |
|---|---|---|
| K1 Lebar menu | **Beres** | `HandlingActions.module.css:24` memakai `max-width: min(20rem, var(--radix-dropdown-menu-content-available-width))`. Di 390 menu ±318 px dan tepi kanannya ±13 px dari tepi layar. Di 1440 lebarnya juga ±318 px, tidak lagi ±460 px (`inbox-bot-menu--390-terang.png`, `--390-gelap.png`, `--1440-terang.png`, `--1440-gelap.png`) |
| K1 Alasan | **Beres** | `id.ts:498`: "Belum ada webhook penerima bot. Atur di pengaturan webhook." Teks ini terbungkus 2 baris dan terbaca utuh di keempat foto. Istilahnya sama dengan tombol "Buka pengaturan webhook" di kartu Bot |
| KS1 Ikon dua baris | **Beres** | `HandlingActions.module.css:177-185`: ikon robot sejajar dengan baris label "Kembalikan ke bot", tidak lagi di tengah dua baris. Jarak atas-bawah item 8 px |
| KS2 Cache | **Dicatat** | Sudah ada di `docs/DECISIONS.md` (entri 2026-11-19 "alasan … hanya dari cache") |

### Layar baru: pilihan Email "Bot hanya melayani pengirim terverifikasi"

Lokasinya `BotCard.tsx:330-341`, `Channels.module.css:1139-1143`, dan `id.ts:3538-3540`.

- Pilihan ini memakai `Checkbox` berbingkai yang sama dengan "Aktifkan bot untuk channel ini", jadi tampilannya konsisten. Petunjuknya memakai `.hint` (`--ink-2`) dengan jarak 4 px.
- Pilihan ini hanya muncul untuk Email ketika bot aktif. Foto Telegram dan WhatsApp tidak menampilkannya, jadi sudah benar.
- Petunjuknya menjelaskan akibat ("langsung masuk antrian tim") dan memberi alasan bawaan mati ("Biarkan mati bila server email belum mencatat hasil pemeriksaannya"). Isinya sesuai dengan DECISIONS P2-1.
- Di 390, label terbungkus 2 baris dan kotak centangnya tetap sejajar. Di gelap kontrasnya cukup.

**Regresi Telegram dan WhatsApp: tidak ada.**
- Telegram (`channel-telegram--1440-gelap.png`) masih utuh:
  - lencana kuning "Belum ada penerima";
  - peringatan "Belum ada penerima bot" dengan tombol "Buka pengaturan webhook";
  - teks "format Standar".
- WhatsApp (`nomor-bot--390-terang.png`) masih utuh:
  - teks "nomor ini";
  - catatan sesi "…hanya bisa mengirim template.";
  - lencana hijau;
  - kalimat positif saat penerima siap;
  - jadwal dan zona waktu.

## Tabel nilai putaran 4

| Layar | Ukuran · tema | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Menu "Kembalikan ke bot", Telegram (tanpa penerima) | 390 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| | 1440 T/G | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `channel-email` aktif + penerima siap + sakelar terverifikasi | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| `channel-telegram` (aktif, tanpa penerima) | 1440 G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| `nomor-bot` / `nomor-bot-mati` (WhatsApp) | 390 · 1440 T/G | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Kriteria 9 untuk `channel-email` bernilai 4 karena ada sedikit ketidakcocokan kata pada petunjuk sakelar (lihat KS3).
Kriteria 3 bernilai 4 karena alasan yang sama dengan putaran sebelumnya: kepala kartu Bot cukup padat.

## Daftar larangan §3

| Larangan | Hasil |
|---|---|
| Gradien ungu-biru, glassmorphism, emoji sebagai ikon | Bersih |
| Semua tombol pill, bayangan tebal | Bersih (bayangan menu tetap tipis) |
| Kartu ikon + judul + 1 kalimat berulang | Bersih |
| Teks Inggris nyasar / Lorem | Bersih. "SPF/DKIM/DMARC" adalah nama standar teknis, bukan teks nyasar |
| Ukuran font/jarak tidak konsisten | Bersih |
| Warna di luar token | Bersih (`.botVerified` hanya memakai `--space-4`; `--radix-*` bukan warna) |

## Saran (tidak menahan)

- **KS3. Kata "mati" pada kotak centang.**
  - Kontrolnya kotak centang, bukan sakelar, jadi frasa "Biarkan mati" kurang pas.
  - Di `id.ts:3540`, ganti dengan:
    ```ts
    'Email yang belum lolos pemeriksaan pengirim (SPF/DKIM/DMARC) langsung masuk antrian tim. Jangan dicentang bila server email belum mencatat hasil pemeriksaannya.',
    ```
- **KS4. Kaitkan dengan bagian "Verifikasi pengirim" di kartu Koneksi (opsional).**
  - Admin bisa bingung dari mana "hasil pemeriksaan" berasal.
  - Bila petunjuk diperpanjang, tambahkan: "Server tepercaya diatur di bagian Verifikasi pengirim."
  - Kalimat ini cukup sebagai teks biasa, tidak perlu tautan.
