import { breakpoints } from '@balesin/shared/design-tokens';
import { useCallback, useSyncExternalStore } from 'react';

/** Media query kerangka layar (DESIGN.md §2), dibangun dari token breakpoint. */
export const media = {
  /** HP: navigasi bawah, layar bertumpuk. */
  hp: `(max-width: ${breakpoints.hpMax}px)`,
  /** Desktop: rail + tiga kolom. */
  desktop: `(min-width: ${breakpoints.desktopMin}px)`,
} as const;

/** Nilai media query yang ikut berubah saat layar atau pengaturan sistem berubah. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
