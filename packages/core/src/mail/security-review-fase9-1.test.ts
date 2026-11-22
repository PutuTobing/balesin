/**
 * Review keamanan Fase 9.1 (docs/security-reviews/2026-11-22-fase9-1.md) — temuan S1 (Tinggi):
 * regex di sanitasi/pemindai HTML email KELUAR berwaktu kubik/kuadratik terhadap panjang masukan.
 * Satu permintaan `POST /public/email/send` (key `email:send`) berisi HTML ≤ 512 KB membekukan event
 * loop api berpuluh menit (Inbox, webhook Meta, semua pengguna ikut berhenti).
 *
 * S1 sudah diperbaiki (putaran 2): tes di bawah `it` biasa dengan asersi utuh — regresi.
 *
 * Ukuran masukan sengaja kecil (≤ 50 KB, jauh di bawah batas 512 KB) supaya CI tetap cepat; perkiraan
 * waktu untuk ukuran penuh ada di laporan.
 */
import { describe, expect, it } from 'vitest';

import { parseInboundEmail } from '../channels/email-message';
import {
  renderOutboundEmail,
  sanitizeOutboundEmailHtml,
  scanTemplateVariables,
} from './outbound-html';

/** Batas wajar untuk HTML puluhan KB (implementasi linear selesai dalam beberapa ms). */
const BUDGET_MS = 300;

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('review 9.1 S1 — ReDoS sanitasi HTML email keluar', () => {
  it('href berisi "{{" + spasi panjang (PLACEHOLDER_ONLY, kubik) selesai < 300 ms — jalur API email:send', () => {
    // ~2,5 KB saja sudah ±2–5 dtk; 20 KB ≈ puluhan menit.
    const html = `<a href="{{${' '.repeat(2_500)}x">bayar</a>`;
    expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it('blok <style> panjang tanpa ; { } (UNSAFE_CSS_DECLARATION, kuadratik) selesai < 300 ms', () => {
    // 50 KB ≈ 3 dtk; 500 KB ≈ 5 menit.
    const html = `<style>${'a'.repeat(50_000)}</style><p>Tagihan</p>`;
    expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it('banyak "<style>" tanpa penutup (STYLE_BLOCK, kuadratik) selesai < 300 ms', () => {
    const html = '<style>'.repeat(40_000);
    expect(elapsed(() => sanitizeOutboundEmailHtml(html))).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it('pemindai variabel template: "{{" + spasi panjang (PLACEHOLDER, kubik) selesai < 300 ms — simpan/pratinjau/terbit', () => {
    const html = `<p>{{${' '.repeat(2_000)}x</p>`;
    expect(
      elapsed(() => scanTemplateVariables({ subject: 'Tagihan', html, text: null })),
    ).toBeLessThan(BUDGET_MS);
  }, 60_000);
});

/**
 * Putaran 2 — temuan S3 (Tinggi): sanitize-html berwaktu super-linear terhadap KEDALAMAN tag
 * (`<div>` bersarang tanpa penutup). Bukan regex — perbaikan S1 tidak menyentuhnya. Jalur: render
 * email API (sanitasi 2× + sanitasi profil masuk di `persist`) dan email MASUK dari internet
 * (`parseInboundEmail` menyanitasi HTML SEBELUM batas 512 KB diperiksa, mentah ≤ 25 MB).
 * Diperbaiki (penjaga `html-guard.ts`: batas tag/kedalaman SEBELUM sanitize-html) — `it` biasa dengan
 * asersi utuh. Render API menjawab galat `html_too_complex`; email masuk membuang HTML.
 */
describe('review 9.1 putaran 2 S3 — sarang tag dalam (sanitize-html super-linear)', () => {
  it('render email API dengan 40.000 <div> bersarang (~200 KB) selesai < 1 dtk', () => {
    const html = '<div>'.repeat(40_000);
    expect(
      elapsed(() =>
        renderOutboundEmail({
          subject: 'Tagihan',
          html,
          text: null,
          values: {},
          organizationName: 'Organisasi',
          qrisImageSrc: null,
          layout: 'brand',
          brand: { primaryColor: '#112233', logoSrc: null, footerText: null },
          substituteVariables: false,
        }),
      ),
    ).toBeLessThan(1_000);
  }, 120_000);

  it('email MASUK 1 MB berisi 200.000 <div> bersarang diurai < 2 dtk (pengirim internet mana pun)', async () => {
    const head = [
      'From: Luar <luar@contoh.example>',
      'To: cs@perusahaan.example',
      'Subject: Halo',
      'Message-ID: <sarang@contoh.example>',
      'Date: Mon, 23 Nov 2026 00:00:00 +0700',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
    ].join(String.fromCharCode(13, 10));
    const crlf = String.fromCharCode(13, 10);
    const raw = Buffer.from(head + crlf + crlf + '<div>'.repeat(200_000) + crlf);
    const start = performance.now();
    await parseInboundEmail(raw, ['cs@perusahaan.example'], []);
    expect(performance.now() - start).toBeLessThan(2_000);
  }, 120_000);
});

/**
 * Putaran 3 — temuan S4 (Sedang): amplifikasi variabel template tanpa batas ukuran hasil. Nilai
 * variabel (≤ 1.000 karakter) di-escape (`&` → `&amp;`, 5×) lalu disisipkan di SETIAP `{{nama}}`;
 * jumlah placeholder tidak dibatasi. 10.000 `{{a}}` (50 KB) × 1.000 `&` ≈ 50 juta karakter ≈ 9 dtk;
 * 50.000 `{{a}}` (250 KB) = api kehabisan heap (proses mati). Perbaikan boleh menolak (galat render)
 * atau membatasi ukuran hasil — asalkan cepat.
 */
describe('review 9.1 putaran 3 S4 — amplifikasi variabel template', () => {
  it.fails(
    '3.000 {{a}} × nilai 1.000 "&" dirender (atau ditolak) < 1 dtk',
    () => {
      expect(
        elapsed(() =>
          renderOutboundEmail({
            subject: 'Tagihan',
            html: '<p>' + '{{a}}'.repeat(3_000) + '</p>',
            text: null,
            values: { a: '&'.repeat(1_000) },
            organizationName: 'Organisasi',
            qrisImageSrc: null,
            layout: 'brand',
            brand: { primaryColor: '#112233', logoSrc: null, footerText: null },
          }),
        ),
      ).toBeLessThan(1_000);
    },
    120_000,
  );
});
