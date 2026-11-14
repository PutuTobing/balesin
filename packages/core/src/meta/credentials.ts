import { randomToken } from '../crypto';
import type { SecretBox } from '../crypto';
import { Secret } from '../secret';
import type { MetaCredentials } from './graph-client';

/**
 * Konteks `SecretBox` untuk rahasia channel WhatsApp (tabel `channels`). AAD = organisasi + tujuan
 * (kolom) + ID channel, jadi teks sandi yang dipindah ke channel/organisasi/kolom lain tidak bisa
 * dibuka. Dipakai api (wizard, tes koneksi) dan worker (kirim pesan, webhook) — JANGAN diganti tanpa
 * migrasi data: rahasia lama tidak akan terbuka lagi.
 */
export const WHATSAPP_SECRET_PURPOSES = {
  accessToken: 'channels.wa_access_token',
  appSecret: 'channels.wa_app_secret',
  verifyToken: 'channels.wa_webhook_verify_token',
} as const;
export type WhatsAppSecretKind = keyof typeof WHATSAPP_SECRET_PURPOSES;

export interface ChannelSecretOwner {
  id: string;
  organizationId: string;
}

export function sealChannelSecret(
  box: SecretBox,
  owner: ChannelSecretOwner,
  kind: WhatsAppSecretKind,
  plaintext: string,
): string {
  return box.encrypt(plaintext, {
    organizationId: owner.organizationId,
    purpose: WHATSAPP_SECRET_PURPOSES[kind],
    subjectId: owner.id,
  });
}

/** Melempar `SecretDecryptionError` bila kunci/konteks/data tidak cocok. */
export function openChannelSecret(
  box: SecretBox,
  owner: ChannelSecretOwner,
  kind: WhatsAppSecretKind,
  sealed: string,
): Secret<string> {
  return new Secret(
    box.decrypt(sealed, {
      organizationId: owner.organizationId,
      purpose: WHATSAPP_SECRET_PURPOSES[kind],
      subjectId: owner.id,
    }),
  );
}

/** Token + App Secret tersimpan → kredensial klien Graph API. */
export function openWhatsAppCredentials(
  box: SecretBox,
  channel: ChannelSecretOwner & {
    waAccessTokenEncrypted: string | null;
    waAppSecretEncrypted: string | null;
  },
): MetaCredentials {
  if (channel.waAccessTokenEncrypted === null || channel.waAppSecretEncrypted === null) {
    throw new Error('Channel tidak punya kredensial tersimpan');
  }
  return {
    accessToken: openChannelSecret(box, channel, 'accessToken', channel.waAccessTokenEncrypted),
    appSecret: openChannelSecret(box, channel, 'appSecret', channel.waAppSecretEncrypted),
  };
}

/**
 * Verify token webhook baru (SECURITY.md §4: acak per channel). 32 byte acak → 43 karakter
 * base64url — Meta menerima teks bebas, dan nilai ini aman ditempel tanpa di-escape.
 */
export function newWebhookVerifyToken(): string {
  return randomToken(32);
}
