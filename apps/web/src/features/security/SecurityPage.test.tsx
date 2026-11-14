import { API_ROUTES, CSRF_HEADER_NAME, type TwoFactorStatusResponse } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  FAKE_BACKUP_CODES,
  apiError,
  fakeEnrollment,
  fakeSession,
  fakeTwoFactorStatus,
  json,
  type FakeHandler,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const copy = t.security;

async function openSecurity(
  role: Parameters<typeof fakeSession>[0] = 'owner',
  status?: Partial<TwoFactorStatusResponse>,
  routes: Record<string, FakeHandler> = {},
) {
  const view = await renderApp('/pengaturan/keamanan', {
    session: fakeSession(role),
    twoFactorStatus: fakeTwoFactorStatus(role, status),
    routes,
  });
  await screen.findByRole('heading', { level: 1, name: copy.title });
  return view;
}

const card = (name: string) => screen.getByRole('region', { name });

describe('Pengaturan → Keamanan akun', () => {
  it('Owner: 2FA aktif dan wajib → penjelasan, bukan tombol nonaktifkan yang mati', async () => {
    await openSecurity('owner');
    const twoFactor = card(copy.twoFactor.title);
    expect(within(twoFactor).getByText(copy.twoFactor.on)).toBeVisible();
    expect(within(twoFactor).getByText(copy.twoFactor.required('Owner'))).toBeVisible();
    expect(within(twoFactor).getByText(copy.twoFactor.since('13 Nov 2026'))).toBeVisible();
    expect(screen.queryByRole('button', { name: copy.disable.title })).toBeNull();
    const backup = card(copy.backupCodes.title);
    expect(within(backup).getByText(copy.backupCodes.remaining(10, 10))).toBeVisible();
    expect(within(backup).queryByText(copy.backupCodes.lowBody)).toBeNull();
  });

  it('kode cadangan tinggal sedikit (≤ 3) → peringatan dan ajakan membuat baru', async () => {
    await openSecurity('admin', { backupCodesRemaining: 2 });
    const backup = card(copy.backupCodes.title);
    expect(within(backup).getByText(copy.backupCodes.lowBody)).toBeVisible();
  });

  it('buat ulang kode cadangan: password + kode → kode baru tampil sekali, lalu hilang dari memori', async () => {
    const view = await openSecurity(
      'owner',
      {},
      {
        [`POST ${API_ROUTES.twoFactor.regenerateBackupCodes}`]: (request) => {
          const body = request.body as { password: string; code: string };
          if (body.password !== 'Kopi-Senja-Tenang-42') {
            return apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
              details: [{ field: 'password', message: 'Password salah.' }],
            });
          }
          return json({ codes: FAKE_BACKUP_CODES, generatedAt: '2026-11-14T02:00:00.000Z' });
        },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    const password = screen.getByLabelText(copy.reauth.password);
    expect(password).toHaveFocus();

    // Kosong → ditolak di browser.
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    expect(await screen.findByText('Password wajib diisi.')).toBeVisible();
    expect(screen.getByText('Kode wajib diisi.')).toBeVisible();

    // Password salah → pesan server di isian password, fokus ke sana.
    fireEvent.change(password, { target: { value: 'salah' } });
    fireEvent.change(screen.getByLabelText(copy.reauth.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    expect(await screen.findByText('Password salah.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(copy.reauth.password)).toHaveFocus());

    fireEvent.change(screen.getByLabelText(copy.reauth.password), {
      target: { value: 'Kopi-Senja-Tenang-42' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));

    const newCodesHeading = await screen.findByRole('heading', {
      level: 2,
      name: t.twoFactor.backupCodes.newTitle,
    });
    await waitFor(() => expect(newCodesHeading).toHaveFocus());
    for (const code of FAKE_BACKUP_CODES) expect(screen.getByText(code)).toBeVisible();
    const request = view.api.requests.findLast(
      (item) => item.path === API_ROUTES.twoFactor.regenerateBackupCodes,
    );
    expect(request?.body).toEqual({ password: 'Kopi-Senja-Tenang-42', code: '123456' });
    expect(request?.headers[CSRF_HEADER_NAME]).toBe('csrf-tes-1');

    // Selesai wajib dicentang dulu; setelah ditutup, kode tidak ada di cache Query.
    fireEvent.click(screen.getByRole('checkbox', { name: t.twoFactor.backupCodes.confirm }));
    fireEvent.click(screen.getByRole('button', { name: t.twoFactor.backupCodes.done }));
    const backupHeading = await screen.findByRole('heading', {
      level: 2,
      name: copy.backupCodes.title,
    });
    await waitFor(() => expect(backupHeading).toHaveFocus());
    expect(screen.queryByText(FAKE_BACKUP_CODES[0] ?? '')).toBeNull();
    const cached = JSON.stringify([
      view.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
      view.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
    ]);
    expect(cached).not.toContain(FAKE_BACKUP_CODES[0]);
    // Status (sisa kode) dimuat ulang dari server.
    await waitFor(() =>
      expect(
        view.api.requests.filter((item) => item.path === API_ROUTES.twoFactor.status).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('429 saat konfirmasi ulang → tombol terkunci dengan hitung mundur', async () => {
    await openSecurity(
      'owner',
      {},
      {
        [`POST ${API_ROUTES.twoFactor.regenerateBackupCodes}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.', {
            retryAfter: 900,
          }),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    fireEvent.change(screen.getByLabelText(copy.reauth.password), { target: { value: 'apa' } });
    fireEvent.change(screen.getByLabelText(copy.reauth.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.reauth.lockedTitle);
    const locked = screen.getByRole('button', { name: t.auth.login.countdownButton('15:00') });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('data-locked');
    // Fokus tidak jatuh ke <body>: kembali ke isian kode setelah isian aktif lagi.
    await waitFor(() => expect(screen.getByLabelText(copy.reauth.code)).toHaveFocus());
  });

  it('"Batal" menutup form dan mengembalikan fokus ke tombol pembukanya', async () => {
    await openSecurity('owner');
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    expect(screen.getByLabelText(copy.reauth.password)).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: copy.reauth.cancel }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: copy.backupCodes.regenerate })).toHaveFocus(),
    );
  });

  it('kode cadangan baru belum dicentang → pindah halaman ditahan dialog; "Tetap di sini" menyimpannya', async () => {
    const view = await openSecurity(
      'owner',
      {},
      {
        [`POST ${API_ROUTES.twoFactor.regenerateBackupCodes}`]: () =>
          json({ codes: FAKE_BACKUP_CODES, generatedAt: '2026-11-14T02:00:00.000Z' }),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    fireEvent.change(screen.getByLabelText(copy.reauth.password), { target: { value: 'apa' } });
    fireEvent.change(screen.getByLabelText(copy.reauth.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    await screen.findByRole('heading', { level: 2, name: t.twoFactor.backupCodes.newTitle });

    // Tombol kembali di header (navigasi di dalam aplikasi) → dialog, halaman tidak berpindah.
    fireEvent.click(screen.getByRole('link', { name: t.common.backTo(t.nav.settings) }));
    const leave = t.twoFactor.backupCodes.leave;
    expect(await screen.findByRole('heading', { name: leave.title })).toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe('/pengaturan/keamanan');
    fireEvent.click(screen.getByRole('button', { name: leave.stay }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: leave.title })).toBeNull());
    expect(screen.getByText(FAKE_BACKUP_CODES[0] ?? '')).toBeVisible();

    // "Tinggalkan" → pindah, kode dibuang.
    fireEvent.click(screen.getByRole('link', { name: t.common.backTo(t.nav.settings) }));
    fireEvent.click(await screen.findByRole('button', { name: leave.leave }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan'));
    await waitFor(() => expect(screen.queryByText(FAKE_BACKUP_CODES[0] ?? '')).toBeNull());
  });

  it('kode baru sudah dicentang → "Selesai" lalu pindah halaman tanpa dialog', async () => {
    const view = await openSecurity(
      'owner',
      {},
      {
        [`POST ${API_ROUTES.twoFactor.regenerateBackupCodes}`]: () =>
          json({ codes: FAKE_BACKUP_CODES, generatedAt: '2026-11-14T02:00:00.000Z' }),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    fireEvent.change(screen.getByLabelText(copy.reauth.password), { target: { value: 'apa' } });
    fireEvent.change(screen.getByLabelText(copy.reauth.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: copy.backupCodes.regenerate }));
    await screen.findByRole('heading', { level: 2, name: t.twoFactor.backupCodes.newTitle });
    fireEvent.click(screen.getByRole('checkbox', { name: t.twoFactor.backupCodes.confirm }));
    fireEvent.click(screen.getByRole('button', { name: t.twoFactor.backupCodes.done }));
    fireEvent.click(screen.getByRole('link', { name: t.common.backTo(t.nav.settings) }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan'));
    expect(screen.queryByRole('heading', { name: t.twoFactor.backupCodes.leave.title })).toBeNull();
  });

  it('BUG QA-2FA-5: keluar dari Keamanan akun tidak memuat ulang status 2FA setelah sesi dicabut', async () => {
    const view = await openSecurity('cs');
    const before = view.api.requests.filter(
      (request) => request.path === API_ROUTES.twoFactor.status,
    ).length;
    fireEvent.keyDown(screen.getByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/masuk'));
    await screen.findByText(t.auth.login.loggedOut);
    expect(
      view.api.requests.filter((request) => request.path === API_ROUTES.twoFactor.status),
    ).toHaveLength(before);
    expect(view.queryClient.getQueryData(['auth', 'two-factor'])).toBeUndefined();
  });

  it('CS dengan 2FA aktif: bisa menonaktifkan setelah konfirmasi password + kode', async () => {
    const view = await openSecurity('cs', {
      enabled: true,
      enabledAt: '2026-11-13T03:00:00.000Z',
      backupCodesRemaining: 8,
      backupCodesGeneratedAt: '2026-11-13T03:00:00.000Z',
    });
    view.api.on(`POST ${API_ROUTES.twoFactor.disable}`, () => {
      view.api.on(`GET ${API_ROUTES.twoFactor.status}`, () => json(fakeTwoFactorStatus('cs')));
      return json({ status: 'disabled' });
    });
    fireEvent.click(screen.getByRole('button', { name: copy.disable.title }));
    fireEvent.change(screen.getByLabelText(copy.reauth.password), {
      target: { value: 'Teh-Manis-Hangat-77' },
    });
    fireEvent.change(screen.getByLabelText(copy.reauth.code), { target: { value: 'k7m2p-x9q4r' } });
    fireEvent.click(screen.getByRole('button', { name: copy.disable.action }));

    expect(await screen.findByRole('status')).toHaveTextContent(copy.disable.done);
    await waitFor(() =>
      expect(within(card(copy.twoFactor.title)).getByText(copy.twoFactor.off)).toBeVisible(),
    );
    expect(screen.queryByRole('region', { name: copy.backupCodes.title })).toBeNull();
    const request = view.api.requests.find((item) => item.path === API_ROUTES.twoFactor.disable);
    expect(request?.body).toEqual({ password: 'Teh-Manis-Hangat-77', code: 'k7m2px9q4r' });
  });

  it('Teknisi tanpa 2FA: "Aktifkan" → konfirmasi password → QR', async () => {
    const view = await openSecurity(
      'teknisi',
      {},
      {
        [`POST ${API_ROUTES.twoFactor.enroll}`]: (request) =>
          (request.body as { password?: string }).password === 'Obeng-Kabel-Rapi-31'
            ? json(fakeEnrollment())
            : apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
                details: [{ field: 'password', message: 'Password salah.' }],
              }),
      },
    );
    expect(within(card(copy.twoFactor.title)).getByText(copy.twoFactor.recommended)).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: copy.twoFactor.enable }));

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe('/pengaturan/keamanan/aktifkan'),
    );
    const password = await screen.findByLabelText(t.twoFactor.enroll.password.label);
    fireEvent.change(password, { target: { value: 'salah' } });
    fireEvent.click(screen.getByRole('button', { name: t.twoFactor.enroll.password.submit }));
    expect(await screen.findByText('Password salah.')).toBeVisible();

    fireEvent.change(screen.getByLabelText(t.twoFactor.enroll.password.label), {
      target: { value: 'Obeng-Kabel-Rapi-31' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.twoFactor.enroll.password.submit }));
    expect(await screen.findByRole('img', { name: t.twoFactor.enroll.add.qrLabel })).toBeVisible();
    // Tombol kembali ke Keamanan akun (sub-halaman).
    expect(screen.getByRole('link', { name: t.common.backTo(copy.title) })).toHaveAttribute(
      'href',
      '/pengaturan/keamanan',
    );
  });

  it('menu Pengaturan dan menu akun membuka Keamanan akun untuk semua peran', async () => {
    const view = await renderApp('/pengaturan', { session: fakeSession('cs') });
    const link = await screen.findByRole('link', { name: new RegExp(copy.title) });
    expect(link).toHaveAttribute('href', '/pengaturan/keamanan');
    await waitFor(() => expect(link).toHaveTextContent(copy.twoFactor.off));

    fireEvent.keyDown(screen.getByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.security }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan/keamanan'));
  });
});
