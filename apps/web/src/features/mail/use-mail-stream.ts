import { useQueryClient } from '@tanstack/react-query';
import type { StreamStatus } from '../inbox/inbox-stream';
import { useRealtimeStream } from '../inbox/use-inbox-stream';
import { applyMailEvent, isMailEvent } from './mail-events';
import { mailKeys } from './mail-queries';

/**
 * Real-time untuk layar Email & Pengaturan → Akun email: soket bersama (`useRealtimeStream`),
 * hanya event `mail.*` yang diterapkan. Tersambung ulang → semua data Email dimuat ulang.
 */
export function useMailStream(): StreamStatus {
  const queryClient = useQueryClient();
  return useRealtimeStream({
    onEvent: (event) => {
      if (isMailEvent(event)) applyMailEvent(queryClient, event);
    },
    onResync: () => void queryClient.invalidateQueries({ queryKey: mailKeys.all }),
  });
}
