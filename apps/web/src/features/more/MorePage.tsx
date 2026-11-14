import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ChevronRight, LogOut, ShieldCheck } from 'lucide-react';
import { BrandMark } from '../../brand/BrandMark';
import { useBrand } from '../../brand/brand';
import { allowedNavItems, moreMenuItems } from '../../components/shell/nav-items';
import { UserIdentity } from '../../components/shell/UserMenu';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { useLogout, useSession } from '../auth/session';
import { t } from '../../i18n/id';
import { twoFactorStatusQuery } from '../../lib/api/queries';
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
  const session = useSession();
  const logout = useLogout();
  const queryClient = useQueryClient();

  // Status 2FA dimuat lebih dulu: Keamanan akun langsung tampil tanpa kerangka.
  useEffect(() => {
    void queryClient.prefetchQuery(twoFactorStatusQuery);
  }, [queryClient]);

  if (!isHp) return <Navigate to="/pengaturan" replace />;

  return (
    <Page>
      {session ? (
        <section className={styles.account} aria-label={t.auth.userMenu.account}>
          <UserIdentity user={session.user} />
          <Link to="/pengaturan/keamanan" className={styles.accountLink}>
            <Icon icon={ShieldCheck} size={20} className={styles.menuIcon} />
            <span className={styles.menuLabel}>{t.auth.userMenu.security}</span>
            <Icon icon={ChevronRight} size={16} className={styles.chevron} />
          </Link>
        </section>
      ) : null}
      <nav aria-label={t.more.menuLabel} className={styles.nav}>
        <ul className={styles.menu}>
          {allowedNavItems(moreMenuItems, session?.permissions ?? []).map((item) => (
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
      <div className={styles.logoutCard}>
        <button
          type="button"
          className={styles.logout}
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          aria-busy={logout.isPending || undefined}
        >
          <Icon icon={LogOut} size={20} />
          <span className={styles.menuLabel}>
            {logout.isPending ? t.auth.userMenu.loggingOut : t.auth.userMenu.logout}
          </span>
        </button>
      </div>
      {logout.isError ? (
        <Notice tone="danger" role="alert" className={styles.logoutError}>
          {t.auth.userMenu.logoutFailed}
        </Notice>
      ) : null}
      <div className={styles.about}>
        <BrandMark fit="tight" />
        <span>{t.common.version(productName, __APP_VERSION__)}</span>
      </div>
    </Page>
  );
}
