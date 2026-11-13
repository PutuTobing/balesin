import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';
import { NotFoundPage } from '../components/shell/NotFoundPage';
import { PageSkeleton } from '../components/shell/PageSkeleton';
import { RouteErrorScreen } from '../components/shell/RouteErrorScreen';
import { InboxPage } from '../features/inbox/InboxPage';
import { InboxSkeleton } from '../features/inbox/InboxSkeleton';
import { parseInboxSearch } from '../features/inbox/inbox-search';
import { t } from '../i18n/id';
import { createPreviewRoutes } from './preview-routes';

/**
 * Peta rute. Alamat halaman memakai bahasa Indonesia karena ikut tampil ke pengguna.
 * Inbox dimuat langsung (layar utama); halaman lain dimuat saat dibutuhkan.
 * `staticData.page` = judul dan layar induk halaman satu kolom, dipakai `Page` dan
 * `PageSkeleton` (lihat components/ui/page-meta.ts).
 */
const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

const getParentRoute = () => rootRoute;

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

const moreRoute = createRoute({
  getParentRoute,
  path: 'lainnya',
  staticData: { page: { title: t.nav.more } },
  component: lazyRouteComponent(() => import('../features/more/MorePage'), 'MorePage'),
});

const appRoutes = [
  indexRoute,
  inboxRoute,
  contactsRoute,
  broadcastRoute,
  ticketsRoute,
  reportsRoute,
  settingsRoute,
  moreRoute,
] as const;

const routeTree = rootRoute.addChildren(appRoutes);

/**
 * Mode pengembangan: tambah rute pratinjau. Tipe pohon rute sengaja tetap versi
 * produksi, jadi rute pratinjau tidak bisa dituju dari kode aplikasi.
 */
function routeTreeWithPreviews(): typeof routeTree {
  return rootRoute.addChildren([
    ...appRoutes,
    ...createPreviewRoutes(rootRoute),
  ]) as unknown as typeof routeTree;
}

interface AppRouterOptions {
  /** Riwayat khusus (tes memakai riwayat di memori). Bawaan: riwayat browser. */
  history?: RouterHistory;
}

export function createAppRouter({ history }: AppRouterOptions = {}) {
  return createRouter({
    routeTree: import.meta.env.DEV ? routeTreeWithPreviews() : routeTree,
    history,
    defaultPreload: 'intent',
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
