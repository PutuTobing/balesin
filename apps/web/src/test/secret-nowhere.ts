import { expect, vi } from 'vitest';
import type { renderApp } from './render-app';

/** Pengintai storage & console untuk `expectSecretNowhere`. */
export function secretSpies() {
  return {
    setItem: vi.spyOn(Storage.prototype, 'setItem'),
    logs: [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ],
  };
}

/**
 * Rahasia tidak boleh ada di cache Query/mutasi, storage, console, teks/atribut DOM, maupun nilai
 * isian yang masih terpasang.
 */
export function expectSecretNowhere(
  view: Awaited<ReturnType<typeof renderApp>>,
  secret: string,
  spies: ReturnType<typeof secretSpies>,
): void {
  const queries = view.queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state.data);
  const mutations = view.queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) => [mutation.state.data, mutation.state.variables]);
  expect(JSON.stringify([queries, mutations])).not.toContain(secret);
  for (const call of spies.setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  for (const spy of spies.logs) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  }
  expect(document.documentElement.outerHTML).not.toContain(secret);
  for (const input of Array.from(document.querySelectorAll('input, textarea'))) {
    expect((input as HTMLInputElement).value).not.toContain(secret);
  }
}
