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
  'messages:initiate',
  'contacts:read',
  'contacts:write',
  'tickets:read',
  'tickets:write',
  // Tahap 9.1 — email lewat API (docs/KONTRAK-API-EMAIL-KIRIM.md §2). `email:send` sudah mencakup
  // memulai percakapan email (TIDAK butuh `messages:initiate`) dan tidak memberi akses rute lain.
  'email:read',
  'email:send',
] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES, { error: 'Scope API key tidak dikenal.' });
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const API_KEY_SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  'conversations:read': 'Baca percakapan',
  'conversations:write':
    'Tangani percakapan: lepas bot ke antrian, tugaskan agen, tandai selesai, tulis catatan tim',
  'messages:read': 'Baca pesan & statusnya',
  'messages:send': 'Kirim pesan di percakapan yang sudah ada (termasuk unggah media)',
  'messages:initiate':
    'Kirim template ke nomor (bisa memulai percakapan baru) — dipakai aplikasi billing/notifikasi',
  'contacts:read': 'Baca & cari kontak',
  'contacts:write': 'Buat & ubah kontak, pasang/lepas tag',
  'tickets:read': 'Baca & cari tiket serta board',
  'tickets:write': 'Buat & ubah tiket, pindah kolom (status), tulis komentar',
  'email:read': 'Baca status email yang dikirim lewat API, daftar pengirim & template email',
  'email:send':
    'Kirim, jadwalkan, batalkan & balas email lewat pengirim yang dipilih (termasuk unggah lampiran)',
};

/** Scope yang ikut didapat karena memegang scope lain (tingkatan). */
export const API_KEY_SCOPE_IMPLIES: Readonly<Record<ApiKeyScope, readonly ApiKeyScope[]>> = {
  'conversations:read': [],
  'conversations:write': ['conversations:read'],
  'messages:read': ['conversations:read'],
  'messages:send': ['messages:read', 'conversations:read'],
  'messages:initiate': [],
  'contacts:read': [],
  'contacts:write': ['contacts:read'],
  'tickets:read': [],
  'tickets:write': ['tickets:read'],
  'email:read': [],
  'email:send': ['email:read'],
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
/** Pengirim email per key (wajib ≥ 1 bila key memegang `email:*`). */
export const API_KEY_EMAIL_SENDERS_MAX = 20;
/** Host URL lampiran email yang diizinkan per key (kosong = lampiran `url` ditolak). */
export const API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX = 20;

/** Key memegang salah satu scope email (`email:read` / `email:send`). */
export function apiKeyHasEmailScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === 'email:read' || scope === 'email:send');
}

/**
 * Host lampiran: nama host persis (`billing.perusahaan.example`), wildcard satu tingkat
 * (`*.perusahaan.example` = semua subdomain, BUKAN domain induknya), atau IP literal. Huruf kecil;
 * dinormalisasi ulang di server.
 */
export const emailAttachmentHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^[0-9a-f:.]+$/,
    'Host tidak valid. Contoh: billing.perusahaan.example atau *.perusahaan.example.',
  );

/** Host `host` cocok dengan salah satu pola allowlist (lihat `emailAttachmentHostSchema`). */
export function emailAttachmentHostAllowed(host: string, patterns: readonly string[]): boolean {
  const target = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const parent = pattern.slice(1);
      return target.endsWith(parent) && target.length > parent.length;
    }
    return target === pattern;
  });
}

const emailSenderIdsSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(API_KEY_EMAIL_SENDERS_MAX, `Maksimal ${String(API_KEY_EMAIL_SENDERS_MAX)} pengirim email.`)
  .refine((items) => new Set(items).size === items.length, 'Pengirim tidak boleh kembar.');
const emailAttachmentHostsSchema = z
  .array(emailAttachmentHostSchema)
  .max(
    API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX,
    `Maksimal ${String(API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX)} host lampiran.`,
  );

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
  /** Tahap 9.1: pengirim email (`chn_<uuid>`) — wajib ≥ 1 bila scope `email:*`, selain itu kosong. */
  emailSenderIds: emailSenderIdsSchema.optional(),
  /** Tahap 9.1: allowlist host URL lampiran email (kosong = lampiran `url` ditolak). */
  emailAttachmentHosts: emailAttachmentHostsSchema.optional(),
  confirmation: identityConfirmationSchema.optional(),
});
export type CreateApiKeyRequest = z.input<typeof createApiKeyRequestSchema>;

/**
 * `PATCH /settings/api-keys/:id` (tahap 9.1): ubah pengirim email & host lampiran. SELALU wajib
 * konfirmasi identitas. Scope tidak bisa diubah (buat key baru).
 */
export const updateApiKeyRequestSchema = z
  .object({
    emailSenderIds: emailSenderIdsSchema.optional(),
    emailAttachmentHosts: emailAttachmentHostsSchema.optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .refine(
    (value) => value.emailSenderIds !== undefined || value.emailAttachmentHosts !== undefined,
    { error: 'Tidak ada pengaturan API key yang diubah.' },
  );
export type UpdateApiKeyRequest = z.input<typeof updateApiKeyRequestSchema>;

/** Pengirim email yang boleh dipakai sebuah key (ringkas, untuk tampilan). */
export const apiKeyEmailSenderSchema = z.object({
  id: z.string(),
  kind: z.enum(['channel', 'account']),
  name: z.string(),
  address: z.string(),
});

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
  /** Tahap 9.1: pengirim email yang boleh dipakai (kosong bila key tanpa scope email). */
  emailSenders: z.array(apiKeyEmailSenderSchema),
  emailAttachmentHosts: z.array(z.string()),
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
