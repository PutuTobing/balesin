/**
 * Tes penjaga review keamanan MobiChat S1 (Putaran 2): potongan jawaban penerima webhook disensor
 * sebelum disimpan (docs/security-reviews/2026-11-19-fase3-kompat-mobichat.md). Semua `it` = regresi.
 */
import { describe, expect, it } from 'vitest';

import { scrubSnippet } from './webhooks-out';

const KEY = [
  'blsn',
  'live',
  '0123456789abcdef',
  'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tX',
].join('_');
const SECRET_PART = KEY.slice(-43);

describe('review keamanan — scrubSnippet', () => {
  it('key utuh (sekali/berkali-kali, di dalam JSON) disensor', () => {
    const echoed = JSON.stringify({ a: 1, mobichat_api_key: KEY, again: KEY });
    const result = scrubSnippet(echoed, KEY) ?? '';
    expect(result).not.toContain(SECRET_PART);
    expect(result).not.toContain(SECRET_PART.slice(0, 12));
  });

  it('key terpotong di batas 500 byte (awalan ≥ 12 karakter di ujung) disensor', () => {
    for (const keep of [12, 20, 30, KEY.length - 1]) {
      const snippet = `${'x'.repeat(500 - keep)}${KEY.slice(0, keep)}`;
      const result = scrubSnippet(snippet, KEY) ?? '';
      expect(result.endsWith(KEY.slice(0, keep)), String(keep)).toBe(false);
      expect(result.length).toBeLessThanOrEqual(500);
    }
  });

  it('pola rahasia umum tanpa key yang disisipkan juga disensor (blsn_live_, whsec_, Bearer)', () => {
    const otherKey = ['blsn', 'live', 'fedcba9876543210', 'Q'.repeat(43)].join('_');
    const signing = `whsec_${'W'.repeat(32)}`;
    const result =
      scrubSnippet(`k=${otherKey} s=${signing} Authorization: Bearer ${'T'.repeat(40)}`, null) ??
      '';
    expect(result).not.toContain('Q'.repeat(20));
    expect(result).not.toContain('W'.repeat(20));
    expect(result).not.toContain('T'.repeat(20));
  });

  it('teks biasa tidak diubah; null tetap null', () => {
    expect(scrubSnippet('{"ok":true}', KEY)).toBe('{"ok":true}');
    expect(scrubSnippet(null, KEY)).toBeNull();
  });
});
