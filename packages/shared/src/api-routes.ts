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
  },
} as const;
