import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../components/ui/Tooltip';
import { t } from '../i18n/id';
import { SKIP_WAITING_MESSAGE } from '../sw/sw-handlers';
import { UpdateBanner } from './UpdateBanner';
import { registerServiceWorker, resetServiceWorkerState } from './service-worker';

function installContainer(options: { controller: boolean; waiting: boolean }) {
  const waiting = { postMessage: vi.fn() };
  const listeners = new Map<string, () => void>();
  const registration = {
    waiting: options.waiting ? waiting : null,
    installing: null,
    addEventListener: vi.fn(),
    update: vi.fn(() => Promise.resolve()),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: options.controller ? {} : null,
      register: vi.fn(() => Promise.resolve(registration)),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    },
  });
  return { waiting, listeners };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  resetServiceWorkerState();
});

describe('pembaruan versi', () => {
  it('versi baru menunggu → banner; "Muat ulang" mengaktifkan versi baru lalu memuat ulang', async () => {
    const { waiting, listeners } = installContainer({ controller: true, waiting: true });
    render(
      <TooltipProvider>
        <UpdateBanner />
      </TooltipProvider>,
    );
    await act(async () => {
      registerServiceWorker();
      await Promise.resolve();
    });
    expect(await screen.findByText(t.pwa.updateTitle)).toBeVisible();

    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      configurable: true,
    });
    fireEvent.click(screen.getByRole('button', { name: t.pwa.reload }));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING_MESSAGE });
    act(() => listeners.get('controllerchange')?.());
    expect(reload).toHaveBeenCalledOnce();
  });

  it('pemasangan pertama (belum ada controller) bukan pembaruan', async () => {
    installContainer({ controller: false, waiting: true });
    render(
      <TooltipProvider>
        <UpdateBanner />
      </TooltipProvider>,
    );
    await act(async () => {
      registerServiceWorker();
      await Promise.resolve();
    });
    expect(screen.queryByText(t.pwa.updateTitle)).toBeNull();
  });

  it('"Nanti saja" menyembunyikan banner', async () => {
    installContainer({ controller: true, waiting: true });
    render(
      <TooltipProvider>
        <UpdateBanner />
      </TooltipProvider>,
    );
    await act(async () => {
      registerServiceWorker();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: t.pwa.dismiss }));
    expect(screen.queryByText(t.pwa.updateTitle)).toBeNull();
  });
});
