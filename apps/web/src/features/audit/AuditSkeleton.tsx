import { Download } from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { PageHeader } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import pageStyles from '../../components/ui/Page.module.css';
import buttonStyles from '../../components/ui/Button.module.css';
import { AuditListSkeleton } from './AuditListSkeleton';
import styles from './Audit.module.css';

const copy = t.audit;

/**
 * Kerangka Audit log (saat kode halaman dimuat): header dengan tombol ekspor tiruan, saringan
 * dengan label asli (kotaknya balok), lalu daftar kerangka yang sama dengan yang dipakai halaman
 * saat menunggu data — jadi tidak ada lompatan dari kerangka rute ke kerangka daftar.
 */
export function AuditSkeleton() {
  usePageTitle(copy.title);
  const labels = [
    copy.filters.actor,
    copy.filters.action,
    copy.filters.target,
    copy.filters.from,
    copy.filters.to,
  ];
  return (
    <div className={pageStyles.page}>
      <PageHeader
        title={copy.title}
        parent="settings"
        actions={
          <span
            className={`${buttonStyles.button} ${buttonStyles.secondary} ${styles.exportButton}`}
            aria-hidden="true"
          >
            <Icon icon={Download} size={16} />
            {copy.export}
          </span>
        }
      />
      <div className={pageStyles.body}>
        <SkeletonRegion className={styles.content}>
          <div className={styles.filters}>
            <span className={styles.filterToggle}>{copy.filters.toggle}</span>
            <div className={styles.filterBody}>
              <div className={styles.filterGrid}>
                {labels.map((label) => (
                  <div key={label} className={styles.skeletonField}>
                    <span className={styles.skeletonLabel}>{label}</span>
                    <Skeleton className={styles.skeletonControl} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <AuditListSkeleton />
        </SkeletonRegion>
      </div>
    </div>
  );
}
