import { useCallback, useEffect, useState } from 'react';
import { isApiError } from '../../lib/api/client';
import { useLock, type Lock } from '../../lib/use-lock';

/**
 * Keadaan halaman tautan email bertoken setelah token dibaca dari fragment:
 *  - `missing`: alamat tanpa token (tautan terpotong saat disalin);
 *  - `loading`: token sedang diperiksa server;
 *  - `ready`:   token sah, isi tautan tersedia;
 *  - `invalid`: 410 `TOKEN_INVALID` (tidak dikenal, kedaluwarsa, sudah dipakai, dibatalkan) atau
 *               bentuk token salah — pesan server ditampilkan apa adanya;
 *  - `failed`:  jaringan putus, server bermasalah, atau 429 (bisa dicoba lagi).
 */
export type LinkState<T> =
  | { kind: 'missing' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'invalid'; message: string }
  | { kind: 'failed'; error: unknown };

/** Error yang berarti tautan tidak bisa dipakai lagi (bukan masalah sementara). */
export function linkInvalidMessage(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === 'TOKEN_INVALID') return error.message;
  const token = error.details.find((detail) => detail.field === 'token');
  if (error.code === 'VALIDATION_ERROR' && token) return token.message;
  return null;
}

/**
 * Periksa token ke server sekali saat halaman dibuka (dan lagi lewat `retry`). Token hanya
 * dipegang pemanggil di memori; hasilnya tidak masuk cache Query (kunci cache tidak boleh
 * memuat token).
 */
export function useLinkInspect<T>(
  token: string | null,
  inspect: (token: string, signal: AbortSignal) => Promise<T>,
): {
  state: LinkState<T>;
  setState: (state: LinkState<T>) => void;
  retry: () => void;
  lock: Lock;
} {
  const [state, setState] = useState<LinkState<T>>(
    token ? { kind: 'loading' } : { kind: 'missing' },
  );
  const [attempt, setAttempt] = useState(0);
  const lock = useLock();
  const { lockFor } = lock;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    inspect(token, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const invalid = linkInvalidMessage(error);
        if (invalid !== null) {
          setState({ kind: 'invalid', message: invalid });
          return;
        }
        if (isApiError(error) && error.status === 429 && error.retryAfterSeconds) {
          lockFor(error.retryAfterSeconds);
        }
        setState({ kind: 'failed', error });
      },
    );
    return () => controller.abort();
    // `inspect` sengaja tidak jadi pemicu: fungsi endpoint tetap, pemeriksaan ulang lewat `retry`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, attempt, lockFor]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, setState, retry, lock };
}
