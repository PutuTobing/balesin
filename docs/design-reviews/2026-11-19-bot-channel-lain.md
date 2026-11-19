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
