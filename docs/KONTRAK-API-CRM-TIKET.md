# Kontrak API — CRM, Tiket, Departemen (Fase 5)

Skema Zod: `packages/shared/src/crm.ts`, `tickets.ts`, `departments.ts` (+ `inbox.ts` untuk kontak &
percakapan). Alamat: `API_ROUTES.crm`, `API_ROUTES.tickets`, `API_ROUTES.departments`,
`API_ROUTES.inbox.department`, `API_ROUTES.publicApi.ticket*`. Semua rute web: sesi + CSRF untuk
metode tulis (hook auth); galat `{ error: { code, message, details? } }`. Migrasi: `0026`.

## Ringkasan izin (PRD §4)

| Kemampuan | Izin | Catatan |
|---|---|---|
| Daftar & cari kontak | `contacts.view` | Bercakupan: Teknisi = kontak percakapannya / tiket terbukanya |
| Impor & ekspor kontak massal | `contacts.export` | Owner/Admin/Supervisor. Ekspor = konfirmasi identitas |
| Gabung kontak duplikat | `contacts.delete` | Owner/Admin + konfirmasi identitas (permanen, setara hapus kontak; review Fase 5 Info 4) |
| Definisi atribut kontak | lihat `contacts.view`, kelola `settings.workspace.manage` | |
| Lihat/ubah tiket | `tickets.manage` | Teknisi `own` (miliknya); pengguna bertanda departemen = `department` |
| Board/kolom/atribut tiket, hapus tiket | `tickets.configure` | Owner/Admin/Supervisor |
| Departemen (kelola, akses pengguna) | `settings.workspace.manage` | Owner/Admin |
| Daftar nama departemen | `inbox.view` | |
| Pindah percakapan ke departemen | `inbox.assign` | Cakupan pelaku |

## Kontak

### Atribut kustom

Nilai tetap disimpan sebagai daftar `{ key, value }` di kontak. **Definisi** (opsional) menambah
label, jenis, wajib, pilihan. Kunci tanpa definisi = atribut bebas (seperti sebelum Fase 5).

| Endpoint | Keterangan |
|---|---|
| `GET /api/v1/contact-attributes` | `{ attributes: [{ id, key, label, type, required, options, position, createdAt, updatedAt }] }` |
| `POST /api/v1/contact-attributes` | `{ key (1–40, huruf/angka/spasi/._-), label (≤ 60), type: text·number·date·select, required?, options? (select: 1–50, tidak kembar) }` → **201** `{ attribute }`. Kunci kembar (tanpa beda huruf) → 409. Maks. 30. Audit `attribute_definition.created` |
| `PATCH /api/v1/contact-attributes/:attributeId` | `{ label?, type?, required?, options?, position? }` — kunci tidak bisa diubah; nilai lama tidak divalidasi ulang sampai diubah |
| `DELETE /api/v1/contact-attributes/:attributeId` | `{ deleted: true }` — nilai tersimpan menjadi atribut bebas |

**Validasi nilai** (`validateAttributeValues`, dipakai web juga): `number` → bentuk baku titik desimal
(`150000,5` → `150000.5`; pemisah ribuan ditolak); `date` → `YYYY-MM-DD` (menerima juga `DD/MM/YYYY`,
`DD-MM-YYYY`, nomor seri tanggal Excel); `select` → salah satu pilihan (tanpa beda huruf, disimpan
ejaan pilihan); kunci ditulis ulang dengan ejaan definisi. Galat 400 `details[].field =
attributes.<kunci>`. **Wajib** ditegakkan saat atribut disimpan dari aplikasi (`PATCH
/contacts/:id` sesi web); API publik/bot & impor tidak memaksa wajib (bot tidak tahu definisi).

### Daftar & cari — `GET /api/v1/contacts`

Query: `q` (2–100: nama/nama profil/username/potongan nomor, `08…` dicoba `628…`), `tagId`,
`attributeKey` + `attributeValue` (berpasangan; kunci tanpa beda huruf, nilai sama persis),
`possibleDuplicate=true|false`, `cursor`, `limit` (≤ 100, bawaan 50). Urut terbaru dibuat dulu.
→ `{ contacts: Contact[], nextCursor }`. `Contact` kini memuat **`possibleDuplicateOfContactId`**
(review R4 — tawarkan "Gabung"). Batas 120/menit per pengguna.

### Ekspor massal — `POST /api/v1/contacts/export`

Body `{ filter? (saringan daftar di atas, tanpa kursor), confirmation }` — **wajib konfirmasi
identitas**. → `text/csv; charset=utf-8` (BOM), `Content-Disposition: attachment;
filename="kontak.csv"`, `Cache-Control: no-store`, header `X-Export-Rows`. Kolom: Nomor kontak, Nama,
Nama profil WhatsApp, Nomor WhatsApp, Username WhatsApp, Email, Tag (`; `), Catatan, Dibuat (UTC),
satu kolom per atribut berdefinisi (label), "Atribut lain" (`kunci=nilai; …`). Setiap sel dikutip,
karakter kendali dibuang, sel berawalan `= + - @` tab/CR (juga setelah spasi/kutip) diberi `'` (kebal
injeksi rumus). Maks. **50.000** baris (lebih → 409, persempit saringan). 5 ekspor/jam per pengguna.
Audit `contact.bulk_exported` `{ rows, filtered, actorRole }` — tanpa kata cari/data pribadi.

### Impor massal — `POST /api/v1/contacts/import`

`multipart/form-data`: isian **`mapping`** (JSON, dikirim SEBELUM berkas) lalu berkas **`file`**
(CSV/XLSX ≤ 5 MB). Berkas dibaca parser terisolasi modul broadcast (`parseTableIsolated`: thread
terpisah, batas waktu & memori, satu per pengguna → 429 "Impor lain sedang diproses").

`mapping`: `{ phoneColumn, nameColumn?, emailColumn?, notesColumn?, tagsColumn? (nama tag dipisah
koma/titik koma; tag baru dibuat biru sampai batas organisasi), attributes?: [{ column, key }] (≤ 30),
mode?: 'upsert' (bawaan; kontak yang ada diperbarui — HANYA isian yang dipetakan & terisi; atribut
digabung per kunci) | 'create_only' (yang ada dilewati), dryRun?: boolean (periksa saja) }`.

→ `{ dryRun, sourceRows, created, updated, unchanged, skipped, issueCounts, issues: [{ row, issue,
key? }] (maks. 200) }`. Isu: `phone_missing`, `phone_invalid`, `phone_scientific`, `duplicate`,
`value_too_long`, `name_invalid`, `email_invalid`, `attribute_invalid` (+`key`), `attributes_limit`,
`tags_limit`, `tag_invalid`, `exists`. Impor SUNGGUHAN mode `upsert` (menimpa data massal) wajib
`mapping.confirmation` (password + kode 2FA; review Fase 5 Info 3) — `dryRun` & `create_only` tidak.
Nomor dinormalkan seperti broadcast (Indonesia `08…` → `+628…`).
Diproses per 200 baris (kunci identitas sama dengan worker pesan masuk). Riwayat kontak
`imported` (`fields`). Audit SEKALI `contact.imported` `{ sourceRows, created, updated, unchanged,
skipped, mode }`. **Tidak** memicu webhook `contact.*` per kontak (cegah banjir event). 10 impor/jam.

### Gabung duplikat — `POST /api/v1/contacts/:contactId/merge` (`contacts.delete`: Owner/Admin)

Body `{ sourceContactId, confirmation }` — `:contactId` DIPERTAHANKAN, sumber digabung lalu dihapus.
→ `{ contact, moved: { conversations, messages, tags, tickets } }`.
- Pindah: percakapan, pesan, tag (gabungan), riwayat kontak, kejadian webhook masuk, penerima
  broadcast, tiket, outbox webhook. Catatan sesi & log percakapan ikut percakapannya.
- Isian: nilai kontak tujuan menang; yang kosong diisi dari sumber; catatan digabung (bila muat
  2.000); atribut digabung (tujuan menang per kunci). Identitas WhatsApp sumber (BSUID/nomor) pindah
  ke tujuan bila tujuan belum punya (kasus `possible_duplicate` R4: kontak lama tanpa nomor).
- Ditolak **409**: identitas WhatsApp berbeda (dua nomor/BSUID berbeda), keduanya punya percakapan
  terbuka di channel yang sama, jenis channel beda, atribut > 30, tag > 20. Sumber = tujuan → 400.
  Kontak organisasi lain → 404 (dicari dengan `organization_id` pemanggil).
- Riwayat `merged` di kontak tujuan; webhook `contact.updated`; audit `contact.merged`
  `{ sourceContactId, conversations, messages, tags, tickets, actorRole }` (tanpa nama/nomor).

## Tiket

Board = proyek; kolom = status berurutan, `isDone` = kolom selesai (tiket diberi `closedAt`).
Prioritas: `low · normal · high · urgent` (Rendah/Normal/Tinggi/Mendesak). Atribut kustom per board
(definisi sama seperti kontak; **wajib ditegakkan** saat buat/ubah tiket & pindah board).

**Tiket**: `{ id, number, boardId, column {id,name,position,isDone}, title, description, priority,
assignee {id,name}|null, dueAt, overdue, contact (ringkas)|null, conversation {id,number,status}|null,
attributes, position, closedAt, createdBy {kind: user|api_key, id, name}|null, createdAt, updatedAt }`.

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/tickets` | manage | Query `boardId, columnId, assignee (uuid/me/none), priority, status (open·closed·all, bawaan open), due (overdue·today·week·none), contactId, conversationId, q (judul atau #nomor), cursor, limit ≤ 100` → `{ tickets, nextCursor }` (terbaru diubah dulu) |
| `POST /api/v1/tickets` | manage | `{ boardId, columnId? (bawaan kolom pertama), title ≤ 200, description? ≤ 5.000, priority?, assigneeUserId?, dueAt?, contactId?, conversationId?, attributes? }` → **201** `{ ticket }` (`null` bila pembuat tidak lagi boleh melihatnya) |
| `GET /api/v1/tickets/:ticketId` | manage | `{ ticket }`; di luar cakupan → 404 |
| `PATCH /api/v1/tickets/:ticketId` | manage | isian di atas (tanpa board/kolom) → `{ ticket \| null }` |
| `POST /api/v1/tickets/:ticketId/move` | manage | `{ columnId (boleh board lain), afterTicketId? (null = paling atas; kosong = paling bawah) }` |
| `DELETE /api/v1/tickets/:ticketId` | configure | audit `ticket.deleted` `{ number, boardId }` |
| `GET`/`POST /api/v1/tickets/:ticketId/comments` | manage | `{ body ≤ 5.000 }` → **201** `{ comment: { id, body, author, createdAt } }` |
| `DELETE /api/v1/tickets/:ticketId/comments/:commentId` | manage | penulisnya, atau pemegang `tickets.configure` |
| `GET /api/v1/tickets/:ticketId/events` | manage | `{ events: [{ kind: created·updated·moved·assigned·closed·reopened·commented, actor, fields, fromColumn, toColumn, assignee, previousAssignee, createdAt }] }` — tanpa isi deskripsi/komentar/nilai atribut |
| `GET /api/v1/ticket-boards?archived=true` | manage | `{ boards: [{ id, name, description, department, position, columns, attributes, archivedAt, … }] }` |
| `POST /api/v1/ticket-boards` | configure | `{ name, description?, departmentId?, columns? }` (kosong = Baru · Dikerjakan · Selesai✓). Maks. 50 board aktif |
| `PATCH /api/v1/ticket-boards/:boardId` | configure | `{ name?, description?, departmentId?, position?, archived? }` |
| `GET /api/v1/ticket-boards/:boardId/kanban` | manage | Query `assignee?, priority?` → `{ board, columns: [{ column, total, tickets (≤ 100, urut posisi) }] }` |
| `POST /api/v1/ticket-boards/:boardId/columns` | configure | `{ name ≤ 40, isDone?, position? }` (maks. 20 kolom) → `{ board }` |
| `PATCH /api/v1/ticket-boards/:boardId/columns/:columnId` | configure | `{ name?, isDone?, position? }` — mengubah `isDone` ikut menutup/membuka tiket di kolom itu |
| `DELETE /api/v1/ticket-boards/:boardId/columns/:columnId` | configure | Body `{ moveToColumnId? }` (wajib bila berisi; kirim `{}` bila kosong). Kolom terakhir tidak bisa dihapus |
| `POST /api/v1/ticket-boards/:boardId/attributes` | configure | seperti atribut kontak (maks. 30/board) |
| `PATCH`/`DELETE /api/v1/ticket-boards/:boardId/attributes/:attributeId` | configure | |

**Aturan keamanan**
- **Tautan hanya ke data yang boleh dilihat pembuat/pengubah** (`inbox.view`/`contacts.view` cakupan
  peran) — tiket tidak bisa dipakai untuk "membuka" percakapan. `conversationId` mengisi `contactId`
  otomatis (kontak percakapan itu; berbeda → 400).
- **Teknisi (`own`)**: hanya tiket yang ia pegang; tiket buatannya selalu miliknya; tidak bisa mengubah
  penanggung jawab/tautan, membuat untuk orang lain, atau memindah ke board lain (403 aturan
  `ticket.own.restricted_fields`, diaudit). Boleh ubah isi/prioritas/tenggat/atribut, komentar, pindah
  kolom di board yang sama.
- **"Terkait tiketnya" (PRD §4)**: Teknisi yang memegang tiket TERBUKA yang menaut sebuah kontak boleh
  melihat & membalas percakapan kontak itu yang **ditautkan eksplisit, masih terbuka, atau dibuat setelah
  tiket** — riwayat selesai yang lebih lama tidak terbuka lewat tiket (review Fase 5 Info 1; kontaknya
  tetap terlihat). Cakupan `assigned` `inbox.view`/`inbox.reply`/`contacts.view`. Untuk pengguna bertanda
  departemen, akses lewat tiket hanya ke percakapan departemennya atau tanpa departemen (review S1). Akses berakhir saat tiket selesai (kolom `isDone`), dialihkan, atau tautannya dilepas.
  Hub real-time ikut menyaring (pemegang tiket terbuka menerima event percakapan kontak itu); perubahan
  akses lewat tiket memicu `conversation.updated` (maks. 20 percakapan terbuka kontak itu).
- **Pengguna bertanda departemen**: hanya tiket di board departemennya + tiket yang ia pegang; membuat
  /memindah ke board departemen lain hanya bila tiketnya ia pegang sendiri (403 `ticket.outside_scope`).
- Penanggung jawab = pengguna aktif organisasi yang memegang `tickets.manage`.

### API publik untuk bot (n8n) — scope `tickets:read` / `tickets:write` (`write` mencakup `read`)

| Endpoint | Scope | Keterangan |
|---|---|---|
| `GET /api/v1/public/ticket-boards` | read | Board aktif + kolom + atribut |
| `GET /api/v1/public/tickets` | read | Query seperti web (`assignee=me` ditolak) |
| `POST /api/v1/public/tickets` | write | Body web + `boardId?` (kosong = board aktif pertama), `columnName?` (tanpa beda huruf), `contactPhone?` (E.164, kontak harus sudah ada) → **201** `{ ticket }` |
| `GET /api/v1/public/tickets/:ticketId` | read | |
| `PATCH /api/v1/public/tickets/:ticketId` | write | `{ title?, description?, priority?, assigneeUserId?, dueAt?, attributes?, columnId? \| columnName? }` — pindah kolom = ubah status |
| `POST /api/v1/public/tickets/:ticketId/comments` | write | `{ body }` → **201** `{ comment }` |

Cakupan = seluruh organisasi pemilik key; pelaku = API key (`createdBy.kind = api_key`, riwayat
`actor` key). Tercantum di OpenAPI `/api/docs`.

### Webhook keluar

`ticket.created` (dibuat) dan `ticket.updated` (isian, penanggung jawab, pindah kolom/status,
komentar). `data.ticket = { id, number, board {id,name}, column {id,name,is_done}, title, description,
priority, assignee {id,name}, due_at, closed_at, contact_id, conversation_id, attributes, created_at,
updated_at }` + `data.contact` / `data.conversation` tautan (bila ada) + `data.actor` (pengguna; kosong
bila API key). Dibangun saat dispatch; tiket yang sudah dihapus tidak dikirim. Outbox
`outgoing_events.ticket_id`.

## Departemen

| Endpoint | Izin | Keterangan |
|---|---|---|
| `GET /api/v1/departments` | `inbox.view` | `{ departments: [{ id, name, description, memberCount }] }` |
| `GET /api/v1/settings/departments` | workspace | + `members [{ id, name, role, restricted }]`, `defaultChannelIds`, waktu |
| `POST /api/v1/settings/departments` | workspace | `{ name ≤ 60 (unik tanpa beda huruf), description?, defaultChannelIds? }` → **201** `{ department }`. Maks. 50 |
| `PATCH /api/v1/settings/departments/:departmentId` | workspace | `{ name?, description?, defaultChannelIds? (mengganti) }` |
| `DELETE /api/v1/settings/departments/:departmentId` | workspace | Percakapan/board/channel dilepas dari departemen ini; keanggotaan terhapus |
| `GET`/`PUT /api/v1/settings/department-access/:userId` | workspace | `{ departmentIds, restricted, confirmation? }` → `{ access: { userId, departmentIds, restricted } }` |
| `POST /api/v1/conversations/:conversationId/department` | `inbox.assign` | `{ departmentId \| null }` → `{ conversation \| null }` (null = pelaku tak lagi melihatnya). Log `department_changed` |

- **Departemen bawaan channel**: percakapan BARU dari pelanggan di channel itu langsung masuk
  departemen tersebut (worker pesan masuk). Percakapan dari broadcast/API/mulai percakapan: tanpa
  departemen.
- **"Akses hanya departemen sendiri"** (`restricted`, hanya **Supervisor & CS** — selain itu 400): cakupan
  `all` izin `inbox.view`, `inbox.reply`, `inbox.assign`, `tickets.manage` menjadi `department` =
  percakapan departemennya + yang ia pegang + terkait tiket terbuka yang ia pegang; tiket board
  departemennya + yang ia pegang. Percakapan **tanpa departemen tidak terlihat** — atur departemen
  bawaan channel. Kontak (CRM) tidak disempitkan. Tanda dibaca **segar** di setiap query (tanpa cache
  sesi; berlaku seketika). Owner/Admin tidak pernah disempitkan walau tandanya tertinggal.
- **Real-time**: percakapan dipindah keluar departemen → pengguna bertanda departemen lama yang kehilangan
  akses menerima `conversation.removed`; akses departemen seseorang diubah / departemennya dihapus →
  socket pengguna itu menerima `resync` (event bus `access.changed`, review Info 2).
- **Melonggarkan** (mencabut tanda, atau menambah departemen pada pengguna bertanda) = konfirmasi
  identitas. Menyempitkan tanpa konfirmasi. Audit `department.access_updated` `{ restricted,
  departments, loosened }`.
- `Conversation.department {id,name}|null`, saringan inbox `departmentId=<uuid>|none`, Log percakapan
  `department_changed` (`department`).

## Titik kait berikutnya

- CSAT / laporan: `tickets.closed_at`, `ticket_events` (`closed`/`reopened`/`assigned`), dan
  `conversations.department_id` siap dipakai laporan per departemen.
- Alokasi otomatis per departemen: `channels.default_department_id` + `department_members`.
