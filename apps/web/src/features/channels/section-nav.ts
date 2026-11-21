/** Jarak dari tepi atas wadah: bagian yang judulnya sudah sampai di sini dianggap sedang dibaca. */
export const ACTIVE_SECTION_OFFSET = 24;

export interface SectionPosition {
  id: string;
  /** Tepi atas bagian (px, koordinat layar). */
  top: number;
}

/**
 * Bagian aktif saat pengguna menggulir bebas: bagian TERAKHIR yang tepi atasnya sudah mencapai tepi
 * atas wadah + 24px. Bila wadah sudah di dasar, bagian terakhir (bagian pendek di bawah tidak
 * pernah bisa naik sampai ke atas).
 */
export function pickActiveSection(
  sections: readonly SectionPosition[],
  containerTop: number,
  atBottom: boolean,
): string | null {
  const last = sections.at(-1);
  if (!last) return null;
  if (atBottom) return last.id;
  let current = sections[0]?.id ?? null;
  for (const section of sections) {
    if (section.top <= containerTop + ACTIVE_SECTION_OFFSET + 1) current = section.id;
  }
  return current;
}

/** Wadah sudah digulir sampai dasar (toleransi 2px pembulatan). */
export function isScrolledToBottom(box: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
}

/** Tombol yang menggulir wadah (dipakai untuk melepas kunci pilihan navigasi bagian). */
export const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  ' ',
]);
