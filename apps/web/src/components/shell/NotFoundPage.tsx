import { Link, useRouterState } from '@tanstack/react-router';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { NotFoundIllustration } from '../illustrations/illustrations';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import styles from './NotFoundPage.module.css';

/** Halaman 404. Tampil di dalam kerangka aplikasi, jadi navigasi tetap bisa dipakai. */
export function NotFoundPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  usePageTitle(t.notFound.title);

  return (
    <div className={styles.screen}>
      <EmptyState
        headingLevel={1}
        illustration={<NotFoundIllustration />}
        title={t.notFound.title}
        body={
          <>
            <p>{t.notFound.body}</p>
            <p className={styles.path}>
              <span className="sr-only">{t.notFound.pathLabel}: </span>
              <code>{pathname}</code>
            </p>
          </>
        }
        actions={
          <Button asChild variant="primary">
            <Link to="/inbox">{t.common.backToInbox}</Link>
          </Button>
        }
      />
    </div>
  );
}
