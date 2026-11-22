import type { MailAccountColor } from '@balesin/shared';
import { initialsOf } from '../../components/shell/initials';
import { cx } from '../../lib/cx';
import styles from './MailShared.module.css';

interface AccountMarkProps {
  account: { displayName: string; color: MailAccountColor; avatarUrl: string | null };
  /**
   * `dot`: titik warna 8px (kolom folder, daftar). `avatar`: foto/logo bila ada, selain itu inisial
   * dengan cincin warna akun (halaman akun, wizard).
   */
  variant?: 'dot' | 'avatar';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Penanda akun email: warna token tag (tanpa warna baru) atau foto/logo yang diunggah (PRD §4.12).
 * Selalu dekoratif — nama akun ditulis di sebelahnya.
 */
export function AccountMark({
  account,
  variant = 'dot',
  size = 'md',
  className,
}: AccountMarkProps) {
  if (variant === 'dot' && !account.avatarUrl) {
    return (
      <span className={cx(styles.dot, className)} data-color={account.color} aria-hidden="true" />
    );
  }
  if (account.avatarUrl) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        className={cx(styles.avatar, styles[size], className)}
        data-color={account.color}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <span
      className={cx(styles.avatar, styles.initials, styles[size], className)}
      data-color={account.color}
      aria-hidden="true"
    >
      {initialsOf(account.displayName)}
    </span>
  );
}
