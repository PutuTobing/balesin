import { MAIL_PROVIDERS_AVAILABLE, type MailAvailableProvider } from '@balesin/shared';

/** Tampilan gabungan di kolom folder (alamat Indonesia, ikut tampil ke pengguna). */
export const MAIL_VIEWS = ['semua', 'belum-dibaca', 'berbintang'] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

/** `/email?f=&m=` — tampilan gabungan atau ID folder, dan email yang sedang dibaca. */
export interface MailSearch {
  f?: string;
  m?: string;
}

const FOLDER_ID = /^[0-9a-f-]{8,64}$/i;
const MESSAGE_ID = /^[0-9a-f-]{8,64}$/i;

export function parseMailSearch(search: Record<string, unknown>): MailSearch {
  const result: MailSearch = {};
  const { f, m } = search;
  if (
    typeof f === 'string' &&
    ((MAIL_VIEWS as readonly string[]).includes(f) || FOLDER_ID.test(f))
  ) {
    result.f = f;
  }
  if (typeof m === 'string' && MESSAGE_ID.test(m)) result.m = m;
  return result;
}

export function isMailView(value: string | undefined): value is MailView {
  return value !== undefined && (MAIL_VIEWS as readonly string[]).includes(value);
}

/**
 * `/pengaturan/akun-email?tambah=` — buka wizard hubungkan akun; nilainya penyedia yang sudah
 * dipilih (`cpanel`/`imap`) atau `baru` (tanpa pilihan).
 */
export interface MailAccountsSearch {
  tambah?: MailAvailableProvider | 'baru';
}

export function parseMailAccountsSearch(search: Record<string, unknown>): MailAccountsSearch {
  const value = search.tambah;
  if (value === 'baru') return { tambah: 'baru' };
  if (
    typeof value === 'string' &&
    (MAIL_PROVIDERS_AVAILABLE as readonly string[]).includes(value)
  ) {
    return { tambah: value as MailAvailableProvider };
  }
  return {};
}

/**
 * `/pengaturan/akun-email/$accountId?ubah=server` — buka dialog Ubah server/password saat halaman
 * akun dimuat (tautan "Perbarui password" dari daftar akun; review 9A P4).
 */
export interface MailAccountSearch {
  ubah?: 'server';
}

export function parseMailAccountSearch(search: Record<string, unknown>): MailAccountSearch {
  return search.ubah === 'server' ? { ubah: 'server' } : {};
}
