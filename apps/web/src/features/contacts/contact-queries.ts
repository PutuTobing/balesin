import type { AttributeDefinition, Contact, ContactFilter } from '@balesin/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import { retryTransient } from '../inbox/inbox-queries';

/** Kunci cache CRM. Event `resync` WebSocket menyegarkan semuanya (lihat `applyInboxEvent`). */
export const crmKeys = {
  all: ['crm'] as const,
  lists: ['crm', 'contacts'] as const,
  list: (filter: ContactFilter) => ['crm', 'contacts', filter] as const,
  attributes: ['crm', 'attributes'] as const,
};

export const CONTACT_PAGE_SIZE = 50;

/** Saringan → parameter query (kosong tidak dikirim; `possibleDuplicate` sebagai teks). */
export function contactFilterParams(filter: ContactFilter) {
  return {
    q: filter.q,
    tagId: filter.tagId,
    attributeKey: filter.attributeKey,
    attributeValue: filter.attributeValue,
    possibleDuplicate: filter.possibleDuplicate ? 'true' : undefined,
  };
}

export function contactListQuery(filter: ContactFilter) {
  return infiniteQueryOptions({
    queryKey: crmKeys.list(filter),
    queryFn: ({ signal, pageParam }) =>
      endpoints.crm.contacts(
        { ...contactFilterParams(filter), cursor: pageParam, limit: CONTACT_PAGE_SIZE },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });
}

/** Definisi atribut kontak organisasi (urut posisi). */
export const contactAttributesQuery = queryOptions({
  queryKey: crmKeys.attributes,
  queryFn: ({ signal }) => endpoints.attributes.list({ kind: 'contact' }, signal),
  select: (data) => sortAttributes(data.attributes),
  staleTime: 60_000,
  retry: retryTransient,
});

export function sortAttributes(items: readonly AttributeDefinition[]): AttributeDefinition[] {
  return [...items].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
}

/** Kontak berubah (gabung, ubah, hapus): daftar kontak dimuat ulang. */
export function refreshContactLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: crmKeys.lists });
}

/** Kontak yang paling lama dibuat (disarankan dipertahankan saat menggabung). */
export function olderContact(a: Contact, b: Contact): Contact {
  return Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b;
}

/** Pesan sekali-tampil yang dibawa pindah halaman (mis. "Kontak dihapus"). */
let flash: string | null = null;
export function setContactFlash(message: string): void {
  flash = message;
}
export function takeContactFlash(): string | null {
  const taken = flash;
  flash = null;
  return taken;
}
