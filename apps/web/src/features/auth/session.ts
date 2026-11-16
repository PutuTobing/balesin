import type { AuthenticatedSession, MeResponse, Permission } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { clearAppData, endSession, sessionQuery } from '../../lib/api/queries';
import { releasePush } from '../notifications/push-device';
import { setLoginNotice } from './login-notice';

/**
 * Sesi PENUH yang sedang aktif. Hanya dipakai di bawah rute aplikasi: penjaga rute sudah
 * memastikan sesi penuh ada sebelum layar dirender, jadi `null` di sini berarti sesi baru saja
 * berakhir (atau berubah menjadi sesi terbatas).
 */
export function useSession(): AuthenticatedSession | null {
  const session = useQuery(sessionQuery).data;
  return session?.status === 'authenticated' ? session : null;
}

/**
 * Sesi ini memegang izin tersebut (daftar `permissions` dari server; docs/KONTRAK-API-AUTH.md
 * "Peran & izin"). Hanya untuk menyembunyikan menu/tombol — server tetap memeriksa setiap
 * permintaan. Matriks tidak ditulis ulang di web.
 */
export function sessionCan(
  session: MeResponse | null | undefined,
  permission: Permission,
): boolean {
  return session?.status === 'authenticated' && (session.permissions ?? []).includes(permission);
}

/** Sesi penuh yang sedang aktif memegang izin ini. */
export function useCan(permission: Permission): boolean {
  return sessionCan(useSession(), permission);
}

/** Sesi apa pun, termasuk sesi terbatas "wajib mendaftar 2FA" (layar pendaftaran 2FA). */
export function useAnySession(): MeResponse | null {
  return useQuery(sessionQuery).data ?? null;
}

/** Keluar: cabut sesi di server, bersihkan semua data Query, buka halaman masuk. */
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      // Lepas notifikasi perangkat ini selagi sesi masih berlaku (DELETE butuh sesi + CSRF).
      // Dibatasi 3 detik: keluar tidak boleh tertahan oleh layanan push yang lambat.
      await Promise.race([
        releasePush({ server: true }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      try {
        await endpoints.auth.logout();
      } catch (error) {
        // Sesi sudah tidak berlaku di server = hasil akhirnya sama dengan keluar.
        if (isApiError(error) && error.status === 401) return;
        throw error;
      }
    },
    onSuccess: async () => {
      // Urutan penting: sesi dikosongkan, pindah ke halaman masuk, BARU data aplikasi dibuang
      // (kalau dibuang lebih dulu, layar yang masih terbuka memuat ulang datanya → 401).
      endSession(queryClient);
      setLoginNotice('logged-out');
      try {
        await router.navigate({ to: '/masuk', replace: true });
      } finally {
        // Tetap dibuang walau navigasi gagal — komputer bersama tidak boleh menyisakan data.
        clearAppData(queryClient);
      }
    },
  });
}
