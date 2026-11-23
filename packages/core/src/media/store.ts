import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openAsBlob, type ReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** `email-out` = lampiran email lewat API (tahap 9.1). */
export type MediaFolder = 'uploads' | 'inbound' | 'email-out' | 'mail';

const STORAGE_KEY_PATTERN = /^(uploads|inbound|email-out|mail)\/[0-9a-f-]{36}$/;

export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/** Berkas melewati batas ukuran saat dialirkan (penulisan dihentikan, berkas sementara dihapus). */
export class MediaTooLargeError extends Error {
  override readonly name = 'MediaTooLargeError';
}

/**
 * Penulis berkas BERALIR (review ruang chat S1): potongan ditulis ke `MEDIA_DIR/tmp/<uuid>` (0600)
 * sambil dihitung ukuran + SHA-256; melewati `maxBytes` → `MediaTooLargeError` seketika. `finish`
 * memindahkan berkas ke `<folder>/<uuid>`; `abort` menghapus berkas sementara. Memori tetap kecil
 * berapa pun ukuran berkasnya.
 */
export interface MediaWriter {
  /** Batas ukuran bisa dipersempit setelah jenis berkas diketahui dari kepala berkas. */
  maxBytes: number;
  readonly sizeBytes: number;
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<StoredFile>;
  abort(): Promise<void>;
}

export interface MediaStore {
  save(folder: MediaFolder, bytes: Uint8Array): Promise<StoredFile>;
  writer(folder: MediaFolder, maxBytes: number): Promise<MediaWriter>;
  /** Blob berbasis berkas (dialirkan ke `fetch`, tidak dimuat ke memori). */
  blob(storageKey: string, type: string): Promise<Blob>;
  /** Membaca potongan berkas (mis. ujung ZIP). */
  readRange(storageKey: string, start: number, length: number): Promise<Buffer>;
  /** Membaca seluruh berkas per potongan (pemindaian), tanpa memuat utuh ke memori. */
  chunks(storageKey: string): AsyncIterable<Buffer>;
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

    async writer(folder, maxBytes) {
      await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
      await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const tempPath = join(root, 'tmp', id);
      const handle = await open(tempPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      };
      const writer: MediaWriter = {
        maxBytes,
        get sizeBytes() {
          return size;
        },
        async write(chunk) {
          size += chunk.byteLength;
          if (size > writer.maxBytes) throw new MediaTooLargeError('Berkas melewati batas ukuran');
          hash.update(chunk);
          await handle.write(chunk);
        },
        async finish() {
          await close();
          const storageKey = `${folder}/${id}`;
          await rename(tempPath, pathOf(storageKey));
          return { storageKey, sizeBytes: size, sha256: hash.digest('hex') };
        },
        async abort() {
          await close().catch(() => undefined);
          await rm(tempPath, { force: true });
        },
      };
      return writer;
    },

    blob: (storageKey, type) => openAsBlob(pathOf(storageKey), { type }),

    async readRange(storageKey, start, length) {
      const handle = await open(pathOf(storageKey), 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },

    chunks(storageKey) {
      return createReadStream(pathOf(storageKey), { highWaterMark: 256 * 1024 });
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
