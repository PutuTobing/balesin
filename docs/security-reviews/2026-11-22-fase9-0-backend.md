# Review keamanan — Fase 9 tahap 9.0 (backend): Cc/Bcc channel Email & akses per channel

- Sumber: working tree `dev` (belum di-commit). Pekerjaan 9.1 (`api-keys`, `email-*`, migrasi 0035,
  `qris`, `outbound-html`, `dsn`, `attachment-type`) **tidak** dinilai.
- Spesifikasi/kontrak: `docs/PRD-EMAIL.md` §4.10 & §5; `docs/KONTRAK-API-INBOX.md` (tahap 9.0);
  `docs/KONTRAK-API-CHANNEL-LAIN.md` (`aliases`); `docs/KONTRAK-API-CHANNEL.md` ("Akses per channel");
  `docs/DECISIONS.md` 2026-11-22.
- Peninjau: subagent `security`
- Model ancaman: (1) akun CS yang dibobol ingin memakai alamat email perusahaan untuk spam/penipuan;
  (2) pengirim email luar yang memalsukan header (`From`, `Cc`, `Delivered-To`, `X-Original-To`);
  (3) Supervisor/CS/Teknisi tanpa akses yang ingin membaca percakapan channel terbatas (IDOR, WS,
  push, laporan, ekspor).

## Putusan: **AMAN** (tidak ada Kritis/Tinggi)

1 Sedang (S1, dikunci 2 tes `it.fails`), 8 Rendah, beberapa Info. S1 **disarankan diperbaiki sebelum
Channel Email dipakai dengan volume tinggi**: celah ini melipatgandakan rem kirim sampai 11×.

Tes: `apps/api/src/modules/messages/security-review-fase9-0.integration.test.ts` (1 regresi + 2
`it.fails`, sudah dicek gagal karena alasan yang benar: 202, bukan 429/403). Tes milik pembangun
(`email-copies.integration.test.ts`, `channel-access/*.integration.test.ts`) lulus 30/30.
`tsc --noEmit` (apps/api) dan eslint berkas tes baru bersih. `pnpm audit`: 2 moderate lama khusus dev
(esbuild lewat drizzle-kit, minimatch lewat eslint) — tidak ada dependensi baru tahap 9.0.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Injeksi header Cc/Bcc | `packages/shared/src/outbound.ts` (`emailCopyList` → `emailAddressSchema` = `z.email()`), `apps/api/src/modules/messages/email-copies.ts:46-71` | CR/LF, koma, `<>`, spasi ditolak Zod sebelum service; kirim ulang memakai alamat yang dulu lolos Zod; worker hanya membaca `extras.email.cc/bcc` dari DB (`apps/worker/src/queues/channel-send.ts:415-441`). Tidak ada jalur lain yang menulis `cc/bcc` pesan keluar |
| Bcc tidak di header MIME | `packages/core/src/mail/smtp.ts:378-383` | `bcc` diteruskan ke nodemailer tanpa `keepBcc` → hanya `RCPT TO`; tidak ada jalur IMAP APPEND/penyusun MIME lain (grep `keepBcc`/`append`) |
| Bcc di DTO/webhook | `apps/api/src/modules/inbox/inbox-view.ts:255-266`, `apps/worker/src/queues/webhooks-out.ts:236-249`, `contacts.service.ts` ekspor | DTO: Bcc hanya pesan keluar (terlihat tim sesuai kontrak); webhook native & MobiChat hanya `subject`/verifikasi; ekspor UU PDP tidak memuat `extras` |
| Aturan alamat lama vs baru | `email-copies.ts:83-110`, `outbound.service.ts:909-926` | "Sudah di utas" = pelanggan + To/Cc email masuk + To/Cc keluar `sent/delivered/read` di percakapan ITU; Bcc & pesan gagal tidak dihitung; alamat baru → `inbox.initiate` (`forbidByRule` + audit) / scope `messages:initiate`; maks. 10; alamat channel/alias → 400; pelanggan dibuang |
| Kirim ulang | `outbound.service.ts:1476-1541` | alamat diperiksa ulang terhadap utas SAAT INI dengan izin penekan "Kirim ulang"; jatah dipotong setelah klaim `UPDATE … returning` |
| Header amplop palsu | `packages/core/src/channels/email-message.ts:484-512` | `Delivered-To`/`X-Original-To` hanya dipakai bila COCOK alamat/alias channel; tidak pernah memasukkan alamat asing ke `recipient` |
| Batas alamat per header | `email-message.ts:465-481`, `packages/core/src/channels/inbound.ts:91-98` | maks. 50 per header (grup diurai), amplop maks. 10, payload antrean divalidasi ulang (regex tanpa spasi/kontrol, ≤ 254) |
| Audit tersamar | `email-copies.ts:113-126`, `outbound.service.ts:1147-1161` | `maskEmail`, dalam transaksi pesan (kirim biasa) |
| Penolakan sebagian SMTP | `smtp.ts:413-427` | hanya tembusan ditolak → `sent` + `rejectedCopies` (tidak mengulang ke penerima lain) |
| `channelAccessSql` | `packages/db/src/access.ts:119-128` | parameter terikat, alias tabel `acl_*` (aman disisipkan), peran & keanggotaan dibaca segar; Owner/Admin kebal |
| Satu sumber penegakan | `permission-grant.ts:148-152`, `inbox.repo.ts:102-110` | `conversationScope` membawa `channel`; dipakai daftar/hitungan/cari/detail/pesan/tandai-dibaca (`inbox.repo.ts:310,412,435`), media & HTML email & kirim ulang (`outbound.service.ts:462-482`), catatan/bintang (`panel.service.ts:134-145`), aksi penugasan & log (`assignment.service.ts:260,801`), balasan cepat, pindah departemen, tautan tiket (`tickets.service.ts:230`) |
| Grep jalur tanpa cakupan | semua `from(conversations)`/`from(messages)` di `apps/api/src` | sisa jalur tanpa `conversationScope`: API key/MobiChat (sengaja), hapus kontak (Owner/Admin), gabung kontak (CRM lintas channel, sengaja), penerbit event (disaring hub), hitungan beban agen. Tidak ada IDOR baru |
| WS / push / worker | `realtime/inbox-stream.ts:321-327,465-472`, `worker/queues/notifications.ts:217-234`, `worker/queues/messages.ts:220-226`, `worker/queues/workspace.ts:145-161` | irisan channel di hub, push, pemeriksaan ulang pengirim saat kirim, round-robin; dibaca segar per batch |
| Laporan & ekspor | `reports.service.ts:170-175,396-405,539` | semua bagian (`c`, `m`, `e`, CSAT, biaya, CSV) diiris `channelAccessSql`; saringan `channelId` terlarang = kosong |
| Broadcast | `broadcasts.routes.ts:122-126`, `broadcasts.service.ts:575-588` | `preHandler` untuk SEMUA rute `:broadcastId` (semua rute ber-ID ada di plugin ini — `api-routes.ts:469-497`); pemilih channel & daftar tersaring |
| Kelola aturan | `channel-access/*` | `channels.manage` (Owner/Admin), CSRF, 30/menit, `assertActorStillAuthorized`, `FOR UPDATE`, departemen/pengguna aktif milik organisasi, FK komposit organisasi + cascade, 404 seragam, audit diff, `access.changed` → resync |
| Penugasan | `assignment.service.ts:446-484,628-643,917-953` | sasaran (sesi & API key) wajib berhak atas channel; buka lagi melepas pemegang tanpa akses; `/inbox/agents?channelId=` 404 untuk channel yang tidak boleh dilihat |
| Biaya query | `access.ts:124-127` | subkueri tidak berkorelasi dengan baris (initPlan/hashed subplan, sekali per query); organisasi tanpa channel terbatas = satu query di `channelAccessOf` |

---

## B. Temuan

### S1 (Sedang) — Daftar izin Cc diisi header email masuk yang dikendalikan pengirim luar; satu balasan = 11 penerima tetapi dihitung 1 pesan

**Bukti**
- `apps/api/src/modules/messages/email-copies.ts:83-102` — `threadEmailAddresses` memasukkan `To`/`Cc`
  SEMUA email masuk (`m.direction = 'inbound'`) tanpa melihat `senderVerification`.
- `apps/worker/src/queues/channel-mailboxes.ts:363-367` — `to`/`cc` disimpan apa adanya dari header
  (maks. 50 per header).
- `apps/api/src/modules/sending-limits/sending-limits.service.ts:115-131` — batas harian per pengguna/
  organisasi/API key & rem darurat menghitung **baris pesan**, bukan penerima.

**Skenario.** Penyerang mengirim satu email (dari domainnya sendiri, atau `From` palsu yang gagal
DMARC) ke kotak surat channel dengan `Cc:` berisi 50 alamat sasaran. Akun CS yang dibobol membalas
dengan Cc 10 alamat itu — lolos hanya dengan `inbox.reply` (tanpa `inbox.initiate`, tanpa jatah
`mulai-percakapan`), lalu mengulang ke 10 alamat berikutnya. Setiap balasan menjangkau 11 alamat
tetapi memakai satu unit batas harian: batas 500/hari menjadi 5.500 email dari domain perusahaan,
dengan isi bebas CS (phishing atas nama perusahaan, reputasi domain/SPF rusak). Rem darurat juga
terlambat 11×. API key `messages:send` mendapat lipatan yang sama terhadap `dailySendLimit`.
Sebelum 9.0 jalur serupa hanya 1:1 dan butuh pemalsuan `From` per korban.

**Tes (`it.fails`)** — `security-review-fase9-0.integration.test.ts`:
- `S1a`: batas harian CS = 3, satu balasan + 10 Cc dari header masuk → diharapkan 429 (sekarang 202).
- `S1b`: email masuk `senderVerification: 'fail'` dengan Cc 10 alamat → CS Cc alamat itu diharapkan
  403 (sekarang 202).

**Perbaikan yang disarankan** (keduanya kecil)
1. Hitung penerima: pesan keluar ber-Cc/Bcc dihitung `1 + cc + bcc` di `countOutbound` (mis. kolom
   `recipient_count` atau `jsonb_array_length` pada `extras.email`) untuk batas per pengguna, per
   organisasi, per API key, dan rem darurat. Periksa sebelum menyimpan dengan bobot pesan baru.
2. Hanya `To`/`Cc` email masuk ber-`senderVerification = 'pass'` yang dihitung "sudah ada di utas";
   `fail`/`unverified` → alamatnya diperlakukan baru (butuh `inbox.initiate`). Opsional: batasi alamat
   warisan header ke email masuk terakhir saja.

### R1 (Rendah) — Jatah `mulai-percakapan` terpotong sebagian dan tidak dikembalikan

`outbound.service.ts:1117-1121` (dan `1523-1525`): unit dipotong satu per satu SEBELUM transaksi
simpan. Bila jatah habis di alamat ke-6 dari 10, 5 unit hilang dan pesan tidak terkirim; bila insert
gagal (mis. `clientMessageId` bentrok bersamaan) unit juga hilang. Dampak: Supervisor+ menghabiskan
jatahnya sendiri (bukan eskalasi). Saran: periksa sisa jatah ≥ N dulu (`peek`) atau `consume` dengan
bobot N sekali secara atomik; potong setelah insert berhasil.

### R2 (Rendah) — Predikat `channelAccessSql` gagal-terbuka untuk ID yang bukan pengguna

`packages/db/src/access.ts:124` — "lolos bila `userId` bukan Supervisor/CS/Teknisi organisasi ini"
juga meloloskan ID pengguna yang terhapus/salah ketik/ID dari organisasi lain, padahal padanannya di
memori (`channelAccessOf`, `access.ts:207-212`) gagal-tertutup. Saat ini semua pemanggil memberi ID
sesi atau sasaran tervalidasi, jadi tidak tereksploitasi; risikonya pada kode berikutnya. Saran:
parameter eksplisit `principal: { kind: 'user' | 'apiKey' }` — API key dilewati di TypeScript, ID
pengguna yang tidak ada = ditolak.

### R3 (Rendah) — `PUT …/access` melonggarkan akses tanpa konfirmasi identitas

`channel-access.service.ts:168-300`; bandingkan `departments.service.ts:424-434` (akses departemen yang
melonggar wajib konfirmasi). Sesi Owner/Admin yang dicuri (cookie) bisa membuka channel terbatas
untuk akun CS lain secara permanen (pintu belakang). Diaudit lengkap, jadi Rendah. Saran: konfirmasi
identitas hanya bila perubahan melonggar (`restricted → all`, menambah pengguna/departemen). Catatan
terkait: menambah anggota departemen (`setAccess`, `loosened` hanya untuk pengguna bertanda
departemen) kini juga bisa memberi akses channel terbatas tanpa konfirmasi dan tanpa audit
`channel.access_updated` — sebutkan di audit `department.access_updated` atau masukkan ke `loosened`.

### R4 (Rendah) — Penugasan lama tidak dilepas saat akses dicabut

Sesuai DECISIONS, tetapi efek sampingnya: percakapan tetap `served` atas nama agen yang tidak bisa
melihatnya (pelanggan tidak dilayani tanpa tanda), dihitung di beban agen (`openConversations`,
kapasitas round-robin), dan kontaknya tetap terlihat Teknisi lewat `contactHeldBy`
(`inbox.repo.ts:81-83`, tanpa irisan channel). Saran: setelah `PUT` yang mencabut, tampilkan jumlah
percakapan terbuka yang pemegangnya kini tanpa akses (atau lepaskan ke antrian) + audit.

### R5 (Rendah) — Kebocoran metadata kecil yang dibiarkan

- `inbox-stream.ts:230-236`: `conversation.removed` (event `conversation.deleted`) dikirim ke semua
  klien cakupan `all` tanpa irisan channel → ID percakapan channel terlarang terlihat.
- `tickets.repo.ts:74-75`: tiket memuat `id`/`number`/`status` percakapan tertaut channel terlarang.
- Template Meta (`templates.routes.ts:93,177`, `inbox.reply`) lintas channel.
Semua tanpa isi pesan/data pelanggan baru. Saran: kirim `conversation.removed` hanya ke pemegang
terakhir + Owner/Admin; tiket menyembunyikan nomor percakapan bila tidak dalam cakupan.

### R6 (Rendah) — Ekspor UU PDP parsial tidak ditandai

`contacts.service.ts:528,550,594`: Supervisor tanpa akses mendapat ekspor tanpa percakapan channel
terlarang, tetapi respons & audit tidak menandai bahwa ekspornya parsial. Risiko kepatuhan: ekspor
diserahkan ke subjek data seolah lengkap. Saran: `partial: true` + jumlah percakapan yang dikecualikan
(tanpa isi) di respons dan audit; UI memberi peringatan "ekspor lengkap = Owner/Admin".

### R7 (Rendah) — Alias tanpa konfirmasi bisa membisukan alamat pelanggan

`connections.service.ts:958-967` + `channel-mailboxes.ts:195`: alias dihitung "alamat sendiri" →
email DARI alias itu dilewati (anti-loop). Owner/Admin (atau sesinya yang dicuri) dapat menjadikan
alamat pelanggan sebagai alias: email pelanggan itu hilang diam-diam dari inbox, Cc ke alamat itu
→ 400. Diaudit `channel.updated`. Saran: tolak alias yang sudah menjadi kontak di channel itu, atau
batasi ke domain alamat utama kecuali dikonfirmasi; catat jumlah email yang dilewati karena alias di
`channel.mailbox.skippedMessages`.

### R8 (Rendah) — Cc ke alamat channel LAIN di organisasi tidak ditolak; utama ditolak + tembusan diterima

- `email-copies.ts:51-63` hanya menolak alamat/alias channel ITU. Cc ke alamat channel Email lain
  milik organisasi membuat percakapan palsu di channel itu (anti-loop `Auto-Submitted` mencegah
  pantulan bot, tetapi tidak percakapannya). Saran: tolak alamat/alias semua channel organisasi.
- `smtp.ts:413-427`: penerima utama ditolak tetapi sebagian tembusan diterima → pesan `failed` dan
  bisa dikirim ulang → tembusan menerima dua kali. Saran: simpan `deliveredCopies` dan kirim ulang
  hanya ke yang belum.

### Info

1. `GET /channels` membuka `emailAddresses` (alamat utama + alias) ke semua peran inbox termasuk
   Teknisi (`channel-view.ts:96-100`). Alamat organisasi, bukan rahasia; alias bisa menyingkap alamat
   internal (mis. `direktur@`). Diterima.
2. API publik (`messages:read`) menerima `email.bcc` pesan keluar lewat DTO yang sama — sesuai "terlihat
   tim"; dokumentasikan di `KONTRAK-API-PUBLIK.md`.
3. Audit kirim ulang ber-Cc ditulis di luar transaksi (`outbound.service.ts:1526`, `recordAudit(db, …)`)
   — kirim biasa sudah di dalam transaksi. Kecil; samakan.
4. DTO pesan KELUAR ber-Cc menampilkan `senderVerification: "unverified"` (terlihat di tes) — kosmetik;
   sebaiknya `null`/tidak ditampilkan untuk pesan keluar seperti webhook.
5. `Delivered-To` palsu yang cocok alias dapat salah memberi label "Alamat tujuan" (hanya saringan).
   Bila 9D memakai `recipient` untuk aturan/routing, jangan percayai header amplop di bawah baris
   `Received` teratas server sendiri.
6. Satu kali run awal tes `email-copies` gagal 500 saat membuat API key (run berikutnya 30/30 lulus) —
   kemungkinan bentrok DB dengan proses tes paralel/pekerjaan 9.1; `qa-tester` sebaiknya memastikan.

---

## C. Ringkasan untuk orkestrator

| ID | Level | Status | Tes |
|---|---|---|---|
| S1 | Sedang | Terbuka — disarankan perbaiki (hitung penerima di batas kirim + hanya header email terverifikasi) | `it.fails` S1a, S1b |
| R1–R8 | Rendah | Terbuka (boleh ditunda, catat di ROADMAP) | — |
| Info 1–6 | Info | — | — |
