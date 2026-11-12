import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultBrand } from '../../brand/brand';
import { t } from '../../i18n/id';
import { renderApp } from '../../test/render-app';
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from '../../theme/theme';

const root = document.documentElement;

describe('Pengaturan → Tampilan', () => {
  it('menawarkan Terang, Gelap, dan Ikuti sistem; bawaannya Ikuti sistem', async () => {
    await renderApp('/pengaturan');

    const group = within(
      await screen.findByRole('radiogroup', { name: t.settings.appearance.themeLabel }),
    );
    expect(group.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      t.theme.light,
      t.theme.dark,
      t.theme.system,
    ]);
    expect(group.getByRole('radio', { name: t.theme.system })).toBeChecked();
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });

  it('memilih Gelap langsung berlaku dan tersimpan di perangkat', async () => {
    await renderApp('/pengaturan');
    const group = within(
      await screen.findByRole('radiogroup', { name: t.settings.appearance.themeLabel }),
    );

    fireEvent.click(group.getByRole('radio', { name: t.theme.dark }));

    expect(group.getByRole('radio', { name: t.theme.dark })).toBeChecked();
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    fireEvent.click(group.getByRole('radio', { name: t.theme.system }));

    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('menampilkan nama produk dan versi dari konfigurasi', async () => {
    await renderApp('/pengaturan');

    expect(
      await screen.findByText(t.common.version(defaultBrand.productName, __APP_VERSION__)),
    ).toBeVisible();
  });
});

describe('menu tema di rail', () => {
  it('memilih tema lewat keyboard dan menandai pilihan aktif', async () => {
    await renderApp('/inbox');
    const trigger = screen.getByRole('button', { name: t.theme.change });

    fireEvent.keyDown(trigger, { key: 'Enter' });

    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitemradio', { name: t.theme.system })).toBeChecked();

    fireEvent.click(menu.getByRole('menuitemradio', { name: t.theme.light }));

    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});
