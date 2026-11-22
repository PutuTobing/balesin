import type { InboxStreamEvent } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useState } from 'react';
import { queryKeys, refetchSession } from '../../lib/api/queries';
import { applyInboxEvent, refreshInbox } from './inbox-queries';
import { InboxStream, inboxStreamUrl, type SocketLike, type StreamStatus } from './inbox-stream';

/** Pengganti pembuat socket untuk tes (jsdom tidak punya server WebSocket). */
let socketFactory: ((url: string) => SocketLike) | undefined;
export function setInboxSocketFactory(factory: ((url: string) => SocketLike) | undefined): void {
  socketFactory = factory;
}

interface RealtimeHandlers {
  onEvent: (event: InboxStreamEvent) => void;
  /** Tersambung lagi setelah putus: event selama terputus tidak diulang server. */
  onResync: () => void;
}

/**
 * Hook WebSocket terpusat (`GET /inbox/stream` — satu soket untuk Inbox & Email, KONTRAK-API-EMAIL
 * keputusan 13). Dipasang oleh layar yang membutuhkan data real-time (Inbox, menu Email, Pengaturan
 * → Akun email); hanya satu layar aktif sekaligus, jadi hanya ada satu soket. Penanganan event
 * lewat `useEffectEvent` supaya soket tidak tersambung ulang saat penanganannya berubah.
 */
export function useRealtimeStream(handlers: RealtimeHandlers): StreamStatus {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const onEvent = useEffectEvent((event: InboxStreamEvent) => handlers.onEvent(event));
  const onResync = useEffectEvent(() => handlers.onResync());

  useEffect(() => {
    const stream = new InboxStream({
      url: inboxStreamUrl(),
      createSocket: socketFactory,
      onEvent: (event) => onEvent(event),
      onStatus: setStatus,
      onResync: () => onResync(),
      // 4401: sesi habis → `/auth/me` menjawab 401 dan aplikasi membuka halaman masuk.
      // 4403: izin berubah → sesi & penjaga rute diperiksa ulang.
      onAuthClosed: () => {
        // Keluar dari aplikasi ini sendiri: sesi di cache sudah dikosongkan, tidak perlu apa-apa.
        if (!queryClient.getQueryData(queryKeys.session)) return;
        void refetchSession(queryClient)
          .then(() => router.invalidate())
          .catch(() => undefined);
      },
    });
    stream.start();
    const onOnline = () => stream.reconnectNow();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      stream.stop();
    };
  }, [queryClient, router]);

  return status;
}

/**
 * WebSocket di halaman Inbox. Event diterapkan ke cache TanStack Query (`applyInboxEvent`, yang
 * juga meneruskan event `mail.*` ke cache Email); status sambungan dipakai untuk menentukan
 * seberapa sering daftar disegarkan lewat REST sebagai cadangan.
 */
export function useInboxStream(): StreamStatus {
  const queryClient = useQueryClient();
  return useRealtimeStream({
    onEvent: (event) => applyInboxEvent(queryClient, event),
    onResync: () => refreshInbox(queryClient),
  });
}

/**
 * Selang penyegaran REST cadangan: jarang selama real-time tersambung (menangkap perubahan
 * cakupan yang tidak dikirim lewat event, mis. chat Teknisi dialihkan), lebih sering bila putus.
 */
export function fallbackRefetchInterval(status: StreamStatus): number {
  return status === 'open' ? 120_000 : 20_000;
}
