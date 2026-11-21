import { API_ROUTES } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeEmailVerification,
  fakeSession,
  json,
  type FakeApiOptions,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const copy = t.verifyEmail;
const email = t.security.email;
const TOKEN = 'Q2FrU2t5LVRlcy1Ub2tlbi1Db250b2gtVmVyaWZpa2FzaT';

describe('/verifikasi-email', () => {
  it('token dikirim SEKALI di body, dibuang dari alamat; berhasil tanpa perlu sedang masuk', async () => {
    const view = await renderApp(`/verifikasi-email#token=${TOKEN}`, {
      session: null,
      routes: {
        [`POST ${API_ROUTES.emailVerification.verify}`]: () =>
          json({ status: 'verified', email: 'rina@majujaya.co.id' }),
      },
    });
    const heading = await screen.findByRole('heading', { level: 1, name: copy.doneTitle });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(copy.done('rina@majujaya.co.id'))).toBeVisible();
    expect(screen.getByRole('link', { name: t.links.toLogin })).toBeVisible();
    const calls = view.api.requests.filter((r) => r.path === API_ROUTES.emailVerification.verify);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ token: TOKEN });
    expect(view.router.state.location.hash).toBe('');
    expect(view.router.history.location.href).not.toContain(TOKEN);
  });

  it('sedang masuk: tombol ke aplikasi', async () => {
    await renderApp(`/verifikasi-email#token=${TOKEN}`, {
      session: fakeSession('owner'),
      routes: {
        [`POST ${API_ROUTES.emailVerification.verify}`]: () =>
          json({ status: 'verified', email: 'rina@majujaya.co.id' }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: copy.doneTitle });
    expect(screen.getByRole('link', { name: copy.toApp })).toHaveAttribute('href', '/inbox');
  });

  it('410 → penjelasan dengan pesan server', async () => {
    const message = 'Tautan verifikasi ini sudah kedaluwarsa (berlaku 24 jam).';
    await renderApp(`/verifikasi-email#token=${TOKEN}`, {
      session: null,
      routes: {
        [`POST ${API_ROUTES.emailVerification.verify}`]: () =>
          apiError(410, 'TOKEN_INVALID', message),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: copy.invalidTitle })).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
  });

  it('gagal jaringan → "Coba lagi" mengirim ulang token yang sama', async () => {
    let calls = 0;
    const view = await renderApp(`/verifikasi-email#token=${TOKEN}`, {
      session: null,
      routes: {
        [`POST ${API_ROUTES.emailVerification.verify}`]: () => {
          calls += 1;
          return calls === 1
            ? apiError(503, 'SERVICE_UNAVAILABLE', 'Server sedang sibuk. Coba lagi sebentar.')
            : json({ status: 'verified', email: 'rina@majujaya.co.id' });
        },
      },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: t.links.failedTitle }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t.common.retry }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.doneTitle })).toBeVisible();
    const sent = view.api.requests.filter((r) => r.path === API_ROUTES.emailVerification.verify);
    expect(sent.map((r) => r.body)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
  });
});

async function openSecurity(options: FakeApiOptions) {
  await renderApp('/pengaturan/keamanan', {
    session: fakeSession('owner'),
    ...options,
  });
  await screen.findByRole('heading', { level: 1, name: t.security.title });
  return within(screen.getByRole('region', { name: email.title }));
}

describe('Keamanan akun: kartu Email akun', () => {
  it('terverifikasi: lencana + tanggal, tanpa tombol kirim', async () => {
    const card = await openSecurity({ emailVerification: fakeEmailVerification() });
    expect(card.getByText(email.verified)).toBeVisible();
    expect(card.getByText('rina@majujaya.co.id')).toBeVisible();
    expect(card.queryByRole('button')).toBeNull();
  });

  it('belum terverifikasi: kirim email verifikasi (CSRF) → pesan terkirim; 409 memuat ulang status', async () => {
    const card = await openSecurity({
      emailVerification: fakeEmailVerification({ verified: false, verifiedAt: null }),
      routes: {
        [`POST ${API_ROUTES.emailVerification.status}`]: () =>
          json({ status: 'queued', expiresAt: '2026-11-15T03:00:00.000Z' }, { status: 202 }),
      },
    });
    expect(card.getByText(email.unverified)).toBeVisible();
    fireEvent.click(card.getByRole('button', { name: email.send }));
    expect(await card.findByText(email.sent('rina@majujaya.co.id'))).toBeVisible();
    expect(card.getByRole('button', { name: email.resend })).toBeVisible();
  });

  it('belum terverifikasi tanpa email pengirim: Owner diarahkan ke Email pengirim, peran lain diberi tahu', async () => {
    const card = await openSecurity({
      emailVerification: fakeEmailVerification({
        verified: false,
        verifiedAt: null,
        canSend: false,
      }),
    });
    expect(card.queryByRole('button', { name: email.send })).toBeNull();
    expect(card.getByRole('link', { name: email.setUpSender })).toHaveAttribute(
      'href',
      '/pengaturan/email',
    );
  });

  it('429: tombol terkunci dengan hitung mundur', async () => {
    const card = await openSecurity({
      emailVerification: fakeEmailVerification({ verified: false, verifiedAt: null }),
      routes: {
        [`POST ${API_ROUTES.emailVerification.status}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Terlalu banyak email verifikasi dalam satu jam.', {
            retryAfter: 1800,
          }),
      },
    });
    fireEvent.click(card.getByRole('button', { name: email.send }));
    expect(await card.findByRole('alert')).toHaveTextContent(email.lockedTitle);
    expect(card.getByRole('button', { name: /30:00|29:59/ })).toBeDisabled();
  });

  it('CS tanpa email pengirim: penjelasan tanpa tautan pengaturan', async () => {
    await renderApp('/pengaturan/keamanan', {
      session: fakeSession('cs'),
      emailVerification: fakeEmailVerification({
        verified: false,
        verifiedAt: null,
        canSend: false,
      }),
    });
    await screen.findByRole('heading', { level: 1, name: t.security.title });
    const card = within(screen.getByRole('region', { name: email.title }));
    expect(card.getByText(email.noSender)).toBeVisible();
    expect(card.queryByRole('link')).toBeNull();
  });
});
