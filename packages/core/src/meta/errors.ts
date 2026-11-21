import { META_ERROR_MESSAGES, type MetaErrorKind } from '@balesin/shared';
import { z } from 'zod';

/**
 * Pemetaan error Graph API Meta → jenis kesalahan Balesin (`META_ERROR_KINDS`) + pesan Indonesia.
 *
 * Sumber: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes dan
 * /docs/graph-api/overview/rate-limiting (dibaca 14 Nov 2026). Bentuk error Meta:
 *
 *   { "error": { "message", "type", "code", "error_data": { "details" }, "error_subcode"?,
 *                "fbtrace_id", "is_transient"? } }
 *
 * `error_subcode` sudah usang sejak v16 dan tidak selalu ada — keputusan dibuat dari `code`
 * (+ pola pesan untuk kasus yang kodenya dipakai bersama, mis. 100).
 */

/** Bentuk error Meta, dibaca toleran: isian yang tidak sesuai diabaikan, bukan menggagalkan. */
const metaErrorBodySchema = z.object({
  error: z.object({
    message: z.string().max(2000).optional().catch(undefined),
    type: z.string().max(200).optional().catch(undefined),
    code: z.coerce.number().int().optional().catch(undefined),
    error_subcode: z.coerce.number().int().optional().catch(undefined),
    is_transient: z.boolean().optional().catch(undefined),
    fbtrace_id: z.string().max(200).optional().catch(undefined),
    error_data: z
      .object({ details: z.string().max(2000).optional().catch(undefined) })
      .optional()
      .catch(undefined),
  }),
});

export interface MetaErrorInfo {
  kind: MetaErrorKind;
  /** Boleh diulang otomatis (gangguan sementara / batas laju). */
  retryable: boolean;
  /** Kode error Meta (`error.code`), bila ada. */
  metaCode: number | null;
  metaSubcode: number | null;
  /** Untuk dilaporkan ke dukungan Meta. Bukan rahasia. */
  fbtraceId: string | null;
  /** Pesan asli Meta (bahasa Inggris) — HANYA untuk log (lewat redaksi), tidak pernah ke klien. */
  metaMessage: string | null;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 80008, 130429]);
const PERMISSION_CODES = new Set([3, 10, 131005]);
const RESTRICTED_CODES = new Set([368, 130497, 131031, 131048]);
const NOT_REGISTERED_CODES = new Set([133010, 131045]);
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 131057, 133004]);
const INVALID_PARAMETER_CODES = new Set([131008, 131009, 135000]);
const TOKEN_CODES = new Set([0, 102, 190]);
/** Subkode 190 yang berarti "kedaluwarsa" (dokumentasi token akses Facebook Login). */
const EXPIRED_SUBCODES = new Set([463]);

function kindFor(
  code: number,
  subcode: number | null,
  message: string,
): { kind: MetaErrorKind; retryable: boolean } {
  if (TOKEN_CODES.has(code)) {
    const expired =
      (subcode !== null && EXPIRED_SUBCODES.has(subcode)) || /\bexpired?\b/i.test(message);
    return { kind: expired ? 'token_expired' : 'token_invalid', retryable: false };
  }
  if (code === 100) {
    // "Invalid appsecret_proof provided in the API argument" / "API calls from the server require
    // an appsecret_proof argument" (bila "Require App Secret" aktif di aplikasi).
    if (/appsecret_proof/i.test(message)) return { kind: 'app_secret_invalid', retryable: false };
    // "(#100) Tried accessing nonexisting field (x)" = nama FIELD salah, bukan objeknya tidak ada.
    if (/nonexisting field/i.test(message)) {
      return { kind: 'invalid_parameter', retryable: false };
    }
    // "Unsupported get request. Object with ID 'x' does not exist, cannot be loaded due to missing
    // permissions, or does not support this operation" (subkode 33).
    if (subcode === 33 || /does not exist|unsupported (?:get|post|delete) request/i.test(message)) {
      return { kind: 'not_found', retryable: false };
    }
    return { kind: 'invalid_parameter', retryable: false };
  }
  if (code === 33) return { kind: 'not_found', retryable: false };
  if (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299)) {
    return { kind: 'permission_denied', retryable: false };
  }
  if (RATE_LIMIT_CODES.has(code)) return { kind: 'rate_limited', retryable: true };
  if (RESTRICTED_CODES.has(code)) return { kind: 'account_restricted', retryable: false };
  if (NOT_REGISTERED_CODES.has(code)) return { kind: 'phone_not_registered', retryable: false };
  if (code === 131042) return { kind: 'payment_required', retryable: false };
  if (TRANSIENT_CODES.has(code)) return { kind: 'temporarily_unavailable', retryable: true };
  if (INVALID_PARAMETER_CODES.has(code)) return { kind: 'invalid_parameter', retryable: false };
  return { kind: 'unknown', retryable: false };
}

function kindForStatus(httpStatus: number): { kind: MetaErrorKind; retryable: boolean } {
  if (httpStatus === 429) return { kind: 'rate_limited', retryable: true };
  if (httpStatus >= 500) return { kind: 'temporarily_unavailable', retryable: true };
  if (httpStatus === 401) return { kind: 'token_invalid', retryable: false };
  if (httpStatus === 403) return { kind: 'permission_denied', retryable: false };
  if (httpStatus === 404) return { kind: 'not_found', retryable: false };
  return { kind: 'unknown', retryable: false };
}

/**
 * Memetakan jawaban gagal Graph API. `body` = JSON yang sudah di-parse (atau `undefined` bila
 * bukan JSON). Tidak pernah melempar.
 */
export function classifyMetaError(httpStatus: number, body: unknown): MetaErrorInfo {
  const parsed = metaErrorBodySchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const code = error?.code ?? null;
  const subcode = error?.error_subcode ?? null;
  const message = [error?.message, error?.error_data?.details].filter(Boolean).join(' — ');

  let decision = code === null ? kindForStatus(httpStatus) : kindFor(code, subcode, message);
  // Kode yang tidak dikenali tetapi Meta sendiri menandainya sementara / server Meta 5xx.
  if (decision.kind === 'unknown' && (error?.is_transient === true || httpStatus >= 500)) {
    decision = { kind: 'temporarily_unavailable', retryable: true };
  }
  return {
    ...decision,
    metaCode: code,
    metaSubcode: subcode,
    fbtraceId: error?.fbtrace_id ?? null,
    metaMessage: message === '' ? null : message.slice(0, 500),
  };
}

/**
 * Kesalahan dari klien Graph API. Semua isiannya aman untuk log; `message` adalah pesan Indonesia
 * yang aman untuk pengguna (`META_ERROR_MESSAGES`). Token/App Secret/URL tidak pernah ikut.
 */
export class MetaApiError extends Error {
  readonly kind: MetaErrorKind;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly metaCode: number | null;
  readonly metaSubcode: number | null;
  readonly fbtraceId: string | null;
  /** Detik sampai boleh mencoba lagi (batas laju), bila diketahui. */
  readonly retryAfterSeconds: number | null;
  /** Operasi yang gagal (nama tetap, mis. `phone_number.read`). */
  readonly operation: string;
  readonly attempts: number;

  constructor(init: {
    kind: MetaErrorKind;
    retryable?: boolean;
    httpStatus?: number | null;
    metaCode?: number | null;
    metaSubcode?: number | null;
    fbtraceId?: string | null;
    retryAfterSeconds?: number | null;
    operation: string;
    attempts?: number;
  }) {
    super(META_ERROR_MESSAGES[init.kind]);
    this.name = 'MetaApiError';
    this.kind = init.kind;
    this.retryable = init.retryable ?? false;
    this.httpStatus = init.httpStatus ?? null;
    this.metaCode = init.metaCode ?? null;
    this.metaSubcode = init.metaSubcode ?? null;
    this.fbtraceId = init.fbtraceId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.operation = init.operation;
    this.attempts = init.attempts ?? 1;
  }
}

export function isMetaApiError(error: unknown): error is MetaApiError {
  return error instanceof MetaApiError;
}
