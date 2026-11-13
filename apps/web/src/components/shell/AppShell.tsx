import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type MouseEvent } from 'react';
import { BrandMark } from '../../brand/BrandMark';
import { useBrand } from '../../brand/brand';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { media, useMediaQuery } from '../../lib/media';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import styles from './AppShell.module.css';
import { ThemeMenu } from './ThemeMenu';
import { navActiveState, navItems, type NavItem } from './nav-items';
import { RAIL_POPOVER_OFFSET } from './rail';

const MAIN_ID = 'konten';

/**
 * Kerangka aplikasi (DESIGN.md §2). Satu elemen <nav> dipakai untuk dua bentuk:
 * rail ikon 64px di kiri (lebar > 640px) dan navigasi bawah berlabel (HP).
 * Bentuknya diatur CSS, jadi tidak ada lompatan saat layar berubah ukuran.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  // Pindah halaman → fokus ke konten, supaya pembaca layar dan keyboard mulai dari isi baru.
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  const skipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className={styles.shell}>
      <a href={`#${MAIN_ID}`} className={styles.skip} onClick={skipToContent}>
        {t.common.skipToContent}
      </a>
      <MainNav pathname={pathname} />
      <main id={MAIN_ID} ref={mainRef} tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

function MainNav({ pathname }: { pathname: string }) {
  const { productName } = useBrand();
  // Di navigasi bawah HP label sudah tampil, jadi tooltip hanya untuk rail ikon.
  const labelsVisible = useMediaQuery(media.hp);
  return (
    <nav className={styles.nav} aria-label={t.nav.label}>
      <Link to="/inbox" className={styles.brand} aria-label={t.nav.home(productName)}>
        <BrandMark />
      </Link>
      <ul className={styles.items}>
        {navItems.map((item) => (
          <li key={item.id} className={cx(styles.item, styles[item.placement])}>
            <NavLink item={item} pathname={pathname} showTooltip={!labelsVisible} />
          </li>
        ))}
        <li className={cx(styles.item, styles.footer)}>
          <ThemeMenu className={styles.link} />
        </li>
      </ul>
    </nav>
  );
}

interface NavLinkProps {
  item: NavItem;
  pathname: string;
  showTooltip: boolean;
}

function NavLink({ item, pathname, showTooltip }: NavLinkProps) {
  const active = navActiveState(item, pathname);
  return (
    <Tooltip
      label={item.label}
      side="right"
      sideOffset={RAIL_POPOVER_OFFSET}
      disabled={!showTooltip}
    >
      <Link
        to={item.to}
        className={styles.link}
        data-active={active ? '' : undefined}
        aria-current={active === 'page' ? 'page' : active === 'section' ? 'true' : undefined}
        // Status aktif dihitung sendiri (lihat navActiveState), bukan oleh router.
        activeProps={{}}
        inactiveProps={{}}
      >
        <Icon icon={item.icon} size={20} />
        <span className={styles.label}>{item.label}</span>
      </Link>
    </Tooltip>
  );
}
