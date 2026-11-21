import { API_ROUTES, type SendingLimits } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { parseLimit } from './parse-limit';

const copy = t.sendingLimits;
const PATH = '/pengaturan/batas-kirim';

const running: SendingLimits = {
  dailyPerUser: 500,
  dailyPerOrganization: 5000,
  perConversationPerMinute: 20,
  paused: null,
  sentLast24Hours: 4200,
};
const pausedLimits: SendingLimits = {
  ...running,
  paused: {
    at: '2026-11-16T03:00:00.000Z',
    by: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
    reason: 'Ada kiriman massal tanpa sengaja',
  },
};

function routes(
  limits: SendingLimits,
  extra: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.sendingLimits.settings}`]: () => json({ limits }),
    [`PUT ${API_ROUTES.sendingLimits.settings}`]: ({ body }) =>
      json({ limits: { ...limits, ...(body as Partial<SendingLimits>) } }),
    [`POST ${API_ROUTES.sendingLimits.pause}`]: ({ body }) =>
      json({
        limits: {
          ...limits,
          paused: {
            at: '2026-11-16T04:00:00.000Z',
            by: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
            reason: (body as { reason?: string }).reason ?? null,
          },
        },
      }),
    [`POST ${API_ROUTES.sendingLimits.resume}`]: () =>
      json({ limits: { ...limits, paused: null } }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

describe('isian batas', () => {
  it('menerima pemisah ribuan, menolak selain angka', () => {
    expect(parseLimit('5.000')).toBe(5000);
    expect(parseLimit(' 20 ')).toBe(20);
    expect(parseLimit('1e3')).toBeNaN();
    expect(parseLimit('-1')).toBeNaN();
    expect(parseLimit('')).toBeNaN();
  });
});

describe('Pengaturan → Batas kirim', () => {
  it('pemakaian 24 jam + meter; ubah batas lewat konfirmasi identitas', async () => {
    const { api } = await renderApp(PATH, { routes: routes(running) });
    expect(await screen.findByText(copy.usage(4200, 5000))).toBeVisible();
    expect(screen.getByRole('meter', { name: copy.usageLabel })).toHaveAttribute(
      'data-tone',
      'warning',
    );

    const perUser = screen.getByLabelText(copy.dailyPerUser);
    fireEvent.change(perUser, { target: { value: 'banyak' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(await screen.findByText(/harus angka/)).toBeVisible();

    fireEvent.change(perUser, { target: { value: '1.000' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await confirmIdentity(copy.confirmTitle, copy.save);
    expect(await screen.findByText(copy.saved)).toBeVisible();
    expect(requestsTo(api, 'PUT', API_ROUTES.sendingLimits.settings)[0]?.body).toEqual({
      dailyPerOrganization: 5000,
      dailyPerUser: 1000,
      perConversationPerMinute: 20,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('tanpa perubahan: tidak meminta konfirmasi', async () => {
    const { api } = await renderApp(PATH, { routes: routes(running) });
    fireEvent.click(await screen.findByRole('button', { name: copy.save }));
    expect(await screen.findByText(copy.unchanged)).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsTo(api, 'PUT', API_ROUTES.sendingLimits.settings)).toHaveLength(0);
  });

  it('tarik rem: dialog jelas dengan alasan, TANPA konfirmasi identitas', async () => {
    const { api } = await renderApp(PATH, { routes: routes(running) });
    fireEvent.click(await screen.findByRole('button', { name: copy.pause }));
    const dialog = within(await screen.findByRole('dialog', { name: copy.pauseTitle }));
    expect(dialog.getByText(copy.pauseBody)).toBeVisible();
    fireEvent.change(dialog.getByLabelText(copy.reasonLabel), {
      target: { value: 'Ada kiriman massal' },
    });
    fireEvent.click(dialog.getByRole('button', { name: copy.pauseConfirm }));
    expect(await screen.findByText(copy.paused)).toBeVisible();
    expect(requestsTo(api, 'POST', API_ROUTES.sendingLimits.pause)[0]?.body).toEqual({
      reason: 'Ada kiriman massal',
    });
    expect(screen.getByText(copy.pausedTitle)).toBeVisible();
    expect(screen.getByRole('button', { name: copy.resume })).toBeVisible();
  });

  it('rem ditarik: pelaku, alasan; lanjutkan dengan konfirmasi identitas', async () => {
    const { api } = await renderApp(PATH, { routes: routes(pausedLimits) });
    expect(await screen.findByText(copy.pausedTitle)).toBeVisible();
    expect(screen.getByText(/Rem ditarik oleh Rina Kartika/)).toBeVisible();
    expect(screen.getByText(copy.pausedReason('Ada kiriman massal tanpa sengaja'))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: copy.resume }));
    await confirmIdentity(copy.resumeTitle, copy.resume);
    expect(await screen.findByText(copy.resumed)).toBeVisible();
    expect(requestsTo(api, 'POST', API_ROUTES.sendingLimits.resume)[0]?.body).toEqual({
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    expect(screen.getByText(copy.runningTitle)).toBeVisible();
  });

  it('gagal dimuat: pesan + coba lagi', async () => {
    await renderApp(PATH, {
      routes: {
        [`GET ${API_ROUTES.sendingLimits.settings}`]: () =>
          apiError(503, 'UNAVAILABLE', 'Server sedang bermasalah.'),
      },
    });
    expect(await screen.findByText(copy.loadFailedTitle)).toBeVisible();
  });

  it('Supervisor dan CS dialihkan dari halaman; menu Pengaturan hanya untuk Owner/Admin', async () => {
    const { router } = await renderApp(PATH, { session: fakeSession('supervisor') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(screen.queryByRole('link', { name: new RegExp(copy.title) })).toBeNull();
  });

  it('Owner melihat menu Batas kirim dengan status rem', async () => {
    await renderApp('/pengaturan', { routes: routes(pausedLimits) });
    const link = await screen.findByRole('link', { name: new RegExp(copy.title) });
    expect(await within(link).findByText(copy.menuPaused)).toBeVisible();
  });
});
