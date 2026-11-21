import type {
  ChannelSettingsListResponse,
  ChannelTestResult,
  WhatsAppChannel,
} from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/api/queries';

/**
 * Hasil tes koneksi → channel di cache (detail dan daftar) langsung ikut berubah, lalu keduanya
 * dimuat ulang dari server (yang menjadi sumber kebenaran: hasil tes yang selesai setelah
 * kredensial diganti di tempat lain tidak dicatat server).
 *
 * Sama dengan server: data nomor hanya diperbarui oleh tes yang berhasil, dan peringatan hanya ada
 * bila tes terakhir berhasil.
 */
export function applyTestResult(
  queryClient: QueryClient,
  channelId: string,
  result: ChannelTestResult,
): void {
  const patch = (channel: WhatsAppChannel): WhatsAppChannel => ({
    ...channel,
    status: result.ok ? 'connected' : 'failed',
    lastTest: {
      ok: result.ok,
      code: result.code,
      message: result.message,
      testedAt: result.testedAt,
    },
    number: result.ok && result.number ? result.number : channel.number,
    warnings: result.ok ? result.warnings : [],
  });
  queryClient.setQueryData<WhatsAppChannel>(queryKeys.channel(channelId), (old) =>
    old ? patch(old) : old,
  );
  queryClient.setQueryData<ChannelSettingsListResponse>(queryKeys.channels, (old) =>
    old
      ? {
          ...old,
          channels: old.channels.map((item) => (item.id === channelId ? patch(item) : item)),
        }
      : old,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.channel(channelId), exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
}

/**
 * Channel dihapus, langkah 1 (sebelum pindah halaman): channel hilang dari daftar di cache, jadi
 * daftar yang dibuka berikutnya langsung benar.
 */
export function dropChannelFromList(queryClient: QueryClient, channelId: string): void {
  queryClient.setQueryData<ChannelSettingsListResponse>(queryKeys.channels, (old) =>
    old ? { ...old, channels: old.channels.filter((item) => item.id !== channelId) } : old,
  );
}

/**
 * Channel dihapus, langkah 2 (setelah halaman nomor ditutup): buang data channel itu dari cache
 * dan muat ulang daftar. Tidak dilakukan selagi halaman nomor masih terpasang, karena query yang
 * masih dipakai akan langsung dimuat ulang dan dijawab 404.
 */
export function forgetChannel(queryClient: QueryClient, channelId: string): void {
  queryClient.removeQueries({ queryKey: queryKeys.channel(channelId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
}
