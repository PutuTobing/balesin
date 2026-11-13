import { API_ROUTES } from '@balesin/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeRequest } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const TOKEN = 'token-setup-yang-panjang-1234567890';
const freshInstall = { needsSetup: true, setupTokenConfigured: true, canStoreSecrets: true };
const steps = t.setup.steps;

const next = () => fireEvent.click(screen.getByRole('button', { name: t.setup.next }));
/** Label isian opsional memuat penanda "opsional", jadi dicocokkan dari awal teksnya. */
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });

async function heading(name: string) {
  return screen.findByRole('heading', { level: 1, name });
}

function setupRoutes(extra: Record<string, (request: FakeRequest) => Response> = {}) {
  return {
    [`POST ${API_ROUTES.setup.verifyToken}`]: (request: FakeRequest) =>
      (request.body as { setupToken: string }).setupToken === TOKEN
        ? json({ valid: true })
        : apiError(403, 'FORBIDDEN', 'Token setup salah.'),
    [`POST ${API_ROUTES.setup.checkPassword}`]: () => json({ acceptable: true, message: null }),
    ...extra,
  };
}

/** Isi langkah Organisasi dan Owner sampai langkah Tampilan. */
async function fillToBranding() {
  await heading(steps.organization.title);
  type(steps.organization.name, 'PT Maju Jaya');
  next();
  await heading(steps.owner.title);
  type(steps.owner.name, 'Rina Kartika');
  type(steps.owner.email, 'rina@majujaya.co.id');
  type(steps.owner.password, 'Kopi-Senja-Tenang-42');
  type(steps.owner.repeat, 'Kopi-Senja-Tenang-42');
  next();
  await heading(steps.branding.title);
}

describe('wizard setup', () => {
  it('token dari #token= dibaca, dihapus dari alamat, diperiksa, lalu langsung ke Organisasi', async () => {
    const { router, api } = await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes(),
    });

    const title = await heading(steps.organization.title);
    expect(router.state.location.hash).toBe('');
    expect(router.history.location.href).not.toContain(TOKEN);
    expect(api.requests.find((r) => r.path === API_ROUTES.setup.verifyToken)?.body).toEqual({
      setupToken: TOKEN,
    });
    expect(title).toHaveFocus();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('token salah: pesan server di kolom token, tetap di langkah Token', async () => {
    await renderApp('/setup', { session: null, setupStatus: freshInstall, routes: setupRoutes() });
    await heading(steps.token.title);

    type(steps.token.label, 'token-salah');
    next();

    expect(await screen.findByText('Token setup salah.')).toBeVisible();
    expect(screen.getByLabelText(steps.token.label)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(steps.token.title);
  });

  it('password ditolak server: tidak lanjut, alasannya tampil di isian password', async () => {
    await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes({
        [`POST ${API_ROUTES.setup.checkPassword}`]: () =>
          json({ acceptable: false, message: 'Password ini terlalu umum.' }),
      }),
    });
    await heading(steps.organization.title);
    type(steps.organization.name, 'PT Maju Jaya');
    next();
    await heading(steps.owner.title);
    type(steps.owner.name, 'Rina Kartika');
    type(steps.owner.email, 'rina@majujaya.co.id');
    type(steps.owner.password, 'password12345');
    type(steps.owner.repeat, 'password12345');
    next();

    await waitFor(() =>
      expect(screen.getByLabelText(steps.owner.password)).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getAllByText('Password ini terlalu umum.').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(steps.owner.title);
  });

  it('kembali ke langkah sebelumnya tidak menghapus isian', async () => {
    await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes(),
    });
    await fillToBranding();

    fireEvent.click(screen.getByRole('button', { name: t.setup.back }));
    await heading(steps.owner.title);
    expect(screen.getByLabelText(steps.owner.name)).toHaveValue('Rina Kartika');
    expect(screen.getByLabelText(steps.owner.password)).toHaveValue('Kopi-Senja-Tenang-42');
  });

  it('warna dengan kontras rendah memunculkan peringatan, tetapi tidak menghalangi', async () => {
    await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes(),
    });
    await fillToBranding();

    type(steps.branding.color, '#7fb3ff');
    expect(await screen.findByText(/Kontras dengan putih hanya 2,1:1/)).toBeVisible();
    type(steps.branding.color, '#1b3557');
    expect(await screen.findByText(/Kontras dengan putih 12,4:1/)).toBeVisible();
    next();
    expect(await heading(steps.email.title)).toBeVisible();
  });

  it('error dari "Selesai" dipetakan ke langkah yang tepat lewat awalan field', async () => {
    const view = await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes({
        [`POST ${API_ROUTES.setup.complete}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
            details: [{ field: 'owner.email', message: 'Email ini tidak bisa dipakai.' }],
          }),
      }),
    });
    const api = view.api;
    await fillToBranding();
    next();
    await heading(steps.email.title);
    fireEvent.click(screen.getByRole('button', { name: t.setup.skip }));
    await heading(steps.summary.title);
    fireEvent.click(screen.getByRole('button', { name: steps.summary.submit }));

    expect(await heading(steps.owner.title)).toHaveFocus();
    expect(screen.getByText('Email ini tidak bisa dipakai.')).toBeVisible();
    expect(screen.getByLabelText(steps.owner.email)).toHaveAttribute('aria-invalid', 'true');
    const body = api.requests.find((r) => r.path === API_ROUTES.setup.complete)?.body;
    expect(body).toMatchObject({ email: null, organization: { name: 'PT Maju Jaya' } });
  });

  it('setup selesai → Owner langsung masuk ke Inbox', async () => {
    const view = await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: freshInstall,
      routes: setupRoutes({
        [`POST ${API_ROUTES.setup.complete}`]: () => {
          view.api.setSession(fakeSession());
          return json(fakeSession(), { status: 201 });
        },
      }),
    });
    await fillToBranding();
    fireEvent.click(screen.getByRole('button', { name: t.setup.skip }));
    await heading(steps.email.title);
    fireEvent.click(screen.getByRole('button', { name: t.setup.skip }));
    await heading(steps.summary.title);
    expect(screen.getByText(steps.summary.emailSkipped)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: steps.summary.submit }));

    await waitFor(() => expect(view.router.state.location.pathname).toBe('/inbox'));
    expect(await screen.findByRole('heading', { level: 1, name: t.inbox.title })).toBeVisible();
  });

  it('409 di tengah wizard → layar "Setup sudah selesai" dengan jalan ke halaman masuk', async () => {
    await renderApp('/setup', {
      session: null,
      setupStatus: freshInstall,
      routes: {
        [`POST ${API_ROUTES.setup.verifyToken}`]: () =>
          apiError(409, 'CONFLICT', 'Setup sudah selesai.'),
      },
    });
    await heading(steps.token.title);
    type(steps.token.label, TOKEN);
    next();

    expect(await heading(t.setup.blocked.doneTitle)).toBeVisible();
    expect(screen.getByRole('link', { name: t.setup.blocked.goToLogin })).toHaveAttribute(
      'href',
      '/masuk',
    );
  });

  it('token belum diatur di server → petunjuk mengisi SETUP_TOKEN', async () => {
    await renderApp('/setup', {
      session: null,
      setupStatus: { needsSetup: true, setupTokenConfigured: false, canStoreSecrets: true },
    });
    expect(await heading(t.setup.blocked.noTokenTitle)).toBeVisible();
    expect(screen.getByText(/SETUP_TOKEN/)).toBeVisible();
  });

  it('master key belum diisi → langkah Email hanya berisi petunjuk dan bisa langsung lanjut', async () => {
    await renderApp(`/setup#token=${TOKEN}`, {
      session: null,
      setupStatus: { ...freshInstall, canStoreSecrets: false },
      routes: setupRoutes(),
    });
    await fillToBranding();
    next();
    await heading(steps.email.title);
    expect(screen.getByText(steps.email.noMasterKeyTitle)).toBeVisible();
    expect(screen.queryByLabelText(t.emailSettings.host)).toBeNull();
    expect(screen.queryByRole('button', { name: t.setup.skip })).toBeNull();
    next();
    expect(await heading(steps.summary.title)).toBeVisible();
  });
});
