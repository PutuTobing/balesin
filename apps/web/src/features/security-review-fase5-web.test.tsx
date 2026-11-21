/**
 * Tes penjaga review keamanan web — UI Fase 5 (kontak, tiket, departemen, laporan, CSAT)
 * (docs/security-reviews/2026-11-22-fase5-web.md). Semua `it` = regresi.
 */
import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeSession, json, type FakeHandler } from '../test/fake-api';
import { AGUS, BOARD_ID, fakeBoard, fakeKanban, fakeTicket } from '../test/fake-crm';
import { renderApp } from '../test/render-app';

const HTML = '"><img src=x onerror="window.__xss=1">';

function noInjection() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

describe('review keamanan — tiket tampil sebagai teks', () => {
  it('judul, deskripsi, komentar, nama penulis & board berisi HTML → teks', async () => {
    const ticket = fakeTicket({
      title: `Tiket ${HTML}`.slice(0, 120),
      description: `Deskripsi ${HTML}`,
    });
    const R = API_ROUTES.tickets;
    const routes: Record<string, FakeHandler> = {
      [`GET ${R.boards}`]: () =>
        json({ boards: [fakeBoard({ name: `Board ${HTML}`.slice(0, 60) })] }),
      [`GET ${apiPath(R.kanban, { boardId: BOARD_ID })}`]: () => json(fakeKanban([ticket])),
      [`GET ${apiPath(R.ticket, { ticketId: ticket.id })}`]: () => json({ ticket }),
      [`GET ${apiPath(R.comments, { ticketId: ticket.id })}`]: () =>
        json({
          comments: [
            {
              id: '7f000000-0000-4000-8000-0000000000c9',
              body: `Komentar ${HTML}`,
              author: {
                kind: 'api_key',
                id: '7f000000-0000-4000-8000-0000000000ca',
                name: `Bot ${HTML}`,
              },
              createdAt: '2026-11-18T03:00:00.000Z',
            },
          ],
        }),
      [`GET ${apiPath(R.events, { ticketId: ticket.id })}`]: () => json({ events: [] }),
      [`GET ${API_ROUTES.inbox.agents}`]: () =>
        json({
          agents: [
            { id: AGUS.id, name: AGUS.name, role: 'cs', active: true, openConversations: 0 },
          ],
        }),
    };
    await renderApp(`/tiket/${ticket.id}`, { session: fakeSession('owner'), routes });
    await waitFor(() => expect(document.body.textContent).toContain('Komentar'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    noInjection();
    expect(document.body.textContent).toContain('onerror');
  });
});

describe('review keamanan — guard halaman Fase 5', () => {
  it('CS & Teknisi dialihkan dari impor, departemen, atribut, CSAT, pengaturan board — tanpa memanggil API-nya', async () => {
    const guarded = [
      '/kontak/impor',
      '/pengaturan/departemen',
      '/pengaturan/atribut-kontak',
      '/pengaturan/csat',
      `/tiket/board/${BOARD_ID}`,
    ];
    const forbiddenApi = [
      API_ROUTES.departments.settings,
      '/api/v1/contact-attributes',
      '/api/v1/contacts/import',
      'csat',
      `/api/v1/ticket-boards/${BOARD_ID}`,
    ];
    for (const role of ['cs', 'teknisi'] as const) {
      for (const target of guarded) {
        const view = await renderApp(target, { session: fakeSession(role) });
        await waitFor(() => expect(view.router.state.location.pathname).not.toBe(target));
        const touched = view.api.requests.filter(
          (request) =>
            request.method !== 'GET' || forbiddenApi.some((path) => request.path.includes(path)),
        );
        expect(
          touched.filter((request) => request.path !== API_ROUTES.auth?.me),
          `${role} ${target}`,
        ).toEqual([]);
        view.unmount();
      }
    }
  });
});
