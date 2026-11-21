import { API_ROUTES } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/id';
import { apiError, fakeEnrollmentSession, fakeSession, json } from '../test/fake-api';
import { confirmIdentity } from '../test/identity';
import { renderApp } from '../test/render-app';

describe('penjaga rute', () => {
  it('tamu di rute aplikasi → halaman masuk dengan tujuan awal tersimpan', async () => {
    const { router } = await renderApp('/pengaturan?x=1', { session: null });

    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    expect(router.state.location.search).toEqual({ redirect: '/pengaturan?x=1' });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Masuk ke');
    // Layar aplikasi tidak pernah dirender untuk tamu.
    expect(screen.queryByRole('navigation', { name: t.nav.label })).toBeNull();
  });

  it('tamu di "/" atau Inbox → halaman masuk tanpa ?redirect (tujuan bawaan)', async () => {
    const { router } = await renderApp('/', { session: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    expect(router.state.location.search).toEqual({});
  });

  it('instalasi baru → wizard setup, dari rute aplikasi maupun halaman masuk', async () => {
    const setupStatus = { needsSetup: true, setupTokenConfigured: true, canStoreSecrets: true };
    const app = await renderApp('/inbox', { session: null, setupStatus });
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/setup'));
    app.unmount();

    const login = await renderApp('/masuk', { session: null, setupStatus });
    await waitFor(() => expect(login.router.state.location.pathname).toBe('/setup'));
  });

  it('setup sudah selesai → /setup diarahkan ke halaman masuk', async () => {
    const { router } = await renderApp('/setup', { session: null });
    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
  });

  it('sudah masuk → halaman masuk meneruskan ke tujuan (hanya path internal)', async () => {
    const internal = await renderApp('/masuk?redirect=%2Fkontak');
    await waitFor(() => expect(internal.router.state.location.pathname).toBe('/kontak'));
    internal.unmount();

    const external = await renderApp('/masuk?redirect=%2F%2Fcontoh-jahat.test');
    await waitFor(() => expect(external.router.state.location.pathname).toBe('/inbox'));
  });

  it('Email pengirim butuh izin settings.email.manage: tanpa izin dialihkan dan tidak melihat menunya', async () => {
    const { router } = await renderApp('/pengaturan/email', { session: fakeSession('supervisor') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(await screen.findByRole('heading', { level: 1, name: t.nav.settings })).toBeVisible();
    expect(screen.queryByRole('link', { name: new RegExp(t.emailSettings.title) })).toBeNull();
  });

  it('menu mengikuti daftar izin dari server, bukan peran', async () => {
    // Admin dengan izin dicabut server: tidak ada menu organisasi walau perannya Admin.
    const view = await renderApp('/pengaturan/email', {
      session: { ...fakeSession('admin'), permissions: ['inbox.view'] },
    });
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan'));
    expect(screen.queryByRole('link', { name: new RegExp(t.emailSettings.title) })).toBeNull();
    expect(screen.queryByRole('link', { name: new RegExp(t.team.title) })).toBeNull();
  });

  it('403 FORBIDDEN tak terduga → sesi dimuat ulang; izin yang hilang menutup halaman itu', async () => {
    const view = await renderApp('/pengaturan/tim', { session: fakeSession('admin') });
    await screen.findByRole('heading', { level: 1, name: t.team.title });
    // Owner baru saja menurunkan peran pengguna ini menjadi CS.
    view.api.setSession(fakeSession('cs'));
    view.api.on(`POST ${API_ROUTES.invitations.collection}`, () =>
      apiError(403, 'FORBIDDEN', 'Kamu tidak punya izin untuk melakukan tindakan ini.'),
    );
    fireEvent.change(screen.getByLabelText(t.team.invite.email), {
      target: { value: 'citra@majujaya.co.id' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.team.invite.submitEmail }));
    await confirmIdentity(t.team.invite.confirmTitle, t.team.invite.submitEmail);
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan'));
    expect(view.api.requests.filter((r) => r.path === API_ROUTES.auth.me).length).toBeGreaterThan(
      1,
    );
  });

  it('Owner melihat menu Email pengirim beserta statusnya', async () => {
    await renderApp('/pengaturan');
    const link = await screen.findByRole('link', { name: new RegExp(t.emailSettings.title) });
    expect(link).toHaveAttribute('href', '/pengaturan/email');
    await waitFor(() => expect(link).toHaveTextContent('Belum diatur'));
  });

  it('server tidak bisa dihubungi saat memeriksa sesi → layar gagal dengan Coba lagi', async () => {
    let fail = true;
    await renderApp('/inbox', {
      routes: {
        [`GET ${API_ROUTES.auth.me}`]: () =>
          fail
            ? apiError(503, 'SERVICE_UNAVAILABLE', 'Layanan sedang tidak tersedia.')
            : json(fakeSession()),
      },
    });
    expect(await screen.findByRole('heading', { name: t.boot.failedTitle })).toBeVisible();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t.common.retry }));
    expect(await screen.findByRole('heading', { level: 1, name: t.inbox.title })).toBeVisible();
  });

  it('sesi habis di tengah pemakaian → data dibersihkan, halaman masuk dengan pesan', async () => {
    const { router, queryClient } = await renderApp('/pengaturan', {
      routes: {
        [`GET ${API_ROUTES.settings.email}`]: () =>
          apiError(401, 'UNAUTHENTICATED', 'Sesi kamu sudah berakhir.'),
      },
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    expect(router.state.location.search).toEqual({ redirect: '/pengaturan' });
    expect(await screen.findByText(t.auth.login.sessionEnded)).toBeVisible();
    expect(queryClient.getQueryData(['auth', 'session'])).toBeNull();
  });

  it('nama produk dan organisasi dari branding menggantikan bawaan (white-label)', async () => {
    await renderApp('/inbox', {
      branding: {
        productName: 'CS Nusantara',
        organizationName: 'PT Nusantara',
        primaryColor: null,
        logoUrl: null,
      },
    });
    await screen.findByRole('heading', { level: 1, name: t.inbox.title });
    expect(document.title).toBe(`${t.inbox.title} · CS Nusantara`);
    expect(
      within(screen.getByRole('navigation', { name: t.nav.label })).getByRole('link', {
        name: t.nav.home('CS Nusantara'),
      }),
    ).toBeInTheDocument();
  });

  describe('sesi terbatas (wajib mendaftar 2FA)', () => {
    it('halaman aplikasi mana pun → layar pendaftaran 2FA, tujuan awal ikut dibawa', async () => {
      const { router, api } = await renderApp('/pengaturan?x=1', {
        session: fakeEnrollmentSession('admin'),
        routes: {
          [`POST ${API_ROUTES.twoFactor.enroll}`]: () => new Promise<Response>(() => undefined),
        },
      });

      await waitFor(() => expect(router.state.location.pathname).toBe('/verifikasi-dua-langkah'));
      expect(router.state.location.search).toEqual({ redirect: '/pengaturan?x=1' });
      expect(
        await screen.findByRole('heading', { level: 1, name: t.twoFactor.enroll.title }),
      ).toBeVisible();
      // Kerangka aplikasi (navigasi, data aplikasi) tidak pernah dirender untuk sesi terbatas.
      expect(screen.queryByRole('navigation', { name: t.nav.label })).toBeNull();
      expect(api.requests.some((request) => request.path === API_ROUTES.settings.email)).toBe(
        false,
      );
      // Hanya Keluar yang bisa dipakai selain pendaftaran.
      expect(screen.getByRole('button', { name: t.auth.userMenu.logout })).toBeVisible();
    });

    it('halaman masuk dan /setup juga diteruskan ke pendaftaran 2FA', async () => {
      const login = await renderApp('/masuk?redirect=%2Fkontak', {
        session: fakeEnrollmentSession(),
        routes: {
          [`POST ${API_ROUTES.twoFactor.enroll}`]: () => new Promise<Response>(() => undefined),
        },
      });
      await waitFor(() =>
        expect(login.router.state.location.pathname).toBe('/verifikasi-dua-langkah'),
      );
      expect(login.router.state.location.search).toEqual({ redirect: '/kontak' });
      login.unmount();

      const setup = await renderApp('/setup', {
        session: fakeEnrollmentSession(),
        routes: {
          [`POST ${API_ROUTES.twoFactor.enroll}`]: () => new Promise<Response>(() => undefined),
        },
      });
      await waitFor(() =>
        expect(setup.router.state.location.pathname).toBe('/verifikasi-dua-langkah'),
      );
    });

    it('layar pendaftaran wajib: sesi penuh → Keamanan akun, tamu → halaman masuk', async () => {
      const full = await renderApp('/verifikasi-dua-langkah');
      await waitFor(() => expect(full.router.state.location.pathname).toBe('/pengaturan/keamanan'));
      full.unmount();

      const guest = await renderApp('/verifikasi-dua-langkah', { session: null });
      await waitFor(() => expect(guest.router.state.location.pathname).toBe('/masuk'));
      // Layar pendaftaran bukan tujuan setelah masuk.
      expect(guest.router.state.location.search).toEqual({});
    });

    it('403 TWO_FACTOR_ENROLLMENT_REQUIRED di tengah pemakaian → sesi dimuat ulang, lalu pendaftaran', async () => {
      const { router, api, queryClient } = await renderApp('/pengaturan', {
        routes: {
          [`POST ${API_ROUTES.twoFactor.enroll}`]: () => new Promise<Response>(() => undefined),
        },
      });
      await screen.findByRole('heading', { level: 1, name: t.nav.settings });
      // Data lama di cache sudah basi: halaman berikutnya memuatnya ulang dari server.
      queryClient.removeQueries({ queryKey: ['settings', 'email'] });

      // Server menganggap sesi ini terbatas (kontrak: muat ulang /auth/me lalu ke pendaftaran).
      api.setSession(fakeEnrollmentSession('admin'));
      api.on(`GET ${API_ROUTES.settings.email}`, () =>
        apiError(403, 'TWO_FACTOR_ENROLLMENT_REQUIRED', 'Aktifkan verifikasi dua langkah dulu.'),
      );
      await router.navigate({ to: '/pengaturan/email' });

      await waitFor(() => expect(router.state.location.pathname).toBe('/verifikasi-dua-langkah'));
      expect(
        await screen.findByRole('heading', { level: 1, name: t.twoFactor.enroll.title }),
      ).toBeVisible();
      const meCalls = api.requests.filter((request) => request.path === API_ROUTES.auth.me);
      expect(meCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
