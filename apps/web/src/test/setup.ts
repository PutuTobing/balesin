import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { THEME_ATTRIBUTE } from '../theme/theme';
import { installMatchMedia, resetMatchMedia } from './match-media';

installMatchMedia();

// jsdom tidak punya ResizeObserver; primitives Radix (menu, tooltip) membutuhkannya.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= ResizeObserverStub;

beforeEach(() => {
  // jsdom tidak mengimplementasikan scrollTo; router memanggilnya saat pindah halaman.
  window.scrollTo = () => undefined;
});

afterEach(() => {
  cleanup();
  resetMatchMedia();
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  document.title = '';
});
