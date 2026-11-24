import { describe, expect, it } from 'vitest';

import { TimeoutError } from '../timeout';
import { classifyApiSmtpError, sendApiEmail } from './api-smtp';

const smtpError = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

describe('klasifikasi galat SMTP email API (§4)', () => {
  it('4xx sementara vs pembatasan laju 4.7.x', () => {
    expect(
      classifyApiSmtpError(
        smtpError({ responseCode: 450, command: 'RCPT TO', response: '450 4.2.0 busy' }),
      ).kind,
    ).toBe('temporary');
    expect(
      classifyApiSmtpError(
        smtpError({ responseCode: 421, command: 'CONN', response: '421 4.7.0 Try again later' }),
      ),
    ).toMatchObject({ kind: 'throttled', smtpCode: 421 });
    expect(
      classifyApiSmtpError(
        smtpError({ responseCode: 451, command: 'DATA', response: '451 4.7.1 too many messages' }),
      ).kind,
    ).toBe('throttled');
  });

  it('5xx per tahap: MAIL → sender, RCPT → recipients, DATA → message; login → auth', () => {
    expect(classifyApiSmtpError(smtpError({ responseCode: 550, command: 'MAIL FROM' })).kind).toBe(
      'sender_rejected',
    );
    expect(
      classifyApiSmtpError(smtpError({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }))
        .kind,
    ).toBe('recipients_rejected');
    expect(classifyApiSmtpError(smtpError({ responseCode: 552, command: 'DATA' })).kind).toBe(
      'message_rejected',
    );
    expect(classifyApiSmtpError(smtpError({ code: 'EAUTH', responseCode: 535 })).kind).toBe('auth');
  });

  it('putus setelah DATA / batas waktu total = tidak pasti; sebelum = sementara; teks server tidak dikembalikan', () => {
    expect(classifyApiSmtpError(smtpError({ code: 'ECONNECTION', command: 'DATA' })).kind).toBe(
      'delivery_unknown',
    );
    expect(classifyApiSmtpError(new TimeoutError('x', 1)).kind).toBe('delivery_unknown');
    expect(classifyApiSmtpError(smtpError({ code: 'ECONNREFUSED' })).kind).toBe('temporary');
    const verdict = classifyApiSmtpError(
      smtpError({ responseCode: 550, command: 'RCPT TO', response: '550 rahasia server internal' }),
    );
    expect(JSON.stringify(verdict)).not.toContain('rahasia');
  });

  it('port di luar daftar izin → config tanpa sambungan', async () => {
    const result = await sendApiEmail(
      { host: 'smtp.contoh.example', port: 2526, security: 'ssl', username: null, password: null },
      { allowedPorts: [465] },
      {
        envelopeFrom: 'a@contoh.example',
        from: { name: 'A', address: 'a@contoh.example' },
        to: [{ email: 'b@contoh.example', name: null }],
        cc: [],
        bcc: [],
        replyTo: null,
        subject: 'x',
        text: 'x',
        html: null,
        messageId: 'id@contoh.example',
        inReplyTo: null,
        references: [],
        inline: [],
        attachments: [],
      },
    );
    expect(result).toMatchObject({ ok: false, kind: 'config', code: 'port_not_allowed' });
  });
});
