import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../lib/media';
import { ThemeContext, type ThemeContextValue } from './theme-context';
import {
  DARK_SCHEME_QUERY,
  THEME_STORAGE_KEY,
  applyPreference,
  readPreference,
  resolveTheme,
  storePreference,
  syncThemeColorMeta,
  type ThemePreference,
} from './theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const systemPrefersDark = useMediaQuery(DARK_SCHEME_QUERY);
  const resolved = resolveTheme(preference, systemPrefersDark);

  // Layout effect: atribut tema terpasang sebelum browser mengecat perubahan pilihan.
  useLayoutEffect(() => {
    applyPreference(preference);
    syncThemeColorMeta();
  }, [preference, resolved]);

  // Pilihan diubah di tab lain → ikut berubah di tab ini.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) {
        setPreferenceState(readPreference());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    setPreferenceState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
