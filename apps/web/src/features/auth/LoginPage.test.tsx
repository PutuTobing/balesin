import { API_ROUTES, CSRF_HEADER_NAME } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(t.auth.login.email), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(t.auth.login.password), { target: { value: password } });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: t.auth.login.submit }));

describe('halaman masuk', () => {
  it('memakai nama organisasi dari branding; tanpa tautan Daftar, dengan "Lupa password?"', async () => {
    await renderApp('/masuk', { session: null });

    expect(
      await screen.findByRole('heading', { level: 1, name: t.auth.login.heading('PT Maju Jaya') }),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: /daftar/i })).toBeNull();
    expect(screen.getByRole('link', { name: t.auth.login.forgot })).toHaveAttribute(
      'href',
      '/lupa-password',
    );
    expect(screen.getByLabelText(t.auth.login.email)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(t.auth.login.password)).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });

  it('validasi di browser: pesan terhubung ke isian lewat aria-describedby', async () => {
    const { api } = await renderApp('/masuk', { session: null });
    await screen.findByRole('heading', { level: 1 });

    submit();

    const email = screen.getByLabelText(t.auth.login.email);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ')[0] ?? '')).toHaveTextContent(
      'Alamat email wajib diisi.',
    );
    expect(api.requests.some((request) => request.path === API_ROUTES.auth.login)).toBe(false);
    // QA6: fokus pindah ke isian pertama yang salah, bukan tertinggal di tombol.
    await waitFor(() => expect(email).toHaveFocus());
  });

  it('berhasil masuk → ke tujuan awal; token CSRF dari respons dipakai berikutnya', async () => {
    const { router, api } = await renderApp('/masuk?redirect=%2Fpengaturan', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.auth.login}`]: () => {
          const session = { ...fakeSession(), csrfToken: 'csrf-setelah-masuk' };
          api.setSession(session);
          return json(session);
        },
      },
    });
    await screen.findByRole('heading', { level: 1 });

    fill('Rina@MajuJaya.co.id', 'Kopi-Senja-Tenang-42');
    submit();

    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    await screen.findByRole('heading', { level: 1, name: t.nav.settings });
    const login = api.requests.find((request) => request.path === API_ROUTES.auth.login);
    expect(login?.body).toEqual({ email: 'rina@majujaya.co.id', password: 'Kopi-Senja-Tenang-42' });

    // Keluar memakai token CSRF dari respons masuk.
    // Menu Radix dibuka lewat keyboard (jsdom tidak mengirim pointer event).
    fireEvent.keyDown(
      await screen.findByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }),
      { key: 'Enter' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    const logout = api.requests.find((request) => request.path === API_ROUTES.auth.logout);
    expect(logout?.headers[CSRF_HEADER_NAME]).toBe('csrf-setelah-masuk');
    expect(await screen.findByText(t.auth.login.loggedOut)).toBeVisible();
  });

  it('401 kredensial salah: pesan server apa adanya, tetap di halaman masuk', async () => {
    const message = 'Email atau password salah. Periksa lagi lalu coba masuk kembali.';
    const { router } = await renderApp('/masuk', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.auth.login}`]: () => apiError(401, 'INVALID_CREDENTIALS', message),
      },
    });
    await screen.findByRole('heading', { level: 1 });

    fill('rina@majujaya.co.id', 'salah');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(router.state.location.pathname).toBe('/masuk');
    await waitFor(() => expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus());
  });

  it('429 terkunci: sisa waktu di tombol (bukan di wilayah alert), lalu aktif lagi dan diumumkan sekali', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderApp('/masuk', {
        session: null,
        routes: {
          [`POST ${API_ROUTES.auth.login}`]: () =>
            apiError(429, 'RATE_LIMITED', 'Akun ini dikunci sementara. Coba lagi dalam 2 menit.', {
              retryAfter: 65,
            }),
        },
      });
      await screen.findByRole('heading', { level: 1 });

      fill('rina@majujaya.co.id', 'salah');
      submit();

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(t.auth.login.lockedTitle)).toBeVisible();
      expect(alert).toHaveTextContent('Coba lagi dalam 2 menit.');
      // Hitung mundur tidak boleh ada di dalam role="alert" (diumumkan berulang).
      expect(alert.textContent).not.toMatch(/\d[.:]\d{2}/);
      const locked = screen.getByRole('button', { name: 'Coba lagi dalam 1:05' });
      expect(locked).toBeDisabled();
      // Gaya terkunci (tidak dipudarkan) dipasang lewat atribut ini (kritikus W6).
      expect(locked).toHaveAttribute('data-locked');
      // N2: fokus tidak jatuh ke <body>; isian password tetap aktif selama terkunci.
      const password = screen.getByLabelText(t.auth.login.password);
      await waitFor(() => expect(password).toHaveFocus());
      expect(password).toBeEnabled();
      const status = screen
        .getAllByRole('status')
        .find((element) => element.classList.contains('sr-only'));
      expect(status).toHaveTextContent('');

      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(
        screen.getByRole('button', { name: t.auth.login.countdownButton('1:03') }),
      ).toBeDisabled();
      // Tes ini mengecek fokus ke password saat kunci habis: pindahkan fokus dulu.
      password.blur();

      await act(() => vi.advanceTimersByTimeAsync(64_000));
      const unlockedButton = screen.getByRole('button', { name: t.auth.login.submit });
      expect(unlockedButton).toBeEnabled();
      // Kunci habis: kembali ke gaya tombol utama biasa.
      expect(unlockedButton).not.toHaveAttribute('data-locked');
      // Pesan kunci yang sudah basi hilang; pembaca layar diberi tahu sekali; fokus ke password.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(status).toHaveTextContent(t.auth.login.unlocked);
      await waitFor(() => expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus());
    } finally {
      vi.useRealTimers();
    }
  });

  it('503: pesan server ditampilkan, fokus kembali ke isian password', async () => {
    await renderApp('/masuk', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.auth.login}`]: () =>
          apiError(
            503,
            'SERVICE_UNAVAILABLE',
            'Layanan sedang tidak tersedia. Coba lagi beberapa saat lagi.',
          ),
      },
    });
    await screen.findByRole('heading', { level: 1 });
    fill('rina@majujaya.co.id', 'apa-saja');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Layanan sedang tidak tersedia.');
    await waitFor(() => expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus());
  });

  it('jaringan putus: pesan jaringan ditampilkan, fokus kembali ke isian password', async () => {
    await renderApp('/masuk', {
      session: null,
      routes: {
        [`POST ${API_ROUTES.auth.login}`]: () => Promise.reject(new TypeError('Failed to fetch')),
      },
    });
    await screen.findByRole('heading', { level: 1 });
    fill('rina@majujaya.co.id', 'apa-saja');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(t.api.network);
    await waitFor(() => expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus());
  });
});
