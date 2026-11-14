import { API_ROUTES, type InspectInvitationResponse, type InvitableRole } from '@balesin/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeEnrollment,
  fakeEnrollmentSession,
  fakeSession,
  json,
  type FakeApiOptions,
  type FakeHandler,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const copy = t.invitation;
const TOKEN = 'Q2FrU2t5LVRlcy1Ub2tlbi1Db250b2gtVW5kYW5nYW4tMT';
const PASSWORD = 'Teh-Manis-Hangat-77';

function inspectResponse(role: InvitableRole = 'cs'): InspectInvitationResponse {
  return {
    email: 'citra@majujaya.co.id',
    role,
    organizationName: 'PT Maju Jaya',
    productName: 'Balesin',
    invitedByName: 'Rina Kartika',
    expiresAt: '2026-11-17T02:00:00.000Z',
    twoFactorRequired: role === 'admin' || role === 'supervisor',
  };
}

async function openInvitation(
  routes: Record<string, FakeHandler>,
  options: FakeApiOptions = { session: null },
) {
  const view = await renderApp(`/undangan#token=${TOKEN}`, { ...options, routes });
  return view;
}

function fillForm(name = 'Citra Maharani', password = PASSWORD) {
  fireEvent.change(screen.getByLabelText(copy.name), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(copy.password), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(copy.repeat), { target: { value: password } });
}

describe('menerima undangan', () => {
  it('token dari fragment dibuang dari alamat; isi undangan tampil; email tidak bisa diubah', async () => {
    const view = await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()),
    });
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: copy.title('PT Maju Jaya'),
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(copy.subtitle('Rina Kartika', 'CS', 'Balesin'))).toBeVisible();
    expect(screen.getByLabelText(copy.email)).toHaveValue('citra@majujaya.co.id');
    expect(screen.getByLabelText(copy.email)).toHaveAttribute('readonly');
    expect(view.router.state.location.hash).toBe('');
    expect(view.router.history.location.href).not.toContain(TOKEN);
    expect(view.api.requests.find((r) => r.path === API_ROUTES.invitations.inspect)?.body).toEqual({
      token: TOKEN,
    });
    // Peran tanpa 2FA wajib: tidak ada pemberitahuan autentikator.
    expect(screen.queryByText(copy.twoFactor('CS'))).toBeNull();
  });

  it('CS: akun dibuat lalu langsung masuk ke aplikasi', async () => {
    const view = await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()),
      [`POST ${API_ROUTES.invitations.accept}`]: () => {
        const session = fakeSession('cs', 'Citra Maharani');
        view.api.setSession(session);
        return json(session, { status: 201 });
      },
    });
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() => expect(view.router.state.location.pathname).toBe('/inbox'));
    const accept = view.api.requests.find((r) => r.path === API_ROUTES.invitations.accept);
    // Peran & email selalu dari undangan: tidak dikirim.
    expect(accept?.body).toEqual({ token: TOKEN, name: 'Citra Maharani', password: PASSWORD });
  });

  it('Admin: pemberitahuan 2FA, lalu langsung ke pendaftaran 2FA', async () => {
    const view = await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse('admin')),
      [`POST ${API_ROUTES.invitations.accept}`]: () => {
        const session = fakeEnrollmentSession('admin');
        view.api.setSession(session);
        return json(session, { status: 201 });
      },
      [`POST ${API_ROUTES.twoFactor.enroll}`]: () => json(fakeEnrollment()),
    });
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    expect(screen.getByText(copy.twoFactor('Admin'))).toBeVisible();
    fillForm('Agus Pratama');
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe('/verifikasi-dua-langkah'),
    );
  });

  it('password ditolak server: pesan di isian password, form tetap bisa dipakai', async () => {
    await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()),
      [`POST ${API_ROUTES.invitations.accept}`]: () =>
        apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'password', message: 'Password ini terlalu umum.' }],
        }),
    });
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    fillForm('Citra Maharani', 'password12345');
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));
    const password = screen.getByLabelText(copy.password);
    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    expect(password).toHaveAccessibleDescription(/Password ini terlalu umum\./);
    await waitFor(() => expect(password).toHaveFocus());
    expect(screen.getByText(t.password.strength.rejected)).toBeVisible();
  });

  it('nama kosong ditolak di browser tanpa memanggil server', async () => {
    const view = await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()),
    });
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    fillForm('');
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));
    const name = screen.getByLabelText(copy.name);
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(name).toHaveFocus());
    expect(view.api.requests.some((r) => r.path === API_ROUTES.invitations.accept)).toBe(false);
  });

  it('410 → layar penjelasan dengan pesan server dan tombol ke halaman masuk', async () => {
    const message =
      'Undangan ini sudah kedaluwarsa. Minta Owner atau Admin di tempatmu mengirim ulang undangannya.';
    await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => apiError(410, 'TOKEN_INVALID', message),
    });
    const heading = await screen.findByRole('heading', { level: 1, name: copy.invalidTitle });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByRole('link', { name: t.links.toLogin })).toHaveAttribute('href', '/masuk');
    expect(screen.queryByLabelText(copy.password)).toBeNull();
  });

  it('tautan dipakai ulang saat dikirim (410) → layar penjelasan', async () => {
    await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()),
      [`POST ${API_ROUTES.invitations.accept}`]: () =>
        apiError(
          410,
          'TOKEN_INVALID',
          'Undangan ini sudah dipakai. Masuk dengan email dan password-mu.',
        ),
    });
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.invalidTitle })).toBeVisible();
    expect(screen.getByText(/sudah dipakai/)).toBeVisible();
  });

  it('429 saat membuka tautan: "Coba lagi" terkunci dengan hitung mundur', async () => {
    await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: () =>
        apiError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan membuka tautan dari jaringanmu.', {
          retryAfter: 840,
        }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: t.links.lockedTitle }),
    ).toBeVisible();
    const retry = screen.getByRole('button', { name: /14:00|13:59/ });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('data-locked');
  });

  it('browser sedang masuk dengan akun lain: peringatan + bisa keluar dulu tanpa meninggalkan halaman', async () => {
    const view = await openInvitation(
      { [`POST ${API_ROUTES.invitations.inspect}`]: () => json(inspectResponse()) },
      { session: fakeSession('owner', 'Rina Kartika') },
    );
    await screen.findByRole('heading', { level: 1, name: copy.title('PT Maju Jaya') });
    expect(screen.getByText(copy.signedIn.title('Rina Kartika'))).toBeVisible();
    expect(screen.getByText(copy.signedIn.body)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: copy.signedIn.logout }));
    expect(await screen.findByText(copy.signedIn.loggedOut)).toBeVisible();
    expect(view.api.requests.some((r) => r.path === API_ROUTES.auth.logout)).toBe(true);
    expect(view.router.state.location.pathname).toBe('/undangan');
    // Form tetap bisa dipakai (token masih di memori).
    expect(screen.getByLabelText(copy.name)).toBeEnabled();
  });

  it('tautan lain dibuka di tab yang sama (hanya fragment berubah): token baru dipakai', async () => {
    const other = 'Q2FrU2t5LVRlcy1Ub2tlbi1Db250b2gtVW5kYW5nYW4tMj';
    const view = await openInvitation({
      [`POST ${API_ROUTES.invitations.inspect}`]: (request) =>
        (request.body as { token: string }).token === TOKEN
          ? apiError(410, 'TOKEN_INVALID', 'Undangan ini sudah dipakai.')
          : json(inspectResponse('admin')),
    });
    await screen.findByRole('heading', { level: 1, name: copy.invalidTitle });
    await act(() => view.router.navigate({ to: '/undangan', hash: `token=${other}` }));
    expect(await screen.findByText(copy.twoFactor('Admin'))).toBeVisible();
    expect(view.router.state.location.hash).toBe('');
    const tokens = view.api.requests
      .filter((r) => r.path === API_ROUTES.invitations.inspect)
      .map((r) => (r.body as { token: string }).token);
    expect(tokens).toEqual([TOKEN, other]);
  });

  it('alamat tanpa token → penjelasan', async () => {
    const view = await renderApp('/undangan', { session: null });
    expect(await screen.findByRole('heading', { level: 1, name: copy.invalidTitle })).toBeVisible();
    expect(screen.getByText(copy.missing)).toBeVisible();
    expect(view.api.requests.some((r) => r.path === API_ROUTES.invitations.inspect)).toBe(false);
  });
});
