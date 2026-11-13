import { API_ROUTES } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/id';
import { apiError, fakeSession, json } from '../test/fake-api';
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

  it('Email pengirim khusus Owner: peran lain dialihkan dan tidak melihat menunya', async () => {
    const { router } = await renderApp('/pengaturan/email', { session: fakeSession('admin') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(await screen.findByRole('heading', { level: 1, name: t.nav.settings })).toBeVisible();
    expect(screen.queryByRole('link', { name: new RegExp(t.emailSettings.title) })).toBeNull();
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
});
