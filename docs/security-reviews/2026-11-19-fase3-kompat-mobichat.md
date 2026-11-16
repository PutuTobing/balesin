# Review keamanan — Fase 3: Lapisan kompatibel MobiChat

- Commit: `dc649d9` (`feat(compat): lapisan kompatibel MobiChat (/api/public/*, /api/bot/*) + webhook format MobiChat`)
- Kontrak: `docs/KONTRAK-API-MOBICHAT.md`, DECISIONS 2026-11-19
- Peninjau: subagent `security`
- Model ancaman:
  - API key bot yang bocor (sengaja ada di body webhook n8n);
  - key organisasi lain yang menebak ID numerik;
  - pemegang URL media bertanda tangan;
  - `media_url` yang diarahkan ke jaringan internal;
  - akun CS dibobol (tidak bisa membuat key atau webhook: Owner/Admin + konfirmasi).

## Putusan: **AMAN**

Tidak ada temuan Kritis atau Tinggi. Ada 1 temuan Sedang (sebaiknya diperbaiki sebelum dipakai produksi
dengan penerima yang memantulkan body) dan beberapa Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Autentikasi `X-API-Key` | `apps/api/src/modules/api-keys/api-key-auth.ts` (`presentedKey`), `http/route-access.ts` (`requireMobichatApiKeyScope`), `auth.hook.ts` | Hanya header (tidak peka huruf); Bearer & `?api_key=` → 401 di `/api/public/*`; `X-API-Key` → 401 di `/api/v1/public/*`. Jalur gagal sama (kunci IP, IP allowlist, batas 300/menit). Header `x-api-key` disensor logger (`packages/core/src/redact.ts:116`) |
| Bentuk galat | `http/error-handler.ts` (`prepareErrorReply`), `mobichat.routes.ts` | `{ success:false, code, message }` / `{ error }` dari jalur yang sama dengan amplop standar (pesan aman, tanpa stack/detail internal); `Retry-After` tetap |
| Scope per rute | `mobichat.routes.ts`, `packages/shared/src/api-keys.ts` | baca/kirim/`conversations:write`/`contacts:write` dipetakan per rute (tes lama); `assertApiKeyStillAuthorized` (`api-key-actor.ts`) mengunci key `FOR SHARE` dan cek ulang di transaksi akhir |
| ID numerik lintas organisasi | `mobichat.service.ts:136-143,411-416` | `conversations.number`/`messages.number` = identity GLOBAL, tetapi setiap pencarian dibatasi `organizationId` key. Key organisasi lain → 404 untuk riwayat, status, handoff, unassign, assign, catatan, kirim, bot reply, ubah kontak, tag lewat nomor; tidak ada yang berubah (tes baru) |
| Assign/unassign oleh bot | `assignment.service.ts` (`assignTarget`, `releaseAsApiKey`) | Sasaran harus UUID agen AKTIF organisasi yang sama dengan `inbox.reply` (`FOR SHARE`); agen organisasi lain / `42` / `bot` → 400 (tes baru). Lepas agen hanya bila `agent_id` = pemegang; ID lain → tidak berubah (tes baru). Handoff tidak merebut dari agen (tes lama) |
| URL media bertanda tangan | `compat-mobichat/media-signature.ts`, `mobichat.routes.ts:357-400`, `mobichat.service.ts:397-429` | HKDF(master key, `balesin/mobichat-media/v1`) → HMAC-SHA256 atas `nomor.exp.kid`; `timingSafeEqual` dengan cek panjang; `exp` safe-integer, > sekarang, ≤ sekarang + 1 jam + 60 dtk; `kid` UUID; nomor `^[1-9]\d{0,14}$`. Key dicabut/kedaluwarsa/tanpa `messages:read` → mati. Media dicari di organisasi KEY → tanda tangan sah untuk key organisasi lain tidak membuka media (tes baru). 11 bentuk tidak sah → 404 dengan body IDENTIK (tes baru). Header: `nosniff`, CSP `default-src 'none'; sandbox`, `attachment` kecuali tipe inline aman, `private, no-store`, `no-referrer`. `sig` tidak muncul di log (tes baru) |
| `fetchRemoteFile` (`media_url`) | `packages/core/src/net/outgoing-webhook.ts:456-640` | Setiap lompatan diperiksa ulang `parseWebhookUrl` + DNS + semua alamat (redirect ke http publik/terlarang ditolak); maks 3 redirect; tenggat total 15 dtk (DNS ikut, `withDeadline`); `content-length` & aliran dibatasi `maxBytes`; soket ke IP terperiksa; tanpa kredensial ke tujuan; jenis dari ISI berkas di jalur unggah biasa (tes lama) |
| Adaptor = service yang sama | `mobichat.service.ts` → `outbound.sendAsApiKey`, `assignment.*AsApiKey`, `panel`, `contacts` | Jendela 24 jam (409), rem darurat (423), batas per percakapan/organisasi 600/menit (`publicOrganizationRate`), batas harian per key, idempotensi `<key>#<urutan>` (tes lama) |
| Webhook format MobiChat — pengelolaan | `outgoing-webhooks.service.ts:301-490` | `apiKey` harus key SAH & aktif organisasi ini; terenkripsi (`webhook_endpoints.mobichat_api_key`); ganti key/alamat balik = konfirmasi identitas; jawaban hanya `apiKeyLast4` + status; audit tanpa key |
| Webhook format MobiChat — kirim | `apps/worker/src/queues/webhooks-out.ts:354-395,569-576` | Key didekripsi & disisipkan SAAT KIRIM, tidak masuk `payload` riwayat. Key dicabut/kedaluwarsa → `mobichat_key_inactive`, tidak dikirim |
| Pengecualian pola terlarang | `forbidden-pattern.test.ts` | `api-key-actor.ts` (cek ulang key di transaksi akhir), wajar |

---

## B. Temuan

### S1 (Sedang) — Key MobiChat bisa tersimpan & tampil lewat potongan jawaban penerima

- Bukti:
  - `apps/worker/src/queues/webhooks-out.ts:577-600`: body berisi `mobichat_api_key` dikirim, lalu 500 byte
    pertama jawaban penerima disimpan apa adanya ke `webhook_deliveries.response_snippet`.
  - Jawaban itu dikembalikan oleh `GET /settings/webhooks/:id/deliveries` ke browser.
- Bila penerima memantulkan body (n8n "Respond to Webhook" dengan item pertama, proxy debug,
  `httpbin`/request-bin), key utuh tersimpan polos di DB ≤ 7 hari dan dikirim ke browser Owner/Admin.
  - Event tes MobiChat kecil, jadi key pasti masuk 500 byte pertama.
  - Ini melanggar dua aturan:
    - "API key tidak pernah dikirim ke browser" (CLAUDE.md);
    - "key hanya disimpan sebagai hash/terenkripsi": salinan DB yang bocor saja menjadi key kirim pesan
      yang sah.
- Workflow ULAN asli memakai mode jawaban bawaan (`onReceived` → `{"message":"Workflow was started"}`),
  jadi tidak memantulkan. Karena itu levelnya Sedang, bukan Tinggi.
- Perbaikan:
  - sebelum menyimpan potongan, ganti setiap kemunculan key yang disisipkan (dan pola umum
    `blsn_live_…`, lewat `redact` yang sudah ada) dengan `[DISENSOR]`;
  - pertimbangkan juga menyensor `whsec_…`;
  - tambahkan tes regresi.
- Tes: `it.fails` "R1: key yang disisipkan tidak tersimpan di potongan jawaban…" (berkas penjaga di bawah)
  gagal di asersi DB. Diverifikasi juga bahwa key ikut di jawaban API riwayat.

---

## C. Info

1. **Nomor global.** `number` percakapan/pesan adalah identity global (bukan per organisasi), jadi selisih
   nomor membocorkan volume instalasi. Enumerasi lintas organisasi tertutup (tes). Instalasi self-hosted
   biasanya satu organisasi; cukup dicatat.
2. **Nilai penyalahgunaan `conversations:write`.** Key bocor dengan scope ini bisa:
   - menyelesaikan percakapan mana pun di organisasi;
   - menugaskan percakapan ke agen mana pun;
   - melepas agen bila tahu UUID-nya. UUID itu terbuka lewat `GET conversation-status` (`assignments.user.id`)
     bagi pemegang `conversations:read`.

   Semua dicatat `conversation_events.api_key_id` dan bisa dibatasi IP/batas. Saran ke depan: batasi
   `resolved`/unassign ke percakapan berstatus `bot` atau yang terakhir disentuh key itu, atau pisahkan
   scope `conversations:assign`.
3. **Catatan bot** tampil ke agen sebagai teks dengan pelaku "Bot · <nama key>". Penyerang dengan key bocor
   bisa menulis catatan menyesatkan (mis. nomor rekening). Teks aman (tanpa HTML); pertimbangkan label
   pelaku yang mencolok.
4. **URL media di query string** bisa tercatat di log proxy dan diteruskan n8n ke penyedia AI (≤ 1 jam).
   Diterima di kontrak; devops perlu mematikan log query untuk `/api/public/media/`.
5. **Webhook MobiChat ke `http://` IP privat** (allowlist) mengirim key tanpa TLS di LAN. Diterima (n8n
   LAN); sarankan https bila memungkinkan, di teks UI.
6. **Pohon kerja**: perubahan worker yang belum di-commit (`maintenance.ts`, jadwal ke-3) membuat
   `maintenance.integration.test.ts` gagal (`expected 3 to be 2`). Bukan dari commit ini.

---

## D. Tes penjaga

Berkas baru: `apps/api/src/modules/compat-mobichat/security-review-fase3-kompat-mobichat.integration.test.ts`
— 5 `it` + 1 `it.fails`:

- key organisasi lain: 404 di semua rute bernomor, percakapan/pesan tidak berubah;
- assign ke agen organisasi lain / bukan UUID → 400;
- unassign `agent_id` bukan pemegang tidak melepas;
- tanda tangan sah dengan `kid` organisasi lain → 404;
- 11 bentuk URL media tidak sah → 404 body identik, `sig` tidak di log;
- `it.fails`: S1.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run …/security-review-fase3-kompat-mobichat.integration.test.ts` | 5 lulus + 1 `it.fails` |
| Salinan `it.fails` → `it` (sementara, sudah dihapus) | gagal di asersi S1 (key ada di `response_snippet` DB; varian kedua: key ada di jawaban `GET …/deliveries`) |
| `apps/api`: `vitest run src/modules/compat-mobichat src/modules/outgoing-webhooks src/modules/public-api src/rbac-matrix… forbidden-pattern src/modules/inbox` | 112 lulus + 1 `it.fails`, 15 berkas |
| `packages/core`: `vitest run src/net redact logger` | 94 lulus |
| `apps/worker`: `vitest run src/queues` | 86 lulus, 1 gagal (Info 6, pohon kerja) |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |
