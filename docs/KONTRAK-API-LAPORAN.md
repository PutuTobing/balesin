# Kontrak — Laporan kinerja, biaya pesan Meta, dan CSAT (Fase 5)

Skema Zod: `packages/shared/src/reports.ts` (`REPORT_ROUTES`, laporan, biaya, ekspor, CSAT). Kode:
`apps/api/src/modules/reports/` (api), `apps/worker/src/queues/csat.ts` (pengirim survei, job
pemeliharaan `csat-dispatch` tiap 15 dtk), `apps/worker/src/inbound/csat-replies.ts` (jawaban & komentar),
`packages/db/src/schema/csat.ts`. Migrasi **0027** (`csat_settings`, `csat_surveys`).

## Izin (PRD §4 "Lihat laporan (termasuk biaya pesan Meta tingkat organisasi)")

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/reports/performance?from&to&channelId` | `reports.view` | Cakupan `all` (Owner/Admin/Supervisor) = organisasi; `own` (CS/Teknisi) = baris dirinya + CSAT percakapannya, bagian lain `null`. 30/menit |
| `GET /api/v1/reports/costs?month=YYYY-MM&channelId` | `reports.view` | Cakupan `all` saja (`own` → 403 aturan `reports.organization`, diaudit) |
| `GET /api/v1/reports/export?kind&from&to\|month&channelId` | `reports.view` | CSV — **GET ber-CSRF** (`X-CSRF-Token` + same-origin), 10/jam, audit `report.exported` (`kind`, `period`, `rows`, `scope`). `own` hanya `kind=agents\|csat` (baris sendiri); lainnya 403 |
| `GET/PUT /api/v1/settings/csat` | `settings.workspace.manage` | Owner/Admin; diaudit `settings.csat.updated` (teks lama & baru) |

Tanggal = zona waktu organisasi; `from`/`to` termasuk; rentang maks. 92 hari (400). Query berjalan di
transaksi baca dengan `statement_timeout` 8 dtk → terlalu berat = **503** "Persempit rentang".

## Laporan kinerja (`report`)

- **Percakapan dalam rentang** = dibuat (`created_at`) dalam rentang (+ `channelId`).
- `summary`: `conversations`, `customerInitiated` (ada pesan pelanggan), `resolved`, `resolvedByBotOnly`
  (selesai, ada balasan bot, tanpa balasan agen), `handledByHuman`, `handoffs` (punya kejadian `handoff`),
  dan statistik durasi `{ count, averageSeconds, medianSeconds, p90Seconds }`:
  - `firstResponse` = `first_response_at − created_at` (balasan agen pertama; percakapan yang dibuka
    pelanggan);
  - `wait` = `first_assigned_at − (handoff pertama ?? created_at)`;
  - `resolution` = `resolved_at − created_at` (yang berstatus selesai).
- `trends.daily` (setiap tanggal dalam rentang: percakapan baru, yang di antaranya sudah selesai, rata-rata
  respons pertama) dan `trends.hourly` (24 jam, percakapan baru per jam).
- `agents[]`: `conversationsHandled` (percakapan yang ia balas dalam rentang), `resolved` (kejadian
  `resolved` olehnya), `messagesSent`, `firstResponse` (percakapan yang balasan agen PERTAMA-nya darinya),
  `csat`.
- `bots[]` (per API key): pesan bot, percakapan, `handoffs` oleh key itu.
- `tags[]` (tag kontak, maks. 100): percakapan, selesai, durasi resolusi.
- `csat`: `{ sent, responses, average, distribution {1..5}, responseRate }` menurut `resolved_at` survei.

## Biaya pesan Meta (`costs`, SELALU perkiraan)

Per channel WhatsApp untuk bulan itu (zona organisasi):
- **Template** per kategori (`messages.template_category`): `sent`; `billable` = diterima
  (delivered/read/played) — UTILITY ke pelanggan yang menulis ≤ 24 jam sebelumnya = `free`; `cost` =
  billable × tarif kategori menurut kode negara nomor kontak (tarif Pengaturan → Batas kirim → Tarif,
  `rateSource`).
- **Percakapan layanan** = balasan non-template agen/bot yang diterima Meta; satu per kontak per nomor
  bila tidak ada balasan sejenis 24 jam sebelumnya (perkiraan aturan 24 jam Meta). Kuota gratis
  `freeQuota` 1.000/nomor/bulan; di atasnya `billableService` × rata-rata tarif UTILITY penerimanya.
- `unknownRate` = pesan ditagih yang negaranya belum punya tarif (tidak dihitung).

## Ekspor CSV

UTF-8 BOM, CRLF; sel diawali `= + - @ TAB CR` diberi `'`. `kind`: `agents`, `daily`, `tags`, `bots`
(`from`/`to`), `costs` (`month`), `csat` (per survei: diselesaikan, nomor percakapan, agen, status, skor,
komentar pelanggan, dinilai — maks. 20.000 baris; tanpa nomor telepon).

## CSAT otomatis

Pengaturan `{ enabled (bawaan MATI), question ≤ 300, thanks ≤ 300, minIntervalHours 1–720 (bawaan 24),
updatedAt }`; teks tidak boleh memuat tautan (`http(s)://`, `www.`).

**Kapan dikirim** (`csat-dispatch`): kejadian `resolved` ≤ 15 menit terakhir yang PELAKUNYA PENGGUNA dan
terjadi setelah CSAT diaktifkan. TIDAK dikirim (status `skipped` + `skip_reason`) bila: dibuka lagi
(`reopened`), tanpa pesan pelanggan (`no_customer_message`), tanpa balasan agen manusia
(`no_human_reply` — percakapan bot/broadcast/API), jendela 24 jam tutup/≤ 5 menit lagi
(`window_closed`), channel nonaktif (`channel_unavailable`), kontak tanpa nomor
(`recipient_unavailable`), kontak sudah disurvei dalam `minIntervalHours` (`recently_surveyed`), CSAT
dimatikan sebelum terkirim (`disabled`). Penyelesaian oleh bot/API key/sistem (batas waktu bot) dan
percakapan yang dibuat `resolved` (broadcast, API v1) tidak punya kejadian `resolved` oleh pengguna →
tidak pernah disurvei. Satu survei per percakapan.

**Pesan**: daftar interaktif (`sender_kind: system`, jalur kirim biasa — rem darurat & batas tetap
berlaku) berisi 5 pilihan `5 — Sangat puas … 1 — Tidak puas`, ID baris `csat:<idSurvei>:<skor>`.

**Jawaban** (tidak tepercaya): hanya ID baris yang cocok regex ketat DAN survei milik kontak + channel
pengirim, berstatus `sent`, dikirim ≤ 24 jam → `answered` + skor (judul balasan diabaikan). Jawaban
DITEMPEL ke percakapan survei tanpa membukanya lagi, tanpa belum-dibaca/antrian, tanpa webhook
`message.received` (bot tidak menerima). Lalu pesan terima kasih. **Komentar** = pesan teks pertama ≤ 30
menit setelah menilai (dibersihkan, maks. 500); pesan itu tetap diproses biasa (bisa membuka percakapan
baru supaya keluhan tidak tertelan). Survei `sent` > 24 jam → `expired`. Hapus kontak menghapus surveinya.
