import { envDefault, envOptional } from '../env';
import { DEFAULT_META_GRAPH_VERSION, META_GRAPH_VERSION_PATTERN } from './graph-client';

/**
 * `META_GRAPH_BASE_URL` (server Meta tiruan): hanya di luar production, dan hanya alamat loopback
 * (localhost/127.0.0.1/[::1]) tanpa kredensial, path, atau query — tidak bisa dipakai membelokkan
 * token Meta ke server lain. Dipakai api dan worker.
 */
export function parseMetaGraphBaseUrl(production: boolean) {
  return (raw: string): string | undefined => {
    if (production) return undefined;
    try {
      const url = new URL(raw);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const bare =
        !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
      return (url.protocol === 'http:' || url.protocol === 'https:') && loopback && bare
        ? url.origin
        : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Variabel lingkungan Graph API (versi terkunci + server tiruan dev/test). */
export function metaGraphEnvShape(production: boolean) {
  return {
    META_GRAPH_VERSION: envDefault(
      (raw) => (META_GRAPH_VERSION_PATTERN.test(raw) ? raw : undefined),
      DEFAULT_META_GRAPH_VERSION,
      `harus berformat vNN.0, contoh: ${DEFAULT_META_GRAPH_VERSION}`,
    ),
    META_GRAPH_BASE_URL: envOptional(
      parseMetaGraphBaseUrl(production),
      production
        ? 'hanya untuk development/test (server Meta tiruan) — kosongkan di production'
        : 'harus berupa alamat http(s) di mesin ini tanpa path, contoh: http://127.0.0.1:4010',
    ),
  };
}
