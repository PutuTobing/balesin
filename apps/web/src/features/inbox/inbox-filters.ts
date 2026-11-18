import {
  type ChannelSummary,
  type TagRef,
  type ConversationCountsResponse,
  type ConversationStatus,
  type ConversationWindowFilter,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { InboxTab } from './inbox-search';

/** Saringan daftar chat (selain tab & kata pencarian). Semua opsional. */
export interface InboxFilters {
  channelId?: string;
  /** Tag kontak (percakapan yang kontaknya memakai tag ini). */
  tagId?: string;
  /** UUID agen, `me`, atau `unassigned`. */
  assignee?: string;
  window?: ConversationWindowFilter;
  unread?: boolean;
  /** UUID departemen, atau `none` (tanpa departemen). */
  departmentId?: string;
}

/** Parameter yang dikirim ke `GET /conversations` dan `/conversations/counts`. */
export interface ConversationParams extends InboxFilters {
  status?: ConversationStatus;
  q?: string;
}

export const TAB_STATUS: Readonly<Record<InboxTab, ConversationStatus | undefined>> = {
  semua: undefined,
  bot: 'bot',
  'belum-dilayani': 'unserved',
  dilayani: 'served',
  selesai: 'resolved',
};

/** Tab ↔ kunci hitungan `GET /conversations/counts`. */
export const TAB_COUNT_KEY: Readonly<Record<InboxTab, keyof ConversationCountsResponse['counts']>> =
  {
    semua: 'all',
    bot: 'bot',
    'belum-dilayani': 'unserved',
    dilayani: 'served',
    selesai: 'resolved',
  };

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

export interface SearchTerm {
  /** Kata yang dikirim ke server, atau `null` (kosong / terlalu pendek). */
  query: string | null;
  /** Ada ketikan, tapi belum cukup 2 huruf. */
  tooShort: boolean;
}

/** Ketikan kolom cari → kata pencarian (spasi dirapikan, 2–100 karakter seperti server). */
export function searchTerm(raw: string): SearchTerm {
  const text = raw.trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX).trim();
  if (text.length === 0) return { query: null, tooShort: false };
  if (Array.from(text).length < SEARCH_MIN) return { query: null, tooShort: true };
  return { query: text, tooShort: false };
}

/** Jumlah saringan aktif (lencana tombol saring). */
export function activeFilterCount(filters: InboxFilters): number {
  return [
    filters.channelId,
    filters.tagId,
    filters.assignee,
    filters.window,
    filters.unread || undefined,
    filters.departmentId,
  ].filter((value) => value !== undefined).length;
}

export function hasFilters(filters: InboxFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/** Parameter → query string, tanpa nilai kosong; urutan kunci tetap supaya stabil di cache. */
export function conversationQueryString(
  params: ConversationParams & { cursor?: string; limit?: number },
): string {
  const search = new URLSearchParams();
  const entries: [string, string | number | boolean | undefined][] = [
    ['status', params.status],
    ['channelId', params.channelId],
    ['tagId', params.tagId],
    ['departmentId', params.departmentId],
    ['assignee', params.assignee],
    ['window', params.window],
    ['unread', params.unread ? 'true' : undefined],
    ['q', params.q],
    ['cursor', params.cursor],
    ['limit', params.limit],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Parameter tanpa nilai kosong (kunci cache yang sama untuk saringan yang sama). */
export function compactParams(params: ConversationParams): ConversationParams {
  const result: ConversationParams = {};
  if (params.status) result.status = params.status;
  if (params.channelId) result.channelId = params.channelId;
  if (params.tagId) result.tagId = params.tagId;
  if (params.departmentId) result.departmentId = params.departmentId;
  if (params.assignee) result.assignee = params.assignee;
  if (params.window) result.window = params.window;
  if (params.unread) result.unread = true;
  if (params.q) result.q = params.q;
  return result;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface FilterOptions {
  channels: ChannelSummary[];
  /** `null` = saringan agen tidak ditampilkan (mis. Teknisi: hanya chat miliknya). */
  agents: AgentOption[] | null;
  /** Master tag (saringan tag); kosong = bagian tag tidak tampil. */
  tags?: TagRef[];
  /** Departemen organisasi; kosong = bagian departemen tidak tampil. */
  departments?: { id: string; name: string }[];
}

const f = t.inbox.filters;

export interface FilterChip {
  key: keyof InboxFilters;
  label: string;
}

/** Saringan aktif sebagai label yang bisa dihapus satu per satu. */
export function filterChips(filters: InboxFilters, options: FilterOptions, selfId?: string) {
  const chips: FilterChip[] = [];
  if (filters.window) {
    chips.push({ key: 'window', label: t.inbox.filters.windowLabels[filters.window] });
  }
  if (filters.assignee) {
    const name =
      filters.assignee === 'me' || filters.assignee === selfId
        ? f.me
        : filters.assignee === 'unassigned'
          ? f.unassigned
          : f.chipAssignee(
              options.agents?.find((agent) => agent.id === filters.assignee)?.name ??
                f.unknownAgent,
            );
    chips.push({ key: 'assignee', label: name });
  }
  if (filters.tagId) {
    chips.push({
      key: 'tagId',
      label: f.chipTag(options.tags?.find((tag) => tag.id === filters.tagId)?.name ?? f.unknownTag),
    });
  }
  if (filters.channelId) {
    chips.push({
      key: 'channelId',
      label: f.chipChannel(
        options.channels.find((channel) => channel.id === filters.channelId)?.name ??
          f.unknownChannel,
      ),
    });
  }
  if (filters.departmentId) {
    chips.push({
      key: 'departmentId',
      label: f.chipDepartment(
        filters.departmentId === 'none'
          ? t.departments.filterNone
          : (options.departments?.find((item) => item.id === filters.departmentId)?.name ??
              f.unknownDepartment),
      ),
    });
  }
  if (filters.unread) chips.push({ key: 'unread', label: f.chipUnread });
  return chips;
}
