import { Timer, TimerOff, User } from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { formatClockTime, formatRemaining, windowState } from './inbox-time';
import { avatarInitials } from './contact-identity';
import styles from './InboxBits.module.css';

/** Avatar kontak: inisial dari nama, atau ikon orang bila nama tidak berhuruf (nomor). */
export function ContactAvatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const initials = avatarInitials(name);
  return (
    <span className={cx(styles.avatar, styles[size], className)} aria-hidden="true">
      {initials ?? <Icon icon={User} size={size === 'lg' ? 20 : 16} />}
    </span>
  );
}

/**
 * Hitung mundur jendela layanan 24 jam (sesi WhatsApp). Terbuka: abu-abu; ≤ 2 jam: kuning
 * (`--warning` + teks `--warning-ink`); habis: merah (`--danger` + `--danger-ink`). Tidak
 * berkedip/beranimasi; tampilan berganti per menit lewat `useMinuteClock` pemanggil.
 * Pembaca layar mendapat kalimat lengkap, bukan singkatan.
 */
export function WindowCountdown({
  expiresAt,
  now,
  showEnd = false,
  className,
}: {
  expiresAt: string | null;
  now: number;
  /** Tambahkan jam berakhirnya ("Berakhir 14.05") di tooltip. */
  showEnd?: boolean;
  className?: string;
}) {
  const state = windowState(expiresAt, now);
  if (state.kind === 'none') return null;
  const w = t.inbox.window;
  const expired = state.kind === 'expired';
  const remaining = expired ? null : formatRemaining(state.remainingMs);
  const long = remaining ? w.remainingLong(remaining.long) : w.expiredLong;
  const title =
    showEnd && expiresAt && remaining ? `${long}. ${w.endsAt(formatClockTime(expiresAt))}` : long;
  return (
    <span className={cx(styles.countdown, className)} data-tone={state.kind} title={title}>
      <Icon icon={expired ? TimerOff : Timer} size={16} className={styles.countdownIcon} />
      <span aria-hidden="true">{remaining ? remaining.short : w.expiredShort}</span>
      <span className="sr-only">{long}</span>
    </span>
  );
}
