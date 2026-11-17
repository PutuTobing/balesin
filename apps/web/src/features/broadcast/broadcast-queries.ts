import type { BroadcastCampaign, BroadcastStatus } from '@balesin/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import { isLive } from './broadcast-logic';

/** Kunci cache broadcast. Event WebSocket `resync` menyegarkan semuanya (lihat `applyInboxEvent`). */
export const broadcastKeys = {
  all: ['broadcasts'] as const,
  lists: ['broadcasts', 'list'] as const,
  list: (status: BroadcastStatus | null) => ['broadcasts', 'list', status ?? 'semua'] as const,
  detail: (id: string) => ['broadcasts', 'detail', id] as const,
  report: (id: string) => ['broadcasts', 'report', id] as const,
  recipients: (id: string, status: string | null) =>
    ['broadcasts', 'recipients', id, status ?? 'semua'] as const,
  preview: (id: string) => ['broadcasts', 'preview', id] as const,
  estimate: (id: string) => ['broadcasts', 'estimate', id] as const,
  connectorOptions: ['broadcasts', 'connector-options'] as const,
  settings: ['broadcasts', 'settings'] as const,
  connectors: ['settings', 'broadcast-connectors'] as const,
  telegram: ['settings', 'alarm-telegram'] as const,
};

/** Selang penyegaran detail/laporan selama kampanye masih bergerak. */
export const LIVE_REFRESH_MS = 4_000;

export const broadcastListQuery = (status: BroadcastStatus | null) =>
  infiniteQueryOptions({
    queryKey: broadcastKeys.list(status),
    queryFn: ({ signal, pageParam }) => endpoints.broadcasts.list(status, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.broadcasts.some((item) => isLive(item.status)))
        ? 10_000
        : false,
  });

export const broadcastQuery = (id: string) =>
  queryOptions({
    queryKey: broadcastKeys.detail(id),
    queryFn: ({ signal }) => endpoints.broadcasts.get(id, signal),
    refetchInterval: (query) => {
      const status = query.state.data?.broadcast.status;
      return status && isLive(status) ? LIVE_REFRESH_MS : false;
    },
  });

export const broadcastSettingsQuery = queryOptions({
  queryKey: broadcastKeys.settings,
  queryFn: ({ signal }) => endpoints.broadcasts.settings(signal),
});

export const connectorOptionsQuery = queryOptions({
  queryKey: broadcastKeys.connectorOptions,
  queryFn: ({ signal }) => endpoints.broadcasts.connectorOptions(signal),
});

export const connectorsQuery = queryOptions({
  queryKey: broadcastKeys.connectors,
  queryFn: ({ signal }) => endpoints.connectors.list(signal),
});

export const telegramAlarmQuery = queryOptions({
  queryKey: broadcastKeys.telegram,
  queryFn: ({ signal }) => endpoints.alarms.telegram(signal),
});

/** Simpan kampanye terbaru (jawaban aksi) ke cache detail, lalu segarkan daftar & laporan. */
export function storeBroadcast(queryClient: QueryClient, broadcast: BroadcastCampaign): void {
  queryClient.setQueryData(broadcastKeys.detail(broadcast.id), { broadcast });
  void queryClient.invalidateQueries({ queryKey: broadcastKeys.lists });
  void queryClient.invalidateQueries({ queryKey: broadcastKeys.report(broadcast.id) });
  void queryClient.invalidateQueries({ queryKey: ['broadcasts', 'recipients', broadcast.id] });
}

/** Pesan sekali-tampil yang dibawa pindah halaman (mis. "Draf dihapus"). */
let flash: string | null = null;
export function setBroadcastFlash(message: string): void {
  flash = message;
}
export function takeBroadcastFlash(): string | null {
  const taken = flash;
  flash = null;
  return taken;
}
