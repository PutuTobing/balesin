import { type AuthenticatedSession } from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api, isApiError } from './client';
import { endpoints } from './endpoints';

/** Kunci query di satu tempat supaya invalidasi tidak salah ketik. */
export const queryKeys = {
  session: ['auth', 'session'] as const,
  branding: ['branding'] as const,
  setupStatus: ['setup', 'status'] as const,
  emailSettings: ['settings', 'email'] as const,
};

/**
 * Sesi yang sedang aktif, atau `null` bila belum masuk. 401 bukan error di sini: artinya
 * "belum masuk". Error lain (jaringan, 5xx) tetap error supaya layar gagal bisa tampil.
 * Token CSRF dari respons langsung dipasang di klien (memori saja).
 */
export const sessionQuery = queryOptions({
  queryKey: queryKeys.session,
  queryFn: async ({ signal }): Promise<AuthenticatedSession | null> => {
    try {
      const session = await endpoints.auth.me(signal);
      api.setCsrfToken(session.csrfToken);
      return session;
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        api.setCsrfToken(null);
        return null;
      }
      throw error;
    }
  },
  // Sesi berubah hanya lewat masuk/keluar/sesi habis, yang semuanya memperbarui cache ini.
  staleTime: Infinity,
  retry: false,
});

export const brandingQuery = queryOptions({
  queryKey: queryKeys.branding,
  queryFn: ({ signal }) => endpoints.branding.get(signal),
  staleTime: 5 * 60_000,
  retry: false,
});

export const setupStatusQuery = queryOptions({
  queryKey: queryKeys.setupStatus,
  queryFn: ({ signal }) => endpoints.setup.status(signal),
  staleTime: Infinity,
  retry: false,
});

export const emailSettingsQuery = queryOptions({
  queryKey: queryKeys.emailSettings,
  queryFn: ({ signal }) => endpoints.emailSettings.get(signal),
});

/** Simpan sesi baru (setelah masuk atau setup selesai) ke cache dan klien. */
export function storeSession(queryClient: QueryClient, session: AuthenticatedSession): void {
  api.setCsrfToken(session.csrfToken);
  queryClient.setQueryData(queryKeys.session, session);
}

/**
 * Bersihkan semua data milik sesi (setelah keluar atau sesi habis). Data publik (branding,
 * status setup) dibiarkan supaya halaman masuk tetap tampil dengan merek yang benar.
 */
export function clearSessionData(queryClient: QueryClient): void {
  api.setCsrfToken(null);
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] !== queryKeys.branding[0] && query.queryKey[0] !== 'setup',
  });
  queryClient.setQueryData(queryKeys.session, null);
}
