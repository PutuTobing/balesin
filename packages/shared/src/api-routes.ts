/**
 * Alamat endpoint API untuk web (dan tes). Semua relatif terhadap alamat API; web memanggilnya
 * lewat proxy `/api` di origin yang sama, selalu dengan `credentials: 'include'`.
 */
export const API_PREFIX = '/api/v1';

export const API_ROUTES = {
  setup: {
    status: `${API_PREFIX}/setup/status`,
    verifyToken: `${API_PREFIX}/setup/verify-token`,
    checkPassword: `${API_PREFIX}/setup/check-password`,
    detectEmailHost: `${API_PREFIX}/setup/email/detect-host`,
    testEmailConnection: `${API_PREFIX}/setup/email/test-connection`,
    sendTestEmail: `${API_PREFIX}/setup/email/send-test`,
    complete: `${API_PREFIX}/setup/complete`,
  },
  auth: {
    login: `${API_PREFIX}/auth/login`,
    logout: `${API_PREFIX}/auth/logout`,
    me: `${API_PREFIX}/auth/me`,
  },
  /**
   * Sesi aktif milik sendiri (docs/KONTRAK-API-AUTH.md bagian "Sesi aktif"). `revoke` memuat
   * parameter `:sessionId` — susun dengan `apiPath`.
   */
  sessions: {
    /** GET (sesi penuh) — sesi yang masih berlaku milik pengguna ini. */
    list: `${API_PREFIX}/auth/sessions`,
    /** DELETE — keluarkan satu sesi lain. */
    revoke: `${API_PREFIX}/auth/sessions/:sessionId`,
    /** POST — keluarkan semua sesi lain (password + kode 2FA bila aktif). */
    revokeOthers: `${API_PREFIX}/auth/sessions/revoke-others`,
  },
  /**
   * Manajemen pengguna (izin `team.manage` = Owner/Admin + matriks kelola `MANAGE_PERMISSIONS`).
   * Path ber-`:userId`/`:sessionId` disusun dengan `apiPath`.
   */
  team: {
    /** GET — semua pengguna organisasi. */
    users: `${API_PREFIX}/users`,
    /** GET — satu pengguna. */
    user: `${API_PREFIX}/users/:userId`,
    /** PUT — ubah peran (+ konfirmasi ulang identitas). */
    role: `${API_PREFIX}/users/:userId/role`,
    /** POST — nonaktifkan (+ konfirmasi ulang identitas). */
    disable: `${API_PREFIX}/users/:userId/disable`,
    /** POST — aktifkan kembali (+ konfirmasi ulang identitas). */
    enable: `${API_PREFIX}/users/:userId/enable`,
    /** POST — atur ulang 2FA (+ konfirmasi ulang identitas). */
    resetTwoFactor: `${API_PREFIX}/users/:userId/2fa/reset`,
    /** POST — buka lagi pendaftaran 2FA yang batas waktunya lewat (+ konfirmasi ulang identitas). */
    reopenTwoFactorEnrollment: `${API_PREFIX}/users/:userId/2fa/enrollment-window`,
    /** POST — buka kunci masuk/2FA (+ konfirmasi ulang identitas). */
    unlock: `${API_PREFIX}/users/:userId/unlock`,
    /** GET — sesi aktif pengguna itu. */
    sessions: `${API_PREFIX}/users/:userId/sessions`,
    /** DELETE — keluarkan satu sesi pengguna itu. */
    revokeSession: `${API_PREFIX}/users/:userId/sessions/:sessionId`,
    /** POST — keluarkan semua sesi pengguna itu (+ konfirmasi ulang identitas). */
    revokeAllSessions: `${API_PREFIX}/users/:userId/sessions/revoke-all`,
  },
  /** Audit log (izin `audit.view` = Owner/Admin). */
  audit: {
    /** GET — daftar bersaring + kursor. */
    list: `${API_PREFIX}/audit-logs`,
    /** GET — CSV (`text/csv`, unduhan) dengan saringan yang sama. */
    export: `${API_PREFIX}/audit-logs/export`,
    /** GET — ringkasan kejadian keamanan 7 hari terakhir (banner peringatan). */
    securitySummary: `${API_PREFIX}/audit-logs/security-summary`,
  },
  /**
   * Undangan (docs/KONTRAK-API-AUTH.md bagian "Undangan"). `resend`/`revoke` memuat parameter
   * `:invitationId` — susun alamatnya dengan `apiPath`.
   */
  invitations: {
    /** GET (Owner/Admin) — daftar undangan tertunda/kedaluwarsa; POST — buat undangan. */
    collection: `${API_PREFIX}/invitations`,
    /** POST (Owner/Admin) — kirim ulang: tautan baru, tautan lama batal. */
    resend: `${API_PREFIX}/invitations/:invitationId/resend`,
    /** DELETE (Owner/Admin) — batalkan undangan. */
    revoke: `${API_PREFIX}/invitations/:invitationId`,
    /** POST (publik) — isi undangan untuk token yang sah. */
    inspect: `${API_PREFIX}/auth/invitation/inspect`,
    /** POST (publik) — terima undangan: nama + password → akun + sesi. */
    accept: `${API_PREFIX}/auth/invitation/accept`,
  },
  /** Atur ulang password (docs/KONTRAK-API-AUTH.md bagian "Atur ulang password"). Semua publik. */
  passwordReset: {
    /** GET — `{ available }`: email pengirim sudah diatur. */
    status: `${API_PREFIX}/auth/password-reset`,
    /** POST — minta tautan (jawaban sama untuk email terdaftar maupun tidak). */
    request: `${API_PREFIX}/auth/password-reset/request`,
    /** POST — isi tautan untuk token yang sah (perlu kode 2FA atau tidak). */
    inspect: `${API_PREFIX}/auth/password-reset/inspect`,
    /** POST — password baru (+ kode 2FA bila aktif). */
    complete: `${API_PREFIX}/auth/password-reset/complete`,
  },
  /** Verifikasi email (docs/KONTRAK-API-AUTH.md bagian "Verifikasi email"). */
  emailVerification: {
    /** GET (sesi) — status verifikasi email akun sendiri; POST (sesi) — kirim tautan verifikasi. */
    status: `${API_PREFIX}/auth/email/verification`,
    /** POST (publik) — token dari tautan → email terverifikasi. */
    verify: `${API_PREFIX}/auth/email/verify`,
  },
  /** Verifikasi dua langkah (docs/KONTRAK-API-AUTH.md bagian 2FA). */
  twoFactor: {
    /** GET — status 2FA pengguna yang sedang masuk. */
    status: `${API_PREFIX}/auth/2fa`,
    /** POST (publik) — langkah kedua saat masuk: tantangan + kode. */
    verify: `${API_PREFIX}/auth/2fa/verify`,
    /** POST — mulai pendaftaran: rahasia baru + URI `otpauth://`. */
    enroll: `${API_PREFIX}/auth/2fa/enroll`,
    /** POST — konfirmasi pendaftaran dengan kode pertama; 2FA aktif + kode cadangan. */
    confirmEnrollment: `${API_PREFIX}/auth/2fa/enroll/confirm`,
    /** POST — buat ulang kode cadangan (password + kode). */
    regenerateBackupCodes: `${API_PREFIX}/auth/2fa/backup-codes`,
    /** POST — nonaktifkan 2FA (hanya peran yang tidak wajib; password + kode). */
    disable: `${API_PREFIX}/auth/2fa/disable`,
  },
  branding: {
    get: `${API_PREFIX}/branding`,
    logo: `${API_PREFIX}/branding/logo`,
    /** GET publik — ikon PNG dari logo (`:file` = `BRAND_ICON_FILES`). */
    icon: `${API_PREFIX}/branding/icons/:file`,
  },
  settings: {
    /** GET/PATCH — Pengaturan → Merek (`organization.manage`, Owner). */
    branding: `${API_PREFIX}/settings/branding`,
    email: `${API_PREFIX}/settings/email`,
    detectEmailHost: `${API_PREFIX}/settings/email/detect-host`,
    testEmailConnection: `${API_PREFIX}/settings/email/test-connection`,
    sendTestEmail: `${API_PREFIX}/settings/email/send-test`,
    /** GET — pratinjau template email (`:template` = `EMAIL_TEMPLATE_IDS`). */
    emailTemplatePreview: `${API_PREFIX}/settings/email/templates/:template/preview`,
  },
  /**
   * Channel (docs/KONTRAK-API-CHANNEL.md). `list` = izin `inbox.view` (semua peran, nama saja);
   * sisanya `channels.manage` (Owner/Admin). Path ber-`:channelId` disusun dengan `apiPath`.
   */
  channels: {
    /** GET — ringkasan channel untuk inbox/filter (tanpa ID Meta maupun petunjuk rahasia). */
    list: `${API_PREFIX}/channels`,
    /** GET — semua channel + status; POST — buat channel (wizard). */
    settings: `${API_PREFIX}/settings/channels`,
    /** GET — satu channel; PATCH — ubah; DELETE — hapus (+ konfirmasi ulang identitas). */
    channel: `${API_PREFIX}/settings/channels/:channelId`,
    /** POST — nonaktifkan. */
    disable: `${API_PREFIX}/settings/channels/:channelId/disable`,
    /** POST — aktifkan kembali. */
    enable: `${API_PREFIX}/settings/channels/:channelId/enable`,
    /** POST — tes koneksi ke Graph API (memperbarui status + data nomor). */
    test: `${API_PREFIX}/settings/channels/:channelId/test`,
    /** GET — URL webhook + verify token. */
    webhook: `${API_PREFIX}/settings/channels/:channelId/webhook`,
    /** GET — diagnosis webhook 24 jam (hitungan, tanpa payload; `channels.manage`). */
    webhookHealth: `${API_PREFIX}/settings/channels/:channelId/webhook-health`,
    /** POST — buat ulang verify token. */
    rotateVerifyToken: `${API_PREFIX}/settings/channels/:channelId/webhook/verify-token`,
    /** GET — profil bisnis dari Meta; PUT — ubah profil bisnis. */
    businessProfile: `${API_PREFIX}/settings/channels/:channelId/business-profile`,
    /** GET/PUT — saklar bot channel, jam kerja bot, batas waktu bot (`integrations.manage`). */
    bot: `${API_PREFIX}/settings/channels/:channelId/bot`,
    /** GET/PUT — akses per channel: semua tim / hanya departemen & pengguna tertentu (`channels.manage`). */
    access: `${API_PREFIX}/settings/channels/:channelId/access`,
  },
  /**
   * Channel selain WhatsApp — Telegram, Email, Messenger, Instagram (Fase 6,
   * docs/KONTRAK-API-CHANNEL-LAIN.md). Semua `channels.manage`.
   */
  channelConnections: {
    /** GET — daftar channel non-WhatsApp + info jenis channel; POST — buat channel. */
    list: `${API_PREFIX}/settings/channel-connections`,
    /** GET — satu channel; PATCH — ubah; DELETE — hapus (+ konfirmasi ulang identitas). */
    channel: `${API_PREFIX}/settings/channel-connections/:channelId`,
    /** POST — nonaktifkan. */
    disable: `${API_PREFIX}/settings/channel-connections/:channelId/disable`,
    /** POST — aktifkan kembali (Messenger/Instagram: wajib tes koneksi berhasil). */
    enable: `${API_PREFIX}/settings/channel-connections/:channelId/enable`,
    /** POST — tes koneksi (Telegram getMe + webhook; Email IMAP + SMTP; Meta Halaman/akun IG). */
    test: `${API_PREFIX}/settings/channel-connections/:channelId/test`,
    /**
     * GET — URL webhook + verify token (Messenger/Instagram). POST — Telegram: pasang ulang webhook
     * (secret baru); Messenger/Instagram: buat ulang verify token.
     */
    webhook: `${API_PREFIX}/settings/channel-connections/:channelId/webhook`,
  },
  /**
   * Rem pengiriman (docs/KONTRAK-API-INBOX.md "Batas kirim & rem darurat"). GET/PUT =
   * `sending.limits.manage`; tarik rem = `sending.limits.manage`; lanjutkan = `sending.resume`.
   */
  sendingLimits: {
    /** GET — batas + status rem; PUT — ubah batas (+ konfirmasi identitas). */
    settings: `${API_PREFIX}/settings/sending-limits`,
    /** POST — tarik rem darurat (hentikan semua pengiriman). */
    pause: `${API_PREFIX}/settings/sending-limits/pause`,
    /** POST — lanjutkan pengiriman (+ konfirmasi identitas). */
    resume: `${API_PREFIX}/settings/sending-limits/resume`,
  },
  /**
   * Inbox (docs/KONTRAK-API-INBOX.md). Percakapan/pesan = `inbox.view`, kontak = `contacts.view`
   * (keduanya bercakupan: Teknisi hanya yang di-assign). Path ber-`:id` disusun dengan `apiPath`.
   */
  inbox: {
    /** GET — daftar percakapan (tab, channel, cari, kursor). */
    conversations: `${API_PREFIX}/conversations`,
    /** GET — jumlah percakapan per tab (saringan sama dengan daftar). */
    counts: `${API_PREFIX}/conversations/counts`,
    /** POST — tandai sudah dibaca (CSRF). */
    read: `${API_PREFIX}/conversations/:conversationId/read`,
    /** POST — mulai percakapan ke nomor (bisa baru) dengan template (`inbox.initiate`). */
    start: `${API_PREFIX}/conversations/start`,
    /** POST `{ active }` — saklar bot per percakapan: matikan (ambil alih/serahkan ke tim) / nyalakan lagi. */
    bot: `${API_PREFIX}/conversations/:conversationId/bot`,
    /** POST — ambil dari antrian terbuka (CSRF, `inbox.assign`). */
    claim: `${API_PREFIX}/conversations/:conversationId/claim`,
    /** POST — tugaskan/alihkan ke agen (CSRF, `inbox.assign`). */
    assign: `${API_PREFIX}/conversations/:conversationId/assign`,
    /** POST — kembalikan ke antrian (CSRF; Teknisi hanya miliknya). */
    unassign: `${API_PREFIX}/conversations/:conversationId/unassign`,
    /** POST — tandai selesai (CSRF, `inbox.reply`). */
    resolve: `${API_PREFIX}/conversations/:conversationId/resolve`,
    /** POST — buka lagi (CSRF, `inbox.reply`). */
    reopen: `${API_PREFIX}/conversations/:conversationId/reopen`,
    /** GET — riwayat penanganan (tab "Log"). */
    events: `${API_PREFIX}/conversations/:conversationId/events`,
    /** GET — daftar agen untuk saringan & penugasan (`inbox.assign`; Teknisi tidak). */
    agents: `${API_PREFIX}/inbox/agents`,
    /** GET (WebSocket) — event inbox real-time. Cookie sesi + `Origin` aplikasi wajib. */
    stream: `${API_PREFIX}/inbox/stream`,
    /** GET — satu percakapan. */
    conversation: `${API_PREFIX}/conversations/:conversationId`,
    /** GET — pesan percakapan, terbaru dulu (kursor = lebih lama); POST — kirim pesan (CSRF). */
    messages: `${API_PREFIX}/conversations/:conversationId/messages`,
    /** POST — unggah media untuk dikirim di percakapan ini (multipart, CSRF). */
    upload: `${API_PREFIX}/conversations/:conversationId/media`,
    /** POST — kirim ulang pesan keluar yang gagal (CSRF). */
    retry: `${API_PREFIX}/messages/:messageId/retry`,
    /** GET — unduh media pesan (CSRF: memakai jatah + menulis cache). */
    media: `${API_PREFIX}/messages/:messageId/media`,
    /** GET — HTML email tersanitasi (pesan channel Email; `inbox.view` + cakupan). */
    emailHtml: `${API_PREFIX}/messages/:messageId/email-html`,
    /** GET — satu kontak (`contacts.view`); PATCH — ubah nama/email/catatan/atribut (`contacts.manage`). */
    contact: `${API_PREFIX}/contacts/:contactId`,
    /** GET — ekspor data satu kontak (JSON, `contacts.export`). DELETE kontak = `contact` (`contacts.delete`). */
    contactExport: `${API_PREFIX}/contacts/:contactId/export`,
    /** POST — pasang tag ke kontak (`contacts.manage`, CSRF). */
    contactTags: `${API_PREFIX}/contacts/:contactId/tags`,
    /** DELETE — lepas tag dari kontak (`contacts.manage`, CSRF). */
    contactTag: `${API_PREFIX}/contacts/:contactId/tags/:tagId`,
    /** GET — catatan sesi (`inbox.view`); POST — tambah (`inbox.reply`, CSRF). */
    notes: `${API_PREFIX}/conversations/:conversationId/notes`,
    /** PATCH — ubah (penulis); DELETE — hapus (penulis / `inbox.notes.moderate`). */
    note: `${API_PREFIX}/conversations/:conversationId/notes/:noteId`,
    /** PUT — tandai pesan; DELETE — lepas tanda (`inbox.reply`, CSRF). */
    star: `${API_PREFIX}/messages/:messageId/star`,
    /** GET — status rem darurat pengiriman `{ paused }` untuk banner (`inbox.view`). */
    sendingStatus: `${API_PREFIX}/inbox/sending-status`,
    /** GET/PUT — saklar ketersediaan agen sendiri untuk alokasi otomatis (`inbox.reply`). */
    availability: `${API_PREFIX}/inbox/availability`,
    /** POST — pindahkan percakapan ke departemen / lepas (`inbox.assign`, CSRF). */
    department: `${API_PREFIX}/conversations/:conversationId/department`,
  },
  /**
   * CRM Fase 5 (docs/KONTRAK-API-CRM-TIKET.md). Daftar = `contacts.view` (bercakupan); impor/ekspor
   * massal = `contacts.export`; gabung = `contacts.manage`; definisi atribut: lihat `contacts.view`,
   * kelola `settings.workspace.manage`.
   */
  crm: {
    /** GET — daftar & cari kontak (kursor). */
    contacts: `${API_PREFIX}/contacts`,
    /** POST — ekspor CSV massal (+ konfirmasi identitas). */
    exportContacts: `${API_PREFIX}/contacts/export`,
    /** POST multipart — impor CSV/XLSX (`mapping` + `file`). */
    importContacts: `${API_PREFIX}/contacts/import`,
    /** POST — gabung kontak lain ke kontak ini (+ konfirmasi identitas). */
    merge: `${API_PREFIX}/contacts/:contactId/merge`,
    /** GET — definisi atribut kontak; POST — buat. */
    attributes: `${API_PREFIX}/contact-attributes`,
    /** PATCH — ubah; DELETE — hapus definisi (nilai tetap tersimpan sebagai atribut bebas). */
    attribute: `${API_PREFIX}/contact-attributes/:attributeId`,
  },
  /**
   * Tiket Fase 5. Lihat/ubah tiket = `tickets.manage` (bercakupan); board/kolom/atribut =
   * `tickets.configure`.
   */
  tickets: {
    /** GET — daftar; POST — buat. */
    list: `${API_PREFIX}/tickets`,
    /** GET — detail; PATCH — ubah; DELETE — hapus (`tickets.configure`). */
    ticket: `${API_PREFIX}/tickets/:ticketId`,
    /** POST — pindah kolom / urutan Kanban. */
    move: `${API_PREFIX}/tickets/:ticketId/move`,
    /** GET — komentar; POST — tambah. */
    comments: `${API_PREFIX}/tickets/:ticketId/comments`,
    /** DELETE — hapus komentar (penulis / `tickets.configure`). */
    comment: `${API_PREFIX}/tickets/:ticketId/comments/:commentId`,
    /** GET — riwayat. */
    events: `${API_PREFIX}/tickets/:ticketId/events`,
    /** GET — daftar board (`tickets.manage`); POST — buat (`tickets.configure`). */
    boards: `${API_PREFIX}/ticket-boards`,
    /** PATCH — ubah/arsipkan board (`tickets.configure`). */
    board: `${API_PREFIX}/ticket-boards/:boardId`,
    /** GET — tampilan Kanban (`tickets.manage`). */
    kanban: `${API_PREFIX}/ticket-boards/:boardId/kanban`,
    /** POST — tambah kolom. */
    columns: `${API_PREFIX}/ticket-boards/:boardId/columns`,
    /** PATCH — ubah kolom; DELETE — hapus (tiket dipindah). */
    column: `${API_PREFIX}/ticket-boards/:boardId/columns/:columnId`,
    /** POST — tambah definisi atribut board. */
    attributes: `${API_PREFIX}/ticket-boards/:boardId/attributes`,
    /** PATCH/DELETE — definisi atribut board. */
    attribute: `${API_PREFIX}/ticket-boards/:boardId/attributes/:attributeId`,
  },
  /**
   * Departemen Fase 5. Daftar nama = `inbox.view`; kelola & akses pengguna =
   * `settings.workspace.manage`.
   */
  /**
   * Pengaturan kerja tim (Fase 5): jam kerja tim + hari libur, pesan otomatis, alokasi agen
   * (`settings.workspace.manage`).
   */
  workspace: {
    /** GET/PUT — jam kerja, hari libur, pesan otomatis, mode alokasi & kapasitas. */
    settings: `${API_PREFIX}/settings/workspace`,
    /** GET — agen untuk alokasi otomatis (tersedia, dikecualikan, beban). */
    agents: `${API_PREFIX}/settings/workspace/agents`,
    /** PATCH — `{ available?, excluded? }` seorang agen. */
    agent: `${API_PREFIX}/settings/workspace/agents/:userId`,
  },
  departments: {
    /** GET — nama departemen. */
    list: `${API_PREFIX}/departments`,
    /** GET — lengkap (anggota, channel bawaan); POST — buat. */
    settings: `${API_PREFIX}/settings/departments`,
    /** PATCH — ubah; DELETE — hapus. */
    department: `${API_PREFIX}/settings/departments/:departmentId`,
    /** GET/PUT — departemen & tanda "akses departemen sendiri" seorang pengguna. */
    access: `${API_PREFIX}/settings/department-access/:userId`,
  },
  /** Pengaturan → API key (`api_keys.manage`, Fase 3; docs/KONTRAK-API-PUBLIK.md). */
  apiKeys: {
    /** GET — daftar; POST — buat (+ konfirmasi identitas; rahasia ditampilkan SEKALI). */
    list: `${API_PREFIX}/settings/api-keys`,
    /** POST — cabut (seketika). */
    revoke: `${API_PREFIX}/settings/api-keys/:apiKeyId/revoke`,
    /** PATCH — ubah pengirim email & host lampiran (tahap 9.1, + konfirmasi identitas). */
    key: `${API_PREFIX}/settings/api-keys/:apiKeyId`,
    /** GET/PUT — pengaturan API publik (dokumentasi `/api/docs` aktif/mati). */
    settings: `${API_PREFIX}/settings/api`,
  },
  /** Pengaturan → Webhook keluar (`integrations.manage`, Fase 3; docs/KONTRAK-WEBHOOK-KELUAR.md). */
  outgoingWebhooks: {
    /** GET — daftar; POST — buat (+ konfirmasi; rahasia tampil SEKALI). */
    list: `${API_PREFIX}/settings/webhooks`,
    /** PATCH — ubah (URL baru = konfirmasi); DELETE — hapus. */
    webhook: `${API_PREFIX}/settings/webhooks/:webhookId`,
    /** POST — rotasi rahasia (+ konfirmasi; lama tetap ditandatangani 24 jam). */
    rotateSecret: `${API_PREFIX}/settings/webhooks/:webhookId/rotate-secret`,
    /** POST — kirim event uji `webhook.test`. */
    test: `${API_PREFIX}/settings/webhooks/:webhookId/test`,
    /** GET — riwayat pengiriman (terbaru dulu). */
    deliveries: `${API_PREFIX}/settings/webhooks/:webhookId/deliveries`,
    /** POST — kirim ulang satu pengiriman. */
    redeliver: `${API_PREFIX}/settings/webhooks/:webhookId/deliveries/:deliveryId/redeliver`,
    /** GET/PUT — allowlist IP privat (PUT + konfirmasi). */
    privateNetwork: `${API_PREFIX}/settings/webhooks-private-network`,
  },
  /**
   * API publik v1 (`Authorization: Bearer blsn_live_…`, tanpa cookie/CSRF). Scope per rute di
   * docs/KONTRAK-API-PUBLIK.md. OpenAPI: `/api/docs/openapi.json`; halaman: `/api/docs`.
   */
  publicApi: {
    conversations: `${API_PREFIX}/public/conversations`,
    conversation: `${API_PREFIX}/public/conversations/:conversationId`,
    messages: `${API_PREFIX}/public/conversations/:conversationId/messages`,
    upload: `${API_PREFIX}/public/conversations/:conversationId/media`,
    message: `${API_PREFIX}/public/messages/:messageId`,
    /** POST — kirim template ke nomor (`messages:initiate`). */
    templateMessage: `${API_PREFIX}/public/messages/template`,
    /** POST — bot menyerahkan percakapan ke tim (`conversations:write`). */
    handoff: `${API_PREFIX}/public/conversations/:conversationId/handoff`,
    contacts: `${API_PREFIX}/public/contacts`,
    contact: `${API_PREFIX}/public/contacts/:contactId`,
    contactTags: `${API_PREFIX}/public/contacts/:contactId/tags`,
    /** GET — board + kolom (`tickets:read`). */
    ticketBoards: `${API_PREFIX}/public/ticket-boards`,
    /** GET — cari (`tickets:read`); POST — buat (`tickets:write`). */
    tickets: `${API_PREFIX}/public/tickets`,
    /** GET (`tickets:read`) / PATCH (`tickets:write`). */
    ticket: `${API_PREFIX}/public/tickets/:ticketId`,
    /** POST — komentar (`tickets:write`). */
    ticketComments: `${API_PREFIX}/public/tickets/:ticketId/comments`,
  },
  /**
   * Tahap 9.1 — kirim email lewat API (docs/KONTRAK-API-EMAIL-KIRIM.md §3). Baca = `email:read`,
   * kirim/batal/balas/unggah = `email:send`.
   */
  publicEmail: {
    senders: `${API_PREFIX}/public/email/senders`,
    send: `${API_PREFIX}/public/email/send`,
    media: `${API_PREFIX}/public/email/media`,
    message: `${API_PREFIX}/public/email/messages/:emailId`,
    cancel: `${API_PREFIX}/public/email/messages/:emailId/cancel`,
    templates: `${API_PREFIX}/public/email/templates`,
    /** `:emailId` = ID pesan Inbox email MASUK yang dibalas. */
    reply: `${API_PREFIX}/public/email/messages/:emailId/reply`,
  },
  /**
   * Pengaturan → Template email (tahap 9.1, `templates.manage`). Terbit = konfirmasi identitas; kirim
   * tes selalu ke alamat akun sendiri.
   */
  emailTemplates: {
    /** GET — daftar (`?q=&archived=`); POST — buat. */
    list: `${API_PREFIX}/settings/email-templates`,
    /** GET — detail (draf + terbit); PATCH — ubah nama/slug/draf. */
    template: `${API_PREFIX}/settings/email-templates/:templateId`,
    publish: `${API_PREFIX}/settings/email-templates/:templateId/publish`,
    archive: `${API_PREFIX}/settings/email-templates/:templateId/archive`,
    unarchive: `${API_PREFIX}/settings/email-templates/:templateId/unarchive`,
    versions: `${API_PREFIX}/settings/email-templates/:templateId/versions`,
    version: `${API_PREFIX}/settings/email-templates/:templateId/versions/:versionId`,
    restore: `${API_PREFIX}/settings/email-templates/:templateId/versions/:versionId/restore`,
    /** POST — pratinjau isi (tanpa menyimpan). */
    preview: `${API_PREFIX}/settings/email-templates/preview`,
    /** POST — kirim tes ke alamat akun sendiri. */
    test: `${API_PREFIX}/settings/email-templates/:templateId/test`,
    /** GET — 6 preset ISP. */
    presets: `${API_PREFIX}/settings/email-templates/presets`,
    /** POST — template baru dari preset. */
    fromPreset: `${API_PREFIX}/settings/email-templates/presets/:presetId`,
  },
  /**
   * Pengaturan → Batas kirim → "Email per pengirim" (tahap 9.1): lihat/ubah/jeda =
   * `sending.limits.manage`; lanjutkan = `sending.resume`.
   */
  emailSenders: {
    list: `${API_PREFIX}/settings/email-senders`,
    /** PUT — batas per jam (menaikkan = konfirmasi identitas). */
    sender: `${API_PREFIX}/settings/email-senders/:senderId`,
    pause: `${API_PREFIX}/settings/email-senders/:senderId/pause`,
    resume: `${API_PREFIX}/settings/email-senders/:senderId/resume`,
  },
  /** Pengaturan → API key → "Email terkirim" (tahap 9.1, `api_keys.manage`; penerima tersamar). */
  emailOutbound: {
    list: `${API_PREFIX}/settings/email-outbound`,
  },

  /**
   * Template Meta (Fase 4, docs/KONTRAK-API-TEMPLATE.md). Daftar/detail = `inbox.reply` (agen memilih
   * template); kelola (buat, ubah, ajukan, hapus, sinkron, preset) = `templates.manage`.
   */
  templates: {
    list: `${API_PREFIX}/templates`,
    template: `${API_PREFIX}/templates/:templateId`,
    submit: `${API_PREFIX}/templates/:templateId/submit`,
    sync: `${API_PREFIX}/templates/sync`,
    presets: `${API_PREFIX}/templates/presets`,
    fromPreset: `${API_PREFIX}/templates/presets/:presetId`,
  },
  /**
   * Broadcast / kampanye (Fase 4, docs/KONTRAK-API-BROADCAST.md). Lihat & kelola kampanye =
   * `broadcast.send`; setujui/tolak = `broadcast.approve`; ekspor CSV laporan = `contacts.export`
   * (data pribadi; GET ber-CSRF). Path ber-`:broadcastId` disusun dengan `apiPath`.
   */
  broadcasts: {
    /** GET — daftar; POST — buat draf. */
    list: `${API_PREFIX}/broadcasts`,
    /** GET — detail; PATCH — ubah draf; DELETE — hapus draf. */
    broadcast: `${API_PREFIX}/broadcasts/:broadcastId`,
    /** POST multipart (`file`) — penerima dari CSV/XLSX (mengganti penerima sebelumnya). */
    upload: `${API_PREFIX}/broadcasts/:broadcastId/recipients/upload`,
    /** POST — penerima dari segmen kontak (tag/atribut). */
    segment: `${API_PREFIX}/broadcasts/:broadcastId/recipients/segment`,
    /** POST — penerima dari konektor REST. */
    connector: `${API_PREFIX}/broadcasts/:broadcastId/recipients/connector`,
    /** GET — daftar penerima + status pesan. */
    recipients: `${API_PREFIX}/broadcasts/:broadcastId/recipients`,
    /** GET — pratinjau per penerima (beberapa baris contoh). */
    preview: `${API_PREFIX}/broadcasts/:broadcastId/preview`,
    /** GET — estimasi biaya. */
    estimate: `${API_PREFIX}/broadcasts/:broadcastId/estimate`,
    /** POST — ajukan (jadwalkan / minta persetujuan) + konfirmasi identitas. */
    submit: `${API_PREFIX}/broadcasts/:broadcastId/submit`,
    /** POST — setujui (`broadcast.approve`, bukan pembuat) + konfirmasi identitas. */
    approve: `${API_PREFIX}/broadcasts/:broadcastId/approve`,
    /** POST — tolak (`broadcast.approve`) → kembali ke draf. */
    reject: `${API_PREFIX}/broadcasts/:broadcastId/reject`,
    /** POST — jeda seketika. */
    pause: `${API_PREFIX}/broadcasts/:broadcastId/pause`,
    /** POST — lanjutkan (+ konfirmasi identitas; setelah rem otomatis butuh `sending.resume`). */
    resume: `${API_PREFIX}/broadcasts/:broadcastId/resume`,
    /** POST — batalkan (penerima tertunda tidak dikirim). */
    cancel: `${API_PREFIX}/broadcasts/:broadcastId/cancel`,
    /** GET — laporan kampanye. */
    report: `${API_PREFIX}/broadcasts/:broadcastId/report`,
    /** GET (CSRF) — ekspor CSV laporan per penerima (`contacts.export`, diaudit). */
    exportCsv: `${API_PREFIX}/broadcasts/:broadcastId/report/export`,
    /** GET — pilihan konektor untuk pembuat kampanye (ID + nama). */
    connectorOptions: `${API_PREFIX}/broadcasts/connectors`,
    /** GET/PUT — pengaturan broadcast (ambang, cadangan kuota, rem otomatis, tarif). */
    settings: `${API_PREFIX}/settings/broadcast`,
    /** GET/POST — konektor REST (`integrations.manage`). */
    connectors: `${API_PREFIX}/settings/broadcast-connectors`,
    /** PATCH/DELETE — satu konektor. */
    connectorItem: `${API_PREFIX}/settings/broadcast-connectors/:connectorId`,
    /** POST — tes ambil data. */
    connectorTest: `${API_PREFIX}/settings/broadcast-connectors/:connectorId/test`,
  },
  /** Alarm sistem ke Telegram (`integrations.manage`). */
  alarms: {
    /** GET/PUT/DELETE — token bot (terenkripsi) + ID chat. */
    telegram: `${API_PREFIX}/settings/alarms/telegram`,
    /** POST — kirim pesan tes. */
    telegramTest: `${API_PREFIX}/settings/alarms/telegram/test`,
  },
  /** Notifikasi Web Push (butir 10, docs/KONTRAK-API-NOTIFIKASI.md). */
  notifications: {
    /** GET — kunci publik VAPID (sesi). */
    vapidPublicKey: `${API_PREFIX}/notifications/vapid-public-key`,
    /** POST — daftarkan perangkat ini; DELETE — lepas (CSRF, sesi). */
    subscriptions: `${API_PREFIX}/notifications/subscriptions`,
    /** GET/PUT — preferensi notifikasi pengguna sendiri (sesi). */
    preferences: `${API_PREFIX}/notifications/preferences`,
    /** POST — kirim notifikasi tes ke perangkat sendiri (CSRF, sesi). */
    test: `${API_PREFIX}/notifications/test`,
    /** GET/PUT — pengaturan organisasi: cuplikan isi pesan (`organization.manage`). */
    settings: `${API_PREFIX}/settings/notifications`,
  },
  /** Master tag (butir 8): lihat = `inbox.view`; buat = `contacts.manage`; ubah/hapus = `settings.workspace.manage`. */
  tags: {
    /** GET — semua tag organisasi; POST — buat tag. */
    list: `${API_PREFIX}/tags`,
    /** PATCH — ganti nama/warna; DELETE — hapus (dilepas dari semua kontak). */
    tag: `${API_PREFIX}/tags/:tagId`,
  },
  /**
   * Modul Email (Fase 9 tahap 9A, docs/KONTRAK-API-EMAIL.md). Izin rute `mail.view` (semua peran);
   * hak nyata per akun (`resolveMailAccess`). Path ber-`:accountId`/`:folderId`/`:userId` disusun
   * dengan `apiPath`. Bagian 2 (daftar/baca/aksi) menambah rute `messages*`/`view*` di sini.
   */
  mail: {
    /** GET — kartu penyedia (cPanel/IMAP tersedia; Microsoft/Google/POP3 "Segera hadir"). */
    providers: `${API_PREFIX}/mail/providers`,
    /** POST — deteksi server dari alamat (`mail.private.own` atau `mail.accounts.manage`). */
    detect: `${API_PREFIX}/mail/accounts/detect`,
    /** POST — tes Masuk/Keluar tanpa menyimpan. */
    test: `${API_PREFIX}/mail/accounts/test`,
    /** GET — akun yang bisa kuakses; POST — buat akun. */
    accounts: `${API_PREFIX}/mail/accounts`,
    /** GET/PATCH/DELETE — satu akun (DELETE = putuskan, 202). */
    account: `${API_PREFIX}/mail/accounts/:accountId`,
    /** POST — tes dengan kredensial tersimpan (level `manage`). */
    accountTest: `${API_PREFIX}/mail/accounts/:accountId/test`,
    /** POST — sinkron sekarang (202). */
    accountSync: `${API_PREFIX}/mail/accounts/:accountId/sync`,
    /** POST — jeda sinkron. */
    accountPause: `${API_PREFIX}/mail/accounts/:accountId/pause`,
    /** POST — lanjutkan sinkron. */
    accountResume: `${API_PREFIX}/mail/accounts/:accountId/resume`,
    /** GET (`image/png`) / PUT / DELETE — foto akun. */
    accountAvatar: `${API_PREFIX}/mail/accounts/:accountId/avatar`,
    /** GET/PUT — akses akun (`mail.accounts.manage`; GET juga level `manage`). */
    accountAccess: `${API_PREFIX}/mail/accounts/:accountId/access`,
    /** GET — folder akun (level `read`). */
    accountFolders: `${API_PREFIX}/mail/accounts/:accountId/folders`,
    /** GET — kolom kiri: gabungan + akun + folder. */
    sidebar: `${API_PREFIX}/mail/sidebar`,
    /** GET — Pengaturan → Akun email (termasuk metadata akun pribadi orang lain untuk Owner/Admin). */
    settingsAccounts: `${API_PREFIX}/settings/mail-accounts`,
    /** GET/PUT — Pengaturan email (retensi cache, jendela sinkron bawaan). */
    settings: `${API_PREFIX}/settings/mail`,
    /** GET/PUT — Pengaturan → Tim → [pengguna] → tab Akses email. */
    teamAccess: `${API_PREFIX}/settings/team/:userId/mail-access`,
    // ── Bagian 2: daftar, baca, aksi (kontrak §7–§9) ──
    /** GET — daftar email (`view` = inboxes/unread/starred/folder, kursor). */
    messages: `${API_PREFIX}/mail/messages`,
    /** POST — aksi dua arah (≤ 100 ID): dibaca/bintang/pindah/arsip/sampah/spam/hapus permanen. */
    messageActions: `${API_PREFIX}/mail/messages/actions`,
    /** GET — detail satu email (isi belum ada → `body.state: "loading"` + job ambil isi). */
    message: `${API_PREFIX}/mail/messages/:messageId`,
    /** POST — URL dokumen tampilan ber-token (10 menit) untuk iframe sandbox. */
    messageView: `${API_PREFIX}/mail/messages/:messageId/view`,
    /** GET — header mentah (`text/plain`, ≤ 64 KB). */
    messageSource: `${API_PREFIX}/mail/messages/:messageId/source`,
    /** GET (token, tanpa cookie) — dokumen HTML tersanitasi ber-CSP sendiri. */
    view: `${API_PREFIX}/mail/view/:token`,
    /** GET (token) — proksi gambar luar ke-`index`. */
    viewImage: `${API_PREFIX}/mail/view/:token/images/:index`,
    /** GET (token) — gambar inline `cid:` milik email itu. */
    viewCid: `${API_PREFIX}/mail/view/:token/cid/:attachmentId`,
    /** GET — unduh lampiran (`?confirm=1` untuk arsip). */
    attachment: `${API_PREFIX}/mail/attachments/:attachmentId`,
    /** GET — pratinjau gambar raster lampiran (inline). */
    attachmentPreview: `${API_PREFIX}/mail/attachments/:attachmentId/preview`,
    /** GET/POST/DELETE — "Selalu tampilkan gambar dari pengirim ini" milik pengguna. */
    remoteImageSenders: `${API_PREFIX}/mail/remote-image-senders`,
  },
  /** Quick reply `/` (butir 9): pakai = `inbox.reply`; kelola = `quick_replies.manage`. */
  quickReplies: {
    /** GET — daftar + cari (`inbox.reply`); POST — buat (`quick_replies.manage`). */
    list: `${API_PREFIX}/quick-replies`,
    /** PATCH — ubah; DELETE — hapus (`quick_replies.manage`). */
    quickReply: `${API_PREFIX}/quick-replies/:quickReplyId`,
    /** POST — isi variabel untuk percakapan + naikkan penghitung (`inbox.reply` + cakupan). */
    use: `${API_PREFIX}/quick-replies/:quickReplyId/use`,
  },
} as const;

/**
 * Penerima webhook dari luar (Meta). SENGAJA di luar `API_PREFIX`: alamatnya ditempel pengguna di Meta
 * App Dashboard (`<API_URL>/webhooks/whatsapp/<channelId>`, lihat `webhookUrlFor` di api), jadi tidak
 * boleh ikut berubah bila versi API web naik. Publik (tanpa sesi/CSRF) — keasliannya dari tanda
 * tangan Meta (docs/KONTRAK-API-CHANNEL.md bagian "Penerima webhook").
 */
export const WEBHOOK_ROUTES = {
  /** GET — jabat tangan verifikasi Meta; POST — notifikasi (pesan masuk, status, error). */
  whatsapp: '/webhooks/whatsapp/:channelId',
  /** POST — update Bot API Telegram; keaslian dari header `X-Telegram-Bot-Api-Secret-Token`. */
  telegram: '/webhooks/telegram/:channelId',
  /** GET — jabat tangan Meta; POST — notifikasi Messenger (tanda tangan App Secret). */
  messenger: '/webhooks/messenger/:channelId',
  /** GET — jabat tangan Meta; POST — notifikasi Instagram DM (tanda tangan App Secret). */
  instagram: '/webhooks/instagram/:channelId',
} as const;

/**
 * Mengisi parameter `:nama` di path `API_ROUTES`. Nilai di-encode; parameter yang tidak diisi
 * membuat fungsi melempar (salah pakai, bukan input pengguna).
 */
export function apiPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Parameter "${name}" belum diisi untuk ${template}`);
    return encodeURIComponent(value);
  });
}

/**
 * Dokumentasi API publik (Fase 3) — DI LUAR `API_PREFIX`: halaman statis + OpenAPI, publik (tanpa
 * sesi), bisa dimatikan Pengaturan → API.
 */
export const API_DOCS_ROUTES = {
  page: '/api/docs',
  style: '/api/docs/app.css',
  script: '/api/docs/app.js',
  openapi: '/api/docs/openapi.json',
} as const;
