import type { ReactNode } from 'react';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  /** Ukuran dan bentuk diberikan lewat kelas pemakai. */
  className?: string;
}

/** Satu balok placeholder. Selalu dibungkus `SkeletonRegion`. */
export function Skeleton({ className }: SkeletonProps) {
  return <span className={cx(styles.block, className)} />;
}

interface SkeletonRegionProps {
  className?: string;
  children: ReactNode;
}

/**
 * Area yang sedang memuat. Bentuknya meniru isi yang akan datang supaya tidak ada
 * lompatan layout; pembaca layar hanya mendengar "Memuat…".
 */
export function SkeletonRegion({ className, children }: SkeletonRegionProps) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t.common.loading}</span>
      <div aria-hidden="true" className={styles.content}>
        {children}
      </div>
    </div>
  );
}
