import { API_ROUTES, apiPath } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeActiveSession,
  fakeSession,
  fakeTwoFactorStatus,
  json,
  type FakeHandler,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const copy = t.security.sessions;
const CURRENT = fakeActiveSession();
const PHONE = fakeActiveSession({
  id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c09',
  device: 'Safari di iOS',
  ipAddress: null,
  current: false,
});

async function openSecurity(role: 'owner' | 'cs', routes: Record<string, FakeHandler> = {}) {
  const view = await renderApp('/pengaturan/keamanan', {
    session: fakeSession(role),
    twoFactorStatus: fakeTwoFactorStatus(role),
    sessions: { sessions: [CURRENT, PHONE] },
    routes,
  });
  await screen.findByRole('heading', { level: 1, name: t.security.title });
  return { view, card: () => screen.getByRole('region', { name: copy.title }) };
}

describe('Keamanan akun → Sesi aktif', () => {
  it('"Sesi ini" ditandai tanpa tombol keluarkan; sesi lain punya tombolnya; IP tak tercatat dijelaskan', async () => {
    const { card } = await openSecurity('owner');
    const rows = within(card()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(t.sessions.current)).toBeVisible();
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(within(rows[1]!).getByText(t.sessions.unknownIp, { exact: false })).toBeVisible();
    expect(
      within(rows[1]!).getByRole('button', { name: t.sessions.revokeLabel('Safari di iOS') }),
    ).toBeVisible();
  });

  it('keluarkan satu sesi lain tanpa konfirmasi identitas; fokus ke judul kartu', async () => {
    const { card } = await openSecurity('owner', {
      [`DELETE ${apiPath(API_ROUTES.sessions.revoke, { sessionId: PHONE.id })}`]: () =>
        json({ status: 'revoked' }),
    });
    fireEvent.click(screen.getByRole('button', { name: t.sessions.revokeLabel('Safari di iOS') }));
    expect(await screen.findByText(t.sessions.revoked('Safari di iOS'))).toBeVisible();
    expect(within(card()).getAllByRole('listitem')).toHaveLength(1);
    expect(within(card()).getByText(copy.onlyThis)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: copy.title })).toHaveFocus(),
    );
  });

  it('keluarkan semua sesi lain (Owner): wajib password + kode; hanya sesi ini yang tersisa', async () => {
    const { view, card } = await openSecurity('owner', {
      [`POST ${API_ROUTES.sessions.revokeOthers}`]: () => json({ revokedSessions: 1 }),
    });
    fireEvent.click(within(card()).getByRole('button', { name: copy.revokeOthers }));
    const dialog = await screen.findByRole('dialog', { name: copy.revokeOthersTitle });
    fireEvent.change(within(dialog).getByLabelText(t.identity.password), {
      target: { value: 'Kopi-Senja-Tenang-42' },
    });
    fireEvent.change(within(dialog).getByLabelText(t.identity.code), {
      target: { value: 'k7m2p-x9q4r' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.revokeOthersConfirm }));
    expect(await screen.findByText(copy.revokedOthers(1))).toBeVisible();
    const post = view.api.requests.find(
      (request) => request.path === API_ROUTES.sessions.revokeOthers,
    );
    // Kode cadangan dinormalkan skema bersama sebelum dikirim.
    expect(post?.body).toMatchObject({ password: 'Kopi-Senja-Tenang-42' });
    expect((post?.body as { code?: string }).code).toMatch(/^k7m2p-?x9q4r$/i);
  });

  it('CS tanpa 2FA: konfirmasi cukup password (isian kode tidak ditampilkan)', async () => {
    const { view, card } = await openSecurity('cs', {
      [`POST ${API_ROUTES.sessions.revokeOthers}`]: () => json({ revokedSessions: 1 }),
    });
    fireEvent.click(within(card()).getByRole('button', { name: copy.revokeOthers }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(t.identity.code)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(t.identity.password), {
      target: { value: 'Teh-Manis-Hangat-77' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.revokeOthersConfirm }));
    await screen.findByText(copy.revokedOthers(1));
    const post = view.api.requests.find(
      (request) => request.path === API_ROUTES.sessions.revokeOthers,
    );
    expect(post?.body).toEqual({ password: 'Teh-Manis-Hangat-77' });
  });

  it('daftar sesi gagal dimuat: kartu lain tetap tampil, kartu sesi menawarkan coba lagi', async () => {
    let fail = true;
    await openSecurity('owner', {
      [`GET ${API_ROUTES.sessions.list}`]: () =>
        fail
          ? apiError(503, 'SERVICE_UNAVAILABLE', 'Server sedang sibuk.')
          : json({ sessions: [CURRENT] }),
    });
    const card = screen.getByRole('region', { name: copy.title });
    expect(await within(card).findByText(copy.loadFailedTitle)).toBeVisible();
    expect(screen.getByRole('region', { name: t.security.twoFactor.title })).toBeVisible();
    fail = false;
    fireEvent.click(within(card).getByRole('button', { name: t.common.retry }));
    expect(await within(card).findByText(copy.onlyThis)).toBeVisible();
  });

  it('sesi yang lebih baru dari sesi ini: keluarkan lewat konfirmasi identitas (body password + kode)', async () => {
    const newer = { ...PHONE, confirmationRequired: true };
    const { view } = await renderAppWithSessions([CURRENT, newer], {
      [`DELETE ${apiPath(API_ROUTES.sessions.revoke, { sessionId: PHONE.id })}`]: () =>
        json({ status: 'revoked' }),
    });
    fireEvent.click(screen.getByRole('button', { name: t.sessions.revokeLabel('Safari di iOS') }));
    const dialog = await screen.findByRole('dialog', {
      name: copy.revokeNewerTitle('Safari di iOS'),
    });
    expect(view.api.requests.some((request) => request.method === 'DELETE')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(t.identity.password), {
      target: { value: 'Kopi-Senja-Tenang-42' },
    });
    fireEvent.change(within(dialog).getByLabelText(t.identity.code), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.revokeNewerConfirm }));
    expect(await screen.findByText(t.sessions.revoked('Safari di iOS'))).toBeVisible();
    const deleted = view.api.requests.find((request) => request.method === 'DELETE');
    expect(deleted?.body).toEqual({ password: 'Kopi-Senja-Tenang-42', code: '123456' });
  });
});

async function renderAppWithSessions(
  sessions: (typeof CURRENT)[],
  routes: Record<string, FakeHandler>,
) {
  const view = await renderApp('/pengaturan/keamanan', {
    session: fakeSession('owner'),
    twoFactorStatus: fakeTwoFactorStatus('owner'),
    sessions: { sessions },
    routes,
  });
  await screen.findByRole('heading', { level: 1, name: t.security.title });
  return { view };
}
