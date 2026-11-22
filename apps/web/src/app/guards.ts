import type { AuthenticatedSession, Permission, TwoFactorEnrollmentSession } from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import {
  brandingQuery,
  securitySummaryQuery,
  sessionQuery,
  setupStatusQuery,
  twoFactorStatusQuery,
} from '../lib/api/queries';
import { DEFAULT_AFTER_LOGIN, safeRedirectTarget } from '../lib/safe-redirect';
import { sessionCan } from '../features/auth/session';

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

/** Batas tunggu ringkasan keamanan saat aplikasi dibuka (jangan menahan aplikasi lebih lama). */
const SUMMARY_WAIT_MS = 1_500;

/**
 * Pemegang `audit.view`: ringkasan keamanan dimuat SEBELUM kerangka aplikasi tampil, supaya
 * banner peringatan sudah ada di render pertama dan tidak mendorong isi halaman ke bawah (CLS).
 * Gagal atau lambat → aplikasi tetap dibuka; banner menyusul bila datanya tiba.
 */
async function prepareSecuritySummary(
  queryClient: QueryClient,
  session: AuthenticatedSession,
): Promise<void> {
  if (!sessionCan(session, 'audit.view')) return;
  await Promise.race([
    queryClient.ensureQueryData(securitySummaryQuery).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, SUMMARY_WAIT_MS)),
  ]);
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
  if (session?.status === 'authenticated') {
    await prepareSecuritySummary(queryClient, session);
    return { session };
  }
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

/**
 * Halaman ber-izin (mis. Email pengirim = `settings.email.manage`, Tim = `team.invite`). Peran tanpa
 * izin dialihkan ke Pengaturan (menunya pun tidak tampil). Server tetap menegakkan izinnya.
 */
/** Tujuan pengalihan bila izin tidak ada: halaman yang selalu boleh dibuka peran itu. */
type DeniedTarget = '/pengaturan' | '/inbox';

export function guardPermission(
  session: AuthenticatedSession,
  permission: Permission,
  to: DeniedTarget = '/pengaturan',
): void {
  if (!sessionCan(session, permission)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to, replace: true });
  }
}

/** Halaman yang cukup dengan salah satu izin (mis. Tim = `team.invite` atau `team.manage`). */
export function guardAnyPermission(
  session: AuthenticatedSession,
  permissions: readonly Permission[],
  to: DeniedTarget = '/pengaturan',
): void {
  if (!permissions.some((permission) => sessionCan(session, permission))) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to, replace: true });
  }
}

/**
 * Rute menu utama: izin dibaca dari `nav-items.ts` (sumber yang sama dengan menu), jadi menu yang
 * disembunyikan juga tidak bisa dibuka lewat alamat. Tanpa izin → Inbox (semua peran boleh).
 */
export function guardNavRoute(
  session: AuthenticatedSession,
  permission: Permission | undefined,
): void {
  if (permission) guardPermission(session, permission, '/inbox');
}

/**
 * Halaman publik dari tautan email: sesi (bila ada) dimuat lebih dulu supaya peringatan "sedang
 * masuk sebagai …" langsung tampil tanpa kedipan. Gagal memuat sesi tidak menghalangi halaman.
 */
export async function preparePublicLink(queryClient: QueryClient): Promise<void> {
  await queryClient.ensureQueryData(sessionQuery).catch(() => null);
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

/**
 * Menu Email & Pengaturan → Akun email (KONTRAK-API-EMAIL §1): `mail.view` DAN `navigation.mail`
 * dari sesi (punya akun yang bisa diakses, atau boleh menghubungkan akun). Menu yang tidak tampil
 * juga tidak bisa dibuka lewat alamat. Server tetap menegakkan hak per akun.
 */
export function guardMail(session: AuthenticatedSession, to: DeniedTarget = '/inbox'): void {
  if (!sessionCan(session, 'mail.view') || session.navigation?.mail !== true) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to, replace: true });
  }
}
