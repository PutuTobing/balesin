/**
 * Review keamanan Fase 9.1 (docs/security-reviews/2026-11-22-fase9-1.md) — temuan S1 (Tinggi):
 * regex di sanitasi/pemindai HTML email KELUAR berwaktu kubik/kuadratik terhadap panjang masukan.
 * Satu permintaan `POST /public/email/send` (key `email:send`) berisi HTML ≤ 512 KB membekukan event
 * loop api berpuluh menit (Inbox, webhook Meta, semua pengguna ikut berhenti).
 *
 * Tes di bawah `it.fails` = MENGUNCI temuan: lulus selama celah masih ada. Setelah diperbaiki, ubah
 * menjadi `it` biasa (tes akan gagal sebagai pengingat bila lupa).
 *
 * Ukuran masukan sengaja kecil (≤ 50 KB, jauh di bawah batas 512 KB) supaya CI tetap cepat; perkiraan
 * waktu untuk ukuran penuh ada di laporan.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeOutboundEmailHtml, scanTemplateVariables } from './outbound-html';

/** Batas wajar untuk HTML puluhan KB (implementasi linear selesai dalam beberapa ms). */
const BUDGET_MS = 300;

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('review 9.1 S1 — ReDoS sanitasi HTML email keluar', () => {
  it.fails(
    'href berisi "{{" + spasi panjang (PLACEHOLDER_ONLY, kubik) selesai < 300 ms — jalur API email:send',
    () => {
      // ~2,5 KB saja sudah ±2–5 dtk; 20 KB ≈ puluhan menit.
      const html = `<a href="{{${' '.repeat(2_500)}x">bayar</a>`;
      expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it.fails(
    'blok <style> panjang tanpa ; { } (UNSAFE_CSS_DECLARATION, kuadratik) selesai < 300 ms',
    () => {
      // 50 KB ≈ 3 dtk; 500 KB ≈ 5 menit.
      const html = `<style>${'a'.repeat(50_000)}</style><p>Tagihan</p>`;
      expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it.fails(
    'banyak "<style>" tanpa penutup (STYLE_BLOCK, kuadratik) selesai < 300 ms',
    () => {
      const html = '<style>'.repeat(40_000);
      expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it.fails(
    'pemindai variabel template: "{{" + spasi panjang (PLACEHOLDER, kubik) selesai < 300 ms — simpan/pratinjau/terbit',
    () => {
      const html = `<p>{{${' '.repeat(2_000)}x</p>`;
      expect(
        elapsed(() => scanTemplateVariables({ subject: 'Tagihan', html, text: null })),
      ).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );
});
