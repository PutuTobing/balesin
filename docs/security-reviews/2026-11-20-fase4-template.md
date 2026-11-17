# Review keamanan — Fase 4: Template Meta, kirim template, mulai percakapan

- Commit: `4bcef4c` (`feat(template): template Meta (sinkron, ajukan, ubah, hapus), preset ISP, kirim template & mulai percakapan`)
- Kontrak: `docs/KONTRAK-API-TEMPLATE.md`, DECISIONS 2026-11-20
- Peninjau: subagent `security`
- Model ancaman: akun CS dibobol / orang dalam yang ingin memakai nomor perusahaan untuk spam/penipuan ke
  nomor sembarang atau membaca kode OTP pelanggan; API key billing yang bocor (`messages:initiate`);
  webhook Meta palsu/berlebih.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi. 1 Sedang (kode OTP tersimpan & tampil polos), 1 Rendah (kontak/percakapan
sampah sebelum batas kirim dicek), beberapa Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Izin | `apps/api/src/modules/templates/templates.routes.ts`, `rbac-matrix.integration.test.ts`, `packages/shared/src/permissions.ts` | lihat/daftar = `inbox.reply`; kelola/ajukan/hapus/sinkron/preset = `templates.manage` (Owner/Admin/Supervisor); mulai percakapan = `inbox.initiate` (Owner/Admin/Supervisor) — CS & Teknisi 403 tanpa kontak baru (tes baru). Tulis = CSRF + 60/menit; sinkron 6/menit/organisasi |
| Scope API key | `packages/shared/src/api-keys.ts` | `messages:initiate` baru, TIDAK tersirat dari `messages:send` — key `messages:send` → 403 di `/public/messages/template`, tanpa kontak/pesan (tes baru) |
| Di luar jendela 24 jam | `apps/api/src/modules/messages/outbound.service.ts` (cek jendela `input.type !== 'template'`), worker `messages.ts` (sama) | Hanya `template` yang lolos, di api DAN worker; jenis lain tetap 409 |
| Template yang boleh dikirim | `apps/api/src/modules/templates/template-send.ts:44-80` | dicari di organisasi pengirim (organisasi lain → 404); harus `APPROVED` (DRAFT/PENDING/REJECTED/PAUSED/DISABLED/DELETED → 409); `waba_id` = WABA channel percakapan (lain → 409); isi diparse ulang (rusak → 409) — tes baru |
| Nilai variabel | `template-send.ts:28-39`, `packages/shared/src/templates.ts:576-588` | wajib, ≤ 1.024, tanpa NUL, tanpa baris baru/tab/> 4 spasi (kosong/`\n`/`\t`/5 spasi → 400, tidak ada pesan — tes baru) |
| Media judul | `outbound.service.ts` (`case 'template'`) | unggahan `source=upload` milik pengirim yang SAMA (pengguna atau key), channel sama, belum dihapus/kedaluwarsa, jenis cocok dengan format judul; selain itu 404/400 |
| Mulai percakapan (web) | `templates.routes.ts:256-300`, `outbound.service.ts` `startWithTemplate` | nomor dinormalkan ke E.164 (`^[1-9]\d{6,14}$`); urutan batas: 30/menit per pengguna, 600/menit organisasi, **200/24 jam per pengguna** (tetap), lalu batas harian/rem darurat di `sendAs`; percakapan terbuka dipakai (tetap lewat cakupan `sendAs`), selain itu baru `served` dipegang pemula; idempoten per pengirim (`clientMessageId`) |
| API v1 `messages:initiate` | `public-api.routes.ts` (`routes.templateMessage`) | 600/menit organisasi, idempotensi per key (`Idempotency-Key`), batas harian PER KEY + organisasi + rem darurat (`sendAs`), template dicari per channel+nama+bahasa di organisasi key |
| Percakapan `resolved` dari key | `outbound.service.ts` `startWithTemplate` | Nilai: notifikasi billing tidak membanjiri antrian. Efek samping dicatat di Info 2 |
| Webhook status template | `packages/core/src/meta/webhook-payload.ts` (`templateUpdateValueSchema`), `whatsapp-webhook.service.ts` | Hanya 3 field template; skema ketat dengan batas panjang (ID ≤ 64, nama ≤ 512, alasan ≤ 200…); yang disimpan HANYA isian template (tanpa data pelanggan); field WABA lain tetap `skipped`. Tanda tangan webhook tetap wajib (jalur yang sama). `applyTemplateUpdate` dibatasi organisasi + WABA channel |
| Sinkron | `packages/db/src/templates.ts`, `templates.service.ts:113-128` | `localChanges` tidak ditimpa; hilang dari Meta → `DELETED` (baris disimpan); maks 50 halaman × 100; galat Meta → pesan Indonesia (`META_ERROR_MESSAGES` / subkode terdokumentasi / "Meta menolak…"), teks mentah Meta TIDAK diteruskan; log hanya jenis + kode |
| Audit | `audit.service.ts`, `packages/shared/src/audit.ts` | `template.*` tanpa isi; `template.synced` hanya jumlah |
| Preset | `packages/shared/src/template-presets.ts` | generik (tanpa nama perusahaan, URL, nomor; grep "Sky" kosong); semua lolos `validateTemplate` (tes lama) |

---

## B. Temuan

### S1 (Sedang) — Kode OTP tersimpan & tampil sebagai teks biasa

- Bukti: `apps/api/src/modules/templates/template-send.ts:84-101` — template AUTHENTICATION menyimpan
  `preview: "Kode verifikasi: <kode>"` ke `messages.text` dan kode di `extras.template.values`/`buttons`.
- Kode itu lalu terlihat oleh siapa pun yang memegang `inbox.view` atas percakapan itu (riwayat, pratinjau
  pesan terakhir, pencarian), ikut ekspor data kontak, diteruskan ke webhook keluar (`data.message.text`), dan
  tersimpan selamanya (retensi pesan).
- Dampak: orang dalam / akun CS dibobol bisa membaca OTP pelanggan yang dikirim aplikasi billing/portal
  lewat `messages:initiate` dan memakainya untuk masuk ke akun pelanggan (atau menipu pelanggan dengan kode
  yang benar). Kode OTP berumur pendek (≤ 90 menit) sehingga levelnya Sedang, bukan Tinggi.
- Perbaikan:
  1. `messages.text` untuk kategori AUTHENTICATION = `Kode verifikasi: ••••••` (tanpa kode);
  2. kode hanya disimpan sampai worker mengirimnya (kosongkan `extras.template.values`/`buttons` setelah
     terkirim/gagal final), atau simpan terenkripsi `SecretBox` dan buang setelah kirim;
  3. jangan teruskan nilai OTP di webhook keluar / ekspor;
  4. tes regresi.
- Tes: `it.fails` "S1: kode OTP tidak tersimpan sebagai teks…" — gagal di
  `expected 'Kode verifikasi: 482913' not to contain '482913'`.

### R1 (Rendah) — Kontak & percakapan dibuat sebelum batas kirim/rem darurat dicek

- Bukti: `outbound.service.ts` `startWithTemplate` — `ensureContact` (`contactsService.createFromApi`) dan
  pembuatan percakapan `resolved` terjadi SEBELUM `sendAs` → `assertCanSend` (batas harian per key/organisasi,
  rem darurat). Jalur web dibatasi 200/hari per pengguna sebelum itu; jalur key hanya 600/menit organisasi.
- Dampak: key yang bocor/tertahan (batas harian habis, rem darurat ditarik) tetap bisa membuat ribuan
  kontak + percakapan + kejadian `contact.created`/`conversation.created` (webhook) per menit untuk nomor
  sembarang — mengotori data & webhook, walau tidak ada pesan terkirim. Juga template/parameter yang tidak
  sah ditolak SETELAH kontak dibuat.
- Perbaikan: panggil `assertCanSend`-pra (rem darurat + batas harian, tanpa mencatat) dan
  `resolveTemplateSend` SEBELUM `ensureContact`, atau bungkus kontak + percakapan + pesan dalam satu
  transaksi yang batal bila kirim ditolak.
- Tes: `it.fails` "R1: key yang tertahan… tidak membuat kontak/percakapan sampah" — gagal di
  `expected [ {…} ] to have a length of +0 but got 1`.

---

## C. Info

1. **Variabel tombol URL** (`{{1}}` di akhir URL template yang disetujui) diisi bebas oleh pengirim/key:
   akhiran bisa memuat `?redirect=…`/`#…`. Domain tetap milik template yang disetujui Meta, tetapi
   pastikan halaman tujuan tidak punya open redirect; pertimbangkan membatasi nilai ke `[A-Za-z0-9._~-]`.
2. **Percakapan dari key berstatus `resolved`** tidak terlihat di antrian; spam dari key bocor kurang
   terlihat tim. Deteksi bertumpu pada batas harian per key (audit + email Owner) — pastikan banner
   keamanan menampilkan `sending.limit_reached` untuk key.
3. **Nomor `0…` → `62…`** (`normalizeWhatsappNumber`) mengasumsikan Indonesia. Untuk produk white-label,
   kode negara bawaan sebaiknya dari pengaturan organisasi.
4. **Validasi nilai variabel** menolak `\n`/`\t` tetapi tidak `\r`, U+2028/U+2029, atau karakter kontrol
   lain → ditolak Meta saat kirim (pesan gagal, bukan celah). Bisa disamakan dengan `\p{Cc}`.
5. **Batas `mulai-percakapan` dikonsumsi sebelum cek idempotensi** — mengulang permintaan yang sama
   menghabiskan kuota 200/hari. Kecil.

---

## D. Tes penjaga

Berkas baru: `apps/api/src/modules/templates/security-review-fase4-template.integration.test.ts` — 4 `it` + 2
`it.fails`: key tanpa `messages:initiate` 403 tanpa kontak; CS & Teknisi tidak bisa mulai percakapan; template
organisasi lain 404 / status selain APPROVED 409 / WABA lain 409; nilai variabel tidak sah 400; `it.fails`
S1 (OTP) dan R1 (kontak sampah).

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/api`: tes penjaga template | 4 lulus + 2 `it.fails` |
| Salinan `it.fails` → `it` (sementara, sudah dihapus) | 2 gagal tepat di asersi S1 & R1 |
| `apps/api`: `vitest run src/modules/templates src/modules/bot src/modules/public-api src/modules/messages src/modules/webhooks src/rbac-matrix…` | 118 lulus + 2 `it.fails`, 12 berkas (putaran pertama melaporkan 6 berkas gagal tanpa satu pun tes gagal saat stack E2E frontend berjalan bersamaan; diulang: 12/12 lulus) |
| `apps/worker`: `vitest run` | 129 lulus |
| `packages/shared`: `vitest run` | 115 lulus |
| `packages/core`: `vitest run src/meta` | 121 lulus |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
