import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * API key untuk API publik (Fase 3 — docs/KONTRAK-API-PUBLIK.md). Dikelola Owner/Admin
 * (`api_keys.manage`, PRD §4 "API key & webhook").
 *
 * Bentuk kunci: `blsn_live_<id 16 hex>_<rahasia 43 base64url>` — `id` untuk pencarian (disimpan
 * polos), rahasia hanya disimpan sebagai HMAC-SHA256 berlada (pepper dari master key). Nilai utuh
 * ditampilkan SEKALI saat dibuat.
 */
export const API_KEY_PREFIX = 'blsn_live_';
export const API_KEY_ID_LENGTH = 16;
export const API_KEY_SECRET_LENGTH = 43;
/** Pola kunci utuh (untuk validasi bentuk sebelum mencari). */
export const API_KEY_PATTERN = /^blsn_live_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/**
 * Scope bertingkat: `…:write`/`send` MENCAKUP `…:read` sumber yang sama. Scope lain dari API-N8N
 * (`messages:initiate`, `broadcasts:write`, `tickets:write`, `reports:read`, `webhooks:manage`)
 * ditambahkan bersama fiturnya. `conversations:write` (lapisan kompatibel MobiChat): lepas bot /
 * handoff, tugaskan agen, ubah status, tulis catatan sesi.
 */
export const API_KEY_SCOPES = [
  'conversations:read',
  'conversations:write',
  'messages:read',
  'messages:send',
  'contacts:read',
  'contacts:write',
] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES, { error: 'Scope API key tidak dikenal.' });
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const API_KEY_SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  'conversations:read': 'Baca percakapan',
  'conversations:write':
    'Tangani percakapan: lepas bot ke antrian, tugaskan agen, tandai selesai, tulis catatan tim',
  'messages:read': 'Baca pesan & statusnya',
  'messages:send': 'Kirim pesan di percakapan yang sudah ada (termasuk unggah media)',
  'contacts:read': 'Baca & cari kontak',
  'contacts:write': 'Buat & ubah kontak, pasang/lepas tag',
};

/** Scope yang ikut didapat karena memegang scope lain (tingkatan). */
export const API_KEY_SCOPE_IMPLIES: Readonly<Record<ApiKeyScope, readonly ApiKeyScope[]>> = {
  'conversations:read': [],
  'conversations:write': ['conversations:read'],
  'messages:read': ['conversations:read'],
  'messages:send': ['messages:read', 'conversations:read'],
  'contacts:read': [],
  'contacts:write': ['contacts:read'],
};

/** Key dengan `granted` boleh memakai `needed` (langsung atau lewat tingkatan). */
export function apiKeyHasScope(granted: readonly string[], needed: ApiKeyScope): boolean {
  return granted.some(
    (scope) =>
      scope === needed ||
      (Object.hasOwn(API_KEY_SCOPE_IMPLIES, scope) &&
        API_KEY_SCOPE_IMPLIES[scope as ApiKeyScope].includes(needed)),
  );
}

export const API_KEYS_PER_ORGANIZATION_MAX = 50;
export const API_KEY_ALLOWED_IPS_MAX = 20;
export const API_KEY_DAILY_SEND_DEFAULT = 500;

/** IPv4/IPv6 tunggal atau CIDR (`10.0.0.0/8`, `2001:db8::/32`). Divalidasi ulang di server. */
const ipOrCidrSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(
    /^[0-9a-fA-F:.]+(\/\d{1,3})?$/,
    'Alamat IP/CIDR tidak valid. Contoh: 203.0.113.10 atau 10.0.0.0/8.',
  );

export const createApiKeyRequestSchema = z.object({
  name: z
    .string({ error: 'Nama API key wajib diisi.' })
    .trim()
    .min(1, 'Nama API key wajib diisi.')
    .max(80, 'Nama API key maksimal 80 karakter.')
    .refine((value) => !hasControlCharacters(value), 'Nama memuat karakter khusus.'),
  scopes: z
    .array(apiKeyScopeSchema)
    .min(1, 'Pilih minimal satu scope.')
    .refine((items) => new Set(items).size === items.length, 'Scope tidak boleh kembar.'),
  /** `null`/tidak diisi = tidak kedaluwarsa. Harus di masa depan, maks. 2 tahun. */
  expiresAt: isoDateTimeSchema.nullable().optional(),
  /** `null`/kosong = semua IP. */
  allowedIps: z
    .array(ipOrCidrSchema)
    .max(API_KEY_ALLOWED_IPS_MAX, `Maksimal ${String(API_KEY_ALLOWED_IPS_MAX)} alamat IP.`)
    .nullable()
    .optional(),
  /** Batas pesan keluar per 24 jam lewat key ini (bawaan 500). */
  dailySendLimit: z.number().int().min(1).max(100_000).optional(),
  confirmation: identityConfirmationSchema.optional(),
});
export type CreateApiKeyRequest = z.input<typeof createApiKeyRequestSchema>;

export const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Awalan yang aman ditampilkan (`blsn_live_<id>_…`). */
  displayPrefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  allowedIps: z.array(z.string()).nullable(),
  dailySendLimit: z.number().int(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: isoDateTimeSchema,
  /** `active` / `expired` / `revoked`. */
  status: z.enum(['active', 'expired', 'revoked']),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const apiKeyListResponseSchema = z.object({ apiKeys: z.array(apiKeySchema) });
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;
export const apiKeyResponseSchema = z.object({ apiKey: apiKeySchema });

/** Jawaban pembuatan: `secret` = kunci UTUH, ditampilkan SEKALI (tidak bisa diambil lagi). */
export const createApiKeyResponseSchema = z.object({ apiKey: apiKeySchema, secret: z.string() });
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

export const apiKeyIdParamsSchema = z.object({ apiKeyId: z.string() });

/** Pengaturan API publik organisasi (`api_keys.manage`). */
export const apiSettingsSchema = z.object({
  /** Halaman dokumentasi `/api/docs` (+ `/api/docs/openapi.json`) bisa dibuka tanpa masuk. */
  docsEnabled: z.boolean(),
});
export type ApiSettings = z.infer<typeof apiSettingsSchema>;
export const apiSettingsResponseSchema = z.object({ settings: apiSettingsSchema });
