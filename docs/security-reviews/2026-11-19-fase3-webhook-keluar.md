# Review keamanan — Fase 3: Webhook keluar (outbox, SSRF, tanda tangan)

- Commit: `da3f141` (`feat(webhook): webhook keluar bertanda tangan (outbox), SSRF ketat + allowlist IP privat, riwayat & kirim ulang`)
- Kontrak: `docs/KONTRAK-WEBHOOK-KELUAR.md`
- Peninjau: subagent `security`
- Model ancaman:
  - akun CS dibobol yang ingin membelokkan data pelanggan (isi pesan + nomor) ke server penyerang;
  - Admin/Owner yang sesinya dicuri tanpa password;
  - pemilik URL tujuan (atau DNS-nya) yang ingin memakai worker untuk SSRF ke jaringan internal/metadata
    cloud atau mengganggu worker.

## Putusan: **AMAN**

Tidak ada temuan Kritis atau Tinggi. Ada 2 temuan Rendah dan beberapa Info.

- **SSRF tertutup** untuk semua bentuk alamat yang biasa dipakai (heks/desimal/oktal, IPv4-mapped heks,
  rebinding, redirect), dengan DNS sekali dan soket ke IP yang sudah diperiksa.
- **CS tidak bisa menyentuh webhook**: `integrations.manage` hanya Owner/Admin.
- **Sesi Admin curian tanpa password** tidak bisa mengganti URL, merotasi rahasia, atau melebarkan allowlist.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Daftar terlarang | `packages/core/src/net/outgoing-webhook.ts:25-48` | 0/8, 127/8, 169.254/16, 224/4, 240/4, 255.255.255.255, 192.0.0/24, 198.18/15; `::`, `::1`, fe80::/10, ff00::/8, fd00:ec2::254, 64:ff9b::/96, 2001:db8::/32. IPv4-mapped dicek sebagai IPv4, termasuk bentuk HEKS hasil normalisasi WHATWG URL (`[::ffff:127.0.0.1]` → `::ffff:7f00:1`): `BlockList` Node mencocokkan mapped-heks ke aturan IPv4 (dibuktikan tes baru) |
| Bentuk alamat aneh | `parseWebhookUrl` (`:148-173`) + `new URL` | `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`, `0`, `[::]`, `[fe80::1%25eth0]` → terlarang/tidak valid (tes baru) |
| Jaringan privat | `:50-59`, `:82-105`, `:188` | 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 hanya lewat allowlist. CIDR allowlist harus seluruhnya di dalam rentang privat (`0.0.0.0/0`, publik, loopback, metadata → 400; tes baru + lama). Mapped-heks ke 10/8 = privat, bukan publik |
| DNS & soket | `:258-341` | resolve sekali (`all`, `verbatim`); SEMUA alamat diperiksa; `lookup` diganti dan hanya mengembalikan IP terperiksa. Nama yang tidak bisa di-resolve tetap sampai lewat IP terperiksa dengan `Host` nama asli; lookup dipanggil tepat 1× (tes baru) |
| TLS | `:340` | `servername` = nama host (SNI), `rejectUnauthorized` bawaan (true); ke IP literal → sertifikat dicek terhadap IP |
| Skema/port/kredensial | `:159-167,189` | https wajib untuk publik; http hanya ke IP privat terizin; port 80/443/5678/8080/8443; `user:pass@` ditolak; `ftp:`/`file:` ditolak |
| Mode tes loopback | `apps/api/src/app.ts:156,553`, `apps/worker/src/queues/webhooks-out.ts:74,352` | hanya dari `overrides` tes; tidak ada env/konfigurasi produksi yang menyalakannya |
| Redirect, batas waktu, potongan | `:343-386` | 3xx tidak diikuti. Batas waktu total mencakup jawaban yang menetes (tes baru). Potongan ≤ 500 byte, karakter kontrol dibuang; agen `agent: false`; env proxy diabaikan |
| Tanda tangan | `:197-211`, worker `:331-349` | HMAC-SHA256 atas `t.body`; `v1` rahasia lama hanya sampai `previousSecretExpiresAt` (24 jam) |
| Rahasia | service `:134,236,379`, routes `:98,156` | `whsec_` 32 byte acak, terenkripsi `SecretBox` dengan konteks (org, `webhook_endpoints.secret`, id), tampil sekali `no-store`; tidak ada di DB polos, audit, maupun log (tes baru) |
| Audit hanya host | service `:248,316,346,394`, worker `:400-410` | path/query (token penerima) tidak masuk audit maupun log (tes baru dengan token di path & query) |
| Konfirmasi identitas | service `:205-215,263-273,352-360,507-525` | wajib untuk buat, ubah URL (hanya bila berbeda), rotasi, allowlist. Nonaktif, hapus, dan ubah event tanpa konfirmasi (arah aman). URL ke metadata ditolak walau dikonfirmasi (tes baru) |
| RBAC | routes (`MANAGE`), `rbac-matrix.integration.test.ts` | Owner/Admin; Supervisor & CS 403 untuk daftar/uji/riwayat/allowlist (tes baru); `assertActorStillAuthorized` di setiap tulis; maks 10 webhook; 30 tulis/menit per pengguna |
| IDOR | service `:180-187,428-497` | semua kueri dibatasi `organizationId` + `endpointId`; kirim ulang pengiriman milik webhook lain → 404 (tes baru) |
| Outbox | `packages/db/src/outgoing-events.ts` | ditulis di transaksi yang sama, hanya ID + jenis, hanya bila ada langganan aktif |
| Isi payload | worker `:96-218` | isi pesan, nomor, nama/email/atribut/tag, pelaku. TANPA `wa_bsuid`, ID media Meta, token, atau rahasia (tes baru). Subjek terhapus → tidak dikirim |
| Endpoint nonaktif | worker `:318-330` | pengiriman tertunda → `endpoint_disabled`, tidak dikirim (tes baru) |
| Retensi & hapus kontak | worker `:449-466`, `contacts.repo.ts` | payload/potongan kosong 7 hari, baris 30 hari; hapus kontak membuang outbox (`contact_id`) dan mengosongkan payload (`data.contact.id`). Semua kejadian outbox kini membawa `contactId`, jadi payload pesan ikut terhapus |
| Nonaktif otomatis | worker `:381-438` | 20 gagal final beruntun → nonaktif sekali + audit (host) + email semua Owner aktif |
| Sewa klaim | worker `:269-292` | `FOR UPDATE SKIP LOCKED` + sewa 2 menit; kirim ganda mungkin bila satu putaran > 2 menit (lihat R1), penerima idempoten via `id` (kontrak) |

---

## B. Temuan

### R1 (Rendah) — Resolusi DNS di luar batas waktu, dan memakai threadpool bersama worker

- Bukti: `packages/core/src/net/outgoing-webhook.ts:194,262-263`
  - `dns.promises.lookup` dipanggil SEBELUM timer `timeoutMs` dimulai (`:383`), jadi lama resolusi tidak
    dibatasi.
  - `lookup` memakai `getaddrinfo` di threadpool libuv (bawaan 4 thread). Threadpool itu dipakai bersama
    oleh worker lain di proses yang sama (`apps/worker/src/runtime.ts:59-81`): kirim Meta, email, koneksi
    DB/Redis.
- Dampak: pemilik domain tujuan (atau Admin yang memasang URL) bisa membuat DNS-nya lambat.
  - 10 pengiriman paralel memenuhi threadpool, sehingga resolusi nama lain di worker ikut tertahan
    (mis. kirim pesan ke Meta).
  - Satu putaran bisa melewati sewa 2 menit, sehingga pengiriman yang sama bisa diklaim ulang (kirim
    ganda).
  - Tidak ada kebocoran data.
- Perbaikan: beri tenggat total yang mencakup DNS, misalnya
  `Promise.race([lookup, timeout(timeoutMs)])` dengan `AbortSignal`. Lebih baik lagi pakai
  `dns.promises.Resolver` (c-ares, tanpa threadpool) dengan `timeout`/`tries` kecil untuk A + AAAA.
- Tes: `it.fails` "waktu resolusi DNS ikut batas waktu total…" — gagal tepat di
  `expected 1512 to be less than 1000`.

### R2 (Rendah) — Beberapa rentang IPv6 yang membungkus IPv4 belum terlarang

- Bukti: `outgoing-webhook.ts:38-48`. Diklasifikasi `public`:
  - IPv4-compatible `::/96` (mis. `::7f00:1`);
  - 6to4 `2002::/16` (mis. `2002:7f00:1::1`, `2002:a9fe:a9fe::1`);
  - NAT64 local-use `64:ff9b:1::/48` (RFC 8215, mis. `64:ff9b:1::a9fe:a9fe`).
- Dampak: terbatas.
  - Ketiganya wajib https, jadi metadata cloud (http) tidak bisa dibaca.
  - Kernel Linux tidak merutekan `::/96` ke IPv4 tanpa tunnel SIT.
  - 6to4 butuh relay.
  - NAT64 local-use hanya ada di jaringan IPv6-only tertentu (sebagian Kubernetes). Di jaringan seperti
    itu, alamat ini bisa menjangkau layanan internal https.
- Perbaikan: tambahkan `::/96`, `2002::/16`, `64:ff9b:1::/48`, dan `2001::/32` (Teredo) ke `FORBIDDEN`.
  Atau, untuk 6to4/NAT64, ekstrak IPv4 tertanamnya lalu klasifikasikan ulang.
- Tes: 3 `it.fails` (`::7f00:1`, 6to4, NAT64 local-use) — gagal di `expected 'public' to be 'forbidden'`.

---

## C. Info

1. **Potongan jawaban = saluran baca SSRF terbatas.** Untuk tujuan privat di allowlist, Admin bisa membaca
   500 byte pertama jawaban layanan internal lewat "Kirim uji" + riwayat. Dibatasi allowlist (Owner/Admin
   + konfirmasi), POST saja, port terbatas. Wajar untuk n8n LAN; dokumentasikan di teks UI allowlist.
2. **Kirim ulang setelah URL diubah** mengirim payload 7 hari terakhir ke URL baru (hingga 30/menit).
   Ganti URL wajib konfirmasi, jadi bisa diterima. Pertimbangkan menolak kirim ulang untuk pengiriman
   yang dibuat sebelum `url` terakhir berubah.
3. **Kejadian beracun memblokir outbox.** `dispatch` memproses satu batch dalam satu transaksi tanpa
   try/catch per kejadian (`webhooks-out.ts:222-266`). Bila `buildEventBody` gagal deterministik untuk
   satu baris, seluruh batch diulang tiap 5 detik dan semua webhook organisasi mana pun macet. Saran:
   savepoint/try per kejadian, tandai gagal, lanjut.
4. **Email nonaktif otomatis dilewati bila pembuat webhook sudah dihapus** (`webhooks-out.ts:413`,
   `!endpoint.createdByUserId`). Audit + banner tetap ada. Kirim tanpa subjek atau pakai subjek Owner.
5. **Galat DB di jalur kirim dicatat dengan `err`** (`webhooks-out.ts:477`). Galat Drizzle memuat
   parameter kueri, dan untuk `finalize` itu bisa berupa potongan jawaban penerima. Isi pesan pelanggan
   tidak ikut (payload tidak diperbarui di sana). Risiko kecil; pertimbangkan hanya mencatat `err.code`.
6. **Rotasi beruntun < 24 jam**: rahasia ke-2 menggantikan rahasia lama, dan rahasia ke-0 langsung
   berhenti. Wajar. Tidak ada opsi "cabut rahasia lama sekarang" bila rahasia bocor; penerima harus
   berhenti menerima `v1` lama sendiri.

---

## D. Tes penjaga

- `packages/core/src/net/security-review-fase3-webhook-keluar.test.ts`: 6 `it` + 4 `it.fails`.
  - `it`: bentuk alamat aneh; mapped-heks privat; kredensial/skema/port; loopback mati di produksi;
    DNS sekali + soket ke IP terperiksa + `Host` asli; jawaban menetes dihentikan + potongan ≤ 500 tanpa
    karakter kontrol.
  - `it.fails`: R2 ×3, R1.
- `apps/api/src/modules/outgoing-webhooks/security-review-fase3-webhook-keluar.integration.test.ts`: 6 `it`
  - payload tanpa BSUID/rahasia; DB/audit/log tanpa rahasia, token path/query, atau nomor;
  - Supervisor/CS 403;
  - ubah URL tanpa konfirmasi ditolak, metadata ditolak walau dikonfirmasi, nonaktif tanpa konfirmasi;
  - allowlist hanya privat;
  - kirim ulang lintas webhook 404;
  - endpoint nonaktif tidak mengirim.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `packages/core`: `vitest run src/net` | 12 lulus + 4 `it.fails` |
| Salinan `it.fails` → `it` (sementara, sudah dihapus) | 4 gagal tepat di asersi temuan |
| `apps/api`: `vitest run src/modules/outgoing-webhooks src/modules/public-api src/rbac-matrix… src/modules/contacts` | 49 lulus, 7 berkas |
| `apps/worker`: `vitest run src/inbound src/queues` | 119 lulus, 11 berkas |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (esbuild via drizzle-kit, minimatch via eslint), tidak ada yang baru |
