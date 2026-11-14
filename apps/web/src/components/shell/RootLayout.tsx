import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { setLoginNotice } from '../../features/auth/login-notice';
import { api } from '../../lib/api/client';
import { clearAppData, clearSessionData, refetchSession } from '../../lib/api/queries';
import { safeRedirectTarget } from '../../lib/safe-redirect';

const ENROLLMENT_PATH = '/verifikasi-dua-langkah';

/** `?redirect=` yang dibawa layar pendaftaran 2FA (tujuan awal sebelum diminta mendaftar). */
function carriedRedirect(search: unknown): string | undefined {
  const value = (search as { redirect?: unknown } | null)?.redirect;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Akar semua layar. Mengawasi dua kejadian dari API di tengah pemakaian:
 *  - sesi berakhir (401 `UNAUTHENTICATED`, termasuk sesi yang dicabut server karena perannya
 *    berubah): data sesi dibersihkan lalu halaman masuk dibuka, dengan alamat sekarang sebagai
 *    tujuan setelah masuk lagi;
 *  - sesi ternyata terbatas (403 `TWO_FACTOR_ENROLLMENT_REQUIRED`, mis. layar aplikasi yang
 *    masih terbuka di tab lain): sesi dimuat ulang dari `/auth/me`, data aplikasi dibuang, lalu
 *    layar pendaftaran 2FA dibuka.
 */
export function RootLayout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(
    () =>
      api.onSessionExpired(() => {
        const { pathname, href, search } = router.state.location;
        if (pathname === '/masuk' || pathname === '/setup') return;
        clearSessionData(queryClient);
        setLoginNotice('session-ended');
        void router.navigate({
          to: '/masuk',
          search: {
            redirect:
              pathname === ENROLLMENT_PATH ? carriedRedirect(search) : safeRedirectTarget(href),
          },
          replace: true,
        });
      }),
    [queryClient, router],
  );

  useEffect(
    () =>
      api.onTwoFactorEnrollmentRequired(() => {
        const { pathname, href } = router.state.location;
        if (pathname === ENROLLMENT_PATH) return;
        void refetchSession(queryClient)
          .then(async () => {
            await router.navigate({
              to: ENROLLMENT_PATH,
              search: { redirect: safeRedirectTarget(href) },
              replace: true,
            });
            // Setelah layar aplikasi ditutup (kalau sebelumnya, query yang masih terpasang
            // langsung memuat ulang dan ditolak lagi).
            clearAppData(queryClient);
          })
          // Gagal memuat sesi (jaringan putus): layar sekarang tetap menampilkan error-nya.
          .catch(() => undefined);
      }),
    [queryClient, router],
  );

  return <Outlet />;
}
