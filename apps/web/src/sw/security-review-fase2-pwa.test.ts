/**
 * Tes penjaga review keamanan web — service worker, PWA, notifikasi
 * (docs/security-reviews/2026-11-19-fase2-pwa-notifikasi-web.md). Semua `it` = regresi.
 */
import { describe, expect, it, vi } from 'vitest';

import { brandedManifest } from '../brand/web-manifest';
import { isAppPath, parsePushPayload, resolveAppUrl } from './push-payload';
import {
  NAVIGATE_MESSAGE,
  fetchStrategy,
  handleNotificationClick,
  handlePush,
  type SwScope,
  type SwWindowClient,
} from './sw-handlers';

const ORIGIN = 'https://balesin.contoh.id';

const EVIL_PATHS = [
  '//evil.example/x',
  '/\\evil.example/x',
  '\\\\evil.example/x',
  '\\/evil.example/x',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r/evil.example',
  ' /evil.example',
  'https://evil.example/',
  'HTTPS://evil.example/',
  'javascript:alert(1)',
  'data:text/html,x',
  '',
  'inbox',
  `/${'a'.repeat(2048)}`,
  null,
  42,
  { toString: () => '/inbox' },
];

/** Bentuk yang LOLOS `isAppPath` tetapi harus tetap di origin yang sama. */
const TRICKY_SAME_ORIGIN = [
  '/%2F%2Fevil.example/x',
  '/%2f%2fevil.example',
  '/%5Cevil.example',
  '/%5C%5Cevil.example',
  '/∕∕evil.example',
  '/／／evil.example',
  '/＼evil.example',
  '/　/evil.example',
  '/inbox?next=//evil.example',
  '/inbox#//evil.example',
  '/@evil.example',
  '/:@evil.example',
];

function scope(windows: SwWindowClient[] = []) {
  const opened: string[] = [];
  const shown: { title: string; options: NotificationOptions }[] = [];
  const value: SwScope = {
    origin: ORIGIN,
    showNotification: (title, options) => {
      shown.push({ title, options });
      return Promise.resolve();
    },
    matchWindows: () => Promise.resolve(windows),
    openWindow: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
  return { value, opened, shown };
}

function client(url: string, focused = false) {
  return { url, focused, focus: vi.fn(() => Promise.resolve()), postMessage: vi.fn() };
}

describe('review keamanan — URL klik notifikasi', () => {
  it('path berbahaya ditolak isAppPath dan resolveAppUrl', () => {
    for (const path of EVIL_PATHS) {
      expect(isAppPath(path), JSON.stringify(path)).toBe(false);
      expect(resolveAppUrl(path, ORIGIN), JSON.stringify(path)).toBeNull();
    }
  });

  it('bentuk ter-encode/unicode yang lolos tetap di origin aplikasi', () => {
    for (const path of TRICKY_SAME_ORIGIN) {
      const resolved = resolveAppUrl(path, ORIGIN);
      if (resolved === null) continue;
      expect(new URL(resolved).origin, path).toBe(ORIGIN);
      expect(new URL(resolved).pathname.startsWith('//'), path).toBe(false);
    }
  });

  it('R1: segmen titik ter-encode tidak boleh menghasilkan path "//host" setelah normalisasi URL', () => {
    for (const path of [
      '/.%2e//evil.example',
      '/x/%2e%2e//evil.example',
      '/./%2e%2e//evil.example',
    ]) {
      expect(isAppPath(path), path).toBe(true);
      const resolved = resolveAppUrl(path, ORIGIN);
      if (resolved === null) continue;
      expect(new URL(resolved).pathname.startsWith('//'), path).toBe(false);
    }
  });

  it('klik: tanpa tab → jendela baru selalu di origin aplikasi', async () => {
    for (const path of [...EVIL_PATHS, ...TRICKY_SAME_ORIGIN]) {
      const { value, opened } = scope();
      await handleNotificationClick(value, { url: path });
      expect(opened).toHaveLength(1);
      expect(new URL(opened[0]!).origin, JSON.stringify(path)).toBe(ORIGIN);
    }
  });

  it('klik: tab origin lain diabaikan; pesan navigasi hanya berisi path (bukan URL lengkap)', async () => {
    const foreign = client('https://evil.example/inbox', true);
    const own = client(`${ORIGIN}/kontak`);
    const { value, opened } = scope([foreign, own]);
    await handleNotificationClick(value, { url: '/%2F%2Fevil.example/x' });
    expect(foreign.postMessage).not.toHaveBeenCalled();
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    const message = own.postMessage.mock.calls[0]?.[0] as { type: string; url: string };
    expect(message.type).toBe(NAVIGATE_MESSAGE);
    expect(message.url.startsWith('/')).toBe(true);
    expect(message.url.startsWith('//')).toBe(false);
    expect(isAppPath(message.url)).toBe(true);
  });

  it('push dengan url berbahaya → notifikasi umum ke /inbox, judul/isi push tidak dipakai', async () => {
    const { value, shown } = scope();
    await handlePush(
      value,
      () => ({
        v: 1,
        title: 'Hadiah! Klik',
        body: 'curi',
        url: '//evil.example',
        tag: 'x',
        conversationId: null,
      }),
      { fallbackTitle: 'Umum', fallbackBody: 'Ada pembaruan' },
    );
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Umum',
        options: expect.objectContaining({ data: { url: '/inbox' } }) as unknown,
      }),
    ]);
  });

  it('conversationId bukan UUID / v lain → isi push ditolak', () => {
    const base = { v: 1, title: 'a', body: 'b', url: '/inbox', tag: 't' };
    expect(parsePushPayload({ ...base, conversationId: '../x' })).toBeNull();
    expect(parsePushPayload({ ...base, v: 2, conversationId: null })).toBeNull();
  });
});

describe('review keamanan — strategi cache', () => {
  const precache = new Set(['/index.html', '/assets/app-1.js', '/manifest.webmanifest']);
  const strategy = (url: string, method = 'GET', mode = 'cors') =>
    fetchStrategy({ url, method, mode }, ORIGIN, precache);

  it('API, origin lain, non-GET, query, dan berkas di luar precache selalu ke jaringan', () => {
    expect(strategy(`${ORIGIN}/api/v1/auth/me`)).toBe('network');
    expect(strategy(`${ORIGIN}/api/v1/media/abc`)).toBe('network');
    expect(strategy(`${ORIGIN}/api/v1/contacts/x/export`, 'GET', 'navigate')).toBe('network');
    expect(strategy(`${ORIGIN}/api/docs`, 'GET', 'navigate')).toBe('network');
    expect(strategy('https://evil.example/assets/app-1.js')).toBe('network');
    expect(strategy(`${ORIGIN}/assets/app-1.js`, 'POST')).toBe('network');
    expect(strategy(`${ORIGIN}/assets/app-1.js?v=2`)).toBe('network');
    expect(strategy(`${ORIGIN}/uploads/x.jpg`)).toBe('network');
    expect(strategy('bukan url')).toBe('network');
  });

  it('navigasi = jaringan dulu (HTML bersesi tidak pernah disajikan dari cache selagi online)', () => {
    expect(strategy(`${ORIGIN}/inbox`, 'GET', 'navigate')).toBe('network-first-shell');
    expect(strategy(`${ORIGIN}/assets/app-1.js`)).toBe('cache-first');
  });

  it('tanpa daftar precache (dev) → semua ke jaringan', () => {
    expect(
      fetchStrategy({ url: `${ORIGIN}/inbox`, method: 'GET', mode: 'navigate' }, ORIGIN, new Set()),
    ).toBe('network');
  });
});

describe('review keamanan — manifest bermerek', () => {
  const base = {
    id: '/',
    start_url: '/inbox',
    scope: '/',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192' },
      { src: 'https://cdn.evil.example/i.png', sizes: '512x512' },
    ],
  };

  it('logo/ikon/start_url origin lain atau skema berbahaya dibuang', () => {
    for (const logoUrl of [
      'https://evil.example/logo.png',
      '//evil.example/logo.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
    ]) {
      const manifest = brandedManifest(base, { productName: 'Toko', logoUrl }, ORIGIN);
      for (const icon of manifest.icons ?? []) {
        expect(new URL(icon.src).origin, logoUrl).toBe(ORIGIN);
      }
    }
    const evilStart = brandedManifest(
      { ...base, start_url: 'https://evil.example/', scope: '//evil.example/' },
      { productName: 'Toko', logoUrl: null },
      ORIGIN,
    );
    expect(evilStart.start_url).toBeUndefined();
    expect(evilStart.scope).toBeUndefined();
  });

  it('logo sama origin dipakai; nama produk hanya data JSON', () => {
    const manifest = brandedManifest(
      base,
      { productName: '<script>x</script>', logoUrl: '/api/v1/branding/logo?v=3' },
      ORIGIN,
    );
    expect(manifest.icons?.[0]?.src).toBe(`${ORIGIN}/api/v1/branding/logo?v=3`);
    expect(manifest.name).toBe('<script>x</script>');
  });
});
