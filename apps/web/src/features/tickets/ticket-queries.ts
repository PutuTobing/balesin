import {
  permissionScope,
  type AuthenticatedSession,
  type Ticket,
  type TicketBoard,
  type TicketKanbanResponse,
} from '@balesin/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import type { TicketListParams } from '../../lib/api/endpoints-crm';
import { retryTransient } from '../inbox/inbox-queries';

/** Kunci cache tiket. Event `resync` WebSocket menyegarkan semuanya. */
export const ticketKeys = {
  all: ['tickets'] as const,
  boards: (archived: boolean) => ['tickets', 'boards', archived] as const,
  boardLists: ['tickets', 'boards'] as const,
  kanbanAll: ['tickets', 'kanban'] as const,
  kanban: (boardId: string, filter: KanbanFilter) =>
    ['tickets', 'kanban', boardId, filter] as const,
  lists: ['tickets', 'list'] as const,
  list: (params: TicketListParams) => ['tickets', 'list', params] as const,
  detail: (id: string) => ['tickets', 'detail', id] as const,
  comments: (id: string) => ['tickets', 'comments', id] as const,
  events: (id: string) => ['tickets', 'events', id] as const,
};

export interface KanbanFilter {
  assignee?: string;
  priority?: string;
}

export const TICKET_PAGE_SIZE = 50;

export const boardsQuery = (archived = false) =>
  queryOptions({
    queryKey: ticketKeys.boards(archived),
    queryFn: ({ signal }) => endpoints.tickets.boards(archived, signal),
    select: (data) => sortBoards(data.boards),
    staleTime: 30_000,
    retry: retryTransient,
  });

export function sortBoards(boards: readonly TicketBoard[]): TicketBoard[] {
  return [...boards].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export const kanbanQuery = (boardId: string, filter: KanbanFilter) =>
  queryOptions({
    queryKey: ticketKeys.kanban(boardId, filter),
    queryFn: ({ signal }) => endpoints.tickets.kanban(boardId, filter, signal),
    retry: retryTransient,
  });

export const ticketListQuery = (params: TicketListParams) =>
  infiniteQueryOptions({
    queryKey: ticketKeys.list(params),
    queryFn: ({ signal, pageParam }) =>
      endpoints.tickets.list(
        { ...params, cursor: pageParam, limit: params.limit ?? TICKET_PAGE_SIZE },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });

export const ticketQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ticketKeys.detail(ticketId),
    queryFn: ({ signal }) => endpoints.tickets.get(ticketId, signal),
    retry: retryTransient,
  });

export const ticketCommentsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ticketKeys.comments(ticketId),
    queryFn: ({ signal }) => endpoints.tickets.comments(ticketId, signal),
    retry: retryTransient,
  });

export const ticketEventsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ticketKeys.events(ticketId),
    queryFn: ({ signal }) => endpoints.tickets.events(ticketId, signal),
    retry: retryTransient,
  });

/**
 * Jawaban aksi tulis: tiket terbaru disimpan ke cache detail (atau dibuang bila `null` = pemanggil
 * kehilangan akses), lalu Kanban, daftar, dan riwayat dimuat ulang.
 */
export function storeTicket(
  queryClient: QueryClient,
  ticketId: string,
  ticket: Ticket | null,
): void {
  if (ticket) queryClient.setQueryData(ticketKeys.detail(ticketId), { ticket });
  else queryClient.removeQueries({ queryKey: ticketKeys.detail(ticketId) });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.kanbanAll });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.events(ticketId) });
}

/** Board berubah (kolom/atribut/nama): daftar board + Kanban dimuat ulang. */
export function storeBoard(queryClient: QueryClient, board: TicketBoard): void {
  for (const archived of [false, true]) {
    queryClient.setQueryData<{ boards: TicketBoard[] }>(
      ticketKeys.boards(archived),
      (data) =>
        data && { boards: data.boards.map((item) => (item.id === board.id ? board : item)) },
    );
  }
  void queryClient.invalidateQueries({ queryKey: ticketKeys.boardLists });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.kanbanAll });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists });
}

/**
 * Pindah kartu di cache Kanban segera (optimistis) supaya seret-lepas terasa langsung; server
 * menentukan urutan akhir (Kanban dimuat ulang setelah jawaban).
 */
export function moveInKanban(
  data: TicketKanbanResponse,
  ticketId: string,
  columnId: string,
  index: number,
): TicketKanbanResponse {
  let moved: Ticket | undefined;
  const without = data.columns.map((entry) => {
    const found = entry.tickets.find((ticket) => ticket.id === ticketId);
    if (!found) return entry;
    moved = found;
    return {
      ...entry,
      total: entry.total - 1,
      tickets: entry.tickets.filter((ticket) => ticket.id !== ticketId),
    };
  });
  if (!moved) return data;
  const ticket = moved;
  return {
    ...data,
    columns: without.map((entry) => {
      if (entry.column.id !== columnId) return entry;
      const tickets = [...entry.tickets];
      tickets.splice(Math.max(0, Math.min(index, tickets.length)), 0, {
        ...ticket,
        column: entry.column,
      });
      return { ...entry, total: entry.total + 1, tickets };
    }),
  };
}

/** Cakupan `tickets.manage` pengguna: `own` (Teknisi) = field terbatas, hanya tiket miliknya. */
export function ticketScope(session: AuthenticatedSession | null): 'all' | 'own' | null {
  if (!session) return null;
  const scope = permissionScope(session.user.role, 'tickets.manage');
  if (scope === null) return null;
  return scope === 'own' ? 'own' : 'all';
}

/** `datetime-local` (zona perangkat) ↔ ISO. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Pesan sekali-tampil yang dibawa pindah halaman (mis. "Tiket #12 dihapus"). */
let flash: string | null = null;
export function setTicketFlash(message: string): void {
  flash = message;
}
export function takeTicketFlash(): string | null {
  const taken = flash;
  flash = null;
  return taken;
}
