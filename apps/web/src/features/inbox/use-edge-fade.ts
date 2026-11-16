import { useEffect, type RefObject } from 'react';

/**
 * Penanda "masih ada isi" di tepi wadah bergulir: `data-fade-start` / `data-fade-end` dipasang
 * selama ada isi tersembunyi di sisi itu. CSS memakainya untuk memudarkan tepi (mask), jadi
 * pengguna tahu daftar/tab masih bisa digeser. Tidak ada pudar bila semua isi muat.
 */
export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  axis: 'x' | 'y',
  /** Hitung ulang bila isi berubah (mis. hitungan tab). */
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const start = axis === 'x' ? element.scrollLeft : element.scrollTop;
      const size = axis === 'x' ? element.clientWidth : element.clientHeight;
      const total = axis === 'x' ? element.scrollWidth : element.scrollHeight;
      toggle(element, 'fadeStart', start > 1);
      toggle(element, 'fadeEnd', start + size < total - 1);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` = pemicu hitung ulang
  }, [ref, axis, ...deps]);
}

function toggle(element: HTMLElement, key: 'fadeStart' | 'fadeEnd', on: boolean): void {
  if (on) element.dataset[key] = '';
  else delete element.dataset[key];
}
