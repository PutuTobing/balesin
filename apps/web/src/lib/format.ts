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

/**
 * Waktu sebagai nilai yang berdiri sendiri (mis. kolom "Tes terakhir"): "Hari ini, 22.03",
 * "Kemarin, 09.15", atau "13 Nov 2026, 22.03".
 */
export function formatDateTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = timeFormat.format(date);
  if (isSameDay(date, now)) return `Hari ini, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Kemarin, ${time}`;
  return `${dateFormat.format(date)}, ${time}`;
}

/**
 * Sisa waktu hitung mundur `m:ss`: `14:59`, `0:45`. Titik dua (seperti hitung mundur OTP),
 * bukan titik: `15.00` terbaca sebagai jam ("pukul 15.00").
 */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Ukuran berkas dalam KB (dibulatkan ke atas). */
export function kilobytes(bytes: number): number {
  return Math.ceil(bytes / 1024);
}

/** Tanggal saja: "14 Nov 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateFormat.format(date);
}
