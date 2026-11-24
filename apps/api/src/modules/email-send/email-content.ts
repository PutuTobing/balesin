import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

import { AppError } from '@balesin/core';
import {
  EMAIL_FROM_NAME_MAX,
  EMAIL_METADATA_KEY_PATTERN,
  EMAIL_METADATA_MAX_BYTES,
  EMAIL_METADATA_MAX_KEYS,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_SCHEDULE_MAX_DAYS,
  EMAIL_VARIABLE_VALUE_MAX,
  hasControlCharacters,
  type EmailRecipientInput,
  type EmailTemplateVariable,
  type ErrorCode,
  type ErrorDetail,
} from '@balesin/shared';

/**
 * Pemeriksaan makna isian email lewat API (tahap 9.1, §3.3–3.9) dengan `details[].reason` stabil.
 * Zod sudah memeriksa bentuk; di sini aturan alamat, metadata, jadwal, nilai variabel. Tidak ada
 * nilai isian (alamat, metadata, variabel) yang ditulis ke log.
 */

export type Scalar = string | number | boolean | null;

export function detail(field: string, reason: string, message: string): ErrorDetail {
  return { location: 'body', field, message, reason };
}

export function emailError(
  code: ErrorCode,
  details: readonly ErrorDetail[],
  extra: { retryAfterSeconds?: number } = {},
): AppError {
  const first = details[0];
  return new AppError(code, {
    message: first?.message ?? 'Permintaan tidak valid.',
    details: [...details],
    ...extra,
  });
}

export function invalid(field: string, reason: string, message: string): AppError {
  return emailError('VALIDATION_ERROR', [detail(field, reason, message)]);
}

// ── Alamat ──────────────────────────────────────────────────────────────────

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Alamat email → bentuk baku huruf kecil, atau `null`. ASCII ≤ 254, bagian lokal ≤ 64 (tanpa titik di
 * ujung/beruntun), domain berlabel valid dengan titik (IDN → punycode). Bagian lokal non-ASCII
 * (SMTPUTF8) belum didukung.
 */
export function normalizeRecipientAddress(value: string): string | null {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1).toLowerCase();
  if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.')) return null;
  if (local.includes('..')) return null;
  const domain = domainToASCII(rawDomain);
  if (!domain) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (!/[a-z]/.test(labels.at(-1) ?? '')) return null;
  const address = `${local.toLowerCase()}@${domain}`;
  return address.length <= 254 ? address : null;
}

export function invalidRecipient(field: string): AppError {
  return invalid(
    field,
    'recipient_invalid',
    `Alamat email ini tidak valid: periksa penulisan di ${field}.`,
  );
}

export interface NormalizedRecipient {
  email: string;
  name: string | null;
}

function cleanName(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const name = value.trim();
  if (name === '') return null;
  if (name.length > EMAIL_FROM_NAME_MAX || hasControlCharacters(name) || /[<>@"\\]/.test(name)) {
    throw invalid(
      field,
      'recipient_invalid',
      'Nama penerima maksimal 80 karakter, tanpa karakter khusus atau alamat email.',
    );
  }
  return name;
}

/**
 * Kepada/Cc/Bcc: dinormalisasi, digabung tanpa beda huruf (prioritas Kepada > Cc > Bcc), total ≤ 50.
 */
export function normalizeRecipients(input: {
  to: readonly EmailRecipientInput[];
  cc?: readonly EmailRecipientInput[];
  bcc?: readonly EmailRecipientInput[];
  /** Nama isian `to` (balasan: Kepada diisi server). */
  toField?: string;
}): { to: NormalizedRecipient[]; cc: NormalizedRecipient[]; bcc: NormalizedRecipient[] } {
  const seen = new Set<string>();
  const take = (items: readonly EmailRecipientInput[] | undefined, field: string) => {
    const result: NormalizedRecipient[] = [];
    (items ?? []).forEach((item, index) => {
      const email = normalizeRecipientAddress(item.email);
      if (!email) throw invalidRecipient(`${field}.${String(index)}.email`);
      const name = cleanName(item.name, `${field}.${String(index)}.name`);
      if (seen.has(email)) return;
      seen.add(email);
      result.push({ email, name });
    });
    return result;
  };
  const to = take(input.to, input.toField ?? 'to');
  const cc = take(input.cc, 'cc');
  const bcc = take(input.bcc, 'bcc');
  if (to.length + cc.length + bcc.length > EMAIL_RECIPIENTS_MAX) {
    throw invalid(
      'to',
      'too_many_recipients',
      'Penerima maksimal 50 alamat (Kepada + Cc + Bcc). Untuk kirim massal, pakai Broadcast.',
    );
  }
  return { to, cc, bcc };
}

/** `fromName` (§3.2): ≤ 80, tanpa karakter kendali, tanpa `@`, `<`, `>`. */
export function cleanFromName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const name = value.trim();
  if (name === '') return null;
  if (name.length > EMAIL_FROM_NAME_MAX || hasControlCharacters(name) || /[@<>"\\]/.test(name)) {
    throw invalid(
      'fromName',
      'from_name_invalid',
      'Nama pengirim maksimal 80 karakter, tanpa karakter khusus dan tanpa alamat email.',
    );
  }
  return name;
}

// ── Metadata & jadwal ───────────────────────────────────────────────────────

const METADATA_INVALID =
  'metadata maksimal 20 kunci (huruf/angka/._-, ≤ 40), nilai teks ≤ 200 / angka / boolean / null, total ≤ 2 KB.';

export function validateMetadata(
  value: Readonly<Record<string, Scalar>> | undefined,
): Record<string, Scalar> | null {
  if (value === undefined) return null;
  const entries = Object.entries(value);
  if (entries.length > EMAIL_METADATA_MAX_KEYS) {
    throw invalid('metadata', 'metadata_invalid', METADATA_INVALID);
  }
  const result: Record<string, Scalar> = {};
  for (const [key, item] of entries) {
    if (!EMAIL_METADATA_KEY_PATTERN.test(key)) {
      throw invalid(`metadata.${key.slice(0, 40)}`, 'metadata_invalid', METADATA_INVALID);
    }
    if (typeof item === 'string' && (item.length > 200 || hasControlCharacters(item))) {
      throw invalid(`metadata.${key}`, 'metadata_invalid', METADATA_INVALID);
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw invalid(`metadata.${key}`, 'metadata_invalid', METADATA_INVALID);
    }
    result[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > EMAIL_METADATA_MAX_BYTES) {
    throw invalid('metadata', 'metadata_invalid', METADATA_INVALID);
  }
  return result;
}

/** `scheduledAt` ISO, ≤ 30 hari ke depan; lampau/kini = kirim segera (`null`). */
export function parseSchedule(value: string | undefined, now: Date): Date | null {
  if (value === undefined) return null;
  const message = `scheduledAt harus waktu ISO 8601 lengkap (mis. 2026-11-25T02:00:00Z), maks. ${String(EMAIL_SCHEDULE_MAX_DAYS)} hari ke depan.`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw invalid('scheduledAt', 'scheduled_at_invalid', message);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid('scheduledAt', 'scheduled_at_invalid', message);
  if (at.getTime() - now.getTime() > EMAIL_SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw invalid('scheduledAt', 'scheduled_at_invalid', message);
  }
  return at.getTime() <= now.getTime() ? null : at;
}

// ── Variabel template ───────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- karakter kendali selain baris baru justru dicari.
const VALUE_FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/;

/**
 * Nilai variabel template (§3.3): string ≤ 1.000 (angka/boolean → teks, `null` = kosong), tanpa
 * karakter kendali selain baris baru dan tanpa U+2028/U+2029. Variabel wajib tidak dikirim/kosong →
 * `template_variable_missing` (satu detail per variabel). Kunci yang tidak dikenal DIABAIKAN.
 */
export function templateValues(
  declared: readonly EmailTemplateVariable[],
  input: Readonly<Record<string, Scalar>> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: ErrorDetail[] = [];
  for (const variable of declared) {
    const raw = input && Object.hasOwn(input, variable.name) ? input[variable.name] : undefined;
    const text =
      raw === undefined || raw === null
        ? ''
        : typeof raw === 'string'
          ? raw.replace(/\r\n?/g, '\n')
          : String(raw);
    if (text.length > EMAIL_VARIABLE_VALUE_MAX || VALUE_FORBIDDEN.test(text)) {
      throw invalid(
        `variables.${variable.name}`,
        'template_variable_invalid',
        `Nilai {{${variable.name}}} maksimal 1.000 karakter dan tanpa karakter khusus.`,
      );
    }
    if (variable.required && text.trim() === '') {
      missing.push(
        detail(
          `variables.${variable.name}`,
          'template_variable_missing',
          `Variabel {{${variable.name}}} wajib diisi untuk template ini.`,
        ),
      );
      continue;
    }
    values[variable.name] = text;
  }
  if (missing.length > 0) throw emailError('VALIDATION_ERROR', missing);
  return values;
}

// ── Idempotensi ─────────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** SHA-256 JSON body yang dikanonisasi (kunci diurutkan) — pembanding `Idempotency-Key`. */
export function requestHashOf(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex');
}
