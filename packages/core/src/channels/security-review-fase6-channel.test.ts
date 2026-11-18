/**
 * Tes penjaga review keamanan Fase 6 — channel Telegram / Email / Messenger & IG (unit)
 * (docs/security-reviews/2026-11-22-fase6-channel.md). `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  classifyEmailAttachment,
  emailAuthWarning,
  normalizeMessageId,
  replySubject,
  sanitizeEmailHtml,
} from './email-message';
import { splitMetaSocialWebhook } from './meta-social';
import { normalizeTelegramUpdate } from './telegram-update';

const require = createRequire(import.meta.url);

describe('review keamanan — HTML email', () => {
  it('skrip, event, gaya, gambar, form, iframe, svg, skema berbahaya dibuang', () => {
    const dirty = [
      '<p onclick="x()">Halo</p>',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(1)">a</a>',
      '<a href="  JaVaScRiPt:alert(1)">b</a>',
      '<a href="jav&#x09;ascript:alert(1)">c</a>',
      '<a href="data:text/html,<script>alert(1)</script>">d</a>',
      '<a href="vbscript:msgbox(1)">e</a>',
      '<a href="//evil.example/x">f</a>',
      '<img src=x onerror=alert(1)>',
      '<svg><script>alert(1)</script></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><input name=p></form>',
      '<style>body{background:url(https://track.example/p)}</style>',
      '<div style="background:url(https://track.example/p)">g</div>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<math><mi xlink:href="javascript:alert(1)">h</mi></math>',
    ].join('');
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(
      /<script|onerror|onclick|<img|<svg|<iframe|<form|<input|<style|style=|<meta|<base|<math/i,
    );
    expect(clean).not.toMatch(/javascript:|vbscript:|data:|href="\/\//i);
    expect(clean).toContain('Halo');
  });

  it('tautan sah tetap ada dengan rel aman & target baru', () => {
    const clean = sanitizeEmailHtml(
      '<a href="https://contoh.id/x" target="_self" rel="opener">x</a>',
    );
    expect(clean).toContain('href="https://contoh.id/x"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
    expect(clean).toContain('target="_blank"');
  });
});

describe('review keamanan — header email keluar', () => {
  it('CR/LF di subjek / Message-ID yang dibalas tidak menyisipkan header baru (nodemailer)', async () => {
    const MailComposer = require('nodemailer/lib/mail-composer') as new (mail: unknown) => {
      compile(): { build(callback: (error: Error | null, message: Buffer) => void): void };
    };
    const injectedSubject = replySubject('Tagihan\r\nBcc: korban@contoh.test');
    const injectedId = normalizeMessageId('<abc@contoh.test\r\nBcc: korban2@contoh.test>') ?? 'x@y';
    const raw = await new Promise<string>((resolve, reject) => {
      new MailComposer({
        from: 'cs@contoh.id',
        to: 'pelanggan@contoh.test',
        subject: injectedSubject,
        text: 'Halo',
        inReplyTo: `<${injectedId}>`,
        references: [`<${injectedId}>`],
      })
        .compile()
        .build((error, message) => (error ? reject(error) : resolve(message.toString('utf8'))));
    });
    const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? '';
    expect(headerBlock).not.toMatch(/^bcc:/im);
  });
});

describe('review keamanan — lampiran email', () => {
  it('berkas eksekusi / HTML / SVG dilewati; isi menentukan jenis, bukan nama', () => {
    const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    for (const [content, name] of [
      [mz, 'faktur.pdf'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'faktur.html'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'logo.svg'],
    ] as const) {
      const verdict = classifyEmailAttachment(content, name);
      // `null` = dilewati; selain itu hanya biner `application/octet-stream` (selalu diunduh).
      if (verdict !== null) expect(verdict.mimeType, name).toBe('application/octet-stream');
    }
  });
});

describe('review keamanan — Telegram & Meta sosial', () => {
  it('Telegram: hanya chat pribadi; pesan grup/kanal & dari bot diabaikan', () => {
    const base = { message_id: 1, date: Math.floor(Date.now() / 1000), text: 'halo' };
    const from = { id: 42, is_bot: false, first_name: 'Budi' };
    for (const chat of [
      { id: -100123, type: 'supergroup', title: 'Grup' },
      { id: -100124, type: 'channel', title: 'Kanal' },
      { id: -55, type: 'group', title: 'Grup kecil' },
    ]) {
      const result = normalizeTelegramUpdate({ update_id: 7, message: { ...base, from, chat } });
      expect(result.ok, chat.type).toBe(false);
    }
    const fromBot = normalizeTelegramUpdate({
      update_id: 8,
      message: { ...base, from: { ...from, is_bot: true }, chat: { id: 42, type: 'private' } },
    });
    expect(fromBot.ok).toBe(false);
    expect(
      normalizeTelegramUpdate({
        update_id: 9,
        message: { ...base, from, chat: { id: 42, type: 'private' } },
      }).ok,
    ).toBe(true);
  });

  it('Messenger: entri untuk Halaman lain tidak diterima (misrouted)', () => {
    const split = splitMetaSocialWebhook(
      {
        object: 'page',
        entry: [
          {
            id: '111111111111111',
            time: Date.now(),
            messaging: [
              {
                sender: { id: '333333333333333' },
                recipient: { id: '111111111111111' },
                timestamp: Date.now(),
                message: { mid: 'm1', text: 'halo' },
              },
            ],
          },
        ],
      },
      'messenger',
      '222222222222222',
    );
    expect(split.items).toHaveLength(0);
    expect(split.misrouted).toBeGreaterThan(0);
  });
});

describe('review keamanan — pengirim email palsu', () => {
  it('Authentication-Results gagal → peringatan, walau ada hasil "pass" palsu dari pengirim', () => {
    const headers = new Map<string, string>([
      ['authentication-results', 'mx.contoh.id; dmarc=fail; spf=fail; x; attacker; dmarc=pass'],
    ]);
    expect(emailAuthWarning(headers as never)).toBe(true);
  });

  it.fails('R1: tanpa Authentication-Results (server tidak memeriksa) pengirim dianggap BELUM terverifikasi', () => {
    expect(emailAuthWarning(new Map() as never)).toBe(true);
  });
});
