import type { ReactNode, Ref } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { LoginHero } from '../../components/illustrations/LoginHero';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { usePageTitle } from '../../lib/use-page-title';
import layout from './AuthLayout.module.css';
import styles from './Login.module.css';

interface AuthLayoutProps {
  /** Judul tab. */
  documentTitle: string;
  /** Teks kecil di atas judul (mis. "Undangan bergabung"). */
  eyebrow?: string;
  /** Kosong = data judul belum tiba (lihat `loading`). */
  title?: string;
  subtitle?: ReactNode;
  /**
   * Judul diberi fokus secara terprogram saat keadaan layar berganti (pengumuman pembaca layar),
   * tanpa cincin fokus (bukan untuk diklik).
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /**
   * Data layar belum tiba: judul dan subjudul berupa balok (`subtitleLines` baris), seluruh
   * panel diumumkan "Memuat…" saja. Isi (`children`) tetap dirender oleh pemanggil dalam bentuk
   * jadinya (label, petunjuk, tombol asli tetapi nonaktif), jadi tidak ada lompatan saat data tiba.
   */
  loading?: { subtitleLines: number };
  /**
   * Form panjang (undangan, atur ulang password): di desktop dimulai dekat atas, bukan di posisi
   * form masuk yang pendek, supaya tombol kirim tetap terlihat tanpa menggulir jauh.
   */
  tall?: boolean;
  children?: ReactNode;
}

/**
 * Kerangka halaman publik di luar aplikasi (undangan, lupa password, atur ulang password,
 * verifikasi email): sama dengan halaman masuk — form di kiri, ilustrasi di kanan pada desktop;
 * hanya form di HP. Satu fokus per layar.
 */
export function AuthLayout({
  documentTitle,
  eyebrow,
  title,
  subtitle,
  titleRef,
  loading,
  tall = false,
  children,
}: AuthLayoutProps) {
  usePageTitle(documentTitle);
  const inner = (
    <div className={styles.inner}>
      <BrandLogo className={styles.logo} />
      <div className={styles.head}>
        {eyebrow ? <p className={layout.eyebrow}>{eyebrow}</p> : null}
        {loading || title === undefined ? (
          <>
            <Skeleton className={layout.skeletonTitle} />
            <span className={layout.skeletonSubtitle}>
              {Array.from({ length: loading?.subtitleLines ?? 1 }, (_, index) => (
                <Skeleton
                  key={index}
                  className={cx(
                    layout.skeletonLine,
                    index === (loading?.subtitleLines ?? 1) - 1 && layout.skeletonLineLast,
                  )}
                />
              ))}
            </span>
          </>
        ) : (
          <>
            <h1 ref={titleRef} tabIndex={-1} className={cx(styles.title, layout.title)}>
              {title}
            </h1>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </>
        )}
      </div>
      {children}
    </div>
  );

  const paneClass = cx(styles.pane, tall && layout.paneTall);
  return (
    <div className={styles.screen}>
      {loading ? (
        <SkeletonRegion className={paneClass}>{inner}</SkeletonRegion>
      ) : (
        <main className={paneClass}>{inner}</main>
      )}
      <aside className={styles.hero} aria-hidden="true">
        <LoginHero sizes="60vw" className={styles.heroImage} />
        <div className={styles.heroText}>
          <p className={styles.heroTitle}>{t.auth.login.heroTitle}</p>
          <p className={styles.heroBody}>{t.auth.login.heroBody}</p>
        </div>
      </aside>
    </div>
  );
}

/**
 * Kerangka saat kode halaman publik masih dimuat (komponen tunggu rute): judul, dua isian, dan
 * tombol di posisi yang sama dengan form halaman masuk.
 */
export function AuthRouteSkeleton({
  documentTitle,
  tall = false,
}: {
  documentTitle: string;
  tall?: boolean;
}) {
  return (
    <AuthLayout documentTitle={documentTitle} loading={{ subtitleLines: 1 }} tall={tall}>
      <div className={styles.form}>
        {[0, 1].map((index) => (
          <div key={index} className={layout.skeletonField}>
            <Skeleton className={layout.skeletonLabel} />
            <Skeleton className={layout.skeletonInput} />
          </div>
        ))}
        <Skeleton className={layout.skeletonButton} />
      </div>
    </AuthLayout>
  );
}
