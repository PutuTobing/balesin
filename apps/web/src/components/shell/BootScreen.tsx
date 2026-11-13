import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { RotateCw } from 'lucide-react';
import { BrandMark } from '../../brand/BrandMark';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { LoadFailedIllustration } from '../illustrations/illustrations';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import styles from './BootScreen.module.css';

/**
 * Tampil saat sesi sedang diperiksa dan jawabannya lambat (> 400 ms). Netral: belum diketahui
 * apakah berikutnya layar aplikasi atau halaman masuk, jadi tidak meniru keduanya.
 */
export function BootScreen() {
  return (
    <div className={styles.screen} role="status" aria-busy="true">
      <BrandMark className={styles.mark} />
      <span className={styles.text}>{t.boot.loading}</span>
    </div>
  );
}

/** Pemeriksaan sesi gagal (server mati, jaringan putus). */
export function BootErrorScreen({ reset }: ErrorComponentProps) {
  const router = useRouter();
  usePageTitle(t.boot.failedTitle);
  const retry = () => {
    void router.invalidate().finally(reset);
  };
  return (
    <main className={styles.error}>
      <EmptyState
        headingLevel={1}
        illustration={<LoadFailedIllustration />}
        title={t.boot.failedTitle}
        body={t.boot.failedBody}
        actions={
          <Button variant="primary" onClick={retry}>
            <Icon icon={RotateCw} size={16} />
            {t.common.retry}
          </Button>
        }
      />
    </main>
  );
}
