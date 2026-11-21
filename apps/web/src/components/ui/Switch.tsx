import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Switch.module.css';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Teks di samping sakelar (bagian dari nama tombol); seluruh baris bisa diketuk (≥ 44px). */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Nama lengkap bila teks terlihat perlu konteks (mis. "Tersedia: Agus"); harus memuat teksnya. */
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/**
 * Sakelar nyala/mati (`role="switch"` + `aria-checked`) untuk pengaturan yang langsung berlaku,
 * mis. "Ikut pembagian otomatis". Untuk pilihan di dalam form yang disimpan belakangan, pakai
 * `Checkbox`.
 */
export function Switch({
  checked,
  onChange,
  children,
  disabled,
  className,
  'aria-label': label,
  'aria-describedby': describedBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cx(styles.row, className)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      <span className={styles.label}>{children}</span>
    </button>
  );
}
