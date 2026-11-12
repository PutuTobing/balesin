import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  /**
   * Ilustrasi dekoratif. Sementara memakai gambar netral dari
   * `components/illustrations`; diganti ilustrasi maskot setelah aset tersedia.
   */
  illustration?: ReactNode;
  /** Tombol atau link yang benar-benar berfungsi. */
  actions?: ReactNode;
  /** Versi ringkas untuk panel sempit di samping fokus utama. */
  compact?: boolean;
  /** `top`: menempel di atas seperti isi daftar, bukan di tengah area. */
  align?: 'center' | 'top';
  /** 1 hanya bila layar tidak punya judul halaman sendiri (404, gagal dimuat). */
  headingLevel?: 1 | 2 | 3;
  className?: string;
}

/** Keadaan kosong, tidak ditemukan, dan gagal: satu pola untuk semua layar. */
export function EmptyState({
  title,
  body,
  illustration,
  actions,
  compact = false,
  align = 'center',
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cx(
        styles.empty,
        compact && styles.compact,
        align === 'top' && styles.top,
        className,
      )}
    >
      {illustration ? <div className={styles.illustration}>{illustration}</div> : null}
      <div className={styles.text}>
        <Heading className={styles.title}>{title}</Heading>
        {body ? <div className={styles.body}>{body}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
