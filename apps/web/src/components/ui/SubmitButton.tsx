import type { ReactNode, Ref } from 'react';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { formatClock } from '../../lib/format';
import type { Lock } from '../../lib/use-lock';
import { Button } from './Button';
import styles from './SubmitButton.module.css';

interface SubmitButtonProps {
  children: ReactNode;
  /** Teks saat memproses (mis. "Memeriksa…"). */
  pendingLabel: string;
  pending: boolean;
  /** Kunci 429: selama terkunci tombol nonaktif dan labelnya sisa waktu `m:ss`. */
  lock?: Lock;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'md' | 'lg';
  className?: string;
  /** Bawaan `submit`. `button` + `onClick` untuk aksi di luar form (mis. "Coba lagi"). */
  type?: 'submit' | 'button';
  onClick?: () => void;
  /** Nonaktif karena belum bisa dipakai (mis. data belum siap), di luar kunci 429. */
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Tombol kirim form dengan tiga keadaan: biasa, memproses, dan terkunci sementara. Sisa waktu
 * ada di label tombol (bukan di wilayah `aria-live`), jadi tidak diumumkan tiap detik.
 */
export function SubmitButton({
  children,
  pendingLabel,
  pending,
  lock,
  variant = 'primary',
  size = 'lg',
  className,
  type = 'submit',
  onClick,
  disabled = false,
  ref,
}: SubmitButtonProps) {
  const locked = lock?.locked ?? false;
  return (
    <Button
      type={type}
      onClick={onClick}
      variant={variant}
      size={size}
      className={cx(styles.submit, className)}
      loading={pending}
      ref={ref}
      disabled={locked || disabled}
      data-locked={locked ? '' : undefined}
    >
      {pending ? (
        pendingLabel
      ) : locked ? (
        <span className={styles.countdown}>
          {t.auth.login.countdownButton(formatClock(lock?.secondsLeft ?? 0))}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
