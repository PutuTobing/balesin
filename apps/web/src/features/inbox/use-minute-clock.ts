import { useSyncExternalStore } from 'react';
import { msUntilNextMinute } from './inbox-time';

/**
 * Jam bersama yang berdetak tepat di awal setiap menit. Semua hitung mundur sesi di layar
 * memakai SATU pewaktu ini (bukan satu per baris), jadi semuanya berganti serentak tanpa
 * render berlebihan. Saat tab kembali terlihat, jam langsung disegarkan.
 */
const listeners = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

function emit(): void {
  current = Date.now();
  for (const listener of listeners) listener();
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      emit();
      schedule();
    },
    msUntilNextMinute(Date.now()) + 50,
  );
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  emit();
  schedule();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    current = Date.now();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Waktu sekarang (ms), diperbarui per menit. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => current);
}
