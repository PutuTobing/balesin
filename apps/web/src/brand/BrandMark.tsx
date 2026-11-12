import { cx } from '../lib/cx';
import { BRAND_MARK_SIZE, brandMarkShape } from './brand-mark-shape';
import styles from './BrandMark.module.css';
import { useBrand } from './brand';

interface BrandMarkProps {
  className?: string;
}

/**
 * Tanda merek. Dekoratif: nama aksesibelnya diberikan oleh elemen pembungkus.
 * Memakai logo organisasi bila tersedia, kalau tidak tanda merek bawaan.
 */
export function BrandMark({ className }: BrandMarkProps) {
  const { logoUrl } = useBrand();

  if (logoUrl) {
    return <img src={logoUrl} alt="" className={cx(styles.mark, className)} />;
  }

  const { tile, bubble, dot } = brandMarkShape;
  return (
    <svg
      viewBox={`0 0 ${BRAND_MARK_SIZE} ${BRAND_MARK_SIZE}`}
      className={cx(styles.mark, className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width={tile.size} height={tile.size} rx={tile.radius} className={styles.tile} />
      <path d={bubble} className={styles.bubble} />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} strokeWidth={dot.ring} className={styles.dot} />
    </svg>
  );
}
