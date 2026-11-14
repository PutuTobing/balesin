# Review Keamanan — Fase 1 butir 4: undangan, atur ulang password, verifikasi email, template bermerek

- Tanggal: 2026-11-14
- Peninjau: agent `security`
- Cakupan: commit `5affb46` (backend). `apps/api/src/modules/{invitations,password-reset,email-verification,account-tokens}/**`,
  `apps/api/src/modules/email-settings/email-template-preview.ts`, `apps/api/src/http/background-tasks.ts`,
  perubahan `two-factor` (pengikatan UA + IP untuk pakai ulang rahasia tertunda, `totp_pending_issued_at`,
  email 2FA-aktif ke Owner/Admin), `auth.service`/`trusted-device` (`password_changed_at`),
  `apps/worker/src/queues/email.ts`, `packages/core/src/{mail/templates,mail/smtp,queues}.ts`,
  `packages/shared/src/{invitations,password-reset,email-verification,email-templates,links,fields}.ts`,
  migrasi `packages/db/drizzle/0004_undangan_reset_verifikasi_email.sql`. `apps/web` dan `e2e` di luar cakupan.
- Acuan: `CLAUDE.md` (tidak ada pendaftaran publik), `docs/SECURITY.md` §1–3, `docs/KONTRAK-API-AUTH.md`
  (bagian tautan bertoken, Undangan, Atur ulang password, Verifikasi email, Pratinjau template),
  `docs/DECISIONS.md` (5 baris 2026-11-14 terakhir), review `2026-11-14-fase1-2fa.md` (R5/R7, Info 17, G.3)
  dan `2026-11-13-fase1-setup-login.md`.
- Tes baru: `apps/api/src/security-review-fase1-undangan-reset.test.ts`, berisi 10 penjaga regresi dan
  2 `it.fails`.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang. Klaim backend yang diminta untuk diverifikasi terbukti
lewat pembacaan kode dan tes. Ada dua celah **Rendah** di undangan (R1, R2) yang murah ditutup, dan
keduanya sudah punya tes `it.fails`. Sisanya catatan Rendah/Info dan risiko yang memang sudah diakui.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Admin bisa membatalkan undangan **Admin** buatan Owner yang sudah kedaluwarsa, caranya dengan membuat undangan baru untuk email yang sama | Sekarang (±3 baris) |
| R2 | Rendah | Undangan tetap bisa diterima setelah pengundangnya dinonaktifkan (atau diturunkan perannya) | Sekarang di sisi terima; wajib sebelum butir 6 |
| R3 | Rendah | Akun ber-peran wajib 2FA yang belum mendaftar bisa diambil alih lewat kotak masuknya (reset, lalu TOFU). R5.3 belum dibangun | Butir berikutnya (sebelum produksi) |
| R4 | Rendah | Batas 3 permintaan reset/jam per email bisa dipakai orang lain untuk menghalangi pemilik akun mereset (DoS ringan) | Bila sempat |
| R5 | Rendah | Selesai reset: kegagalan Redis setelah transaksi menjawab 503 padahal password sudah berganti, dan email "password diganti" tidak terkirim | Bila sempat (murah) |
| Info 1–12 | Info | Lihat bagian C | — |

---

## A. Verifikasi klaim backend

| Klaim | Hasil | Bukti |
|---|---|---|
| Matriks undangan Owner → A/S/CS/T; Admin → S/CS/T; lainnya 403; Owner tidak bisa diundang (Zod + CHECK) | **Benar**, dengan pengecualian R1 | `packages/shared/src/invitations.ts:18-42`, `invitations.service.ts:264,364,424`, `invitations.routes.ts:145`, CHECK `0004_…sql:48`, `findInvitationByTokenHash` membuang baris `owner` (`invitations.repo.ts:312`). Tes: "eskalasi peran", "undangan Owner ditolak juga di database" |
| Kirim ulang/batalkan mengikuti aturan yang sama | **Benar** untuk rute resend/revoke. **Bocor** lewat "buat undangan baru menggantikan yang kedaluwarsa" (R1) | `invitations.service.ts:292-303` |
| Peran/email tidak bisa diubah lewat body | **Benar**. Resend tanpa skema body (body diabaikan), terima memakai `row.role`/`row.email` | `invitations.routes.ts:214-229`, `invitations.service.ts:486-491`. Tes: body `{role:'admin'}` saat resend, `{role:'owner', email:…}` saat terima |
| Token di fragment, dikirim di body; tidak pernah di payload antrean; salinan AES-GCM ber-AAD baris + generasi; worker menyusun dari `APP_URL` lalu menghapus salinan | **Benar** | `links.ts:315-320`, `token-delivery.ts:29-37,88-91`, `queues.ts` (`invitationDeliveryContext` → `subjectId = id\|sendCount`), worker `email.ts:457-472,500,547-556,587,598`. Tes "kebocoran token": `Host`/`X-Forwarded-Host` palsu tidak memengaruhi tautan; token tidak ada di log, audit, payload job, header, maupun error; hanya hash 64-hex yang tersimpan; salinan `null` setelah dipakai |
| Tanpa SMTP: tautan dikembalikan sekali ke pembuat + audit `link_shown`; reset `available:false` / 503 pesan sama | **Benar** | `invitations.service.ts:325-335,356,398-408,416`, `password-reset.service.ts:276-283` |
| Reset: waktu jawaban sama (BackgroundTasks) | **Benar** (diukur) | `password-reset.service.ts:262-286`, `background-tasks.ts:22-28`. Pengukuran lokal 80 sampel lewat `inject`: median 3,98 ms (terdaftar) vs 4,15 ms (tidak terdaftar). Permintaan berikutnya setelah keduanya: 4,25 vs 4,09 ms, masih dalam derau. Status, body (selain `requestId`), dan nama header identik, juga saat 429 (tes "enumerasi") |
| Akun ber-2FA wajib kode; ember sama dengan langkah kedua login; 3 salah → tautan hangus | **Benar** | `password-reset.service.ts:314-349`, `two-factor.service.ts` `verifySecondFactor` (flag kunci dicek dulu, `consume` ember akun/perangkat, `lock` + email di salah ke-5). `claimAccountTokenAttempt` atomik (`account-tokens.repo.ts:248-269`) |
| Semua sesi + tantangan dicabut; cookie perangkat lama batal; kunci tebakan password dilepas, kunci 2FA tidak | **Benar** | `password-reset.service.ts:353-407`, `trusted-device.ts` `deviceStillValid`, `auth.service.ts` (login) dan `two-factor.service.ts` `bucketFor` memakai `passwordChangedAt` |
| Terima undangan peran wajib-2FA → sesi pendaftaran 30 menit; rahasia tertunda dipakai ulang hanya bila UA + IP/64 sama; batas mutlak 30 menit dari `totp_pending_issued_at` | **Benar** | `invitations.service.ts:516-527` + `session.service.ts` (`kind = two_factor_enrollment`), `two-factor.service.ts` (`sameClient`, `savePendingSecret(…, fresh)`), `two-factor.repo.ts` `isPendingSecretFresh`. Nilai `NULL` dari sebelum migrasi → tidak segar (gagal-tertutup) |
| Batas laju 20/jam pengundang, 50/jam organisasi, 5/jam email tujuan; tautan tidak sah 30/15 mnt per IP; reset 10/15 mnt per IP + 3/jam per email; verifikasi 3/jam per pengguna | **Benar**. Limiter gagal-tertutup (Redis mati → 503) | `invitations.service.ts:115-131,190-210`, `token-delivery.ts:44-48`, `password-reset.service.ts:108-118`, `email-verification.service.ts:65-69`, `rate-limit.ts:90-97` |

**Pengambilalihan lewat undangan.** Email yang sudah punya akun (aktif maupun nonaktif) ditolak saat
undangan dibuat (409) dan saat diterima (410). Pemeriksaannya ada di aplikasi
(`invitations.service.ts:468`) dan juga di constraint unik `users_organization_id_email_unique`
(`:546-549`). Akun lama tidak tersentuh (diuji). Email selalu dibakukan (`trim().toLowerCase()`) dan
`z.email()` hanya menerima ASCII. Akibatnya varian huruf besar/spasi dianggap alamat yang sama, sedangkan
homoglif Kiril, `İ` Turki, dan zero-width ditolak (diuji). Terima ganda serentak: 8 permintaan menghasilkan
tepat 1 akun (`markInvitationAccepted` bersyarat token + terbuka + belum kedaluwarsa, di transaksi yang sama
dengan `INSERT users`). Lintas organisasi: semua query manajemen memfilter `organization_id`, dan pencarian
berdasarkan hash token membawa organisasinya sendiri.

**Reset tidak memotong 2FA.** Tanpa kode → 400. Kode salah → ember 2FA akun, lalu tautan hangus di salah
ke-3. Saat langkah kedua terkunci → 429. Kode cadangan baru dibakar di transaksi yang sama dengan
`consumeAccountToken`. Selesai serentak 6× dengan satu token menghasilkan tepat 1 sukses (diuji). Token
salah tujuan (reset ↔ verifikasi ↔ undangan) → 410 dan tidak menghabiskan token yang benar (diuji).

**Template & pratinjau.** Semua nilai luar lewat `escapeHtml`. Subjek dan nama lewat `singleLine`. `href`
lewat `assertHttpUrl` + escape. Logo hanya `cid:` atau `data:image/(png|jpeg|webp)`. Warna hanya
`#rrggbb` (`templates.ts:40-53,108-140,162-225`). Tes memasukkan `"><script>…<img onerror>` + CRLF ke nama
organisasi, nama produk, dan nama pengundang, ditambah `logoSrc: javascript:` dan warna `red;background:url(…)`.
Hasilnya, baik email langsung maupun respons pratinjau: tidak ada tag mentah, tidak ada `javascript:`/`url(`,
subjek tanpa CR/LF. Email sungguhan di Mailpit dari tes worker juga ter-escape (`PT &lt;Maju&gt; Jaya`).
Header `Subject` aman. Pratinjau khusus Owner (`email-settings.routes.ts:34`), tanpa token sungguhan.

---

## B. Temuan

### R1 — Rendah — Admin bisa "mengelola" undangan Admin lewat jalur buat-menggantikan-yang-kedaluwarsa

**Bukti.** `invitations.service.ts:263-303`. `create` hanya memeriksa `canInviteRole(actor, input.role)`
untuk peran **baru**. Bila sudah ada undangan terbuka yang kedaluwarsa untuk email itu (`existing.expired`,
`:275-282`), undangan itu dibatalkan di `:292-303` tanpa memeriksa `canInviteRole(actor, existing.role)`.
Rute resend/revoke (`:364`, `:424`) justru memeriksanya.
Tes `R1` (`security-review-fase1-undangan-reset.test.ts:132`): Owner mengundang Admin, undangan
kedaluwarsa, Admin kirim ulang → 403 (benar), lalu Admin membuat undangan CS untuk email yang sama → 201
dan undangan Admin Owner ter-`revoked`. Gagal dengan `expected 2026-11-14T03:18:30.217Z to be null`.

**Dampak.** Bukan eskalasi: Admin tidak pernah mendapat undangan Admin. Ini melanggar aturan "kirim ulang/
batalkan mengikuti aturan yang sama" (`DECISIONS.md`, `KONTRAK-API-AUTH.md`). Admin bisa menggagalkan
penunjukan Admin oleh Owner dan menggantinya dengan undangan CS ke orang yang sama, sehingga Owner yang
belakangan menekan "kirim ulang" mendapati undangannya hilang.

**Perbaikan.** Di `create`, sebelum menggantikan: `if (existing && !canInviteRole(auth.user.role,
existing.role)) throw forbiddenRole(auth.user.role);`. Sebaiknya letakkan sebelum `consumeInviteQuota`
supaya kuota tidak terpakai. Hapus `.fails` pada tes R1 setelah diperbaiki.

### R2 — Rendah — Undangan dari pengundang yang dinonaktifkan/diturunkan tetap berlaku

**Bukti.** `findInvitationByTokenHash` (`invitations.repo.ts:287-311`) hanya menggabungkan `inviter` lewat
`joinInviter()`, tanpa memeriksa `inviter.disabled_at` maupun perannya sekarang. `accept`
(`invitations.service.ts:455-562`) tidak memeriksa ulang `canInviteRole(inviter.role, row.role)`. Worker
juga mengirim undangan dari pengundang nonaktif (`apps/worker/src/queues/email.ts:444-450`).
Tes `R2` (`security-review-fase1-undangan-reset.test.ts:170`): Admin membuat undangan Supervisor (tautan
disalin), akun Admin dinonaktifkan di DB, lalu undangan diterima → 201. Gagal dengan
`expected 201 to be 410`.

**Dampak.** Model ancaman: akun Admin dibobol. Penyerang membuat beberapa undangan Supervisor/CS ke alamat
miliknya (tanpa SMTP, tautan langsung didapat). Owner yang menonaktifkan Admin itu tidak otomatis menutup
undangan-undangannya. Selama 72 jam undangan itu masih bisa menjadi akun baru, kecuali Owner menyadari dan
membatalkannya satu per satu. Belum terjangkau lewat produk karena belum ada endpoint nonaktifkan/ganti
peran (butir 6). Kalau pemeriksaan ini tidak ada saat butir 6 dibangun, jalannya terbuka.

**Perbaikan (keduanya).**
1. **Sekarang, di sisi terima (pertahanan berlapis):** di `findInvitationByTokenHash` ambil juga
   `inviter.disabledAt` dan `inviter.role`. Di `publicLookup`, perlakukan `disabledAt !== null ||
   !canInviteRole(inviter.role, row.role)` sebagai `revoked` (410 + audit `invitation.rejected` dengan
   alasan `inviter_unavailable`). Lakukan hal yang sama di worker `sendInvitation`, lalu `settle('skipped')`.
   Tes R2 menguji sisi ini.
2. **Butir 6:** menonaktifkan atau menurunkan peran pengguna membatalkan semua undangan terbuka yang
   `invited_by_user_id`/`last_sent_by_user_id`-nya pengguna itu, dalam transaksi yang sama, plus audit.

### R3 — Rendah (risiko diakui) — TOFU tersisa: akun peran wajib-2FA yang belum mendaftar

**Penilaian.** Mitigasi R5 dari review 2FA kini sebagian besar ada: (1) pendaftaran menyatu dengan
penerimaan undangan; (2) email "2FA aktif" ke semua Owner/Admin lain, lengkap dengan IP/perangkat
(`two-factor.service.ts` `notifyAdministrators`, worker `sendSecurityNoticeAdmin` memeriksa ulang peran
penerima); (3) pakai ulang rahasia terikat UA + IP/64 dan dibatasi 30 menit mutlak. Yang belum ada adalah
R5.3, yaitu batas 72 jam. Admin/Supervisor yang menerima undangan tetapi menutup layar QR tetap tanpa 2FA
tanpa batas waktu. Siapa pun yang menguasai **kotak masuknya** bisa memakai reset
(`password-reset.service.ts:314`, tanpa kode karena `totpEnabledAt` `null`), masuk, lalu mendaftarkan
autentikatornya sendiri. Kontrol yang ada sekarang hanya bersifat deteksi (email ke Owner/Admin).
Rendah, karena butuh kotak masuk korban dan akunnya memang belum pernah dipakai penuh. Kalau dibiarkan
sampai produksi, levelnya naik.

**Perbaikan (butir berikutnya, sebelum produksi).** R5.3: akun ber-peran wajib dengan
`totp_enabled_at IS NULL` dan `created_at` (atau waktu naik peran) lebih dari 72 jam lalu → login dan
reset ditolak dengan pesan "minta Owner/Admin memperbarui undangan". Sebagai tambahan murah: reset
password untuk akun peran wajib yang belum mendaftar 2FA juga memberi tahu Owner/Admin.

### R4 — Rendah — Ember 3/jam per email reset bisa dihabiskan pihak lain

**Bukti.** `password-reset.service.ts:114-118,270-275`. Kuncinya hanya `sha256("reset|" + email)`, tidak
peduli IP pemintanya. Dengan 3 permintaan per jam dari IP mana saja (jatah IP 10/15 menit), penyerang
membuat pemilik akun mendapat 429 "untuk email ini" selama satu jam. Ini bisa diulang terus.

**Dampak.** Penolakan layanan ringan. Pemilik akun yang lupa password tidak bisa mereset, dan tiga email
reset sungguhan tetap masuk ke kotak masuknya. Tidak membuka keberadaan akun (perilakunya sama untuk
email tak terdaftar).

**Perbaikan (bila sempat).** Gunakan dua ember: per (email, IP/64) 3/jam untuk menolak, dan per email
misalnya 10/jam sebagai plafon global. Pilihan lain: ember per email hanya menahan **pengiriman** di
latar belakang (email tidak dikirim, jawaban tetap 202), bukan menjawab 429. Dengan begitu penyerang
tidak bisa mengamati atau menghabiskan jatah untuk mengunci pemilik. Jawaban tetap identik untuk semua
email.

### R5 — Rendah — Langkah pasca-transaksi reset bisa gagal setelah password berganti

**Bukti.** `password-reset.service.ts:353-424`. Transaksi (password, sesi, tantangan, audit) sudah
commit, lalu `limiter.clearFlag`/`reset` (`:404-407`) melempar 503 bila Redis bermasalah (`rate-limit.ts:90-97`).
Akibatnya `securityNotice('password_changed')` (`:413`) tidak pernah diantrekan.

**Dampak.** Pengguna melihat "layanan tidak tersedia" padahal password sudah berganti dan semua sesi
dicabut. Email pemberitahuan "password diganti", yang menjadi deteksi bagi korban bila reset dilakukan
orang lain, hilang.

**Perbaikan.** Antrekan `notify(...)` lebih dulu, lalu bungkus pembersihan kunci dengan `try/catch` +
`log.warn`. Kunci yang tidak terhapus hanya membuat pemilik menunggu ≤ 15 menit, dan itu tidak berbahaya.

---

## C. Info (tidak perlu tindakan sekarang)

1. **Salinan token terenkripsi tertinggal bila job tidak pernah diproses** (worker mati, job hilang di
   Redis). Baris undangan/token yang kedaluwarsa tetap menyimpan `delivery_token_encrypted`
   (`worker email.ts:202-218` hanya menghapusnya saat diproses). Tokennya sudah tidak berlaku, jadi
   risikonya kecil, dan untuk membukanya tetap perlu DB + `BALESIN_MASTER_KEY`. Saat job berkala ada:
   `UPDATE … SET delivery_token_encrypted = NULL WHERE expires_at < now()` untuk kedua tabel. Ini
   melengkapi risiko yang sudah diakui.
2. **`BackgroundTasks` gagal diam-diam.** Dua permintaan reset beruntun untuk akun yang sama bisa
   berjalan bersamaan. Yang kalah menabrak `account_tokens_live_unique` dan hanya tercatat di log
   (`background-tasks.ts:24-26`). Terlihat di tes enumerasi: 3 permintaan → 2 baris token. Tidak
   berbahaya, karena satu token tetap hidup, tetapi pengguna bisa menerima email dari permintaan yang
   lebih lama. Saat ada metrik, hitung `task` gagal per nama, atau jalankan ulang sekali bila terjadi
   unique-violation.
3. **Kanal waktu sisa** dari pekerjaan latar belakang (DB + antrean) terhadap permintaan berikutnya:
   sekitar 0,1 ms secara lokal, jauh di bawah derau jaringan. Tidak perlu tindakan.
4. **Email akun dari undangan tanpa SMTP belum terverifikasi, tetapi reset tetap dikirim ke sana**
   (`password-reset.service.ts:167-178`). Ini konsisten dengan kontrak (status verifikasi tidak
   membatasi apa pun). Kalau alamatnya salah ketik, pemilik alamat itu bisa mengambil alih akun CS/
   Teknisi tanpa 2FA. Pertimbangkan menampilkan peringatan "email belum diverifikasi" di daftar
   pengguna (butir 6).
5. **Verifikasi email bisa terpicu pemindai tautan** (Safe Links dan sejenisnya yang menjalankan JS)
   bila halaman `/verifikasi-email` langsung memanggil `verify` saat dimuat. Undangan dan reset aman
   dari ini karena halaman hanya memanggil `inspect` (tanpa efek). Karena "terverifikasi" tidak membuka
   apa pun, cukup dicatat. Bila nanti verifikasi menjadi syarat, pakai tombol "Verifikasi" alih-alih
   otomatis.
6. **Audit menyimpan email utuh** (`invitations.service.ts:322,435`), sesuai risiko yang diakui.
   Reset tak cocok sudah memakai `maskEmail`. Retensi audit sebaiknya diatur bersama retensi data
   pribadi (SECURITY.md §10).
7. **Normalisasi Unicode → ASCII:** `toLowerCase()` mengubah tanda Kelvin `K` (U+212A) menjadi `k`,
   sehingga `Kelvin@…` tersimpan dan dikirim sebagai `kelvin@…`. Tidak berbahaya (alamat hasilnya
   sama dengan yang tersimpan), tetapi perlu diingat kalau validasi email diganti.
8. **Konten nama di email sah.** Nama pengundang (bebas, satu baris) dan nama organisasi tampil sebagai
   teks di email resmi organisasi. Admin yang dibobol bisa menulis "kunjungi http://…" di namanya, dan
   klien email akan membuat tautan di versi teks. Batas laju undangan 20/50 per jam sudah membatasi
   penyalahgunaan ini. Pertimbangkan menolak `://` di `personNameSchema`.
9. **Biaya argon2id per pemegang token.** Terima undangan atau selesai reset serentak dengan token sah
   menjalankan `hasher.hash` untuk setiap permintaan sebelum yang menang ditentukan
   (`invitations.service.ts:473`, `password-reset.service.ts:351`). Hanya pemegang token yang bisa
   melakukannya, jadi bukan vektor DoS yang berarti.
10. **Percobaan kode saat langkah kedua terkunci tetap membakar jatah tautan.** `claimAccountTokenAttempt`
    (`password-reset.service.ts:321`) dipanggil sebelum `verifySecondFactor` menjawab 429. Tiga kali
    429 membuat tautan habis. Dampaknya hanya pada kegunaan; urutan bisa dibalik dengan memeriksa
    `flagTtl` sebelum mengambil jatah.
11. **Owner lupa password tanpa SMTP tidak punya jalan pemulihan**, sesuai risiko yang diakui. Untuk
    butir devops: perintah `balesin reset-owner-password` di server (butuh akses shell + `SETUP_TOKEN`
    baru), dengan audit + cabut sesi + mempertahankan 2FA.
12. **Migrasi 0004 rapi.** FK komposit `(organization_id, *_user_id)` ke `users`, `ON DELETE RESTRICT`
    untuk undangan dan `CASCADE` untuk token akun. CHECK email baku, `role <> 'owner'`, berpasangan
    `accepted_*`/`revoked_*`, tertutup sekali. Indeks unik parsial untuk undangan terbuka per email dan
    token hidup per (pengguna, tujuan). `token_hash` unik (berindeks). Kolom `users` baru nullable tanpa
    backfill. Hash token SHA-256 dari 256-bit acak dicari dengan kesetaraan DB, dan perbandingan
    waktu-konstan tidak diperlukan untuk pencarian hash dari nilai berentropi tinggi.

## D. Status catatan sebelumnya

| Catatan | Status |
|---|---|
| 2FA R5 (TOFU) mitigasi 1, 2, 4 | 1 dan 2 terpenuhi. 4 menunggu butir 6. **3 (batas 72 jam) belum** → R3 |
| 2FA R7 (cookie sesi pendaftaran curian membaca ulang rahasia) | Dimitigasi: pakai ulang hanya untuk UA + IP/64 yang sama. Klien lain memutar rahasia (QR pemilik batal, audit `rotatedReason`). Pencuri tetap bisa mendaftarkan autentikatornya sendiri, karena itu sifat sesi pendaftaran. Email ke Owner/Admin menjadi deteksinya |
| 2FA Info 17 (batas mutlak rahasia tertunda) | Terpenuhi (`totp_pending_issued_at`, 30 menit) |
| 2FA G.3 (reset membatalkan cookie perangkat lama) | Terpenuhi (`password_changed_at`, ambang dibulatkan ke atas) |
| 2FA G.4 (email keamanan memuat IP/perangkat) | Terpenuhi (`auditLogId` → worker membaca IP/UA dari audit) |
| SECURITY.md §1 undangan (acak, ter-hash, sekali pakai, 72 jam, terikat email) | Terpenuhi |
| SECURITY.md §1 reset (ter-hash, sekali pakai, 30 menit, respons sama, semua sesi dicabut) | Terpenuhi |
| CLAUDE.md "tidak ada pendaftaran publik" | Terpenuhi. Satu-satunya pembuatan akun publik adalah `accept`, dan itu butuh token undangan dari Owner/Admin |
| Tujuh path publik baru | Terdaftar di `http-units.test.ts:232-246`. Semua bertoken atau tanpa efek (`GET /auth/password-reset`). `Origin` asing → 403, body JSON wajib, batas body 16 KiB |

## E. Hasil `pnpm audit`

2 kerentanan **moderate**, 0 tinggi/kritis. Keduanya sama dengan laporan sebelumnya dan hanya ada di
dependensi pengembangan:
- `esbuild <= 0.24.2` (GHSA-67mh-4wv8-2f99) lewat `drizzle-kit`, yaitu server dev esbuild.
- `minimatch >=7 <11.0.1` (GHSA-g3hv-75wg-m249) lewat `eslint` (39 jalur), hanya untuk lint.

Commit ini tidak menambah dependensi (tidak ada perubahan `package.json`/lockfile).

## F. Tes

Dijalankan (Postgres + Redis lokal; database sementara per berkas tes, prefiks Redis acak di DB 15;
Mailpit bersama):
- `apps/api`: `src/modules/{invitations,password-reset,email-verification,two-factor,auth,email-settings}`,
  `src/http`, `src/security-review*.test.ts` → 20 berkas, **321 lulus**.
- `apps/worker` (termasuk `token-email.integration.test.ts`, kirim sungguhan ke Mailpit) → 5 berkas,
  **44 lulus**.
- `packages/core` 385 lulus · `packages/shared` 56 lulus · `packages/db` 86 lulus.
- `apps/api` typecheck bersih. Berkas tes baru lolos eslint + prettier.
- Email yang dibuat tes saya di Mailpit (11 dari worker, 1 email tes dari `email-settings`) sudah
  dihapus berdasarkan ID.

Tes baru `apps/api/src/security-review-fase1-undangan-reset.test.ts` → **10 lulus + 2 expected fail**.
Kedua `it.fails` sudah dipastikan gagal karena alasan yang dimaksud, dengan menjalankannya sementara
sebagai `it` biasa:

| Tes | Jenis | Gagal karena |
|---|---|---|
| R1 Admin tidak bisa membatalkan undangan Admin buatan Owner lewat buat-baru | `it.fails` | `expected 2026-11-14T03:18:30.217Z to be null` |
| R2 undangan dari pengundang nonaktif tidak bisa diterima | `it.fails` | `expected 201 to be 410` |
| Admin: undangan Admin 403, Owner 400; resend/terima dengan body peran/email lain tidak berpengaruh | `it` | — |
| Undangan Owner ditolak CHECK DB | `it` | — |
| Terima undangan untuk email yang sudah punya akun → 410, akun lama utuh | `it` | — |
| Email beda huruf/spasi = sama; homoglif/`İ`/zero-width → 400 | `it` | — |
| 8 terima serentak → tepat 1 akun | `it` | — |
| Reset: status/body/header identik untuk terdaftar/tidak/nonaktif, juga saat 429 | `it` | — |
| Reset: 6 selesai serentak → tepat 1 sukses | `it` | — |
| Token salah tujuan (reset ↔ verifikasi ↔ undangan) → 410, token benar utuh | `it` | — |
| Token tidak bocor (log/audit/antrean/header/error); tautan dari `APP_URL` meski `Host`/`X-Forwarded-Host` palsu | `it` | — |
| Template: HTML/CRLF di nama organisasi/produk/pengundang di-escape (email & pratinjau) | `it` | — |

Setelah R1 atau R2 diperbaiki, Vitest akan melaporkan tes `it.fails`-nya gagal. Saat itu hapus `.fails`-nya.

## G. Catatan untuk butir berikutnya

1. **Butir 6 (manajemen pengguna):** nonaktifkan/turunkan peran → batalkan undangan terbuka milik
   pengguna itu (R2.2), cabut sesi + tantangan (I.11/S2), dan tes matriks peran × endpoint undangan
   termasuk sesi terbatas.
2. **R5.3** batas 72 jam untuk peran wajib yang belum mendaftar 2FA (R3), sebelum produksi.
3. **Job berkala:** buang `delivery_token_encrypted` yang kedaluwarsa (Info 1), token akun basi
   lintas pengguna, dan tantangan 2FA kedaluwarsa (review 2FA Info 12).
4. **Web (`/undangan`, `/atur-ulang-password`, `/verifikasi-email`):** periksa saat review frontend bahwa
   fragment dibuang dengan `history.replaceState` sebelum render apa pun, token hanya ada di memori, tidak
   ada pemanggilan pihak ketiga di halaman bertoken, `link` salin-sekali tidak masuk cache Query, dan
   pratinjau memakai `<iframe sandbox="" srcdoc>` (tanpa `allow-scripts`/`allow-same-origin`) dan tidak
   pernah `dangerouslySetInnerHTML`. Verifikasi email lewat tombol, bukan otomatis (Info 5).
5. **Devops:** jalur pemulihan Owner tanpa SMTP lewat CLI server (Info 11).
