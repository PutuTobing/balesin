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
  },
  settings: {
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
    /** POST — buat ulang verify token. */
    rotateVerifyToken: `${API_PREFIX}/settings/channels/:channelId/webhook/verify-token`,
    /** GET — profil bisnis dari Meta; PUT — ubah profil bisnis. */
    businessProfile: `${API_PREFIX}/settings/channels/:channelId/business-profile`,
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
    /** GET (WebSocket) — event inbox real-time. Cookie sesi + `Origin` aplikasi wajib. */
    stream: `${API_PREFIX}/inbox/stream`,
    /** GET — satu percakapan. */
    conversation: `${API_PREFIX}/conversations/:conversationId`,
    /** GET — pesan percakapan, terbaru dulu (kursor = lebih lama). */
    messages: `${API_PREFIX}/conversations/:conversationId/messages`,
    /** GET — satu kontak. */
    contact: `${API_PREFIX}/contacts/:contactId`,
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
