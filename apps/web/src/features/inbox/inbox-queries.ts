import type {
  Conversation,
  ConversationListResponse,
  ConversationResponse,
  Contact,
  InboxStreamEvent,
  Message,
  MessageListFilter,
  MessageListResponse,
} from '@balesin/shared';
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { applyMailEvent, isMailEvent } from '../mail/mail-events';
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
  agents: ['inbox', 'agents'] as const,
  tags: ['inbox', 'tags'] as const,
  notes: (id: string) => ['inbox', 'notes', id] as const,
  events: (id: string) => ['inbox', 'events', id] as const,
  /** Pesan tersaring panel detail (`only=starred|media|files`). */
  messagesOnly: (id: string, only: MessageListFilter) =>
    ['inbox', 'messages-only', id, only] as const,
  sendingLimits: ['inbox', 'sending-limits'] as const,
  sendingStatus: ['inbox', 'sending-status'] as const,
  /** Rem darurat diketahui sedang ditarik (dari 423 atau pengaturan batas kirim). */
  sendingPaused: ['inbox', 'sending-paused'] as const,
  /** Penanda (tanpa data pribadi): percakapan ini tidak tersedia lagi untuk pengguna ini. */
  gone: (id: string) => ['inbox', 'gone', id] as const,
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

/**
 * Tahap 9.0 — agen yang berhak atas satu channel (dialog tugaskan/alihkan). Kunci di bawah
 * `inboxKeys.agents` supaya ikut dimuat ulang bersama daftar agen.
 */
export const channelAgentsQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...inboxKeys.agents, 'channel', channelId] as const,
    queryFn: ({ signal }) => endpoints.inbox.channelAgents(channelId, signal),
    staleTime: 60_000,
    retry: retryTransient,
  });

/** Agen inbox: nama pengirim pesan keluar (`senderUserId`) dan saringan agen. */
export const agentsQuery = queryOptions({
  queryKey: inboxKeys.agents,
  queryFn: ({ signal }) => endpoints.inbox.agents(signal),
  staleTime: 5 * 60_000,
  retry: retryTransient,
});

/** Batas kirim & rem darurat — hanya untuk pemegang `sending.limits.manage`. */
export const sendingLimitsQuery = queryOptions({
  queryKey: inboxKeys.sendingLimits,
  queryFn: ({ signal }) => endpoints.sendingLimits.get(signal),
  refetchInterval: 60_000,
  retry: retryTransient,
});

/** Status rem darurat untuk semua peran (`GET /inbox/sending-status`; event `sending.changed`). */
export const sendingStatusQuery = queryOptions({
  queryKey: inboxKeys.sendingStatus,
  queryFn: ({ signal }) => endpoints.inbox.sendingStatus(signal),
  staleTime: 60_000,
  refetchInterval: 120_000,
  retry: retryTransient,
});

/** Rem darurat diketahui ditarik (dari jawaban 423). Tidak pernah diambil dari server sendiri. */
export const sendingPausedQuery = queryOptions({
  queryKey: inboxKeys.sendingPaused,
  queryFn: () => false,
  initialData: false,
  staleTime: Infinity,
  enabled: false,
});

/** Master tag (pilih tag kontak, saringan tag). */
export const tagsQuery = queryOptions({
  queryKey: inboxKeys.tags,
  queryFn: ({ signal }) => endpoints.tags.list(signal),
  staleTime: 5 * 60_000,
  retry: retryTransient,
});

export function notesQuery(conversationId: string) {
  return queryOptions({
    queryKey: inboxKeys.notes(conversationId),
    queryFn: ({ signal }) => endpoints.inbox.notes(conversationId, signal),
    retry: retryTransient,
  });
}

export function eventsQuery(conversationId: string) {
  return queryOptions({
    queryKey: inboxKeys.events(conversationId),
    queryFn: ({ signal }) => endpoints.inbox.events(conversationId, signal),
    retry: retryTransient,
  });
}

/** Media / file / pesan ditandai di panel detail (kursor sama dengan riwayat). */
export function messagesOnlyQuery(conversationId: string, only: MessageListFilter) {
  return infiniteQueryOptions({
    queryKey: inboxKeys.messagesOnly(conversationId, only),
    queryFn: ({ signal, pageParam }) =>
      endpoints.inbox.messages(conversationId, pageParam, signal, only),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });
}

/** Kontak dari jawaban server (ubah kontak, pasang/lepas tag): kontak + ringkasan di percakapan. */
export function storeContact(queryClient: QueryClient, contact: Contact): void {
  queryClient.setQueryData(inboxKeys.contact(contact.id), { contact });
  queryClient.setQueriesData<ConversationPages>(
    { queryKey: inboxKeys.conversationLists },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          conversations: page.conversations.map((item) =>
            item.contact.id === contact.id
              ? {
                  ...item,
                  contact: {
                    ...item.contact,
                    displayName: contact.displayName,
                    nameSource: contact.nameSource,
                    tags: contact.tags,
                  },
                }
              : item,
          ),
        })),
      },
  );
  scheduleListRefresh(queryClient);
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
  // Penanda dulu: pemakai detail percakapan berhenti memuat (tidak ada permintaan ulang yang
  // berujung 404 lagi) begitu datanya dibuang di bawah.
  queryClient.setQueryData(inboxKeys.gone(conversationId), true);
  const contactId = queryClient.getQueryData<ConversationResponse>(
    inboxKeys.conversation(conversationId),
  )?.conversation.contact.id;
  queryClient.removeQueries({ queryKey: inboxKeys.conversation(conversationId), exact: true });
  queryClient.removeQueries({ queryKey: inboxKeys.messages(conversationId) });
  if (contactId) queryClient.removeQueries({ queryKey: inboxKeys.contact(contactId) });
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

/** Percakapan boleh dimuat lagi (dibuka dari daftar / ada event untuknya = masuk cakupan lagi). */
export function reviveConversation(queryClient: QueryClient, conversationId: string): void {
  queryClient.removeQueries({ queryKey: inboxKeys.gone(conversationId), exact: true });
}

/** `true` setelah `forgetConversation` untuk percakapan ini. */
export function goneQuery(conversationId: string) {
  return queryOptions({
    queryKey: inboxKeys.gone(conversationId),
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
    enabled: false,
  });
}

/**
 * Pesan dari jawaban kirim/kirim ulang: dimasukkan (atau diganti) di halaman terbaru riwayat,
 * supaya tampil seketika; event `message.created`/`message.status` lalu menyegarkannya.
 */
export function storeMessage(queryClient: QueryClient, conversationId: string, message: Message) {
  queryClient.setQueryData<MessagePages>(inboxKeys.messages(conversationId), (data) => {
    if (!data) return data;
    const exists = data.pages.some((page) => page.messages.some((item) => item.id === message.id));
    return {
      ...data,
      pages: data.pages.map((page, index) => ({
        ...page,
        messages: exists
          ? page.messages.map((item) => (item.id === message.id ? message : item))
          : index === 0
            ? [message, ...page.messages]
            : page.messages,
      })),
    };
  });
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
    case 'resync':
      // Server membuang event karena terlalu banyak (mis. broadcast besar): muat ulang lewat REST.
      refreshInbox(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      // Akses departemen/tiket bisa berubah (event bus `access.changed`): data bercakupan dimuat ulang.
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['crm'] });
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
      // Tahap 9.0: akses per channel berubah → laporan bercakupan channel juga dimuat ulang.
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      return;
    case 'conversation.updated': {
      const now = Date.now();
      // Server hanya mengirim event dalam cakupan penerima: percakapan ini terlihat lagi.
      reviveConversation(queryClient, event.conversationId);
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
    case 'conversation.detail': {
      // Hanya ID + bagian: ambil ulang bagian yang berubah (cakupan ditegakkan server lagi).
      const id = event.conversationId;
      void queryClient.invalidateQueries({ queryKey: inboxKeys.events(id) });
      if (event.section === 'notes') {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.notes(id) });
      } else if (event.section === 'stars') {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(id) });
        void queryClient.invalidateQueries({ queryKey: ['inbox', 'messages-only', id] });
      } else {
        const contactId = queryClient.getQueryData<ConversationResponse>(inboxKeys.conversation(id))
          ?.conversation.contact.id;
        if (contactId)
          void queryClient.invalidateQueries({ queryKey: inboxKeys.contact(contactId) });
        scheduleListRefresh(queryClient);
      }
      return;
    }
    case 'tags.changed':
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags });
      return;
    case 'sending.changed':
      // Rem darurat ditarik/dilanjutkan: banner & tombol kirim semua pengguna ikut berubah.
      queryClient.setQueryData(inboxKeys.sendingStatus, { paused: event.paused });
      if (!event.paused) queryClient.setQueryData(inboxKeys.sendingPaused, false);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.sendingLimits });
      return;
    case 'conversation.removed':
      // Agen lama yang kehilangan akses (mis. Teknisi dialihkan): buang semua datanya.
      forgetConversation(queryClient, event.conversationId);
      return;
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
      // Gagal: event hanya membawa status — penjelasan (`failure`/`errorCode`) dan tombol "Kirim
      // ulang" butuh pesan lengkap dari REST.
      if (event.status === 'failed') {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(event.conversationId) });
      }
      scheduleListRefresh(queryClient);
      return;
    default:
      // Fase 9: soket yang sama membawa event modul Email (ID & angka saja).
      if (isMailEvent(event)) applyMailEvent(queryClient, event);
      return;
  }
}
