import type { MeResponse } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { setLoginNotice } from '../../features/auth/login-notice';
import { api } from '../../lib/api/client';
import { clearAppData, endSession, queryKeys, refetchSession } from '../../lib/api/queries';
import { isGuestPage, safeRedirectTarget } from '../../lib/safe-redirect';
import { onServiceWorkerNavigate } from '../../pwa/service-worker';

const ENROLLMENT_PATH = '/verifikasi-dua-langkah';

/** Peran + izin sesi sebagai satu nilai pembanding. */
function permissionKey(session: MeResponse | null | undefined): string {
  if (!session) return '';
  return `${session.status}:${session.user.role}:${(session.permissions ?? []).join(',')}`;
}

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
 *    layar pendaftaran 2FA dibuka;
 *  - izin ditolak (403 `FORBIDDEN`, mis. peran baru saja diubah Owner/Admin): sesi dimuat ulang;
 *    bila izinnya memang berubah, penjaga rute diperiksa ulang (menu yang tidak berhak hilang,
 *    halaman yang tidak lagi boleh dibuka dialihkan). Izin yang tidak berubah = 403 biasa dari
 *    aturan rinci modul; layar menampilkan pesannya sendiri (tanpa memuat ulang berulang-ulang).
 */
export function RootLayout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  // Klik notifikasi saat tab sudah terbuka: service worker meminta router membuka path-nya (path
  // relatif aplikasi, sudah divalidasi di kedua sisi).
  useEffect(
    () => onServiceWorkerNavigate((path) => void router.navigate({ href: path })),
    [router],
  );

  useEffect(
    () =>
      api.onSessionExpired(() => {
        const { pathname, href, search } = router.state.location;
        // Halaman tamu (masuk, setup, tautan email): cukup kosongkan sesi, tetap di halaman ini.
        if (isGuestPage(pathname)) {
          endSession(queryClient);
          return;
        }
        // Sesi dikosongkan dulu, data aplikasi dibuang SETELAH pindah halaman (lihat useLogout).
        endSession(queryClient);
        setLoginNotice('session-ended');
        void router
          .navigate({
            to: '/masuk',
            search: {
              redirect:
                pathname === ENROLLMENT_PATH ? carriedRedirect(search) : safeRedirectTarget(href),
            },
            replace: true,
          })
          .finally(() => clearAppData(queryClient));
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

  useEffect(
    () =>
      api.onForbidden(() => {
        const before = queryClient.getQueryData<MeResponse | null>(queryKeys.session);
        void refetchSession(queryClient)
          .then(async (after) => {
            if (permissionKey(before) === permissionKey(after)) return;
            await router.invalidate();
          })
          // Gagal memuat sesi (jaringan putus): layar sekarang tetap menampilkan error-nya.
          .catch(() => undefined);
      }),
    [queryClient, router],
  );

  return <Outlet />;
}
