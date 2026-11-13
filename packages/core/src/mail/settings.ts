import type { SmtpSecurity } from '@balesin/shared';

import { SecretDecryptionError, type SecretBox } from '../crypto';
import type { SmtpFallbackConfig } from '../env';
import { Secret } from '../secret';
import type { MailSender, SmtpConnectionConfig } from './smtp';

/**
 * Jembatan antara pengaturan email yang TERSIMPAN (baris `email_settings`, password
 * terenkripsi) atau cadangan `.env`, dan bentuk yang dipakai klien SMTP. Dipakai api (tes
 * koneksi atas pengaturan tersimpan) dan worker (mengirim notifikasi).
 */

/** Konteks enkripsi password SMTP — harus sama saat menyimpan dan membuka. */
export const SMTP_PASSWORD_PURPOSE = 'email_settings.smtp_password';

/** Kolom `email_settings` yang dibutuhkan untuk mengirim. */
export interface StoredEmailSettings {
  organizationId: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  passwordEncrypted: string | null;
}

export interface MailTransportSettings {
  connection: SmtpConnectionConfig;
  sender: MailSender;
}

export type OpenedEmailSettings =
  | { ok: true; settings: MailTransportSettings }
  /** Password tersimpan tidak bisa dibuka: master key tidak ada/berganti, atau datanya rusak. */
  | { ok: false; code: 'secret_unavailable' };

/** Membuka password tersimpan dan menyusun pengaturan kirim. Password tetap terbungkus `Secret`. */
export function openStoredEmailSettings(
  row: StoredEmailSettings,
  secretBox: SecretBox | null,
): OpenedEmailSettings {
  let password: Secret<string> | null = null;
  if (row.username !== null && row.passwordEncrypted !== null) {
    if (!secretBox) return { ok: false, code: 'secret_unavailable' };
    try {
      password = new Secret(
        secretBox.decrypt(row.passwordEncrypted, {
          organizationId: row.organizationId,
          purpose: SMTP_PASSWORD_PURPOSE,
        }),
      );
    } catch (error) {
      if (error instanceof SecretDecryptionError) return { ok: false, code: 'secret_unavailable' };
      throw error;
    }
  }

  return {
    ok: true,
    settings: {
      connection: {
        host: row.host,
        port: row.port,
        security: row.security,
        username: row.username,
        password,
      },
      sender: { fromName: row.fromName, fromAddress: row.fromAddress, replyTo: row.replyTo },
    },
  };
}

/** Pengaturan kirim dari cadangan `SMTP_*` di .env. */
export function fallbackEmailSettings(fallback: SmtpFallbackConfig): MailTransportSettings {
  return {
    connection: {
      host: fallback.host,
      port: fallback.port,
      security: fallback.security,
      username: fallback.username,
      password: fallback.username !== null ? fallback.password : null,
    },
    sender: { fromName: fallback.fromName, fromAddress: fallback.fromAddress, replyTo: null },
  };
}
