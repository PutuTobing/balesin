import {
  API_ROUTES,
  AUTO_MESSAGE_DEFAULT_TEXTS,
  apiPath,
  type WorkspaceSettings,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { fakeConversation, fakeEvent } from '../../test/fake-inbox';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../test/identity';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const w = t.workspace;
const W = API_ROUTES.workspace;

const SETTINGS: WorkspaceSettings = {
  timezone: 'Asia/Makassar',
  teamHours: {
    mode: 'schedule',
    windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' })),
  },
  holidays: [{ date: '2026-12-25', name: 'Natal' }],
  withinTeamHoursNow: true,
  allocation: { mode: 'manual', maxOpenPerAgent: null },
  autoMessages: {
    greeting: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.greeting },
    away: { enabled: true, text: AUTO_MESSAGE_DEFAULT_TEXTS.away },
    assigned: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.assigned },
  },
  updatedAt: null,
};

function routes(extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${W.settings}`]: () => json({ settings: SETTINGS }),
      [`GET ${W.agents}`]: () =>
        json({
          agents: [
            {
              userId: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0a02',
              name: 'Agus Saputra',
              role: 'cs',
              available: true,
              excluded: false,
              openConversations: 3,
              lastAssignedAt: null,
            },
          ],
        }),
      ...extra,
    },
  };
}

describe('Pengaturan → Jam kerja & alokasi', () => {
  it('mengaktifkan pesan otomatis = konfirmasi identitas', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      '/pengaturan/jam-kerja',
      routes({
        [`PUT ${W.settings}`]: (request) => {
          bodies.push(request.body);
          return json({ settings: SETTINGS });
        },
      }),
    );
    const section = within(await screen.findByRole('form', { name: w.autoTitle }));
    fireEvent.click(section.getByLabelText(w.autoEnabled(w.autoLabels.greeting ?? '')));
    fireEvent.click(section.getByRole('button', { name: w.save }));
    // Dialog TIDAK bersarang di <form> pesan otomatis: form bersarang membuat browser mengirim
    // password & kode lewat GET ke URL halaman.
    expect(
      (await screen.findByRole('dialog', { name: w.autoConfirmTitle })).closest('form'),
    ).toBeNull();
    await confirmIdentity(w.autoConfirmTitle, w.autoConfirm);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      autoMessages: { greeting: { enabled: true, text: AUTO_MESSAGE_DEFAULT_TEXTS.greeting } },
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('mematikan pesan otomatis tanpa konfirmasi; variabel tak dikenal ditolak', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      '/pengaturan/jam-kerja',
      routes({
        [`PUT ${W.settings}`]: (request) => {
          bodies.push(request.body);
          return json({ settings: SETTINGS });
        },
      }),
    );
    const section = within(await screen.findByRole('form', { name: w.autoTitle }));
    const greeting = section.getByLabelText(`${w.autoText}: ${w.autoLabels.greeting ?? ''}`, {
      selector: 'textarea',
    });
    fireEvent.change(greeting, { target: { value: 'Halo {agen}' } });
    fireEvent.click(section.getByRole('button', { name: w.save }));
    expect(await section.findByText(/Variabel \{agen\} tidak bisa dipakai di sini/)).toBeVisible();
    fireEvent.change(greeting, { target: { value: AUTO_MESSAGE_DEFAULT_TEXTS.greeting } });
    fireEvent.click(section.getByLabelText(w.autoEnabled(w.autoLabels.away ?? '')));
    fireEvent.click(section.getByRole('button', { name: w.save }));
    await waitFor(() =>
      expect(bodies).toEqual([
        { autoMessages: { away: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.away } } },
      ]),
    );
  });

  it('jam kerja + hari libur, lalu pembagian round-robin dengan kapasitas', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      '/pengaturan/jam-kerja',
      routes({
        [`PUT ${W.settings}`]: (request) => {
          bodies.push(request.body);
          return json({ settings: SETTINGS });
        },
      }),
    );
    const hours = within(await screen.findByRole('form', { name: w.hoursTitle }));
    fireEvent.change(hours.getByLabelText(w.holidayDate), { target: { value: '2026-03-19' } });
    fireEvent.change(hours.getByLabelText(w.holidayName), { target: { value: 'Nyepi' } });
    fireEvent.click(hours.getByRole('button', { name: w.addHoliday }));
    fireEvent.click(hours.getByRole('button', { name: w.save }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      teamHours: { mode: 'schedule' },
      holidays: [
        { date: '2026-03-19', name: 'Nyepi' },
        { date: '2026-12-25', name: 'Natal' },
      ],
    });

    const allocation = within(screen.getByRole('form', { name: w.allocationTitle }));
    fireEvent.click(
      allocation.getByRole('radio', { name: new RegExp(w.allocationModes.round_robin ?? '') }),
    );
    fireEvent.change(allocation.getByLabelText(new RegExp(w.capacity)), { target: { value: '8' } });
    fireEvent.click(allocation.getByRole('button', { name: w.save }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ allocation: { mode: 'round_robin', maxOpenPerAgent: 8 } });
  });

  it('agen: satu sakelar positif "Ikut pembagian otomatis"; status sebagai teks', async () => {
    let patched: unknown = null;
    await renderApp(
      '/pengaturan/jam-kerja',
      routes({
        [`PATCH ${apiPath(W.agent, { userId: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0a02' })}`]: (
          request,
        ) => {
          patched = request.body;
          return json({ agent: {} });
        },
      }),
    );
    const agents = within(await screen.findByRole('list', { name: w.agentsLabel }));
    expect(
      agents.getByText(new RegExp(`^${w.availabilityOn}$`), { selector: 'span span' }),
    ).toBeVisible();
    const included = agents.getByRole('switch', { name: `${w.included}: Agus Saputra` });
    expect(included).toHaveAttribute('aria-checked', 'true');
    expect(agents.getByRole('switch', { name: `${w.available}: Agus Saputra` })).toBeEnabled();
    fireEvent.click(included);
    await waitFor(() => expect(patched).toEqual({ excluded: true }));
  });
});

describe('saklar "Tersedia" di inbox', () => {
  it('round-robin: agen mematikan ketersediaan', async () => {
    let body: unknown = null;
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox', {
      session: fakeSession('cs'),
      routes: {
        [`GET ${API_ROUTES.inbox.availability}`]: () =>
          json({ availability: { available: true, excluded: false, mode: 'round_robin' } }),
        [`PUT ${API_ROUTES.inbox.availability}`]: (request) => {
          body = request.body;
          return json({ availability: { available: false, excluded: false, mode: 'round_robin' } });
        },
      },
    });
    const toggle = await screen.findByRole('switch', {
      name: `${w.availabilityLabel}: ${w.availabilityOn}`,
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(() => expect(body).toEqual({ available: false }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(toggle).toHaveAccessibleName(`${w.availabilityLabel}: ${w.availabilityOff}`);
  });

  it('Owner (bawaan dikecualikan): saklar nonaktif, namanya tetap "Tersedia untuk chat baru"', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox', {
      routes: {
        [`GET ${API_ROUTES.inbox.availability}`]: () =>
          json({ availability: { available: true, excluded: true, mode: 'round_robin' } }),
      },
    });
    const toggle = await screen.findByRole('switch', {
      name: `${w.availabilityLabel}: ${w.availabilityExcludedShort}`,
    });
    expect(toggle).toHaveAttribute('title', w.availabilityExcluded);
    expect(toggle).toBeDisabled();
  });

  it('Teknisi (409) tidak melihat saklar', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox', {
      session: fakeSession('teknisi'),
      routes: {
        [`GET ${API_ROUTES.inbox.availability}`]: () =>
          apiError(409, 'CONFLICT', 'Peran ini tidak ikut alokasi.'),
      },
    });
    await screen.findByRole('heading', { level: 1, name: t.inbox.title });
    expect(screen.queryByRole('switch', { name: new RegExp(w.availabilityLabel) })).toBeNull();
  });
});

describe('log percakapan', () => {
  it('penugasan tanpa pelaku = otomatis (round-robin)', async () => {
    const conversation = fakeConversation();
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${conversation.id}`, {
      inbox: {
        conversations: [conversation],
        events: {
          [conversation.id]: [
            fakeEvent({
              kind: 'assigned',
              actor: null,
              assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0a02', name: 'Agus' },
            }),
          ],
        },
      },
    });
    fireEvent.mouseDown(await screen.findByRole('tab', { name: t.inbox.panel.tabs.log }));
    fireEvent.click(screen.getByRole('tab', { name: t.inbox.panel.tabs.log }));
    expect(await screen.findByText(t.inbox.panel.automatic)).toBeVisible();
  });
});
