import { API_ROUTES, apiPath } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import {
  AGUS,
  BOARD_ID,
  COLUMNS,
  COLUMN_DONE,
  COLUMN_NEW,
  COLUMN_WORK,
  fakeAttribute,
  fakeBoard,
  fakeKanban,
  fakeTicket,
} from '../../test/fake-crm';
import { renderApp } from '../../test/render-app';
import { moveInKanban } from './ticket-queries';
import { describeEvent } from './ticket-events';

const k = t.tickets;
const R = API_ROUTES.tickets;
const TICKET = fakeTicket();
const ticketPath = apiPath(R.ticket, { ticketId: TICKET.id });

function base(
  extra: Record<string, FakeHandler> = {},
  role: Parameters<typeof fakeSession>[0] = 'owner',
) {
  return {
    session: fakeSession(role),
    routes: {
      [`GET ${R.boards}`]: () => json({ boards: [fakeBoard()] }),
      [`GET ${apiPath(R.kanban, { boardId: BOARD_ID })}`]: () => json(fakeKanban([TICKET])),
      [`GET ${ticketPath}`]: () => json({ ticket: TICKET }),
      [`GET ${apiPath(R.comments, { ticketId: TICKET.id })}`]: () => json({ comments: [] }),
      [`GET ${apiPath(R.events, { ticketId: TICKET.id })}`]: () => json({ events: [] }),
      [`GET ${API_ROUTES.inbox.agents}`]: () =>
        json({
          agents: [
            { id: AGUS.id, name: AGUS.name, role: 'cs', active: true, openConversations: 2 },
          ],
        }),
      ...extra,
    },
  };
}

describe('logika tiket', () => {
  it('pindah kartu di cache Kanban (optimistis)', () => {
    const moved = moveInKanban(fakeKanban([TICKET]), TICKET.id, COLUMN_DONE, 0);
    expect(moved.columns.map((entry) => entry.total)).toEqual([0, 0, 1]);
    expect(moved.columns[2]?.tickets[0]?.column.id).toBe(COLUMN_DONE);
  });

  it('riwayat dibaca manusia tanpa isi', () => {
    expect(
      describeEvent({
        id: '7f000000-0000-4000-8000-000000000001',
        kind: 'moved',
        actor: { kind: 'user', id: AGUS.id, name: AGUS.name },
        fields: null,
        fromColumn: 'Baru',
        toColumn: 'Dikerjakan',
        assignee: null,
        previousAssignee: null,
        createdAt: '2026-11-18T03:00:00.000Z',
      }),
    ).toBe('Agus Saputra · memindahkan tiket dari Baru ke Dikerjakan');
  });
});

describe('halaman tiket', () => {
  it('belum ada board: Owner membuat board pertama', async () => {
    let created: unknown = null;
    const board = fakeBoard({ name: 'Pemasangan' });
    const { api } = await renderApp('/tiket', {
      routes: {
        [`POST ${R.boards}`]: (request) => {
          created = request.body;
          api.on(`GET ${R.boards}`, () => json({ boards: [board] }));
          return json({ board }, { status: 201 });
        },
        [`GET ${apiPath(R.kanban, { boardId: BOARD_ID })}`]: () => json(fakeKanban([], board)),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: k.createFirstBoard }));
    const dialog = await screen.findByRole('dialog', { name: k.boardCreateTitle });
    fireEvent.change(within(dialog).getByLabelText(k.boardName), {
      target: { value: 'Pemasangan' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: k.createBoard }));
    expect(await screen.findByRole('list', { name: k.kanbanLabel('Pemasangan') })).toBeVisible();
    expect(created).toEqual({ name: 'Pemasangan', description: null, departmentId: null });
  });

  it('CS tanpa board: diarahkan ke pengelola', async () => {
    await renderApp('/tiket', { session: fakeSession('cs') });
    expect(await screen.findByText(k.noBoardsBodyNoConfigure)).toBeVisible();
    expect(screen.queryByRole('button', { name: k.createFirstBoard })).toBeNull();
  });

  it('Kanban: angkat dengan keyboard, pindah kolom, letakkan', async () => {
    let moved: unknown = null;
    await renderApp(
      '/tiket',
      base({
        [`POST ${apiPath(R.move, { ticketId: TICKET.id })}`]: (request) => {
          moved = request.body;
          return json({ ticket: { ...TICKET, column: COLUMNS[1] } });
        },
      }),
    );
    const handle = await screen.findByRole('button', { name: k.grabLabel(12) });
    handle.focus();
    fireEvent.keyDown(handle, { key: ' ' });
    expect(screen.getByText(k.grabbed(12, 'Baru', 1, 1))).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: k.grabLabel(12) }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('button', { name: k.grabLabel(12) }), { key: ' ' });
    await waitFor(() => expect(moved).toEqual({ columnId: COLUMN_WORK, afterTicketId: null }));
    expect(screen.getByText(k.dropped(12, 'Dikerjakan'))).toBeInTheDocument();
  });

  it('Kanban: Escape membatalkan tanpa memanggil server', async () => {
    const { api } = await renderApp('/tiket', base());
    const handle = await screen.findByRole('button', { name: k.grabLabel(12) });
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: k.grabLabel(12) }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('button', { name: k.grabLabel(12) }), { key: 'Escape' });
    expect(screen.getByText(k.dropCancelled(12))).toBeInTheDocument();
    expect(api.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('menu "Pindah ke…" sebagai alternatif seret', async () => {
    let moved: unknown = null;
    await renderApp(
      '/tiket',
      base({
        [`POST ${apiPath(R.move, { ticketId: TICKET.id })}`]: (request) => {
          moved = request.body;
          return json({ ticket: { ...TICKET, column: COLUMNS[2] } });
        },
      }),
    );
    fireEvent.keyDown(await screen.findByRole('button', { name: k.moveMenu(12) }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Selesai/ }));
    await waitFor(() => expect(moved).toEqual({ columnId: COLUMN_DONE, afterTicketId: null }));
  });

  it('menu "Pindah ke…" menandai kolom sekarang (nonaktif)', async () => {
    await renderApp('/tiket', base());
    fireEvent.keyDown(await screen.findByRole('button', { name: k.moveMenu(12) }), {
      key: 'Enter',
    });
    const current = await screen.findByRole('menuitem', { name: k.currentColumn('Baru') });
    expect(current).toHaveAttribute('aria-disabled', 'true');
  });

  it('hapus kolom kosong mengirim body `{}`', async () => {
    let body: unknown = 'tidak terkirim';
    await renderApp(
      '/tiket',
      base({
        [`DELETE ${apiPath(R.column, { boardId: BOARD_ID, columnId: COLUMN_WORK })}`]: (
          request,
        ) => {
          body = request.body;
          return json({ board: fakeBoard({ columns: [COLUMNS[0]!, COLUMNS[2]!] }) });
        },
      }),
    );
    fireEvent.keyDown(await screen.findByRole('button', { name: k.columnMenu('Dikerjakan') }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: k.deleteColumn }));
    const dialog = await screen.findByRole('dialog', { name: k.deleteColumnTitle('Dikerjakan') });
    fireEvent.click(within(dialog).getByRole('button', { name: k.deleteColumnConfirm }));
    await waitFor(() => expect(body).toEqual({}));
  });

  it('tiket baru: isian board wajib diperiksa dulu', async () => {
    let created: unknown = null;
    const board = fakeBoard({
      attributes: [fakeAttribute({ key: 'odp', label: 'ODP', type: 'text' })],
    });
    await renderApp(
      '/tiket',
      base({
        [`GET ${R.boards}`]: () => json({ boards: [board] }),
        [`GET ${apiPath(R.kanban, { boardId: BOARD_ID })}`]: () => json(fakeKanban([], board)),
        [`POST ${R.list}`]: (request) => {
          created = request.body;
          return json({ ticket: null }, { status: 201 });
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: k.newTicket }));
    const dialog = await screen.findByRole('dialog', { name: k.createTitle });
    fireEvent.change(within(dialog).getByLabelText(k.titleLabel), {
      target: { value: 'Pasang baru Jl. Melati' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: k.create }));
    expect(await within(dialog).findByText('ODP wajib diisi.')).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^ODP/), { target: { value: 'ODP-12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: k.create }));
    // `ticket: null` = dibuat tetapi di luar akses: pesan, bukan halaman detail.
    expect(await screen.findByText(k.createdNoAccess)).toBeVisible();
    expect(created).toMatchObject({
      boardId: BOARD_ID,
      title: 'Pasang baru Jl. Melati',
      attributes: [{ key: 'odp', value: 'ODP-12' }],
    });
  });

  it('tampilan Daftar memakai saringan status & penanggung jawab', async () => {
    const { api } = await renderApp(
      '/tiket?tampilan=daftar&pj=me&status=all',
      base({ [`GET ${R.list}`]: () => json({ tickets: [TICKET], nextCursor: null }) }),
    );
    expect(await screen.findByRole('link', { name: k.cardLabel(12, TICKET.title) })).toBeVisible();
    const request = api.requests.find((item) => item.path === R.list);
    expect(request?.query.get('assignee')).toBe('me');
    expect(request?.query.get('status')).toBe('all');
    expect(request?.query.get('boardId')).toBe(BOARD_ID);
  });
});

describe('detail tiket', () => {
  it('percakapan di channel tanpa akses: teks "tidak tersedia", bukan tautan', async () => {
    await renderApp(
      `/tiket/${TICKET.id}`,
      base({
        [`GET ${ticketPath}`]: () =>
          json({ ticket: { ...TICKET, conversation: null, conversationUnavailable: true } }),
      }),
    );
    expect(await screen.findByText(k.conversationUnavailable)).toBeVisible();
    expect(screen.queryByRole('link', { name: /percakapan/i })).toBeNull();
  });

  it('kehilangan akses setelah dialihkan → kembali ke daftar dengan pesan', async () => {
    const { router } = await renderApp(
      `/tiket/${TICKET.id}`,
      base({ [`PATCH ${ticketPath}`]: () => json({ ticket: null }) }),
    );
    const assignee = await screen.findByLabelText(k.assigneePick);
    fireEvent.change(assignee, { target: { value: '' } });
    await waitFor(() => expect(router.state.location.pathname).toBe('/tiket'));
    expect(await screen.findByText(k.lostAccess)).toBeVisible();
  });

  it('Teknisi: penanggung jawab hanya-baca, tanpa hapus', async () => {
    await renderApp(`/tiket/${TICKET.id}`, base({}, 'teknisi'));
    expect(await screen.findByText(k.technicianNote)).toBeVisible();
    expect(screen.queryByLabelText(k.assigneePick)).toBeNull();
    expect(screen.queryByRole('button', { name: k.deleteTicket })).toBeNull();
    expect(screen.getByLabelText(k.columnStatus)).toHaveValue(COLUMN_NEW);
  });

  it('komentar terkirim lalu daftar dimuat ulang', async () => {
    let comment: unknown = null;
    await renderApp(
      `/tiket/${TICKET.id}`,
      base({
        [`POST ${apiPath(R.comments, { ticketId: TICKET.id })}`]: (request) => {
          comment = request.body;
          return json(
            {
              comment: {
                id: '7f000000-0000-4000-8000-0000000000c1',
                body: 'Sudah dicek',
                author: null,
                createdAt: '2026-11-18T03:00:00.000Z',
              },
            },
            { status: 201 },
          );
        },
      }),
    );
    fireEvent.change(await screen.findByLabelText(k.commentLabel), {
      target: { value: 'Sudah dicek' },
    });
    fireEvent.click(screen.getByRole('button', { name: k.sendComment }));
    await waitFor(() => expect(comment).toEqual({ body: 'Sudah dicek' }));
  });
});
