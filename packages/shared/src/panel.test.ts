import { describe, expect, it } from 'vitest';

import { contactAttributesSchema, updateContactRequestSchema } from './inbox';
import {
  createQuickReplyRequestSchema,
  quickReplyShortcutSchema,
  renderQuickReply,
  unknownQuickReplyVariables,
} from './quick-replies';
import { createTagRequestSchema, tagNameSchema } from './tags';

describe('quick reply', () => {
  it('shortcut dinormalkan: tanpa "/" di depan, huruf kecil; spasi ditolak', () => {
    expect(quickReplyShortcutSchema.parse(' /Salam-Pagi ')).toBe('salam-pagi');
    for (const bad of ['', '/', 'dua kata', '-awal', 'x'.repeat(33), 'émoji']) {
      expect(quickReplyShortcutSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('hanya {nama} & {agen}; variabel lain ditolak saat menyimpan', () => {
    expect(unknownQuickReplyVariables('Halo {nama} {nam} {x_1} {nam}')).toEqual(['nam', 'x_1']);
    expect(
      createQuickReplyRequestSchema.safeParse({ shortcut: 'a', title: 'A', body: 'Halo {nama}' })
        .success,
    ).toBe(true);
    expect(
      createQuickReplyRequestSchema.safeParse({ shortcut: 'a', title: 'A', body: 'Halo {nam}' })
        .success,
    ).toBe(false);
    // Kurung kurawal biasa (bukan bentuk variabel) tetap boleh.
    expect(
      createQuickReplyRequestSchema.safeParse({ shortcut: 'a', title: 'A', body: 'Kode { 12 }' })
        .success,
    ).toBe(true);
  });

  it('nilai pengganti tidak diproses ulang', () => {
    expect(renderQuickReply('Halo {nama}, saya {agen}.', { nama: '{agen}', agen: 'Ani' })).toBe(
      'Halo {agen}, saya Ani.',
    );
  });
});

describe('tag & kontak', () => {
  it('nama tag satu baris tanpa karakter tak terlihat; warna dari palet', () => {
    expect(tagNameSchema.parse('  MITRA-SURYA ')).toBe('MITRA-SURYA');
    expect(tagNameSchema.safeParse('a\u200bb').success).toBe(false);
    expect(createTagRequestSchema.parse({ name: 'VIP' }).color).toBe('blue');
    expect(createTagRequestSchema.safeParse({ name: 'VIP', color: '#fff' }).success).toBe(false);
  });

  it('atribut: kunci unik tanpa beda huruf, batas jumlah, tanpa kunci prototipe', () => {
    expect(contactAttributesSchema.safeParse([{ key: 'ID pelanggan', value: '1' }]).success).toBe(
      true,
    );
    expect(
      contactAttributesSchema.safeParse([
        { key: 'Area', value: '1' },
        { key: 'area', value: '2' },
      ]).success,
    ).toBe(false);
    expect(contactAttributesSchema.safeParse([{ key: '__proto__', value: '1' }]).success).toBe(
      false,
    );
    const many = Array.from({ length: 31 }, (_, index) => ({
      key: `k${String(index)}`,
      value: 'v',
    }));
    expect(contactAttributesSchema.safeParse(many).success).toBe(false);
  });

  it('ubah kontak: minimal satu isian; email dinormalkan; catatan boleh baris baru', () => {
    expect(updateContactRequestSchema.safeParse({}).success).toBe(false);
    expect(updateContactRequestSchema.parse({ email: ' Budi@Contoh.ID ' }).email).toBe(
      'budi@contoh.id',
    );
    expect(updateContactRequestSchema.safeParse({ notes: 'baris 1\nbaris 2' }).success).toBe(true);
    expect(updateContactRequestSchema.safeParse({ notes: 'a\u202eb' }).success).toBe(false);
    expect(updateContactRequestSchema.parse({ name: null }).name).toBeNull();
  });
});
