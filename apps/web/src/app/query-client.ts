import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '../lib/api/client';

/** Berapa kali permintaan yang kena 429 dicoba ulang sebelum galatnya ditampilkan. */
export const RATE_LIMIT_RETRIES = 3;
/** Jeda 429 terpanjang yang masih ditunggu diam-diam; lebih lama → tampilkan galat + hitung mundur. */
export const RATE_LIMIT_MAX_WAIT_SECONDS = 10;
/** Jeda bila server tidak mengirim `Retry-After`. */
const RATE_LIMIT_FALLBACK_SECONDS = 5;

/**
 * Coba ulang bawaan semua query: 429 (mis. gerbang laporan yang sedang penuh) ditunggu sesuai
 * `Retry-After` sampai `RATE_LIMIT_RETRIES` kali bila jedanya pendek (audit akhir QA S1); galat
 * lain dicoba ulang sekali seperti sebelumnya.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status === 429) {
    const wait = error.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS;
    return failureCount < RATE_LIMIT_RETRIES && wait <= RATE_LIMIT_MAX_WAIT_SECONDS;
  }
  return failureCount < 1;
}

/** Jeda coba ulang: 429 → `Retry-After`; selainnya mundur eksponensial bawaan (maks. 30 dtk). */
export function retryQueryDelay(failureCount: number, error: unknown): number {
  if (isApiError(error) && error.status === 429) {
    return (error.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS) * 1000;
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

/** Semua data server lewat TanStack Query; pembaruan real-time lewat WebSocket. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: retryQuery,
        retryDelay: retryQueryDelay,
      },
    },
  });
}
