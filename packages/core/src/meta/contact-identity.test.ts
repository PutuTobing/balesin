import { describe, expect, it } from 'vitest';

import { cleanCustomerText, waIdToE164, whatsAppContactIdentity } from './contact-identity';
import { splitWhatsAppWebhook } from './webhook-payload';

describe('waIdToE164', () => {
  it('wa_id Meta (digit tanpa +) → E.164', () => {
    expect(waIdToE164('6281234567890')).toBe('+6281234567890');
    expect(waIdToE164('+6281234567890')).toBe('+6281234567890');
    expect(waIdToE164('16505551234')).toBe('+16505551234');
    expect(waIdToE164('6281234')).toBe('+6281234'); // 7 digit: batas bawah
  });

  it('bukan nomor sah → null (tidak pernah dibalas)', () => {
    for (const value of [
      null,
      undefined,
      '',
      '081234567890', // awalan 0 lokal, bukan E.164
      '628123', // terlalu pendek
      '1234567890123456', // 16 digit
      '62 812 3456 7890',
      '62812-3456-7890',
      '6281234567890\n',
      '٦٢٨١٢٣٤٥٦٧٨٩٠', // digit Arab-Indik
      'abc',
    ]) {
      expect(waIdToE164(value), String(value)).toBeNull();
    }
  });
});

describe('whatsAppContactIdentity', () => {
  it('BSUID + nomor', () => {
    expect(
      whatsAppContactIdentity({ userId: 'ID.13491208655302741918', waId: '6281234567890' }),
    ).toEqual({ bsuid: 'ID.13491208655302741918', phone: '+6281234567890' });
  });

  it('hanya BSUID (pelanggan memakai username tanpa nomor)', () => {
    expect(whatsAppContactIdentity({ userId: 'US.1', waId: null })).toEqual({
      bsuid: 'US.1',
      phone: null,
    });
  });

  it('hanya nomor (payload lama tanpa BSUID)', () => {
    expect(whatsAppContactIdentity({ userId: null, waId: '6281234567890' })).toEqual({
      bsuid: null,
      phone: '+6281234567890',
    });
  });

  it('BSUID berkarakter aneh/terlalu panjang dianggap tidak ada', () => {
    expect(whatsAppContactIdentity({ userId: 'ID 1; drop', waId: null }).bsuid).toBeNull();
    expect(whatsAppContactIdentity({ userId: 'x'.repeat(257), waId: null }).bsuid).toBeNull();
    expect(whatsAppContactIdentity({ userId: 'ID.‮1', waId: null }).bsuid).toBeNull();
  });
});

/** Ada surrogate tunggal (emoji terbelah di tengah)? */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('cleanCustomerText', () => {
  it('membuang pengubah arah, lebar-nol, baris baru; merapatkan spasi', () => {
    expect(cleanCustomerText('  Budi‮  Santoso\n')).toBe('Budi Santoso');
    expect(cleanCustomerText('A​B⁦C')).toBe('A B C');
  });

  it('emoji gabungan (ZWJ) dipertahankan', () => {
    expect(cleanCustomerText('Keluarga 👨‍👩‍👧')).toBe('Keluarga 👨‍👩‍👧');
  });

  it('kosong → null; dipotong per titik kode (emoji tidak terbelah)', () => {
    expect(cleanCustomerText('‮​ ')).toBeNull();
    expect(cleanCustomerText(null)).toBeNull();
    const cleaned = cleanCustomerText('😀'.repeat(300));
    expect(Array.from(cleaned ?? '')).toHaveLength(256);
    expect(hasLoneSurrogate(cleaned ?? '')).toBe(false);
  });
});

describe('kejadian field lain (S4)', () => {
  it('hanya hash isi yang disimpan, bukan isinya', () => {
    const value = { event: 'APPROVED', message_template_name: 'tagihan_bulanan', reason: 'NONE' };
    const { items } = splitWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        { id: '102290129340398', changes: [{ field: 'message_template_status_update', value }] },
      ],
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.kind).toBe('other');
    const payload = item?.payload as { wabaId: string; valueSha256: string };
    expect(Object.keys(payload).sort()).toEqual(['valueSha256', 'wabaId']);
    expect(payload.wabaId).toBe('102290129340398');
    expect(payload.valueSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(item?.payload)).not.toContain('tagihan_bulanan');
  });
});
