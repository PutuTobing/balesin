/** Gabungkan nama kelas, lewati nilai kosong. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
