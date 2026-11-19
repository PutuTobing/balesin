import {
  API_ROUTES,
  BRAND_COLOR_LOW_CONTRAST_MESSAGE,
  type BrandingSettings,
  type BrandingSettingsResponse,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { brandThemeVariables, mixHex } from '../../brand/brand-theme';
import { t } from '../../i18n/id';
import { apiError, defaultBranding, fakeSession, json } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { buildBrandingUpdate, draftFrom, previewColors } from './branding-form';

const b = t.brandingSettings;
const R = API_ROUTES.settings.branding;

const SETTINGS: BrandingSettings = {
  productName: null,
  primaryColor: null,
  primaryTextColor: null,
  mascotName: null,
  logo: null,
  defaults: { productName: 'Balesin', mascotName: 'Kak Sky' },
};

const respond = (branding: Partial<BrandingSettings> = {}): BrandingSettingsResponse => ({
  branding: { ...SETTINGS, ...branding },
});

afterEach(() => {
  for (const name of ['--primary', '--on-primary', '--primary-soft']) {
    document.documentElement.style.removeProperty(name);
  }
  document.head.querySelectorAll('link[data-brand]').forEach((link) => link.remove());
});

describe('warna merek → token tema', () => {
  it('biru dongker: dipakai di tema terang, mode gelap tetap bawaan (kurang terbaca)', () => {
    const light = brandThemeVariables('#1B3557', 'light');
    expect(light).toEqual({
      '--primary': '#1b3557',
      '--on-primary': '#ffffff',
      '--primary-soft': mixHex('#1b3557', '#ffffff', 0.12),
    });
    expect(brandThemeVariables('#1b3557', 'dark')).toBeNull();
  });

  it('kuning terang: tidak terbaca sebagai tautan di tema terang, tetapi terbaca di tema gelap', () => {
    expect(brandThemeVariables('#ffd400', 'light')).toBeNull();
    expect(brandThemeVariables('#ffd400', 'dark')?.['--on-primary']).not.toBe('#ffffff');
  });

  it('kosong/format salah/kontras rendah → bawaan', () => {
    expect(brandThemeVariables(null, 'light')).toBeNull();
    expect(brandThemeVariables('merah', 'light')).toBeNull();
    expect(brandThemeVariables('#7d7d7d', 'light')).toBeNull();
  });
});

describe('form merek', () => {
  it('hanya isian yang berubah dikirim; kosong = kembali ke bawaan (null)', () => {
    const saved = { ...SETTINGS, productName: 'Halo Maju', mascotName: 'Mbak Ayu' };
    expect(buildBrandingUpdate(saved, draftFrom(saved))).toEqual({ ok: true, empty: true });
    const draft = { ...draftFrom(saved), productName: '  ', primaryColor: '#1B3557 ' };
    expect(buildBrandingUpdate(saved, draft)).toEqual({
      ok: true,
      empty: false,
      body: { productName: null, primaryColor: '#1b3557' },
    });
  });

  it('nama dengan "WhatsApp" dan warna kontras rendah ditolak sebelum dikirim', () => {
    const draft = { ...draftFrom(SETTINGS), productName: 'Whats App CS', primaryColor: '#7d7d7d' };
    const built = buildBrandingUpdate(SETTINGS, draft);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.productName).toMatch(/WhatsApp/);
    expect(built.errors.primaryColor).toBe(BRAND_COLOR_LOW_CONTRAST_MESSAGE);
  });

  it('pratinjau: warna sah dipakai dengan teks yang terbaca; kontras rendah ditandai', () => {
    expect(previewColors('#1b3557')).toMatchObject({
      primary: '#1b3557',
      onPrimary: '#ffffff',
      custom: true,
    });
    expect(previewColors('#7d7d7d')).toMatchObject({ custom: false, lowContrast: true });
    expect(previewColors('')).toMatchObject({ custom: false, lowContrast: false });
  });
});

describe('Pengaturan → Merek', () => {
  it('Owner melihat menu Merek; Admin tidak', async () => {
    const { unmount } = await renderApp('/pengaturan');
    expect(await screen.findByRole('link', { name: new RegExp(b.title) })).toBeVisible();
    unmount();
    await renderApp('/pengaturan', { session: fakeSession('admin') });
    await screen.findByRole('heading', { name: t.settingsMenu.sectionTitle });
    expect(screen.queryByRole('link', { name: new RegExp(`^${b.title}`) })).toBeNull();
  });

  it('ubah nama, maskot, warna, dan logo → PATCH, lalu GET /branding dimuat ulang', async () => {
    const bodies: unknown[] = [];
    let brandingFetches = 0;
    const view = await renderApp('/pengaturan/merek', {
      routes: {
        [`GET ${R}`]: () => json(respond()),
        [`PATCH ${R}`]: (request) => {
          bodies.push(request.body);
          return json(
            respond({
              productName: 'Halo Maju',
              mascotName: 'Mbak Ayu',
              primaryColor: '#1b3557',
              primaryTextColor: '#ffffff',
            }),
          );
        },
        [`GET ${API_ROUTES.branding.get}`]: () => {
          brandingFetches += 1;
          return json(defaultBranding);
        },
      },
    });
    const before = brandingFetches;
    fireEvent.change(await screen.findByLabelText(b.productName), {
      target: { value: 'Halo Maju' },
    });
    fireEvent.change(screen.getByLabelText(b.mascotName), { target: { value: 'Mbak Ayu' } });
    expect(screen.getByText(/Tenang, Mbak Ayu jaga inbox-nya/)).toBeVisible();
    fireEvent.change(screen.getByLabelText(b.colorCode), { target: { value: '#1B3557' } });
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('merek-logo-berkas'), { target: { files: [file] } });
    expect(await screen.findByText(/logo\.png/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: b.save }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      productName: 'Halo Maju',
      mascotName: 'Mbak Ayu',
      primaryColor: '#1b3557',
      logo: { contentType: 'image/png', dataBase64: 'iVBORw==' },
    });
    expect(await screen.findByText(b.saved)).toBeVisible();
    await waitFor(() => expect(brandingFetches).toBeGreaterThan(before));
    view.unmount();
  });

  it('hapus logo tersimpan → logo: null; galat isian dari server tampil di isiannya', async () => {
    const bodies: unknown[] = [];
    await renderApp('/pengaturan/merek', {
      routes: {
        [`GET ${R}`]: () =>
          json(
            respond({
              logo: {
                url: '/api/v1/branding/logo?v=1',
                contentType: 'image/png',
                byteSize: 20_480,
                updatedAt: '2026-11-18T03:00:00.000Z',
              },
            }),
          ),
        [`PATCH ${R}`]: (request) => {
          bodies.push(request.body);
          return apiError(400, 'VALIDATION_ERROR', 'Periksa isian.', {
            details: [{ field: 'logo', message: 'Gambar logo rusak. Pilih gambar lain.' }],
          });
        },
      },
    });
    expect(await screen.findByText(b.logoCurrent(20))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t.setup.steps.branding.logoRemove }));
    expect(screen.getByText(b.logoWillRemove)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.save }));
    await waitFor(() => expect(bodies).toEqual([{ logo: null }]));
    expect(await screen.findByText('Gambar logo rusak. Pilih gambar lain.')).toBeVisible();
  });

  it('tanpa perubahan: tidak ada permintaan; warna kontras rendah ditolak di browser', async () => {
    let patched = 0;
    await renderApp('/pengaturan/merek', {
      routes: {
        [`GET ${R}`]: () => json(respond()),
        [`PATCH ${R}`]: () => {
          patched += 1;
          return json(respond());
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: b.save }));
    expect(await screen.findByText(b.noChanges)).toBeVisible();
    fireEvent.change(screen.getByLabelText(b.colorCode), { target: { value: '#7d7d7d' } });
    expect(screen.getByText(BRAND_COLOR_LOW_CONTRAST_MESSAGE)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.save }));
    await act(() => Promise.resolve());
    expect(patched).toBe(0);
  });
});

describe('merek diterapkan di aplikasi', () => {
  it('nama maskot, warna utama (token tema), favicon & ikon layar utama dari logo', async () => {
    await renderApp('/inbox', {
      branding: {
        ...defaultBranding,
        mascotName: 'Mbak Ayu',
        primaryColor: '#1b3557',
        logoUrl: '/api/v1/branding/logo?v=2',
        icons: {
          favicon: '/api/v1/branding/icons/favicon-32.png?v=2',
          appleTouchIcon: '/api/v1/branding/icons/apple-touch-icon.png?v=2',
          manifest: [],
        },
      },
    });
    // Inbox kosong (bawaan data uji, desktop/jsdom): ajakan bermaskot di ruang chat.
    const chat = within(await screen.findByRole('region', { name: t.inbox.chat.label }));
    expect(await chat.findByText(t.inbox.chat.inboxEmptyBody('Mbak Ayu'))).toBeVisible();
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#1b3557'),
    );
    const icon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]');
    expect(icon?.getAttribute('href')).toBe(
      `${window.location.origin}/api/v1/branding/icons/favicon-32.png?v=2`,
    );
    expect(
      document.head.querySelector('link[rel="apple-touch-icon"][data-brand]')?.getAttribute('href'),
    ).toBe(`${window.location.origin}/api/v1/branding/icons/apple-touch-icon.png?v=2`);
  });
});
