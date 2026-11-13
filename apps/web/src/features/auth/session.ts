import type { AuthenticatedSession } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { clearSessionData, sessionQuery } from '../../lib/api/queries';
import { setLoginNotice } from './login-notice';

/**
 * Sesi yang sedang aktif. Hanya dipakai di bawah rute aplikasi: penjaga rute sudah memastikan
 * sesi ada sebelum layar dirender, jadi `null` di sini berarti sesi baru saja berakhir.
 */
export function useSession(): AuthenticatedSession | null {
  return useQuery(sessionQuery).data ?? null;
}

/** Keluar: cabut sesi di server, bersihkan semua data Query, buka halaman masuk. */
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      try {
        await endpoints.auth.logout();
      } catch (error) {
        // Sesi sudah tidak berlaku di server = hasil akhirnya sama dengan keluar.
        if (isApiError(error) && error.status === 401) return;
        throw error;
      }
    },
    onSuccess: async () => {
      clearSessionData(queryClient);
      setLoginNotice('logged-out');
      await router.navigate({ to: '/masuk', replace: true });
    },
  });
}
