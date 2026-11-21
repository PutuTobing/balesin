# Review Keamanan — Fase 2: layar Channel (web)

- Tanggal: 2026-11-16
- Peninjau: agent `security`
- Cakupan: commit `60be001` `feat(channel): Pengaturan → Channel, wizard WhatsApp 9 langkah, halaman nomor & profil
  bisnis`. Berkas: `apps/web/src/features/channels/**`, `apps/web/src/lib/api/{client,endpoints,queries}.ts`,
  `apps/web/src/app/router.ts` (rute channel), `apps/web/src/components/ui/{Field,CopyButton}.tsx`,
  `e2e/stack/{fake-meta-data,fake-meta-server}.ts`, `e2e/stack/start-backend.mjs`. Sisi server dicek hanya sejauh yang
  menentukan kebocoran (`apps/api/src/config.ts` `META_GRAPH_BASE_URL`, `apps/api/tsup.config.ts`,
  `apps/api/src/testing/fake-meta.ts`).
- Acuan: `CLAUDE.md` (aturan keras: token/App Secret tidak pernah ke browser kecuali saat diketik pengguna, tidak di-log),
  `docs/SECURITY.md` §2, §3, §8, `docs/KONTRAK-API-CHANNEL.md`, review `2026-11-15-fase2-channel-whatsapp.md`.
- Model ancaman: akun CS yang dibobol (mencoba membuka layar/API channel), sesi Admin di komputer bersama (sisa rahasia
  di cache/storage/DOM setelah disimpan), skrip pihak ketiga/ekstensi yang membaca DOM, dan kebocoran server Meta
  tiruan ke build produksi.
- Lingkungan uji: Vitest + jsdom (`apps/web`) saja. Stack E2E (3100/5180) tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis/Tinggi/Sedang. Token System User, App Secret, serta password + kode konfirmasi:
- dikirim **langsung** lewat `endpoints.*` (bukan `useMutation`), jadi cache mutasi tetap kosong;
- tidak pernah ditulis ke cache Query, storage, URL, atau riwayat;
- dikosongkan dari state wizard begitu channel tersimpan;
- form ganti kredensial selalu kosong, dan nilai lama hanya muncul sebagai petunjuk `••••abcd` dari server.

GET profil bisnis membawa CSRF. Semua tautan keluar menuju domain Meta dengan `rel="noopener noreferrer"`. Rute channel
dijaga `channels.manage` sebelum loader berjalan. Server Meta tiruan tidak bisa sampai ke produksi: konfigurasi produksi
menolaknya (gagal start), hanya loopback yang diterima, dan berkasnya tidak ikut bundle.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Selama form terbuka, React menyalin isian rahasia ke **atribut** `value` (`<input type="password" value="EAAG…">`). Isinya tampak di DevTools/serialisasi DOM, termasuk dialog konfirmasi (password, kode) | Sebelum menambah alat perekam sesi / pelaporan error yang memotret DOM |
| R2 | Rendah | `autocomplete="off"` di isian token/App Secret diabaikan password manager. Browser bisa menawarkan menyimpan token Meta sebagai "password" situs ini (tersinkron ke cloud, bisa menimpa entri password Balesin) | Kapan saja |
| Info 1–6 | Info | Lihat bagian C | — |

Tes baru: `apps/web/src/features/channels/security-review-fase2-channel-web.test.tsx`, berisi 11 penjaga (`it`) dan
1 `it.fails` (R1). `it.fails` sudah saya jalankan sebagai `it`, dan gagal tepat di asersi yang dimaksud
(`expected '<html>…' not to contain 'EAAGreviewTokenBaru…'`).

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Rahasia tidak masuk cache TanStack Query (query **dan** mutasi) | ✅ | Wizard `persist` (`ChannelWizardPage.tsx:185-212`), `CredentialsForm.persist` (`CredentialsCard.tsx:148-173`), dan `BusinessProfileCard.persist` memanggil `endpoints.channels.*` langsung. `storeChannel` hanya menyimpan `WhatsAppChannel` (petunjuk tersamar). Tes penjaga memeriksa `getQueryCache()` + `getMutationCache()` setelah simpan, untuk token, App Secret, password, dan kode |
| Storage, URL, riwayat | ✅ | Tidak ada `localStorage`/`sessionStorage` di fitur channel (satu-satunya pemakai di web: banner keamanan & preferensi perangkat). `HistoryState` hanya `deletedChannel` (nama) (`route-state.ts`). Tes penjaga: `localStorage`, `sessionStorage`, `router.state.location`, `window.location.href`, `history.state` |
| Log konsol | ✅ | Tidak ada `console.*` di fitur channel/lib API. Tes penjaga memata-matai `console.log/info/warn/error/debug` selama alur simpan |
| Atribut DOM **setelah** simpan | ✅ | Wizard pindah ke langkah webhook (input token/secret dilepas, nilai dikosongkan `values.accessToken/appSecret = ''`). Form kredensial ditutup (`setEditing(false)`). Dialog konfirmasi dilepas. Tes penjaga memeriksa `document.documentElement.outerHTML` (termasuk atribut). **Selama** form terbuka → R1 |
| Form ganti kredensial tidak menampilkan nilai lama | ✅ | State awal `accessToken: ''`, `appSecret: ''` (`CredentialsCard.tsx:120-125`). Server tidak pernah mengirim nilai asli (hanya `accessTokenHint`/`appSecretHint`). Isian kosong = tidak dikirim (`credentialChanges`) |
| `csrf: true` untuk GET profil bisnis | ✅ | `endpoints.ts` `businessProfile` + `client.ts` `send(..., forceCsrf)`. Bila `CSRF_INVALID`, token diambil ulang lalu dicoba sekali lagi (juga untuk GET ber-CSRF). Tes `ChannelPage.test.tsx` "GET profil bisnis membawa header CSRF". `retry: false`, `refetchOnWindowFocus: false` supaya jatah batas laju tidak terbuang |
| Tautan eksternal hanya ke Meta, `rel=noopener` | ✅ | Semua `href` di `i18n/id.ts` bagian channel: `business.facebook.com`, `business.facebook.com/settings/{security,system-users}`, `business.facebook.com/wa/manage/home/`, `developers.facebook.com/apps/`. Ditambah `WHATSAPP_MANAGER_URL` (`BusinessProfileCard.tsx:42`). Semua `target="_blank" rel="noopener noreferrer"` (`GuideSteps.tsx:30-32`, `BusinessProfileCard.tsx:325`). Website profil bisnis hanya tampil sebagai **nilai isian**, bukan tautan. Tidak ada `dangerouslySetInnerHTML` |
| Guard izin rute (CS tidak memanggil API channel) | ✅ | Ketiga rute memakai `beforeLoad: guardPermission(session, 'channels.manage')` (`router.ts:262-300`), sebelum `loader` prefetch berjalan. Menu Pengaturan menyembunyikan Channel (`useCan('channels.manage')`). Tes penjaga: **semua** peran selain Owner/Admin (`supervisor`, `cs`, `teknisi`) × 3 rute → dialihkan ke `/pengaturan`, dan tidak ada satu pun permintaan ke `/settings/channels…`. Server tetap 403 (RBAC matrix) |
| Server Meta tiruan / `META_GRAPH_BASE_URL` tidak bocor ke produksi | ✅ | `config.ts` `parseMetaGraphBaseUrl`: di produksi nilainya **ditolak** (`envOptional` → error konfigurasi, API tidak start), di luar produksi hanya `http(s)://localhost|127.0.0.1|[::1]` tanpa kredensial/path/query. `tsup` entry hanya `src/index.ts` dan tidak ada impor ke `testing/`, jadi `fake-meta.ts` tidak ikut bundle. Server tiruan `listen(0, '127.0.0.1')`. `start-backend.mjs` hanya mengisi env proses anak E2E. Web tidak mereferensikan fake Meta atau `META_GRAPH*` (`import.meta.env` hanya `DEV` untuk rute pratinjau) |
| Data E2E palsu tidak memicu secret scanning | ✅ | Lihat Info 5 |

---

## B. Temuan

### R1 — Rendah — Isian rahasia muncul sebagai atribut `value` selama form terbuka

**Bukti.** `PasswordField` (`components/ui/Field.tsx:128-153`) adalah input **terkendali** (`value={values.accessToken}`
di `CredentialsCard.tsx:225`, wizard, dan `IdentityDialog`). React DOM menyinkronkan atribut `value` dengan nilai
terkendali. Uji jsdom: setelah mengetik, `outerHTML` = `<input … type="password" value="RAHASIA123">`. Tes `it.fails` R1
mengunci perilaku ini di form ganti kredensial.

**Dampak.** Nilainya sudah bisa dibaca skrip apa pun lewat `.value`, jadi ini **bukan** celah baru bagi penyerang yang
sudah bisa menjalankan JS. Yang bertambah adalah permukaan pasif:
- alat yang menyerialisasi DOM (perekam sesi/"session replay", lampiran DOM di pelaporan error, ekstensi
  tangkap-layar/halaman) merekam atribut ini;
- pemilih atribut CSS (`input[value^="EAAG"]`) bisa mengeksfiltrasi lewat injeksi CSS, bila suatu hari CSP
  melonggarkan `style-src`;
- terlihat di panel Elements DevTools saat berbagi layar.

Setelah simpan/batal, inputnya dilepas, sehingga tidak ada sisa (penjaga lulus).

**Perbaikan** (pilih salah satu):
1. Isian rahasia (token, App Secret, password/kode konfirmasi) dibuat **tak terkendali**: `defaultValue=""` + `ref`, lalu
   dibaca saat submit (`new FormData(form)`/`ref.current.value`), dan dikosongkan `ref.current.value = ''` setelah
   selesai. Validasi per isian tetap bisa memakai `onChange` tanpa menyimpan nilainya di prop `value`.
2. Atau di `PasswordField`, sesudah render `useLayoutEffect(() => input.removeAttribute('value'))`. Cara ini kurang
   bersih dibanding pilihan 1.

Ubah `it.fails` R1 menjadi `it` setelah diperbaiki. Bila nanti ditambah alat perekam sesi/pelaporan error, wajibkan
penyamaran semua `input[type=password]` dan elemen `[data-secret]`.

### R2 — Rendah — Password manager bisa menyimpan token Meta sebagai password

**Bukti.** Isian token/App Secret: `type="password"` + `autocomplete="off"` (`CredentialsCard.tsx:228,239`, wizard).
Chrome, Firefox, dan Safari mengabaikan `autocomplete="off"` pada isian password. Saat form dikirim, browser bisa
menawarkan "Simpan password untuk balesin…" dengan nilai token/App Secret, lalu menyinkronkannya ke akun browser dan
mengisikannya otomatis di form login.

**Perbaikan.** Pakai `autocomplete="one-time-code"` (tidak disimpan password manager, tanpa saran pembuatan password)
atau `new-password` disertai atribut abaikan dari pengelola populer (`data-1p-ignore`, `data-lpignore="true"`,
`data-bwignore`, `data-form-type="other"`). Alternatif: `type="text"` dengan `-webkit-text-security: disc` + tombol
tampilkan, tetapi dukungannya tidak merata, jadi bukan pilihan utama.

---

## C. Info (tidak perlu tindakan segera)

1. **Verify token** memang ditampilkan ke peran `channels.manage` (teks `<code>` + Salin). Query-nya `gcTime: 0`, jadi
   dibuang begitu halaman nomor ditutup. Hasil "Buat ulang" ditaruh di cache yang sama (`setQueryData`), juga
   `gcTime: 0`. Nilainya hanya berguna untuk jabat tangan GET (tidak bisa memalsukan pesan), jadi ini bisa diterima.
2. **Logout/sesi habis** membersihkan seluruh data Query (`clearAppData`, Fase 1), termasuk cache channel.
3. **`initialData` dari daftar** (`channelQuery`) hanya memuat objek channel tersamar, sama dengan respons detail.
4. **Prefetch webhook di loader** baru berjalan setelah `beforeLoad` lolos, jadi peran tanpa izin tidak memicunya
   (tes penjaga izin rute).
5. **Data palsu & secret scanning.** Token E2E (`EAAGe2eTokenSahTiruan_…`) dan token di tes unit memakai kata
   "Tiruan"/"review"/"Rahasia" dengan entropi rendah. Saya memindai repo dengan pola Meta yang umum dipakai pemindai
   (gitleaks `EAA[MC][a-z0-9]{100,}`, app token `\d{15,16}\|…`, `facebook…[a-f0-9]{32}`): tidak ada yang cocok. Tidak
   ada pola mirip token bot Telegram (`\d{8,10}:AA…`). Saran ringan untuk mencegah insiden token contoh terulang: tambah
   langkah `gitleaks detect` di CI (allowlist folder `**/testing/**`, `e2e/stack/fake-meta-data.ts`) dan catat konvensi
   di `docs/SECURITY.md` §3: nilai contoh wajib memuat kata `tiruan`/`contoh`, tidak boleh berbentuk token asli yang
   bisa diverifikasi penyedia (mis. `123456789:AA…` Telegram, `xoxb-` Slack, `ghp_` GitHub), dan tidak di-commit di
   dokumen pengguna.
6. **Halaman tes koneksi/profil** menampilkan `message` server apa adanya sebagai teks (React meng-escape). Tidak ada
   HTML dari Meta yang dirender.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/web`: `vitest run src/features/channels/security-review-fase2-channel-web` | 11 lulus + 1 `it.fails` (R1) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi DOM berisi token (R1) |
| `apps/web`: `vitest run src/features/channels src/lib` | 92 lulus + 1 `it.fails`, 8 berkas |
| ESLint + `tsc --noEmit` (apps/web) + Prettier untuk berkas tes baru | bersih |
| Uji jsdom ad-hoc input terkendali `type=password` | `outerHTML` memuat `value="…"` (dasar R1) |
| Pindai pola token (git grep) | tidak ada yang cocok dengan pola Meta/Telegram yang umum |

Catatan: working tree saat tes berisi perubahan backend yang belum di-commit (`disabledAt`, `apps/web/src/test/fake-api.ts`,
`packages/shared/src/channels.ts`). Tes di atas lulus dengan keadaan itu.
