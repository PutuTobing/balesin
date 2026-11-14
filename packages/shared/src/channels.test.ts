import { describe, expect, it } from 'vitest';

import {
  CHANNEL_TEST_CODES,
  CHANNEL_TEST_MESSAGES,
  CHANNEL_WARNING_MESSAGES,
  META_ERROR_KINDS,
  META_ERROR_MESSAGES,
  createChannelRequestSchema,
  messagingLimitLabel,
  numberWarnings,
  phoneNumberStatusLabel,
  qualityRatingLabel,
  updateBusinessProfileRequestSchema,
  updateChannelRequestSchema,
  whatsAppChannelSchema,
  type WhatsAppNumberSummary,
} from './channels';

const valid = {
  type: 'whatsapp',
  name: 'CS Utama',
  phoneNumberId: '106540352242922',
  wabaId: '102290129340398',
  accessToken: 'EAAGm0PX4ZCpsBAtokenSistemUser0123456789',
  appSecret: '0123456789abcdef0123456789abcdef',
};

describe('wizard channel WhatsApp', () => {
  it('menerima isian sah; ID & token dipangkas (hasil tempel), App Secret huruf/angka', () => {
    const parsed = createChannelRequestSchema.parse({
      ...valid,
      phoneNumberId: ` ${valid.phoneNumberId} `,
      accessToken: `${valid.accessToken}\n`,
    });
    expect(parsed).toEqual(valid);
  });

  it('menolak ID bukan angka, token berspasi, App Secret aneh, jenis channel lain', () => {
    for (const patch of [
      { phoneNumberId: '1065-4035' },
      { wabaId: 'abc' },
      { accessToken: 'EAAG token dengan spasi di tengah 123' },
      { accessToken: 'pendek' },
      { appSecret: 'rahasia!' },
      { name: 'x' },
      { type: 'telegram' },
    ]) {
      expect(
        createChannelRequestSchema.safeParse({ ...valid, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('ubah: minimal satu isian; konfirmasi identitas opsional di skema (ditegakkan server)', () => {
    expect(updateChannelRequestSchema.safeParse({}).success).toBe(false);
    expect(updateChannelRequestSchema.safeParse({ confirmation: { password: 'x' } }).success).toBe(
      false,
    );
    expect(updateChannelRequestSchema.safeParse({ name: 'CS Kedua' }).success).toBe(true);
    expect(
      updateChannelRequestSchema.safeParse({
        accessToken: valid.accessToken,
        confirmation: { password: 'kopi-tubruk-gerimis', code: '123456' },
      }).success,
    ).toBe(true);
  });

  it('tampilan channel tidak punya isian token/App Secret/verify token — hanya petunjuk', () => {
    const keys = Object.keys(whatsAppChannelSchema.shape);
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('appSecret');
    expect(keys).not.toContain('verifyToken');
    expect(keys).toEqual(expect.arrayContaining(['accessTokenHint', 'appSecretHint']));
  });
});

describe('pesan & label', () => {
  it('setiap kode tes, jenis error Meta, dan peringatan punya pesan Indonesia', () => {
    for (const code of CHANNEL_TEST_CODES) expect(CHANNEL_TEST_MESSAGES[code]).toMatch(/\.$/);
    for (const kind of META_ERROR_KINDS)
      expect(META_ERROR_MESSAGES[kind].length).toBeGreaterThan(20);
    for (const message of [
      ...Object.values(CHANNEL_TEST_MESSAGES),
      ...Object.values(META_ERROR_MESSAGES),
      ...Object.values(CHANNEL_WARNING_MESSAGES),
    ]) {
      expect(message).not.toMatch(/\banda\b/i);
    }
  });

  it('label nilai Meta; nilai baru yang belum dikenal ditampilkan apa adanya', () => {
    expect(qualityRatingLabel('GREEN')).toBe('Tinggi');
    expect(qualityRatingLabel(null)).toBe('Belum dinilai');
    expect(phoneNumberStatusLabel('CONNECTED')).toBe('Terhubung');
    expect(phoneNumberStatusLabel('STATUS_BARU')).toBe('STATUS_BARU');
    expect(messagingLimitLabel('TIER_2K')).toBe('2.000 pelanggan per 24 jam');
    expect(messagingLimitLabel('toString')).toBe('toString');
  });

  it('peringatan dari data nomor', () => {
    const number: WhatsAppNumberSummary = {
      displayPhoneNumber: '+62 811',
      verifiedName: 'Maju',
      qualityRating: 'YELLOW',
      status: 'CONNECTED',
      nameStatus: 'AVAILABLE_WITHOUT_REVIEW',
      codeVerificationStatus: 'VERIFIED',
      messagingLimit: 'TIER_250',
      throughputLevel: null,
      fetchedAt: '2026-11-14T00:00:00.000Z',
    };
    expect(numberWarnings(number).map((warning) => warning.code)).toEqual(['quality_medium']);
    expect(numberWarnings(null)).toEqual([]);
  });
});

describe('profil bisnis', () => {
  it('batas Meta: Info ≤139 & tidak kosong, website ≤2 & https, kategori dari daftar', () => {
    expect(updateBusinessProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateBusinessProfileRequestSchema.safeParse({ about: '' }).success).toBe(false);
    expect(updateBusinessProfileRequestSchema.safeParse({ about: 'x'.repeat(140) }).success).toBe(
      false,
    );
    expect(
      updateBusinessProfileRequestSchema.safeParse({ websites: ['majujaya.test'] }).success,
    ).toBe(false);
    expect(
      updateBusinessProfileRequestSchema.safeParse({ websites: ['https://user@evil.test'] })
        .success,
    ).toBe(false);
    expect(updateBusinessProfileRequestSchema.safeParse({ vertical: 'KASINO' }).success).toBe(
      false,
    );
    expect(
      updateBusinessProfileRequestSchema.parse({
        about: ' Halo ',
        email: 'CS@Contoh.CO.ID',
        websites: ['https://contoh.co.id/kontak?x=1'],
        vertical: '',
        description: 'Baris satu\nBaris dua',
      }),
    ).toEqual({
      about: 'Halo',
      email: 'cs@contoh.co.id',
      websites: ['https://contoh.co.id/kontak?x=1'],
      vertical: '',
      description: 'Baris satu\nBaris dua',
    });
    expect(updateBusinessProfileRequestSchema.safeParse({ address: 'a\nb' }).success).toBe(false);
  });
});
