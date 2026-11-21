import { useEffect, type RefObject } from 'react';

/** Selisih tinggi minimal yang dianggap keyboard layar (bukan bilah alamat yang mengecil). */
const KEYBOARD_MIN_PX = 120;

/**
 * Keyboard layar di iOS Safari menutupi halaman tanpa mengecilkan `100dvh` (`interactive-widget`
 * tidak didukung), sehingga composer di dasar layar tertutup (CS3). Saat `visualViewport` lebih
 * pendek dari jendela, kerangka aplikasi diberi tinggi area yang benar-benar terlihat dan digeser
 * mengikuti `offsetTop`; selain itu gaya dikembalikan ke CSS. Android/Chrome (resizes-content)
 * mengecilkan jendela sendiri, jadi tidak ada yang berubah di sana. Zoom cubit diabaikan.
 */
export function useVisualViewportFit(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const element = ref.current;
    if (!viewport || !element) return;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const covered = window.innerHeight - viewport.height;
        if (covered > KEYBOARD_MIN_PX && Math.abs(viewport.scale - 1) < 0.01) {
          element.style.height = `${String(Math.round(viewport.height))}px`;
          element.style.transform =
            viewport.offsetTop > 0 ? `translateY(${String(Math.round(viewport.offsetTop))}px)` : '';
        } else {
          element.style.height = '';
          element.style.transform = '';
        }
      });
    };
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    apply();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      element.style.height = '';
      element.style.transform = '';
    };
  }, [ref]);
}
