import type { SmtpPresetId } from '@balesin/shared';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useBrand } from '../../brand/brand';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './EmailGuide.module.css';

interface EmailGuideProps {
  /** `setup`: di dalam langkah Email wizard (tertutup, berlabel ajakan). `settings`: kolom samping. */
  context: 'setup' | 'settings';
  /** Preset terpilih: menentukan blok langkah khusus penyedia. */
  preset: SmtpPresetId;
  /** Terbuka saat pertama tampil (desktop Pengaturan). */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Panduan langkah demi langkah (docs/PENGATURAN-UI.md §1): langkah umum + langkah khusus
 * penyedia terpilih, dengan tautan ke halaman resmi Google/Microsoft. Gambar menyusul
 * (lihat DECISIONS). Tidak butuh data server, jadi juga tampil apa adanya di kerangka memuat.
 */
export function EmailGuide({ context, preset, defaultOpen = false, className }: EmailGuideProps) {
  const { productName } = useBrand();
  const specific = preset === 'other' ? null : t.emailSettings.guidePreset[preset];
  return (
    <details
      className={cx(styles.guide, styles[context], className)}
      open={defaultOpen}
      // `key`: nilai bawaan `open` berlaku lagi saat ukuran layar berganti.
      key={defaultOpen ? 'terbuka' : 'tertutup'}
    >
      <summary className={styles.summary}>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
        {context === 'setup' ? t.emailSettings.guideSetupTitle : t.emailSettings.guideTitle}
      </summary>
      <div className={styles.body}>
        <ol className={styles.list}>
          {t.emailSettings.guide(context).map((step) => (
            <li key={step} className={styles.item}>
              {step}
            </li>
          ))}
        </ol>
        {specific ? (
          <section className={styles.preset} aria-label={specific.title}>
            <h3 className={styles.presetTitle}>{specific.title}</h3>
            {/* Gaya nomor sama dengan langkah umum (lingkaran), bukan "1." biasa (kritikus N4). */}
            <ol className={styles.list}>
              {specific.steps.map((step) => {
                const link = 'link' in step ? step.link : null;
                // Sebagian langkah menyebut nama produk (white-label): diisi dari branding.
                const text = typeof step.text === 'function' ? step.text(productName) : step.text;
                return (
                  <li key={text} className={styles.item}>
                    <div className={styles.itemBody}>
                      {text}
                      {/* Tautan tepat di bawah langkah yang menyuruh membuka halamannya. */}
                      {link ? (
                        <a
                          className={styles.link}
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <LinkLabel label={link.label} />
                          <span className="sr-only"> {t.emailSettings.newTab}</span>
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
      </div>
    </details>
  );
}

/** Kata terakhir dan ikon tautan luar tidak dipisah baris (ikon tidak "terdampar" sendiri). */
function LinkLabel({ label }: { label: string }) {
  const cut = label.lastIndexOf(' ');
  return (
    <>
      {label.slice(0, cut + 1)}
      <span className={styles.nowrap}>
        {label.slice(cut + 1)}
        <Icon icon={ExternalLink} size={16} className={styles.linkIcon} />
      </span>
    </>
  );
}
