import type {
  Conversation,
  ConversationListResponse,
  ConversationResponse,
  InboxStreamEvent,
  MessageListResponse,
} from '@balesin/shared';
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { compactParams, conversationQueryString, type ConversationParams } from './inbox-filters';

/**
 * Data Inbox lewat TanStack Query. Event WebSocket (`inbox-stream.ts`) hanya berisi ID + status,
 * jadi cache diperbarui di tempat untuk yang bisa (lencana belum dibaca, status kirim) lalu daftar
 * & hitungan dimuat ulang lewat REST (cakupan ditegakkan server lagi).
 */

export const INBOX_PAGE_SIZE = 30;

export const inboxKeys = {
  all: ['inbox'] as const,
  conversationLists: ['inbox', 'conversations'] as const,
  conversations: (params: ConversationParams) => ['inbox', 'conversations', params] as const,
  countsAll: ['inbox', 'counts'] as const,
  counts: (params: ConversationParams) => ['inbox', 'counts', params] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  messages: (id: string) => ['inbox', 'messages', id] as const,
  contact: (id: string) => ['inbox', 'contact', id] as const,
  channels: ['inbox', 'channels'] as const,
};

/**
 * Coba ulang hanya untuk gangguan sementara jaringan/server. 4xx (termasuk 429 batas laju) dan
 * 503 pencarian terlalu lama TIDAK diulang otomatis: pengguna yang memutuskan.
 */
export function retryTransient(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (!isApiError(error)) return true;
  return error.status === 0 || (error.status >= 500 && error.status !== 503);
}

/** 404 = percakapan tidak ada / di luar cakupan pengguna ini (dialihkan, dihapus). */
export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

export function conversationsQuery(params: ConversationParams) {
  const key = compactParams(params);
  return infiniteQueryOptions({
    queryKey: inboxKeys.conversations(key),
    queryFn: ({ signal, pageParam }) =>
      endpoints.inbox.conversations(
        conversationQueryString({ ...key, cursor: pageParam ?? undefined, limit: INBOX_PAGE_SIZE }),
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });
}

export function countsQuery(params: Omit<ConversationParams, 'status'>) {
  const key = compactParams(params);
  return queryOptions({
    queryKey: inboxKeys.counts(key),
    queryFn: ({ signal }) => endpoints.inbox.counts(conversationQueryString(key), signal),
    retry: retryTransient,
  });
}

/**
 * Satu percakapan. Data awal diambil dari daftar yang sudah dimuat (tidak ada kedipan kerangka
 * saat memilih chat), lalu disegarkan dari server.
 */
export function conversationQuery(conversationId: string, queryClient?: QueryClient) {
  return queryOptions({
    queryKey: inboxKeys.conversation(conversationId),
    queryFn: ({ signal }) => endpoints.inbox.conversation(conversationId, signal),
    initialData: () => {
      const found = queryClient && findListedConversation(queryClient, conversationId);
      return found ? { conversation: found.conversation } : undefined;
    },
    initialDataUpdatedAt: () =>
      queryClient && findListedConversation(queryClient, conversationId)?.updatedAt,
    retry: retryTransient,
  });
}

export function messagesQuery(conversationId: string) {
  return infiniteQueryOptions({
    queryKey: inboxKeys.messages(conversationId),
    queryFn: ({ signal, pageParam }) => endpoints.inbox.messages(conversationId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });
}

export function contactQuery(contactId: string) {
  return queryOptions({
    queryKey: inboxKeys.contact(contactId),
    queryFn: ({ signal }) => endpoints.inbox.contact(contactId, signal),
    retry: retryTransient,
  });
}

export const inboxChannelsQuery = queryOptions({
  queryKey: inboxKeys.channels,
  queryFn: ({ signal }) => endpoints.inbox.channels(signal),
  staleTime: 5 * 60_000,
});

// ── Pembaruan cache ─────────────────────────────────────────────────────────

type ConversationPages = InfiniteData<ConversationListResponse, string | null>;
type MessagePages = InfiniteData<MessageListResponse, string | null>;

function findListedConversation(
  queryClient: QueryClient,
  conversationId: string,
): { conversation: Conversation; updatedAt: number } | undefined {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: inboxKeys.conversationLists })) {
    const data = query.state.data as ConversationPages | undefined;
    for (const page of data?.pages ?? []) {
      const conversation = page.conversations.find((item) => item.id === conversationId);
      if (conversation) return { conversation, updatedAt: query.state.dataUpdatedAt };
    }
  }
  return undefined;
}

/** Ubah satu percakapan di semua daftar + detailnya. `update` mengembalikan versi barunya. */
export function patchConversation(
  queryClient: QueryClient,
  conversationId: string,
  update: (conversation: Conversation) => Conversation,
): void {
  queryClient.setQueriesData<ConversationPages>(
    { queryKey: inboxKeys.conversationLists },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          conversations: page.conversations.map((item) =>
            item.id === conversationId ? update(item) : item,
          ),
        })),
      },
  );
  queryClient.setQueryData<ConversationResponse>(
    inboxKeys.conversation(conversationId),
    (data) => data && { conversation: update(data.conversation) },
  );
}

/**
 * Percakapan tidak lagi tersedia untuk pengguna ini (404: dialihkan, dihapus, di luar cakupan):
 * buang SEMUA data tersimpannya (detail, pesan, kontak di daftar) supaya isi lama tidak tetap
 * tampil, lalu muat ulang daftar.
 */
export function forgetConversation(queryClient: QueryClient, conversationId: string): void {
  queryClient.removeQueries({ queryKey: inboxKeys.messages(conversationId) });
  queryClient.setQueriesData<ConversationPages>(
    { queryKey: inboxKeys.conversationLists },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          conversations: page.conversations.filter((item) => item.id !== conversationId),
        })),
      },
  );
  scheduleListRefresh(queryClient);
}

/** Simpan percakapan dari jawaban server (mis. setelah tandai dibaca). */
export function storeConversation(queryClient: QueryClient, conversation: Conversation): void {
  patchConversation(queryClient, conversation.id, () => conversation);
}

/** Pesan-pesan yang sudah dimuat (lama → baru, tanpa duplikat). */
export function flattenMessages(data: InfiniteData<MessageListResponse, unknown> | undefined) {
  if (!data) return [];
  const seen = new Set<string>();
  const result = [];
  for (const page of data.pages) {
    for (const message of page.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      result.push(message);
    }
  }
  return result.reverse();
}

const refreshTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();
/** Jeda pengumpulan event beruntun sebelum daftar & hitungan dimuat ulang. */
export const LIST_REFRESH_DELAY_MS = 400;

/** Muat ulang semua daftar & hitungan sekali saja untuk rentetan event (debounce). */
export function scheduleListRefresh(queryClient: QueryClient): void {
  const pending = refreshTimers.get(queryClient);
  if (pending !== undefined) clearTimeout(pending);
  refreshTimers.set(
    queryClient,
    setTimeout(() => {
      refreshTimers.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
    }, LIST_REFRESH_DELAY_MS),
  );
}

/** Setelah sambungan real-time pulih: event selama terputus tidak diulang, jadi muat ulang semua. */
export function refreshInbox(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
}

/**
 * Terapkan satu event WebSocket ke cache. Event TIDAK membawa isi pesan/nama, jadi:
 *  - `conversation.updated` → lencana belum dibaca/status/jendela diperbarui langsung (terasa
 *    instan), lalu daftar & hitungan dimuat ulang (urutan, cuplikan pesan terakhir, agen);
 *  - `message.created` → riwayat pesan percakapan itu dimuat ulang (bila sedang dipakai);
 *  - `message.status` → centang status pesan keluar diperbarui di tempat.
 */
export function applyInboxEvent(queryClient: QueryClient, event: InboxStreamEvent): void {
  switch (event.type) {
    case 'hello':
      return;
    case 'conversation.updated': {
      const now = Date.now();
      patchConversation(queryClient, event.conversationId, (conversation) => ({
        ...conversation,
        status: event.status,
        unreadCount: event.unreadCount,
        lastMessageAt: event.lastMessageAt,
        windowExpiresAt: event.windowExpiresAt,
        windowOpen: event.windowExpiresAt !== null && Date.parse(event.windowExpiresAt) > now,
      }));
      // Detail selalu diambil ulang: agen bisa berganti, dan bila cakupan pemanggil hilang
      // (mis. Teknisi dialihkan) server menjawab 404 → layar menutup chat itu (`forgetConversation`).
      void queryClient.invalidateQueries({
        queryKey: inboxKeys.conversation(event.conversationId),
      });
      scheduleListRefresh(queryClient);
      return;
    }
    case 'message.created':
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(event.conversationId) });
      scheduleListRefresh(queryClient);
      return;
    case 'message.status':
      queryClient.setQueryData<MessagePages>(
        inboxKeys.messages(event.conversationId),
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              messages: page.messages.map((message) =>
                message.id === event.messageId ? { ...message, status: event.status } : message,
              ),
            })),
          },
      );
      scheduleListRefresh(queryClient);
      return;
  }
}
