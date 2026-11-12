import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { Icon } from './Icon';
import styles from './Page.module.css';

interface PageProps {
  title: string;
  /**
   * Layar induk di HP (layar bertumpuk). Tombol kembali hanya tampil di HP; di desktop
   * semua menu sudah terlihat di rail.
   */
  parent?: { to: NonNullable<LinkProps['to']>; label: string };
  /** Aksi halaman di kanan header. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Kerangka halaman satu kolom: header berjudul + isi yang bisa digulir. */
export function Page({ title, parent, actions, children }: PageProps) {
  usePageTitle(title);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        {parent ? (
          <Link to={parent.to} className={styles.back} aria-label={t.common.backTo(parent.label)}>
            <Icon icon={ArrowLeft} size={20} />
          </Link>
        ) : null}
        <h1 className={styles.title}>{title}</h1>
        {actions}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
