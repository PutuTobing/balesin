import type { Page } from '@playwright/test';

export interface Screen {
  /** Nama berkas: e2e/screenshots/<name>--<viewport>-<tema>.png */
  name: string;
  /** Path yang dibuka (relatif ke baseURL). */
  path: string;
  /** Selector yang harus terlihat sebelum difoto (opsional). */
  waitFor?: string;
  /** Langkah tambahan sebelum difoto, mis. membuka menu atau mengisi form. */
  prepare?: (page: Page) => Promise<void>;
  /** Foto seluruh halaman (bukan hanya viewport). Default: false. */
  fullPage?: boolean;
}

/**
 * Daftar layar yang difoto untuk penilaian desain.
 * Tambahkan entri setiap ada layar/keadaan baru (kosong, loading, error).
 */
export const screens: Screen[] = [{ name: 'beranda', path: '/' }];
