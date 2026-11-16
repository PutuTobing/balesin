/**
 * Gulir wadah gulir terdekat (mis. isi halaman `Page`) sampai `element` berada di atasnya.
 * Bukan `scrollIntoView({ block: 'start' })`: itu ikut menggeser leluhur ber-`overflow: hidden`
 * (kerangka aplikasi), sehingga header halaman dan rail navigasi ikut tergeser keluar layar.
 */
export function scrollToTopOfContainer(element: HTMLElement, offset = 16): void {
  let box = element.parentElement;
  while (box) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY === 'auto' || overflowY === 'scroll') break;
    box = box.parentElement;
  }
  if (!box) return;
  const top = element.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += top - offset;
}
