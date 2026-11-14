import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  apiPath,
  type InvitationIssuedResponse,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeInvitation,
  fakeInvitationList,
  fakeSession,
  json,
  type FakeApiOptions,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { defaultInviteRole, inviteRoleOptions } from './invite-roles';

const copy = t.team;
const LINK = 'http://localhost:5173/undangan#token=Q2FrU2t5LVRlcy1Ub2tlbi1Db250b2gtVHVqdWFuLTEyMz';

async function openTeam(role: 'owner' | 'admin' = 'owner', options: FakeApiOptions = {}) {
  const view = await renderApp('/pengaturan/tim', { session: fakeSession(role), ...options });
  await screen.findByRole('heading', { level: 1, name: copy.title });
  return view;
}

function roleOptions(): string[] {
  const select = screen.getByLabelText(copy.invite.role);
  return within(select)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

function issued(overrides: Partial<InvitationIssuedResponse> = {}): InvitationIssuedResponse {
  return {
    invitation: fakeInvitation({ email: 'citra@majujaya.co.id', deliveryStatus: 'link' }),
    link: LINK,
    ...overrides,
  };
}

function invite(email: string, roleLabel?: string) {
  fireEvent.change(screen.getByLabelText(copy.invite.email), { target: { value: email } });
  if (roleLabel) {
    const select = screen.getByLabelText<HTMLSelectElement>(copy.invite.role);
    const option = within(select).getByRole<HTMLOptionElement>('option', { name: roleLabel });
    fireEvent.change(select, { target: { value: option.value } });
  }
}

/** Seluruh isi cache Query sebagai teks (untuk memastikan tautan tidak pernah tersimpan). */
function cacheText(view: Awaited<ReturnType<typeof openTeam>>): string {
  return JSON.stringify([
    view.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
    view.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
  ]);
}

describe('matriks peran di form undangan', () => {
  it('Owner: Admin/Supervisor/CS/Teknisi; Admin: tanpa Admin; peran lain kosong; Owner tidak pernah ada', () => {
    const all = ['admin', 'supervisor', 'cs', 'teknisi'] as const;
    expect(inviteRoleOptions('owner', all)).toEqual(['admin', 'supervisor', 'cs', 'teknisi']);
    expect(inviteRoleOptions('admin', all)).toEqual(['supervisor', 'cs', 'teknisi']);
    expect(inviteRoleOptions('supervisor', all)).toEqual([]);
    expect(inviteRoleOptions('cs', all)).toEqual([]);
    expect(inviteRoleOptions('teknisi', all)).toEqual([]);
    // Server tetap penentu: peran yang tidak ditawarkan server tidak muncul walau matriks boleh.
    expect(inviteRoleOptions('owner', ['cs'])).toEqual(['cs']);
    // Matriks tetap berlaku walau server (keliru) menawarkan Admin ke Admin.
    expect(inviteRoleOptions('admin', all)).not.toContain('admin');
  });

  it('pilihan awal CS bila tersedia', () => {
    expect(defaultInviteRole(['admin', 'supervisor', 'cs', 'teknisi'])).toBe('cs');
    expect(defaultInviteRole(['supervisor'])).toBe('supervisor');
    expect(defaultInviteRole([])).toBe('');
  });
});

describe('Pengaturan → Tim', () => {
  it('Owner melihat semua peran yang boleh diundang; Admin tidak bisa memilih Admin', async () => {
    await openTeam('owner');
    expect(roleOptions()).toEqual(['Admin', 'Supervisor', 'CS', 'Teknisi']);
    expect(screen.getByLabelText(copy.invite.role)).toHaveValue('cs');
  });

  it('Admin: tanpa pilihan Admin; undangan Admin buatan Owner tampil tanpa tombol kelola', async () => {
    await openTeam('admin', {
      invitations: fakeInvitationList({
        invitableRoles: ['supervisor', 'cs', 'teknisi'],
        invitations: [
          fakeInvitation({
            id: '7d1c4f8e-2b3a-4c5d-8e9f-0a1b2c3d4e02',
            email: 'agus@majujaya.co.id',
            role: 'admin',
            canManage: false,
          }),
        ],
      }),
    });
    expect(roleOptions()).toEqual(['Supervisor', 'CS', 'Teknisi']);
    const row = screen.getByRole('listitem', { name: copy.list.actionsFor('agus@majujaya.co.id') });
    expect(within(row).getByText(copy.list.managedByOwner)).toBeVisible();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('CS dan Teknisi tidak melihat menu Tim dan dialihkan bila membuka alamatnya', async () => {
    const view = await renderApp('/pengaturan', { session: fakeSession('cs') });
    await screen.findByRole('heading', { level: 1, name: t.nav.settings });
    expect(screen.queryByRole('link', { name: new RegExp(copy.title) })).toBeNull();

    await act(() => view.router.navigate({ to: '/pengaturan/tim' }));
    expect(view.router.state.location.pathname).toBe('/pengaturan');
    expect(view.api.requests.some((r) => r.path === API_ROUTES.invitations.collection)).toBe(false);
  });

  it('Admin melihat menu Tim dan Email pengirim (izin team.invite dan settings.email.manage)', async () => {
    await renderApp('/pengaturan', { session: fakeSession('admin') });
    expect(await screen.findByRole('link', { name: new RegExp(copy.title) })).toHaveAttribute(
      'href',
      '/pengaturan/tim',
    );
    expect(screen.getByRole('link', { name: new RegExp(t.emailSettings.title) })).toHaveAttribute(
      'href',
      '/pengaturan/email',
    );
  });

  it('daftar menampilkan status pengiriman, kedaluwarsa, dan keadaan kosong', async () => {
    await openTeam('owner', {
      invitations: fakeInvitationList({
        invitations: [
          fakeInvitation({ email: 'a@majujaya.co.id', deliveryStatus: 'queued' }),
          fakeInvitation({
            id: '7d1c4f8e-2b3a-4c5d-8e9f-0a1b2c3d4e03',
            email: 'b@majujaya.co.id',
            deliveryStatus: 'failed',
          }),
          fakeInvitation({
            id: '7d1c4f8e-2b3a-4c5d-8e9f-0a1b2c3d4e04',
            email: 'c@majujaya.co.id',
            status: 'expired',
          }),
        ],
      }),
    });
    const rowA = screen.getByRole('listitem', { name: copy.list.actionsFor('a@majujaya.co.id') });
    expect(within(rowA).getByText('Sedang dikirim')).toBeVisible();
    const rowB = screen.getByRole('listitem', { name: copy.list.actionsFor('b@majujaya.co.id') });
    expect(within(rowB).getByText('Email gagal terkirim')).toBeVisible();
    expect(within(rowB).getByText(copy.list.deliveryHint.failed)).toBeVisible();
    const rowC = screen.getByRole('listitem', { name: copy.list.actionsFor('c@majujaya.co.id') });
    expect(within(rowC).getByText(copy.list.expired)).toBeVisible();
    expect(within(rowC).getByRole('button', { name: copy.list.resend })).toBeVisible();
  });

  it('kosong: penjelasan, bukan daftar', async () => {
    await openTeam('owner');
    expect(screen.getByRole('heading', { name: copy.list.emptyTitle })).toBeVisible();
    expect(screen.queryAllByRole('listitem', { name: /^Undangan untuk/ })).toHaveLength(0);
  });

  it('dengan email pengirim: undangan dikirim (body email + peran, CSRF), tanpa dialog tautan', async () => {
    const created = fakeInvitation({
      email: 'tono@majujaya.co.id',
      role: 'teknisi',
      deliveryStatus: 'queued',
    });
    let list = fakeInvitationList();
    const view = await openTeam('owner', {
      routes: {
        [`GET ${API_ROUTES.invitations.collection}`]: () => json(list),
        [`POST ${API_ROUTES.invitations.collection}`]: () => {
          list = fakeInvitationList({ invitations: [created] });
          return json(issued({ invitation: created, link: null }), { status: 201 });
        },
      },
    });
    expect(screen.getByText(copy.invite.viaEmail)).toBeVisible();
    invite('tono@majujaya.co.id', 'Teknisi');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));

    expect(await screen.findByText(copy.invite.sent('tono@majujaya.co.id'))).toBeVisible();
    const request = view.api.requests.find(
      (r) => r.method === 'POST' && r.path === API_ROUTES.invitations.collection,
    );
    expect(request?.body).toEqual({ email: 'tono@majujaya.co.id', role: 'teknisi' });
    expect(request?.headers[CSRF_HEADER_NAME.toLowerCase()]).toBe('csrf-tes-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('listitem', { name: copy.list.actionsFor('tono@majujaya.co.id') }),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(copy.invite.email)).toHaveFocus());
  });

  it('error isian dari server ditandai di isiannya; 403 tampil di bawah tombol', async () => {
    let calls = 0;
    await openTeam('admin', {
      invitations: fakeInvitationList({ invitableRoles: ['supervisor', 'cs', 'teknisi'] }),
      routes: {
        [`POST ${API_ROUTES.invitations.collection}`]: () => {
          calls += 1;
          return calls === 1
            ? apiError(409, 'CONFLICT', 'Email ini sudah terdaftar.', {
                details: [{ field: 'email', message: 'Email ini sudah terdaftar.' }],
              })
            : apiError(
                403,
                'FORBIDDEN',
                'Admin hanya bisa mengundang dan mengelola undangan Supervisor, CS, dan Teknisi.',
              );
        },
      },
    });
    invite('rina@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    const email = screen.getByLabelText(copy.invite.email);
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Email ini sudah terdaftar.')).toBeVisible();
    await waitFor(() => expect(email).toHaveFocus());

    invite('agus@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Admin hanya bisa mengundang/);
  });

  it('isian kosong / email salah ditolak di browser tanpa memanggil server', async () => {
    const view = await openTeam('owner');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    const email = screen.getByLabelText(copy.invite.email);
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(email).toHaveAccessibleDescription(/email/i);
    expect(view.api.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('tanpa email pengirim: tautan tampil SEKALI, tidak tersimpan di cache/storage, menutup minta konfirmasi', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const view = await openTeam('owner', {
      invitations: fakeInvitationList({ emailDelivery: false }),
      routes: {
        [`POST ${API_ROUTES.invitations.collection}`]: () => json(issued(), { status: 201 }),
      },
    });
    expect(screen.getByText(copy.invite.viaLink, { exact: false })).toBeVisible();
    invite('citra@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitLink }));

    const dialog = await screen.findByRole('dialog', { name: copy.linkDialog.title });
    expect(within(dialog).getByText(LINK)).toBeVisible();
    expect(within(dialog).getByText(copy.linkDialog.keyTitle)).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(copy.linkDialog.body('citra@majujaya.co.id'));
    // Tautan setara kunci akses: tidak di cache Query/mutasi, URL, atau storage.
    expect(cacheText(view)).not.toContain('#token=');
    expect(view.router.state.location.href).not.toContain('token');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    // Tutup tanpa menyalin → peringatan dulu.
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.done }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(copy.linkDialog.notCopied);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: copy.linkDialog.back })).toHaveFocus(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.back }));

    // Salin → "Selesai" langsung menutup.
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    await screen.findByRole('button', { name: copy.linkDialog.copied });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.done }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Tidak bisa dilihat lagi dan tidak ada di cache.
    expect(screen.queryByText(LINK)).toBeNull();
    expect(cacheText(view)).not.toContain('#token=');
    await waitFor(() => expect(screen.getByLabelText(copy.invite.email)).toHaveFocus());
  });

  it('kirim ulang tanpa email pengirim membuka dialog tautan baru; batalkan lewat konfirmasi', async () => {
    const invitation = fakeInvitation({ email: 'citra@majujaya.co.id', deliveryStatus: 'link' });
    const view = await openTeam('owner', {
      invitations: fakeInvitationList({ emailDelivery: false, invitations: [invitation] }),
      routes: {
        [`POST ${apiPath(API_ROUTES.invitations.resend, { invitationId: invitation.id })}`]: () =>
          json(issued({ invitation })),
        [`DELETE ${apiPath(API_ROUTES.invitations.revoke, { invitationId: invitation.id })}`]: () =>
          json({ status: 'revoked' }),
      },
    });
    const row = screen.getByRole('listitem', { name: copy.list.actionsFor(invitation.email) });
    fireEvent.click(within(row).getByRole('button', { name: copy.list.resend }));
    const dialog = await screen.findByRole('dialog', { name: copy.linkDialog.title });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.done }));
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.closeAnyway }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(copy.list.reissued(invitation.email))).toBeVisible();
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: copy.list.resend })).toHaveFocus(),
    );

    // Batalkan: konfirmasi dulu ("Jangan batalkan" mendapat fokus), lalu baris hilang.
    fireEvent.click(within(row).getByRole('button', { name: copy.list.revoke }));
    const confirm = await screen.findByRole('dialog', { name: copy.list.revokeTitle });
    expect(within(confirm).getByRole('button', { name: copy.list.keep })).toHaveFocus();
    expect(
      view.api.requests.some((r) => r.method === 'DELETE'),
      'belum dibatalkan sebelum dikonfirmasi',
    ).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: copy.list.revokeConfirm }));
    expect(await screen.findByText(copy.list.revoked(invitation.email))).toBeVisible();
    expect(
      screen.queryByRole('listitem', { name: copy.list.actionsFor(invitation.email) }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: copy.list.title })).toHaveFocus(),
    );
  });

  it('429 saat mengundang: tombol terkunci dengan hitung mundur', async () => {
    await openTeam('owner', {
      routes: {
        [`POST ${API_ROUTES.invitations.collection}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Terlalu banyak undangan dalam satu jam.', {
            retryAfter: 120,
          }),
      },
    });
    invite('citra@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.invite.lockedTitle);
    const locked = screen.getByRole('button', { name: /2:00|1:59/ });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('data-locked');
  });
});
