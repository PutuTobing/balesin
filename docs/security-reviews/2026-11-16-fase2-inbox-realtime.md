# Review Keamanan — Fase 2 butir 5: inbox real-time (backend)

- Tanggal: 2026-11-16
- Peninjau: agent `security`
- Cakupan: commit `72b4fd2` `feat(inbox): WebSocket real-time, hitungan per tab, saringan jendela 24 jam, tandai dibaca`.
  Berkas yang diperiksa:
  - real-time: `apps/api/src/modules/realtime/{inbox-stream,inbox-stream.routes}.ts`, `packages/core/src/inbox-events.ts`;
  - auth/CSRF: `apps/api/src/modules/auth/{auth.hook,csrf-rejection,session.service}.ts`;
  - inbox: `apps/api/src/modules/inbox/{inbox.repo,inbox.routes}.ts`;
  - reset password (R5): `apps/api/src/modules/password-reset/{reset-burst,password-reset.service}.ts`;
  - worker: `apps/worker/src/{inbound/handlers,queues/webhooks}.ts`;
  - perakitan: `apps/api/src/app.ts`.
- Acuan: `docs/KONTRAK-API-INBOX.md` (Real-time, Saringan), `docs/DECISIONS.md` (6 baris 2026-11-16 butir 5),
  `docs/SECURITY.md` §1, §2, §8, review akhir Fase 1 (F.5 CSWSH, R1 audit CSRF, R5, F.11/G.6).
- Model ancaman:
  - (a) situs lain yang dibuka korban yang sedang masuk (CSWSH/CSRF), termasuk **subdomain saudara** (same-site,
    sehingga cookie `SameSite=Lax` tetap terkirim);
  - (b) akun CS/Teknisi curian yang ingin melihat event, hitungan, atau percakapan di luar cakupan;
  - (c) pengguna yang sesinya dicabut/dinonaktifkan tetapi socket-nya masih terbuka;
  - (d) pihak yang bisa menulis ke Redis;
  - (e) banjir koneksi/event.
- Lingkungan uji: Postgres/Redis dev (database sementara + awalan Redis acak per berkas). Stack E2E (3100/5180) tidak
  dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Penolakan sebelum upgrade.** Hook auth (cookie, tanpa token di URL) → 401/403. `Origin` wajib sama persis dengan
  origin aplikasi, sehingga pembajakan WebSocket dari subdomain saudara pun ditolak (SameSite tidak melindungi kasus
  itu). Batas koneksi → 429.
- **Payload hanya ID.** Pesan Redis divalidasi `strictObject`. Keadaan dibaca ulang dari DB per organisasi lalu
  disaring per socket dengan cakupan `inbox.view` peran **terkini**. Isi pesan, nama, dan nomor tidak pernah lewat
  socket.
- **Validasi ulang 30 detik** memakai `sessions.peek`, yang memeriksa revoke, idle, absolut, akun nonaktif, dan jenis
  sesi vs 2FA, tanpa memperpanjang idle.
- **Hitungan, saringan, dan tandai dibaca** semuanya lewat `conversationFilterCondition(grant, …)` (organisasi +
  cakupan). `POST …/read` lewat hook CSRF.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Navigasi biasa (tautan/bookmark, tanpa `Origin`) ke `/api/v1/inbox/stream` dicatat `auth.csrf.rejected` atas nama korban. Penyerang cukup memasang tautan untuk mengotori audit setiap pengguna (1×/menit) dan menutupi percobaan sungguhan | Sekarang (kecil) |
| R2 | Rendah | Setiap event bus memicu 1–2 query DB **per proses api** (tanpa penggabungan); validasi ulang berjalan berurutan untuk semua socket. Broadcast besar (ribuan status/menit) atau Redis yang bisa ditulis pihak lain → beban DB berlipat | Sebelum broadcast (Fase 4) |
| Info 1–8 | Info | Lihat bagian C | — |

Tes baru di `apps/api/src/modules/realtime/security-review-fase2-inbox-realtime.integration.test.ts`: 4 penjaga
(`it`) dan 1 `it.fails` (R1). `it.fails` sudah dijalankan sebagai `it` dan gagal tepat di asersinya
(`expected [ { …(10) } ] to deeply equal []`, yaitu satu entri audit atas nama Owner).

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Sesi cookie, tanpa token URL | ✅ | Rute `config.access = requirePermission('inbox.view')` → hook auth root (cookie). Kontrak & kode tidak menerima token di query. Tes: tanpa sesi 401, sesi dicabut 401 |
| `Origin` wajib (CSWSH, F.5) | ✅ | `inbox-stream.routes.ts:37-53`: `origin !== appOrigin` (termasuk tanpa `Origin`) → 403 + audit, di `preValidation` sebelum handler upgrade. Cookie `SameSite=Lax` tidak terkirim lintas situs, tetapi **terkirim dari subdomain saudara** (same-site). Karena itu pemeriksaan Origin yang eksak inilah pertahanan utamanya, dan sudah benar |
| Batas socket | ✅ | `canConnect` sebelum upgrade + dicek ulang di `register` (tutup 4429) → tidak ada balapan yang melewati batas. Per pengguna per proses (Info 3) |
| `maxPayload` | ✅ | `@fastify/websocket` `{ maxPayload: 1024 }`. Pesan klien diabaikan. Tes penjaga: 2 KiB → 1009 |
| Heartbeat | ✅ | Ping 30 dtk, tanpa pong → 4408 + `terminate`. Klien lambat (`bufferedAmount` > 1 MiB) diputus |
| Validasi ulang 30 dtk tanpa memperpanjang idle | ✅ | `sessions.peek` → `findActiveSession` (`revoked_at`, `idle_expires_at`, `absolute_expires_at`, `users.disabled_at`, 2FA terverifikasi) tanpa `touch`. Jenis sesi ≠ keadaan 2FA → `undefined` → 4401. Peran tanpa `inbox.view` → 4403. Peran berubah → cakupan baru. Tes penjaga baru: sesi melewati idle → 4401 |
| Penutupan 4401/4403 | ✅ | Kode `INBOX_STREAM_CLOSE_CODES`; tes cabut/nonaktif/naik peran wajib 2FA |
| Pub/sub hanya ID, disaring per socket | ✅ | `inboxBusEventSchema` `strictObject` (`v`, `type`, `organizationId`, `conversationId`, `messageId?`), maks. 2.000 byte. `payloadFor` membaca ulang dengan filter organisasi + percakapan (+ pesan di percakapan itu). `deliver` hanya ke `byOrganization` + `isWithinScope(permissionScope(role,'inbox.view'), userId, holders=[assignee])` |
| Pesan Redis tidak bertanda tangan | ✅ (Info 1) | Event palsu hanya bisa memicu pembacaan ulang data yang memang boleh dilihat penerimanya. Tidak ada isi yang berasal dari pesan Redis yang diteruskan ke browser |
| `GET /conversations/counts` + saringan | ✅ | Satu query `count(*) filter` dengan `conversationFilterCondition(grant, …)` (organisasi + cakupan + saringan). `assignee=<uuid>` hanya mempersempit di dalam cakupan. Tes penjaga: Teknisi `assignee=<Owner>` / `unassigned` → 0; daftar Teknisi hanya miliknya. Batas laju sama dengan daftar; `q` → ember cari + `statement_timeout` |
| `POST /conversations/:id/read` | ✅ | Hook CSRF (Origin + token, diaudit). `markConversationRead` dengan `conversationScope`. Di luar cakupan → 404 dan penghitung tetap (tes penjaga). Event hanya bila berubah |
| Audit `auth.csrf.rejected` + `peek` untuk POST Origin asing | ✅ (R1) | 1×/menit per pengguna (`claimFlag`), metadata tanpa token/cookie/body, host asal saja. `peek` = satu query per hash token, setara biaya hook auth biasa (tidak menambah daya DoS). Korban lintas situs tidak mengirim cookie Lax pada POST, jadi audit hanya muncul untuk sumber same-site atau pemegang cookie, dan itulah sinyal yang dicari |
| Reset setelah `email_sender_changed` (R5) | ✅ (Info 7) | `emailSenderChangedRecently` (72 jam, `ownersNotified = true`) → `afterEmailSenderChange` → `password_reset_without_two_factor` (`warning`). Tes `reset-after-sender-change` |
| Tanpa RLS (F.11) | ✅ | Diterima untuk model satu instalasi per perusahaan. Isolasi = `grant` di repo + FK komposit + tes isolasi. Peninjauan ulang sudah dicatat bila SaaS multi-tenant dibangun |
| Dependensi baru | ✅ | `@fastify/websocket` 11.3.7 → `ws` 8.23.0 (sudah melewati perbaikan DoS header CVE-2024-37890 di 8.17.1), `duplexify` 4.1.3. `pnpm audit`: tetap 2 moderate dev-only (`esbuild`, `minimatch`), tidak ada yang baru |

---

## B. Temuan

### R1 — Rendah — Navigasi biasa ke alamat stream tercatat sebagai "CSRF ditolak"

**Bukti.** `guard` dipasang sebagai `preValidation` rute `websocket: true`, sehingga ikut berjalan untuk GET biasa
(bukan upgrade). Navigasi tingkat atas (klik tautan dari situs lain, bookmark, mengetik URL) mengirim cookie
`SameSite=Lax` tetapi **tanpa** `Origin`, jadi `origin !== appOrigin` → `csrfRejections.record(...)`. Tes `it.fails` R1
(GET dengan cookie Owner, tanpa `Origin`, `Sec-Fetch-Mode: navigate`) menghasilkan 1 entri `auth.csrf.rejected` atas
nama Owner. Tes lama "permintaan HTTP biasa → 404" lulus hanya karena helper `call` selalu mengirim `Origin` aplikasi.

**Dampak.** Situs mana pun bisa membuat setiap pengguna yang mengklik tautannya tercatat "CSRF ditolak" (1×/menit).
Audit log jadi penuh positif palsu, sehingga entri sungguhan (WebSocket dari subdomain saudara, CSRF dengan cookie
curian) tenggelam. Selain itu, karena penanda 1×/menit per pengguna sudah terpakai, upaya pembajakan sungguhan dalam
menit yang sama **tidak tercatat**. Tidak ada data yang bocor.

**Perbaikan.**
- Jalankan pemeriksaan Origin + audit hanya untuk permintaan upgrade (`request.headers.upgrade?.toLowerCase() ===
  'websocket'`, atau pindahkan ke `preHandler` khusus jalur WS).
- GET biasa langsung dijawab 404 tanpa audit.
- Opsional: jangan audit bila `Sec-Fetch-Mode: navigate` (navigasi tingkat atas memang tidak membawa `Origin`).
- Ubah `it.fails` R1 menjadi `it`.

### R2 — Rendah — Biaya per event & validasi ulang tidak dibatasi

**Bukti.**
- `deliver` → `payloadFor` menjalankan 1 query (`conversation.updated`) atau 2 query (`message.*`) untuk SETIAP event
  di SETIAP proses api yang punya socket di organisasi itu (`inbox-stream.ts:188-265, 291-305`), tanpa penggabungan
  atau antrean.
- `revalidate` menjalankan `peek` berurutan untuk semua socket setiap 30 detik (`inbox-stream.ts:307-330`). Bila satu
  putaran lebih lama dari 30 detik, putaran berikutnya tumpang tindih (tanpa penjaga "sedang berjalan").

**Dampak.**
- Broadcast 10.000 pesan menghasilkan ±30.000 event status (sent/delivered/read), jadi ±60.000 query per proses api
  dalam beberapa menit. Ditambah banjir event yang bisa diterbitkan siapa pun yang bisa menulis ke Redis.
- DB dan event loop api melambat untuk semua pengguna.
- Bukan kebocoran data. Saat ini volume event masih kecil (belum ada broadcast/pesan keluar).

**Perbaikan** (sebelum broadcast, Fase 4):
1. Gabungkan event per percakapan dalam jendela pendek (mis. 250 ms) lalu baca satu query `IN (…)` per batch.
2. `message.status` cukup dikirim untuk pesan yang sedang dilihat, atau digabung ke `conversation.updated`.
3. Batasi laju per organisasi di hub (buang event berlebih dan kirim satu sinyal `resync` agar klien memuat ulang
   lewat REST).
4. Lindungi `revalidate` dari tumpang tindih (flag "sedang berjalan") dan jalankan `peek` paralel terbatas, atau
   satu query untuk semua hash token sekaligus.

---

## C. Info

1. **Redis tanpa tanda tangan.** Penulis Redis bisa menerbitkan event palsu, tetapi hasilnya hanya pembacaan ulang data
   dalam cakupan penerima. Kerahasiaan aman. Redis tetap harus privat dengan password (SECURITY §9). Volume
   ditangani R2.
2. **Pencabutan sesi ≤ 30 detik tidak seketika** (diakui backend). Selama jendela itu socket hanya menerima ID +
   status/penghitung, dan detail tetap lewat REST yang langsung ditolak. Bisa diterima. Bila ingin seketika, terbitkan
   event bus `session.revoked` (ID sesi) saat logout/cabut/nonaktif dan tutup socket yang cocok.
3. **Batas 10 socket per pengguna per proses.** Dengan N proses api, totalnya 10×N. Memori per socket kecil, dan hanya
   pengguna terautentikasi yang bisa membuka socket. Bisa diterima. Bila perlu batas global, hitung di Redis (`INCR`
   dengan TTL dan heartbeat).
4. **Teknisi yang dialihkan** tetap melihat detail lama di layar sampai klien memuat ulang. REST berikutnya menolak
   (404). Saran untuk web: saat menerima `conversation.updated` dengan `assigneeUserId` ≠ dirinya (sebagai Teknisi),
   atau saat REST detail menjawab 404, tutup panel detail dan buang cache percakapan itu.
5. **`conversation.updated` menyertakan `assigneeUserId`** (UUID pengguna lain). Itu ID internal yang memang terlihat
   lewat REST bagi peran yang sama. Bukan masalah.
6. **Event setelah commit, "paling banyak sekali".** Klien wajib memuat ulang saat tersambung lagi (sudah di kontrak).
   Kegagalan Redis tidak menggagalkan transaksi worker. Tepat.
7. **R5 hanya menandai perubahan email pengirim oleh selain Owner** (`ownersNotified = true`). Perubahan oleh Owner
   (yang kini wajib konfirmasi password + 2FA) tidak memicu penanda. Bisa diterima, karena pembajak Owner sudah punya
   kendali penuh.
8. **Proxy produksi (Fase 7).** Teruskan ke devops: nginx harus meneruskan header `Origin` apa adanya (bawaan). Jangan
   memasang `proxy_set_header Origin …` yang menimpa nilainya, karena itu akan meloloskan semua origin.
   `proxy_read_timeout` > 30 dtk.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/realtime/security-review-fase2-inbox-realtime` | 4 lulus + 1 `it.fails` (R1) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi audit (1 entri atas nama Owner) |
| `apps/api`: `vitest run src/modules/realtime src/modules/inbox src/modules/password-reset src/rbac-matrix src/modules/auth` | 180 lulus + 1 `it.fails`, 12 berkas |
| `apps/worker`: `vitest run src/inbound` · `packages/core`: `vitest run src/inbox-events` | 30/30 · 3/3 lulus |
| ESLint + Prettier + `tsc --noEmit` (apps/api) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild` via drizzle-kit, `minimatch` via eslint), tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan commit `320ae51`

### Putusan putaran 2: AMAN

R1 **tertutup**. R2 tertutup sebagian (penjaga tumpang tindih `revalidate`). Sisa R2 (gabung event, `message.status`
selektif, batas laju per organisasi + `resync`, validasi ulang satu query) dicatat sebagai **syarat broadcast Fase 4**
di DECISIONS 2026-11-16. Penundaan ini bisa diterima karena saat ini belum ada pesan keluar/broadcast bervolume.
Info 2 (pencabutan seketika) dan Info 8 (nginx tidak menimpa `Origin`) sudah ditindaklanjuti.

Tes R1 di `security-review-fase2-inbox-realtime.integration.test.ts` kini `it` dan lulus. Diff hanya menghapus `.fails`.
Asersinya tetap `expect(await csrfAudits()).toEqual([])` dan status 403/404. Komentar "saat ini 1 entri…" masih
tertinggal di baris itu (kosmetik, boleh dihapus kapan saja).

Tidak ada temuan baru di atas Info.

| # | Status | Bukti |
|---|---|---|
| R1 | ✅ | `inbox-stream.routes.ts`: `guard` keluar lebih awal bila `Upgrade` ≠ `websocket` (huruf kecil), sehingga GET biasa → 404 tanpa audit. Tidak ada celah lewat header `Upgrade` aneh: `@fastify/websocket` menyerahkan upgrade ke `ws.handleUpgrade`, yang menolak semua nilai selain `websocket` (`websocket-server.js:260` "Invalid Upgrade header" → 400). Aturan guard sama persis dengan aturan `ws`. Tes lama "tanpa upgrade → 404 tanpa audit, Origin apa pun" juga lulus |
| R2 (sebagian) | ✅ | `revalidate` memakai satu `Promise` bersama (`revalidating`), sehingga putaran berbarengan digabung (tes "revalidate berbarengan memakai satu putaran") |
| Info 2 | ✅ | `sessions.revoke`/`revokeAllForUser` dibungkus di `app.ts` → `session.revoked` (organisasi + pengguna, `strictObject`, tanpa token/ID sesi) di channel event inbox. Hub memeriksa ulang socket yang cocok 250 ms & 2 dtk kemudian lewat `peek`. Sinyal palsu hanya memicu pemeriksaan ulang dan tidak menutup sesi sah (tes "sinyal session.revoked palsu…"). Pemeriksaan 30 dtk tetap jaring pengaman |
| Info 8 | ✅ | DECISIONS 2026-11-16 (devops Fase 7): upgrade WS diteruskan dan `Origin` tidak pernah ditimpa |

### Catatan putaran 2 (Info)

1. **`revoke` tanpa `userId`.** `revoke(executor, organizationId, sessionRef)` menerbitkan sinyal hanya dengan
   organisasi. Akibatnya SEMUA socket organisasi diperiksa ulang dua kali (2 × `peek` per socket) setiap kali
   seseorang logout atau mencabut satu sesi. Dengan ratusan socket, ini beban kecil tetapi tidak perlu. Saran: sertakan
   `userId` (ambil dari baris sesi yang dicabut, `returning`) supaya hanya socket pengguna itu yang diperiksa.
2. **Sinyal bersifat usaha terbaik.**
   - `checkClients` dari sinyal tidak memakai penjaga tumpang tindih.
   - `pendingTimers` bertambah dua per sinyal (dibersihkan setelah berjalan).
   - Sinyal tidak melonjak dari jalur tanpa sesi (hanya revoke yang sah), jadi tidak ada vektor DoS dari luar.
   - Penulis Redis bisa membanjiri sinyal, dan itu masuk ke batas laju per organisasi pada syarat Fase 4 (R2.3).
3. **Sinyal diterbitkan dari dalam transaksi.**
   - Pemeriksaan 250 ms bisa berjalan sebelum commit, sehingga belum melihat pencabutan.
   - Pemeriksaan 2 dtk menutup celah untuk transaksi singkat. Transaksi yang lebih lama dari 2 dtk kembali ke
     jaring 30 dtk.
   - Bisa diterima. Alternatif lebih rapi: terbitkan setelah commit (pola `emit` + `publish` seperti worker).

### Tes putaran 2

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/realtime src/modules/auth src/modules/inbox src/modules/sessions src/modules/team` | 195/195 lulus, 12 berkas (termasuk R1 yang kini `it`, sinyal palsu, revalidate berbarengan) |
| `packages/core`: `vitest run src/inbox-events` | 4/4 lulus |
| Pemeriksaan sumber `ws@8.23.0` (`handleUpgrade`) & `@fastify/websocket@11.3.7` | nilai `Upgrade` selain `websocket` ditolak sebelum handler |

Tidak ada kode produk yang diubah dan tidak ada commit. Stack E2E tidak dipakai.
