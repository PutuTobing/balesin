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
  fakeSelfUser,
  fakeSession,
  fakeTeamUser,
  json,
  type FakeApiOptions,
} from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { defaultInviteRole, inviteRoleOptions } from './invite-roles';
import { filterMembers, memberBadges, viewOnlyReason } from './member-status';

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
    // Konfirmasi identitas dulu (semua peran, Owner juga): belum ada yang dikirim.
    expect(view.api.requests.some((r) => r.method === 'POST')).toBe(false);
    await confirmIdentity(copy.invite.confirmTitle, copy.invite.submitEmail);

    expect(await screen.findByText(copy.invite.sent('tono@majujaya.co.id'))).toBeVisible();
    const request = view.api.requests.find(
      (r) => r.method === 'POST' && r.path === API_ROUTES.invitations.collection,
    );
    expect(request?.body).toEqual({
      email: 'tono@majujaya.co.id',
      role: 'teknisi',
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    // Isian konfirmasi tidak tertinggal di cache Query/mutasi.
    expect(cacheText(view)).not.toContain(TEST_PASSWORD);
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
    await confirmIdentity(copy.invite.confirmTitle, copy.invite.submitEmail);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const email = screen.getByLabelText(copy.invite.email);
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Email ini sudah terdaftar.')).toBeVisible();
    await waitFor(() => expect(email).toHaveFocus());

    invite('agus@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    await confirmIdentity(copy.invite.confirmTitle, copy.invite.submitEmail);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Admin hanya bisa mengundang/);
  });

  it('konfirmasi identitas salah: pesan server di isian dialog; batal mengosongkan isiannya', async () => {
    await openTeam('owner', {
      routes: {
        [`POST ${API_ROUTES.invitations.collection}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
            details: [{ field: 'confirmation.code', message: 'Kode verifikasi salah.' }],
          }),
      },
    });
    invite('citra@majujaya.co.id');
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    const dialog = await confirmIdentity(copy.invite.confirmTitle, copy.invite.submitEmail);
    expect(await within(dialog).findByText('Kode verifikasi salah.')).toBeVisible();
    const code = within(dialog).getByLabelText(t.identity.code);
    expect(code).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(code).toHaveFocus());
    fireEvent.click(within(dialog).getByRole('button', { name: t.identity.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: copy.invite.submitEmail })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole('button', { name: copy.invite.submitEmail }));
    const reopened = await screen.findByRole('dialog', { name: copy.invite.confirmTitle });
    expect(within(reopened).getByLabelText(t.identity.password)).toHaveValue('');
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
    await confirmIdentity(copy.invite.confirmTitleLink, copy.invite.submitLink);

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
    // Fokus ke aksi aman: "Salin tautan" (satu-satunya tombol berwarna); "Tutup tanpa menyalin"
    // berupa teks bahaya tanpa latar.
    const copyButton = within(dialog).getByRole('button', { name: copy.linkDialog.copy });
    await waitFor(() => expect(copyButton).toHaveFocus());
    expect(copyButton.className).toMatch(/primary/);
    expect(
      within(dialog).getByRole('button', { name: copy.linkDialog.closeAnyway }).className,
    ).toMatch(/ghost/);

    // Salin dari peringatan → kembali ke pasangan biasa, fokus ke "Selesai" yang langsung menutup.
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    const done = within(dialog).getByRole('button', { name: copy.linkDialog.done });
    await waitFor(() => expect(done).toHaveFocus());
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(done);
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
    await confirmIdentity(copy.list.resendTitle, copy.list.resend);
    const dialog = await screen.findByRole('dialog', { name: copy.linkDialog.title });
    expect(
      view.api.requests.find((r) => r.method === 'POST' && r.path.endsWith('/resend'))?.body,
    ).toEqual({ confirmation: { password: TEST_PASSWORD, code: TEST_CODE } });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.done }));
    fireEvent.click(within(dialog).getByRole('button', { name: copy.linkDialog.closeAnyway }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(copy.list.reissued(invitation.email))).toBeVisible();
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: copy.list.resend })).toHaveFocus(),
    );

    // Batalkan: konfirmasi dulu ("Kembali" mendapat fokus, sekunder; hanya aksi merah yang
    // berwarna), lalu baris hilang.
    fireEvent.click(within(row).getByRole('button', { name: copy.list.revoke }));
    const confirm = await screen.findByRole('dialog', { name: copy.list.revokeTitle });
    const keep = within(confirm).getByRole('button', { name: copy.list.keep });
    expect(keep).toHaveFocus();
    expect(keep.className).toMatch(/secondary/);
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

  it('429 saat mengundang: dialog konfirmasi terkunci dengan hitung mundur', async () => {
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
    const dialog = await confirmIdentity(copy.invite.confirmTitle, copy.invite.submitEmail);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(t.identity.lockedTitle);
    const locked = within(dialog).getByRole('button', { name: /2:00|1:59/ });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('data-locked');
  });
});

describe('anggota tim: lencana & alasan hanya dilihat', () => {
  const base = fakeTeamUser();
  it('lencana urut perhatian: nonaktif/terkunci, 2FA, email belum diverifikasi', () => {
    expect(memberBadges(base).map((badge) => badge.label)).toEqual([copy.badges.twoFactorOff]);
    const admin = fakeTeamUser({
      role: 'admin',
      status: 'locked',
      emailVerified: false,
      twoFactor: { ...base.twoFactor, required: true, enrollmentExpired: true },
    });
    expect(memberBadges(admin)).toEqual([
      { tone: 'warning', label: copy.badges.locked },
      { tone: 'warning', label: copy.badges.twoFactorExpired },
      { tone: 'warning', label: copy.badges.emailUnverified },
    ]);
    expect(
      memberBadges(fakeTeamUser({ twoFactor: { ...base.twoFactor, enabled: true } }))[0]?.label,
    ).toBe(copy.badges.twoFactorOn);
  });

  it('alasan tidak bisa dikelola mengikuti canManage dari server', () => {
    expect(viewOnlyReason(base, 'owner')).toBeNull();
    expect(viewOnlyReason({ ...base, canManage: false, isSelf: true }, 'owner')).toBe('self');
    expect(viewOnlyReason({ ...base, canManage: false, role: 'owner' }, 'admin')).toBe(
      'adminLimit',
    );
    expect(viewOnlyReason({ ...base, canManage: false }, 'owner')).toBe('other');
  });

  it('pencarian nama/email tanpa membedakan huruf besar-kecil', () => {
    const users = [
      base,
      fakeTeamUser({ id: 'x', name: 'Tono Saputra', email: 'tono@majujaya.co.id' }),
    ];
    expect(filterMembers(users, 'TONO').map((user) => user.name)).toEqual(['Tono Saputra']);
    expect(filterMembers(users, '  ')).toHaveLength(2);
    // Domain organisasi tidak ikut dicocokkan ("ma" bukan semua orang); dengan "@" boleh.
    expect(filterMembers(users, 'jaya')).toHaveLength(0);
    expect(filterMembers(users, '@majujaya')).toHaveLength(2);
  });

  it('kelompok Nonaktif tanpa lencana "Nonaktif" ganda', () => {
    const disabled = fakeTeamUser({ status: 'disabled' });
    expect(memberBadges(disabled).map((badge) => badge.label)).toContain(copy.badges.disabled);
    expect(
      memberBadges(disabled, { inDisabledGroup: true }).map((badge) => badge.label),
    ).not.toContain(copy.badges.disabled);
  });
});

describe('Pengaturan → Tim → daftar anggota', () => {
  it('daftar: baris sendiri ke Keamanan akun, anggota lain ke detail, nonaktif di kelompok sendiri', async () => {
    const session = fakeSession('admin', 'Dimas Pratama');
    const owner = fakeTeamUser({
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
      name: 'Rina Kartika',
      role: 'owner',
      canManage: false,
      assignableRoles: [],
    });
    const off = fakeTeamUser({
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0010',
      name: 'Tono Saputra',
      role: 'teknisi',
      status: 'disabled',
      disabledAt: '2026-11-13T00:00:00.000Z',
      activeSessions: 0,
      lastLoginAt: null,
    });
    await openTeam('admin', {
      session,
      teamUsers: {
        users: [owner, fakeSelfUser(session), fakeTeamUser(), off],
        manageableRoles: ['supervisor', 'cs', 'teknisi'],
      },
    });
    const list = screen.getByRole('list', { name: copy.members.listLabel });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(copy.members.viewOnly);
    expect(rows[1]).toHaveAttribute('href', '/pengaturan/keamanan');
    expect(rows[1]).toHaveTextContent(copy.members.you);
    expect(rows[2]).toHaveAttribute('href', `/pengaturan/tim/${fakeTeamUser().id}`);
    expect(rows[2]).toHaveTextContent(copy.members.sessions(1));
    const disabled = screen.getByRole('list', { name: copy.members.disabledGroup(1) });
    // Kelompok Nonaktif: judulnya sudah menyatakan, tanpa lencana "Nonaktif" ganda (T-S4).
    expect(disabled).not.toHaveTextContent(copy.badges.disabled);
    expect(disabled).toHaveTextContent(copy.members.neverLoggedIn);
    // Pencarian baru muncul untuk tim besar.
    expect(screen.queryByRole('searchbox', { name: copy.members.searchLabel })).toBeNull();
  });

  it('tim besar: kolom cari menyaring daftar, dengan pesan bila tidak ada yang cocok', async () => {
    const users = Array.from({ length: 10 }, (_, index) =>
      fakeTeamUser({
        id: `3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1c${String(index).padStart(2, '0')}`,
        name: index === 3 ? 'Sari Wulandari' : `Anggota ${index}`,
        email: `anggota${index}@majujaya.co.id`,
      }),
    );
    await openTeam('owner', { teamUsers: { users, manageableRoles: ['cs'] } });
    const search = screen.getByRole('searchbox', { name: copy.members.searchLabel });
    fireEvent.change(search, { target: { value: 'sari' } });
    const list = screen.getByRole('list', { name: copy.members.listLabel });
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(copy.members.searchEmpty('zzz'))).toBeVisible();
  });

  it('menu Pengaturan menyebut jumlah anggota dan undangan terbuka', async () => {
    await renderApp('/pengaturan', {
      session: fakeSession('owner'),
      invitations: fakeInvitationList({ invitations: [fakeInvitation()] }),
    });
    const menu = await screen.findByRole('link', { name: new RegExp(`^${copy.title}`) });
    await waitFor(() => expect(menu).toHaveTextContent('1 anggota · 1 undangan terbuka'));
    expect(screen.getByRole('link', { name: new RegExp(t.audit.title) })).toHaveAttribute(
      'href',
      '/pengaturan/audit',
    );
  });
});
