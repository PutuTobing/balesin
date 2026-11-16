import { AppError, type Logger } from '@balesin/core';
import { apiKeys, type Database } from '@balesin/db';
import { apiKeyHasScope, type ApiKeyScope } from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { clientInfo } from '../../http/client-info';
import type { ApiKeyCredential } from '../../http/route-access';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { ipAllowed, parseApiKey, secretMatches } from './api-key-token';

/**
 * Autentikasi API publik (Fase 3, docs/KONTRAK-API-PUBLIK.md "Autentikasi"):
 *  1. `Authorization: Bearer blsn_live_<id>_<rahasia>` — cookie/CSRF TIDAK dipakai sama sekali;
 *  2. kegagalan per IP dibatasi (`api-key-gagal`, 30/menit) — HANYA jalur gagal (key sah tetap dilayani);
 *  3. key dicari lewat `<id>`, rahasia dibandingkan waktu-konstan (HMAC berlada);
 *  4. dicabut/kedaluwarsa → 401; IP di luar daftar key → 403; scope kurang → 403;
 *  5. batas laju per key (`api-key`, 300/menit) → 429;
 *  6. `last_used_at` diperbarui paling sering sekali per menit.
 * Nilai key TIDAK PERNAH ditulis ke log (header `authorization` sudah disensor logger).
 */

export interface ApiKeyPrincipal {
  id: string;
  organizationId: string;
  name: string;
  scopes: string[];
  dailySendLimit: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Pemanggil API publik (rute `requireApiKeyScope`); `null` di rute lain. */
    apiKey: ApiKeyPrincipal | null;
  }
}

export interface ApiKeyAuthenticator {
  authenticate(
    request: FastifyRequest,
    scope: ApiKeyScope | null,
    credential?: ApiKeyCredential,
  ): Promise<ApiKeyPrincipal>;
}

export const API_KEY_RULE: RateLimitRule = { name: 'api-key', limit: 300, windowSeconds: 60 };
export const API_KEY_FAILURE_RULE: RateLimitRule = {
  name: 'api-key-gagal',
  limit: 30,
  windowSeconds: 60,
};

const INVALID =
  'API key tidak valid, sudah dicabut, atau kedaluwarsa. Periksa header Authorization: Bearer <API key>.';
const MISSING = 'API key wajib dikirim di header Authorization: Bearer <API key>.';
const INVALID_X_API_KEY =
  'API key tidak valid, sudah dicabut, atau kedaluwarsa. Periksa header X-API-Key.';
const MISSING_X_API_KEY = 'API key wajib dikirim di header X-API-Key.';

/**
 * Nilai key dari permintaan. Lapisan MobiChat: header `X-API-Key` (nama header tidak peka huruf;
 * key di query string sengaja TIDAK diterima — URL bisa masuk log proxy/riwayat).
 */
function presentedKey(request: FastifyRequest, credential: ApiKeyCredential): string | null {
  if (credential === 'x-api-key') {
    const header = request.headers['x-api-key'];
    const value = Array.isArray(header) ? undefined : header?.trim();
    return value ? value : null;
  }
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer +(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

export function createApiKeyAuthenticator(deps: {
  db: Database;
  limiter: RateLimiter;
  /** `null` = master key tidak ada → semua key ditolak. */
  pepper: Buffer | null;
  logger: Pick<Logger, 'warn'>;
  now?: () => Date;
}): ApiKeyAuthenticator {
  const { db, limiter, pepper } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Jalur GAGAL saja (review API publik R1): key sah tetap dilayani walau IP-nya sedang dikunci,
   * jadi penyerang di NAT/proxy bersama tidak bisa memblokir integrasi sah. IP yang terkunci
   * mendapat 429 untuk key salah berikutnya (tanpa menambah hitungan).
   */
  async function fail(ipKey: string, message: string): Promise<never> {
    const failures = await limiter.peek(API_KEY_FAILURE_RULE, ipKey).catch(() => null);
    if (failures && !failures.allowed) {
      throw new AppError('RATE_LIMITED', {
        message: 'Terlalu banyak API key yang salah dari alamat ini. Coba lagi sebentar lagi.',
        retryAfterSeconds: failures.retryAfterSeconds,
      });
    }
    await limiter.consume(API_KEY_FAILURE_RULE, ipKey).catch(() => undefined);
    throw new AppError('UNAUTHENTICATED', { message });
  }

  return {
    async authenticate(request, scope, credential = 'bearer') {
      const client = clientInfo(request);
      const ipKey = client.ip ?? 'tanpa-ip';
      const invalid = credential === 'x-api-key' ? INVALID_X_API_KEY : INVALID;
      const presented = presentedKey(request, credential);
      // Tanpa header bukan tebakan kunci: tidak dihitung ke batas kegagalan.
      if (!presented) {
        throw new AppError('UNAUTHENTICATED', {
          message: credential === 'x-api-key' ? MISSING_X_API_KEY : MISSING,
        });
      }
      const parsed = parseApiKey(presented);
      if (!parsed || !pepper) return fail(ipKey, invalid);

      const [key] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.lookupKey, parsed.lookupKey))
        .limit(1);
      const at = now();
      if (
        !key ||
        !secretMatches(pepper, parsed, key.secretHash) ||
        key.revokedAt !== null ||
        (key.expiresAt !== null && key.expiresAt.getTime() <= at.getTime())
      ) {
        return fail(ipKey, invalid);
      }
      if (!ipAllowed(client.ip, key.allowedIps)) {
        throw new AppError('FORBIDDEN', {
          message: 'Alamat IP ini tidak diizinkan memakai API key tersebut.',
        });
      }
      if (scope !== null && !apiKeyHasScope(key.scopes, scope)) {
        throw new AppError('FORBIDDEN', {
          message: `API key ini tidak punya izin "${scope}". Buat key dengan scope tersebut di Pengaturan → API key.`,
        });
      }
      await enforceRateLimit(
        limiter,
        API_KEY_RULE,
        key.id,
        (wait) => `Batas permintaan API key ini tercapai. Coba lagi dalam ${wait}.`,
      );
      // Jejak pemakaian (paling sering sekali per menit; gagal ditulis tidak menggagalkan permintaan).
      await db
        .update(apiKeys)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(apiKeys.id, key.id),
            or(
              isNull(apiKeys.lastUsedAt),
              lt(apiKeys.lastUsedAt, sql`${at}::timestamptz - interval '1 minute'`),
            ),
          ),
        )
        .catch((err: unknown) => {
          deps.logger.warn({ err, apiKeyId: key.id }, 'Waktu pakai API key tidak tercatat');
        });
      return {
        id: key.id,
        organizationId: key.organizationId,
        name: key.name,
        scopes: key.scopes,
        dailySendLimit: key.dailySendLimit,
      };
    },
  };
}

/** Pemanggil API publik di handler rute `requireApiKeyScope`. */
export function requireApiKey(request: FastifyRequest): ApiKeyPrincipal {
  if (!request.apiKey) throw new AppError('UNAUTHENTICATED', { message: MISSING });
  return request.apiKey;
}
