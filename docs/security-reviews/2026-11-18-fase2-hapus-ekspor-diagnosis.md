# Review Keamanan — Fase 2: hapus & ekspor data kontak, diagnosis webhook (backend)

- Tanggal: 2026-11-18
- Peninjau: agent `security`
- Cakupan: commit `c90555f` `feat(kontak): hapus & ekspor data kontak (UU PDP), diagnosis webhook per channel, nama kontak di
  notifikasi bawaan mati`. Berkas yang diperiksa:
  - kontak: `apps/api/src/modules/contacts/{contacts.routes,contacts.service,contacts.repo}.ts`;
  - webhook: `apps/api/src/modules/webhooks/{webhook-health,webhook-guard}.ts`, `apps/api/src/modules/channels/channels.routes.ts`;
  - real-time & audit: `apps/api/src/modules/realtime/inbox-stream.ts`, `packages/core/src/inbox-events.ts`,
    `apps/api/src/modules/audit/audit.service.ts`;
  - perbaikan push: `apps/worker/src/queues/notifications.ts`, `apps/api/src/modules/notifications/notifications.service.ts`,
    `apps/api/src/modules/quick-replies/quick-replies.service.ts`, migrasi `0019`.

  Verifikasi R1/R2 push ada di "Putaran 2" `2026-11-18-fase2-notifikasi-push.md`.
- Acuan: `docs/KONTRAK-API-INBOX.md` (hapus/ekspor kontak), `docs/KONTRAK-API-CHANNEL.md` (diagnosis webhook),
  DECISIONS 2026-11-18 (5 baris), `docs/SECURITY.md` §2, §8, §10, review webhook S4 & kontak R4.
- Model ancaman:
  - sesi Admin/Supervisor curian yang ingin menghapus jejak atau mengekspor data pelanggan;
  - Teknisi/CS di luar izinnya;
  - IDOR lintas organisasi;
  - kebocoran ID lewat WebSocket;
  - CSRF pada GET berefek samping.
- Lingkungan uji: Postgres/Redis dev (database sementara). Stack E2E/kritikus tidak dipakai, kode produk tidak diubah.

## Putusan: AMAN

Tidak ada temuan Kritis, Tinggi, atau Sedang.

**(A) `DELETE /contacts/:id`:**
- `contacts.delete` (Owner/Admin) + konfirmasi identitas (password + 2FA) + cek ulang pelaku di transaksi.
- `deleteContactData` (pesan, percakapan, catatan sesi, tag, riwayat, payload webhook) di satu transaksi.
- Audit hanya ID kontak + jumlah + `hadOpenConversation` + peran.
- Media dibersihkan seketika setelah commit (kegagalan dicoba ulang pembersih berkala).
- Kontak organisasi lain → 404.

**(B) `GET /contacts/:id/export`:**
- `contacts.export` (Owner/Admin/Supervisor), 20/jam, audit (jumlah saja), `no-store`, `attachment`.
- Isi tanpa BSUID, ID media Meta, catatan sesi, maupun wamid. Nama berkas `cleanFileName`. Maks. 10.000 pesan
  (`truncated`).
- **Tanpa konfirmasi identitas dinilai tepat.** Peran yang boleh mengekspor sudah bisa membaca data yang sama lewat
  REST inbox/kontak (pesan, nomor, email, catatan kontak). Ekspor per kontak tidak membuka akses baru, hanya merapikan
  formatnya. Perlindungan bermaknanya adalah izin + batas 20/jam + audit. Konfirmasi wajib untuk ekspor MASSAL (semua
  kontak / CSV) kelak, bukan ekspor satu kontak. Satu catatan konsistensi pola CSRF → R1.

**(C) `GET /settings/channels/:id/webhook-health`:** `channels.manage`, ID bukan UUID → 404, saringan organisasi +
channel tidak terhapus. Isinya hanya hitungan & waktu (tanpa payload, nomor, tanda tangan, IP).

**(D)** `channelId` di detail `webhook_signature_failed` hanya untuk Owner/Admin (ringkasan keamanan). ID internal,
tidak sensitif.

**(E)** Lihat putaran 2 laporan push: R1 & R2 tertutup, dan Info 5 (`DELETE` langganan dinormalkan) tertutup.

| # | Level | Ringkas | Kapan |
|---|---|---|---|
| R1 | Rendah | `GET /contacts/:id/export` tidak memakai `requireCsrf`. Endpoint ini berefek samping (audit, jatah 20/jam, mengunduh PII), sementara pola proyek untuk GET berefek samping (ekspor audit CSV, unduh media, profil bisnis) mewajibkan CSRF. Dampak kecil karena butuh UUID kontak | Sekarang (kecil) |
| Info 1–5 | Info | Lihat bagian C | — |

Tes baru di `apps/api/src/modules/contacts/security-review-fase2-hapus-ekspor.integration.test.ts`: 2 penjaga + 1
`it.fails` (R1, sudah dijalankan sebagai `it`: `expected 200 to be 403`).
- Ekspor: Teknisi 403; kontak organisasi lain 404; catatan sesi & BSUID tidak ikut; `no-store`.
- Hapus: Supervisor 403; Owner pada kontak organisasi lain tidak menghapus apa pun.

---

## A. Verifikasi fokus

| Fokus | Status | Bukti |
|---|---|---|
| Hapus: izin + konfirmasi + cek ulang | ✅ | Rute `requirePermission('contacts.delete')` (`[Y,Y,N,N,N]`). `requireIdentityConfirmation(…'contact.delete')` dengan perangkat tepercaya dari cookie (pola Fase 1). `assertActorStillAuthorized` di transaksi. Tes lama: CS/Supervisor 403, tanpa/salah konfirmasi 400 |
| Hapus: audit tanpa PII | ✅ | `contact.deleted` metadata `messages`, `conversations`, `webhookEvents`, `hadOpenConversation`, `actorRole`. Tes lama memeriksa nama/nomor tidak ada |
| Hapus: media langsung hilang | ✅ (Info 2) | `purgeMedia()` setelah commit. `deleteContactData` memajukan `expiresAt`. Tes lama: berkas di disk hilang |
| Percakapan terbuka boleh dihapus | ✅ | Permintaan UU PDP tidak boleh tertahan percakapan berjalan. Tercatat `hadOpenConversation` |
| Event `conversation.deleted` → `conversation.removed` ke semua `inbox.view` | ✅ (Info 1) | Hub mengirim ID percakapan ke semua pemegang `inbox.view` organisasi itu (baris sudah tidak ada untuk dicek cakupannya) |
| Ekspor: izin, batas, audit, isi | ✅ (R1) | `contacts.export` `[Y,Y,Y,N,N]`, `kontak-ekspor` 20/jam per pengguna, audit `contact.exported` (jumlah + `truncated`). Skema respons `contactExportSchema` menyaring kolom. Tanpa `wa_bsuid`, `metaMediaId`, `sha256`, wamid, catatan sesi. Penjaga baru |
| Ekspor tanpa konfirmasi identitas | ✅ (dinilai) | Lihat Putusan (B) |
| Diagnosis webhook | ✅ | `channels.manage`, UUID → 404, organisasi + `deleted_at IS NULL`. Hanya angka/waktu. `lastSignatureFailureAt` dari TTL penanda Redis. Tes lama "tanpa payload" |
| `channelId` di `webhook_signature_failed` | ✅ | `DETAIL_KEYS` ditambah `channelId`. Baris lama diambil dari `target_id`. Tes lama |
| `pnpm audit` | ✅ | 2 moderate dev-only yang sama |

---

## B. Temuan

### R1 — Rendah — Ekspor kontak tidak mewajibkan CSRF

**Bukti.** `contacts.routes.ts`: rute `GET /contacts/:id/export` `config: { access: requirePermission('contacts.export') }`
tanpa `requireCsrf: true`. Pola proyek (`auth.hook.ts` "GET bertanda `config.requireCsrf` (efek samping)") dipakai di
ekspor audit CSV, unduh media, dan profil bisnis. Tes `it.fails` R1: GET tanpa `X-CSRF-Token` → 200.

**Dampak.** Situs lain yang mengetahui UUID kontak bisa memicu unduhan ekspor di browser korban lewat navigasi
(cookie Lax). Jawaban tidak terbaca lintas situs (berkas diunduh di perangkat korban sendiri), tetapi jatah 20/jam
korban berkurang dan audit `contact.exported` tercatat atas namanya, sehingga jejak forensik ekspor tercemar. Karena
butuh UUID kontak (tidak bisa ditebak), risikonya kecil.

**Perbaikan.** `config: { access: …, requireCsrf: true }`. Web mengambilnya lewat `client.download` (sudah membawa
header CSRF). Ubah `it.fails` R1 menjadi `it`.

---

## C. Info

1. **Kebocoran ID lewat `conversation.removed` saat hapus kontak.** Semua pemegang `inbox.view` (termasuk Teknisi yang
   tidak memegang percakapan itu) menerima ID percakapan yang dihapus. Isinya hanya UUIDv7 + "dihapus": tanpa
   nama/nomor/isi, dan percakapan itu sudah tidak ada. Risiko dapat diabaikan. Bila ingin rapi, sertakan
   `assigneeUserId` lama di event bus (diambil sebelum hapus) supaya hub memakai saringan cakupan biasa.
2. **`purgeMedia()` setelah hapus kontak** menjalankan pembersih GLOBAL (semua organisasi, maks. 500 baris) di dalam
   permintaan. Bila ada antrean kedaluwarsa > 500, media kontak ini bisa belum terhapus di putaran itu (pembersih
   berkala menyusul ≤ 1 jam), dan permintaan bisa lambat. Saran: purge khusus ID media milik kontak (kumpulkan
   `media_file_id` sebelum hapus).
3. **Audit hapus tidak menyimpan identitas kontak** (sengaja, UU PDP). Owner tidak bisa melihat SIAPA yang dihapus
   dari audit, hanya kapan, oleh siapa, dan berapa banyak. Untuk bukti pemenuhan permintaan pelanggan, simpan bukti
   permintaan di luar sistem atau tambahkan `sha256(nomor)` bila perlu dicocokkan kelak.
4. **Diagnosis webhook** menghitung `max(received_at)`/`stalled` atas seluruh baris channel (tanpa batas 24 jam).
   Dibatasi umur baris 35 hari dan hanya Owner/Admin. Cukup.
5. **Pola domain `quick_reply_risky` umum** (`\.[a-z]{2,}`) menandai juga teks seperti "Jl.Sudirman" atau
   "Pt.Contoh". Positif palsu hanya menambah kejadian `warning` untuk perubahan oleh selain Owner. Bisa diterima.

---

## D. Hasil tes yang dijalankan

| Perintah | Hasil |
|---|---|
| `apps/api`: `vitest run src/modules/contacts/security-review-fase2-hapus-ekspor` | 2 lulus + 1 `it.fails` (R1) |
| Sama, `it.fails` → `it` (salinan sementara, sudah dihapus) | gagal tepat di asersi R1 (`expected 200 to be 403`) |
| `apps/api`: `vitest run src/modules/contacts src/modules/notifications src/modules/quick-replies src/modules/channels src/modules/inbox src/rbac-matrix src/modules/audit` | 142 lulus + 1 `it.fails`, 15 berkas |
| ESLint + `tsc --noEmit` (apps/api) untuk berkas tes baru | bersih |
| `pnpm audit` | 2 moderate dev-only, tidak ada yang baru |

---

## Putaran 2 — verifikasi perbaikan (commit `2f2d311`)

| Butir | Bukti | Status |
|---|---|---|
| R1 CSRF ekspor kontak | `apps/api/src/modules/contacts/contacts.routes.ts:136` kini `requireCsrf: true`. Tes `security-review-fase2-hapus-ekspor.integration.test.ts:150` diubah dari `it.fails` ke `it` dengan asersi `403` yang sama, dan lulus | **Tertutup** |
| Info 2: purge global | `contacts.service.ts:146-149,412` memanggil `purgeMedia(outcome.mediaFileIds)` → `outbound.purgeMediaFiles` (`outbound.service.ts:959-966`) yang hanya memproses ID media milik kontak yang dihapus (`inArray`, belum `deletedAt`) | **Tertutup** |
| Info 1: `conversation.removed` ke semua `inbox.view` | `contacts.service.ts:425` menyertakan `previousAssigneeUserId`; `apps/api/src/modules/realtime/inbox-stream.ts:135-141` memakainya sebagai `assigneeUserId`, sehingga saringan cakupan biasa berlaku (Teknisi lain tidak menerima ID) | **Tertutup** |

Hasil: tes hapus/ekspor 3 lulus (tanpa `it.fails` tersisa). Putusan tetap **AMAN**.
