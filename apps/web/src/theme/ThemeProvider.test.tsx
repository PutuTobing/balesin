import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setMediaQuery } from '../test/match-media';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './theme-context';
import {
  DARK_SCHEME_QUERY,
  THEME_ATTRIBUTE,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  storePreference,
} from './theme';

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <output aria-label="pilihan">{preference}</output>
      <output aria-label="tampil">{resolved}</output>
      {THEME_PREFERENCES.map((value) => (
        <button key={value} type="button" onClick={() => setPreference(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

const root = document.documentElement;

describe('ThemeProvider', () => {
  it('bawaannya mengikuti sistem tanpa memasang atribut', () => {
    renderProbe();

    expect(screen.getByLabelText('pilihan')).toHaveTextContent('system');
    expect(screen.getByLabelText('tampil')).toHaveTextContent('light');
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });

  it('ikut berubah saat tema sistem berganti', () => {
    renderProbe();

    act(() => setMediaQuery(DARK_SCHEME_QUERY, true));
    expect(screen.getByLabelText('tampil')).toHaveTextContent('dark');
    // Tetap tanpa atribut: CSS prefers-color-scheme yang bekerja.
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);

    act(() => setMediaQuery(DARK_SCHEME_QUERY, false));
    expect(screen.getByLabelText('tampil')).toHaveTextContent('light');
  });

  it('memakai pilihan yang tersimpan di perangkat', () => {
    storePreference('dark');
    renderProbe();

    expect(screen.getByLabelText('pilihan')).toHaveTextContent('dark');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
  });

  it('pilihan Gelap mengalahkan sistem yang terang, dan tersimpan', () => {
    renderProbe();

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(screen.getByLabelText('tampil')).toHaveTextContent('dark');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('pilihan Terang mengalahkan sistem yang gelap', () => {
    act(() => setMediaQuery(DARK_SCHEME_QUERY, true));
    renderProbe();

    fireEvent.click(screen.getByRole('button', { name: 'light' }));

    expect(screen.getByLabelText('tampil')).toHaveTextContent('light');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'light');
  });

  it('kembali ke "Ikuti sistem" melepas atribut dan simpanan', () => {
    storePreference('dark');
    renderProbe();

    fireEvent.click(screen.getByRole('button', { name: 'system' }));

    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText('tampil')).toHaveTextContent('light');
  });

  it('ikut berubah saat pilihan diganti di tab lain', () => {
    renderProbe();

    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });

    expect(screen.getByLabelText('pilihan')).toHaveTextContent('dark');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
  });
});
