import '@testing-library/jest-dom/vitest';
import { configureZodLocale } from '@balesin/shared';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { clearHandoffEmail, clearLoginNotice } from '../features/auth/login-notice';
import { api } from '../lib/api/client';
import { setInboxSocketFactory } from '../features/inbox/use-inbox-stream';
import { THEME_ATTRIBUTE } from '../theme/theme';
import { FakeSocket } from './fake-socket';
import { clearMediaCache } from '../features/inbox/message-media';
import { resetOutbox } from '../features/inbox/outbox';
import { resetComposeStore } from '../features/mail/compose/compose-store';
import { installMatchMedia, resetMatchMedia } from './match-media';

installMatchMedia();
configureZodLocale();
// Bawaan `findBy*`/`waitFor` 1 dtk terlalu ketat untuk runner CI yang menjalankan tes web
// bersamaan dengan tes API (media dimuat lewat fetch → object URL gagal ditemukan tepat waktu).
configure({ asyncUtilTimeout: 5_000 });
// Inbox real-time: tidak ada server WebSocket di jsdom.
setInboxSocketFactory((url) => new FakeSocket(url));

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

// jsdom tidak punya object URL (media pesan & pratinjau lampiran). Selalu dipasang: object URL bawaan
// Node menolak `Blob` milik jsdom di Node 22 (CI), sehingga media gagal tampil hanya di sana.
let blobCounter = 0;
Object.assign(URL, {
  createObjectURL: () => `blob:tes/${String((blobCounter += 1))}`,
  revokeObjectURL: () => undefined,
});

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
  FakeSocket.reset();
  resetOutbox();
  resetComposeStore();
  clearMediaCache();
});
