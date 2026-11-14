import { useMemo } from 'react';
import { cx } from '../../lib/cx';
import { qrPath } from './qr-path';
import styles from './TwoFactor.module.css';

/**
 * Kode QR dibuat di browser dari teks (mis. URI `otpauth://`); rahasianya tidak pernah dikirim
 * ke layanan luar. Digambar sebagai SVG biasa lewat React (tanpa `innerHTML`, tanpa atribut
 * `style`, aman untuk CSP `style-src 'self'`). Selalu gelap di atas terang (`data-theme="light"`)
 * karena tidak semua aplikasi pemindai bisa membaca kode terbalik di mode gelap.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => qrPath(value), [value]);
  return (
    <div data-theme="light" className={cx(styles.qrTile, className)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        className={styles.qrSvg}
      >
        <path d={path} className={styles.qrModules} />
      </svg>
    </div>
  );
}
