import type { ContactFilter } from '@balesin/shared';

/**
 * Saringan daftar kontak di URL (`/kontak?cari=budi&tag=…&duplikat=1`) supaya tetap ada setelah
 * membuka detail lalu kembali. Nilai tak dikenal diabaikan (bukan membuat halaman gagal).
 */
export interface ContactSearch {
  cari?: string;
  tag?: string;
  atribut?: string;
  nilai?: string;
  duplikat?: 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : undefined;

export function parseContactSearch(search: Record<string, unknown>): ContactSearch {
  const atribut = text(search.atribut, 40);
  const nilai = text(search.nilai, 500);
  return {
    cari: text(search.cari, 100),
    tag: typeof search.tag === 'string' && UUID.test(search.tag) ? search.tag : undefined,
    // Atribut berpasangan: tanpa nilai, kuncinya diabaikan (dan sebaliknya).
    atribut: atribut && nilai ? atribut : undefined,
    nilai: atribut && nilai ? nilai : undefined,
    duplikat: search.duplikat === 1 || search.duplikat === '1' ? 1 : undefined,
  };
}

/** Saringan URL → saringan API (`q` hanya bila ≥ 2 karakter). */
export function contactFilterFrom(search: ContactSearch): ContactFilter {
  const q = search.cari?.trim().replace(/\s+/g, ' ');
  return {
    q: q && Array.from(q).length >= 2 ? q : undefined,
    tagId: search.tag,
    attributeKey: search.atribut,
    attributeValue: search.nilai,
    possibleDuplicate: search.duplikat === 1 ? true : undefined,
  };
}

export function hasContactFilter(filter: ContactFilter): boolean {
  return Object.values(filter).some((value) => value !== undefined);
}
