import { API_ROUTES, apiPath } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { fakeSession, fakeTeamUser, json } from '../../test/fake-api';
import { AGUS, fakeDepartment } from '../../test/fake-crm';
import { fakeChannelSummary, fakeConversation } from '../../test/fake-inbox';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { isLoosening } from './department-access';
import { hoursFormFrom, hoursSummary, teamHoursFrom } from './team-hours';

const d = t.departments;
const R = API_ROUTES.departments;
const DEPARTMENT = fakeDepartment();

describe('logika departemen', () => {
  it('melonggarkan = cabut tanda atau tambah departemen saat bertanda', () => {
    const before = { departmentIds: ['a'], restricted: true };
    expect(isLoosening(before, { departmentIds: ['a'], restricted: false })).toBe(true);
    expect(isLoosening(before, { departmentIds: ['a', 'b'], restricted: true })).toBe(true);
    expect(isLoosening(before, { departmentIds: [], restricted: true })).toBe(false);
    expect(isLoosening({ departmentIds: [], restricted: false }, before)).toBe(false);
  });

  it('jam kerja tim: ikut organisasi, jadwal, galat', () => {
    expect(teamHoursFrom(hoursFormFrom(null))).toEqual({ ok: true, hours: null });
    const custom = { ...hoursFormFrom(null), custom: true };
    const built = teamHoursFrom(custom);
    expect(built.ok && built.hours?.mode === 'schedule' ? built.hours.windows.length : 0).toBe(5);
    const none = { custom: true, days: custom.days.map((day) => ({ ...day, on: false })) };
    expect(teamHoursFrom(none)).toEqual({ ok: false, error: d.noDay });
    expect(
      hoursSummary({ mode: 'schedule', windows: [{ day: 1, start: '08:00', end: '17:00' }] }),
    ).toBe(d.hoursSummary('Sen 08.00–17.00'));
    expect(
      hoursSummary({
        mode: 'schedule',
        windows: [
          ...[1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '20:00' })),
          { day: 6, start: '08:00', end: '14:00' },
        ],
      }),
    ).toBe(d.hoursSummary('Sen–Jum 08.00–20.00, Sab 08.00–14.00'));
  });
});

describe('Pengaturan → Departemen', () => {
  it('daftar + tambah departemen dengan channel bawaan', async () => {
    let created: unknown = null;
    const channel = fakeChannelSummary();
    const { api } = await renderApp('/pengaturan/departemen', {
      inbox: { channels: [channel] },
      routes: {
        [`GET ${R.settings}`]: () => json({ departments: [DEPARTMENT] }),
        [`POST ${R.settings}`]: (request) => {
          created = request.body;
          return json({ department: fakeDepartment({ name: 'CS' }) }, { status: 201 });
        },
      },
    });
    const list = within(await screen.findByRole('list', { name: d.listLabel }));
    expect(list.getByRole('heading', { name: 'Teknisi' })).toBeVisible();
    expect(list.getByText(d.restrictedBadge)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: d.add }));
    const dialog = await screen.findByRole('dialog', { name: d.createTitle });
    fireEvent.change(within(dialog).getByLabelText(d.name), { target: { value: 'CS' } });
    fireEvent.click(within(dialog).getByLabelText(channel.name));
    fireEvent.click(within(dialog).getByRole('button', { name: d.save }));
    await waitFor(() =>
      expect(created).toEqual({ name: 'CS', description: null, defaultChannelIds: [channel.id] }),
    );
    expect(api.requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(await screen.findByText(d.saved)).toBeVisible();
  });
});

describe('akses departemen pengguna', () => {
  const user = fakeTeamUser({ id: AGUS.id, name: AGUS.name, role: 'cs' });
  const routes = (handlers: Record<string, (request: { body: unknown }) => Response>) => ({
    routes: {
      [`GET ${apiPath(API_ROUTES.team.user, { userId: AGUS.id })}`]: () => json({ user }),
      [`GET ${R.list}`]: () =>
        json({
          departments: [
            { id: DEPARTMENT.id, name: 'Teknisi', description: null, memberCount: 1 },
            {
              id: '7e000000-0000-4000-8000-0000000000d2',
              name: 'CS',
              description: null,
              memberCount: 0,
            },
          ],
        }),
      [`GET ${apiPath(R.access, { userId: AGUS.id })}`]: () =>
        json({ access: { userId: AGUS.id, departmentIds: [DEPARTMENT.id], restricted: true } }),
      ...handlers,
    },
  });

  it('mencabut tanda = melonggarkan → konfirmasi identitas', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      `/pengaturan/tim/${AGUS.id}`,
      routes({
        [`PUT ${apiPath(R.access, { userId: AGUS.id })}`]: (request) => {
          bodies.push(request.body);
          return json({
            access: { userId: AGUS.id, departmentIds: [DEPARTMENT.id], restricted: false },
          });
        },
      }),
    );
    fireEvent.click(await screen.findByLabelText(d.restrictedLabel));
    fireEvent.click(screen.getByRole('button', { name: d.accessSave }));
    await confirmIdentity(d.loosenTitle, d.loosenConfirm);
    expect(await screen.findByText(d.accessSaved)).toBeVisible();
    expect(bodies).toEqual([
      {
        departmentIds: [DEPARTMENT.id],
        restricted: false,
        confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
      },
    ]);
  });

  it('menyempitkan tersimpan tanpa konfirmasi', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      `/pengaturan/tim/${AGUS.id}`,
      routes({
        [`PUT ${apiPath(R.access, { userId: AGUS.id })}`]: (request) => {
          bodies.push(request.body);
          return json({ access: { userId: AGUS.id, departmentIds: [], restricted: true } });
        },
      }),
    );
    fireEvent.click(await screen.findByLabelText('Teknisi'));
    fireEvent.click(screen.getByRole('button', { name: d.accessSave }));
    expect(await screen.findByText(d.accessSaved)).toBeVisible();
    expect(bodies).toEqual([{ departmentIds: [], restricted: true }]);
  });
});

describe('inbox: departemen', () => {
  const conversation = fakeConversation();
  const inbox = {
    conversations: [conversation],
    channels: [fakeChannelSummary()],
    agents: [
      { id: AGUS.id, name: AGUS.name, role: 'cs' as const, active: true, openConversations: 1 },
    ],
  };

  it('pindah departemen dari menu chat', async () => {
    let body: unknown = null;
    await renderApp(`/inbox?chat=${conversation.id}`, {
      session: fakeSession('owner'),
      inbox,
      routes: {
        [`GET ${R.list}`]: () =>
          json({
            departments: [
              { id: DEPARTMENT.id, name: 'Teknisi', description: null, memberCount: 1 },
            ],
          }),
        [`POST ${apiPath(API_ROUTES.inbox.department, { conversationId: conversation.id })}`]: (
          request,
        ) => {
          body = request.body;
          return json({
            conversation: { ...conversation, department: { id: DEPARTMENT.id, name: 'Teknisi' } },
          });
        },
      },
    });
    const chat = await screen.findByRole('region', { name: /chat/i }).catch(() => document.body);
    fireEvent.keyDown(within(chat).getByRole('button', { name: t.inbox.handling.menu }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: d.move }));
    const dialog = await screen.findByRole('dialog', { name: d.moveTitle });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Teknisi/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: d.moveConfirm }));
    await waitFor(() => expect(body).toEqual({ departmentId: DEPARTMENT.id }));
  });
});
