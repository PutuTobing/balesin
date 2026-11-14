import { describe, expect, it } from 'vitest';

import { decodeAuditCursor, encodeAuditCursor } from './audit.repo';
import { csvCell, csvRow, publicMetadata } from './audit-view';

describe('csvCell (formula injection, RFC 4180)', () => {
  it.each([
    ['=1+1', `"'=1+1"`],
    ['+cmd|/C calc!A0', `"'+cmd|/C calc!A0"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\t=1', `"'\t=1"`],
    ['  =HYPERLINK("x")', `"'  =HYPERLINK(""x"")"`],
    ['"=1"', `"'""=1"""`],
    ["'=1", `"''=1"`],
  ])('%j → %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('teks biasa, angka, kosong, dan karakter kendali', () => {
    expect(csvCell('Budi Santoso')).toBe('"Budi Santoso"');
    expect(csvCell('kata "kutip", koma')).toBe('"kata ""kutip"", koma"');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell('a\u0000b\u001bc')).toBe('"abc"');
    expect(csvCell('baris\r\nbaru')).toBe('"baris\r\nbaru"');
    expect(csvRow(['a', null, 'b'])).toBe('"a","","b"\r\n');
  });
});

describe('publicMetadata', () => {
  it('menyaring rahasia lagi dan membuat nilai bersarang menjadi teks', () => {
    const result = publicMetadata({
      password: 'bocor',
      nested: { accessToken: 'bocor-juga', ok: 1 },
      count: 3,
      flag: true,
      nothing: null,
      infinite: Number.POSITIVE_INFINITY,
      long: 'x'.repeat(600),
    });
    expect(JSON.stringify(result)).not.toContain('bocor');
    expect(result.count).toBe(3);
    expect(result.flag).toBe(true);
    expect(result.nothing).toBeNull();
    expect(result.infinite).toBeNull();
    expect(typeof result.nested).toBe('string');
    expect(String(result.long).length).toBeLessThanOrEqual(501);
  });
});

describe('kursor audit', () => {
  it('bolak-balik, dan kursor rusak/dibuat-buat ditolak', () => {
    const cursor = {
      createdAtExact: '2026-11-14T03:18:30.217123Z',
      id: '01a1d8ac-69cc-7042-9f9d-2c9d642d2ae5',
    };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor('bukan')).toBeUndefined();
    expect(
      decodeAuditCursor(Buffer.from("2026-11-14T03:18:30Z'; drop|x").toString('base64url')),
    ).toBeUndefined();
  });
});
