import { API_ROUTES, type NotificationPreferences } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { applyUpdate, resetServiceWorkerState } from '../../pwa/service-worker';
import { brandedManifest } from '../../brand/web-manifest';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import {
  FAKE_ENDPOINT,
  FAKE_KEYS,
  FAKE_VAPID,
  installFakePush,
  type FakePush,
} from '../../test/fake-push';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { media } from '../../lib/media';
import { base64UrlToBytes } from './push-device';

const copy = t.notifications;
const PATH = '/pengaturan/notifikasi';

const preferences: NotificationPreferences = {
  queue: true,
  assignedMessage: true,
  assignedToMe: true,
  quietHours: null,
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.notifications.preferences}`]: () =>
      json({ preferences, timezone: 'Asia/Jakarta', devices: 1 }),
    [`PUT ${API_ROUTES.notifications.preferences}`]: ({ body }) =>
      json({ preferences: body, timezone: 'Asia/Jakarta', devices: 1 }),
    [`GET ${API_ROUTES.notifications.vapidPublicKey}`]: () => json({ publicKey: FAKE_VAPID }),
    [`POST ${API_ROUTES.notifications.subscriptions}`]: () =>
      json(
        {
          subscription: {
            id: '6f1c2a90-3333-4c4c-9a9a-000000000001',
            createdAt: '2026-11-17T03:00:00.000Z',
          },
        },
        { status: 201 },
      ),
    [`DELETE ${API_ROUTES.notifications.subscriptions}`]: () => json({ deleted: true }),
    [`POST ${API_ROUTES.notifications.test}`]: () => json({ devices: 2 }),
    [`GET ${API_ROUTES.notifications.settings}`]: () =>
      json({ settings: { preview: false, contactName: false } }),
    [`PUT ${API_ROUTES.notifications.settings}`]: ({ body }) => json({ settings: body }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

let push: FakePush | null = null;
afterEach(() => {
  push?.uninstall();
  push = null;
  resetServiceWorkerState();
});

describe('perangkat ini', () => {
  it('izin diminta hanya setelah klik; berlangganan lalu didaftarkan ke server', async () => {
    push = installFakePush();
    const { api } = await renderApp(PATH, { routes: routes() });
    const enable = await screen.findByRole('button', { name: copy.enable });
    expect(push.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(enable);
    expect(await screen.findByText(copy.enabled)).toBeVisible();
    expect(push.requestPermission).toHaveBeenCalledOnce();
    const options = push.subscribe.mock.calls[0]?.[0] as PushSubscriptionOptionsInit;
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toEqual(base64UrlToBytes(FAKE_VAPID));
    expect(requestsTo(api, 'POST', API_ROUTES.notifications.subscriptions)[0]?.body).toEqual({
      endpoint: FAKE_ENDPOINT,
      expirationTime: null,
      keys: FAKE_KEYS,
    });
    expect(await screen.findByText(copy.statusOn)).toBeVisible();
  });

  it('izin tidak diberikan: pesan jelas, tidak ada langganan', async () => {
    push = installFakePush({ grant: 'default' });
    const { api } = await renderApp(PATH, { routes: routes() });
    fireEvent.click(await screen.findByRole('button', { name: copy.enable }));
    expect(await screen.findByText(copy.permissionDismissed)).toBeVisible();
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(requestsTo(api, 'POST', API_ROUTES.notifications.subscriptions)).toHaveLength(0);
  });

  it('sudah aktif: kirim tes, lalu lepas perangkat (DELETE + unsubscribe)', async () => {
    push = installFakePush({ permission: 'granted', subscribed: true });
    const { api } = await renderApp(PATH, { routes: routes() });
    fireEvent.click(await screen.findByRole('button', { name: copy.test }));
    expect(await screen.findByText(copy.testSent(2))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: copy.disable }));
    expect(await screen.findByText(copy.disabled)).toBeVisible();
    expect(requestsTo(api, 'DELETE', API_ROUTES.notifications.subscriptions)[0]?.body).toEqual({
      endpoint: FAKE_ENDPOINT,
    });
    expect(push.unsubscribe).toHaveBeenCalled();
  });

  it('izin diblokir: cara membukanya, tanpa tombol aktifkan', async () => {
    push = installFakePush({ permission: 'denied' });
    await renderApp(PATH, { routes: routes() });
    expect(await screen.findByText(copy.blockedTitle)).toBeVisible();
    expect(screen.queryByRole('button', { name: copy.enable })).toBeNull();
  });

  it('browser tanpa Web Push: penjelasan (iPhone non-PWA → Tambah ke Layar Utama)', async () => {
    const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1',
      configurable: true,
    });
    try {
      await renderApp(PATH, { routes: routes() });
      expect(await screen.findByText(copy.iosTitle)).toBeVisible();
    } finally {
      Reflect.deleteProperty(navigator, 'userAgent');
      if (userAgent) expect(navigator.userAgent).toBeTruthy();
    }
  });

  it('browser lain tanpa Web Push: tidak didukung', async () => {
    await renderApp(PATH, { routes: routes() });
    expect(await screen.findByText(copy.unsupportedTitle)).toBeVisible();
  });
});

describe('preferensi', () => {
  it('simpan preferensi + jam tenang; jam sama ditolak', async () => {
    push = installFakePush();
    const { api } = await renderApp(PATH, { routes: routes() });
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(copy.assignedToMe) }));
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(copy.quietHours) }));
    fireEvent.change(screen.getByLabelText(copy.quietStart), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText(copy.quietEnd), { target: { value: '22:00' } });
    fireEvent.click(screen.getByRole('button', { name: copy.savePrefs }));
    expect(await screen.findByText('Jam mulai dan selesai tidak boleh sama.')).toBeVisible();

    fireEvent.change(screen.getByLabelText(copy.quietEnd), { target: { value: '06:30' } });
    fireEvent.click(screen.getByRole('button', { name: copy.savePrefs }));
    expect(await screen.findByText(copy.prefsSaved)).toBeVisible();
    expect(requestsTo(api, 'PUT', API_ROUTES.notifications.preferences)[0]?.body).toEqual({
      queue: true,
      assignedMessage: true,
      assignedToMe: false,
      quietHours: { start: '22:00', end: '06:30' },
    });
  });

  it('Teknisi: tanpa pilihan antrian dan tanpa bagian organisasi', async () => {
    await renderApp(PATH, { routes: routes(), session: fakeSession('teknisi') });
    expect(
      await screen.findByRole('checkbox', { name: new RegExp(copy.assignedMessage) }),
    ).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: new RegExp(copy.queue) })).toBeNull();
    expect(screen.queryByRole('heading', { name: copy.orgTitle })).toBeNull();
  });

  it('Owner: nama kontak & cuplikan bawaan mati, bisa dinyalakan', async () => {
    const { api } = await renderApp(PATH, { routes: routes() });
    const card = within(
      (await screen.findByRole('heading', { name: copy.orgTitle })).closest('section')!,
    );
    const contactName = await card.findByRole('checkbox', { name: new RegExp(copy.contactName) });
    expect(contactName).not.toBeChecked();
    expect(card.getByRole('checkbox', { name: new RegExp(copy.preview) })).not.toBeChecked();
    fireEvent.click(contactName);
    fireEvent.click(card.getByRole('button', { name: copy.saveOrg }));
    expect(await card.findByText(copy.orgSaved)).toBeVisible();
    expect(requestsTo(api, 'PUT', API_ROUTES.notifications.settings)[0]?.body).toEqual({
      preview: false,
      contactName: true,
    });
  });
});

describe('keluar', () => {
  it('perangkat yang berlangganan dilepas di server sebelum logout', async () => {
    push = installFakePush({ permission: 'granted', subscribed: true });
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp('/pengaturan', { routes: routes() });
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Akun / }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
    await waitFor(() =>
      expect(requestsTo(api, 'DELETE', API_ROUTES.notifications.subscriptions)).toHaveLength(1),
    );
    const order = api.requests.map((request) => `${request.method} ${request.path}`);
    expect(order.indexOf(`DELETE ${API_ROUTES.notifications.subscriptions}`)).toBeLessThan(
      order.indexOf(`POST ${API_ROUTES.auth.logout}`),
    );
    await waitFor(() => expect(push?.unsubscribe).toHaveBeenCalled());
  });
});

describe('PWA', () => {
  it('manifest bermerek: nama organisasi; ikon dari logo menggantikan SELURUH ikon bawaan', () => {
    const base = {
      id: '/',
      start_url: '/inbox',
      scope: '/',
      name: 'Bawaan',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    };
    const icons = {
      favicon: '/api/v1/branding/icons/favicon-32.png?v=1',
      appleTouchIcon: '/api/v1/branding/icons/apple-touch-icon.png?v=1',
      manifest: [
        {
          src: '/api/v1/branding/icons/icon-192.png?v=1',
          sizes: '192x192',
          type: 'image/png' as const,
          purpose: 'any' as const,
        },
        {
          src: '/api/v1/branding/icons/maskable-512.png?v=1',
          sizes: '512x512',
          type: 'image/png' as const,
          purpose: 'maskable' as const,
        },
      ],
    };
    const manifest = brandedManifest(
      base,
      { productName: 'Halo Pelanggan Nusantara', icons },
      'https://inbox.contoh.test',
    );
    expect(manifest.name).toBe('Halo Pelanggan Nusantara');
    expect(manifest.short_name).toBe('Halo Pelangg');
    expect(manifest.start_url).toBe('https://inbox.contoh.test/inbox');
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([
      'https://inbox.contoh.test/api/v1/branding/icons/icon-192.png?v=1',
      'https://inbox.contoh.test/api/v1/branding/icons/maskable-512.png?v=1',
    ]);
    // Tanpa logo: ikon bawaan produk.
    const plain = brandedManifest(
      base,
      { productName: 'X', icons: null },
      'https://inbox.contoh.test',
    );
    expect(plain.icons?.[0]?.src).toBe('https://inbox.contoh.test/icons/icon-192.png');
  });

  it('tanpa versi baru yang menunggu, "Muat ulang" memuat ulang halaman', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      configurable: true,
    });
    act(() => applyUpdate());
    expect(reload).toHaveBeenCalled();
  });
});
