import { randomToken, type SecretBox } from '../crypto';
import { Secret } from '../secret';

/**
 * Konteks `SecretBox` rahasia channel Telegram & Email (Fase 6, tabel `channels`). AAD = organisasi +
 * tujuan (kolom) + ID channel: teks sandi yang dipindah ke channel/organisasi/kolom lain tidak bisa
 * dibuka. Token bot channel memakai tujuan SENDIRI — terpisah dari token alarm Telegram
 * (`telegram_alarm_settings`) walau nilainya boleh sama. JANGAN diganti tanpa migrasi data.
 */
export const CHANNEL_SECRET_PURPOSES = {
  telegramBotToken: 'channels.tg_bot_token',
  telegramWebhookSecret: 'channels.tg_webhook_secret',
  emailImapPassword: 'channels.email_imap_password',
  emailSmtpPassword: 'channels.email_smtp_password',
} as const;
export type ChannelSecretKind = keyof typeof CHANNEL_SECRET_PURPOSES;

export interface ChannelSecretSubject {
  id: string;
  organizationId: string;
}

export function sealChannelConnectionSecret(
  box: SecretBox,
  owner: ChannelSecretSubject,
  kind: ChannelSecretKind,
  plaintext: string,
): string {
  return box.encrypt(plaintext, {
    organizationId: owner.organizationId,
    purpose: CHANNEL_SECRET_PURPOSES[kind],
    subjectId: owner.id,
  });
}

/** Melempar `SecretDecryptionError` bila kunci/konteks/data tidak cocok. */
export function openChannelConnectionSecret(
  box: SecretBox,
  owner: ChannelSecretSubject,
  kind: ChannelSecretKind,
  sealed: string,
): Secret<string> {
  return new Secret(
    box.decrypt(sealed, {
      organizationId: owner.organizationId,
      purpose: CHANNEL_SECRET_PURPOSES[kind],
      subjectId: owner.id,
    }),
  );
}

/**
 * `secret_token` webhook Telegram: 1–256 karakter `[A-Za-z0-9_-]` (aturan Bot API). 32 byte acak →
 * 43 karakter base64url.
 */
export function newTelegramWebhookSecret(): string {
  return randomToken(32);
}
