import '@testing-library/jest-dom/vitest';
import { configureZodLocale } from '@balesin/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { clearHandoffEmail, clearLoginNotice } from '../features/auth/login-notice';
import { api } from '../lib/api/client';
import { THEME_ATTRIBUTE } from '../theme/theme';
import { installMatchMedia, resetMatchMedia } from './match-media';

installMatchMedia();
configureZodLocale();

// jsdom tidak punya ResizeObserver; primitives Radix (menu, tooltip) membutuhkannya.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= ResizeObserverStub;
// jsdom tidak punya scrollIntoView (dipakai saat pindah langkah wizard).
if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => undefined });
}

beforeEach(() => {
  // jsdom tidak mengimplementasikan scrollTo; router memanggilnya saat pindah halaman.
  window.scrollTo = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.setCsrfToken(null);
  clearLoginNotice();
  clearHandoffEmail();
  resetMatchMedia();
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  document.title = '';
});
