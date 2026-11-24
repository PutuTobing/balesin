import { API_ROUTES, apiPath, type EmailSenderSettings } from '@balesin/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const s = t.sendingLimits;
const ID = 'chn_6b1f2c3d-0000-4000-8000-000000000001';
const BLOCKED_ID = 'chn_6b1f2c3d-0000-4000-8000-000000000002';

const billing: EmailSenderSettings = {
  id: ID,
  kind: 'channel',
  name: 'Billing',
  address: 'billing@perusahaan.example',
  smtpMode: 'custom',
  hourlyLimit: 100,
  sentLastHour: 84,
  queued: 3,
  state: 'ok',
  throttledUntil: null,
  blockedReason: null,
  pausedBy: null,
  pausedAt: null,
};
const blocked: EmailSenderSettings = {
  ...billing,
  id: BLOCKED_ID,
  name: 'CS',
  address: 'cs@perusahaan.example',
  state: 'blocked',
  blockedReason: 'smtp_auth_failed',
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.sendingLimits.settings}`]: () =>
      json({
        limits: {
          dailyPerUser: 500,
          dailyPerOrganization: 5000,
          perConversationPerMinute: 20,
          paused: null,
          sentLast24Hours: 120,
        },
      }),
    [`GET ${API_ROUTES.emailSenders.list}`]: () => json({ senders: [billing, blocked] }),
    [`PUT ${apiPath(API_ROUTES.emailSenders.sender, { senderId: ID })}`]: ({ body }) =>
      json({ sender: { ...billing, ...(body as { hourlyLimit: number }) } }),
    [`POST ${apiPath(API_ROUTES.emailSenders.pause, { senderId: ID })}`]: () =>
      json({ sender: { ...billing, state: 'paused', pausedAt: '2026-11-22T03:00:00.000Z' } }),
    [`POST ${apiPath(API_ROUTES.emailSenders.resume, { senderId: BLOCKED_ID })}`]: () =>
      json({ sender: { ...blocked, state: 'ok', blockedReason: null } }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

async function senderRow(name: string) {
  const list = await screen.findByRole('list', { name: s.emailListLabel });
  const item = within(list)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(name, { exact: true }));
  if (!item) throw new Error(`Baris ${name} tidak ada`);
  return within(item);
}

describe('Pengaturan → Batas kirim → Email per pengirim', () => {
  it('status terblokir dengan penjelasan + tautan channel; menurunkan batas tanpa konfirmasi', async () => {
    const { api } = await renderApp('/pengaturan/batas-kirim', { routes: routes() });
    const cs = await senderRow('CS');
    expect(cs.getByText(s.emailState.blocked)).toBeVisible();
    expect(cs.getByText(/Username atau password SMTP ditolak/)).toBeVisible();
    expect(cs.getByRole('link', { name: s.emailOpenChannel })).toHaveAttribute(
      'href',
      '/pengaturan/channel/lain/6b1f2c3d-0000-4000-8000-000000000002',
    );

    const row = await senderRow('Billing');
    expect(row.getByText(s.emailUsage(84, 100))).toBeVisible();
    expect(row.getByText(s.emailQueued(3), { exact: false })).toBeVisible();
    fireEvent.change(row.getByLabelText(s.emailLimitLabel), { target: { value: '60' } });
    fireEvent.click(row.getByRole('button', { name: s.emailLimitSaveFor('Billing') }));
    expect(await row.findByText(s.emailLimitSaved('Billing'))).toBeVisible();
    expect(
      requestsTo(api, 'PUT', apiPath(API_ROUTES.emailSenders.sender, { senderId: ID }))[0]?.body,
    ).toEqual({ hourlyLimit: 60 });
  });

  it('menaikkan batas wajib konfirmasi identitas', async () => {
    const { api } = await renderApp('/pengaturan/batas-kirim', { routes: routes() });
    const row = await senderRow('Billing');
    fireEvent.change(row.getByLabelText(s.emailLimitLabel), { target: { value: '1.000' } });
    fireEvent.click(row.getByRole('button', { name: s.emailLimitSaveFor('Billing') }));
    await confirmIdentity(s.emailRaiseTitle, s.emailLimitSave);
    expect(await row.findByText(s.emailLimitSaved('Billing'))).toBeVisible();
    expect(
      requestsTo(api, 'PUT', apiPath(API_ROUTES.emailSenders.sender, { senderId: ID }))[0]?.body,
    ).toEqual({ hourlyLimit: 1000, confirmation: { password: TEST_PASSWORD, code: TEST_CODE } });
  });

  it('jeda tanpa konfirmasi; lanjutkan terblokir dengan konfirmasi', async () => {
    const { api } = await renderApp('/pengaturan/batas-kirim', { routes: routes() });
    const row = await senderRow('Billing');
    fireEvent.click(row.getByRole('button', { name: s.emailPauseFor('Billing') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: s.emailPauseTitle('Billing') }),
    );
    fireEvent.click(dialog.getByRole('button', { name: s.emailPauseConfirm }));
    expect(await screen.findByText(s.emailPausedDone('Billing'))).toBeVisible();
    expect(
      requestsTo(api, 'POST', apiPath(API_ROUTES.emailSenders.pause, { senderId: ID }))[0]?.body,
    ).toEqual({});

    const cs = await senderRow('CS');
    fireEvent.click(cs.getByRole('button', { name: s.emailResumeFor('CS') }));
    await confirmIdentity(s.emailResumeTitle('CS'), s.emailResume);
    expect(await screen.findByText(s.emailResumed('CS'))).toBeVisible();
  });

  it('belum ada pengirim → ajakan ke Channel', async () => {
    await renderApp('/pengaturan/batas-kirim', {
      routes: routes({ [`GET ${API_ROUTES.emailSenders.list}`]: () => json({ senders: [] }) }),
      session: fakeSession('admin'),
    });
    expect(await screen.findByText(s.emailEmptyTitle)).toBeVisible();
    expect(screen.getByRole('link', { name: s.emailEmptyAction })).toHaveAttribute(
      'href',
      '/pengaturan/channel',
    );
  });
});
