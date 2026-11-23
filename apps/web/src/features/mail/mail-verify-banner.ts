import type { MailAccount } from '@balesin/shared';

/**
 * Akun yang perlu banner "Verifikasi alamat … supaya bisa mengirim email" di menu Email
 * (KONTRAK-API-EMAIL-TULIS §3.4): peringatan `identity_unverified` atau `system_sender_conflict`,
 * hanya untuk pemegang hak Kelola (yang bisa memverifikasi). Urutan mengikuti daftar akun.
 */
export function accountsNeedingVerification(accounts: readonly MailAccount[]): MailAccount[] {
  return accounts.filter(
    (account) =>
      account.myLevel === 'manage' &&
      (account.warnings.includes('identity_unverified') ||
        account.warnings.includes('system_sender_conflict')),
  );
}

/** Semua akun di banner terkunci karena kotak surat Email pengirim sistem (verifikasi tidak bisa dimulai). */
export function verificationLocked(accounts: readonly MailAccount[]): boolean {
  return (
    accounts.length > 0 &&
    accounts.every((account) => account.warnings.includes('system_sender_conflict'))
  );
}
