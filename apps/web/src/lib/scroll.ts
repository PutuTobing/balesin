/** Wadah gulir terdekat (`overflow-y: auto|scroll`) di atas `element`, mis. isi halaman `Page`. */
export function scrollContainerOf(element: Element | null): HTMLElement | null {
  let box = element?.parentElement ?? null;
  while (box) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY === 'auto' || overflowY === 'scroll') return box;
    box = box.parentElement;
  }
  return null;
}

/**
 * Gulir wadah gulir terdekat (mis. isi halaman `Page`) sampai `element` berada di atasnya.
 * Bukan `scrollIntoView({ block: 'start' })`: itu ikut menggeser leluhur ber-`overflow: hidden`
 * (kerangka aplikasi), sehingga header halaman dan rail navigasi ikut tergeser keluar layar.
 */
export function scrollToTopOfContainer(element: HTMLElement, offset = 16): void {
  const box = scrollContainerOf(element);
  if (!box) return;
  const top = element.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += top - offset;
}
