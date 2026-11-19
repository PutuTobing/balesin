import type { Page } from '@playwright/test';
import { asGuest, json } from './mocks';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 7 white-label: Pengaturan → Merek (bawaan, sudah disesuaikan, warna kurang terbaca) dan
 * halaman masuk bermerek. Data tiruan = bentuk skema bersama (`@balesin/shared` branding).
 */
const API = '**/api/v1';
const LOGO_URL = '/api/v1/branding/logo?v=e2e1';
const NAME = 'Layanan Maju Jaya';
const COLOR = '#1b3557';

/** Logo contoh organisasi (hanya untuk foto; server sungguhan menerima PNG/JPG/WebP). */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 56">
<rect x="4" y="8" width="40" height="40" rx="12" fill="${COLOR}"/>
<path d="M14 36 L24 18 L34 36 Z" fill="#ffffff"/>
<text x="54" y="37" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${COLOR}">Maju Jaya</text>
</svg>`;

/** Ikon persegi yang dibuat server dari logo (rail, favicon, PWA). */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
<rect x="4" y="4" width="40" height="40" rx="12" fill="${COLOR}"/>
<path d="M14 33 L24 15 L34 33 Z" fill="#ffffff"/>
</svg>`;
const ICON = (file: string) => `/api/v1/branding/icons/${file}?v=e2e1`;
const ICONS = {
  favicon: ICON('favicon-32.png'),
  appleTouchIcon: ICON('apple-touch-icon.png'),
  manifest: [
    { src: ICON('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: ICON('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: ICON('maskable-192.png'), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: ICON('maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const DEFAULTS = { productName: 'Balesin', mascotName: 'Kak Sky' };

const CUSTOM_SETTINGS = {
  productName: NAME,
  primaryColor: COLOR,
  primaryTextColor: '#ffffff',
  mascotName: 'Mbak Ayu',
  logo: {
    url: LOGO_URL,
    contentType: 'image/png',
    byteSize: 18_432,
    updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  },
  defaults: DEFAULTS,
};

const DEFAULT_SETTINGS = {
  productName: null,
  primaryColor: null,
  primaryTextColor: null,
  mascotName: null,
  logo: null,
  defaults: DEFAULTS,
};

async function brandingMocks(page: Page, custom: boolean): Promise<void> {
  await quietSecurity(page);
  await page.route(`${API}/branding/logo**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: LOGO_SVG }),
  );
  await page.route(`${API}/branding/icons/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: ICON_SVG }),
  );
  await page.route(`${API}/branding`, (route) =>
    json(route, {
      productName: custom ? NAME : 'Balesin',
      organizationName: 'PT Maju Jaya',
      primaryColor: custom ? COLOR : null,
      logoUrl: custom ? LOGO_URL : null,
      mascotName: custom ? 'Mbak Ayu' : 'Kak Sky',
      icons: custom ? ICONS : null,
    }),
  );
  await page.route(`${API}/settings/branding`, (route) =>
    json(route, { branding: custom ? CUSTOM_SETTINGS : DEFAULT_SETTINGS }),
  );
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

export const brandingScreens: Screen[] = [
  {
    name: 'merek',
    path: '/pengaturan/merek',
    before: (page) => brandingMocks(page, false),
    waitFor: 'text=Warna utama',
    prepare: settle,
    tall: true,
  },
  {
    name: 'merek-kustom',
    path: '/pengaturan/merek',
    before: (page) => brandingMocks(page, true),
    waitFor: 'text=Logo tersimpan',
    prepare: settle,
    tall: true,
  },
  {
    name: 'merek-kontras',
    path: '/pengaturan/merek',
    before: (page) => brandingMocks(page, false),
    waitFor: 'text=Warna utama',
    prepare: async (page) => {
      await page.getByLabel('Kode warna').fill('#7d7d7d');
      await page.getByLabel('Kode warna').blur();
      await settle(page);
    },
  },
  {
    name: 'masuk-merek',
    path: '/masuk',
    before: async (page) => {
      await asGuest(page);
      await brandingMocks(page, true);
    },
    waitFor: 'h1',
  },
];
