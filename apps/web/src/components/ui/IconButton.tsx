import type { LucideIcon } from 'lucide-react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from './Icon';
import styles from './IconButton.module.css';
import { Tooltip } from './Tooltip';

interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** Wajib: nama aksesibel sekaligus isi tooltip. */
  label: string;
  icon: LucideIcon;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/** Tombol berisi ikon saja. Selalu berlabel dan punya tooltip. */
export function IconButton({
  label,
  icon,
  tooltipSide = 'bottom',
  className,
  type,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        type={type ?? 'button'}
        aria-label={label}
        className={cx(styles.iconButton, className)}
        {...rest}
      >
        <Icon icon={icon} size={20} />
      </button>
    </Tooltip>
  );
}
