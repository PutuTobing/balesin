import type { BusinessProfile, UpdateBusinessProfileRequest } from '@balesin/shared';
import { z } from 'zod';

import { MetaApiError } from './errors';
import type { MetaCredentials, MetaGraphClient } from './graph-client';

/**
 * Operasi WhatsApp Cloud API di atas `MetaGraphClient`. Bentuk jawaban dibaca TOLERAN: isian yang
 * tidak ada/berbeda tipe menjadi `null`, bukan menggagalkan seluruh tes — Meta sering menambah
 * atau mengusangkan isian (mis. `messaging_limit_tier` → `whatsapp_business_manager_messaging_limit`).
 *
 * Sumber (dibaca 14 Nov 2026):
 *  - GET /{phone-number-id}: developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
 *  - Batas pesan: developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
 *  - Profil bisnis: developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
 */

/** Teks pendek dari Meta; selain string (atau terlalu panjang) → `null`. */
const looseText = (max = 200) =>
  z
    .unknown()
    .transform((value) =>
      typeof value === 'string' && value.length <= max && value.trim() !== '' ? value : null,
    );

/** `whatsapp_business_manager_messaging_limit` bisa string atau objek (`{ tier }`/`{ value }`). */
const messagingLimitValue = z.unknown().transform((value): string | null => {
  if (typeof value === 'string' && value.length <= 64) return value;
  if (typeof value === 'object' && value !== null) {
    for (const key of ['tier', 'value', 'current_limit', 'limit']) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === 'string' && inner.length <= 64) return inner;
    }
  }
  return null;
});

const phoneNumberResponseSchema = z.object({
  id: z.string().max(64),
  display_phone_number: looseText(64).optional(),
  verified_name: looseText(200).optional(),
  quality_rating: looseText(32).optional(),
  status: looseText(32).optional(),
  name_status: looseText(64).optional(),
  code_verification_status: looseText(64).optional(),
  whatsapp_business_manager_messaging_limit: messagingLimitValue.optional(),
  messaging_limit_tier: looseText(64).optional(),
  throughput: z
    .unknown()
    .transform((value) => {
      const level = (value as { level?: unknown } | null)?.level;
      return typeof level === 'string' && level.length <= 32 ? level : null;
    })
    .optional(),
});

export interface PhoneNumberDetails {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  status: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  messagingLimit: string | null;
  throughputLevel: string | null;
}

/** Field lengkap. Bila versi API menolak salah satunya ("nonexisting field"), dipakai `BASIC`. */
export const PHONE_NUMBER_FIELDS = [
  'display_phone_number',
  'verified_name',
  'quality_rating',
  'status',
  'name_status',
  'code_verification_status',
  'whatsapp_business_manager_messaging_limit',
  'throughput',
] as const;
export const PHONE_NUMBER_BASIC_FIELDS = [
  'display_phone_number',
  'verified_name',
  'quality_rating',
  'status',
  'code_verification_status',
] as const;

/** Profil + status satu nomor. */
export async function readPhoneNumber(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  phoneNumberId: string,
): Promise<PhoneNumberDetails> {
  const fetchWith = (fields: readonly string[]) =>
    client.request(credentials, {
      operation: 'phone_number.read',
      method: 'GET',
      path: [phoneNumberId],
      query: { fields: fields.join(',') },
      schema: phoneNumberResponseSchema,
    });

  let data: z.infer<typeof phoneNumberResponseSchema>;
  try {
    data = await fetchWith(PHONE_NUMBER_FIELDS);
  } catch (error) {
    // Isian opsional yang tidak dikenal versi ini → ulangi dengan isian dasar saja.
    if (error instanceof MetaApiError && error.kind === 'invalid_parameter') {
      data = await fetchWith(PHONE_NUMBER_BASIC_FIELDS);
    } else {
      throw error;
    }
  }
  if (data.id !== phoneNumberId) {
    throw new MetaApiError({ kind: 'unexpected_response', operation: 'phone_number.read' });
  }
  return {
    id: data.id,
    displayPhoneNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
    status: data.status ?? null,
    nameStatus: data.name_status ?? null,
    codeVerificationStatus: data.code_verification_status ?? null,
    messagingLimit:
      data.whatsapp_business_manager_messaging_limit ?? data.messaging_limit_tier ?? null,
    throughputLevel: data.throughput ?? null,
  };
}

const CURSOR_PATTERN = /^[A-Za-z0-9_=-]{1,512}$/;

const wabaPhoneNumbersSchema = z.object({
  data: z.array(z.object({ id: z.string().max(64) })).max(1000),
  paging: z
    .unknown()
    .transform((value) => {
      const after = (value as { cursors?: { after?: unknown } } | null)?.cursors?.after;
      const hasNext = typeof (value as { next?: unknown } | null)?.next === 'string';
      return typeof after === 'string' && CURSOR_PATTERN.test(after) && hasNext ? after : null;
    })
    .optional(),
});

/** Halaman maksimal yang ditelusuri saat mencari nomor di WABA (100 nomor per halaman). */
const WABA_MAX_PAGES = 5;

/**
 * `true` bila Phone Number ID termasuk WABA ini (`GET /{waba-id}/phone_numbers`). Halaman berikutnya
 * diambil lewat kursor `after` — URL `paging.next` dari Meta TIDAK diikuti (bisa menunjuk host lain).
 */
export async function wabaHasPhoneNumber(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  wabaId: string,
  phoneNumberId: string,
): Promise<boolean> {
  let after: string | undefined;
  for (let page = 0; page < WABA_MAX_PAGES; page += 1) {
    const data = await client.request(credentials, {
      operation: 'waba.phone_numbers.list',
      method: 'GET',
      path: [wabaId, 'phone_numbers'],
      query: { fields: 'id', limit: 100, after },
      schema: wabaPhoneNumbersSchema,
    });
    if (data.data.some((entry) => entry.id === phoneNumberId)) return true;
    if (!data.paging) return false;
    after = data.paging;
  }
  return false;
}

// ── Profil bisnis ───────────────────────────────────────────────────────────

const BUSINESS_PROFILE_FIELDS = [
  'about',
  'address',
  'description',
  'email',
  'websites',
  'vertical',
] as const;

const businessProfileResponseSchema = z.object({
  data: z
    .array(
      z.object({
        about: looseText(1000).optional(),
        address: looseText(1000).optional(),
        description: looseText(2000).optional(),
        email: looseText(500).optional(),
        vertical: looseText(64).optional(),
        websites: z
          .unknown()
          .transform((value) =>
            Array.isArray(value)
              ? value
                  .filter((item): item is string => typeof item === 'string' && item.length <= 500)
                  .slice(0, 5)
              : [],
          )
          .optional(),
      }),
    )
    .max(10),
});

export async function readBusinessProfile(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  phoneNumberId: string,
): Promise<BusinessProfile> {
  const data = await client.request(credentials, {
    operation: 'business_profile.read',
    method: 'GET',
    path: [phoneNumberId, 'whatsapp_business_profile'],
    query: { fields: BUSINESS_PROFILE_FIELDS.join(',') },
    schema: businessProfileResponseSchema,
  });
  const profile = data.data[0];
  return {
    about: profile?.about ?? null,
    address: profile?.address ?? null,
    description: profile?.description ?? null,
    email: profile?.email ?? null,
    websites: profile?.websites ?? [],
    vertical: profile?.vertical ?? null,
  };
}

const successSchema = z.object({ success: z.literal(true) });

/**
 * Mengubah profil bisnis (hanya isian yang dikirim). Aman diulang otomatis: mengirim nilai yang
 * sama dua kali menghasilkan profil yang sama. Foto profil (Resumable Upload API, butuh App ID)
 * belum didukung.
 */
export async function updateBusinessProfile(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  phoneNumberId: string,
  changes: UpdateBusinessProfileRequest,
): Promise<void> {
  const body: Record<string, unknown> = { messaging_product: 'whatsapp' };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) body[key] = value;
  }
  await client.request(credentials, {
    operation: 'business_profile.update',
    method: 'POST',
    path: [phoneNumberId, 'whatsapp_business_profile'],
    body,
    schema: successSchema,
    idempotent: true,
  });
}
