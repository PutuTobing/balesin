import { type MeResponse } from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api, isApiError } from './client';
import { endpoints } from './endpoints';

/** Kunci query di satu tempat supaya invalidasi tidak salah ketik. */
export const queryKeys = {
  session: ['auth', 'session'] as const,
  branding: ['branding'] as const,
  setupStatus: ['setup', 'status'] as const,
  emailSettings: ['settings', 'email'] as const,
  twoFactorStatus: ['auth', 'two-factor'] as const,
};

/**
 * Sesi yang sedang aktif, atau `null` bila belum masuk. 401 bukan error di sini: artinya
 * "belum masuk". Error lain (jaringan, 5xx) tetap error supaya layar gagal bisa tampil.
 * Token CSRF dari respons langsung dipasang di klien (memori saja).
 *
 * Sesi bisa penuh (`authenticated`) atau terbatas (`two_factor_enrollment_required`: Owner/
 * Admin/Supervisor yang belum mengaktifkan 2FA, hanya boleh membuka layar pendaftaran 2FA).
 */
export const sessionQuery = queryOptions({
  queryKey: queryKeys.session,
  queryFn: async ({ signal }): Promise<MeResponse | null> => {
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

/** Status 2FA pengguna yang sedang masuk (Pengaturan → Keamanan akun). */
export const twoFactorStatusQuery = queryOptions({
  queryKey: queryKeys.twoFactorStatus,
  queryFn: ({ signal }) => endpoints.twoFactor.status(signal),
});

/**
 * Simpan sesi baru (setelah masuk, langkah 2FA, pendaftaran 2FA, atau setup selesai) ke cache
 * dan klien. Hanya bagian sesi yang disimpan: respons pendaftaran 2FA juga memuat kode cadangan,
 * dan kode itu TIDAK boleh tertinggal di cache Query (hanya ditampilkan sekali).
 */
export function storeSession(queryClient: QueryClient, response: MeResponse): void {
  const { status, user, organization, csrfToken, session } = response;
  const clean: MeResponse = { status, user, organization, csrfToken, session };
  api.setCsrfToken(clean.csrfToken);
  queryClient.setQueryData(queryKeys.session, clean);
}

/** Ambil ulang sesi dari server (mis. setelah API menjawab "wajib mendaftar 2FA"). */
export function refetchSession(queryClient: QueryClient): Promise<MeResponse | null> {
  return queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

/**
 * Bersihkan semua data milik sesi (setelah keluar atau sesi habis). Data publik (branding,
 * status setup) dibiarkan supaya halaman masuk tetap tampil dengan merek yang benar.
 */
export function clearSessionData(queryClient: QueryClient): void {
  api.setCsrfToken(null);
  clearAppData(queryClient);
  queryClient.setQueryData(queryKeys.session, null);
}

/** Hapus data aplikasi milik pengguna, kecuali sesi itu sendiri dan data publik. */
export function clearAppData(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] !== queryKeys.branding[0] &&
      query.queryKey[0] !== 'setup' &&
      query.queryHash !== JSON.stringify(queryKeys.session),
  });
}
