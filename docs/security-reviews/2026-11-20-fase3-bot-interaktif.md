# Review keamanan — Fase 3: Bot eksternal + pesan interaktif

- Commit: `d93859b` (`feat(bot): saklar bot per channel & percakapan, jam kerja bot, handoff, batas waktu bot, pesan interaktif`)
- Kontrak: KONTRAK-API-INBOX ("Bot eksternal", "Pesan interaktif"), KONTRAK-API-PUBLIK, KONTRAK-API-MOBICHAT,
  KONTRAK-WEBHOOK-KELUAR; DECISIONS 2026-11-19
- Peninjau: subagent `security`
- Model ancaman: akun CS dibobol; sesi Admin curian TANPA password (pengaturan bot tanpa konfirmasi);
  API key bot bocor (ada di body webhook n8n); pelanggan jahat yang mengirim balasan tombol/daftar
  buatan sendiri.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi. 1 Rendah (pelanggan bisa "terjebak" di bot) + Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Pengaturan bot channel | `apps/api/src/modules/bot/bot.routes.ts`, `bot.service.ts:79-110` | `integrations.manage` (Owner/Admin); PUT ber-CSRF, 30/menit, `assertActorStillAuthorized` + `FOR UPDATE`, audit `channel.bot_updated` tanpa data pelanggan. CS/Supervisor 403, tanpa CSRF 403, channel organisasi lain/bukan UUID 404 (tes baru). Tanpa konfirmasi identitas: dapat diterima (bukan kredensial, bisa dibalik) — lihat R1 untuk dampak sabotase |
| Status awal `bot` | `apps/worker/src/inbound/handlers.ts:70-90` | `bot` hanya bila saklar aktif DAN dalam jam kerja bot; `bot_hours` rusak → `unserved` (gagal-aman) |
| Push | DECISIONS, `assignment.service.ts` (handoff → push antrian) | pesan selama `bot` tidak memicu push manusia; handoff (bot/agen/sistem) → push "kembali ke antrian" |
| Handoff oleh key | `assignment.service.ts:538-590`, `public-api.routes.ts` (`routes.handoff`), MobiChat | `conversations:write` wajib (tanpa → 403, tes baru). Key HANYA melepas dari `bot`; `agent_id` diabaikan; tugaskan hanya dari bot/antrian (dipegang agen → 409); selesai hanya `bot` (409). Percakapan dipegang agen tidak berubah lewat handoff publik (`changed:false`, tes baru). Key dicek ulang di transaksi akhir |
| Saklar per percakapan (agen) | `assignment.routes.ts` (`routes.bot`), `assignment.service.ts:591-630` | `inbox.reply` + cakupan + CSRF (tanpa CSRF 403, tes baru); kembali ke bot butuh bot channel aktif; mengambil dari agen lain butuh `inbox.assign` + audit penolakan. Teknisi (cakupan `assigned`) tidak bisa menyentuh percakapan agen lain (404, status tetap — tes baru) |
| Batas waktu bot | `apps/worker/src/queues/maintenance.ts:196-280` | Hanya `status='bot'` dengan `bot_awaiting_since` lebih tua dari `bot_timeout_minutes` channel; `FOR UPDATE SKIP LOCKED`, maks 200/putaran; pelaku sistem (`actor` null), webhook `conversation.handoff`, push antrian (hanya ID). Agen & antrian tidak tersentuh (tes baru) |
| `bot_awaiting_since` | `outbound.service.ts` (`botAwaitingSince: null` saat kirim via key), handlers (`coalesce` hanya saat `bot`), constraint DB | Dikosongkan saat status bukan `bot`; hanya pesan pelanggan pertama yang belum dibalas |
| `botOnly` | `apps/worker/src/queues/webhooks-out.ts:506-522` | dinilai SAAT DISPATCH dari status percakapan di DB (organisasi yang sama); bukan `bot` → tidak dikirim. Isi pesan tidak keluar ke bot setelah agen mengambil alih |
| Pesan interaktif — validasi | `packages/shared/src/interactive.ts`, `apps/worker/src/queues/messages.ts` (`case 'interactive'`), `packages/core/src/meta/messaging.ts` (`interactivePayload`) | Skema bersama dengan batas Meta (tombol 1–3, judul ≤ 20, unik; daftar ≤ 10 baris; ID tanpa karakter kontrol; teks tanpa NUL); worker memvalidasi ULANG `extras.interactiveMessage` (jsonb tidak tepercaya) dan hanya untuk `outbound`, gagal → `meta_rejected`. 7 bentuk tidak sah → 400, tidak tersimpan; di luar jendela 24 jam → 409 (tes baru). Rem darurat & batas tetap (jalur kirim sama) |
| Balasan interaktif pelanggan | `webhooks-out.ts:232-249` | `{ type, id, title, description }` hanya untuk pesan `inbound`, nilai non-string → `null`; diteruskan sebagai DATA (lihat Info 2) |
| S1 MobiChat (Putaran 2) | `webhooks-out.ts:736-752` `scrubSnippet`, `packages/core/src/redact.ts` (`whsec_`) | lihat "Putaran 2" di laporan MobiChat |

---

## B. Temuan

### R1 (Rendah) — Percakapan bisa "terjebak" di status `bot` tanpa batas waktu dan tanpa push

- Bukti:
  - `bot.service.ts:79-110` — mematikan saklar bot channel TIDAK memindahkan percakapan yang sedang
    `bot`; `botTimeoutMinutes` boleh `null` (`packages/shared/src/bot.ts:59-64`, constraint 0023).
  - `handlers.ts:70-90` — status awal `bot` tidak memeriksa apakah ada penerima yang benar-benar aktif
    (endpoint webhook aktif yang melanggan `message.received`; endpoint MobiChat dengan key yang masih
    aktif — `mobichat_key_inactive`; endpoint nonaktif otomatis setelah 20 gagal).
  - `maintenance.ts:196` — batas waktu hanya berjalan bila `bot_timeout_minutes` terisi.
- Dampak: bila bot mati/tak terhubung dan batas waktu kosong, pelanggan baru "diparkir" di tab Bot tanpa
  push ke manusia sampai ada agen yang melihat tab itu. Sesi Admin curian (tanpa password) bisa memicu
  ini dengan sengaja: nyalakan bot + batas waktu kosong di channel yang tak punya penerima bot → layanan
  pelanggan senyap. Tercatat di audit dan bisa dibalik, tetapi tidak memunculkan banner keamanan.
- Perbaikan (pilih yang sederhana):
  1. Matikan bot channel → serahkan semua percakapan `bot` channel itu ke antrian (kejadian `handoff`
     pelaku pengguna, push antrian) — kontrak sudah menyebut "bisa dibalik kapan saja".
  2. Wajibkan/bawaankan `timeoutMinutes` (mis. 15) saat `enabled: true`, atau perlakukan `null` sebagai
     batas maksimum (1.440).
  3. `botAwareInitialStatus` → `unserved` bila tidak ada endpoint aktif yang melanggan `message.received`
     (dan untuk MobiChat, key-nya aktif).
  4. Opsional: kejadian keamanan `warning` bila bot dinyalakan oleh selain Owner atau tanpa batas waktu.
- Tes: `it.fails` "R1: mematikan bot channel menyerahkan percakapan…" — gagal di
  `expected 'bot' to be 'unserved'`.

---

## C. Info

1. **CS boleh mengembalikan ke bot percakapan rekan / dari antrian** (CS memegang `inbox.assign`, sesuai
   matriks). Akun CS dibobol bisa "memarkir" banyak percakapan ke bot (hilang dari antrian & push).
   Tercatat `bot_resumed` per percakapan; pertimbangkan memasukkan `bot_resumed` ke pengawas aksi massal
   (`watchBulk`) seperti alih/lepas.
2. **Balasan tombol/daftar pelanggan tidak tepercaya.** `reply_id`/`title`/`description` datang dari
   pelanggan (klien WhatsApp tidak resmi bisa mengirim ID buatan). Bot/n8n harus memperlakukannya
   sebagai masukan pengguna (bukan perintah tepercaya), terutama `message_text` MobiChat = judul.
   Tambahkan satu kalimat di KONTRAK-API-MOBICHAT/WEBHOOK-KELUAR.
3. **Bot bisa menahan percakapan tanpa batas** dengan terus membalas lewat key (setiap balasan
   mengosongkan `bot_awaiting_since`). Sesuai desain; pelanggan bisa diambil agen kapan saja.
4. **Potongan jawaban lama** (tersimpan sebelum `scrubSnippet`, ≤ 7 hari) tidak disensor ulang; habis
   sendiri oleh retensi 7 hari. Bila instalasi produksi sudah memakai webhook MobiChat dengan penerima
   pemantul, kosongkan `response_snippet` sekali.
5. **Pohon kerja**: pekerjaan templat yang belum di-commit (`packages/shared/src/templates*.ts`,
   `api-routes.ts`) membuat `contracts.test.ts` gagal (`/api/v1/templates/presets/:presetKey`). Bukan dari
   commit ini.

---

## D. Tes penjaga

- `apps/api/src/modules/bot/security-review-fase3-bot-interaktif.integration.test.ts` — 9 `it` + 1
  `it.fails`: pengaturan bot (RBAC, CSRF, audit, 404 lintas organisasi); Teknisi tidak bisa menyentuh
  chat agen lain; saklar tanpa CSRF 403; handoff publik tidak mengacak chat agen; key tanpa
  `conversations:write` 403; batas waktu hanya bot yang lewat; 7 bentuk interaktif tidak sah → 400;
  interaktif di luar jendela → 409; `it.fails` R1.
- `apps/worker/src/queues/security-review-fase3-scrub-snippet.test.ts` — 4 `it`: key utuh/berulang,
  terpotong di batas 500 byte (12/20/30/hampir utuh), pola umum `blsn_live_`/`whsec_`/Bearer, teks biasa
  utuh.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/api`: tes penjaga bot | 9 lulus + 1 `it.fails` (diverifikasi gagal tepat di asersi R1) |
| `apps/api`: `vitest run src/modules/bot src/modules/compat-mobichat src/modules/outgoing-webhooks src/modules/public-api src/modules/inbox src/rbac-matrix… forbidden-pattern` | 128 lulus + 1 `it.fails`, 17 berkas |
| `apps/worker`: `vitest run src/queues src/inbound` (+ penjaga scrub) | 119 lulus (+ 4) |
| `packages/core`: `vitest run src/redact.test.ts src/meta src/net` | 202 lulus |
| `packages/shared`: `vitest run` | 114 lulus, 1 gagal (Info 5, pohon kerja) |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
