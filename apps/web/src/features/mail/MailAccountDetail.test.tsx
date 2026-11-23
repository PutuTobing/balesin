import { API_ROUTES, apiPath, type TeamMailAccessResponse } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { fakeTeamUser, json, type FakeHandler } from '../../test/fake-api';
import { MAIL_IDS, fakeMailAccount, fakeTestResult } from '../../test/fake-mail';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const m = t.mail;
const d = t.mail.detail;
const a = t.mail.access;
const w = t.mail.wizard;
const tm = t.mail.team;

const account = fakeMailAccount();
const accountPath = apiPath(API_ROUTES.mail.account, { accountId: MAIL_IDS.cs });
const accessPath = apiPath(API_ROUTES.mail.accountAccess, { accountId: MAIL_IDS.cs });
const AGUS = { id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b04', name: 'Agus Pratama' };

const access = {
  implicit: [
    { role: 'owner', level: 'manage' },
    { role: 'admin', level: 'manage' },
  ],
  grants: [
    {
      principal: { type: 'user', id: AGUS.id, name: AGUS.name, role: 'cs', active: true },
      level: 'send',
      grantedBy: null,
      grantedAt: '2026-11-22T01:00:00.000Z',
    },
  ],
  editable: true,
};

function routes(extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${accountPath}`]: () => json({ account }),
      [`GET ${accessPath}`]: () => json(access),
      [`GET ${API_ROUTES.team.users}`]: () =>
        json({
          users: [
            fakeTeamUser({ id: AGUS.id, name: AGUS.name, role: 'cs' }),
            fakeTeamUser({
              id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b03',
              name: 'Citra Pratiwi',
              role: 'supervisor',
            }),
          ],
          manageableRoles: ['admin', 'supervisor', 'cs', 'teknisi'],
        }),
      ...extra,
    },
  };
}

describe('Pengaturan → Akun email → satu akun', () => {
  it('ringkasan, server (password tersamar), akses akun bersama', async () => {
    await renderApp(`/pengaturan/akun-email/${MAIL_IDS.cs}`, routes());
    expect(await screen.findByRole('heading', { level: 1, name: 'CS Maju Jaya' })).toBeVisible();
    expect(screen.getByText(d.lastSynced)).toBeVisible();
    expect(screen.getByText('812 MB / 2 GB')).toBeVisible();
    // Server: host + password tersamar, tidak pernah password utuh.
    expect(screen.getAllByText('mail.majujaya.co.id')).toHaveLength(2);
    expect(screen.getByText(d.passwordSaved('••••a1b2'))).toBeVisible();
    // Akses: Owner/Admin otomatis + Agus.
    expect(await screen.findByText(a.implicit)).toBeVisible();
    expect(screen.getByLabelText(a.levelFor(AGUS.name))).toHaveValue('send');
  });

  it('akses: menurunkan hak tanpa konfirmasi; menambah orang wajib konfirmasi identitas', async () => {
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes({ [`PUT ${accessPath}`]: () => json(access) }),
    );
    const level = await screen.findByLabelText(a.levelFor(AGUS.name));
    fireEvent.change(level, { target: { value: 'read' } });
    fireEvent.click(screen.getByRole('button', { name: a.save }));
    await waitFor(() =>
      expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(1),
    );
    expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
      grants: [{ principalType: 'user', userId: AGUS.id, level: 'read' }],
    });

    fireEvent.click(await screen.findByRole('button', { name: a.add }));
    fireEvent.click(await screen.findByRole('button', { name: a.addPrincipal('Citra Pratiwi') }));
    fireEvent.click(screen.getByRole('button', { name: a.save }));
    await confirmIdentity(a.confirmTitle, a.save);
    await waitFor(() =>
      expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(2),
    );
    expect(api.requests.filter((request) => request.method === 'PUT')[1]?.body).toMatchObject({
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('tampilan & sinkron: hanya isian yang berubah dikirim (tanpa konfirmasi)', async () => {
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes({
        [`PATCH ${accountPath}`]: () =>
          json({ account: { ...account, displayName: 'CS Pusat', periodicSyncMinutes: 10 } }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(w.displayName), {
      target: { value: 'CS Pusat' },
    });
    fireEvent.change(screen.getByLabelText(d.interval), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: d.save }));
    expect(await screen.findByText(d.saved)).toBeVisible();
    expect(api.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      displayName: 'CS Pusat',
      periodicSyncMinutes: 10,
    });
  });

  it('ubah server: host berubah wajib isi ulang password; lalu konfirmasi identitas', async () => {
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes({ [`PATCH ${accountPath}`]: () => json({ account }) }),
    );
    fireEvent.click(await screen.findByRole('button', { name: d.editServer }));
    const dialog = within(await screen.findByRole('dialog', { name: d.editServerTitle }));
    const [imapHost] = dialog.getAllByLabelText(w.host);
    if (!imapHost) throw new Error('isian host tidak ada');
    fireEvent.change(imapHost, { target: { value: 'imap.majujaya.co.id' } });
    fireEvent.click(dialog.getByRole('button', { name: d.save }));
    expect(await dialog.findByText(w.passwordRefill)).toBeVisible();

    fireEvent.change(dialog.getByLabelText(w.password), { target: { value: 'Sandi-Baru-123' } });
    fireEvent.click(dialog.getByRole('button', { name: d.save }));
    await confirmIdentity(d.serverConfirmTitle, d.save);
    expect(await screen.findByText(d.serverSaved)).toBeVisible();
    expect(api.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
      imap: { host: 'imap.majujaya.co.id', password: 'Sandi-Baru-123' },
      smtp: { sameCredentials: true },
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('tes koneksi akun tersimpan menampilkan hasil per sisi', async () => {
    await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes({
        [`POST ${apiPath(API_ROUTES.mail.accountTest, { accountId: MAIL_IDS.cs })}`]: () =>
          json(fakeTestResult(false)),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: d.testNow }));
    expect(await screen.findByText(d.testDoneFailed)).toBeVisible();
    expect(screen.getByText(w.outgoingFailed)).toBeVisible();
  });

  it('password ditolak: Notice dengan tombol Perbarui password yang membuka dialog server', async () => {
    const failed = fakeMailAccount({
      sync: {
        ...account.sync,
        state: 'auth_failed',
        lastErrorCode: 'imap_auth_failed',
        lastErrorMessage: 'Username atau password akun email ditolak server.',
      },
    });
    await renderApp(`/pengaturan/akun-email/${MAIL_IDS.cs}`, {
      routes: { ...routes().routes, [`GET ${accountPath}`]: () => json({ account: failed }) },
    });
    // Judul Notice tidak sama dengan lencana; pesan server sekali saja, tanpa paragraf tambahan.
    expect(await screen.findByText(d.authFailedTitle)).toBeVisible();
    expect(screen.getAllByText('Username atau password akun email ditolak server.')).toHaveLength(1);
    expect(screen.queryByText(m.authFailedHint)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: d.fixPassword }));
    expect(await screen.findByRole('dialog', { name: d.editServerTitle })).toBeVisible();
  });

  it('?ubah=server (tautan dari daftar akun) langsung membuka dialog server', async () => {
    await renderApp(`/pengaturan/akun-email/${MAIL_IDS.cs}?ubah=server`, routes());
    const dialog = await screen.findByRole('dialog', { name: d.editServerTitle });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: t.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('');
  });

  it('akun pribadi orang lain / tidak ada → tidak ditemukan', async () => {
    await renderApp(`/pengaturan/akun-email/${MAIL_IDS.other}`);
    expect(await screen.findByRole('heading', { name: d.notFoundTitle })).toBeVisible();
    expect(screen.getByRole('link', { name: d.backToList })).toHaveAttribute(
      'href',
      '/pengaturan/akun-email',
    );
  });
});

describe('Pengaturan → Tim → pengguna → Akses email', () => {
  const user = fakeTeamUser({ id: AGUS.id, name: AGUS.name, role: 'cs' });
  const teamAccess: TeamMailAccessResponse = {
    user: { id: AGUS.id, name: AGUS.name, role: 'cs', active: true },
    menuVisible: true,
    canConnectPersonal: true,
    accounts: [
      {
        account: {
          id: MAIL_IDS.cs,
          displayName: 'CS Maju Jaya',
          emailAddress: 'cs@majujaya.co.id',
          color: 'tagBlue',
        },
        effectiveLevel: 'send',
        directLevel: null,
        sources: [
          {
            type: 'department',
            level: 'send',
            department: { id: '5d0e0000-0000-4000-8000-000000000001', name: 'Layanan Pelanggan' },
          },
        ],
      },
      {
        account: {
          id: MAIL_IDS.billing,
          displayName: 'Billing',
          emailAddress: 'billing@majujaya.co.id',
          color: 'tagTeal',
        },
        effectiveLevel: 'read',
        directLevel: 'read',
        sources: [{ type: 'user', level: 'read', department: null }],
      },
    ],
    personalAccounts: [
      { id: MAIL_IDS.personal, emailAddress: 'agus@surel.id', syncState: 'ready' },
    ],
  };
  const path = apiPath(API_ROUTES.mail.teamAccess, { userId: AGUS.id });

  it('sumber hak tampil; memberi akses baru = konfirmasi identitas, mencabut tidak', async () => {
    const { api } = await renderApp(`/pengaturan/tim/${AGUS.id}`, {
      routes: {
        [`GET ${apiPath(API_ROUTES.team.user, { userId: AGUS.id })}`]: () => json({ user }),
        [`GET ${path}`]: () => json(teamAccess),
        [`PUT ${path}`]: () => json(teamAccess),
      },
    });
    expect(await screen.findByRole('heading', { name: tm.title })).toBeVisible();
    expect(screen.getByText(tm.menuVisible)).toBeVisible();
    expect(
      screen.getByText(tm.viaDepartment('Layanan Pelanggan', m.levels.send ?? '')),
    ).toBeVisible();
    expect(screen.getByText('agus@surel.id')).toBeVisible();

    // Mencabut hak langsung Billing: tanpa konfirmasi.
    fireEvent.change(screen.getByLabelText(tm.levelFor('Billing')), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: tm.save }));
    await waitFor(() =>
      expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(1),
    );
    expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
      grants: [{ accountId: MAIL_IDS.billing, level: null }],
    });

    // Memberi hak langsung di CS: konfirmasi identitas.
    fireEvent.change(screen.getByLabelText(tm.levelFor('CS Maju Jaya')), {
      target: { value: 'manage' },
    });
    fireEvent.click(screen.getByRole('button', { name: tm.save }));
    await confirmIdentity(tm.confirmTitle, tm.save);
    await waitFor(() =>
      expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(2),
    );
    const second = api.requests.filter((request) => request.method === 'PUT')[1]?.body as {
      grants: { accountId: string; level: string | null }[];
      confirmation: unknown;
    };
    expect(second.grants).toContainEqual({ accountId: MAIL_IDS.cs, level: 'manage' });
    expect(second.confirmation).toEqual({ password: TEST_PASSWORD, code: TEST_CODE });
  });
});
