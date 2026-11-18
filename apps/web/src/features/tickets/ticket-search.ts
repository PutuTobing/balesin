import {
  TICKET_DUE_FILTERS,
  TICKET_PRIORITIES,
  TICKET_STATUS_FILTERS,
  type TicketPriority,
} from '@balesin/shared';

/**
 * Keadaan layar Tiket di URL (`/tiket?board=…&tampilan=daftar&pj=me`). Nilai tak dikenal diabaikan.
 * `tampilan` kosong = Kanban. `status`/`tenggat`/`cari` hanya untuk tampilan Daftar.
 */
export interface TicketSearch {
  board?: string;
  tampilan?: 'daftar';
  /** Penanggung jawab: UUID, `me`, atau `none`. */
  pj?: string;
  prioritas?: TicketPriority;
  status?: 'closed' | 'all';
  tenggat?: (typeof TICKET_DUE_FILTERS)[number];
  cari?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTicketSearch(search: Record<string, unknown>): TicketSearch {
  const pick = <T extends string>(value: unknown, allowed: readonly T[]) =>
    allowed.find((item) => item === value);
  const status = pick(search.status, TICKET_STATUS_FILTERS);
  return {
    board: typeof search.board === 'string' && UUID.test(search.board) ? search.board : undefined,
    tampilan: search.tampilan === 'daftar' ? 'daftar' : undefined,
    pj:
      search.pj === 'me' || search.pj === 'none'
        ? search.pj
        : typeof search.pj === 'string' && UUID.test(search.pj)
          ? search.pj
          : undefined,
    prioritas: pick(search.prioritas, TICKET_PRIORITIES),
    status: status === 'open' ? undefined : status,
    tenggat: pick(search.tenggat, TICKET_DUE_FILTERS),
    cari:
      typeof search.cari === 'string' && search.cari.trim() !== ''
        ? search.cari.slice(0, 100)
        : undefined,
  };
}
