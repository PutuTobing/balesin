import type {
  AttributeDefinition,
  DepartmentDetail,
  Ticket,
  TicketBoard,
  TicketColumn,
  TicketKanbanResponse,
} from '@balesin/shared';

/**
 * Data tiruan Fase 5 (atribut, board/kolom/tiket, departemen) untuk tes komponen. Bentuknya sama
 * dengan skema bersama.
 */
const NOW = '2026-11-18T03:00:00.000Z';

export const BOARD_ID = '7b000000-0000-4000-8000-000000000001';
export const COLUMN_NEW = '7c000000-0000-4000-8000-000000000001';
export const COLUMN_WORK = '7c000000-0000-4000-8000-000000000002';
export const COLUMN_DONE = '7c000000-0000-4000-8000-000000000003';
export const AGUS = { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0a02', name: 'Agus Saputra' };

export function fakeAttribute(overrides: Partial<AttributeDefinition> = {}): AttributeDefinition {
  return {
    id: '7a000000-0000-4000-8000-000000000001',
    key: 'paket',
    label: 'Paket',
    type: 'select',
    required: true,
    options: ['Bronze', 'Gold'],
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const COLUMNS: TicketColumn[] = [
  { id: COLUMN_NEW, name: 'Baru', position: 0, isDone: false },
  { id: COLUMN_WORK, name: 'Dikerjakan', position: 1, isDone: false },
  { id: COLUMN_DONE, name: 'Selesai', position: 2, isDone: true },
];

export function fakeBoard(overrides: Partial<TicketBoard> = {}): TicketBoard {
  return {
    id: BOARD_ID,
    name: 'Gangguan',
    description: null,
    department: null,
    position: 0,
    columns: COLUMNS,
    attributes: [],
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function fakeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: '7d000000-0000-4000-8000-000000000001',
    number: 12,
    boardId: BOARD_ID,
    column: COLUMNS[0] as TicketColumn,
    title: 'Internet putus sejak pagi',
    description: 'Lampu LOS merah.',
    priority: 'high',
    assignee: AGUS,
    dueAt: null,
    overdue: false,
    contact: null,
    conversation: null,
    attributes: [],
    position: 1,
    closedAt: null,
    createdBy: { kind: 'user', id: AGUS.id, name: AGUS.name },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function fakeKanban(tickets: Ticket[], board = fakeBoard()): TicketKanbanResponse {
  return {
    board,
    columns: board.columns.map((column) => {
      const inColumn = tickets.filter((ticket) => ticket.column.id === column.id);
      return { column, total: inColumn.length, tickets: inColumn };
    }),
  };
}

export function fakeDepartment(overrides: Partial<DepartmentDetail> = {}): DepartmentDetail {
  return {
    id: '7e000000-0000-4000-8000-0000000000d1',
    name: 'Teknisi',
    description: null,
    memberCount: 1,
    members: [{ id: AGUS.id, name: AGUS.name, role: 'cs', restricted: true }],
    defaultChannelIds: [],
    teamHours: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
