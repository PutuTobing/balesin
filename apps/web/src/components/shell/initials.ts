/** Inisial untuk avatar: huruf pertama dua kata pertama nama, huruf besar. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase('id-ID') || '?';
}
