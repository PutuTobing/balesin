import type { Page } from '@playwright/test';
import { apiError, json } from './mocks';
import { inboxMocks } from './mocks-inbox';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 2 butir 10: Pengaturan → Notifikasi (semua keadaan perangkat) dan banner "Versi baru
 * tersedia". Browser API (Notification, PushManager, service worker) diganti tiruan lewat
 * `addInitScript` supaya setiap keadaan bisa difoto tanpa layanan push sungguhan.
 */
const API = '**/api/v1';
const PATH = '/pengaturan/notifikasi';

interface DeviceOptions {
  support?: 'supported' | 'ios' | 'unsupported';
  permission?: 'default' | 'granted' | 'denied';
  subscribed?: boolean;
  /** Ada versi baru service worker yang menunggu. */
  updateWaiting?: boolean;
}

async function fakeDevice(page: Page, options: DeviceOptions = {}): Promise<void> {
  await page.addInitScript((device: DeviceOptions) => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/foto';
    let subscribed = device.subscribed === true;
    let permission = device.permission ?? 'default';
    const subscription = () => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
      }),
      unsubscribe: () => {
        subscribed = false;
        return Promise.resolve(true);
      },
    });
    const registration = {
      waiting: device.updateWaiting ? { postMessage: () => undefined } : null,
      installing: null,
      addEventListener: () => undefined,
      update: () => Promise.resolve(),
      pushManager: {
        getSubscription: () => Promise.resolve(subscribed ? subscription() : null),
        subscribe: () => {
          subscribed = true;
          return Promise.resolve(subscription());
        },
      },
    };
    const container = {
      controller: {},
      ready: Promise.resolve(registration),
      register: () => Promise.resolve(registration),
      addEventListener: () => undefined,
    };
    Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
    if (device.support === 'ios' || device.support === 'unsupported') {
      Reflect.deleteProperty(window, 'PushManager');
      Reflect.deleteProperty(window, 'Notification');
      if (device.support === 'ios') {
        Object.defineProperty(navigator, 'userAgent', {
          value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1',
          configurable: true,
        });
      }
      return;
    }
    const notification = function Notification() {};
    Object.defineProperty(notification, 'permission', { get: () => permission });
    Object.defineProperty(notification, 'requestPermission', {
      value: () => {
        permission = 'granted';
        return Promise.resolve(permission);
      },
    });
    Object.defineProperty(window, 'Notification', { value: notification, configurable: true });
    if (!('PushManager' in window)) {
      Object.defineProperty(window, 'PushManager', { value: function PushManager() {} });
    }
  }, options);
}

async function notificationMocks(
  page: Page,
  options: { quiet?: boolean; preferences?: 'ok' | 'hang' | 'fail' } = {},
): Promise<void> {
  const preferences = {
    queue: true,
    assignedMessage: true,
    assignedToMe: true,
    quietHours: options.quiet ? { start: '21:00', end: '07:00' } : null,
  };
  await page.route(`${API}/notifications/preferences`, (route) => {
    if (options.preferences === 'hang') return undefined;
    if (options.preferences === 'fail') {
      return apiError(route, 503, 'UNAVAILABLE', 'Server sedang sibuk. Coba lagi sebentar lagi.');
    }
    return json(route, { preferences, timezone: 'Asia/Jakarta', devices: 2 });
  });
  await page.route(`${API}/notifications/vapid-public-key`, (route) =>
    json(route, { publicKey: `B${'Q'.repeat(86)}` }),
  );
  await page.route(`${API}/notifications/subscriptions`, (route) =>
    route.request().method() === 'DELETE'
      ? json(route, { deleted: true })
      : json(
          route,
          {
            subscription: {
              id: '6f1c2a90-3333-4c4c-9a9a-000000000001',
              createdAt: new Date().toISOString(),
            },
          },
          201,
        ),
  );
  await page.route(`${API}/notifications/test`, (route) => json(route, { devices: 2 }));
  await page.route(`${API}/settings/notifications`, (route) =>
    json(route, { settings: { preview: false, contactName: false } }),
  );
}

function screen(
  name: string,
  device: DeviceOptions,
  waitFor: string,
  extra: {
    quiet?: boolean;
    preferences?: 'ok' | 'hang' | 'fail';
    prepare?: Screen['prepare'];
  } = {},
): Screen {
  return {
    name,
    path: PATH,
    waitUntil: extra.preferences === 'hang' ? 'domcontentloaded' : undefined,
    before: async (page) => {
      await quietSecurity(page);
      await fakeDevice(page, device);
      await notificationMocks(page, extra);
    },
    waitFor,
    prepare: extra.prepare,
  };
}

export const notificationScreens: Screen[] = [
  screen('notifikasi', {}, 'text=Aktifkan di perangkat ini'),
  screen(
    'notifikasi-aktif',
    { permission: 'granted', subscribed: true },
    'text=Kirim notifikasi tes',
    { quiet: true },
  ),
  screen(
    'notifikasi-tes-terkirim',
    { permission: 'granted', subscribed: true },
    'text=Kirim notifikasi tes',
    {
      prepare: async (page) => {
        await page.getByRole('button', { name: 'Kirim notifikasi tes' }).click();
        await page.getByText(/Notifikasi tes dikirim/).waitFor();
        await page.mouse.move(1, 1);
      },
    },
  ),
  screen(
    'notifikasi-diblokir',
    { permission: 'denied' },
    'text=Notifikasi diblokir di browser ini',
  ),
  screen('notifikasi-ios', { support: 'ios' }, 'text=Pasang aplikasi dulu untuk notifikasi'),
  screen(
    'notifikasi-tidak-didukung',
    { support: 'unsupported' },
    'text=Browser ini belum mendukung notifikasi',
  ),
  screen('notifikasi-memuat', {}, '[aria-busy="true"]', { preferences: 'hang' }),
  screen('notifikasi-gagal', {}, 'text=Preferensi notifikasi belum bisa dimuat', {
    preferences: 'fail',
  }),
  // Versi baru service worker menunggu: banner di atas konten (semua halaman aplikasi).
  {
    name: 'pembaruan-versi',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await fakeDevice(page, { updateWaiting: true });
      await inboxMocks(page);
    },
    waitFor: 'text=Versi baru tersedia',
  },
];
