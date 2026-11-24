import type { EmailSenderSettings } from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';

/**
 * Pengirim email (Channel Email; akun Email setelah 9B) + batas per jam & keadaannya. Dipakai
 * Pengaturan → Batas kirim dan pemilih pengirim API key (keduanya Owner/Admin).
 */
export const emailSenderKeys = {
  list: ['email-senders', 'list'] as const,
};

export const emailSendersQuery = queryOptions({
  queryKey: emailSenderKeys.list,
  queryFn: ({ signal }) => endpoints.emailSenders.list(signal),
  staleTime: 30_000,
});

/** Ganti satu pengirim di cache setelah ubah batas / jeda / lanjut. */
export function storeEmailSender(queryClient: QueryClient, sender: EmailSenderSettings): void {
  queryClient.setQueryData(
    emailSenderKeys.list,
    (current: { senders: EmailSenderSettings[] } | undefined) =>
      current
        ? {
            senders: current.senders.map((item) => (item.id === sender.id ? sender : item)),
          }
        : current,
  );
}
