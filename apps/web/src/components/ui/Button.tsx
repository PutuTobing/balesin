import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** `primary` hanya untuk satu aksi utama per layar. */
  variant?: ButtonVariant;
  /** Pakai elemen anak (mis. `<Link>`) sebagai tombol. */
  asChild?: boolean;
}

export function Button({
  variant = 'secondary',
  asChild = false,
  className,
  type,
  ...rest
}: ButtonProps) {
  const classes = cx(styles.button, styles[variant], className);
  if (asChild) return <Slot.Root className={classes} {...rest} />;
  return <button type={type ?? 'button'} className={classes} {...rest} />;
}
