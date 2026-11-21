import { ExternalLink } from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { RichText } from '../../components/ui/RichText';
import { t } from '../../i18n/id';
import styles from './Channels.module.css';

export interface GuideStep {
  readonly text: string;
  /** Halaman resmi Meta yang disebut langkah ini; tampil tepat di bawah teksnya. */
  readonly link?: { readonly label: string; readonly href: string };
}

/**
 * Langkah di Meta (docs/SETUP-META.md) dengan lingkaran nomor, pola sama dengan panduan Email
 * pengirim. Tautan hanya ke domain resmi Meta dan selalu membuka tab baru.
 */
export function GuideSteps({ steps }: { steps: readonly GuideStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className={styles.guide}>
      {steps.map((step) => (
        <li key={step.text} className={styles.guideItem}>
          <div className={styles.guideBody}>
            <span>
              <RichText text={step.text} />
            </span>
            {step.link ? (
              <a
                className={styles.guideLink}
                href={step.link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <LinkLabel label={step.link.label} />
                <span className="sr-only"> {t.channels.newTab}</span>
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Kata terakhir dan ikon tautan luar tidak dipisah baris. */
export function LinkLabel({ label }: { label: string }) {
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
