import type { AuthenticatedSession } from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { brandingQuery, sessionQuery, setupStatusQuery } from '../lib/api/queries';
import { DEFAULT_AFTER_LOGIN, safeRedirectTarget } from '../lib/safe-redirect';

/*
 * Penjaga rute (dipanggil dari `beforeLoad` di router.ts). Semuanya MENUNGGU jawaban server
 * sebelum layar dirender, jadi pengguna tidak pernah melihat sekilas layar yang salah.
 */

/**
 * Sebelum layar apa pun: muat branding (nama produk + logo white-label) supaya layar pertama
 * sudah memakai merek yang benar. Gagal memuat branding tidak menghalangi aplikasi (merek
 * bawaan dipakai). Pemeriksaan sesi dimulai bersamaan supaya tidak menunggu bergantian.
 */
export async function prepareApp(queryClient: QueryClient): Promise<void> {
  void queryClient.prefetchQuery(sessionQuery);
  await queryClient.ensureQueryData(brandingQuery).catch(() => undefined);
}

/**
 * Rute aplikasi: wajib sudah masuk. Belum masuk → halaman masuk (alamat tujuan disimpan di
 * `?redirect=`), atau wizard setup bila instalasi masih baru.
 */
export async function requireSession(
  queryClient: QueryClient,
  href: string,
): Promise<{ session: AuthenticatedSession }> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session) return { session };

  const status = await queryClient.ensureQueryData(setupStatusQuery).catch(() => null);
  if (status?.needsSetup) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/setup', replace: true });
  }
  const target = safeRedirectTarget(href);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
  throw redirect({
    to: '/masuk',
    search: { redirect: target === DEFAULT_AFTER_LOGIN || href === '/' ? undefined : target },
    replace: true,
  });
}

/** Halaman masuk: yang sudah masuk langsung diteruskan; instalasi baru ke wizard setup. */
export async function guardLogin(queryClient: QueryClient, redirectTo: string | undefined) {
  const session = await queryClient.ensureQueryData(sessionQuery).catch(() => null);
  if (session) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ href: safeRedirectTarget(redirectTo), replace: true });
  }
  const status = await queryClient.ensureQueryData(setupStatusQuery).catch(() => null);
  if (status?.needsSetup) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/setup', replace: true });
  }
}

/**
 * Wizard setup: hanya selama belum ada Owner. Status yang gagal dimuat dilempar ke
 * `errorComponent` rute (layar "status setup tidak bisa dimuat").
 */
export async function guardSetup(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.ensureQueryData(setupStatusQuery);
  if (!status.needsSetup) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/masuk', replace: true });
  }
}

/** Halaman khusus Owner. Peran lain dialihkan ke Pengaturan (menunya pun tidak tampil). */
export function guardOwner(session: AuthenticatedSession): void {
  if (session.user.role !== 'owner') {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/pengaturan', replace: true });
  }
}
