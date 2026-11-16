# Review keamanan — Fase 2 web: service worker, PWA, notifikasi push

- Commit: `9778d3d` (`feat(pwa): notifikasi push & PWA installable, Pengaturan → Notifikasi; revisi panel detail P1–P4`)
- Cakupan:
  - `apps/web/vite/service-worker-plugin.ts`
  - `apps/web/src/sw/*`, `apps/web/src/pwa/*`
  - `apps/web/src/brand/web-manifest.ts`
  - `apps/web/src/features/notifications/*`
  - logout/401 (`session.ts`, `lib/api/queries.ts`)
  - token warna tag & `css-guard`
- Peninjau: subagent `security`
- Model ancaman:
  - perangkat bersama (CS bergantian di satu PC/HP);
  - penyerang yang bisa memengaruhi isi push atau URL logo merek;
  - halaman/origin lain yang mencoba memanfaatkan service worker.

## Putusan: **AMAN**

Tidak ada temuan Kritis, Tinggi, atau Sedang. Ada 1 temuan Rendah (pertahanan berlapis) dan 4 Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Isi cache | `vite/service-worker-plugin.ts:155-178`, `src/sw/sw.ts:76-117` | Cache hanya diisi saat `install` dari daftar precache (berkas build + `public/` + `/index.html` statis + manifest), tanpa `sw.js` dan `.map`. Tidak ada penulisan cache runtime, jadi respons API/HTML bersesi/media pelanggan tidak pernah masuk cache. Cache versi lama dihapus saat `activate`. Dev = tanpa penangan `fetch` |
| Strategi fetch | `src/sw/sw-handlers.ts:104-121` | `/api/`, origin lain, non-GET, berkas di luar precache, dan URL ber-query → jaringan. Navigasi = jaringan dulu, `/index.html` cache hanya saat offline. Navigasi ke `/api/…` (mis. ekspor, `/api/docs`) tetap jaringan (tes baru) |
| Logout di perangkat bersama | cache hanya aset statis; `session.ts` (`releasePush({server:true})`, maks 3 dtk), `queries.ts:332` (401 → `releasePush({server:false})`) | Tidak ada data pengguna di cache SW. Langganan push dilepas di server (DELETE + CSRF) lalu di browser; saat sesi kedaluwarsa dilepas lokal (server sudah menghapus langganan sesi itu). Endpoint push unik di server (`onConflictDoUpdate` `endpoint`), jadi perangkat yang dipakai pengguna lain berpindah pemilik, bukan ganda |
| Validasi isi push | `src/sw/push-payload.ts` | `v === 1`, judul/isi/tag dipotong, `conversationId` UUID/`null`, `url` harus path aplikasi. Isi tidak valid → notifikasi umum tanpa teks dari push, data `{ url: '/inbox' }` (tes baru) |
| URL klik notifikasi | `push-payload.ts:25,33-35,67-77`, `sw-handlers.ts:73-101` | Ditolak: `//host`, `/\host`, `\\host`, `\/host`, skema (`https:`, `javascript:`, `data:`), karakter kontrol (`\t \n \r`, yang dibuang parser URL), spasi depan, > 2048, non-string. `resolveAppUrl` menolak hasil beda origin. Bentuk `%2F%2F`, `%5C`, unicode (`∕`, `／`, `＼`, spasi ideografis), `?next=//`, `#//`, `/@host` tetap di origin aplikasi. Tab origin lain diabaikan; pesan navigasi hanya path. Halaman memeriksa ulang `isAppPath` (`pwa/service-worker.ts:48-51`) dan `router.navigate({ href })` tanpa skema tetap SPA internal |
| Skip-waiting | `sw.ts:94-97`, `pwa/service-worker.ts:81-89`, `UpdateBanner.tsx` | Hanya pesan `balesin:skip-waiting` dari halaman sendiri (klien SW selalu satu origin), dan dikirim hanya dari klik "Muat ulang"; muat ulang hanya bila `reloading` |
| Izin notifikasi | `push-device.ts:83-118`, `NotificationsPage.tsx:113-117` | `Notification.requestPermission()` hanya di `enablePush`, yang hanya dipanggil dari tombol. `userVisibleOnly: true`. Kunci VAPID publik dari API bersesi; langganan dengan kunci lama di-unsubscribe dulu. Body langganan divalidasi Zod sebelum dikirim |
| Pengaturan organisasi | `NotificationsPage.tsx:50,71,380-421` | Kartu `preview`/`contactName` hanya untuk `organization.manage`, bawaan mati; server penegak (review push backend) |
| Manifest bermerek | `brand/web-manifest.ts:31-64` | Logo, ikon, `id`, `start_url`, `scope` origin lain atau skema `javascript:`/`data:` dibuang (tes baru). Nama produk hanya nilai JSON di Blob `application/manifest+json`; Blob URL dicabut saat merek berganti |
| Tidak ada sink berbahaya | grep berkas yang diubah | tanpa `innerHTML`, `dangerouslySetInnerHTML`, `href` dinamis selain `#id` statis, `window.open`, `console.*`, atau storage baru |
| Token tag & `css-guard` | `packages/shared/src/design-tokens.ts`, `styles/css-guard.test.ts` | hanya warna. Pengecualian `var(--x)` di penjaga CSS tidak meloloskan `var(--x, red)` (fallback bernama tetap terdeteksi) |

---

## B. Temuan

### R1 (Rendah) — Segmen titik bisa menghasilkan path `//host` setelah normalisasi URL

- Bukti: `apps/web/src/sw/push-payload.ts:25,67-77`. `APP_PATH` hanya memeriksa dua karakter pertama.
  - `'/x/..//evil.example'`, `'/.%2e//evil.example'`, `'/x/%2e%2e//evil.example'` lolos `isAppPath`.
  - `new URL(…, origin)` menormalkan segmen titik menjadi `https://<origin>//evil.example`. Origin-nya
    sama sehingga `resolveAppUrl` menerimanya, tetapi pathname-nya `//evil.example`.
- Dampak saat ini kecil:
  - Tab terbuka: pesan navigasi berisi `//evil.example`, lalu ditolak `isAppPath` di halaman.
  - Tanpa tab: `openWindow` membuka URL di origin SENDIRI dengan path aneh.
  - `url` push dibangun server dari ID percakapan, tidak dari input pengguna.
  - Ini penjaga berlapis yang belum rapat. Bila kelak sebuah router/redirect menafsirkan pathname `//…`
    sebagai URL protokol-relatif, ini menjadi open redirect.
- Perbaikan: di `resolveAppUrl` tolak bila `url.pathname.startsWith('//')` (atau mengandung `\`), dan
  kembalikan `url.pathname + url.search` yang sudah dinormalkan. Opsional: tolak segmen `.`/`..`
  (termasuk `%2e`) di `APP_PATH`.
- Tes: `it.fails` "R1: segmen titik ter-encode…" — gagal di `/.%2e//evil.example: expected true to be false`.

---

## C. Info

1. **Penyajian produksi (Fase 7, devops).**
   - `sw.js` dan `index.html` harus `Cache-Control: no-cache` supaya pembaruan sampai.
   - Bila web app diberi CSP, tambahkan `worker-src 'self'` dan `manifest-src 'self' blob:` (manifest
     bermerek berupa Blob URL).
   - Belum ada konfigurasi server web di repo; catat untuk butir deploy.
2. **Shell offline** `/index.html` disajikan untuk navigasi APA PUN saat offline. Isinya statis tanpa data,
   jadi aman. Data tetap dimuat dari API (yang gagal offline).
3. **Notifikasi umum saat isi push tidak valid** memakai `tag: 'pembaruan-inbox'` dan selalu ke `/inbox`.
   Wajar.
4. **`releasePush({server:true})` saat logout dibatasi 3 detik.** Bila habis, langganan di server tetap
   terhapus bersama sesi (server memotong langganan per sesi), jadi tidak ada notifikasi yang tertinggal.

---

## D. Tes penjaga

Berkas baru: `apps/web/src/sw/security-review-fase2-pwa.test.ts` — 11 `it` + 1 `it.fails`:

- korpus path berbahaya ditolak;
- bentuk ter-encode/unicode tetap di origin;
- klik tanpa tab selalu di origin aplikasi;
- tab origin lain diabaikan dan pesan navigasi hanya path;
- push ber-url berbahaya → notifikasi umum;
- `conversationId`/`v` salah → ditolak;
- strategi cache (API/origin lain/non-GET/query/di luar precache → jaringan; navigasi jaringan dulu; dev tanpa cache);
- manifest bermerek membuang logo/ikon/start_url origin lain dan skema berbahaya; logo sama origin dipakai;
- `it.fails`: R1.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/sw/security-review-fase2-pwa.test.ts` | 11 lulus + 1 `it.fails` |
| Salinan `it.fails` → `it` (sementara, sudah dihapus) | gagal tepat di R1 |
| `apps/web`: `vitest run src/sw src/pwa src/features/notifications src/brand src/styles src/features/auth …panel-batas-kirim` | 96 lulus + 1 `it.fails`, 10 berkas |
| `tsc --noEmit` + ESLint (`apps/web`) | bersih |
| `pnpm audit` | 2 moderate dev-only (esbuild via drizzle-kit, minimatch via eslint), tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan (commit `4e53378`)

| Butir | Bukti | Status |
|---|---|---|
| R1 segmen titik → `//host` | `apps/web/src/sw/push-payload.ts` `resolveAppUrl`: setelah `new URL(path, origin)` menolak pathname yang diawali `//` atau berisi `\`, dan mengembalikan `origin + pathname + search` hasil normalisasi (bukan `href` mentah). Tes penjaga R1 di `security-review-fase2-pwa.test.ts` diubah `it.fails` → `it` dan lulus (`/.%2e//evil.example`, `/x/%2e%2e//…`, `/./%2e%2e//…`) | **Tertutup** |

Catatan: `handleNotificationClick` kini membuka URL hasil normalisasi; halaman tetap memeriksa ulang
`isAppPath` untuk pesan navigasi. `vitest run src/sw` lulus semua tanpa `it.fails` tersisa. Putusan tetap
**AMAN**.
