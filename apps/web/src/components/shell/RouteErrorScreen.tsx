import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { RotateCw } from 'lucide-react';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { LoadFailedIllustration } from '../illustrations/illustrations';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import styles from './RouteErrorScreen.module.css';

/**
 * Layar gagal untuk isi halaman. Navigasi tetap tampil, jadi pengguna tidak terjebak.
 * "Coba lagi" memuat ulang data rute lalu merender ulang halaman.
 */
export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  usePageTitle(t.error.title);

  const retry = () => {
    void router.invalidate().finally(reset);
  };

  // Pesan teknis berasal dari browser/server: tampil sebagai teks biasa, tidak pernah HTML.
  const detail = error instanceof Error ? error.message : '';

  return (
    <div className={styles.screen} role="alert">
      <EmptyState
        headingLevel={1}
        illustration={<LoadFailedIllustration />}
        title={t.error.title}
        body={t.error.body}
        actions={
          <>
            <Button variant="primary" onClick={retry}>
              <Icon icon={RotateCw} size={16} />
              {t.common.retry}
            </Button>
            <Button asChild>
              <Link to="/inbox">{t.common.backToInbox}</Link>
            </Button>
          </>
        }
      />
      {detail ? (
        <details className={styles.details}>
          <summary className={styles.summary}>{t.error.details}</summary>
          <pre className={styles.message}>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
