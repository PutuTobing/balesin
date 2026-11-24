import { Link, type LinkProps } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { Button } from './Button';
import styles from './CreateButton.module.css';
import { Icon } from './Icon';

interface CreateButtonProps {
  /** Label lengkap, selalu "Buat …" (mis. "Buat kampanye"). Juga nama aksesibel di HP. */
  label: string;
  /**
   * Label pendek di HP (bawaan "Buat"). Untuk aksi yang bukan membuat objek baru, mis.
   * "Hubungkan" (akun email, mengikuti "Hubungkan nomor" untuk channel).
   */
  shortLabel?: string;
  /** Tautan ke halaman pembuat; tanpa ini tombol memanggil `onClick` (mis. membuka dialog). */
  to?: LinkProps['to'];
  onClick?: () => void;
  className?: string;
}

/**
 * Aksi "buat" utama halaman berisi satu daftar (audit akhir D1). Ditaruh di `Page actions`
 * (kanan kepala halaman) dan hanya bila daftarnya tidak kosong — saat kosong, ajakannya ada di
 * `EmptyState`. Di HP labelnya dipendekkan jadi "Buat" + ikon supaya judul tidak terpotong; nama
 * aksesibelnya tetap label lengkap (memuat teks yang terlihat).
 */
export function CreateButton({
  label,
  shortLabel = t.common.createShort,
  to,
  onClick,
  className,
}: CreateButtonProps) {
  const content = (
    <>
      <Icon icon={Plus} size={16} />
      <span className={styles.full}>{label}</span>
      <span className={styles.short} aria-hidden="true">
        {shortLabel}
      </span>
    </>
  );
  if (to) {
    return (
      <Button variant="primary" asChild className={cx(styles.button, className)}>
        <Link to={to} aria-label={label}>
          {content}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      className={cx(styles.button, className)}
      aria-label={label}
      onClick={onClick}
    >
      {content}
    </Button>
  );
}
