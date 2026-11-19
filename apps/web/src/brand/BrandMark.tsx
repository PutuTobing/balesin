import { cx } from '../lib/cx';
import { symbol } from './brand-mark-shape';
import styles from './BrandMark.module.css';
import { useBrand } from './brand';

interface SymbolProps {
  className?: string;
  /**
   * `square` (bawaan): simbol di tengah kotak persegi, untuk rail.
   * `tight`: tanpa ruang sisa, untuk baris yang harus rata kiri dengan elemen lain.
   */
  fit?: 'square' | 'tight';
}

type BrandMarkProps = SymbolProps;

/** Simbol logo bawaan (tanpa wordmark), warna dari token sehingga ikut tema. */
export function DefaultSymbol({ className, fit = 'square' }: SymbolProps) {
  const { path, dot } = symbol;
  const viewBox = fit === 'tight' ? symbol.tightViewBox : symbol.squareViewBox;
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      <path d={path} className={styles.symbol} />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} className={styles.dot} />
    </svg>
  );
}

/**
 * Tanda merek. Dekoratif: nama aksesibelnya diberikan oleh elemen pembungkus.
 * Memakai logo organisasi bila tersedia, kalau tidak simbol logo bawaan.
 */
export function BrandMark({ className, fit = 'square' }: BrandMarkProps) {
  const { logoUrl, icons } = useBrand();
  // Tempat persegi (rail, dll.): ikon persegi yang dibuat server dari logo (latar transparan)
  // lebih terbaca daripada logo melebar yang diperkecil.
  const square =
    icons?.manifest.find((icon) => icon.purpose === 'any' && icon.sizes === '192x192')?.src ??
    logoUrl;

  if (square) {
    return <img src={square} alt="" className={cx(styles.mark, className)} />;
  }

  return (
    <DefaultSymbol
      fit={fit}
      className={cx(styles.mark, fit === 'tight' && styles.tight, className)}
    />
  );
}
