# Kontrak — Broadcast / kampanye template (Fase 4)

Kampanye template WhatsApp ke banyak penerima. Skema Zod: `packages/shared/src/broadcasts.ts`
(kampanye, pemetaan, normalisasi nomor, estimasi, pengaturan, konektor, alarm). Alamat:
`API_ROUTES.broadcasts`, `API_ROUTES.alarms`. Kode: `apps/api/src/modules/broadcasts/` (api),
`apps/worker/src/queues/broadcast.ts` (worker), `apps/worker/src/inbound/broadcast-replies.ts`
(balasan + tag otomatis), `packages/db/src/schema/broadcasts.ts` + `packages/db/src/broadcasts.ts`.
Migrasi 0025.

## Izin (PRD §4)

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET/POST /api/v1/broadcasts` | `broadcast.send` | Daftar (`status`, kursor) / buat draf `{ name, channelId, templateId }` → **201** |
| `GET/PATCH/DELETE /api/v1/broadcasts/:id` | `broadcast.send` | Ubah/hapus HANYA draf (409 selain itu) |
| `POST /…/:id/recipients/upload` | `broadcast.send` | multipart `file` (CSV/XLSX ≤ 5 MB), query `phoneColumn?` → `{ broadcast, report }` |
| `POST /…/:id/recipients/segment` | `broadcast.send` | `{ tagIds[≤10], tagMatch: any\|all, attributes[≤5] {key,value} }` |
| `POST /…/:id/recipients/connector` | `broadcast.send` | `{ connectorId }` (tarik dari konektor REST) |
| `GET /…/:id/recipients?status=&cursor=` | `broadcast.send` | `pending\|skipped\|cancelled\|sent\|delivered\|read\|failed\|replied` |
| `GET /…/:id/preview` | `broadcast.send` | ≤ 5 contoh terisi + jumlah penerima yang datanya kurang/salah |
| `GET /…/:id/estimate` | `broadcast.send` | Estimasi biaya (lihat "Estimasi") |
| `POST /…/:id/submit` | `broadcast.send` | `{ confirmation }` WAJIB. → `scheduled`, atau `pending_approval` bila penerima > ambang |
| `POST /…/:id/approve` | `broadcast.approve` | `{ confirmation }` WAJIB; pembuat/pengaju TIDAK boleh (403 aturan `broadcast.approve.own`) |
| `POST /…/:id/reject` | `broadcast.approve` | `{ reason }` → kembali `draft` |
| `POST /…/:id/pause` | `broadcast.send` | Seketika, tanpa konfirmasi (arah aman) |
| `POST /…/:id/resume` | `broadcast.send` | `{ confirmation }` WAJIB; dijeda rem otomatis/rem darurat → butuh `sending.resume` (403 aturan `broadcast.resume.brake`); rem darurat organisasi masih ditarik → 409 |
| `POST /…/:id/cancel` | `broadcast.send` | Penerima `pending` → `cancelled` |
| `GET /…/:id/report` | `broadcast.send` | Laporan |
| `GET /…/:id/report/export` | `contacts.export` | CSV per penerima (data pribadi): **GET ber-CSRF** (`X-CSRF-Token` + same-origin), 10/jam, audit `broadcast.exported` |
| `GET /api/v1/broadcasts/connectors` | `broadcast.send` | Pilihan konektor `{ id, name }` |
| `GET/PUT /api/v1/settings/broadcast` | `sending.limits.manage` | PUT + `confirmation`; MELONGGARKAN pelindung hanya Owner (403 aturan `broadcast.settings.loosen`) |
| `GET/POST /api/v1/settings/broadcast-connectors` | `integrations.manage` | Buat dengan header auth = `confirmation` |
| `PATCH/DELETE /…/broadcast-connectors/:id` | `integrations.manage` | Ganti header, atau ganti URL konektor berheader = `confirmation` |
| `POST /…/broadcast-connectors/:id/test` | `integrations.manage` | 6/menit/organisasi |
| `GET/PUT/DELETE /api/v1/settings/alarms/telegram` | `integrations.manage` | PUT & DELETE = `confirmation` |
| `POST /api/v1/settings/alarms/telegram/test` | `integrations.manage` | 6/menit/organisasi |

Tulis = CSRF (hook auth), 60/menit/pengguna; impor 30/jam/pengguna. Audit (`targetType: broadcast`,
hanya ID/nama kampanye/jumlah — TANPA nomor/isi): `broadcast.created/updated/deleted/
recipients_imported/submitted/approved/rejected/paused/resumed/cancelled/exported`,
`settings.broadcast.updated`, `broadcast_connector.*` (host saja), `settings.alarm_telegram.*`.

## Status

`draft` → `pending_approval` (penerima valid > ambang) → `scheduled` → `running` → `completed`.
`paused` (`pause.reason`: `manual` | `emergency_brake` | `failure_spike` | `meta_blocked` | `quality_low` |
`template_unavailable` | `channel_unavailable`; `requiresAdmin` = bukan `manual`) dan `cancelled` dari
`scheduled`/`running`. `running` bisa MENUNGGU (`waiting.reason`: `daily_quota` | `meta_tier` |
`meta_rate_limit`, `until`) — lanjut sendiri.

## Sumber penerima

- **CSV/XLSX**: baris 1 = judul (kosong → `kolom_N`, kembar → `_2`). CSV: `,`/`;`/tab, kutip RFC 4180,
  BOM. XLSX: lembar pertama, nilai tersimpan (rumus/makro tidak dijalankan), angka besar → digit utuh;
  `.xls` lama ditolak. Batas: 5 MB, 20.000 penerima, 30 kolom, isian 500 karakter, isi XLSX terbuka
  ≤ 40 MB (zip bomb). Kolom nomor: dari judul (`nomor`, `no hp`, `wa`, `phone`, …) atau ≥ 60% isinya
  nomor; bisa dipilih lewat `phoneColumn`.
- **Normalisasi nomor (Indonesia dulu)**: `0…`/`8…` (nol hilang di Excel)/`62…` → `+62…`; 8–13 digit
  setelah 62; negara lain hanya bila ditulis `+`/`00`; format ilmiah Excel (`6,28E+12`) ditolak
  tersendiri.
- **Laporan impor** `{ sourceRows, recipients, rejectedRows, issues[≤200] {row, issue}, issueCounts,
  columns, phoneColumn }`; `issue`: `phone_missing | phone_invalid | phone_scientific | duplicate |
  value_too_long`. Satu nomor SEKALI per kampanye (indeks unik).
- **Segmen**: kontak WhatsApp bernomor dengan tag (`any`/`all`) dan/atau atribut sama persis. Kolom:
  `nomor`, `nama` (nama tim → nama profil), lalu kunci atribut.
- **Konektor REST**: `GET url` dengan header auth opsional (terenkripsi, hanya `authHeaderTail` yang
  tampil), jawaban JSON array objek di `itemsPath` (`data.items`, kosong = akar), `phoneField` = kolom
  nomor. Aturan SSRF webhook keluar (IP privat hanya lewat allowlist Pengaturan → Integrasi, https untuk
  publik, port 80/443/5678/8080/8443, DNS sekali), TANPA redirect, 20 dtk, ≤ 5 MB. Kode tes:
  `BROADCAST_CONNECTOR_TEST_CODES`. Simpan rahasia di header, bukan di query URL.

## Pemetaan & pratinjau

`mapping = { body: { "1": {kind:"column", column} | {kind:"text", value} }, header, buttons: { "0": … } }`.
Wajib untuk setiap variabel body, judul TEKS, tombol URL ber-`{{1}}`/salin kode. Template harus
`APPROVED`, milik WABA nomor pengirim; **AUTHENTICATION (OTP) dan judul media ditolak** (409). Mengganti
template mengosongkan pemetaan. Saat diajukan, penerima yang datanya kosong/melanggar aturan Meta
(baris baru, tab, > 4 spasi) ditandai `skipped` (`missing_variable`/`invalid_variable`).

## Estimasi

`{ currency, category, recipients, billable, free, unknownRate, total, rateSource, computedAt }`:
penerima `pending` × tarif kategori per kode negara (kode panggil terpanjang). UTILITY ke pelanggan yang
jendela layanannya masih terbuka = `free`. Nomor tanpa tarif = `unknownRate`. Salinan estimasi disimpan
saat diajukan (dasar persetujuan). Tarif bawaan Indonesia = PERKIRAAN (lihat `rateSource`), diatur di
pengaturan.

## Pengaturan (`GET/PUT /settings/broadcast`)

`{ approvalThreshold (50), maxRatePerSecond (10, ≤20), quotaReservePercent (20), autoBrake: { enabled,
failureSpikePercent (50), failureSpikeMinSample (20), spikeMultiplier (10), spikeMinPerMinute (120),
spikeAbsolutePerMinute (400) }, rates: { currency, rates[{country, callingCode, marketing, utility,
authentication}], source }, updatedAt, updatedBy }`. Melonggarkan (ambang/kecepatan naik, cadangan turun,
rem otomatis dimatikan/dilonggarkan) = Owner saja.

## Worker (antrian `broadcast`, payload hanya ID)

- `tick` 2 dtk: `scheduled` jatuh tempo → `running`; rem darurat organisasi → kampanye aktif `paused
  (emergency_brake)` + alarm sekali per penarikan; kampanye `running` tanpa sewa → job `run`.
- `run` per kampanye: sewa 60 dtk, potongan ±25 dtk, throttle `ratePerSecond`. Klaim penerima
  `pending → queued` + kontak/percakapan/pesan dalam SATU transaksi (kampanye `FOR SHARE` → jeda/batal
  berlaku seketika). Pesan: `senderKind: broadcast`, `messages.broadcast_id`, kategori template;
  percakapan terbuka dipakai, selain itu terakhir, selain itu dibuat `resolved`. Dikirim lewat
  `processSendMessageJob` (rem darurat, klaim kirim atomik). Restart: pesan `pending` tanpa klaim
  dikirim ulang lebih dulu (tidak pernah dobel).
- Anti-dobel lintas kampanye: nomor yang menerima broadcast (template sama, atau `scope: any`) dalam
  `dedupe.hours` (bawaan 24) → `skipped (recently_sent)`; diserialkan kunci identitas nomor.
- Cadangan kuota CS: berhenti menunggu bila pesan keluar 24 jam organisasi ≥ batas harian ×
  (100 − cadangan)%; tier Meta (`TIER_*`) diperlakukan sama per nomor.
- Rem otomatis kampanye (butuh `sending.resume` untuk lanjut): ≥ `failureSpikePercent`% gagal dari sampel
  terakhir (≥ `failureSpikeMinSample`, sejak terakhir dilanjutkan); kode Meta 368, 130497, 131031, 131048,
  131042, 190, 10, 131005 → `meta_blocked`; 132001/132015/132016 atau template tidak `APPROVED` →
  `template_unavailable`; kualitas `RED`/status `FLAGGED|RESTRICTED|BANNED|DISCONNECTED` → `quality_low`;
  channel nonaktif/kredensial → `channel_unavailable`. Batas laju Meta → menunggu (backoff).
- `guard` tiap menit: **rem darurat OTOMATIS organisasi** bila pesan keluar NON-broadcast/menit >
  `spikeAbsolutePerMinute`, atau > `spikeMinPerMinute` DAN > `spikeMultiplier` × rata-rata 7 hari →
  `sending_paused_at` (pelaku kosong), audit `sending.paused {automatic: true}`, alarm `auto_brake`,
  email Owner `sending_auto_paused`, event `sending.changed`. Retensi: data kolom penerima dikosongkan
  30 hari setelah selesai/batal.
- `alarms` tiap 10 dtk: outbox `alarm_events` → Telegram (teks polos tanpa data pelanggan); tanpa
  Telegram = `skipped`; token/chat salah = `failed`; lainnya diulang (≤ 5×).

## Laporan

`{ recipients, rejectedRows, pending, skipped, skippedByReason, cancelled, sending, sent, delivered,
read (termasuk played), failed, failures[{reason, errorCode, message (Indonesia), count}], replied,
cost {currency, billable (= delivered+read), total}, estimate, startedAt, completedAt }`. **Dibalas** =
pesan masuk pelanggan di nomor yang sama ≤ 72 jam setelah diproses (`replied_at`). **Tag otomatis**
(`autoTagId`): dipasang ke KONTAK saat ia membalas (kejadian `tag_added` pelaku sistem, event
`conversation.detail tags`). Ekspor CSV (UTF-8 BOM): `baris, nomor, status, alasan_dilewati,
status_pesan, alasan_gagal, kode_meta, diproses_pada, dibalas_pada`; sel diawali `= + - @` diberi `'`.

## Alarm Telegram

`telegram = { configured, enabled, tokenTail, chatId, lastTest, updatedAt }`. PUT `{ botToken?, chatId
(-100…/@kanal), enabled, confirmation }` (token kosong = pakai yang lama). Token terenkripsi (konteks
`telegram_alarm_settings.bot_token`), tidak pernah dikirim balik/di-log. Tes: `TELEGRAM_TEST_CODES`.
Jenis alarm: `emergency_brake`, `auto_brake`, `broadcast_auto_paused`, `broadcast_pending_approval`,
`broadcast_completed`.

## Real-time (syarat broadcast)

Hub WebSocket menggabungkan event Redis per 250 ms, membaca keadaan dengan satu query `IN (…)` per
batch, menggabungkan > 20 `message.status` per batch ke `conversation.updated`, membatasi 200
event/detik per organisasi (lebih → event dibuang + SATU `{ "type": "resync" }` per 2 dtk; web memuat
ulang lewat REST), dan memvalidasi ulang semua sesi socket dengan satu query (`peekMany`).

## Kontak (review R4)

Kontak hanya-nomor menerima BSUID pertama hanya bila pernah ada pesan masuk atau dibuat ≤ 30 hari
(kejadian `whatsapp_identity_attached`). Selain itu: kontak baru (BSUID + nomor) bertanda
`possible_duplicate_of_contact_id` (kejadian `possible_duplicate`), kontak lama tetap sebagai catatan
CRM tanpa nomor (`wa_identity_released_at`).
