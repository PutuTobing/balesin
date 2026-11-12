import { QueryClient } from '@tanstack/react-query';

/** Semua data server lewat TanStack Query; pembaruan real-time lewat WebSocket. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
      },
    },
  });
}
