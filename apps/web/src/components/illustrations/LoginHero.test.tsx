import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { THEME_STORAGE_KEY } from '../../theme/theme';
import { LoginHero } from './LoginHero';
import { LOGIN_HERO_HEIGHT, LOGIN_HERO_WIDTH, loginHeroSources } from './login-hero-sources';

function renderHero(saved?: 'light' | 'dark') {
  if (saved) window.localStorage.setItem(THEME_STORAGE_KEY, saved);
  return render(
    <ThemeProvider>
      <LoginHero sizes="50vw" />
    </ThemeProvider>,
  );
}

describe('LoginHero', () => {
  it('hanya memuat versi tema terang saat tema terang', () => {
    const { container } = renderHero('light');

    expect(container.querySelectorAll('picture')).toHaveLength(1);
    const sources = [...container.querySelectorAll('source')].map((s) => s.getAttribute('srcset'));
    expect(sources).toEqual([loginHeroSources.light.avif, loginHeroSources.light.webp]);
    expect(container.innerHTML).not.toContain('login-hero-dark');
  });

  it('hanya memuat versi malam saat tema gelap', () => {
    const { container } = renderHero('dark');

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', loginHeroSources.dark.fallback);
    expect(container.querySelector('source')).toHaveAttribute('srcset', loginHeroSources.dark.avif);
  });

  it('dekoratif dan berukuran eksplisit (tanpa lompatan layout)', () => {
    const { container } = renderHero();

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', String(LOGIN_HERO_WIDTH));
    expect(img).toHaveAttribute('height', String(LOGIN_HERO_HEIGHT));
    expect(container.querySelector('source')).toHaveAttribute('sizes', '50vw');
  });
});
