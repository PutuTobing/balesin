/**
 * `window.matchMedia` tiruan untuk jsdom (yang tidak punya layout). Tes mengatur hasil
 * tiap query lewat `setMediaQuery`; query yang tidak diatur dianggap tidak cocok.
 */
type Listener = (event: MediaQueryListEvent) => void;

const matchesByQuery = new Map<string, boolean>();
const listenersByQuery = new Map<string, Set<Listener>>();

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = listenersByQuery.get(query) ?? new Set<Listener>();
    listenersByQuery.set(query, listeners);

    const list: Pick<
      MediaQueryList,
      'matches' | 'media' | 'addEventListener' | 'removeEventListener'
    > = {
      get matches() {
        return matchesByQuery.get(query) ?? false;
      },
      media: query,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listeners.delete(listener);
      },
    };
    return list as MediaQueryList;
  };
}

/** Ubah hasil sebuah media query dan beri tahu pendengarnya. Panggil di dalam `act()`. */
export function setMediaQuery(query: string, matches: boolean): void {
  matchesByQuery.set(query, matches);
  const event = { matches, media: query } as MediaQueryListEvent;
  listenersByQuery.get(query)?.forEach((listener) => listener(event));
}

export function resetMatchMedia(): void {
  matchesByQuery.clear();
  listenersByQuery.clear();
}
