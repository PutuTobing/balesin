import qrcode from 'qrcode-generator';

/** Zona tenang di sekeliling kode, dalam modul (standar QR: minimal 4). */
const QUIET_ZONE = 4;

/**
 * Jalur SVG untuk semua modul gelap: satu persegi panjang per deret modul gelap yang
 * bersebelahan dalam satu baris (lebih ringkas daripada satu persegi per modul).
 */
export function qrPath(value: string): { size: number; path: string } {
  // Koreksi galat "M" (±15%): cukup untuk layar, kode tetap kecil.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col += 1;
      path += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`;
    }
  }
  return { size: count + QUIET_ZONE * 2, path };
}
