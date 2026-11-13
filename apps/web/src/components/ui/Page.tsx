import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { Icon } from './Icon';
import styles from './Page.module.css';
import { Skeleton } from './Skeleton';
import { usePageMeta, type PageParent } from './page-meta';

const parents: Record<PageParent, { to: NonNullable<LinkProps['to']>; label: string }> = {
  more: { to: '/lainnya', label: t.nav.more },
};

interface PageHeaderProps {
  /** Kosong = judul belum diketahui; tampil sebagai balok kerangka. */
  title?: string;
  /**
   * Layar induk di HP. Tombol kembali hanya tampil di HP; di desktop semua menu sudah
   * terlihat di rail.
   */
  parent?: PageParent;
  /** Aksi halaman di kanan header. */
  actions?: ReactNode;
}

/** Header halaman satu kolom. Dipakai layar jadi dan kerangka memuatnya. */
export function PageHeader({ title, parent, actions }: PageHeaderProps) {
  const back = parent ? parents[parent] : undefined;
  return (
    <header className={styles.header}>
      {back ? (
        <Link to={back.to} className={styles.back} aria-label={t.common.backTo(back.label)}>
          <Icon icon={ArrowLeft} size={20} />
        </Link>
      ) : null}
      {title ? (
        <h1 className={styles.title}>{title}</h1>
      ) : (
        <Skeleton className={styles.titleSkeleton} />
      )}
      {actions}
    </header>
  );
}

interface PageProps {
  /** Aksi halaman di kanan header. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Kerangka halaman satu kolom: header berjudul + isi yang bisa digulir. Judul dan layar
 * induk diambil dari `staticData.page` rutenya (app/router.ts).
 */
export function Page({ actions, children }: PageProps) {
  const meta = usePageMeta();
  usePageTitle(meta?.title ?? '');
  if (!meta) throw new Error('<Page> membutuhkan `staticData.page` pada rutenya.');

  return (
    <div className={styles.page}>
      <PageHeader title={meta.title} parent={meta.parent} actions={actions} />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
