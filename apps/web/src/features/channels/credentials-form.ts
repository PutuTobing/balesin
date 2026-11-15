import {
  CHANNEL_CREDENTIAL_FIELDS,
  metaAccessTokenSchema,
  metaAppSecretSchema,
  phoneNumberIdSchema,
  wabaIdSchema,
  type UpdateChannelRequest,
  type WhatsAppChannel,
} from '@balesin/shared';
import type { FieldErrors } from '../../lib/form';

/** Ganti kredensial di halaman nomor (`PATCH`, wajib konfirmasi identitas). */
export const CREDENTIAL_FIELDS = CHANNEL_CREDENTIAL_FIELDS;

export interface CredentialValues {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
}

/**
 * Isian yang benar-benar berubah. Token/App Secret kosong = tetap memakai yang tersimpan (tidak
 * dikirim); ID yang sama dengan yang tersimpan juga tidak dikirim.
 */
export function credentialChanges(
  values: CredentialValues,
  channel: Pick<WhatsAppChannel, 'phoneNumberId' | 'wabaId'>,
): UpdateChannelRequest {
  const changes: UpdateChannelRequest = {};
  if (values.phoneNumberId.trim() !== channel.phoneNumberId) {
    changes.phoneNumberId = values.phoneNumberId;
  }
  if (values.wabaId.trim() !== channel.wabaId) changes.wabaId = values.wabaId;
  if (values.accessToken.trim() !== '') changes.accessToken = values.accessToken;
  if (values.appSecret.trim() !== '') changes.appSecret = values.appSecret;
  return changes;
}

const SCHEMAS = {
  phoneNumberId: phoneNumberIdSchema,
  wabaId: wabaIdSchema,
  accessToken: metaAccessTokenSchema,
  appSecret: metaAppSecretSchema,
} as const;

/** Validasi isian yang berubah dengan skema yang sama dengan server. */
export function validateCredentialChanges(changes: UpdateChannelRequest): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
    const value = changes[field];
    if (value === undefined) continue;
    const result = SCHEMAS[field].safeParse(value);
    if (!result.success) errors[field] = result.error.issues[0]?.message ?? '';
  }
  return errors;
}
