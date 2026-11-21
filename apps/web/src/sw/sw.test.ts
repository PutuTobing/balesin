import { pushNotificationPayloadSchema } from '@balesin/shared';
import { describe, expect, it, vi } from 'vitest';
import { isAppPath, parsePushPayload, resolveAppUrl } from './push-payload';
import {
  NAVIGATE_MESSAGE,
  fetchStrategy,
  handleNotificationClick,
  handlePush,
  type SwScope,
  type SwWindowClient,
} from './sw-handlers';

const ORIGIN = 'https://inbox.contoh.test';
const CONVERSATION = '6f1c2a90-1111-4c4c-9a9a-000000000001';
const TEXT = { fallbackTitle: 'Ada pembaruan', fallbackBody: 'Buka inbox.' };

const valid = {
  v: 1,
  title: 'Pesan baru di inbox',
  body: 'Buka untuk membaca pesan.',
  url: `/inbox?chat=${CONVERSATION}`,
  tag: `chat-${CONVERSATION}`,
  conversationId: CONVERSATION,
};

function scope(windows: SwWindowClient[] = []) {
  const showNotification = vi.fn<SwScope['showNotification']>(() => Promise.resolve());
  const openWindow = vi.fn<SwScope['openWindow']>(() => Promise.resolve(null));
  const value: SwScope = {
    origin: ORIGIN,
    showNotification,
    matchWindows: () => Promise.resolve(windows),
    openWindow,
  };
  return { value, showNotification, openWindow };
}

function client(url: string, focused = false) {
  return {
    url,
    focused,
    focus: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
  };
}

describe('isi push', () => {
  const cases: unknown[] = [
    valid,
    { ...valid, conversationId: null, url: '/inbox', tag: 'balesin-test' },
    { ...valid, v: 2 },
    { ...valid, url: 'https://evil.example/inbox' },
    { ...valid, url: '//evil.example/inbox' },
    { ...valid, url: '/\\evil.example' },
    { ...valid, url: 'javascript:alert(1)' },
    { ...valid, url: 'inbox' },
    { ...valid, conversationId: 'bukan-uuid' },
    { ...valid, title: 5 },
    { title: 'tanpa versi' },
    null,
    'teks',
  ];

  it('validasi sama dengan pushNotificationPayloadSchema (atau lebih ketat)', () => {
    for (const candidate of cases) {
      const ours = parsePushPayload(candidate);
      const schema = pushNotificationPayloadSchema.safeParse(candidate);
      // Yang kami terima pasti sah menurut skema bersama.
      if (ours) expect(schema.success, JSON.stringify(candidate)).toBe(true);
    }
    expect(parsePushPayload(valid)).toEqual(valid);
    expect(parsePushPayload({ ...valid, url: '/\\evil.example' })).toBeNull();
  });

  it('URL klik hanya path relatif di origin yang sama', () => {
    expect(resolveAppUrl('/inbox?chat=1', ORIGIN)).toBe(`${ORIGIN}/inbox?chat=1`);
    expect(resolveAppUrl('//evil.example/x', ORIGIN)).toBeNull();
    expect(resolveAppUrl('/\\evil.example', ORIGIN)).toBeNull();
    expect(resolveAppUrl('https://evil.example', ORIGIN)).toBeNull();
    expect(resolveAppUrl('/inbox\nX', ORIGIN)).toBeNull();
    expect(isAppPath(42)).toBe(false);
  });
});

describe('penangan push', () => {
  it('menampilkan judul/isi dengan tag; data notifikasi hanya path tujuan', async () => {
    const { value, showNotification } = scope();
    await handlePush(value, () => valid, TEXT);
    expect(showNotification).toHaveBeenCalledWith(valid.title, {
      body: valid.body,
      tag: valid.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: valid.url },
    });
  });

  it('isi tidak valid / bukan JSON → notifikasi umum ke /inbox, tanpa teks dari push', async () => {
    for (const read of [
      () => ({ ...valid, url: 'https://evil.example' }),
      () => {
        throw new SyntaxError('bukan JSON');
      },
      () => null,
    ]) {
      const { value, showNotification } = scope();
      await handlePush(value, read, TEXT);
      const [title, options] = showNotification.mock.calls[0]!;
      expect(title).toBe(TEXT.fallbackTitle);
      expect(options).toMatchObject({ body: TEXT.fallbackBody, data: { url: '/inbox' } });
    }
  });
});

describe('klik notifikasi', () => {
  it('tab aplikasi terbuka → fokus + minta router membuka path', async () => {
    const other = client('https://lain.example/');
    const app = client(`${ORIGIN}/pengaturan`);
    const { value, openWindow } = scope([other, app]);
    await handleNotificationClick(value, { url: valid.url });
    expect(app.focus).toHaveBeenCalled();
    expect(app.postMessage).toHaveBeenCalledWith({ type: NAVIGATE_MESSAGE, url: valid.url });
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('tanpa tab → jendela baru; url berbahaya diganti /inbox', async () => {
    const { value, openWindow } = scope([]);
    await handleNotificationClick(value, { url: '//evil.example/curi' });
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
    await handleNotificationClick(value, null);
    expect(openWindow).toHaveBeenLastCalledWith(`${ORIGIN}/inbox`);
  });
});

describe('strategi cache', () => {
  const precache = new Set(['/assets/app-1a2b.js', '/index.html']);
  const request = (url: string, mode = 'cors', method = 'GET') => ({ url, mode, method });

  it('hanya aset precache dari cache; API & media pelanggan selalu jaringan', () => {
    expect(fetchStrategy(request(`${ORIGIN}/assets/app-1a2b.js`), ORIGIN, precache)).toBe(
      'cache-first',
    );
    expect(fetchStrategy(request(`${ORIGIN}/api/v1/conversations`), ORIGIN, precache)).toBe(
      'network',
    );
    expect(fetchStrategy(request(`${ORIGIN}/api/v1/messages/x/media`), ORIGIN, precache)).toBe(
      'network',
    );
    expect(fetchStrategy(request(`${ORIGIN}/assets/app-1a2b.js?v=2`), ORIGIN, precache)).toBe(
      'network',
    );
    expect(fetchStrategy(request('https://cdn.example/app.js'), ORIGIN, precache)).toBe('network');
    expect(
      fetchStrategy(request(`${ORIGIN}/assets/app-1a2b.js`, 'cors', 'POST'), ORIGIN, precache),
    ).toBe('network');
    expect(fetchStrategy(request(`${ORIGIN}/inbox`, 'navigate'), ORIGIN, precache)).toBe(
      'network-first-shell',
    );
    // Dev server: daftar kosong = tidak ada cache sama sekali.
    expect(fetchStrategy(request(`${ORIGIN}/inbox`, 'navigate'), ORIGIN, new Set())).toBe(
      'network',
    );
  });
});
