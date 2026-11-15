/**
 * Review keamanan Fase 2 — layar Channel di web (docs/security-reviews/2026-11-16-fase2-channel-web.md).
 * Penjaga regresi: token Meta, App Secret, dan isian konfirmasi identitas tidak tertinggal di cache
 * TanStack Query, storage, URL/riwayat, DOM (termasuk atribut), maupun konsol setelah disimpan; peran
 * tanpa `channels.manage` tidak pernah memanggil API Pengaturan → Channel.
 */
import { API_ROUTES, USER_ROLES, apiPath, type UserRole } from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { t } from '../../i18n/id';
import { fakeChannel, fakeSession, json, type FakeRequest } from '../../test/fake-api';
import { confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

// Nilai unik supaya pencarian teks tidak salah cocok dengan isi lain di layar.
const TOKEN = `EAAGreviewTokenUnik${'R'.repeat(32)}`;
const NEW_TOKEN = `EAAGreviewTokenBaru${'N'.repeat(32)}`;
const SECRET = '7a1c3e5b9d2f4a6c8e0b1d3f5a7c9e2b';
const PASSWORD = 'Sandi-Review-Unik-7731';
const CODE = '907153';
const SECRETS = [TOKEN, NEW_TOKEN, SECRET, PASSWORD, CODE] as const;
const SLOW = { timeout: 5_000 };

const wizard = t.channels.wizard;
const created = fakeChannel({
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e09',
  status: 'untested',
  lastTest: null,
  number: null,
});
const webhook = {
  channelId: created.id,
  callbackUrl: `https://balesin.contoh.co.id/webhooks/whatsapp/${created.id}`,
  verifyToken: 'q7Vb2kLx9TzR4mWn8PcY3sHd6JfA1uGe5oKi0NvB2xE',
  verifyTokenRotatedAt: '2026-11-14T02:00:00.000Z',
  subscribeFields: ['messages'],
  warning: null,
};

let consoleSpies: MockInstance[] = [];
beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level),
  );
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

/** Semua tempat di browser yang bisa menyimpan sisa rahasia setelah disimpan. */
function leftovers(queryClient: QueryClient, router: { state: { location: unknown } }): string {
  return JSON.stringify({
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, data: query.state.data })),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
    location: router.state.location,
    href: window.location.href,
    history: window.history.state as unknown,
    // outerHTML memuat atribut (`value="…"` dari sinkronisasi atribut React, `data-*`, `title`).
    dom: document.documentElement.outerHTML,
    console: consoleSpies.map((spy) => spy.mock.calls),
  });
}

function expectNoSecrets(snapshot: string) {
  for (const secret of SECRETS) expect(snapshot).not.toContain(secret);
}

const next = () => fireEvent.click(screen.getByRole('button', { name: wizard.next }));
const heading = (name: string) => screen.findByRole('heading', { level: 2, name }, SLOW);
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('rahasia tidak tertinggal setelah disimpan', () => {
  it('wizard: token, App Secret, password & kode konfirmasi tidak ada di cache/storage/URL/DOM/konsol', async () => {
    const { router, queryClient } = await renderApp('/pengaturan/channel/tambah', {
      routes: {
        [`POST ${API_ROUTES.channels.settings}`]: () =>
          json({ channel: created, webhook }, { status: 201 }),
        [`GET ${apiPath(API_ROUTES.channels.channel, { channelId: created.id })}`]: () =>
          json({ channel: created }),
        [`GET ${apiPath(API_ROUTES.channels.webhook, { channelId: created.id })}`]: () =>
          json(webhook),
      },
    });
    await heading(wizard.steps.business.title);
    next();
    await heading(wizard.steps.app.title);
    next();
    await heading(wizard.steps.number.title);
    next();
    await heading(wizard.steps.ids.title);
    fill(wizard.steps.ids.name, 'CS Review');
    fill(wizard.steps.ids.phoneNumberId, '106540352242922');
    fill(wizard.steps.ids.wabaId, '102290129340398');
    next();
    await heading(wizard.steps.token.title);
    fill(wizard.steps.token.label, TOKEN);
    next();
    await heading(wizard.steps.secret.title);
    fill(wizard.steps.secret.label, SECRET);
    fireEvent.click(screen.getByRole('button', { name: wizard.save }));
    await confirmIdentity(wizard.confirmTitle, wizard.save, { password: PASSWORD, code: CODE });
    await heading(wizard.steps.webhook.title);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expectNoSecrets(leftovers(queryClient, router));
  });

  it('ganti kredensial: setelah tersimpan token baru & konfirmasi tidak tersisa; form tidak pernah memuat nilai lama', async () => {
    const channel = fakeChannel();
    const at = (route: string) => apiPath(route, { channelId: channel.id });
    const { router, queryClient, api } = await renderApp(`/pengaturan/channel/${channel.id}`, {
      routes: {
        [`GET ${at(API_ROUTES.channels.channel)}`]: () => json({ channel }),
        [`GET ${at(API_ROUTES.channels.webhook)}`]: () =>
          json({ ...webhook, channelId: channel.id }),
        [`GET ${at(API_ROUTES.channels.businessProfile)}`]: () =>
          json({
            profile: {
              about: 'Info',
              address: null,
              description: null,
              email: null,
              websites: [],
              vertical: '',
            },
            fetchedAt: '2026-11-14T02:00:00.000Z',
          }),
        [`PATCH ${at(API_ROUTES.channels.channel)}`]: () =>
          json({ channel: { ...channel, status: 'untested', lastTest: null, number: null } }),
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: t.channels.credentials.change }, SLOW),
    );
    const token = screen.getByLabelText(new RegExp(`^${t.channels.credentials.token}`));
    const appSecret = screen.getByLabelText(new RegExp(`^${t.channels.credentials.appSecret}`));
    // Nilai lama tidak pernah ada di browser: isian rahasia kosong, hanya petunjuk tersamar.
    expect(token).toHaveValue('');
    expect(appSecret).toHaveValue('');
    expect(token).toHaveAttribute('type', 'password');

    fireEvent.change(token, { target: { value: NEW_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: t.channels.credentials.save }));
    await confirmIdentity(t.channels.credentials.confirmTitle, t.channels.credentials.save, {
      password: PASSWORD,
      code: CODE,
    });
    expect(await screen.findByText(t.channels.credentials.saved, {}, SLOW)).toBeInTheDocument();
    const patch = api.requests.find((request: FakeRequest) => request.method === 'PATCH');
    expect(patch?.body).toMatchObject({ accessToken: NEW_TOKEN });

    expectNoSecrets(leftovers(queryClient, router));
  });
});

describe('R1 — selama form terbuka, React menyalin isian rahasia ke atribut `value` di DOM', () => {
  // React menyinkronkan atribut `value` untuk input terkendali: `<input type="password"
  // value="EAAG…">` terlihat di DevTools, ikut terekam alat perekam DOM/sesi, dan bisa dibaca
  // pemilih atribut CSS. Setelah disimpan/ditutup inputnya dilepas (penjaga di atas lulus).
  it.fails('isian token di form ganti kredensial tidak muncul sebagai atribut value', async () => {
    const channel = fakeChannel();
    const at = (route: string) => apiPath(route, { channelId: channel.id });
    await renderApp(`/pengaturan/channel/${channel.id}`, {
      routes: {
        [`GET ${at(API_ROUTES.channels.channel)}`]: () => json({ channel }),
        [`GET ${at(API_ROUTES.channels.webhook)}`]: () =>
          json({ ...webhook, channelId: channel.id }),
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: t.channels.credentials.change }, SLOW),
    );
    const token = screen.getByLabelText(new RegExp(`^${t.channels.credentials.token}`));
    fireEvent.change(token, { target: { value: NEW_TOKEN } });
    expect(token).toHaveValue(NEW_TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(NEW_TOKEN); // saat ini value="…"
  });
});

describe('izin rute', () => {
  const blocked = USER_ROLES.filter(
    (role): role is UserRole => role !== 'owner' && role !== 'admin',
  );
  const channel = fakeChannel();
  for (const role of blocked) {
    for (const path of [
      '/pengaturan/channel',
      '/pengaturan/channel/tambah',
      `/pengaturan/channel/${channel.id}`,
    ]) {
      it(`${role} di ${path} → dialihkan, tanpa memanggil API Pengaturan → Channel`, async () => {
        const { router, api } = await renderApp(path, { session: fakeSession(role) });
        await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
        expect(
          api.requests.filter((request) => request.path.startsWith(API_ROUTES.channels.settings)),
        ).toEqual([]);
      });
    }
  }
});
