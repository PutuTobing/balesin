import { API_ROUTES, apiPath } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { fakeChannel, json, type FakeHandler } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { botFormFrom, botSettingsFrom } from './bot-form';

const b = t.channels.bot;
const channel = fakeChannel();
const path = `/pengaturan/channel/${channel.id}`;
const at = (route: string) => apiPath(route, { channelId: channel.id });

function routes(settings: Record<string, unknown>, extra: Record<string, FakeHandler> = {}) {
  return {
    [`GET ${at(API_ROUTES.channels.channel)}`]: () => json({ channel }),
    [`GET ${at(API_ROUTES.channels.bot)}`]: () =>
      json({
        settings: {
          enabled: false,
          hours: { mode: 'always' },
          timeoutMinutes: null,
          timezone: 'Asia/Jakarta',
          activeNow: false,
          updatedAt: null,
          ...settings,
        },
      }),
    [`PUT ${at(API_ROUTES.channels.bot)}`]: ({ body }) =>
      json({
        settings: {
          ...(body as object),
          timezone: 'Asia/Jakarta',
          activeNow: true,
          updatedAt: '2026-11-17T03:00:00.000Z',
        },
      }),
    ...extra,
  } satisfies Record<string, FakeHandler>;
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  route: string,
) => api.requests.filter((request) => request.method === method && request.path === at(route));

describe('isian bot', () => {
  it('24:00 ditampilkan 23:59 dan dikembalikan; bot aktif selalu punya batas waktu', () => {
    const form = botFormFrom({
      enabled: true,
      hours: { mode: 'schedule', windows: [{ day: 1, start: '08:00', end: '24:00' }] },
      timeoutMinutes: null,
    });
    expect(form.days.find((day) => day.day === 1)).toMatchObject({ on: true, end: '23:59' });
    expect(form.timeout).toBe('15');
    expect(botSettingsFrom(form).settings).toEqual({
      enabled: true,
      hours: { mode: 'schedule', windows: [{ day: 1, start: '08:00', end: '24:00' }] },
      timeoutMinutes: 15,
    });
    expect(botSettingsFrom({ ...form, timeout: '0' }).timeoutInvalid).toBe(true);
    expect(botSettingsFrom({ ...form, timeout: '1441' }).timeoutInvalid).toBe(true);
  });
});

describe('kartu Bot di halaman nomor', () => {
  it('aktifkan dengan jadwal hari kerja + batas waktu → PUT; status "Memegang chat baru"', async () => {
    const { api } = await renderApp(path, { routes: routes({}) });
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: b.title })).closest('section')!,
    );
    expect(card.getByText(b.statusOff)).toBeVisible();
    fireEvent.click(card.getByRole('checkbox', { name: b.enable }));
    // Tidak ada pilihan "tanpa batas waktu": isian menit selalu ada.
    expect(card.getByLabelText(b.timeoutLabel)).toHaveValue('15');
    fireEvent.click(card.getByRole('radio', { name: b.schedule }));
    fireEvent.change(card.getByLabelText(b.timeoutLabel), { target: { value: '20' } });
    fireEvent.click(card.getByRole('button', { name: b.save }));
    expect(await card.findByText(b.saved)).toBeVisible();
    const body = requestsTo(api, 'PUT', API_ROUTES.channels.bot)[0]?.body as {
      enabled: boolean;
      hours: { mode: string; windows: { day: number }[] };
      timeoutMinutes: number;
    };
    expect(body.enabled).toBe(true);
    expect(body.timeoutMinutes).toBe(20);
    expect(body.hours.mode).toBe('schedule');
    expect(body.hours.windows.map((window) => window.day)).toEqual([1, 2, 3, 4, 5]);
    expect(await card.findByText(b.statusOn)).toBeVisible();
  });

  it('batas waktu di luar 1–1.440 ditolak di klien', async () => {
    const { api } = await renderApp(path, { routes: routes({}) });
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: b.title })).closest('section')!,
    );
    fireEvent.click(card.getByRole('checkbox', { name: b.enable }));
    fireEvent.change(card.getByLabelText(b.timeoutLabel), { target: { value: '0' } });
    fireEvent.click(card.getByRole('button', { name: b.save }));
    expect(await card.findByText(b.timeoutInvalid)).toBeVisible();
    expect(requestsTo(api, 'PUT', API_ROUTES.channels.bot)).toHaveLength(0);
  });

  it('mematikan bot meminta persetujuan (chat bot pindah ke antrian)', async () => {
    const { api } = await renderApp(path, {
      routes: routes({ enabled: true, timeoutMinutes: 10, activeNow: true }),
    });
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: b.title })).closest('section')!,
    );
    fireEvent.click(await card.findByRole('checkbox', { name: b.enable }));
    fireEvent.click(card.getByRole('button', { name: b.save }));
    const dialog = within(await screen.findByRole('dialog', { name: b.disableTitle }));
    expect(requestsTo(api, 'PUT', API_ROUTES.channels.bot)).toHaveLength(0);
    fireEvent.click(dialog.getByRole('button', { name: b.disableConfirm }));
    await waitFor(() =>
      expect(requestsTo(api, 'PUT', API_ROUTES.channels.bot)[0]?.body).toMatchObject({
        enabled: false,
      }),
    );
  });
});
