import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './FormActions.module.css';

interface FormActionsProps {
  /**
   * Tombol form. Urutan sama dengan dialog (DESIGN.md §4): tombol berwarna (simpan) selalu
   * **terakhir** — kanan di desktop, paling atas dan selebar penuh di HP.
   */
  children: ReactNode;
  /** Keterangan opsional di kiri (desktop) / di bawah tombol (HP), mis. "Terakhir diubah …". */
  meta?: ReactNode;
  className?: string;
}

/**
 * Baris tombol simpan form halaman (audit akhir D3): kanan di desktop, selebar penuh di atas pada
 * HP. Satu pola untuk semua form Pengaturan supaya tombol simpan tidak berpindah-pindah tempat.
 */
export function FormActions({ children, meta, className }: FormActionsProps) {
  return (
    <div className={cx(styles.actions, className)}>
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {children}
    </div>
  );
}
