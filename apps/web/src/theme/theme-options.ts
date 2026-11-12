import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { t } from '../i18n/id';
import type { ThemePreference } from './theme';

export interface ThemeOption {
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}

/** Urutan tampil pilihan tema, dipakai menu di rail dan halaman Pengaturan. */
export const themeOptions: readonly ThemeOption[] = [
  { value: 'light', label: t.theme.light, icon: Sun },
  { value: 'dark', label: t.theme.dark, icon: Moon },
  { value: 'system', label: t.theme.system, icon: Monitor },
];
