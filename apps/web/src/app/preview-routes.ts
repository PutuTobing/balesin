import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { PageSkeleton } from '../components/shell/PageSkeleton';
import { CrashPreview } from '../features/preview/CrashPreview';
import { InboxLoadingPreview } from '../features/preview/InboxLoadingPreview';
import { t } from '../i18n/id';

/**
 * Rute pratinjau keadaan yang tidak bisa dipicu dari UI selama belum ada data
 * (memuat, gagal). Dipakai skrip screenshot dan `kritikus-desain`.
 * HANYA dipasang di mode pengembangan (lihat router.ts); tidak ikut build produksi.
 *
 * Pratinjau memuat diletakkan di bawah alamat halamannya (/inbox/..., /kontak/...) supaya
 * navigasi dan judul sama dengan layar jadi, jadi keduanya bisa dibandingkan langsung.
 */
export function createPreviewRoutes(parent: AnyRoute): AnyRoute[] {
  const getParentRoute = () => parent;
  return [
    createRoute({ getParentRoute, path: 'pratinjau/gagal', component: CrashPreview }),
    createRoute({
      getParentRoute,
      path: 'inbox/pratinjau-memuat',
      component: InboxLoadingPreview,
    }),
    createRoute({
      getParentRoute,
      path: 'kontak/pratinjau-memuat',
      staticData: { page: { title: t.nav.contacts } },
      component: PageSkeleton,
    }),
  ];
}
