import { cx } from '../lib/cx';
import { DefaultSymbol } from './BrandMark';
import styles from './BrandMark.module.css';
import { defaultBrand, useBrand } from './brand';
import { fullLogo, symbol, wordmark } from './brand-mark-shape';

interface BrandLogoProps {
  /** Atur tinggi lewat CSS (`height`); lebar mengikuti. Bawaan 32 px. */
  className?: string;
}

/**
 * Logo lengkap untuk layar tanpa rail (login, wizard setup, email undangan di web).
 * Punya nama aksesibel sendiri (nama produk), jadi bisa berdiri tanpa teks pendamping.
 *
 * White-label: logo organisasi dipakai bila diatur. Wordmark vektor hanya untuk nama
 * produk bawaan; nama lain ditulis sebagai teks di samping simbol bawaan.
 */
export function BrandLogo({ className }: BrandLogoProps) {
  const { logoUrl, productName } = useBrand();

  if (logoUrl) {
    return <img src={logoUrl} alt={productName} className={cx(styles.logo, className)} />;
  }

  if (productName !== defaultBrand.productName) {
    return (
      <span className={cx(styles.lockup, className)}>
        <DefaultSymbol fit="tight" className={styles.lockupMark} />
        {productName}
      </span>
    );
  }

  return (
    <svg
      viewBox={fullLogo.viewBox}
      className={cx(styles.logo, className)}
      role="img"
      aria-label={productName}
    >
      <g transform={fullLogo.symbolTransform}>
        <path d={symbol.path} className={styles.symbol} />
        <circle cx={symbol.dot.cx} cy={symbol.dot.cy} r={symbol.dot.r} className={styles.dot} />
      </g>
      <g className={styles.wordmark} strokeWidth={wordmark.strokeWidth}>
        <path d={wordmark.path} />
        {wordmark.bowls.map(({ cx: x, cy: y, rx, ry }) => (
          <ellipse key={x} cx={x} cy={y} rx={rx} ry={ry} />
        ))}
      </g>
      <circle
        cx={wordmark.dot.cx}
        cy={wordmark.dot.cy}
        r={wordmark.dot.r}
        className={styles.wordmarkDot}
      />
    </svg>
  );
}
