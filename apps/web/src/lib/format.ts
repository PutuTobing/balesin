/**
 * Format tanggal/waktu untuk teks UI (bahasa Indonesia). Zona waktu = zona waktu perangkat;
 * nanti diganti zona waktu organisasi bila perlu.
 */
const timeFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "pukul 14.05" untuk hari ini, "13 Nov 2026 pukul 14.05" untuk hari lain. */
export function formatTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `pukul ${timeFormat.format(date)}`;
  return isSameDay(date, now) ? time : `${dateFormat.format(date)} ${time}`;
}

/** Rasio kontras dengan koma desimal: `4,5`. */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toLocaleString('id-ID', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Ukuran berkas dalam KB (dibulatkan ke atas). */
export function kilobytes(bytes: number): number {
  return Math.ceil(bytes / 1024);
}
