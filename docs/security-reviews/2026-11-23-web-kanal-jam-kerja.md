# Review keamanan — Web: channel Telegram/Email/Meta, inbox multi-channel, jam kerja & pesan otomatis, saklar "Tersedia"

- Commit: `9aeb2f1` (`feat(web): channel Telegram/Email/Meta, inbox multi-channel, jam kerja & pesan otomatis, saklar Tersedia; revisi UI Fase 5`)
- Lingkup: `apps/web/src/features/channels/connections/*`, `features/inbox/EmailMessage.tsx` +
  `contact-identity.ts`/`ConversationItem.tsx`/`ContactPanel.tsx`, `features/workspace/*`,
  `zod-config.ts`/`main.tsx`; pola form bersarang di seluruh `apps/web`
- Acuan: `docs/SECURITY.md` §3, §8; review backend `2026-11-22-fase6-channel.md` (Info 2 & 3: nama
  channel tidak tepercaya, HTML email wajib `iframe sandbox`), DECISIONS Fase 7 (CSP produksi, jitless)
- Peninjau: subagent `security`
- Model ancaman: (1) akun Admin/Owner curian yang ingin mencuri token bot Telegram, password
  IMAP/SMTP, atau app secret Meta lewat browser; (2) pelanggan/pengirim email yang menyisipkan
  HTML/skrip atau meniru nama tim; (3) skrip pihak ketiga/ekstensi atau riwayat browser yang memungut
  rahasia dari URL, storage, atau cache; (4) Admin yang mengira kredensial bocor sudah dirotasi.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi. 1 Sedang (W1 — rotasi rahasia lewat "Ubah" gagal diam-diam), 1 Rendah
(W2 — password konfirmasi di cache mutasi), beberapa Info. W1 sebaiknya diperbaiki sebelum channel
Telegram/Email dipakai produksi.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Rahasia di form channel (buat) | `connection-form.tsx:27-75,155-161,266-272`, `use-connection-form.ts:100-118`, `Field.tsx:187-206` | token bot, password IMAP/SMTP, page access token, app secret hanya `SecretField` TAK TERKENDALI (callback ref; tidak ada `value` di state/atribut DOM; `autocomplete="new-password"` + atribut abaikan password manager); dibaca saat kirim, `clearSecrets()` setelah sukses; dikirim lewat `endpoints.connections.*` langsung (bukan `useMutation`). Tes baru: setelah membuat Telegram dan Email (IMAP + SMTP kustom) — token, kedua password, dan password konfirmasi identitas TIDAK ada di cache Query/mutasi, `Storage.setItem`, `console.*`, HTML dokumen, maupun nilai isian |
| Isian non-rahasia | `use-connection-form.ts:22-87` | hanya host/port/username/folder/ID halaman di state; respons server hanya `…Hint` tersamar (`••••ghij`) |
| SMTP tanpa TLS | `connection-form.tsx:241` | pilihan keamanan SMTP hanya `ssl`/`starttls` (`none` tidak ditawarkan; tes baru) |
| Konfirmasi identitas | `ConnectionWizardPage.tsx:69-95`, `ConnectionPage.tsx:504-606` | buat/hapus/ubah kredensial/tujuan = `IdentityDialog` (password + kode) — `SENSITIVE_KEYS` mencakup token, email, IMAP/SMTP, server verifikasi, ID halaman/IG, app secret; ubah nama saja tanpa konfirmasi (tes lama) |
| HTML email | `EmailMessage.tsx:76-125` | HANYA `<iframe sandbox="" srcDoc>` (tanpa token `allow-*`, tanpa `allow` attribute, tanpa `src`, `referrerPolicy="no-referrer"`), dimuat saat tombol ditekan, `gcTime` 60 dtk. Tes baru dengan 9 vektor (`<script>`, `onerror`, `javascript:`, `<base>`, `<meta refresh>`, `<form action>`, `<iframe src>`, `<svg onload>`): `srcdoc` = string apa adanya, tidak satu pun elemen masuk ke dokumen aplikasi, tidak ada skrip baru, `window.__balesinXss` tetap `undefined`, satu-satunya iframe = bingkai sandbox. Di browser: dokumen `srcdoc` mewarisi CSP halaman (`img-src 'self' data: blob:`, `frame-src 'self'`), jadi piksel pelacak & iframe luar juga tertahan di lapis kedua |
| Subjek & isi email | `EmailMessage.tsx:29-34` | dirender sebagai teks (`dir="auto"`); tes baru: subjek `<img onerror>` tampil sebagai teks |
| Label verifikasi pengirim | `EmailMessage.tsx:26-46` | `fail` = peringatan keras (`role="note"`); tanpa `senderVerification` dan tanpa `authWarning` → `unverified` (netral), TIDAK PERNAH jatuh ke `pass` (tes baru, 2 kasus) |
| Nama dari channel | `contact-identity.ts:58-100,113-123`, `ConversationItem.tsx`, `ContactPanel.tsx` | `nameSource: 'channel'` → label "dari Telegram/Email/…" + `channelHandle` (`@username`/alamat) di samping nama; channel non-WhatsApp di panel menyebut jenisnya. Tes baru: nama profil Telegram yang meniru tim ("Admin Resmi …") tetap berlabel + handle asli |
| IdentityDialog di luar `<form>` | `WorkspaceSettingsPage.tsx:402-480` | perbaikan terverifikasi: dialog adalah saudara `<form>` pesan otomatis; tes baru: `dialog.closest('form') === null`, `document.querySelector('form form') === null`, setelah konfirmasi password/kode tidak ada di `router.location` maupun `window.location` |
| Pola serupa di seluruh web | pemindai statis (tes baru) + sapuan runtime | (a) tes penjaga: tidak ada komponen yang merender `<form>` (52 komponen, termasuk `IdentityDialog`) ditaruh di dalam `<form>` lain di JSX mana pun di `apps/web/src`; (b) sapuan runtime: seluruh suite web (70 berkas, 836 tes) dijalankan dengan pengamat tambahan (`MutationObserver` `form form` + peringatan React validateDOMNesting; kontrol positif jsdom terdeteksi) → **0 kemunculan form bersarang** |
| `dangerouslySetInnerHTML` & iframe | tes baru (statis) | tidak ada `dangerouslySetInnerHTML` di `apps/web/src`; setiap `<iframe srcDoc>` punya `sandbox`, tidak ada `allow-scripts`/`allow-same-origin` |
| Zod jitless | `zod-config.ts`, `main.tsx:1-2` | `z.config({ jitless: true })` diimpor PERTAMA di `main.tsx` (tes baru memeriksa urutan) → tidak ada probe `Function('')`, CSP tetap tanpa `unsafe-eval` |
| Saklar "Tersedia" | `AvailabilityToggle.tsx` | hanya mengirim `{ available }` untuk diri sendiri lewat `endpoints.availability.set`; tampil hanya saat round-robin; agen dikecualikan → tombol nonaktif; penegakan (Teknisi 409, dikecualikan, hanya diri sendiri) ada di server (review backend Fase 5 jam kerja) |
| Dependensi | `git show 9aeb2f1 --stat` | tidak ada perubahan `package.json`/lockfile |

---

## B. Temuan

### W1 (Sedang) — Mengganti rahasia lewat "Ubah" + konfirmasi identitas gagal DIAM-DIAM

- Bukti: `apps/web/src/features/channels/connections/ConnectionPage.tsx:552` —
  `<Dialog open={!confirming}>` membungkus form ubah; `components/ui/Dialog.tsx:60` merender isi hanya
  bila `open`. Saat isian sensitif berubah, `submit` → `setConfirming(true)` → isi dialog ubah
  DILEPAS, `SecretField` ikut dilepas dan callback ref (`use-connection-form.ts:102-104`) menjadi
  `null`. `send(confirmation)` (`:505-519`) memanggil `form.build()` lagi → `secret(name)` =
  `undefined` → rahasia dianggap "tidak diganti".
- Diuji (tes `it.fails` W1): ubah token bot Telegram → simpan → konfirmasi identitas → **tidak ada
  permintaan PATCH sama sekali** (body kosong → `built.empty` → dialog ditutup tanpa pesan). Bila
  isian lain ikut diubah (nama/host), hanya isian itu yang terkirim dan UI menampilkan "Tersimpan" —
  password IMAP/SMTP, page access token, atau app secret baru hilang.
- Dampak: Admin yang merotasi token/password/app secret yang bocor (mis. setelah akun CS dibobol atau
  token Telegram tersebar) mengira rotasi berhasil, padahal kredensial lama tetap aktif dan terus bisa
  dipakai penyerang. Tidak membocorkan rahasia, tetapi mematahkan langkah pemulihan insiden.
- Perbaikan (pilih satu, yang paling sederhana pertama):
  1. Biarkan form ubah tetap terpasang selama konfirmasi — mis. jangan menutup `Dialog` ubah
     (`open` tetap `true`, `IdentityDialog` modal di atasnya), atau sembunyikan dengan `hidden` alih-alih
     melepas isinya.
  2. Baca rahasia SEKALI saat `submit` lalu bawa body jadi ke `send(confirmation)` (seperti
     `ConnectorsPage`/`WebhookFormDialog` — `pending.body`), dan kosongkan setelah selesai/batal.
  Tambahkan tes: ganti token/password lewat "Ubah" → PATCH memuat nilai baru + `confirmation`;
  sesudahnya `expectSecretNowhere`.
- Tes: `it.fails` "W1: mengganti token Telegram lewat "Ubah" + konfirmasi identitas benar-benar
  mengirim token baru" (gagal di `expected null not to be null` — tidak ada PATCH).

### W2 (Rendah) — Password akun + kode 2FA tersimpan di cache mutasi (pesan otomatis)

- Bukti: `apps/web/src/features/workspace/WorkspaceSettingsPage.tsx:95-101` (`useSaveWorkspace` =
  `useMutation`) dan `:363-375` (`save.mutateAsync({ autoMessages, confirmation })`). TanStack Query
  menyimpan `variables` mutasi di `MutationCache` selama komponen terpasang + `gcTime` (bawaan 5 menit).
  Tes: setelah konfirmasi, `mutation.state.variables` memuat
  `"confirmation":{"password":"Kopi-Senja-Tenang-42","code":"123456"}`.
- Dampak: password akun Admin/Owner tetap di memori yang bisa dibaca skrip apa pun di halaman (atau
  React/Query DevTools) jauh setelah dipakai. Satu-satunya tempat di web yang melanggar pola "permintaan
  berkonfirmasi lewat `endpoints.*` langsung" (lihat review `fase2-channel-web`, `fase3-integrasi-web`;
  `EmailSettingsPage`, `ConnectorsPage`, `DepartmentAccessCard`, dll.).
- Perbaikan: di `send(confirmation)` panggil `endpoints.workspace.update(...)` langsung lalu
  `queryClient.setQueryData(workspaceKeys.settings, data)`; `useSaveWorkspace` hanya untuk simpan tanpa
  konfirmasi (jam kerja, alokasi). Atau `mutationFn` menerima body tanpa `confirmation` dan konfirmasi
  dibawa lewat closure/ref yang dikosongkan.
- Tes: `it.fails` "W2: password konfirmasi tidak tertinggal di cache mutasi".

---

## C. Info

1. **`srcdoc` tanpa CSP sendiri**: pratinjau template email membungkus HTML dengan dokumen ber-CSP
   `default-src 'none'` (`emailPreviewDocument`), sedangkan `EmailMessage` memasukkan HTML apa adanya.
   Dengan `sandbox=""` + CSP halaman yang diwarisi + sanitasi server, ini aman; membungkus dengan
   `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
   menambah lapis bila suatu saat CSP gateway dilonggarkan.
2. **Kontak Telegram tanpa `@username`**: `channelHandle` bisa `null` → nama profil tampil tanpa
   handle (hanya label "dari Telegram"). Pertimbangkan menampilkan ID Telegram/"tanpa username" supaya
   dua kontak bernama sama tetap bisa dibedakan.
3. **Pesan galat server** (`isApiError(error) ? error.message`) ditampilkan di form channel — pesan
   berasal dari `AppError` server (bahasa Indonesia, tanpa nilai rahasia; review backend Fase 6).
4. **`zodFieldErrors`** memetakan pesan Zod (tanpa nilai input), jadi rahasia tidak ikut ke pesan galat.
5. **Suite web saat review**: sapuan penuh mencatat 22 tes gagal karena waktu habis/elemen tidak
   ditemukan di bawah beban tinggi dan berkas yang sedang disunting agen lain (`Workspace.test.tsx`,
   `AvailabilityToggle.tsx`, `ConnectionsSection.tsx` di salinan kerja). Itu bukan temuan keamanan;
   `qa-tester` perlu menjalankan ulang di salinan bersih.

---

## D. Tes penjaga

Berkas baru: `apps/web/src/features/security-review-web-kanal-jam-kerja.test.tsx` — 11 `it` + 2
`it.fails`:
- membuat Telegram / Email (IMAP + SMTP kustom): `expectSecretNowhere` untuk token, dua password, dan
  password konfirmasi; SMTP tanpa TLS tidak ditawarkan;
- `it.fails` W1 (rotasi rahasia lewat "Ubah");
- pesan otomatis: dialog identitas di luar `<form>`, tidak ada `form form`, password/kode tidak masuk URL;
  `it.fails` W2 (cache mutasi);
- email: 9 vektor XSS hanya di iframe `sandbox=""`; subjek HTML sebagai teks; label verifikasi `fail` dan
  "tanpa hasil ≠ pass";
- nama channel tidak tepercaya diberi label + handle;
- statis: tidak ada komponen ber-`<form>` di dalam `<form>` di seluruh `apps/web/src`; tanpa
  `dangerouslySetInnerHTML`; setiap `iframe srcDoc` ber-`sandbox` tanpa `allow-scripts/allow-same-origin`;
  `./zod-config` impor pertama di `main.tsx`.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `vitest run src/features/security-review-web-kanal-jam-kerja.test.tsx` | 11 lulus + 2 `it.fails` sesuai harapan (W1: tidak ada PATCH; W2: password di `variables`) |
| Sapuan runtime form bersarang (suite web penuh + pengamat `form form`/validateDOMNesting) | 0 kemunculan di 836 tes |
| `eslint` + `prettier --check` berkas tes baru | bersih |
| `tsc --noEmit -p apps/web` (disaring ke berkas tes baru) | tanpa galat |
| Dependensi | tidak berubah di commit ini |

Tidak memakai stack E2E (3100/5180) maupun stack kritikus (3191/5191); semua uji di jsdom.

---

## Putaran 2 — verifikasi perbaikan `b785c4f`

- Commit: `b785c4f` (`feat(web): revisi K1–K8 & F11, saklar Tersedia ber-teks, W1/W2 security, …`)
- Lingkup: `ConnectionPage.tsx` (EditDialog, StatusCard), `WorkspaceSettingsPage.tsx`
  (AutoMessagesSection, AgentRow), `lib/api/endpoints-channels.ts`, `Switch.tsx`,
  `AvailabilityToggle.tsx`, `ContactPanel.tsx`, `EmailMessage.tsx`, tes penjaga.
- Tidak ada perubahan kode produk oleh peninjau; hanya tes ditambah.

### Putusan putaran 2: **AMAN**

W1 dan W2 tertutup. Tidak ada temuan baru Kritis/Tinggi/Sedang/Rendah; dua catatan Info.

### Status per temuan

| Temuan | Status | Bukti |
|---|---|---|
| **W1** (Sedang) rotasi rahasia lewat "Ubah" gagal diam-diam | **AMAN — tertutup** | `ConnectionPage.tsx:524` `pendingBody = useRef` (bukan state, tidak dirender, tidak di-log); diisi SEKALI dari `form.build()` saat Simpan (`:558`, `:567` bila server minta konfirmasi); dikosongkan saat sukses (`:534` + `form.clearSecrets()` `:535`), Batal (`:603`), dan galat selain konfirmasi (`:618`). Hanya dipertahankan saat password/kode ditolak (`isConfirmationError` → dialog tetap terbuka untuk dicoba lagi) — wajar, lalu dibuang saat Batal. `SecretField` tetap tak terkendali (tidak ada `value` di state/atribut); setelah Batal/galat isian token muncul KOSONG. Dikirim lewat `endpoints.connections.update` langsung (tanpa `useMutation`); respons hanya `…Hint`. |
| **W2** (Rendah) password + kode di cache mutasi | **AMAN — tertutup** | `WorkspaceSettingsPage.tsx:340-390` — `AutoMessagesSection` memanggil `endpoints.workspace.update` langsung (`:381`), hasil ke `setQueryData(workspaceKeys.settings)` (`:382`; respons tanpa `confirmation`); `failure` menyimpan `ApiError` (`client.ts:35-59` — tanpa body permintaan). `useSaveWorkspace` (`:96`) masih dipakai jam kerja & alokasi, keduanya tanpa konfirmasi identitas (`grep confirmation` hanya di `:368-372`, `:488-490`). |
| Hapus channel lain (perubahan baru) | **AMAN** | `endpoints-channels.ts:53-59` — `DELETE` dengan body JSON `{ password, code }` di tingkat atas, cocok `deleteChannelRequestSchema = identityConfirmationSchema` (`packages/shared/src/channels.ts:157`, `identity.ts:17-20`), rute server `connections.routes.ts:152`. Bukan URL/query. `client.ts:75,148` memasang `X-CSRF-Token` untuk DELETE; `credentials: 'include'`, tidak ada cache HTTP/Query. Dipanggil dari `StatusCard.remove` (`ConnectionPage.tsx:651-661`) langsung, tanpa `useMutation`. Bentuk lama `{ confirmation }` ditolak server (400) — itu bug fungsional, bukan celah (tidak ada jalan hapus tanpa password). |
| Tes `it.fails` → `it` | **Bukan tautologi, tapi belum menguji kebocoran** | Tes W1 lama hanya membuktikan PATCH memuat token baru (fungsional). Tes W2 lama memeriksa `mutation.state.variables` — bermakna (gagal sebelum perbaikan), tetapi tidak memeriksa tempat lain. Ditambah tes putaran 2 (di bawah). |
| `Switch.tsx` | AMAN | tombol `type="button"` `role="switch"`, tanpa form/rahasia. |
| `AgentRow` (Switch "Ikut pembagian" / "Tersedia") | AMAN | hanya `endpoints.workspace.updateAgent(userId, { excluded } / { available })`; penegakan peran di server (review backend jam kerja). |
| `AvailabilityToggle.tsx` | AMAN | tetap hanya `{ available }` diri sendiri; `aria-label`/`title` dari teks i18n, tanpa data pengguna lain. |
| `ContactPanel.tsx` | AMAN | nama profil kini berlabel "dari <channel>"; alamat pengirim channel Email (`:204-206`) dirender sebagai teks (`EmailText`, tanpa `href`/`mailto:`). |
| `EmailMessage.tsx` | AMAN | iframe tetap `sandbox=""` + `referrerPolicy="no-referrer"` + `srcDoc` (`:110-118`); hanya ditambah label teks. Tes statis "iframe srcDoc selalu sandbox" & tes 9 vektor XSS tetap lulus. |
| Dependensi | AMAN | `b785c4f` tidak mengubah `package.json`/lockfile; `pnpm audit --prod`: *No known vulnerabilities found*. |

### Info (putaran 2)

6. **Residu UX W1**: setelah Batal di dialog identitas atau galat server, isian token/password
   kembali KOSONG tanpa keterangan. Bila Admin lalu menekan Simpan lagi tanpa mengetik ulang, hanya
   isian non-rahasia yang terkirim dan UI menampilkan "Tersimpan". Berbeda dengan W1 asli (gagal
   tanpa aksi pengguna), di sini pengguna sudah melihat batal/galat dan isian terlihat kosong — bukan
   celah. Saran (`frontend`): pesan singkat "Isi ulang token/password baru" di atas form setelah
   batal/galat bila sebelumnya ada rahasia yang diganti.
7. **Alamat pengirim email di kolom "Email" kontak** (`ContactPanel.tsx:204-206`) berasal dari
   header `From` yang bisa dipalsukan; label verifikasi pengirim (`fail` = peringatan keras) ada di
   gelembung pesan, bukan di panel. Pertimbangkan keterangan "dari channel Email" seperti nama
   profil.

### Tes penjaga baru (putaran 2)

`apps/web/src/features/security-review-web-kanal-jam-kerja.test.tsx` (+5 `it`, total 18, 0
`it.fails`). Pemindai baru `hookStateContains` menyusuri pohon fiber React AKTIF (`stateNode.current`)
dan memeriksa nilai SETIAP hook (`useState`/`useRef`/…), jadi `useRef` yang tidak dikosongkan pasti
tertangkap; kontrol positif: saat dialog identitas terbuka (dan setelah password ditolak) pemindai
MENEMUKAN token di `pendingBody` — membuktikan pemeriksaan "tidak ada" setelahnya tidak tautologis.
- W1 sukses: token baru & password konfirmasi tidak ada di hook, cache Query/mutasi, storage,
  console, HTML, nilai isian;
- W1 password salah → Batal: token dipertahankan selama dialog terbuka, lalu dibuang dari ref;
  isian token kosong; password salah juga tidak tertinggal;
- W1 server 500 setelah konfirmasi: galat tampil, token & password dibuang dari ref dan isian;
- W2: body membawa `confirmation`, lalu password tidak ada di hook/cache/storage/console/DOM dan
  `MutationCache` kosong;
- Hapus channel lain: `DELETE` body `{ password, code }`, header `x-csrf-token` + JSON, password tidak
  di path/query maupun `router.state.location`, tidak tertinggal di hook/cache/storage/DOM.

### Hasil perintah (putaran 2)

| Perintah | Hasil |
|---|---|
| `vitest run src/features/security-review-web-kanal-jam-kerja.test.tsx` | 18 lulus |
| `vitest run src/features/channels src/features/workspace` | 8 berkas, 80 lulus |
| `eslint` + `prettier --check` berkas tes | bersih |
| `tsc --noEmit -p apps/web` (berkas tes) | tanpa galat |
| `pnpm audit --prod` | tidak ada kerentanan |
