import {
  CONNECTION_CHANNEL_TYPES,
  type ConnectionChannel,
  type ConnectionChannelListResponse,
  type ConnectionChannelType,
} from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../../lib/api/endpoints';
import { retryTransient } from '../../inbox/inbox-queries';

/** Kunci cache channel selain WhatsApp (Pengaturan → Channel). */
export const connectionKeys = {
  all: ['settings', 'channel-connections'] as const,
  list: ['settings', 'channel-connections', 'list'] as const,
  detail: (id: string) => ['settings', 'channel-connections', 'detail', id] as const,
  webhook: (id: string) => ['settings', 'channel-connections', 'webhook', id] as const,
};

export const connectionsQuery = queryOptions({
  queryKey: connectionKeys.list,
  queryFn: ({ signal }) => endpoints.connections.list(signal),
  retry: retryTransient,
});

/** Data awal dari daftar (tanpa kedipan kerangka saat membuka dari daftar). */
export function connectionQuery(channelId: string, queryClient?: QueryClient) {
  return queryOptions({
    queryKey: connectionKeys.detail(channelId),
    queryFn: ({ signal }) => endpoints.connections.get(channelId, signal),
    initialData: () => {
      const list = queryClient?.getQueryData<ConnectionChannelListResponse>(connectionKeys.list);
      const channel = list?.channels.find((item) => item.id === channelId);
      return channel ? { channel } : undefined;
    },
    retry: retryTransient,
  });
}

/** Channel terbaru dari jawaban server → detail + daftar + ringkasan inbox. */
export function storeConnection(queryClient: QueryClient, channel: ConnectionChannel): void {
  queryClient.setQueryData(connectionKeys.detail(channel.id), { channel });
  queryClient.setQueryData<ConnectionChannelListResponse>(
    connectionKeys.list,
    (data) =>
      data && {
        ...data,
        channels: data.channels.some((item) => item.id === channel.id)
          ? data.channels.map((item) => (item.id === channel.id ? channel : item))
          : [...data.channels, channel],
      },
  );
  void queryClient.invalidateQueries({ queryKey: ['inbox', 'channels'] });
}

export function isConnectionType(value: string): value is ConnectionChannelType {
  return (CONNECTION_CHANNEL_TYPES as readonly string[]).includes(value);
}

/** Pesan sekali-tampil yang dibawa pindah halaman (mis. "Channel terhubung"). */
let flash: string | null = null;
export function setConnectionFlash(message: string): void {
  flash = message;
}
export function takeConnectionFlash(): string | null {
  const taken = flash;
  flash = null;
  return taken;
}
