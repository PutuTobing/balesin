# Review keamanan — Fase 6: Channel Telegram, Email (IMAP/SMTP), Messenger & Instagram

- Commit: `f335d9c` (`feat(channel): Telegram, Email (IMAP/SMTP), Messenger & IG (nonaktif bawaan); …`)
- Kontrak: `docs/KONTRAK-API-CHANNEL-LAIN.md`, DECISIONS 2026-11-22
- Peninjau: subagent `security`
- Model ancaman: pihak luar tanpa akun yang mengirim webhook/email palsu (memalsukan Telegram/Meta,
  memalsukan pengirim email, HTML/lampiran berbahaya); akun Admin yang dibobol memakai konfigurasi IMAP
  untuk SSRF; kebocoran token bot/app secret/password IMAP.

## Putusan: **AMAN**

Tidak ada temuan Kritis/Tinggi/Sedang. 1 Rendah (pengirim email tanpa hasil pemeriksaan dianggap
terverifikasi), beberapa Info.

---

## A. Yang diperiksa dan lolos

| Area | Bukti | Hasil |
|---|---|---|
| Telegram — keaslian | `apps/api/src/modules/webhooks/channel-webhooks.service.ts:157-170` | `X-Telegram-Bot-Api-Secret-Token` wajib, dibandingkan `constantTimeEqual`; tanpa/salah → 403 + penolakan tercatat di penjaga (batas laju sama dengan WhatsApp); channel nonaktif dibuang (200) SETELAH cek rahasia |
| Telegram — isi | `packages/core/src/channels/telegram-update.ts:140-180` | hanya chat `private`, bukan dari bot (tes baru: supergroup/channel/group/bot ditolak); idempoten `(channel_id, dedup_key = tg:<update_id>)` unik; kejadian terlalu lama dibuang |
| Telegram — keluar & berkas | `packages/core/src/channels/telegram-bot.ts` | host tetap `api.telegram.org` (lain hanya loopback tes), `redirect: 'error'`, batas waktu & ukuran (≤ 20 MB), `file_path` dibatasi `^[A-Za-z0-9_./-]+$` tanpa `..`; token terenkripsi, terpisah dari token alarm; `setWebhook` hanya bila `API_URL` https publik |
| Email — IMAP | `packages/core/src/channels/email-imap.ts`, `packages/core/src/mail/host-guard.ts` | TLS wajib (993 SSL/TLS atau 143 STARTTLS wajib, tidak pernah turun ke teks polos), sertifikat diverifikasi (TLS ≥ 1.2, SNI); port daftar izin; host di-resolve sekali, link-local/metadata cloud/multicast/cadangan diblokir, koneksi ke IP terperiksa; batas waktu & ukuran literal; galat = kode (balasan server tidak diteruskan) |
| Email — HTML | `packages/core/src/channels/email-message.ts:194-236` | `sanitize-html` daftar izin ketat: tanpa `style`/`class`/`id`/event/gambar/form/iframe/svg/math/meta/base; skema hanya http/https/mailto, tanpa protocol-relative; `<a>` dipaksa `rel="noopener noreferrer nofollow" target=_blank`. Tes baru: 17 vektor (`javascript:` campur huruf/tab-entity, `data:`, `vbscript:`, `//host`, `onerror`, `<svg><script>`, `<meta refresh>`, `<base>`, `<math xlink:href>`, CSS `url()`) dibuang |
| Email — endpoint HTML | `apps/api/src/modules/messages/outbound.routes.ts:227-244`, `outbound.service.ts:1271-1285` | `inbox.view` + cakupan (`scopedMessage`), `private, no-store`, jawaban JSON `{ html }` (bukan dokumen HTML) — web wajib `iframe sandbox` + `srcdoc` (dicek saat review UI) |
| Email — lampiran | `email-message.ts:280-357` | ≤ 20 MB, ≤ 10; ekstensi eksekusi/HTML/SVG dilewati; jenis dari ISI (`detectMedia` + pemeriksaan wadah Office → makro ditolak); jenis tak dikenal = `application/octet-stream` (selalu diunduh). Tes baru: `MZ` bernama `.pdf`, HTML, SVG tidak pernah menjadi pdf/html/svg |
| Email — utas & anti-loop | `apps/worker/src/inbound/channel-inbound.ts:186-192`, `email-message.ts:105-140,422-431` | `In-Reply-To` hanya menaut pesan di channel + KONTAK yang sama (tidak bisa menyusup ke percakapan kontak lain); balasan otomatis/bounce/email sendiri dilewati; balasan keluar `Auto-Submitted` untuk pesan otomatis |
| Email — header keluar | `packages/core/src/mail/smtp.ts:357-384` | CR/LF di subjek / `In-Reply-To` / `References` hasil email masuk tidak menyisipkan header (tes baru dengan nodemailer composer: tidak ada `Bcc:` tersisip) |
| Messenger/IG | `packages/core/src/channels/meta-social.ts`, `channel-webhooks.service.ts:216-287` | `hub.verify_token` waktu-konstan; `X-Hub-Signature-256` atas body mentah; `entry[].id` wajib Halaman/akun IG channel (tes baru: entri Halaman lain → `misrouted`, tidak ada item); echo diabaikan; lampiran hanya `https` ke `*.fbcdn.net`/`*.fbsbx.com`/`*.cdninstagram.com` (akhiran bertitik, tanpa kredensial/port); dibuat nonaktif sampai App Review + tes |
| Kelola channel | `apps/api/src/modules/channel-connections/*` | `channels.manage`; buat/ganti kredensial/hapus = konfirmasi identitas; rahasia terenkripsi & tersamar; audit tanpa nilai rahasia; CS & Teknisi ditolak, organisasi lain 404 (tes lama) |
| Kontak lintas channel | `contacts.repo.ts`, `crm.service.ts` | identitas `external_user_id` per jenis channel; hapus kontak mencocokkan payload via `payloadMatchesIdentity`; gabung ditolak bila identitas eksternal beda (tes lama) |
| Dependensi baru | `packages/core/package.json` (`imapflow` 2.12.1, `mailparser` 3.14.5, `sanitize-html` 2.18.2, `nodemailer` 10.5.0) | versi dipin; `pnpm audit` tidak memuat satu pun (hanya 3 lama: picomatch build-only + 2 moderate dev) |
| Sertifikat tes | `packages/core/src/channels/testing/test-cert.ts`, `ImapPolicy.testCa` | hanya dipakai server IMAP tiruan di tes; produksi tidak punya jalur mengisinya |

---

## B. Temuan

### R1 (Rendah) — Email tanpa `Authentication-Results` dianggap terverifikasi (pemalsuan pengirim)

- Bukti: `packages/core/src/channels/email-message.ts:142-148` — `emailAuthWarning` hanya `true` bila
  server penerima MELAPORKAN gagal (DMARC fail / SPF fail tanpa DKIM pass); header kosong → `false`.
- Dampak: identitas kontak email = alamat `From`. Siapa pun bisa mengirim email ber-`From` alamat
  pelanggan X; bila server IMAP organisasi tidak menambahkan `Authentication-Results` (server mandiri /
  penyedia kecil), pesan masuk ke percakapan X TANPA peringatan — agen bisa menindaklanjuti permintaan
  palsu (ganti alamat, kirim data). Penyedia besar (Gmail/Outlook) menambahkan header sehingga kasus
  umum tertangani.
- Perbaikan: anggap "belum terverifikasi" bila tidak ada hasil `dmarc=pass`/`dkim=pass` dari
  `authserv-id` tepercaya (bisa diatur per channel, bawaan = host IMAP); tampilkan label netral
  "pengirim tidak diverifikasi server" di UI.
- Tes: `it.fails` "R1: tanpa Authentication-Results…" — gagal di `expected false to be true`.

---

## C. Info

1. **IMAP ke jaringan privat/loopback diizinkan** (sama dengan SMTP kustom, `host-guard`): Admin dengan
   konfirmasi identitas bisa membuat worker menyambung ke host LAN di port 993/143 dengan TLS; hasil
   hanya kode (`imap_host_blocked`/koneksi/TLS) → pemindaian port internal sangat terbatas.
2. **Nama profil channel tidak tepercaya** (`nameSource: channel`) — kontrak sudah mewajibkan UI
   menampilkan `channelHandle` di sampingnya; cek saat review UI.
3. **`GET /messages/:id/email-html`** mengembalikan HTML tersanitasi sebagai JSON; keamanan akhir
   tergantung UI memakai `iframe sandbox` tanpa `allow-scripts`/`allow-same-origin` (pola pratinjau email
   pengirim sudah ada dan dites).
4. **Telegram `callback_query` tanpa `message`** (tombol inline mode) tidak diperiksa jenis chatnya;
   bot tidak memakai inline mode, data hanya ID tombol — dampak tidak ada.

---

## D. Tes penjaga

Berkas baru: `packages/core/src/channels/security-review-fase6-channel.test.ts` — 7 `it` + 1 `it.fails`:
sanitasi HTML (17 vektor) & tautan sah; header keluar tidak tersisip CR/LF; lampiran eksekusi/HTML/SVG;
Telegram hanya chat pribadi & bukan bot; Messenger entri Halaman lain ditolak; peringatan DMARC gagal
tetap muncul walau ada `pass` palsu; `it.fails` R1.

## E. Hasil perintah

| Perintah | Hasil |
|---|---|
| `packages/core`: penjaga baru | 7 lulus + 1 `it.fails` (salinan tanpa `.fails` gagal tepat di R1, sudah dihapus) |
| `apps/api`: `vitest run src/modules/channel-connections src/modules/webhooks src/modules/workspace crm.integration src/modules/messages rbac-matrix` | 95 lulus, 10 berkas |
| `packages/core`: `vitest run src/channels src/mail` | 125 lulus |
| `apps/worker`: `vitest run src/queues src/inbound` | 131 lulus |
| `tsc --noEmit` (api, worker) + ESLint berkas tes baru | bersih |
| `pnpm audit` | 1 high build-only + 2 moderate dev-only (tidak ada dari dependensi baru) |
