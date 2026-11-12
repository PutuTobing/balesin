/**
 * Tab daftar chat (PRD §3.3). Nilai ini tampil di URL (`/inbox?tab=belum-dilayani`),
 * jadi memakai bahasa Indonesia seperti alamat halaman lainnya.
 */
export const INBOX_TABS = ['semua', 'bot', 'belum-dilayani', 'dilayani', 'selesai'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
export const DEFAULT_INBOX_TAB: InboxTab = 'semua';

export interface InboxSearch {
  /** Kosong = tab bawaan ("Semua"), supaya URL tetap bersih. */
  tab?: InboxTab;
}

export function parseInboxTab(value: unknown): InboxTab {
  return INBOX_TABS.find((tab) => tab === value) ?? DEFAULT_INBOX_TAB;
}

/**
 * Validasi parameter URL: nilai tak dikenal diabaikan, bukan membuat halaman gagal.
 * Kunci `tab` selalu dikembalikan (walau `undefined`) karena router menggabungkan hasil
 * ini di atas parameter mentah; tanpa itu nilai tak dikenal akan lolos ke halaman.
 */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = parseInboxTab(search.tab);
  return { tab: tab === DEFAULT_INBOX_TAB ? undefined : tab };
}
