import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_FAILURE_REASONS,
  isRetryableFailure,
  outboundFailureMessage,
  sendMessageRequestSchema,
} from './outbound';

describe('pesan kegagalan kirim', () => {
  it('setiap alasan punya penjelasan bahasa Indonesia', () => {
    for (const reason of OUTBOUND_FAILURE_REASONS) {
      expect(outboundFailureMessage(reason, null).length, reason).toBeGreaterThan(30);
    }
  });

  it('kode Meta umum dijelaskan beserta solusinya', () => {
    expect(outboundFailureMessage('delivery_failed', 131047)).toContain('24 jam');
    expect(outboundFailureMessage('meta_rejected', 130429)).toContain('Tunggu');
    expect(outboundFailureMessage('delivery_failed', 131026)).toContain('kanal lain');
    expect(outboundFailureMessage('meta_rejected', 131051)).toContain('tidak didukung');
    expect(outboundFailureMessage('meta_rejected', 999999)).toContain('kode Meta 999999');
  });

  it('kirim ulang hanya untuk kegagalan yang masuk akal diulang', () => {
    expect(isRetryableFailure('delivery_unknown', null)).toBe(true);
    expect(isRetryableFailure('meta_rejected', 130429)).toBe(true);
    expect(isRetryableFailure('meta_rejected', 131051)).toBe(false);
    expect(isRetryableFailure('recipient_unavailable', null)).toBe(false);
    expect(isRetryableFailure('sender_not_allowed', null)).toBe(false);
  });
});

describe('sendMessageRequestSchema', () => {
  const id = '018f0000-0000-7000-8000-000000000001';
  it('menolak teks kosong, terlalu panjang, atau memuat NUL', () => {
    for (const text of ['   ', 'x'.repeat(4097), 'a\u0000b']) {
      expect(
        sendMessageRequestSchema.safeParse({ type: 'text', clientMessageId: id, text }).success,
      ).toBe(false);
    }
    expect(
      sendMessageRequestSchema.safeParse({ type: 'text', clientMessageId: id, text: 'Halo\nkak' })
        .success,
    ).toBe(true);
  });

  it('jenis tak dikenal / URL media dari klien tidak diterima', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        type: 'media',
        clientMessageId: id,
        mediaUrl: 'http://169.254.169.254/latest',
      }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ type: 'template', clientMessageId: id }).success,
    ).toBe(false);
  });
});
