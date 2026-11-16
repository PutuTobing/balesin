# Review Keamanan — Fase 2 butir 7: penanganan percakapan (backend)

- Tanggal: 2026-11-17
- Peninjau: agent `security`
- Cakupan: commit `6d609c5` bagian butir 7. Berkas yang diperiksa:
  - `apps/api/src/modules/inbox/assignment.{routes,service}.ts`;
  - `packages/db/src/schema/conversation-events.ts` + `drizzle/0015_penanganan_percakapan.sql`;
  - `apps/api/src/modules/realtime/inbox-stream.ts` (`conversation.removed`), `packages/core/src/inbox-events.ts`
    (`previousAssigneeUserId`);
  - `apps/api/src/modules/inbox/{inbox-view,inbox.repo}.ts` (`nameSource`, `waUsername`, `firstAssignedAt`,
    `firstResponseAt`);
  - `apps/api/src/modules/contacts/contacts.repo.ts` (hapus `conversation_events`).

  Bagian rem pengiriman & media di commit yang sama dinilai sebagai "Putaran 2" di `2026-11-17-fase2-ruang-chat.md`.
- Acuan: `docs/KONTRAK-API-INBOX.md` "Penanganan percakapan", DECISIONS 2026-11-17 (6 baris butir 7), PRD §4 (matriks
  izin), `docs/SECURITY.md` §2, §10.
- Model ancaman:
  - akun CS curian yang ingin merebut/menyembunyikan percakapan, membuka data ke akun lain, atau mengganggu antrian;
  - Teknisi yang mencoba melihat/mengubah percakapan di luar tugasnya;
  - pengguna yang perannya diturunkan/dinonaktifkan di tengah sesi;
  - IDOR lintas organisasi.
- Lingkungan uji: Postgres/Redis dev (database sementara per berkas). Stack E2E/kritikus tidak dipakai, kode produk tidak
  diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Satu transaksi per aksi:**
  - `assertActorStillAuthorized` memeriksa ulang peran pelaku SAAT INI, lalu cakupan dihitung dari peran itu;
  - baris percakapan dikunci `FOR UPDATE` dengan saringan organisasi + cakupan;
  - perubahan + baris `conversation_events` (pelaku, agen baru/lama; tanpa isi pesan) disimpan bersama;
  - event diterbitkan setelah commit.
- **Balapan ambil:** dua agen bersamaan → satu 200, satu 409 yang menyebut nama pemegang (nama memang terlihat di
  daftar).
- **Sasaran penugasan:** satu organisasi, aktif, memegang `inbox.reply` (`FOR SHARE` pada baris pengguna).
- **Teknisi:**
  - tidak bisa ambil/tugaskan (`inbox.assign` = N);
  - hanya mengembalikan/menyelesaikan/membuka lagi chat miliknya; selain itu 404 dan percakapan tidak berubah;
  - menerima `conversation.removed` (ID saja) saat dialihkan dan tidak lagi menerima event percakapan itu;
  - jawaban aksi `{ conversation: null }` bila ia tidak lagi boleh melihatnya.
- **`GET /inbox/agents`:** tanpa email. `nameSource`/`waUsername` hanya untuk pemegang `inbox.view`, dan peran yang
  sama sudah bisa melihatnya lewat `GET /contacts/:id`.
- **Hapus kontak** ikut menghapus `conversation_events` percakapan kontak itu.

**Ambil/alihkan/buka lagi tanpa konfirmasi identitas: tepat.**
- Aksi ini tidak membuka rahasia, tidak membelokkan jalur komunikasi ke luar, dan hanya memindahkan data di antara
  pengguna yang memang berizin melihat inbox. Catatan: menugaskan ke Teknisi memang membuka percakapan itu untuk
  Teknisi tersebut (PRD).
- Aksinya bisa dibatalkan dan tercatat per pelaku.
- Konfirmasi di setiap ambil/selesai akan merusak alur kerja CS tanpa menambah perlindungan berarti.
- Bandingkan dengan aksi yang memang wajib konfirmasi: ubah batas kirim, lanjutkan rem, kredensial channel, profil
  bisnis.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Tidak ada deteksi penyalahgunaan massal. Akun CS curian bisa mengambil semua chat antrian (120 aksi/menit), sehingga antrian "Belum dilayani" kosong dan pelanggan tak terlayani, atau menyelesaikan/mengembalikan massal. Hanya tercatat di `conversation_events` (bukan audit/banner) | Sebelum produksi (kecil) |
| Info 1–6 | Info | Lihat bagian C | — |

Tes baru: `apps/api/src/modules/inbox/security-review-fase2-penanganan.integration.test.ts`, 5 penjaga (`it`), semua
lulus:
- Teknisi: riwayat/buka lagi/selesai milik orang lain → 404 tanpa perubahan dan tanpa baris event;
- Teknisi menugaskan (termasuk ke dirinya) → 403;
- pengguna organisasi lain sebagai sasaran → 400;
- CS yang diturunkan menjadi Teknisi tidak bisa lagi mengambil;
- Teknisi mengembalikan chat-nya → `conversation: null`.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| RBAC aksi | ✅ | `claim`/`assign` = `inbox.assign` (Owner/Admin/Supervisor/CS). `unassign`/`resolve`/`reopen` = `inbox.reply` + cakupan (Teknisi `assigned`). `events` + `agents` = `inbox.view`. Rute `requirePermission` + CSRF hook + `inbox-aksi` 120/menit per pengguna. RBAC matrix diperbarui |
| Cek ulang pelaku + `FOR UPDATE` dengan cakupan terbaru | ✅ | `assignment.service.ts` `mutate`: `assertActorStillAuthorized(tx, auth, permission)` → `permissionScope(role)` dari peran SEKARANG → `SELECT … conversationScope(grant) FOR UPDATE`. Penjaga baru: peran diturunkan → aksi ditolak, percakapan tidak berubah |
| Teknisi kembalikan chat orang lain | ✅ | Di luar cakupan → 404 (baris tidak ditemukan dengan saringan cakupan). Jalur `forbidByRule(inboxUnassignOthers)` untuk peran tanpa `inbox.assign` yang lolos cakupan juga ada (berlapis) |
| Sasaran penugasan | ✅ | `users` organisasi pelaku + `disabled_at IS NULL` + `hasPermission(role,'inbox.reply')` + `FOR SHARE`. FK komposit `conversation_events (organization_id, *_user_id)` |
| Buka lagi | ✅ | Hanya sesi terakhir kontak × channel. Indeks unik parsial "satu sesi terbuka" menangkap balapan dengan pesan masuk (409). Agen lama dipulihkan hanya bila masih aktif & berizin |
| `conversation_events` | ✅ | Tanpa isi pesan/nomor. FK komposit ke percakapan/pengguna. Dihapus bersama kontak (`deleteContactData`). Riwayat dibaca hanya setelah percakapan lolos cakupan, maks. 500 baris |
| `GET /inbox/agents` | ✅ (Info 1) | Kolom `id, name, role, active, openConversations`. Tanpa email (tes lama memeriksa `@majujaya.test` tidak muncul). Termasuk pengguna nonaktif untuk saringan lama |
| `nameSource`/`waUsername` | ✅ | Sama dengan data `GET /contacts/:id` untuk peran yang sama (`contacts.view` = `inbox.view` per peran). Membantu UI menandai "nama dari WhatsApp" (antipenyamaran) |
| `conversation.removed` | ✅ | Hanya ke socket `previousAssigneeUserId` yang TIDAK lagi dalam cakupan. Isinya ID percakapan saja. Penerima lain tidak menerima apa pun (`inbox-stream.ts` `deliver`) |
| IDOR lintas organisasi | ✅ | Semua query memakai `auth.organizationId`. Penjaga baru: sasaran organisasi lain → 400 |
| Log/privasi | ✅ | Log `conversationId` + `actorRef` saja |

---

## B. Temuan

### R1 — Rendah — Tidak ada alarm untuk ambil/selesai/kembalikan massal

**Bukti.** `inbox-aksi` 120/menit per pengguna adalah satu-satunya rem. Riwayat hanya di `conversation_events` (tab
"Log" per percakapan), bukan audit log atau ringkasan keamanan.

**Dampak.** Akun CS curian (atau orang dalam) bisa mengambil seluruh antrian dalam beberapa menit. Chat pindah ke
"Dilayani" atas nama akun itu, sehingga CS lain tidak melihatnya di "Belum dilayani" dan pelanggan menunggu tanpa
jawaban. Ia juga bisa menyelesaikan massal percakapan berjalan. Tidak ada data yang bocor, tetapi layanan terganggu dan
Owner tidak diberi tahu.

**Perbaikan.**
- Penghitung per pengguna di Redis (mis. > 30 `claimed`/`resolved`/`unassigned` dalam 10 menit) → audit
  `inbox.bulk_action` + kejadian `warning` di ringkasan keamanan (banner Owner/Admin), sekali per jam per pengguna.
- Opsional: batas "maks. chat dilayani per agen" (sudah direncanakan bersama alokasi/kapasitas agen) juga membatasi
  efek ambil massal.

---

## C. Info

1. **Teknisi ikut mendapat `GET /inbox/agents`** (nama, peran, aktif, beban kerja semua agen) walau tidak bisa
   menugaskan atau menyaring per agen. Kebocorannya kecil (rekan satu organisasi), tetapi bisa dibatasi ke pemegang
   `inbox.assign` (atau Teknisi hanya melihat dirinya) bila tidak dibutuhkan UI-nya.
2. **409 "sudah diambil {nama}"** menyebut nama pemegang ke pemanggil yang berizin `inbox.assign`, yang memang melihat
   pemegang di daftar. Tidak bocor.
3. **`firstResponseAt`/`firstAssignedAt`** hanya cap waktu. Tidak ada isi.
4. **Penugasan otomatis/kapasitas/departemen** ditunda (DECISIONS). Saat dibangun, pelaku `null` (sistem) harus tetap
   mematuhi aturan sasaran yang sama (aktif, berizin, organisasi sama), dan departemen menyempitkan cakupan di SQL,
   bukan di klien.
5. **`resolve` oleh CS atas percakapan agen lain** diizinkan (cakupan CS = semua) dan tercatat. Sesuai PRD.
6. **Hapus kontak** menghapus `conversation_events`. Bila kelak laporan butuh agregat penanganan, simpan agregat
   anonim terpisah sebelum hapus, bukan baris ber-ID kontak.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/inbox/security-review-fase2-penanganan` | 5/5 lulus |
| `apps/api`: `vitest run src/modules/inbox src/modules/messages src/modules/sending-limits src/rbac-matrix src/modules/realtime src/modules/audit` | 106 lulus + 1 `it.fails` (R5 ruang chat putaran 2), 11 berkas |
| `apps/worker`: `vitest run src/queues/messages src/queues/email` | 25/25 lulus |
| `packages/core`: `vitest run src/meta src/mail` | 190/190 lulus |
| ESLint + `tsc --noEmit` (apps/api) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild`, `minimatch`), tidak ada yang baru |
