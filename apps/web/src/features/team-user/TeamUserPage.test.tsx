import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  apiPath,
  type TeamUser,
  type TeamUserActionResponse,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeActiveSession,
  fakeAuditEntry,
  fakeSession,
  fakeTeamUser,
  json,
  type FakeApiOptions,
  type FakeHandler,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { roleChoices } from './role-choices';

const copy = t.teamUser;
const identity = t.identity;
const CS = fakeTeamUser();
const userPath = (user: TeamUser) => apiPath(API_ROUTES.team.user, { userId: user.id });
const PASSWORD = 'Kopi-Senja-Tenang-42';

async function openUser(
  user: TeamUser,
  routes: Record<string, FakeHandler> = {},
  options: FakeApiOptions = {},
) {
  const view = await renderApp(`/pengaturan/tim/${user.id}`, {
    session: fakeSession(options.session?.user.role ?? 'owner'),
    ...options,
    routes: {
      [`GET ${userPath(user)}`]: () => json({ user }),
      [`GET ${apiPath(API_ROUTES.team.sessions, { userId: user.id })}`]: () =>
        json({
          sessions: [
            fakeActiveSession({ current: false }),
            fakeActiveSession({
              id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c02',
              device: 'Chrome di Android',
              current: false,
            }),
          ],
        }),
      ...routes,
    },
  });
  await screen.findByRole('heading', { level: 1, name: copy.title });
  await screen.findByRole('heading', { level: 2, name: user.name });
  return view;
}

function action(user: TeamUser, overrides: Partial<TeamUserActionResponse> = {}) {
  return { user, revokedSessions: 2, revokedInvitations: 0, ...overrides };
}

function fillIdentity(password = PASSWORD, code = '123456') {
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(identity.password), {
    target: { value: password },
  });
  fireEvent.change(within(dialog).getByLabelText(identity.code), { target: { value: code } });
  return dialog;
}

describe('pilihan peran', () => {
  it('peran sekarang ditandai; Owner (tidak bisa diberikan) tetap tampil sebagai peran sekarang', () => {
    expect(roleChoices(CS).map((option) => option.label)).toEqual([
      'Admin',
      'Supervisor',
      'CS (sekarang)',
      'Teknisi',
    ]);
    const owner = fakeTeamUser({ role: 'owner' });
    expect(roleChoices(owner)[0]).toEqual({ value: 'owner', label: 'Owner (sekarang)' });
    expect(roleChoices(owner).some((option) => option.label === 'Owner')).toBe(false);
  });
});

describe('Pengaturan → Tim → detail anggota', () => {
  it('bisa dikelola: semua aksi tampil, termasuk sesi aktif dan riwayat aktivitas', async () => {
    await openUser(CS, {
      [`GET ${API_ROUTES.audit.list}`]: () =>
        json({ entries: [fakeAuditEntry()], nextCursor: null }),
    });
    expect(screen.getByRole('button', { name: copy.role.submit })).toBeVisible();
    expect(screen.getByRole('button', { name: copy.access.disable })).toBeVisible();
    // 2FA belum aktif → tidak ada tombol atur ulang (bukan tombol mati).
    expect(screen.queryByRole('button', { name: copy.twoFactor.reset })).toBeNull();
    expect(
      await screen.findByRole('button', { name: t.sessions.revokeLabel('Chrome di Android') }),
    ).toBeVisible();
    expect(await screen.findByText('Peran pengguna diubah')).toBeVisible();
    expect(screen.getByRole('link', { name: copy.activity.openAll })).toHaveAttribute(
      'href',
      `/pengaturan/audit?userId=${CS.id}`,
    );
  });

  it('Admin melihat Admin lain: tanpa tombol kelola, dengan penjelasan singkat', async () => {
    const other = fakeTeamUser({ role: 'admin', canManage: false, assignableRoles: [] });
    const view = await openUser(other, {}, { session: fakeSession('admin') });
    expect(screen.getByText(copy.viewOnly.adminLimit)).toBeVisible();
    expect(screen.queryByRole('button', { name: copy.role.submit })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.access.disable })).toBeNull();
    expect(screen.queryByRole('heading', { name: copy.sessions.title })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Sesi termasuk "kelola": tidak diminta sama sekali (server akan menjawab 403).
    expect(view.api.requests.some((request) => request.path.endsWith('/sessions'))).toBe(false);
  });

  it('ubah peran CS → Supervisor: konfirmasi identitas, kirim password + kode + CSRF, hasil diumumkan', async () => {
    const supervisor = fakeTeamUser({
      role: 'supervisor',
      twoFactor: { ...CS.twoFactor, required: true },
      activeSessions: 0,
    });
    const view = await openUser(CS, {
      [`PUT ${apiPath(API_ROUTES.team.role, { userId: CS.id })}`]: () =>
        json(action(supervisor, { revokedInvitations: 1 })),
    });
    // Peran sama → pesan di isian, tanpa dialog.
    fireEvent.click(screen.getByRole('button', { name: copy.role.submit }));
    expect(await screen.findByText(copy.role.same)).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.change(screen.getByLabelText(copy.role.label), { target: { value: 'supervisor' } });
    fireEvent.click(screen.getByRole('button', { name: copy.role.submit }));
    const dialog = await screen.findByRole('dialog', { name: copy.role.dialogTitle('Supervisor') });
    // Peran baru wajib 2FA dan ia belum punya → akibatnya disebut.
    expect(dialog).toHaveAccessibleDescription(copy.role.dialogBody2fa(CS.name));
    expect(within(dialog).getByLabelText(identity.password)).toHaveFocus();
    fillIdentity();
    fireEvent.click(within(dialog).getByRole('button', { name: copy.role.confirm }));

    const status = await screen.findByText(copy.done.role(CS.name, 'Supervisor', 2));
    expect(status).toBeVisible();
    expect(screen.getByText(copy.done.invitationsRevoked(1))).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    const put = view.api.requests.find((request) => request.method === 'PUT');
    expect(put?.body).toEqual({ password: PASSWORD, code: '123456', role: 'supervisor' });
    expect(put?.headers[CSRF_HEADER_NAME.toLowerCase()]).toBe('csrf-tes-1');
    // Isian identitas tidak tertinggal di cache Query.
    expect(
      JSON.stringify(
        view.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(PASSWORD);
  });

  it('konfirmasi identitas: kosong ditolak di browser, kode salah dari server di isiannya, 429 mengunci', async () => {
    let calls = 0;
    await openUser(CS, {
      [`POST ${apiPath(API_ROUTES.team.disable, { userId: CS.id })}`]: () => {
        calls += 1;
        if (calls === 1) {
          return apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
            details: [{ field: 'code', message: 'Kode tidak cocok.' }],
          });
        }
        return apiError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan. Coba lagi nanti.', {
          retryAfter: 120,
        });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.access.disable }));
    const dialog = await screen.findByRole('dialog', { name: copy.access.disableTitle });
    const confirm = within(dialog).getByRole('button', { name: copy.access.disableConfirm });

    fireEvent.click(confirm);
    expect(await within(dialog).findByText('Password wajib diisi.')).toBeVisible();
    expect(within(dialog).getByText(identity.codeRequired)).toBeVisible();
    expect(calls).toBe(0);

    fillIdentity(PASSWORD, '000000');
    fireEvent.click(confirm);
    const code = within(dialog).getByLabelText(identity.code);
    await waitFor(() => expect(code).toHaveAttribute('aria-invalid', 'true'));
    expect(within(dialog).getByText('Kode tidak cocok.')).toBeVisible();
    await waitFor(() => expect(code).toHaveFocus());

    fireEvent.change(code, { target: { value: '111111' } });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.access.disableConfirm }));
    expect(await within(dialog).findByText(identity.lockedTitle)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Coba lagi dalam 2:00/ })).toBeDisabled();
  });

  it('batal: dialog tertutup, fokus kembali ke tombol pembuka, isian kosong saat dibuka lagi', async () => {
    await openUser(CS);
    const trigger = screen.getByRole('button', { name: copy.access.disable });
    fireEvent.click(trigger);
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: identity.cancel }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(within(screen.getByRole('dialog')).getByLabelText(identity.password)).toHaveValue('');
  });

  it('terkunci → Buka kunci; 2FA aktif → Atur ulang 2FA (varian bahaya); batas daftar lewat → Buka lagi', async () => {
    const locked = fakeTeamUser({
      status: 'locked',
      lockedUntil: '2026-11-14T03:00:00.000Z',
      twoFactor: { ...CS.twoFactor, enabled: true, enabledAt: '2026-11-11T00:00:00.000Z' },
    });
    await openUser(locked);
    expect(screen.getByText(copy.locked.title)).toBeVisible();
    expect(screen.getByRole('button', { name: copy.locked.action })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: copy.twoFactor.reset }));
    const dialog = await screen.findByRole('dialog', { name: copy.twoFactor.resetTitle });
    expect(within(dialog).getByRole('button', { name: copy.twoFactor.resetConfirm })).toHaveClass(
      /danger/,
    );
  });

  it('buka kunci tetapi kunci 2FA harian tetap: kotak yang sama berganti isi, aksinya Atur ulang 2FA', async () => {
    const locked = fakeTeamUser({
      status: 'locked',
      lockedUntil: '2026-11-15T02:00:00.000Z',
      twoFactor: { ...CS.twoFactor, enabled: true, enabledAt: '2026-11-11T00:00:00.000Z' },
    });
    await openUser(locked, {
      [`POST ${apiPath(API_ROUTES.team.unlock, { userId: locked.id })}`]: () =>
        json(action(locked, { revokedSessions: 0 })),
    });
    fireEvent.click(screen.getByRole('button', { name: copy.locked.action }));
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: copy.locked.confirm }),
    );
    const title = await screen.findByText(copy.locked.dailyTitle);
    // Satu kotak saja: judul lama dan pesan berhasil tidak tampil, tombol Buka kunci hilang.
    expect(screen.queryByText(copy.locked.title)).toBeNull();
    expect(screen.queryByText(copy.done.unlocked(locked.name))).toBeNull();
    expect(screen.queryByRole('button', { name: copy.locked.action })).toBeNull();
    const box = title.closest('[tabindex="-1"]') as HTMLElement;
    await waitFor(() => expect(box).toHaveFocus());
    fireEvent.click(within(box).getByRole('button', { name: copy.locked.dailyAction }));
    expect(await screen.findByRole('dialog', { name: copy.twoFactor.resetTitle })).toBeVisible();
  });

  it('akun nonaktif: satu tombol Aktifkan lagi di kotak penjelasan, tanpa kartu Akses akun', async () => {
    const disabled = fakeTeamUser({
      status: 'disabled',
      disabledAt: '2026-11-11T14:26:00.000Z',
    });
    await openUser(disabled);
    const enable = screen.getAllByRole('button', { name: copy.access.enable });
    expect(enable).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: copy.access.title })).toBeNull();
    fireEvent.click(enable[0]!);
    expect(await screen.findByRole('dialog', { name: copy.access.enableTitle })).toBeVisible();
  });

  it('Ubah peran baru biru setelah peran lain dipilih', async () => {
    await openUser(CS);
    const submit = screen.getByRole('button', { name: copy.role.submit });
    expect(submit).toHaveClass(/secondary/);
    fireEvent.change(screen.getByLabelText(copy.role.label), { target: { value: 'supervisor' } });
    expect(submit).toHaveClass(/primary/);
  });

  it('batas daftar 2FA lewat: tombol Buka lagi pendaftaran memanggil endpoint jendela pendaftaran', async () => {
    const expired = fakeTeamUser({
      role: 'admin',
      twoFactor: {
        enabled: false,
        required: true,
        enabledAt: null,
        enrollmentDueAt: '2026-11-10T00:00:00.000Z',
        enrollmentExpired: true,
      },
    });
    let current = expired;
    const view = await openUser(expired, {
      [`GET ${userPath(expired)}`]: () => json({ user: current }),
      [`POST ${apiPath(API_ROUTES.team.reopenTwoFactorEnrollment, { userId: expired.id })}`]:
        () => {
          current = { ...expired, twoFactor: { ...expired.twoFactor, enrollmentExpired: false } };
          return json(action(current, { revokedSessions: 0 }));
        },
    });
    expect(screen.getAllByText(t.team.badges.twoFactorExpired)[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: copy.expired.action }));
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: copy.expired.confirm }),
    );
    expect(await screen.findByText(copy.done.reopened(expired.name))).toBeVisible();
    expect(screen.queryByRole('button', { name: copy.expired.action })).toBeNull();
    expect(
      view.api.requests.some((request) => request.path.endsWith('/2fa/enrollment-window')),
    ).toBe(true);
  });

  it('keluarkan satu sesi tanpa dialog; keluarkan semua lewat konfirmasi identitas', async () => {
    const view = await openUser(CS, {
      [`DELETE ${apiPath(API_ROUTES.team.revokeSession, {
        userId: CS.id,
        sessionId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c02',
      })}`]: () => json({ status: 'revoked' }),
      [`POST ${apiPath(API_ROUTES.team.revokeAllSessions, { userId: CS.id })}`]: () =>
        json({ revokedSessions: 1 }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: t.sessions.revokeLabel('Chrome di Android') }),
    );
    expect(await screen.findByText(t.sessions.revoked('Chrome di Android'))).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.queryByRole('button', { name: t.sessions.revokeLabel('Chrome di Android') }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: copy.sessions.revokeAll }));
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: copy.sessions.revokeAllConfirm,
      }),
    );
    expect(await screen.findByText(copy.done.sessionsRevoked(CS.name, 1))).toBeVisible();
    expect(screen.getByText(copy.sessions.empty)).toBeVisible();
    expect(view.api.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });

  it('409 (data berubah di tempat lain): pesan server di dialog, data dimuat ulang', async () => {
    const view = await openUser(CS, {
      [`POST ${apiPath(API_ROUTES.team.disable, { userId: CS.id })}`]: () =>
        apiError(409, 'CONFLICT', 'Data pengguna ini baru saja berubah. Muat ulang halaman.'),
    });
    fireEvent.click(screen.getByRole('button', { name: copy.access.disable }));
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: copy.access.disableConfirm }),
    );
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'Data pengguna ini baru saja berubah. Muat ulang halaman.',
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        view.api.requests.filter((request) => request.path === userPath(CS)).length,
      ).toBeGreaterThan(1),
    );
  });

  it('pengguna tidak ada: keadaan "tidak ditemukan" dengan jalan kembali ke Tim', async () => {
    await renderApp(`/pengaturan/tim/${CS.id}`, {
      routes: {
        [`GET ${userPath(CS)}`]: () => apiError(404, 'NOT_FOUND', 'Pengguna tidak ditemukan.'),
      },
    });
    expect(await screen.findByRole('heading', { name: copy.notFoundTitle })).toBeVisible();
    expect(screen.getByRole('link', { name: copy.backToTeam })).toHaveAttribute(
      'href',
      '/pengaturan/tim',
    );
  });

  it('CS tidak bisa membuka detail anggota (dialihkan ke Pengaturan)', async () => {
    const view = await renderApp(`/pengaturan/tim/${CS.id}`, { session: fakeSession('cs') });
    await screen.findByRole('heading', { level: 1, name: t.nav.settings });
    expect(view.router.state.location.pathname).toBe('/pengaturan');
  });
});

/**
 * Bug QA butir 6 (sudah diperbaiki, dijaga tes ini): pesan berhasil "Atur ulang 2FA" dulu selalu
 * berbunyi "Ia perlu mendaftarkan aplikasi autentikator lagi saat masuk", juga untuk CS/Teknisi
 * yang 2FA-nya TIDAK wajib — server tidak memintanya mendaftar lagi (masuk berikutnya cukup
 * password; E2E `tim-kunci.spec.ts`). Teks: `t.teamUser.done.twoFactorReset(name, required)`
 * (`apps/web/src/i18n/id.ts`), dipakai `TeamUserPage.tsx`. Email serupa ke Owner
 * (`renderAdminAccountNoticeEmail`, `packages/core/src/mail/templates.ts`) diurus backend.
 */
describe('atur ulang 2FA peran yang tidak wajib', () => {
  it('pesan berhasil tidak menjanjikan pendaftaran wajib saat masuk berikutnya', async () => {
    const teknisi = fakeTeamUser({
      role: 'teknisi',
      twoFactor: {
        ...CS.twoFactor,
        enabled: true,
        required: false,
        enabledAt: '2026-11-11T00:00:00.000Z',
      },
    });
    const after = {
      ...teknisi,
      twoFactor: { ...teknisi.twoFactor, enabled: false, enabledAt: null },
    };
    await openUser(teknisi, {
      [`POST ${apiPath(API_ROUTES.team.resetTwoFactor, { userId: teknisi.id })}`]: () =>
        json(action(after)),
    });
    fireEvent.click(screen.getByRole('button', { name: copy.twoFactor.reset }));
    await screen.findByRole('dialog', { name: copy.twoFactor.resetTitle });
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: copy.twoFactor.resetConfirm }),
    );
    const status = await screen.findByText(/sudah diatur ulang/);
    expect(status).toBeVisible();
    // Teknisi tidak wajib 2FA: ia TIDAK diminta mendaftar lagi saat masuk.
    expect(status.textContent).not.toMatch(
      /perlu mendaftarkan aplikasi autentikator lagi saat masuk/,
    );
  });
  it('setelah atur ulang 2FA, daftar undangan di cache dimuat ulang (undangan terbitannya bisa batal)', async () => {
    const enabled = fakeTeamUser({
      twoFactor: { ...CS.twoFactor, enabled: true, enabledAt: '2026-11-11T00:00:00.000Z' },
    });
    const view = await openUser(enabled, {
      [`POST ${apiPath(API_ROUTES.team.resetTwoFactor, { userId: enabled.id })}`]: () =>
        json(action({ ...enabled, twoFactor: { ...enabled.twoFactor, enabled: false } })),
    });
    view.queryClient.setQueryData(['team', 'invitations'], { stale: true });
    fireEvent.click(screen.getByRole('button', { name: copy.twoFactor.reset }));
    await screen.findByRole('dialog', { name: copy.twoFactor.resetTitle });
    fillIdentity();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: copy.twoFactor.resetConfirm }),
    );
    await screen.findByText(/sudah diatur ulang/);
    expect(view.queryClient.getQueryState(['team', 'invitations'])?.isInvalidated).toBe(true);
  });
});
