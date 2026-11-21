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
  /** ID percakapan yang sedang dibuka (UUID). */
  chat?: string;
  /** HP: panel detail dibuka sebagai layar bertumpuk di atas chat (`&detail=1`). */
  detail?: 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInboxTab(value: unknown): InboxTab {
  return INBOX_TABS.find((tab) => tab === value) ?? DEFAULT_INBOX_TAB;
}

/** ID percakapan dari URL: hanya UUID (huruf kecil), selain itu diabaikan. */
export function parseChatId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Validasi parameter URL: nilai tak dikenal diabaikan, bukan membuat halaman gagal.
 * Kunci selalu dikembalikan (walau `undefined`) karena router menggabungkan hasil
 * ini di atas parameter mentah; tanpa itu nilai tak dikenal akan lolos ke halaman.
 */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = parseInboxTab(search.tab);
  return {
    tab: tab === DEFAULT_INBOX_TAB ? undefined : tab,
    chat: parseChatId(search.chat),
    detail: search.detail === 1 || search.detail === '1' ? 1 : undefined,
  };
}
