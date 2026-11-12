import type { LinkProps } from '@tanstack/react-router';
import {
  ChartColumn,
  Ellipsis,
  Megaphone,
  MessagesSquare,
  Settings,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { t } from '../../i18n/id';

/**
 * Tempat item tampil:
 * - `primary`  : rail desktop + navigasi bawah HP
 * - `secondary`: rail desktop; di HP masuk layar "Lainnya"
 * - `footer`   : dasar rail desktop; di HP masuk layar "Lainnya"
 * - `more`     : hanya navigasi bawah HP (pintu ke item secondary + footer)
 */
export type NavPlacement = 'primary' | 'secondary' | 'footer' | 'more';

export interface NavItem {
  id: string;
  to: NonNullable<LinkProps['to']>;
  label: string;
  icon: LucideIcon;
  placement: NavPlacement;
}

/** Menu utama (PRD §3). Urutan di sini = urutan tampil. */
export const navItems: readonly NavItem[] = [
  { id: 'inbox', to: '/inbox', label: t.nav.inbox, icon: MessagesSquare, placement: 'primary' },
  { id: 'contacts', to: '/kontak', label: t.nav.contacts, icon: Users, placement: 'primary' },
  {
    id: 'broadcast',
    to: '/broadcast',
    label: t.nav.broadcast,
    icon: Megaphone,
    placement: 'primary',
  },
  { id: 'tickets', to: '/tiket', label: t.nav.tickets, icon: Ticket, placement: 'secondary' },
  {
    id: 'reports',
    to: '/laporan',
    label: t.nav.reports,
    icon: ChartColumn,
    placement: 'secondary',
  },
  { id: 'more', to: '/lainnya', label: t.nav.more, icon: Ellipsis, placement: 'more' },
  { id: 'settings', to: '/pengaturan', label: t.nav.settings, icon: Settings, placement: 'footer' },
];

/** Item yang di HP dibuka lewat layar "Lainnya". */
export const moreMenuItems: readonly NavItem[] = navItems.filter(
  (item) => item.placement === 'secondary' || item.placement === 'footer',
);

function pathMatches(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export type NavActiveState = 'page' | 'section' | null;

/**
 * `page`: item ini halaman yang sedang dibuka. `section`: halaman yang dibuka ada di
 * bawah item ini (berlaku untuk "Lainnya" saat membuka Tiket, Laporan, Pengaturan).
 */
export function navActiveState(item: NavItem, pathname: string): NavActiveState {
  if (pathMatches(pathname, item.to)) return 'page';
  if (item.placement === 'more' && moreMenuItems.some((other) => pathMatches(pathname, other.to))) {
    return 'section';
  }
  return null;
}
