import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from './Icon';
import styles from './Notice.module.css';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const icons: Record<NoticeTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** Aksi kecil di bawah teks. */
  actions?: ReactNode;
  /**
   * `alert`: diumumkan segera (error setelah aksi). `status`: diumumkan sopan (hasil tes).
   * Kosong: tidak diumumkan (petunjuk yang tampil sejak awal).
   */
  role?: 'alert' | 'status';
  id?: string;
  className?: string;
}

/** Kotak pesan di dalam alur: hasil tes, error form, peringatan. Warna dari token status. */
export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  role,
  id,
  className,
}: NoticeProps) {
  return (
    <div id={id} role={role} className={cx(styles.notice, styles[tone], className)}>
      <Icon icon={icons[tone]} size={20} className={styles.icon} />
      <div className={styles.text}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <div className={styles.body}>{children}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
