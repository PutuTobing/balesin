import { Page } from '../../components/ui/Page';
import { SkeletonRegion } from '../../components/ui/Skeleton';
import { SecurityCardsSkeleton } from './SecurityCards';

/**
 * Kerangka Keamanan akun: header asli dan kartu yang sama dengan layar jadi (sesuai peran dari
 * sesi), jadi tidak ada lompatan saat status 2FA tiba.
 */
export function SecuritySkeleton() {
  return (
    <Page>
      <SkeletonRegion>
        <SecurityCardsSkeleton />
      </SkeletonRegion>
    </Page>
  );
}
