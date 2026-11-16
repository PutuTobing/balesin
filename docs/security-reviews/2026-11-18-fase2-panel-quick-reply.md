# Review Keamanan — Fase 2 butir 8–9: panel detail & quick reply (backend)

- Tanggal: 2026-11-18
- Peninjau: agent `security`
- Cakupan: commit `40d9c1b` `feat(inbox): panel detail (tag, kontak, catatan sesi, pesan ditandai, log) dan quick reply`.
  Berkas yang diperiksa:
  - `apps/api/src/modules/{contacts,tags,quick-replies}/**`, `apps/api/src/modules/inbox/{panel.*,inbox.repo,inbox-view,
    assignment.service}.ts`;
  - `apps/api/src/modules/realtime/inbox-stream.ts`, `packages/core/src/inbox-events.ts`;
  - `packages/db/src/schema/{tags,contact-events,conversation-notes,quick-replies,contacts,messages}.ts` + `drizzle/0017_…sql`;
  - `packages/shared/src/{inbox,tags,quick-replies,permissions}.ts`.

  Sisipan perbaikan review sebelumnya dinilai di "Putaran 2" laporan penanganan percakapan dan "Putaran 3" laporan ruang
  chat.
- Acuan: `docs/KONTRAK-API-INBOX.md` "Panel detail", "Quick reply"; DECISIONS 2026-11-17 (13 baris); PRD §4;
  `docs/SECURITY.md` §2, §10.
- Model ancaman:
  - akun CS curian yang ingin mengubah data pelanggan, menyalahgunakan tag/quick reply untuk penipuan, atau menulis
    "atas nama" rekan;
  - Teknisi di luar cakupannya;
  - pelanggan yang mengendalikan nama profil WhatsApp (dipakai variabel `{nama}`);
  - pencemaran prototipe lewat atribut;
  - IDOR lintas organisasi.
- Lingkungan uji: Postgres/Redis dev (database sementara). Stack E2E tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

- **Semua tulis:** CSRF, `assertActorStillAuthorized` di transaksi, saringan `organization_id`, FK komposit
  `(organization_id, …)` di semua tabel baru, dan batas laju `panel-ubah` 120/menit (`quick-reply-pakai` 240/menit).
- **RBAC:**
  - tag: lihat `inbox.view`, buat & pasang `contacts.manage` (Teknisi N), ganti nama/hapus
    `settings.workspace.manage` (Owner/Admin);
  - ubah kontak `contacts.manage`;
  - catatan: ubah HANYA penulis (moderator pun tidak), hapus penulis atau `inbox.notes.moderate`;
  - tandai pesan `inbox.reply` + cakupan;
  - quick reply kelola `quick_replies.manage` (Owner/Admin/Supervisor), pakai `inbox.reply` + cakupan.
- **Atribut** berupa DAFTAR `{key,value}`, bukan objek. Kunci harus diawali huruf/angka (`__proto__` ditolak), dan
  `constructor` hanya teks di daftar.
- **`contact_events`** hanya menyimpan nama isian yang berubah + nama/warna tag. Penjaga baru membuktikan email,
  catatan, dan nilai atribut tidak tersimpan di riwayat.
- **Quick reply** diisi server SATU putaran (`{agen}` di nama pelanggan tetap teks). Cakupan percakapan dicek sebelum
  penghitung dinaikkan. Template diaudit tanpa isi.
- **Event WS** hanya ID (`conversation.detail` per percakapan dalam cakupan, `tags.changed` tanpa data).
- **Hapus kontak** ikut menghapus tag kontak, `contact_events`, dan catatan sesi.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | Quick reply dibuat/diubah Supervisor+ dan disisipkan agen ke pesan pelanggan apa adanya. Akun Supervisor curian bisa menanam tautan/rekening penipuan di template yang dipakai semua CS. Yang diaudit hanya shortcut + nama isian (tanpa isi), dan Owner tidak diberi tahu | Sebelum produksi (kecil) |
| Info 1–7 | Info | Lihat bagian C | — |

Tes baru di `apps/api/src/modules/inbox/security-review-fase2-panel.integration.test.ts`: 5 penjaga (`it`), semua lulus.
- `__proto__` ditolak / `constructor` aman;
- riwayat kontak tanpa nilai data pelanggan;
- Teknisi tidak bisa ubah kontak / pasang tag (403), bahkan pada percakapannya;
- Owner (moderator) tidak bisa mengubah catatan CS (403, isi tetap), CS lain tidak bisa menghapusnya (403), Owner boleh
  menghapus;
- nama pelanggan berisi `{agen} {nama}` tidak diproses ulang.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Tag menempel ke kontak; CS buat master (maks. 300); ganti nama/hapus Owner/Admin; Teknisi tidak bisa pasang | ✅ | `tags.service.ts` + `permissions.ts` (`contacts.manage` `[Y,Y,Y,Y,N]`, `settings.workspace.manage` `[Y,Y,N,N,N]`). Nama unik `lower(name)`. CHECK warna dari palet. `tag.created/updated/deleted` diaudit. Tes lama + penjaga baru (Teknisi pasang → 403). Batas 300/20 dihitung tanpa kunci (Info 2) |
| `PATCH /contacts/:id` | ✅ | `updateContactRequestSchema`: nama ≤ 256 tanpa karakter kendali, email dinormalkan, catatan ≤ 2.000, atribut maks. 30 dengan kunci `^[\p{L}\p{N}][\p{L}\p{N} ._-]*$` unik tanpa beda huruf, nilai ≤ 500 tanpa karakter kendali. Baris kontak `FOR UPDATE`. Penjaga baru: `__proto__` → 400, `constructor` tersimpan sebagai elemen daftar |
| `contact_events` tanpa nilai | ✅ | Kolom: `kind`, `fields` (CHECK ⊆ 4 nama isian), `tag_name/color`, pelaku. Penjaga baru: email/catatan/nilai atribut tidak ada di baris riwayat. Ikut dihapus bersama kontak |
| Catatan sesi & aturan `edit_others`/`delete_others` | ✅ | `panel.service.ts`: `lockScoped` (cek ulang pelaku + percakapan dalam cakupan, `FOR SHARE`) → `lockNote` (`FOR UPDATE`) → penulis atau `forbidByRule` (diaudit `auth.access.denied`). `inbox.notes.moderate` `[Y,Y,N,N,N]`. Isi catatan tidak di log/audit/event. Penjaga baru |
| Pesan ditandai | ✅ | Pesan dicari per organisasi, lalu `lockScoped` pada percakapannya. Di luar cakupan → 404 seragam |
| `?only=starred|media|files` | ✅ | `z.enum(MESSAGE_LIST_FILTERS)`. Dibaca hanya setelah percakapan lolos cakupan (jalur `listMessages` yang sama) |
| Log (`/events`) | ✅ | `conversation_events` + `contact_events` milik kontak sejak percakapan dibuat. Hanya nama isian/tag. Cakupan percakapan dicek dulu |
| Quick reply `{nama}` dari profil WA | ✅ (R1) | `renderQuickReply` satu putaran (nilai pengganti tidak diproses ulang). Nama profil sudah dibersihkan karakter tak terlihat (review kontak R2). Hasilnya ke composer (agen melihat dulu) dan dikirim lewat endpoint kirim biasa (jendela, batas, rem). Pelanggan hanya menerima namanya sendiri |
| `POST /quick-replies/:id/use` cakupan | ✅ | Percakapan + kontak dicari dengan `conversationScope(grant)` SEBELUM penghitung naik. Quick reply per organisasi. Tes lama: Teknisi di luar cakupan → 404 |
| Event WS `conversation.detail`/`tags.changed` | ✅ | Bus `strictObject` + `isComplete`. Hub membaca percakapan per organisasi dan mengirim hanya ke socket yang cakupannya mencakup percakapan itu. `tags.changed` tanpa ID/isi ke pemegang `inbox.view`. Perubahan kontak → maks. 20 percakapan terbaru (Info 4) |
| Hapus kontak | ✅ | `deleteContactData` menghapus `conversation_notes` (semua percakapan kontak), `contact_tags`, `contact_events` (tes lama `hapus kontak (UU PDP)`) |
| Batas laju | ✅ | `panel-ubah` di 11 rute tulis kontak/tag/catatan/bintang. `quick-reply-pakai` di `use` |
| IDOR lintas organisasi | ✅ | Semua query memakai `auth.organizationId`. FK komposit pada `contact_tags`, `contact_events`, `conversation_notes`, `quick_replies`, `messages.starred_by` |
| `pnpm audit` | ✅ | 2 moderate dev-only yang sama |

---

## B. Temuan

### R1 — Rendah — Isi quick reply tidak dijejaki

**Bukti.** `quick-replies.service.ts`: audit `quick_reply.created/updated/deleted` hanya memuat shortcut + nama isian
yang berubah (DECISIONS: "TANPA isi template"). Tidak ada kejadian keamanan atau email Owner. Template dipakai semua
pemegang `inbox.reply` dan dikirim ke pelanggan dari nomor resmi.

**Dampak.** Akun Supervisor/Admin curian bisa mengubah `/rekening` menjadi nomor rekening penipu, atau menyisipkan
tautan phishing ke `/salam`. CS yang memakai template sehari-hari meneruskannya ke banyak pelanggan. Setelah template
dikembalikan, tidak ada jejak isi lama untuk menelusuri pelanggan yang terdampak. Isi template adalah teks bisnis (bukan
data pelanggan), jadi menyimpannya di audit tidak bertentangan dengan UU PDP.

**Perbaikan.**
- Audit `quick_reply.updated` memuat `previous.body` dan `next.body` (seperti `channel.business_profile_updated`).
- Perubahan oleh selain Owner yang MENAMBAH tautan/angka panjang (mis. pola URL atau ≥ 8 digit berurutan) → kejadian
  `warning` di ringkasan keamanan.
- Opsional: tampilkan "diubah oleh … pada …" di daftar `/` (sudah ada `updatedBy`).

---

## C. Info

1. **Kunci atribut `constructor`/`toString`/`hasOwnProperty` diterima** (huruf biasa). Aman selama atribut tetap
   DAFTAR. Bila kelak diubah menjadi objek (API n8n/compat MobiChat `{ "key": "value" }`), pakai
   `Object.create(null)`/`Map`, atau tolak nama-nama itu.
2. **Batas 300 tag/organisasi, 20 tag/kontak, 200 catatan/percakapan** dihitung tanpa kunci. Balapan bisa sedikit
   melewatinya (dibatasi batas laju). Bisa diterima.
3. **Nama kontak dari tim** bebas (≤ 256, tanpa karakter kendali) dan mengalahkan nama profil di tampilan. CS bisa
   menamai kontak secara menyesatkan. Tercatat di `contact_events` (`fields: ['name']`) beserta pelakunya. Cukup.
4. **Fan-out `conversation.detail` maks. 20 percakapan terbaru.** Teknisi yang memegang percakapan lama kontak itu
   (di luar 20 terbaru) tidak mendapat event, tetapi REST tetap benar. Fungsional, bukan keamanan.
5. **Hasil quick reply bisa > 4.096 karakter** (template 3.500 + beberapa `{nama}` 256). Kirim akan 400. Fungsional.
6. **Skema respons opsional sementara** (`contact.tags`, `Contact.email/notes/attributes`, …) tidak berdampak keamanan.
   Server selalu mengisinya lewat skema respons yang menyaring kolom.
7. **`tags.changed` dikirim ke Teknisi juga.** Hanya sinyal tanpa data; Teknisi memang boleh `GET /tags`.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/inbox/security-review-fase2-panel` | 5/5 lulus |
| `apps/api`: `vitest run src/modules/inbox src/modules/contacts src/modules/tags src/modules/quick-replies src/modules/messages src/modules/realtime src/rbac-matrix` | 94 lulus + 1 `it.fails` (R2 penanganan putaran 2), 10 berkas |
| `apps/worker`: `vitest run src/queues` | 86/86 lulus |
| `packages/core`: `vitest run` · `packages/shared`: `vitest run` | 518/518 · 108/108 lulus |
| ESLint + `tsc --noEmit` (apps/api) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only (`esbuild`, `minimatch`), tidak ada yang baru |
