import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { setLoginNotice } from '../../features/auth/login-notice';
import { api } from '../../lib/api/client';
import { clearSessionData } from '../../lib/api/queries';
import { safeRedirectTarget } from '../../lib/safe-redirect';

/**
 * Akar semua layar. Mengawasi sesi yang berakhir di tengah pemakaian (API menjawab 401
 * `UNAUTHENTICATED`): data sesi dibersihkan lalu halaman masuk dibuka, dengan alamat sekarang
 * sebagai tujuan setelah masuk lagi.
 */
export function RootLayout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(
    () =>
      api.onSessionExpired(() => {
        const { pathname, href } = router.state.location;
        if (pathname === '/masuk' || pathname === '/setup') return;
        clearSessionData(queryClient);
        setLoginNotice('session-ended');
        void router.navigate({
          to: '/masuk',
          search: { redirect: safeRedirectTarget(href) },
          replace: true,
        });
      }),
    [queryClient, router],
  );

  return <Outlet />;
}
