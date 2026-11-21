import { API_ROUTES, type InspectPasswordResetResponse } from '@balesin/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { sessionQuery } from '../../lib/api/queries';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const forgot = t.forgotPassword;
const reset = t.resetPassword;
const TOKEN = 'Q2FrU2t5LVRlcy1Ub2tlbi1Db250b2gtVHVqdWFuLTEyMz';
const NEW_PASSWORD = 'Gunung-Biru-Pagi-81';

function inspectResponse(
  overrides: Partial<InspectPasswordResetResponse> = {},
): InspectPasswordResetResponse {
  return {
    email: 'citra@majujaya.co.id',
    expiresAt: '2026-11-14T03:30:00.000Z',
    twoFactorRequired: false,
    methods: [],
    ...overrides,
  };
}

async function openReset(routes: Record<string, FakeHandler>, hash = `#token=${TOKEN}`) {
  const view = await renderApp(`/atur-ulang-password${hash}`, { session: null, routes });
  return view;
}

function fillPasswords(password = NEW_PASSWORD, repeat = password) {
  fireEvent.change(screen.getByLabelText(reset.password), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(reset.repeat), { target: { value: repeat } });
}

describe('lupa password', () => {
  it('halaman masuk punya tautan "Lupa password?" yang membawa email yang sudah diketik', async () => {
    const view = await renderApp('/masuk', { session: null });
    fireEvent.change(await screen.findByLabelText(t.auth.login.email), {
      target: { value: 'citra@majujaya.co.id' },
    });
    fireEvent.click(screen.getByRole('link', { name: t.auth.login.forgot }));
    expect(await screen.findByRole('heading', { level: 1, name: forgot.heading })).toBeVisible();
    expect(view.router.state.location.pathname).toBe('/lupa-password');
    // Email dibawa lewat memori, bukan URL.
    expect(view.router.state.location.href).not.toContain('citra');
    expect(screen.getByLabelText(forgot.email)).toHaveValue('citra@majujaya.co.id');
  });

  it('email pengirim belum diatur → penjelasan tanpa form', async () => {
    await renderApp('/lupa-password', { session: null, passwordResetAvailable: false });
    expect(
      await screen.findByRole('heading', { level: 1, name: forgot.unavailableTitle }),
    ).toBeVisible();
    expect(screen.getByText(forgot.unavailable)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: forgot.back })).toHaveAttribute('href', '/masuk');
  });

  it('jawaban netral yang sama untuk email apa pun — tidak pernah "email terkirim"', async () => {
    const view = await renderApp('/lupa-password', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.passwordReset.request}`]: () =>
          json({ status: 'accepted', validMinutes: 30 }, { status: 202 }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: forgot.heading });
    fireEvent.change(await screen.findByLabelText(forgot.email), {
      target: { value: 'tidak-terdaftar@contoh.co.id' },
    });
    fireEvent.click(screen.getByRole('button', { name: forgot.submit }));

    const heading = await screen.findByRole('heading', { level: 1, name: forgot.sentTitle });
    await waitFor(() => expect(heading).toHaveFocus());
    const text = screen.getByText(forgot.sent('tidak-terdaftar@contoh.co.id', 30));
    expect(text).toHaveTextContent(/^Kalau tidak-terdaftar@contoh\.co\.id terdaftar/);
    expect(text).toHaveTextContent('Kalau ada beberapa email, pakai yang terbaru.');
    expect(document.body).not.toHaveTextContent(/email terkirim/i);
    expect(
      view.api.requests.find((r) => r.path === API_ROUTES.passwordReset.request)?.body,
    ).toEqual({ email: 'tidak-terdaftar@contoh.co.id' });

    // "Pakai email lain" kembali ke form kosong.
    fireEvent.click(screen.getByRole('button', { name: forgot.otherEmail }));
    expect(await screen.findByLabelText(forgot.email)).toHaveValue('');
  });

  it('email salah ditolak di browser; 429 mengunci tombol dengan hitung mundur m:ss', async () => {
    const view = await renderApp('/lupa-password', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.passwordReset.request}`]: () =>
          apiError(
            429,
            'RATE_LIMITED',
            'Terlalu banyak permintaan atur ulang password untuk email ini dari jaringanmu.',
            { retryAfter: 600 },
          ),
      },
    });
    await screen.findByRole('heading', { level: 1, name: forgot.heading });
    const email = await screen.findByLabelText(forgot.email);
    fireEvent.change(email, { target: { value: 'bukan-email' } });
    fireEvent.click(screen.getByRole('button', { name: forgot.submit }));
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(view.api.requests.some((r) => r.path === API_ROUTES.passwordReset.request)).toBe(false);

    fireEvent.change(email, { target: { value: 'citra@majujaya.co.id' } });
    fireEvent.click(screen.getByRole('button', { name: forgot.submit }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(forgot.lockedTitle);
    expect(alert).toHaveTextContent(/dari jaringanmu/);
    const locked = screen.getByRole('button', { name: /10:00|9:59/ });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('data-locked');
  });
});

describe('atur ulang password', () => {
  it('token dibaca dari fragment lalu langsung dibuang dari alamat; dikirim di body', async () => {
    const view = await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => json(inspectResponse()),
    });
    expect(await screen.findByRole('heading', { level: 1, name: reset.heading })).toBeVisible();
    expect(view.router.state.location.hash).toBe('');
    expect(view.router.history.location.href).not.toContain(TOKEN);
    expect(
      view.api.requests.find((r) => r.path === API_ROUTES.passwordReset.inspect)?.body,
    ).toEqual({ token: TOKEN });
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(
      JSON.stringify(
        view.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => [query.queryKey, query.state.data]),
      ),
    ).not.toContain(TOKEN);
  });

  it('akun tanpa 2FA: tidak ada isian kode; berhasil → halaman masuk dengan pesan dan email terisi', async () => {
    const view = await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => json(inspectResponse()),
      [`POST ${API_ROUTES.passwordReset.complete}`]: () => json({ status: 'password_reset' }),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    expect(screen.getByText(reset.subtitle('citra@majujaya.co.id'))).toBeVisible();
    expect(screen.queryByLabelText(reset.code)).toBeNull();

    fillPasswords();
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));

    expect(await screen.findByText(t.auth.login.passwordReset)).toBeVisible();
    expect(view.router.state.location.pathname).toBe('/masuk');
    expect(screen.getByLabelText(t.auth.login.email)).toHaveValue('citra@majujaya.co.id');
    expect(
      view.api.requests.find((r) => r.path === API_ROUTES.passwordReset.complete)?.body,
    ).toEqual({ token: TOKEN, password: NEW_PASSWORD });
  });

  it('akun ber-2FA: isian kode wajib (kode cadangan diterima bila masih ada)', async () => {
    const view = await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () =>
        json(inspectResponse({ twoFactorRequired: true, methods: ['totp', 'backup_code'] })),
      [`POST ${API_ROUTES.passwordReset.complete}`]: () =>
        apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'code', message: 'Kode verifikasi salah. Sisa 2 percobaan.' }],
        }),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    expect(screen.getByText(reset.twoFactorTitle)).toBeVisible();
    const code = screen.getByLabelText(reset.code);
    expect(code).toHaveAccessibleDescription(reset.codeHintAny);

    // Tanpa kode → ditolak di browser.
    fillPasswords();
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));
    await waitFor(() => expect(code).toHaveAttribute('aria-invalid', 'true'));
    expect(view.api.requests.some((r) => r.path === API_ROUTES.passwordReset.complete)).toBe(false);

    fireEvent.change(code, { target: { value: 'k7m2p-x9q4r' } });
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));
    expect(await screen.findByText('Kode verifikasi salah. Sisa 2 percobaan.')).toBeVisible();
    await waitFor(() => expect(code).toHaveFocus());
    // Kode dikirim apa adanya; server yang menormalkan (spasi, tanda hubung, huruf besar).
    expect(
      view.api.requests.find((r) => r.path === API_ROUTES.passwordReset.complete)?.body,
    ).toMatchObject({ token: TOKEN, password: NEW_PASSWORD });
  });

  it('akun ber-2FA tanpa kode cadangan: hanya kode 6 digit', async () => {
    await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () =>
        json(inspectResponse({ twoFactorRequired: true, methods: ['totp'] })),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    const code = screen.getByLabelText(reset.code);
    expect(code).toHaveAccessibleDescription(reset.codeHintTotp);
    expect(code).toHaveAttribute('inputmode', 'numeric');
  });

  it('password ditolak server → pesan di isian password, tautan tetap bisa dipakai', async () => {
    await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => json(inspectResponse()),
      [`POST ${API_ROUTES.passwordReset.complete}`]: () =>
        apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'password', message: 'Password ini terlalu umum.' }],
        }),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    fillPasswords('password-umum-1');
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));
    const password = screen.getByLabelText(reset.password);
    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    expect(password).toHaveAccessibleDescription(/Password ini terlalu umum\./);
    await waitFor(() => expect(password).toHaveFocus());
  });

  it('ulangi password tidak sama → ditolak di browser', async () => {
    await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => json(inspectResponse()),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    fillPasswords(NEW_PASSWORD, `${NEW_PASSWORD}x`);
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));
    await waitFor(() =>
      expect(screen.getByLabelText(reset.repeat)).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByText(t.form.passwordsDiffer)).toBeVisible();
  });

  it('tautan tidak berlaku (410) → layar penjelasan dengan pesan server + minta tautan baru', async () => {
    const message =
      'Tautan ini sudah dipakai. Kalau kamu masih perlu mengganti password, minta tautan baru.';
    await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => apiError(410, 'TOKEN_INVALID', message),
    });
    const heading = await screen.findByRole('heading', { level: 1, name: reset.invalidTitle });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByRole('link', { name: reset.requestNew })).toHaveAttribute(
      'href',
      '/lupa-password',
    );
    // Bukan sesi habis.
    expect(screen.queryByText(t.auth.login.sessionEnded)).toBeNull();
  });

  it('tautan hangus saat dikirim (kode salah 3 kali) → layar penjelasan', async () => {
    await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () =>
        json(inspectResponse({ twoFactorRequired: true, methods: ['totp'] })),
      [`POST ${API_ROUTES.passwordReset.complete}`]: () =>
        apiError(410, 'TOKEN_INVALID', 'Kode salah 3 kali. Tautan ini tidak berlaku lagi.'),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    fillPasswords();
    fireEvent.change(screen.getByLabelText(reset.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: reset.submit }));
    expect(
      await screen.findByRole('heading', { level: 1, name: reset.invalidTitle }),
    ).toBeVisible();
    expect(screen.getByText('Kode salah 3 kali. Tautan ini tidak berlaku lagi.')).toBeVisible();
  });

  it('alamat tanpa token → penjelasan tanpa memanggil server', async () => {
    const view = await openReset({}, '');
    expect(
      await screen.findByRole('heading', { level: 1, name: reset.invalidTitle }),
    ).toBeVisible();
    expect(screen.getByText(reset.missing)).toBeVisible();
    expect(view.api.requests.some((r) => r.path === API_ROUTES.passwordReset.inspect)).toBe(false);
  });

  it('401 pemeriksaan sesi latar di halaman tamu tidak memindahkan ke halaman masuk', async () => {
    const view = await openReset({
      [`POST ${API_ROUTES.passwordReset.inspect}`]: () => json(inspectResponse()),
    });
    await screen.findByRole('heading', { level: 1, name: reset.heading });
    // Sesi lama ternyata sudah dicabut: /auth/me menjawab 401 saat halaman sudah terbuka.
    view.queryClient.setQueryData(sessionQuery.queryKey, fakeSession('cs'));
    await act(() => view.queryClient.refetchQueries({ queryKey: sessionQuery.queryKey }));
    expect(view.router.state.location.pathname).toBe('/atur-ulang-password');
    expect(screen.getByRole('heading', { level: 1, name: reset.heading })).toBeVisible();
    expect(view.queryClient.getQueryData(sessionQuery.queryKey)).toBeNull();
  });
});
