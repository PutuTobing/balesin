import { useSyncExternalStore } from 'react';
import { isAppPath } from '../sw/push-payload';
import { NAVIGATE_MESSAGE, SKIP_WAITING_MESSAGE } from '../sw/sw-handlers';

/**
 * Pendaftaran service worker (`/sw.js`) + status pembaruan versi. Versi baru TIDAK langsung
 * dipakai: halaman menampilkan "Versi baru tersedia · Muat ulang", dan baru setelah ditekan
 * service worker yang menunggu diaktifkan lalu halaman dimuat ulang sekali.
 */

let registration: ServiceWorkerRegistration | null = null;
let updateReady = false;
let reloading = false;
const listeners = new Set<() => void>();
let navigateHandler: ((path: string) => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function markWaiting(next: ServiceWorkerRegistration): void {
  // Tanpa controller = pemasangan pertama, bukan pembaruan.
  if (next.waiting && navigator.serviceWorker.controller) {
    updateReady = true;
    emit();
  }
}

function watch(next: ServiceWorkerRegistration): void {
  markWaiting(next);
  next.addEventListener('updatefound', () => {
    const installing = next.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') markWaiting(next);
    });
  });
}

export function serviceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Daftarkan service worker sekali saat aplikasi dimuat. Gagal = aplikasi tetap jalan tanpa PWA. */
export function registerServiceWorker(): void {
  if (!serviceWorkerSupported()) return;
  const container = navigator.serviceWorker;
  container.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === NAVIGATE_MESSAGE && isAppPath(data.url)) navigateHandler?.(data.url);
  });
  container.addEventListener('controllerchange', () => {
    // Hanya setelah pengguna menekan "Muat ulang" (bukan pemasangan pertama di tab ini).
    if (!reloading) return;
    window.location.reload();
  });
  container
    .register('/sw.js', { scope: '/' })
    .then((next) => {
      registration = next;
      watch(next);
      // Periksa versi baru saat tab kembali dilihat (aplikasi yang dibiarkan terbuka berhari-hari).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void next.update().catch(() => undefined);
      });
    })
    .catch(() => undefined);
}

/** Router: buka path dari klik notifikasi saat tab sudah terbuka. */
export function onServiceWorkerNavigate(handler: (path: string) => void): () => void {
  navigateHandler = handler;
  return () => {
    if (navigateHandler === handler) navigateHandler = null;
  };
}

/** Pakai versi baru: aktifkan service worker yang menunggu, lalu muat ulang saat ia mengambil alih. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  reloading = true;
  waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
}

export function dismissUpdate(): void {
  updateReady = false;
  emit();
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => updateReady,
    () => false,
  );
}

/** Registrasi aktif untuk Web Push (menunggu siap paling lama `timeoutMs`). */
export async function readyRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  if (!serviceWorkerSupported()) throw new Error('service-worker-unsupported');
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('service-worker-timeout')), timeoutMs);
  });
  return Promise.race([ready, timeout]);
}

/** Hanya untuk tes. */
export function resetServiceWorkerState(): void {
  registration = null;
  updateReady = false;
  reloading = false;
  navigateHandler = null;
  listeners.clear();
}
