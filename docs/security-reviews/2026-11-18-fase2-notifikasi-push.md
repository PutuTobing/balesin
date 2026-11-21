# Review Keamanan — Fase 2 butir 10: notifikasi Web Push (backend)

- Tanggal: 2026-11-18
- Peninjau: agent `security`
- Cakupan: commit `51e5dbc` `feat(notifikasi): Web Push VAPID per organisasi, langganan, preferensi, pengirim worker`.
  Berkas yang diperiksa:
  - kripto: `packages/core/src/push/web-push.ts` (implementasi sendiri, hanya `node:crypto`);
  - api: `apps/api/src/modules/notifications/**`, `apps/api/src/modules/auth/session.repo.ts` (hapus langganan saat
    sesi dicabut), `apps/api/src/queues/notification-queue.ts`;
  - worker: `apps/worker/src/queues/notifications.ts`, `apps/worker/src/queues/webhooks.ts` (antre per pesan);
  - db & shared: `packages/db/src/schema/notifications.ts` + `drizzle/0018_notifikasi_push.sql`,
    `packages/shared/src/notifications.ts`;
  - sekunder: `senderName`, `GET /inbox/sending-status` + `sending.changed`, audit isi quick reply +
    `quick_reply_risky`, `assigned` di alarm aksi massal.
- Acuan: `docs/KONTRAK-API-NOTIFIKASI.md`, DECISIONS 2026-11-17 (9 baris butir 10), RFC 8030/8188/8291/8292,
  `docs/SECURITY.md` §2, §3, §6 (SSRF), §10.
- Model ancaman:
  - browser/klien jahat yang mendaftarkan alamat langganan buatan (SSRF, penimpaan langganan pengguna lain);
  - pengguna yang sesinya dicabut tetapi perangkatnya masih berlangganan;
  - Teknisi yang menerima push di luar cakupannya;
  - layar kunci yang membocorkan isi chat;
  - kesalahan kripto (nonce/salt/kunci efemeral dipakai ulang, titik kurva tidak sah, JWT yang bisa dipalsukan);
  - kebocoran kunci VAPID privat.
- Lingkungan uji: Postgres/Redis dev + server push TIRUAN lokal. Tidak ada panggilan ke layanan push sungguhan.
  Stack E2E tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

**Kripto benar.**
- `aes128gcm` mengikuti RFC 8291/8188:
  - IKM = HKDF(salt = `auth`, ikm = ECDH, info = `"WebPush: info\0" ‖ ua_pub ‖ as_pub`, 32);
  - CEK/NONCE = HKDF(salt acak 16 byte, `"Content-Encoding: aes128gcm\0"`/`"…nonce\0"`, 16/12);
  - satu rekaman `isi ‖ 0x02`, header `salt ‖ rs=4096 ‖ idlen=65 ‖ as_pub`, dicek ≤ rs.
- Kunci ECDH efemeral + salt baru di SETIAP pesan, sehingga pasangan (kunci, nonce) tidak pernah dipakai ulang.
- Titik P-256 divalidasi (65 byte `0x04` + `computeSecret` menolak titik di luar kurva).
- VAPID: JWT ES256 (`ieee-p1363`) dengan `aud` = origin layanan push, `exp` +12 jam (≤ 24 jam), `sub` = origin
  `APP_URL` (https di produksi).
- Tidak ada perbandingan rahasia yang membutuhkan waktu-konstan (server hanya mengenkripsi/menandatangani).
- Vektor RFC 8291 lulus. Penjaga baru mendekripsi keluaran ACAK dengan implementasi penerima independen.

**Anti-SSRF benar.**
- Hanya `https:` port bawaan, tanpa userinfo/fragmen, ≤ 1.024 karakter.
- Host persis `fcm.googleapis.com`/`android.googleapis.com`/`web.push.apple.com` atau sufiks bertitik
  `.push.services.mozilla.com`/`.push.apple.com`/`.notify.windows.com`.
- Diperiksa saat daftar DAN sebelum kirim, `redirect: 'manual'`, batas waktu 10 dtk, isi jawaban tidak dibaca.
- Origin tiruan (`extraOrigins`) hanya lewat `overrides` tes, tidak bisa diaktifkan lewat env/konfigurasi produksi.

**Kunci, langganan, penerima, dan isi:**
- **Kunci VAPID privat** terenkripsi per organisasi (AAD organisasi + tujuan), tidak pernah ke browser/log.
- **Kunci langganan browser** terenkripsi (AAD + `subjectId` pengguna).
- **Langganan terikat SESI:**
  - dihapus saat logout/cabut sesi/ganti peran/nonaktif;
  - diperiksa ulang sebelum kirim (revoke, idle, absolut, jenis, 2FA);
  - 404/410 → dihapus;
  - alamat yang didaftarkan ulang pindah utuh (pengguna, sesi, kunci) ke pendaftar baru;
  - maks. 10 per pengguna.
- **Penerima dihitung ulang di worker** dari database: aktif, cakupan `inbox.view` (Teknisi hanya pemegang), antrian
  hanya `inbox.assign`, preferensi, jam tenang, gabung 30 dtk.
- **Isi bawaan tanpa isi pesan**, URL relatif `/inbox?chat=<uuid>`, nama ≤ 60 karakter. Cuplikan hanya bila Owner
  (`organization.manage`) menyalakannya, dan diaudit.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Mode "tanpa cuplikan" masih menampilkan NAMA pelanggan di layar kunci ("Pesan baru dari Budi Santoso"). Nama profil WhatsApp juga diisi pelanggan sendiri, jadi bisa dipakai menulis teks pendek di layar kunci agen | Sebelum produksi (kecil) |
| R2 | Rendah | Pendeteksi `quick_reply_risky` hanya mengenali TLD tertentu (`.com`, `.id`, `.xyz`, …). Tautan ke TLD lain (mis. `.ru`, `.tk`, `.vip`, `.cn`) atau domain tanpa skema lolos tanpa tanda. Audit isi dipotong 1.000 karakter (template ≤ 3.500) | Kapan saja |
| Info 1–7 | Info | Lihat bagian C | — |

**Tes baru (semua lulus):**
- `packages/core/src/push/security-review-fase2-push.test.ts`, 6 penjaga:
  - keluaran acak bisa didekripsi penerima RFC 8291 independen;
  - salt/kunci efemeral/ciphertext berbeda tiap pesan;
  - auth/kunci lain gagal membuka;
  - titik di luar kurva/terkompresi/tak hingga ditolak;
  - JWT tidak sah untuk kunci publik lain dan `aud` tanpa path;
  - 17 bentuk bypass host ditolak, termasuk `fcm.googleapis.com.evil.test`, `evilfcm.googleapis.com`, userinfo,
    `#@`, `\@`, port, http, IP, titik di ujung, homoglif IDN, sufiks telanjang `push.apple.com`;
  - alamat asli diterima (huruf besar, `:443`).
- `apps/api/src/modules/notifications/security-review-fase2-push.integration.test.ts`, 2 penjaga:
  - alamat yang didaftarkan ulang pindah utuh; pengguna lama tidak bisa melepasnya dan tes push-nya 0 perangkat;
  - Teknisi tidak menerima push antrian/chat agen lain; isi push tanpa isi pesan/nomor, URL relatif; log tanpa isi
    pesan/alamat langganan.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Nonce/IKM/salt | ✅ | `web-push.ts:146-151`: IKM dari HKDF(auth, ECDH, key_info), CEK/NONCE dari HKDF(salt acak, info). Salt `randomBytes(16)`. `salt`/`serverPrivateKey` opsional hanya untuk vektor uji |
| Padding & record size | ✅ | Satu rekaman `isi ‖ 0x02` (delimiter rekaman terakhir, tanpa padding tambahan). `rs = 4096`, ditolak bila `isi + 17 > rs`. Isi dibatasi 3.000 byte (layanan push ±4 KB termasuk header 86 byte) |
| Validasi titik P-256 | ✅ | Panjang 65 + awalan `0x04` + `computeSecret` (OpenSSL menolak titik di luar kurva). Titik tak hingga/terkompresi ditolak (penjaga baru) |
| Kunci efemeral tidak dipakai ulang | ✅ | `createECDH().generateKeys()` per pesan. Penjaga baru membandingkan dua keluaran |
| JWT `aud`/`exp`/`sub` | ✅ | `aud = new URL(endpoint).origin`, `exp = now + 12 jam`, `sub = origin APP_URL`. Header `{typ:'JWT',alg:'ES256'}`, tanda tangan P1363 64 byte. Diverifikasi tes lama + penjaga baru |
| Waktu-konstan | ✅ n/a | Tidak ada perbandingan rahasia di jalur push |
| Allowlist host | ✅ | `checkPushEndpoint`: exact + sufiks bertitik + `host.length > suffix.length`. `URL` menormalkan huruf besar/IDN (punycode) dan port 443. Trailing dot, IP, userinfo, port lain, http ditolak (penjaga baru) |
| Tanpa redirect, batas waktu | ✅ | `redirect: 'manual'` (3xx = `rejected`), `AbortSignal.timeout(10_000)`, `response.body.cancel()` |
| Kunci VAPID privat terenkripsi per organisasi | ✅ | `push_vapid_keys.private_key_encrypted` (`SecretBox`, AAD `organizationId` + `push_vapid_keys.private_key`). Hanya `publicKey` yang dikembalikan. Pembuatan pertama `onConflictDoNothing`. Tanpa master key → 503 |
| Langganan terikat sesi | ✅ | `session_id` FK `ON DELETE CASCADE`. `dropPushSubscriptions` di setiap jalur cabut sesi. Worker memakai `sessionLive` (revoke, idle, absolut, `kind = 'standard'`, 2FA) dan menghapus yang mati |
| Penimpaan endpoint oleh pengguna lain | ✅ | `onConflictDoUpdate(endpoint)` mengganti organisasi, pengguna, sesi, dan kunci (AAD pengguna baru). Penjaga baru. Alamat langganan hanya diketahui browser itu sendiri (Info 2) |
| Maks. 10, hapus 404/410/logout | ✅ | Tes lama + `keep` 10 terbaru. 404/410 dan alamat yang kini ditolak allowlist → dihapus |
| Penerima: cakupan, Teknisi, preferensi, jam tenang, gabung 30 dtk | ✅ | `processNotificationJob`: kandidat → `users` aktif → `permissionScope('inbox.view')` + `isWithinScope(holder)` → `needsAssign` untuk antrian → preferensi → jam tenang (zona organisasi) → `throttle` Redis `SET NX EX 30`. Tes lama + penjaga baru |
| Isi push | ✅ (R1) | Bawaan `body = "Buka untuk membaca pesan."`. Cuplikan ≤ 80 hanya bila `notification_preview`. `url` relatif dari ID percakapan (`encodeURIComponent`). `tag`/`Topic` dari UUID |
| Pengaturan cuplikan | ✅ | `organization.manage` + `assertActorStillAuthorized` + `FOR UPDATE` + audit `settings.notifications.updated` (lama/baru) |
| Antrian dedup per ID pesan | ✅ | `notificationJobId` (pesan = ID pesan), sehingga kiriman ulang Meta tidak menggandakan push. Payload job hanya ID (`strictObject`) |
| Log | ✅ | Hanya jenis, jumlah penerima/terkirim/dihapus, `subscriptionId` + status HTTP. Penjaga baru: isi pesan & alamat langganan tidak di log |

### Sekunder

| Fokus | Status | Bukti |
|---|---|---|
| `senderName` di `Message` | ✅ | Hanya `users.name` (tanpa email), dibaca setelah percakapan lolos cakupan. Tes lama "nama tampilan, tanpa email" |
| `GET /inbox/sending-status` + `sending.changed` | ✅ | `inbox.view`, hanya `{ paused }`. Event tanpa pelaku/alasan |
| Audit isi quick reply + `quick_reply_risky` | ✅ (R2) | `quick_reply.created/updated` kini memuat `previous`/`next` (judul + isi ≤ 1.000) dan `risky` bila selain Owner menambah tautan/angka ≥ 8 digit. Menutup R1 review panel (lihat putaran 2 di laporan panel) |
| `assigned` di alarm aksi massal | ✅ | `BULK_ACTION_KINDS` kini memuat `assigned`. Tes R2 penanganan kini `it` dan lulus. Asersi tidak dilemahkan (`toHaveLength(1)`) |

---

## B. Temuan

### R1 — Rendah — Nama pelanggan tetap tampil di layar kunci

**Bukti.** `audienceOf` (`apps/worker/src/queues/notifications.ts`): `title = "Pesan baru dari ${name}"` /
`body = "Percakapan dengan ${name}"`. `name` = nama tim → nama profil WhatsApp → "pelanggan", tidak bergantung
`preview`.

**Dampak.**
- Privasi: siapa pun yang melihat HP agen yang terkunci tahu siapa yang sedang menghubungi perusahaan. Untuk
  layanan tertentu (kesehatan, keuangan, penagihan) itu informasi sensitif (UU PDP: minimisasi data).
- Rekayasa sosial: nama profil diisi pelanggan sendiri (sudah dibersihkan karakter tak terlihat, ≤ 60). Ia bisa
  menulis teks pendek di layar kunci, misalnya "Pesan baru dari Admin Sky Tech: reset password", walau awalan
  "Pesan baru dari" mengurangi daya tipunya.

**Perbaikan.**
- Pengaturan organisasi "Tampilkan nama pelanggan di notifikasi" (bawaan MATI, atau ikut `preview`). Saat mati, judul
  netral "Pesan baru" / "Chat ditugaskan ke kamu", tanpa nama.
- Bila nama ditampilkan, utamakan nama dari TIM (tepercaya). Untuk nama profil, beri tanda kutip/awalan "WA:" supaya
  jelas itu teks dari pelanggan.

### R2 — Rendah — Deteksi tautan berisiko terbatas; audit isi terpotong

**Bukti.** `quick-replies.service.ts`: `LINK_PATTERN` = `https?://…|www.…|<domain>.(com|net|org|id|co|io|me|link|xyz|ly|
info|biz|site|online|app|cc|top|shop)`. `AUDIT_BODY_MAX = 1_000`.

**Dampak.** Penyerang (Supervisor/Admin curian) yang menanam `bayar-tagihan.vip/sky` atau `skytech-cs.ru` tanpa
`https://` tidak memicu `quick_reply_risky`. Bagian isi setelah 1.000 karakter tidak tercatat di audit, sehingga
penelusuran isi lama tidak lengkap.

**Perbaikan.**
- Pola domain umum: label (huruf/angka/tanda hubung, termasuk punycode) + `.` + TLD huruf ≥ 2 (`\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b`),
  dengan pengecualian kecil (mis. singkatan "a.n.").
- Simpan isi audit utuh (≤ 3.500, teks bisnis, bukan data pelanggan), atau simpan `sha256` isi penuh bila tetap
  dipotong.

---

## C. Info

1. **Service worker (web) belum ada di commit ini.** Saat dibuat: di `notificationclick`, buka hanya
   `new URL(payload.url, self.location.origin)` yang origin-nya sama dan path-nya diawali `/` (tolak `//`,
   `javascript:`, URL absolut), tampilkan `title`/`body` sebagai teks, dan validasi `PushNotificationPayload` dengan
   skema yang sama.
2. **Penimpaan langganan** butuh alamat langganan, yaitu URL rahasia milik browser itu. API tidak pernah mengembalikan
   alamat ini (`devices` hanya jumlah). Penimpaan oleh pengguna lain di browser yang SAMA memang diinginkan.
3. **Pengiriman berurutan** per langganan dengan batas waktu 10 dtk. Organisasi dengan ratusan langganan + layanan
   push lambat → job lama (concurrency 5). Bisa diterima. Pertimbangkan paralel terbatas bila volume naik.
4. **`throttle` dipakai sebelum kirim.** Pesan kedua dalam 30 dtk tidak menghasilkan push sama sekali (bukan
   "digabung" ke push susulan). Fungsional, bukan keamanan.
5. **Hapus langganan via `DELETE`** membandingkan `endpoint` mentah dengan `url.href` tersimpan. Variasi penulisan
   (mis. huruf besar host) membuat pelepasan gagal diam-diam. Normalkan dengan `checkPushEndpoint` sebelum mencari.
6. **Pasangan VAPID tidak diperiksa konsisten.** `signingKey` membangun JWK dari `publicKey` + `d` tersimpan tanpa
   memastikan keduanya cocok. Kerusakan data hanya membuat push ditolak (401/403, dicatat), bukan celah.
7. **`rbac-matrix` di working tree** gagal karena rute backend yang BELUM di-commit (`DELETE /contacts/:id`,
   `GET /contacts/:id/export`, `…/webhook-health`) belum masuk tabel ROUTES. Ini bukan bagian dari `51e5dbc`, dan
   tabel harus diperbarui bersama rute itu.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `packages/core`: `vitest run src/push/security-review-fase2-push` | 6/6 lulus |
| `apps/api`: `vitest run src/modules/notifications/security-review-fase2-push` | 2/2 lulus |
| `apps/api`: `vitest run src/modules/notifications src/modules/inbox src/modules/quick-replies src/modules/sending-limits src/modules/auth src/rbac-matrix` | 180 lulus, 9 gagal, semuanya `rbac-matrix` karena rute backend yang belum di-commit di working tree (Info 7) |
| `apps/worker`: `vitest run` | 123/123 lulus |
| `packages/core`: `vitest run` | 529/529 lulus |
| ESLint + `tsc --noEmit` (api, core) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild`, `minimatch`), tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan commit `c90555f`

### Putusan putaran 2: AMAN

R1, R2, dan Info 5 tertutup.

| # | Status | Bukti |
|---|---|---|
| R1 nama di layar kunci | ✅ | Kolom baru `organizations.notification_contact_name` (migrasi 0019, bawaan `false`). Pengaturan `PUT /settings/notifications` `{ preview, contactName }` (`organization.manage`, diaudit lama/baru). Worker: bila mati → judul "Pesan baru di inbox", badan "Buka untuk melihat percakapan." (tanpa nama). Bila hidup → nama TIM apa adanya, nama profil WhatsApp diberi awalan `~` (penanda teks dari pelanggan), ≤ 60 karakter |
| R2 `quick_reply_risky` & audit isi | ✅ (Info 5 laporan hapus/ekspor) | Pola domain umum `…\.[a-z]{2,}` (dengan/ tanpa skema). Isi audit utuh hingga 3.500 (= batas template). `quick_reply.deleted` kini menyimpan `previous` (judul + isi) |
| Info 5 `DELETE` langganan dinormalkan | ✅ | `unsubscribe` menormalkan lewat `checkPushEndpoint(...).href` sebelum mencocokkan |

Tes penjaga putaran 1 (`security-review-fase2-push.test.ts`, `…push.integration.test.ts`) tetap lulus.
