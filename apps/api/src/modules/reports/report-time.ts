/**
 * Batas waktu laporan menurut ZONA WAKTU ORGANISASI (tanggal/bulan lokal → titik waktu UTC) dan batas
 * bawah UUIDv7 (ID semua tabel = UUIDv7 dari jam aplikasi, berurutan waktu) supaya penyaringan rentang
 * waktu memakai indeks primary key tanpa indeks tambahan.
 */

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Tengah malam tanggal lokal `YYYY-MM-DD` di zona ini sebagai titik waktu. */
export function zonedMidnight(date: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let instant = guess - offsetMs(new Date(guess), timeZone);
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** `YYYY-MM-DD` + n hari (kalender, tanpa zona). */
export function addDays(date: string, days: number): string {
  const value = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return value.toISOString().slice(0, 10);
}

/** Rentang laporan [awal tanggal `from`, awal hari setelah `to`) di zona organisasi. */
export function zonedRange(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedMidnight(from, timeZone), end: zonedMidnight(addDays(to, 1), timeZone) };
}

/** Bulan `YYYY-MM` → [awal bulan, awal bulan berikutnya) di zona organisasi. */
export function zonedMonth(month: string, timeZone: string): { start: Date; end: Date } {
  const [year, value] = month.split('-').map(Number) as [number, number];
  const next =
    value === 12
      ? `${String(year + 1)}-01`
      : `${String(year)}-${String(value + 1).padStart(2, '0')}`;
  return {
    start: zonedMidnight(`${month}-01`, timeZone),
    end: zonedMidnight(`${next}-01`, timeZone),
  };
}

/** UUIDv7 terkecil untuk milidetik ini (batas bawah rentang ID berdasarkan waktu). */
export function uuidV7Floor(at: Date): string {
  const hex = Math.max(0, Math.floor(at.getTime())).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}
