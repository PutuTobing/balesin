import type { SecretBox } from '../crypto';
import { Secret } from '../secret';

/**
 * Konteks `SecretBox` password akun Email (Fase 9, KONTRAK-API-EMAIL §3): AAD = organisasi + kolom +
 * ID akun — teks sandi yang dipindah ke akun/organisasi/kolom lain tidak bisa dibuka. JANGAN diganti
 * tanpa migrasi data.
 */
export const MAIL_SECRET_PURPOSES = {
  imapPassword: 'mail_accounts.imap_password',
  smtpPassword: 'mail_accounts.smtp_password',
} as const;
export type MailSecretKind = keyof typeof MAIL_SECRET_PURPOSES;

export interface MailSecretSubject {
  id: string;
  organizationId: string;
}

export function sealMailAccountSecret(
  box: SecretBox,
  owner: MailSecretSubject,
  kind: MailSecretKind,
  plaintext: string,
): string {
  return box.encrypt(plaintext, {
    organizationId: owner.organizationId,
    purpose: MAIL_SECRET_PURPOSES[kind],
    subjectId: owner.id,
  });
}

/** Melempar `SecretDecryptionError` bila kunci/konteks/data tidak cocok. */
export function openMailAccountSecret(
  box: SecretBox,
  owner: MailSecretSubject,
  kind: MailSecretKind,
  sealed: string,
): Secret<string> {
  return new Secret(
    box.decrypt(sealed, {
      organizationId: owner.organizationId,
      purpose: MAIL_SECRET_PURPOSES[kind],
      subjectId: owner.id,
    }),
  );
}
