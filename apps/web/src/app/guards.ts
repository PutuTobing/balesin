import type { AuthenticatedSession, TwoFactorEnrollmentSession } from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import {
  brandingQuery,
  sessionQuery,
  setupStatusQuery,
  twoFactorStatusQuery,
} from '../lib/api/queries';
import { DEFAULT_AFTER_LOGIN, safeRedirectTarget } from '../lib/safe-redirect';

/*
 * Penjaga rute (dipanggil dari `beforeLoad` di router.ts). Semuanya MENUNGGU jawaban server
 * sebelum layar dirender, jadi pengguna tidak pernah melihat sekilas layar yang salah.
 *
 * Tiga keadaan sesi (docs/KONTRAK-API-AUTH.md bagian 2FA):
 *  - tidak ada            → halaman masuk (atau wizard setup pada instalasi baru);
 *  - terbatas             → HANYA layar pendaftaran 2FA (`/verifikasi-dua-langkah`) dan keluar;
 *  - penuh (`authenticated`) → semua layar aplikasi.
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

/** `?redirect=` yang layak dibawa: path internal selain tujuan bawaan. */
function redirectSearch(href: string | undefined): string | undefined {
  if (!href || href === '/') return undefined;
  const target = safeRedirectTarget(href);
  return target === DEFAULT_AFTER_LOGIN ? undefined : target;
}

/** Sesi terbatas → layar pendaftaran 2FA (tujuan awal ikut dibawa untuk setelah selesai). */
function toEnrollment(href: string | undefined): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
  throw redirect({
    to: '/verifikasi-dua-langkah',
    search: { redirect: redirectSearch(href) },
    replace: true,
  });
}

/** Tanpa sesi: wizard setup pada instalasi baru, selain itu halaman masuk. */
async function toLoginOrSetup(queryClient: QueryClient, href: string | undefined): Promise<never> {
  const status = await queryClient.ensureQueryData(setupStatusQuery).catch(() => null);
  if (status?.needsSetup) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/setup', replace: true });
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
  throw redirect({ to: '/masuk', search: { redirect: redirectSearch(href) }, replace: true });
}

/**
 * Rute aplikasi: wajib sesi PENUH. Belum masuk → halaman masuk (alamat tujuan disimpan di
 * `?redirect=`), atau wizard setup bila instalasi masih baru. Sesi terbatas → pendaftaran 2FA.
 */
export async function requireSession(
  queryClient: QueryClient,
  href: string,
): Promise<{ session: AuthenticatedSession }> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session?.status === 'authenticated') return { session };
  if (session) return toEnrollment(href);
  return toLoginOrSetup(queryClient, href);
}

/** Halaman masuk: yang sudah masuk langsung diteruskan; instalasi baru ke wizard setup. */
export async function guardLogin(queryClient: QueryClient, redirectTo: string | undefined) {
  const session = await queryClient.ensureQueryData(sessionQuery).catch(() => null);
  if (session?.status === 'authenticated') {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ href: safeRedirectTarget(redirectTo), replace: true });
  }
  if (session) toEnrollment(redirectTo);
  const status = await queryClient.ensureQueryData(setupStatusQuery).catch(() => null);
  if (status?.needsSetup) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/setup', replace: true });
  }
}

/**
 * Layar pendaftaran 2FA wajib: hanya untuk sesi terbatas. Sesi penuh sudah punya 2FA (atau
 * perannya tidak wajib) → halaman Keamanan akun; tanpa sesi → halaman masuk.
 */
export async function guardEnrollment(
  queryClient: QueryClient,
  redirectTo: string | undefined,
): Promise<{ session: TwoFactorEnrollmentSession }> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session?.status === 'two_factor_enrollment_required') return { session };
  if (session) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/pengaturan/keamanan', replace: true });
  }
  return toLoginOrSetup(queryClient, redirectTo);
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

/**
 * Mengaktifkan 2FA dari Keamanan akun (peran yang tidak wajib): bila sudah aktif, kembali ke
 * halaman Keamanan akun.
 */
export async function guardVoluntaryEnrollment(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.fetchQuery(twoFactorStatusQuery);
  if (status.enabled) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/pengaturan/keamanan', replace: true });
  }
}
