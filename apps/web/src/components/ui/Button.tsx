import { LoaderCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import styles from './Button.module.css';
import { Icon } from './Icon';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** `primary` hanya untuk satu aksi utama per layar. */
  variant?: ButtonVariant;
  /** `lg`: 44px di semua ukuran layar (form utama seperti masuk dan setup). */
  size?: 'md' | 'lg';
  /** Pakai elemen anak (mis. `<Link>`) sebagai tombol. */
  asChild?: boolean;
  /**
   * Sedang memproses: tombol nonaktif, ikon putar tampil, `aria-busy`. Teks tombol sebaiknya
   * ikut berubah (mis. "Menyimpan…") supaya pembaca layar tahu.
   */
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  asChild = false,
  loading = false,
  className,
  type,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = cx(styles.button, styles[variant], size === 'lg' && styles.lg, className);
  if (asChild) {
    return (
      <Slot.Root className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      data-loading={loading ? '' : undefined}
      {...rest}
    >
      {loading ? <Icon icon={LoaderCircle} size={16} className={styles.spinner} /> : null}
      {children}
    </button>
  );
}
