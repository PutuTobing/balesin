import { describe, expect, it } from 'vitest';

import {
  cleanCustomerText,
  cleanFileName,
  contactIdentityLockKeys,
  safeHttpUrl,
  waIdToE164,
  whatsAppContactIdentity,
} from './contact-identity';
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
    expect(whatsAppContactIdentity({ userId: 'ID.\u202e1', waId: null }).bsuid).toBeNull();
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
    expect(cleanCustomerText('  Budi\u202e  Santoso\n')).toBe('Budi Santoso');
    expect(cleanCustomerText('A\u200bB\u2066C')).toBe('A B C');
  });

  it('emoji gabungan (ZWJ) dipertahankan', () => {
    expect(cleanCustomerText('Keluarga 👨‍👩‍👧')).toBe('Keluarga 👨‍👩‍👧');
  });

  it('kosong → null; dipotong per titik kode (emoji tidak terbelah)', () => {
    expect(cleanCustomerText('\u202e\u200b ')).toBeNull();
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

describe('safeHttpUrl (review kontak R2)', () => {
  it('hanya http/https yang sah', () => {
    expect(safeHttpUrl('https://fb.me/iklan?id=1')).toBe('https://fb.me/iklan?id=1');
    expect(safeHttpUrl(' http://contoh.test/a ')).toBe('http://contoh.test/a');
    for (const value of [
      'javascript:alert(document.cookie)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//contoh.test/tanpa-skema',
      'https://contoh.test/\u202egnp.exe',
      'bukan url',
      '',
      null,
      `https://contoh.test/${'a'.repeat(3000)}`,
    ]) {
      expect(safeHttpUrl(value), String(value).slice(0, 40)).toBeNull();
    }
  });
});

describe('cleanFileName (review kontak R2)', () => {
  it('membuang pengubah arah/karakter tak terlihat dan pemisah path; basename; maks 255', () => {
    expect(cleanFileName('../tagihan\u202efdp.exe')).toBe('tagihanfdp.exe');
    expect(cleanFileName('..\\..\\windows\\system32\\ktp.pdf')).toBe('ktp.pdf');
    expect(cleanFileName('/etc/passwd')).toBe('passwd');
    expect(cleanFileName('foto\u0000ktp\n.jpg')).toBe('fotoktp.jpg');
    expect(cleanFileName('  bukti   transfer.png ')).toBe('bukti transfer.png');
    expect(cleanFileName('../')).toBeNull();
    expect(cleanFileName('..')).toBeNull();
    expect(cleanFileName('\u202e\u200b')).toBeNull();
    expect(cleanFileName(null)).toBeNull();
    const long = cleanFileName(`${'é'.repeat(300)}.pdf`);
    expect(Array.from(long ?? '')).toHaveLength(255);
  });

  it('review 9A-2 R7: titik/spasi di akhir dibuang (nama = nama yang disimpan Windows)', () => {
    expect(cleanFileName('tagihan.pdf.js.')).toBe('tagihan.pdf.js');
    expect(cleanFileName('tagihan.pdf.js . . ')).toBe('tagihan.pdf.js');
    expect(cleanFileName('...')).toBeNull();
    expect(cleanFileName('.env')).toBe('.env');
  });
});

describe('contactIdentityLockKeys', () => {
  it('format tetap, terurut, hanya identitas yang ada', () => {
    expect(
      contactIdentityLockKeys('org-1', 'whatsapp', { bsuid: 'ID.1', phone: '+62811' }),
    ).toEqual(['contact:org-1:whatsapp:bsuid:ID.1', 'contact:org-1:whatsapp:phone:+62811']);
    expect(contactIdentityLockKeys('org-1', 'whatsapp', { bsuid: null, phone: '+62811' })).toEqual([
      'contact:org-1:whatsapp:phone:+62811',
    ]);
    expect(contactIdentityLockKeys('org-1', 'whatsapp', { bsuid: null, phone: null })).toEqual([]);
  });
});
