import { Link, Navigate } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { BrandMark } from '../../brand/BrandMark';
import { useBrand } from '../../brand/brand';
import { moreMenuItems } from '../../components/shell/nav-items';
import { Icon } from '../../components/ui/Icon';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import styles from './More.module.css';

/**
 * Layar "Lainnya": pintu HP ke menu yang tidak muat di navigasi bawah.
 * Di layar lebih lebar semua menu itu sudah ada di rail, jadi layar ini dialihkan ke
 * Pengaturan. Berlaku juga saat jendela dilebarkan ketika layar ini sedang terbuka.
 */
export function MorePage() {
  const { productName } = useBrand();
  const isHp = useMediaQuery(media.hp);

  if (!isHp) return <Navigate to="/pengaturan" replace />;

  return (
    <Page>
      <nav aria-label={t.more.menuLabel}>
        <ul className={styles.menu}>
          {moreMenuItems.map((item) => (
            <li key={item.id} className={styles.menuItem}>
              <Link to={item.to} className={styles.menuLink}>
                <Icon icon={item.icon} size={20} className={styles.menuIcon} />
                <span className={styles.menuLabel}>{item.label}</span>
                <Icon icon={ChevronRight} size={16} className={styles.chevron} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.about}>
        <BrandMark />
        <span>{t.common.version(productName, __APP_VERSION__)}</span>
      </div>
    </Page>
  );
}
