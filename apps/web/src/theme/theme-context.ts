import { createContext, useContext } from 'react';
import type { ResolvedTheme, ThemePreference } from './theme';

export interface ThemeContextValue {
  /** Pilihan pengguna: Terang, Gelap, atau Ikuti sistem. */
  preference: ThemePreference;
  /** Tema yang sedang tampil setelah "Ikuti sistem" diterjemahkan. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme harus dipakai di dalam <ThemeProvider>.');
  return value;
}
