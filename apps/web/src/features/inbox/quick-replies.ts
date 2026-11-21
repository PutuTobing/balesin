import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';

/** Paling banyak sekian pilihan tampil (urut paling sering dipakai dari server). */
export const QUICK_REPLY_SHOWN = 8;

/**
 * Perintah `/` di composer: seluruh isi kolom berupa `/kata` (tanpa spasi) → daftar template.
 * Mengembalikan kata yang dicari (boleh kosong), atau `null` bila bukan perintah.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s/]{0,50})$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

export function quickRepliesQuery(search: string) {
  return {
    queryKey: ['inbox', 'quick-replies', search] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      endpoints.quickReplies.list(search || null, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  };
}

/** Hasil `GET /quick-replies?q=` (pemanggil: composer). */
export function useQuickReplies(search: string | null) {
  const result = useQuery({
    ...quickRepliesQuery(search ?? ''),
    enabled: search !== null,
  });
  return {
    items: (result.data?.quickReplies ?? []).slice(0, QUICK_REPLY_SHOWN),
    loading: result.isPending && search !== null,
    failed: result.isError,
  };
}
