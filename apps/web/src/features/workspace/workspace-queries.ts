import { queryOptions } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import { retryTransient } from '../inbox/inbox-queries';

/** Kunci cache pengaturan kerja tim & ketersediaan agen. `resync` menyegarkan via ['inbox'] / ini. */
export const workspaceKeys = {
  all: ['settings', 'workspace'] as const,
  settings: ['settings', 'workspace', 'settings'] as const,
  agents: ['settings', 'workspace', 'agents'] as const,
  availability: ['inbox', 'availability'] as const,
};

export const workspaceQuery = queryOptions({
  queryKey: workspaceKeys.settings,
  queryFn: ({ signal }) => endpoints.workspace.get(signal),
  retry: retryTransient,
});

export const workspaceAgentsQuery = queryOptions({
  queryKey: workspaceKeys.agents,
  queryFn: ({ signal }) => endpoints.workspace.agents(signal),
  retry: retryTransient,
});

/** Saklar "Tersedia" milik agen sendiri (`inbox.reply`). Teknisi → 409 (disembunyikan). */
export const availabilityQuery = queryOptions({
  queryKey: workspaceKeys.availability,
  queryFn: ({ signal }) => endpoints.availability.get(signal),
  retry: false,
  staleTime: 60_000,
});
