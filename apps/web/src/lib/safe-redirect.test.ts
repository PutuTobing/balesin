import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_LOGIN, safeRedirectTarget } from './safe-redirect';

describe('safeRedirectTarget (cegah open redirect)', () => {
  it.each([
    ['/pengaturan', '/pengaturan'],
    ['/inbox?tab=bot', '/inbox?tab=bot'],
    ['/kontak#atas', '/kontak#atas'],
    ['/pengaturan/email', '/pengaturan/email'],
  ])('path internal %s diterima', (raw, expected) => {
    expect(safeRedirectTarget(raw)).toBe(expected);
  });

  it.each([
    'https://contoh-jahat.test/curi',
    '//contoh-jahat.test',
    '/\\contoh-jahat.test',
    '\\\\contoh-jahat.test',
    'javascript:alert(1)',
    'data:text/html,hai',
    '/\tcontoh',
    '/\n/contoh-jahat.test',
    'pengaturan',
    '',
    '   ',
    `/${'a'.repeat(3000)}`,
  ])('tujuan berbahaya %j diganti Inbox', (raw) => {
    expect(safeRedirectTarget(raw)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it('bukan teks atau halaman publik → Inbox', () => {
    expect(safeRedirectTarget(undefined)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirectTarget(['/inbox'])).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirectTarget('/masuk')).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirectTarget('/setup#token=x')).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirectTarget('/verifikasi-dua-langkah')).toBe(DEFAULT_AFTER_LOGIN);
  });

  it('path yang dinormalkan keluar ke origin lain tetap ditolak', () => {
    expect(safeRedirectTarget('/..//contoh-jahat.test')).not.toMatch(/^\/\//);
  });
});
