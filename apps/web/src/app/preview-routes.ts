import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { PageSkeleton } from '../components/shell/PageSkeleton';
import { InboxSkeleton } from '../features/inbox/InboxSkeleton';
import { CrashPreview } from '../features/preview/CrashPreview';

/**
 * Rute pratinjau keadaan yang tidak bisa dipicu dari UI selama belum ada data
 * (memuat, gagal). Dipakai skrip screenshot dan `kritikus-desain`.
 * HANYA dipasang di mode pengembangan (lihat router.ts); tidak ikut build produksi.
 */
export function createPreviewRoutes(parent: AnyRoute): AnyRoute[] {
  const getParentRoute = () => parent;
  return [
    createRoute({ getParentRoute, path: 'pratinjau/gagal', component: CrashPreview }),
    createRoute({ getParentRoute, path: 'pratinjau/memuat-inbox', component: InboxSkeleton }),
    createRoute({ getParentRoute, path: 'pratinjau/memuat-halaman', component: PageSkeleton }),
  ];
}
