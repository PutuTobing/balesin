import { QueryClient } from '@tanstack/react-query';

/** QueryClient untuk tes: tanpa coba ulang, supaya error langsung terlihat. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
  });
}
