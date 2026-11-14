# Review Keamanan — Fase 1 butir 6: manajemen pengguna, sesi aktif, audit log (API)

- Tanggal: 2026-11-14
- Peninjau: agent `security`
- Cakupan: commit `4141fcd`. `packages/shared/src/{team,audit}.ts`, `apps/api/src/modules/team/**` (termasuk
  `lock-state.ts`), `modules/two-factor/{enrollment-window,two-factor.service,two-factor.repo}.ts`, `modules/audit/**`,
  `modules/sessions/**`, perubahan di `auth.service.ts`, `session.repo.ts`, `invitations.*`, `password-reset.service.ts`,
  worker `apps/worker/src/queues/email.ts`, `packages/core/src/{queues.ts,mail/templates.ts}`, migrasi `0006`, `0007`.
- Acuan: `CLAUDE.md`, `docs/SECURITY.md` §1–2, §10, `docs/PRD.md` §4, `docs/KONTRAK-API-AUTH.md` bagian "Manajemen
  pengguna, sesi aktif & audit log", `docs/DECISIONS.md` (baris 2026-11-14 terakhir), review
  `2026-11-14-fase1-undangan-reset.md` (R2.2, R3, G.1–2) dan `2026-11-14-fase1-rbac.md` (R1, Info 6).
- Model ancaman: penyerang memegang satu akun CS yang dibobol (atau cookie sesi Admin/Owner tanpa password/2FA,
  atau akun Admin lengkap) dan ingin menaikkan wewenang, mengambil alih akun lain, bertahan di sistem, atau
  memakai nomor perusahaan untuk spam/penipuan.
- Tes baru: `apps/api/src/security-review-fase1-tim-audit.test.ts` — 5 penjaga regresi (`it`) dan 5 celah
  terbuka (`it.fails`, T1–T5). Setiap `it.fails` sudah dipastikan gagal karena alasan yang dimaksud (dijalankan
  tanpa `.fails`: T1/T2/T5 `expected 200 not to be 200`, T3 `expected [ 500 ] to deeply equal []`, T4
  `expected 200 to be 403`). Balapan dibuat deterministik dengan kunci baris/advisory lock milik tes, bukan
  dengan untung-untungan waktu.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang. Lapisan utamanya kuat:

- **Eskalasi tertutup.** Admin tidak bisa memberi peran Admin, tidak ada jalan menjadikan orang Owner (Zod 400 +
  CHECK DB), diri sendiri selalu 403, dan Admin tidak bisa menyentuh Owner atau Admin lain di semua 11 endpoint.
- **Konfirmasi ulang identitas** benar-benar memakai password + kode **pelaku**. Kredensial sasaran atau campuran
  ditolak. Pemegang cookie curian tanpa password hanya mendapat 5 tebakan per 15 menit, lalu 429. Kode salah ikut
  ember langkah kedua yang sama.
- **IDOR lintas organisasi**: semua `:userId`/`:sessionId` tersaring organisasi (dan pengguna untuk sesi).
- **Pencabutan lengkap**: sesi, tantangan 2FA, rahasia tertunda, token akun (nonaktif), dan undangan terbitan
  (R2.2) semuanya dicabut. Kode cadangan dibuang saat atur ulang 2FA.
- **R3** tidak bisa dipotong lewat atur ulang password (diuji) dan tidak bisa mengunci instalasi dari Owner.
- **Audit** tersaring ulang saat dikirim (diuji dengan baris "penulis lupa"), dan CSV aman dari formula injection.

Yang tersisa adalah empat temuan **Rendah**. Dua di antaranya (R1, R2) ada di area yang diminta dicek ulang:
pemeriksaan ulang di dalam transaksi dan advisory lock Owner terakhir. Keduanya nyata dan bisa direproduksi,
tetapi butuh balapan dengan aksi Owner yang sah.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Pemeriksaan ulang di transaksi memakai **peran sasaran basi** dan tidak memeriksa ulang **peran yang diberikan**: Admin bisa mengatur ulang 2FA orang yang baru dinaikkan menjadi Admin; Owner yang baru diturunkan masih bisa memberi peran Admin (T1, T2) | Sekarang (±30 baris) |
| R2 | Rendah | Dua Owner saling menurunkan bersamaan → **deadlock Postgres → 500**, bukan 409/403. Invarian "≥ 1 Owner" tetap aman. Tes lama tidak menangkapnya (T3) | Sekarang (urutan kunci) |
| R3 | Rendah | `GET /audit-logs/export` bisa dipicu **lintas situs** (navigasi tingkat atas + cookie `SameSite=Lax`): CSV berisi data pribadi jatuh ke folder Unduhan Admin, jatah 10/jam terpakai, entri `audit.exported` palsu (T4) | Sekarang (wajib header CSRF) |
| R4 | Rendah | Mengeluarkan SATU sesi sendiri tanpa konfirmasi: cookie lama yang dicuri bisa terus mengusir sesi baru pemiliknya (T5) | Sebelum produksi |
| Info 1–14 | Info | Lihat bagian D | — |

---

## A. Verifikasi hal yang diakui/diminta backend

| Klaim / permintaan | Penilaian | Bukti |
|---|---|---|
| Admin melihat detail Owner/Admin lain (terakhir masuk, status 2FA, jumlah sesi) tanpa bisa mengelola | **Dapat diterima** (Info 1). Tidak ada data rahasia, `canManage: false`, `assignableRoles: []`. Sesi Owner tidak bisa dibuka Admin (403) | `team.service.ts:177-211`, `:657-661` |
| Buka kunci langkah kedua memberi penebak 5 percobaan baru | **Dapat diterima** (Info 2). Tiap buka kunci butuh password + TOTP Owner/Admin dan diaudit. Peluang per buka kunci ≈ 5 × 3 / 10⁶ ≈ 1,5·10⁻⁵ | `lock-state.ts:174-183` |
| Lewat batas R3, sesi pendaftaran dengan rahasia tertunda masih bisa konfirmasi ≤ 30 menit | **Dapat diterima** (Info 3). Sesi itu terbit sebelum batas, terikat sesi + UA + IP/64, dan email "2FA aktif" ke Owner/Admin tetap terkirim | `two-factor.service.ts:1023-1050` |
| `lockRef` di metadata audit dan tampil di `GET /audit-logs` | **Dapat diterima** (Info 4). Isinya `sha256(...)` terpotong 40 hex dari email + kunci IP, atau dari kunci akun + `sha256(device|token)`. Tidak bisa dibalik ke token perangkat dan hanya berguna bagi yang memegang Redis | `auth.service.ts:245,306` |
| CSV injection: awalan `'`, sel selalu dikutip, karakter kendali dibuang | **Benar.** `^[\s"']*[=+\-@\t\r]` juga menangkap baris baru di depan (`\s`). Kunci di kolom Rincian berasal dari kode | `audit-view.ts:297-303` |
| Kursor audit | **Benar.** Regex ketat (mikrodetik + UUID), parameter terikat, selalu ditambah saringan organisasi. Kursor rakitan hanya bergerak di organisasi sendiri | `audit.repo.ts:39-52,81-83,115` |
| Pemeriksaan ulang wewenang pelaku di dalam transaksi | **Sebagian.** Peran + status pelaku dibaca ulang `FOR SHARE` (benar, diuji). Tetapi peran **sasaran** yang dipakai masih yang dibaca sebelum transaksi, dan peran yang **diberikan** tidak dicek ulang → **R1** | `team.service.ts:265-281`, `team.repo.ts:158-253` |
| Advisory lock Owner terakhir | **Invarian aman, urutan kunci salah.** Tidak pernah 0 Owner, tetapi yang kalah bisa 500 karena deadlock → **R2** | `team.service.ts:284-291,395-396`, `team.repo.ts:78-100` |
| Penyaringan ulang metadata audit di respons | **Benar** (tes baru: `password`, `accessToken` di baris lama tersensor di daftar DAN CSV) | `audit-view.ts:253-266` |
| Join nama target dibatasi organisasi | **Benar.** Join pelaku dan target sama-sama mensyaratkan `organization_id` sama, dan target hanya untuk `target_type = 'user'` | `audit.repo.ts:103-114` |

## B. Hasil fokus tambahan

| Fokus | Hasil |
|---|---|
| Admin → Admin/Owner lewat ubah peran | Tertutup: 403 `team.manage.assign_role` (diaudit), `owner` → 400 (tes baru + `team.integration`) |
| Ubah peran diri sendiri lewat jalur lain | Tertutup: semua endpoint tim 403 `team.manage.self`. Jalur undangan tidak bisa mengenai akun yang sudah ada |
| Race dua aksi kelola | Pelaku yang baru diturunkan tertolak (benar). Sasaran yang berubah peran tidak dicek ulang → R1. Owner vs Owner → R2 |
| IDOR `:userId`/`:sessionId` | Tertutup: `findTeamUser`, `revokeSessionOfUser`, dan `listActiveSessions` memfilter organisasi + pengguna. Sesi Owner tidak bisa dicabut lewat path pengguna CS (404) |
| Konfirmasi ulang identitas: dilewati? brute force? ember 2FA? | Tidak bisa dilewati (sesi pendaftaran tidak bisa mencapai rute tim). Password: 5/15 menit per pelaku → 429 (tes baru). Kode: ember langkah kedua yang sama; kode salah ke-5 mengunci login pelaku 15 menit + email |
| Pencabutan sesi lengkap | Ubah peran: sesi + tantangan + rahasia tertunda + undangan di luar peran baru. Nonaktif: + token reset/verifikasi + SEMUA undangan. Atur ulang 2FA: + kode cadangan + langkah terakhir, cookie perangkat lama batal karena `totpEnabledAt` baru. Cookie perangkat tidak memotong 2FA (hanya ember), jadi tidak perlu dicabut |
| R3: memotong 2FA? mengunci instalasi? | Tidak memotong (atur ulang password → tetap 403, tanpa sesi; tes baru). Owner hasil setup tanpa batas; batas Owner lain hanya ditegakkan bila ada Owner ber-2FA lain. Sisa risiko penguncian operasional: Info 12 |
| Audit: rahasia, ekspor, label, DoS, enumerasi | Rahasia tersaring dua kali. Label lewat `Object.hasOwn`. Ekspor 10/jam/pengguna, maks. 10.000 baris. Daftar maks. 200/halaman. Email tak terdaftar hanya tersamar. Satu celah: ekspor lintas situs → R3 |
| Sesi aktif: IP tersamar untuk pengguna biasa? | Ya. Daftar sesi sendiri dan daftar sesi pengguna lain sama-sama `/24` atau 3 grup IPv6, dan UA diringkas. IP lengkap hanya di audit (Owner/Admin) |

---

## C. Temuan

### R1 — Rendah — Pemeriksaan ulang di transaksi memakai keadaan sasaran basi dan tidak memeriksa ulang peran yang diberikan

**Bukti.**
- Sasaran dibaca di LUAR transaksi (`loadManageable`, `team.service.ts:376,443,488,520,601,639,664,682`). Di dalam
  transaksi, `assertActorStillAuthorized(tx, auth, target.role, …)` (`:395,448,493,531,613,685`) memeriksa peran
  pelaku yang segar terhadap peran sasaran yang **lama**.
- Pembaruan bersyarat hanya menjaga keadaan aksi itu sendiri, bukan peran: `disableUser` (`team.repo.ts:158-176`,
  `disabled_at is null`), `resetUserTwoFactor` (`:208-232`, `totp_enabled_at is not null`), `reopenTwoFactorEnrollment`
  (`:235-253`), `enableUser` (`:182-202`). Hanya `updateUserRole` yang bersyarat `role = expectedRole`.
- `assertActorStillAuthorized` hanya menguji `canManageRole` (`team.service.ts:272`). `assignableRoles(actor.role)`
  untuk `input.role` hanya dicek sebelum transaksi (`:377`).
- `unlock` (`:638-655`) dan `revokeSession` (`:663-679`) tidak memeriksa ulang sama sekali.

**Reproduksi (deterministik).**
- **T1:** Admin mengatur ulang 2FA seorang Supervisor. Tepat saat `UPDATE` menunggu kunci baris, "Owner" menaikkan
  Supervisor itu menjadi Admin → 200. Admin baru saja mengatur ulang 2FA Admin lain, padahal matriks melarangnya.
- **T2:** Owner kedua memberi peran Admin kepada CS. Tepat saat `lockActor` menunggu, Owner pertama menurunkannya
  menjadi Admin → 200. Seorang Admin baru saja menerbitkan Admin.

**Dampak.** Pelanggaran matriks kelola terjadi tepat pada skenario yang dimaksud pemeriksaan ulang ini (Owner
menurunkan Admin yang dicurigai, Admin bertindak serentak). Rendah karena butuh balapan selebar milidetik dengan aksi
Owner yang sah. Pelaku juga sudah lolos konfirmasi password + TOTP, dan atur ulang 2FA saja belum memberi akses
(password sasaran tetap perlu). Hasilnya juga tercatat di audit dan email ke Owner.

**Perbaikan.** Satu helper untuk semua aksi kelola, dipanggil paling awal di transaksi:
```ts
async function lockManaged(tx, auth, target, context, assignRole?: InvitableRole) {
  await lockOwnerChanges(tx, auth.organizationId);           // lihat R2: SELALU dulu
  const actor = await lockActor(tx, auth.organizationId, auth.user.id);
  const fresh = await lockTarget(tx, auth.organizationId, target.id); // SELECT … FOR UPDATE
  if (!fresh || fresh.role !== target.role || fresh.disabledAt?.getTime() !== target.disabledAt?.getTime())
    throw conflict(CHANGED_MESSAGE);
  if (!actor || actor.disabledAt || !canManageRole(actor.role, fresh.role) ||
      (assignRole && !assignableRoles(actor.role).includes(assignRole)))
    await forbidByRule(…);
}
```
Pakai juga di `unlock` dan `revokeSession`. Pertahanan tambahan yang murah: beri `eq(users.role, expectedRole)` pada
`disableUser`/`enableUser`/`resetUserTwoFactor`/`reopenTwoFactorEnrollment`. Setelah diperbaiki, hapus `.fails` T1/T2.

### R2 — Rendah — Dua Owner saling menurunkan bersamaan berakhir deadlock (500)

**Bukti.** Di `changeRole`/`disable`, urutannya `lockActor` (`FOR SHARE` baris pelaku, `team.repo.ts:78-90`) lalu
`lockOwnerChanges` (advisory lock, `team.repo.ts:96-100`, dipanggil di `team.service.ts:285`). A memegang share
baris A lalu advisory, kemudian `UPDATE` baris B menunggu share milik B. B memegang share baris B lalu menunggu
advisory milik A. Hasilnya `40P01 deadlock detected` (log: `lockOwnerChanges … deadlock detected`) dan jawaban
`500 INTERNAL_ERROR`. Tanpa rekayasa, ronde serentak menghasilkan 500 pada sekitar 4 dari 6 percobaan. T3 membuatnya
deterministik. Tes lama `team.integration.test.ts:340-361` hanya memeriksa `not.toBe(200)`, jadi 500 lolos.

**Dampak.** Invarian aman: transaksi yang dibatalkan tidak mengubah apa pun, dan Owner aktif tetap ≥ 1 (diperiksa
di T3). Kerugiannya hanya kontrak dilanggar (409/403 yang dijanjikan menjadi 500), log error palsu, dan, saat alarm
Fase 4 ada, alarm "kesalahan server". Tidak bisa dipicu Admin (tidak bisa mengelola Owner).

**Perbaikan.** Ambil advisory lock organisasi **sebelum** kunci baris apa pun, di SETIAP transaksi kelola
(organisasi tunggal, aksi jarang, jadi biayanya nol). Dengan begitu semua aksi kelola berjalan berurutan, dan yang
kalah melihat peran barunya (403 `team.manage.role` atau 409). Ini menyatu dengan helper R1. Perketat tes lama:
`expect([403, 409]).toContain(statuses[1])`. Hapus `.fails` T3.

### R3 — Rendah — Ekspor audit bisa dipicu lintas situs

**Bukti.** Hook auth hanya memeriksa `Origin` dan CSRF untuk metode tidak aman (`auth.hook.ts:36,73-79,101`).
`GET /audit-logs/export` (`audit.routes.ts:208-231`) punya efek samping: memakai jatah 10/jam
(`audit.service.ts:139-144`) dan menulis `audit.exported` (`:156-168`). Cookie sesi `SameSite=Lax` ikut pada
navigasi tingkat atas. T4: permintaan dengan `Sec-Fetch-Site: cross-site`, tanpa `Origin`, hanya cookie → 200 +
CSV + entri audit.

**Dampak.** Tautan di pesan pelanggan (input tidak tepercaya; Owner/Admin juga membaca inbox mulai Fase 2) atau di
halaman mana pun bisa membuat browser Admin mengunduh audit log (email, IP lengkap, nama: data pribadi menurut UU
PDP) ke folder Unduhan. Ini berbahaya di komputer bersama. Sepuluh navigasi menghabiskan jatah ekspor selama satu
jam dan mengisi audit dengan "Audit log diekspor" yang bukan dilakukan Admin. Penyerang tidak bisa membaca isinya,
jadi levelnya Rendah.

**Perbaikan.** Web memang mengunduh lewat `fetch` (kontrak), jadi wajibkan header CSRF untuk rute ini. Contohnya
penanda `config: { access: VIEW, csrf: 'always' }` yang membuat hook memeriksa `X-CSRF-Token` walau GET, atau tolak
`Sec-Fetch-Site` selain `same-origin`. Jadikan pola untuk setiap GET yang menulis atau memakai jatah (mis. ekspor
kontak Fase 3). Hapus `.fails` T4.

### R4 — Rendah — Mengeluarkan satu sesi sendiri tanpa konfirmasi: pencuri cookie bisa mengusir pemiliknya

**Bukti.** `sessions.service.ts:56-76`: `DELETE /auth/sessions/:sessionId` cukup sesi + CSRF, untuk sesi milik
sendiri mana pun. T5: cookie sesi LAMA (dicuri dari perangkat CS, tanpa password) mengeluarkan sesi BARU yang dibuat
pemilik saat masuk ulang untuk mengusir pencuri → 200.

**Dampak.** Pencuri cookie memang sudah memegang akun selama cookienya hidup. Tambahan kerugiannya: ia bisa
memantau `GET /auth/sessions` dan langsung mengeluarkan setiap sesi baru pemilik sebelum pemilik sempat menekan
"Keluarkan semua sesi lain" (yang butuh password). Pemilik masih punya jalan keluar, yaitu atur ulang password
(mencabut semua sesi), jadi levelnya Rendah. Ini juga relevan untuk akun CS yang dibobol: pencuri ingin bertahan
selama mungkin.

**Perbaikan.** Mengeluarkan sesi yang **lebih baru** dari sesi pemanggil (`created_at` > `created_at` sesi ini)
wajib konfirmasi identitas (`{ password, code? }` di body, seperti `revoke-others`). Mengeluarkan sesi yang lebih
lama tetap satu klik, supaya pemilik yang masuk ulang bisa langsung mengusir cookie lama. Web: dialog konfirmasi
hanya untuk kasus itu. Opsional: email "sesi dikeluarkan dari perangkat lain" ke pemilik. Hapus `.fails` T5.

---

## D. Info (tanpa tindakan wajib)

1. **Admin melihat detail Owner/Admin lain.** Sesuai PRD (daftar tim terlihat). Ini sedikit membantu pengintaian
   oleh Admin yang dibobol (siapa belum ber-2FA, siapa lewat batas), tetapi tidak membuka aksi apa pun.
2. **Buka kunci = 5 tebakan baru.** Usul murah: hitungan kode 2FA salah jangka panjang per akun (mis. 20/24 jam)
   yang TIDAK direset `unlock`, ditambah email ke sasaran "kunci akunmu dibuka oleh {nama}". Rekayasa sosial
   ("tolong buka kunci saya") jadi tidak bisa diulang tanpa batas.
3. **Konfirmasi pendaftaran ≤ 30 menit setelah batas R3**: diterima. Jendelanya sempit, terikat sesi/klien, dan
   dideteksi lewat email ke Owner/Admin.
4. **`lockRef` di layar audit**: bukan rahasia. Kalau dianggap bising, `publicMetadata` bisa membuangnya dari
   respons (tetap tersimpan untuk `lock-state`).
5. **Admin mencabut satu sesi pengguna lain tanpa konfirmasi**: dampaknya hanya mengeluarkan orang. Sesuai kontrak.
6. **Admin yang dibobol (lengkap dengan TOTP) menurunkan/menonaktifkan banyak Supervisor/CS** hanya muncul sebagai
   `info` di ringkasan keamanan, tanpa email. Usul: `role_changed`/`user_disabled` oleh selain Owner dinaikkan
   menjadi `warning`. Owner aktif lain juga bisa diberi email ringkas, sejalan dengan pola review RBAC S1.
7. **Tebakan password konfirmasi dari cookie curian** mengunci konfirmasi milik Admin asli selama 15 menit (429).
   Ini gangguan kecil dan bukan jalan masuk.
8. **Kode `TWO_FACTOR_ENROLLMENT_EXPIRED` hanya keluar setelah password benar**, jadi bukan oracle enumerasi.
   Penebak yang berhasil menebak password akun yang lewat batas memang tahu password-nya benar. Ia masih terhalang
   sampai pendaftaran dibuka lagi, lalu kembali ke risiko TOFU yang sudah diakui (email "2FA aktif").
9. **Owner vs Owner tetap tidak bisa menghabiskan Owner**, juga saat deadlock (R2). Advisory lock + hitungan di
   dalam transaksi sudah benar.
10. **Ekspor:** 10.000 baris digabung di memori (beberapa MB), 10/jam per pengguna. Aman untuk satu organisasi.
    Kalau audit Fase 2+ membesar, pertimbangkan streaming.
11. **Migrasi 0007** langsung menutup pendaftaran Admin/Supervisor lama yang belum ber-2FA dan dibuat > 72 jam lalu.
    Ini memang tujuannya. Sebutkan di catatan rilis/`balesin update` supaya Owner tahu harus "Buka lagi pendaftaran".
12. **Penguncian operasional**: Owner B (2FA diatur ulang, batas lewat) tertutup selama Owner A ber-2FA. Bila A
    kehilangan autentikator **dan** kode cadangan, tidak ada yang bisa masuk penuh. Jalur pemulihan CLI server
    (review undangan Info 11, devops) menjadi wajib sebelum produksi.
13. **Tanpa `BALESIN_MASTER_KEY`** (opsional di `config.ts:44,157`) peran wajib tidak bisa mendaftar 2FA, tetapi
    batas 72 jam tetap berjalan, sehingga Admin/Supervisor undangan tertutup setelah 72 jam. Usul: production
    menolak start tanpa master key (devops), atau `assertEnrollmentOpen` dilewati bila `!available`.
14. **Pemberitahuan atur ulang 2FA** hanya ke Owner lain. Bila Owner tunggal mengatur ulang 2FA Admin, hanya
    sasaran yang diberi tahu. Ini sesuai kontrak (pelakunya Owner).

---

## E. Hasil `pnpm audit`

`pnpm audit`: 2 **moderate** (esbuild lewat `drizzle-kit`, minimatch lewat `eslint`), 0 tinggi/kritis. Keduanya
dependensi pengembangan saja dan sama dengan review sebelumnya. `pnpm audit --prod`: **No known vulnerabilities
found**. Commit ini tidak menambah dependensi.

## F. Tes

- Tes area keamanan yang sudah ada (team, audit, sessions, two-factor, password-reset, invitations,
  `rbac-matrix`, `security-review-fase1-{rbac,undangan-reset,2fa,2fa-putaran2}`): **16 berkas, 205 tes lulus**.
- Berkas baru `apps/api/src/security-review-fase1-tim-audit.test.ts`: **5 lulus + 5 expected fail** (dijalankan 3×,
  stabil). Lint, Prettier, dan `tsc` bersih.
  - Penjaga: Admin tidak bisa menaikkan siapa pun/diri sendiri/Admin lain di 5 endpoint. Konfirmasi memakai
    kredensial PELAKU. Tebakan password konfirmasi 5 → 429. R3 tidak terpotong lewat atur ulang password. Audit
    lintas organisasi kosong dan metadata rahasia baris lama tersensor di daftar + CSV.
  - `it.fails`: T1/T2 (R1), T3 (R2), T4 (R3), T5 (R4).
- Uji dijalankan dengan Redis DB 12 (`REDIS_URL_TEST`) dan database sementara per berkas buatan harness (dihapus
  otomatis). Stack E2E/kritikus tidak disentuh.

## G. Catatan untuk butir berikutnya

1. **Web layar Tim/Audit/Sesi** (review frontend): isian password + kode konfirmasi tidak masuk cache Query/storage.
   Ekspor lewat `fetch` + Blob (setelah R3: kirim header CSRF). Tombol "Keluarkan" untuk sesi lebih baru memakai
   dialog konfirmasi (R4). Label aksi audit yang tidak dikenal ditampilkan sebagai teks (bukan HTML).
2. **Fase 2+**: setiap GET yang menulis/memakai jatah (ekspor kontak, unduh media) memakai pola CSRF-wajib dari R3.
3. **Devops**: jalur pemulihan Owner lewat CLI (Info 12), production wajib `BALESIN_MASTER_KEY` (Info 13), catatan
   rilis migrasi 0007 (Info 11).
