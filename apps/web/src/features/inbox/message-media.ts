import { useCallback, useEffect, useRef, useState } from 'react';
import { endpoints } from '../../lib/api/endpoints';

/**
 * Media pesan lewat `fetch` ber-CSRF → `Blob` → object URL (review security Info 1): tidak pernah
 * `<img src>` langsung ke API. Blob disimpan sebentar di memori (paling banyak `CACHE_SIZE`) supaya
 * membuka chat yang sama lagi tidak mengunduh ulang; object URL dibuat per pemakai dan dicabut saat
 * komponennya dilepas.
 */
const CACHE_SIZE = 40;
const blobs = new Map<string, { blob: Blob; filename: string | null }>();

function remember(messageId: string, value: { blob: Blob; filename: string | null }): void {
  blobs.delete(messageId);
  blobs.set(messageId, value);
  while (blobs.size > CACHE_SIZE) {
    const oldest = blobs.keys().next().value;
    if (oldest === undefined) break;
    blobs.delete(oldest);
  }
}

/** Kosongkan cache (keluar dari aplikasi / tes). */
export function clearMediaCache(): void {
  blobs.clear();
}

/**
 * Nama berkas dari `Content-Disposition` server (RFC 5987 `filename*` lebih dulu). Nama dari teks
 * pesan TIDAK dipakai untuk unduhan. Karakter pemisah path dibuang.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  let name: string | null = null;
  if (extended?.[1]) {
    try {
      name = decodeURIComponent(extended[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
    name = plain?.[1]?.trim() ?? null;
  }
  // Karakter kendali dan pemisah path → "_" (tanpa regex berkarakter kendali).
  const clean = name
    ? Array.from(name, (char) =>
        char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? '_' : char,
      )
        .join('')
        .trim()
    : null;
  return clean ? clean : null;
}

async function fetchMedia(messageId: string, signal?: AbortSignal) {
  const cached = blobs.get(messageId);
  if (cached) return cached;
  const { blob, headers } = await endpoints.inbox.media(messageId, signal);
  const value = { blob, filename: filenameFromDisposition(headers.get('content-disposition')) };
  remember(messageId, value);
  return value;
}

export interface MediaState {
  url: string | null;
  loading: boolean;
  error: unknown;
  /** Muat (lagi). */
  load: () => void;
}

/** Object URL media pesan. `auto` = langsung dimuat (gambar); selain itu menunggu `load()`. */
export function useMessageMedia(messageId: string, auto: boolean): MediaState {
  const [attempt, setAttempt] = useState(auto ? 1 : 0);
  const [result, setResult] = useState<{ attempt: number; url: string | null; error: unknown }>({
    attempt: 0,
    url: null,
    error: null,
  });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (attempt === 0) return;
    const controller = new AbortController();
    fetchMedia(messageId, controller.signal)
      .then(({ blob }) => {
        if (controller.signal.aborted) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const next = URL.createObjectURL(blob);
        urlRef.current = next;
        setResult({ attempt, url: next, error: null });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setResult((current) => ({ attempt, url: current.url, error: reason }));
        }
      });
    return () => controller.abort();
  }, [messageId, attempt]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const load = useCallback(() => setAttempt((value) => value + 1), []);
  const settled = result.attempt === attempt;
  return {
    url: result.url,
    loading: attempt > 0 && !settled,
    error: settled ? result.error : null,
    load,
  };
}

/** Unduh berkas pesan sebagai lampiran (nama dari server). */
export async function downloadMessageMedia(messageId: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await fetchMedia(messageId);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename ?? fallbackName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Beri waktu browser memulai unduhan sebelum URL dicabut.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
