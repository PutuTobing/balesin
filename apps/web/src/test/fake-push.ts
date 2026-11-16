import { vi } from 'vitest';

/**
 * Web Push tiruan untuk jsdom (tidak punya Notification, ServiceWorker, PushManager). Mengganti
 * properti global selama satu tes; `uninstall()` mengembalikan keadaan semula.
 */
export const FAKE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/perangkat-uji';
/** Kunci contoh berbentuk base64url dengan panjang yang diterima skema. */
export const FAKE_KEYS = {
  p256dh: `B${'A'.repeat(86)}`,
  auth: 'AAAAAAAAAAAAAAAAAAAAAA',
};
export const FAKE_VAPID = `B${'Q'.repeat(86)}`;

export interface FakePush {
  requestPermission: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  setPermission(permission: NotificationPermission): void;
  setSubscribed(subscribed: boolean): void;
  uninstall(): void;
}

export function installFakePush(
  options: {
    permission?: NotificationPermission;
    subscribed?: boolean;
    grant?: NotificationPermission;
  } = {},
): FakePush {
  let permission: NotificationPermission = options.permission ?? 'default';
  let subscribed = options.subscribed ?? false;
  const unsubscribe = vi.fn(() => {
    subscribed = false;
    return Promise.resolve(true);
  });
  const subscription = () => ({
    endpoint: FAKE_ENDPOINT,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: FAKE_ENDPOINT, expirationTime: null, keys: FAKE_KEYS }),
    unsubscribe,
  });
  const subscribe = vi.fn(() => {
    subscribed = true;
    return Promise.resolve(subscription());
  });
  const registration = {
    pushManager: {
      getSubscription: () => Promise.resolve(subscribed ? subscription() : null),
      subscribe,
    },
  };
  const requestPermission = vi.fn(() => {
    permission = options.grant ?? 'granted';
    return Promise.resolve(permission);
  });

  const notification = function Notification() {};
  Object.defineProperty(notification, 'permission', { get: () => permission });
  Object.defineProperty(notification, 'requestPermission', { value: requestPermission });
  const serviceWorker = {
    ready: Promise.resolve(registration),
    controller: null,
    register: () => Promise.resolve(registration),
    addEventListener: () => undefined,
  };
  Object.defineProperty(window, 'Notification', { value: notification, configurable: true });
  Object.defineProperty(window, 'PushManager', {
    value: function PushManager() {},
    configurable: true,
  });
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });

  return {
    requestPermission,
    subscribe,
    unsubscribe,
    setPermission: (next) => {
      permission = next;
    },
    setSubscribed: (next) => {
      subscribed = next;
    },
    uninstall: () => {
      Reflect.deleteProperty(window, 'Notification');
      Reflect.deleteProperty(window, 'PushManager');
      Reflect.deleteProperty(navigator, 'serviceWorker');
    },
  };
}
