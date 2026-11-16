import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Penyimpanan berkas media di disk (`MEDIA_DIR`, volume bersama — ARCHITECTURE.md §1 "media").
 *
 * - Nama berkas SELALU buatan server: `<folder>/<uuid>` (`uploads/…` unggahan agen, `inbound/…`
 *   cache unduhan media masuk). Nama dari klien/Meta tidak pernah menjadi path.
 * - Setiap path diselesaikan lalu dipastikan tetap di dalam `MEDIA_DIR` (pertahanan berlapis
 *   terhadap path traversal walau kuncinya sudah divalidasi CHECK database).
 * - Berkas ditulis dengan mode 0600.
 */

export type MediaFolder = 'uploads' | 'inbound';

const STORAGE_KEY_PATTERN = /^(uploads|inbound)\/[0-9a-f-]{36}$/;

export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

export interface MediaStore {
  save(folder: MediaFolder, bytes: Uint8Array): Promise<StoredFile>;
  /** Aliran baca berkas, atau `null` bila sudah tidak ada di disk. */
  open(storageKey: string): Promise<{ stream: ReadStream; sizeBytes: number } | null>;
  remove(storageKey: string): Promise<void>;
}

export function createMediaStore(mediaDir: string): MediaStore {
  const root = resolve(mediaDir);

  function pathOf(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error('Kunci penyimpanan media tidak sah');
    const full = resolve(root, storageKey);
    const inside = relative(root, full);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('Path media keluar dari MEDIA_DIR');
    }
    return full;
  }

  return {
    async save(folder, bytes) {
      const storageKey = `${folder}/${randomUUID()}`;
      const path = pathOf(storageKey);
      await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      return {
        storageKey,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },

    async open(storageKey) {
      const path = pathOf(storageKey);
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { stream: createReadStream(path), sizeBytes: info.size };
      } catch {
        return null;
      }
    },

    async remove(storageKey) {
      await rm(pathOf(storageKey), { force: true });
    },
  };
}

/**
 * `Content-Disposition` aman (RFC 6266 + RFC 5987): `filename` ASCII cadangan (karakter lain →
 * `_`, tanda kutip/backslash dibuang) dan `filename*` UTF-8 ter-encode persen.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string | null,
): string {
  if (!filename) return disposition;
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150);
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
