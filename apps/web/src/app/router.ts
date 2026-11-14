import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';
import { BootErrorScreen, BootScreen } from '../components/shell/BootScreen';
import { NotFoundPage } from '../components/shell/NotFoundPage';
import { PageSkeleton } from '../components/shell/PageSkeleton';
import { RootLayout } from '../components/shell/RootLayout';
import { RouteErrorScreen } from '../components/shell/RouteErrorScreen';
import { LoginSkeleton } from '../features/auth/LoginSkeleton';
import { parseLoginSearch } from '../features/auth/login-search';
import { EmailSettingsSkeleton } from '../features/email-settings/EmailSettingsSkeleton';
import { InboxPage } from '../features/inbox/InboxPage';
import { InboxSkeleton } from '../features/inbox/InboxSkeleton';
import { parseInboxSearch } from '../features/inbox/inbox-search';
import { SecuritySkeleton } from '../features/security/SecuritySkeleton';
import { SetupSkeleton } from '../features/setup/SetupSkeleton';
import { SetupStatusError } from '../features/setup/SetupStatusError';
import { EnrollmentSkeleton } from '../features/two-factor/EnrollmentSkeleton';
import { t } from '../i18n/id';
import { emailSettingsQuery, twoFactorStatusQuery } from '../lib/api/queries';
import { createPreviewRoutes } from './preview-routes';
import {
  guardEnrollment,
  guardLogin,
  guardOwner,
  guardSetup,
  guardVoluntaryEnrollment,
  prepareApp,
  requireSession,
} from './guards';

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Peta rute. Alamat halaman memakai bahasa Indonesia karena ikut tampil ke pengguna.
 *
 * - Publik: `/setup` (wizard pertama kali) dan `/masuk`.
 * - `/verifikasi-dua-langkah`: pendaftaran 2FA wajib, HANYA untuk sesi terbatas (Owner/Admin/
 *   Supervisor yang belum mengaktifkan 2FA). Sesi terbatas tidak bisa membuka rute lain.
 * - Semua rute lain ada di bawah layout `app`, yang mewajibkan sesi penuh (lihat `guards.ts`).
 *   Penjaga menunggu jawaban `/auth/me` SEBELUM merender apa pun, jadi tidak ada kedipan
 *   layar aplikasi untuk tamu atau layar masuk untuk pengguna yang sudah masuk.
 *
 * `staticData.page` = judul dan layar induk halaman satu kolom, dipakai `Page` dan
 * `PageSkeleton` (lihat components/ui/page-meta.ts).
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  beforeLoad: ({ context }) => prepareApp(context.queryClient),
  // Saat sesi/status setup diperiksa di muatan pertama: layar netral (belum diketahui apakah
  // berikutnya aplikasi, halaman masuk, atau wizard).
  pendingComponent: BootScreen,
  notFoundComponent: NotFoundPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'setup',
  beforeLoad: ({ context }) => guardSetup(context.queryClient),
  component: lazyRouteComponent(() => import('../features/setup/SetupPage'), 'SetupPage'),
  pendingComponent: SetupSkeleton,
  errorComponent: SetupStatusError,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'masuk',
  validateSearch: parseLoginSearch,
  beforeLoad: ({ context, search }) => guardLogin(context.queryClient, search.redirect),
  component: lazyRouteComponent(() => import('../features/auth/LoginPage'), 'LoginPage'),
  pendingComponent: LoginSkeleton,
});

/** Pendaftaran 2FA wajib (sesi terbatas): setelah setup, atau setelah masuk tanpa 2FA aktif. */
const enrollmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'verifikasi-dua-langkah',
  validateSearch: parseLoginSearch,
  beforeLoad: ({ context, search }) => guardEnrollment(context.queryClient, search.redirect),
  component: lazyRouteComponent(
    () => import('../features/two-factor/EnrollmentPage'),
    'EnrollmentPage',
  ),
  pendingComponent: EnrollmentSkeleton,
  errorComponent: BootErrorScreen,
});

/** Layout aplikasi (rail/navigasi bawah). Hanya untuk pengguna yang sudah masuk. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: AppShell,
  pendingComponent: BootScreen,
  pendingMs: 400,
  errorComponent: BootErrorScreen,
});

const getParentRoute = () => appRoute;

const indexRoute = createRoute({
  getParentRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/inbox', replace: true });
  },
});

const inboxRoute = createRoute({
  getParentRoute,
  path: 'inbox',
  validateSearch: parseInboxSearch,
  component: InboxPage,
  pendingComponent: InboxSkeleton,
});

const contactsRoute = createRoute({
  getParentRoute,
  path: 'kontak',
  staticData: { page: { title: t.nav.contacts } },
  component: lazyRouteComponent(() => import('../features/contacts/ContactsPage'), 'ContactsPage'),
});

const broadcastRoute = createRoute({
  getParentRoute,
  path: 'broadcast',
  staticData: { page: { title: t.nav.broadcast } },
  component: lazyRouteComponent(
    () => import('../features/broadcast/BroadcastPage'),
    'BroadcastPage',
  ),
});

const ticketsRoute = createRoute({
  getParentRoute,
  path: 'tiket',
  staticData: { page: { title: t.nav.tickets, parent: 'more' } },
  component: lazyRouteComponent(() => import('../features/tickets/TicketsPage'), 'TicketsPage'),
});

const reportsRoute = createRoute({
  getParentRoute,
  path: 'laporan',
  staticData: { page: { title: t.nav.reports, parent: 'more' } },
  component: lazyRouteComponent(() => import('../features/reports/ReportsPage'), 'ReportsPage'),
});

const settingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan',
  staticData: { page: { title: t.nav.settings, parent: 'more' } },
  component: lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage'),
});

/** Pengaturan → Email pengirim: khusus Owner (peran lain dialihkan ke Pengaturan). */
const emailSettingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/email',
  staticData: { page: { title: t.emailSettings.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardOwner(context.session),
  loader: ({ context }) => context.queryClient.ensureQueryData(emailSettingsQuery),
  component: lazyRouteComponent(
    () => import('../features/email-settings/EmailSettingsPage'),
    'EmailSettingsPage',
  ),
  pendingComponent: EmailSettingsSkeleton,
});

/** Pengaturan → Keamanan akun: semua peran. */
const securityRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/keamanan',
  staticData: { page: { title: t.security.title, parent: 'settings' } },
  loader: ({ context }) => context.queryClient.ensureQueryData(twoFactorStatusQuery),
  component: lazyRouteComponent(() => import('../features/security/SecurityPage'), 'SecurityPage'),
  pendingComponent: SecuritySkeleton,
});

/** Keamanan akun → Aktifkan 2FA (peran yang tidak wajib; yang wajib sudah aktif). */
const securityEnrollRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/keamanan/aktifkan',
  staticData: { page: { title: t.twoFactor.enroll.title, parent: 'security' } },
  beforeLoad: ({ context }) => guardVoluntaryEnrollment(context.queryClient),
  component: lazyRouteComponent(
    () => import('../features/two-factor/VoluntaryEnrollmentPage'),
    'VoluntaryEnrollmentPage',
  ),
});

const moreRoute = createRoute({
  getParentRoute,
  path: 'lainnya',
  staticData: { page: { title: t.nav.more } },
  component: lazyRouteComponent(() => import('../features/more/MorePage'), 'MorePage'),
});

/** Alamat yang tidak dikenal: 404 di dalam kerangka aplikasi (navigasi tetap bisa dipakai). */
const notFoundRoute = createRoute({
  getParentRoute,
  path: '$',
  component: NotFoundPage,
});

const appChildren = [
  indexRoute,
  inboxRoute,
  contactsRoute,
  broadcastRoute,
  ticketsRoute,
  reportsRoute,
  settingsRoute,
  emailSettingsRoute,
  securityRoute,
  securityEnrollRoute,
  moreRoute,
  notFoundRoute,
] as const;

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  enrollmentRoute,
  appRoute.addChildren(appChildren),
]);

/**
 * Mode pengembangan: tambah rute pratinjau. Tipe pohon rute sengaja tetap versi
 * produksi, jadi rute pratinjau tidak bisa dituju dari kode aplikasi.
 */
function routeTreeWithPreviews(): typeof routeTree {
  return rootRoute.addChildren([
    setupRoute,
    loginRoute,
    enrollmentRoute,
    appRoute.addChildren([...appChildren, ...createPreviewRoutes(appRoute)]),
  ]) as unknown as typeof routeTree;
}

interface AppRouterOptions {
  queryClient: QueryClient;
  /** Riwayat khusus (tes memakai riwayat di memori). Bawaan: riwayat browser. */
  history?: RouterHistory;
}

export function createAppRouter({ queryClient, history }: AppRouterOptions) {
  return createRouter({
    routeTree: import.meta.env.DEV ? routeTreeWithPreviews() : routeTree,
    context: { queryClient },
    history,
    defaultPreload: 'intent',
    // Data rute sudah dikelola TanStack Query; preload hanya memuat kode halaman.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PageSkeleton,
    defaultErrorComponent: RouteErrorScreen,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
