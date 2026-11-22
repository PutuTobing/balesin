import { describe, expect, it } from 'vitest';

import { parseDeliveryStatusReport } from './dsn';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'latin1');

/** DSN baku RFC 3464 (data fiktif): satu penerima gagal 5.1.1, satu tertunda. */
const STANDARD = crlf([
  'Return-Path: <>',
  'From: Mail Delivery System <MAILER-DAEMON@mx.contoh.example>',
  'To: billing@perusahaan.example',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <bounce-1@mx.contoh.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="BATAS-1"',
  '',
  'Ini laporan pengiriman.',
  '--BATAS-1',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'Email tidak bisa dikirim ke penerima berikut.',
  'Message-ID: <jangan-dipakai@contoh.example>',
  '',
  '--BATAS-1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.contoh.example',
  'Arrival-Date: Wed, 25 Nov 2026 09:07:10 +0700',
  '',
  'Final-Recipient: rfc822; Budi.Santoso@contoh.example',
  'Original-Recipient: rfc822;budi.santoso@contoh.example',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
  '',
  'Final-Recipient: rfc822; sari@contoh.example',
  'Action: delayed',
  'Status: 4.4.7',
  '',
  '--BATAS-1',
  'Content-Type: text/rfc822-headers',
  '',
  'From: Billing <billing@perusahaan.example>',
  'To: budi.santoso@contoh.example',
  'Message-ID: <a1b2c3d4-0000-4000-8000-000000000001@perusahaan.example>',
  'Subject: Tagihan November 2026',
  '',
  '--BATAS-1--',
  '',
]);

describe('parseDeliveryStatusReport', () => {
  it('laporan baku: penerima per blok + Message-ID asli', async () => {
    const report = await parseDeliveryStatusReport(STANDARD);
    expect(report).toEqual({
      standard: true,
      originalMessageIds: ['a1b2c3d4-0000-4000-8000-000000000001@perusahaan.example'],
      recipients: [
        { recipient: 'budi.santoso@contoh.example', action: 'failed', status: '5.1.1' },
        { recipient: 'sari@contoh.example', action: 'delayed', status: '4.4.7' },
      ],
    });
  });

  it('email asli terlampir sebagai message/rfc822 (base64) dan laporan di dalam multipart/mixed', async () => {
    const original = Buffer.from(
      [
        'From: billing@perusahaan.example',
        'Message-ID: <asli-77@perusahaan.example>',
        'Subject: Tes',
        '',
        'Isi',
      ].join('\r\n'),
    ).toString('base64');
    const raw = crlf([
      'From: postmaster@mx.contoh.example',
      'Content-Type: multipart/mixed; boundary=LUAR',
      '',
      '--LUAR',
      'Content-Type: multipart/report; report-type="delivery-status"; boundary=DALAM',
      '',
      '--DALAM',
      'Content-Type: message/delivery-status',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Reporting-MTA: dns; mx.contoh.example',
      '',
      'Final-Recipient: rfc822; <arsip@perusahaan.example>',
      'Action: Failed',
      'Status: 5.2.2 (mailbox full)',
      '',
      '--DALAM',
      'Content-Type: message/rfc822',
      'Content-Transfer-Encoding: base64',
      '',
      original,
      '--DALAM--',
      '--LUAR--',
      '',
    ]);
    expect(await parseDeliveryStatusReport(raw)).toEqual({
      standard: true,
      originalMessageIds: ['asli-77@perusahaan.example'],
      recipients: [{ recipient: 'arsip@perusahaan.example', action: 'failed', status: '5.2.2' }],
    });
  });

  it('status tidak sah → null, alamat tidak sah dilewati', async () => {
    const raw = crlf([
      'Content-Type: multipart/report; report-type=delivery-status; boundary=B',
      '',
      '--B',
      'Content-Type: message/delivery-status',
      '',
      'Final-Recipient: rfc822; bukan-alamat',
      'Action: failed',
      '',
      'Final-Recipient: rfc822; budi@contoh.example',
      'Action: failed',
      'Status: lima',
      '',
      '--B--',
    ]);
    expect(await parseDeliveryStatusReport(raw)).toEqual({
      standard: true,
      originalMessageIds: [],
      recipients: [{ recipient: 'budi@contoh.example', action: 'failed', status: null }],
    });
  });

  it('cadangan MAILER-DAEMON tanpa laporan baku: Message-ID dari isi (selain milik bounce)', async () => {
    const raw = crlf([
      'From: MAILER-DAEMON@mx.contoh.example',
      'Message-ID: <bounce-9@mx.contoh.example>',
      'Subject: Delivery failure',
      'Content-Type: text/plain',
      '',
      'Pesanmu tidak terkirim.',
      'Final-Recipient: rfc822; budi@contoh.example',
      'Action: failed',
      'Status: 5.1.1',
      '',
      '----- Header asli -----',
      'Message-ID: <bounce-9@mx.contoh.example>',
      '> Message-Id: <asli-1@perusahaan.example>',
      'Message-ID: <asli-2@perusahaan.example>',
    ]);
    expect(await parseDeliveryStatusReport(raw)).toEqual({
      standard: false,
      originalMessageIds: ['asli-1@perusahaan.example', 'asli-2@perusahaan.example'],
      recipients: [{ recipient: 'budi@contoh.example', action: 'failed', status: '5.1.1' }],
    });
  });

  it('cadangan Return-Path kosong tanpa penerima → recipients []', async () => {
    const raw = crlf([
      'Return-Path: <>',
      'From: Server <noreply@mx.contoh.example>',
      'Content-Type: text/plain',
      '',
      'Message-ID: <asli-3@perusahaan.example>',
    ]);
    expect(await parseDeliveryStatusReport(raw)).toEqual({
      standard: false,
      originalMessageIds: ['asli-3@perusahaan.example'],
      recipients: [],
    });
  });

  it('email biasa (balasan pelanggan) → null', async () => {
    const raw = crlf([
      'From: Budi <budi@contoh.example>',
      'To: billing@perusahaan.example',
      'Message-ID: <balas-1@contoh.example>',
      'In-Reply-To: <asli-1@perusahaan.example>',
      'Content-Type: text/plain',
      '',
      'Sudah saya bayar.',
      'Message-ID: <asli-1@perusahaan.example>',
    ]);
    expect(await parseDeliveryStatusReport(raw)).toBeNull();
  });

  it('dibatasi 20 Message-ID', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Message-ID: <m${String(i)}@x.example>`);
    const raw = crlf(['From: postmaster@x.example', 'Content-Type: text/plain', '', ...lines]);
    const report = await parseDeliveryStatusReport(raw);
    expect(report?.originalMessageIds).toHaveLength(20);
  });
});
