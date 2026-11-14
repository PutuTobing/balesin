/**
 * Review keamanan Fase 2 butir 1–2 (docs/security-reviews/2026-11-15-fase2-channel-whatsapp.md):
 * validasi isian channel & profil bisnis.
 */
import { describe, expect, it } from 'vitest';

import {
  channelNameSchema,
  createChannelRequestSchema,
  updateBusinessProfileRequestSchema,
} from './channels';

const base = {
  type: 'whatsapp',
  name: 'CS Utama',
  phoneNumberId: '106540352242922',
  wabaId: '102290129340398',
  accessToken: 'EAAGm0PX4ZCpsBAtokenSistemUser0123456789',
  appSecret: '0123456789abcdef0123456789abcdef',
} as const;

describe('review fase 2 — validasi isian', () => {
  it('penjaga: ID Meta hanya angka (tidak bisa membelokkan path Graph API)', () => {
    for (const phoneNumberId of ['../me', '123/messages', '123?fields=x', 'evil.com', '12 34']) {
      expect(createChannelRequestSchema.safeParse({ ...base, phoneNumberId }).success).toBe(false);
    }
    for (const wabaId of ['me', '1%2F2', '-1']) {
      expect(createChannelRequestSchema.safeParse({ ...base, wabaId }).success).toBe(false);
    }
  });

  it('penjaga: token/App Secret tanpa spasi, baris baru, atau karakter header', () => {
    for (const accessToken of [`${base.accessToken}\r\nX-Evil: 1`, `${base.accessToken} x`]) {
      expect(createChannelRequestSchema.safeParse({ ...base, accessToken }).success).toBe(false);
    }
    expect(
      createChannelRequestSchema.safeParse({ ...base, appSecret: `${base.appSecret}!` }).success,
    ).toBe(false);
  });

  it('penjaga: website profil bisnis hanya http(s) tanpa kredensial', () => {
    for (const website of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://user:pass@contoh.co.id',
      'https://contoh',
      '//contoh.co.id',
    ]) {
      expect(updateBusinessProfileRequestSchema.safeParse({ websites: [website] }).success).toBe(
        false,
      );
    }
  });

  /**
   * R4: `hasControlCharacters` hanya menolak C0 + DEL. Karakter pengubah arah (U+202E RLO, U+2066–
   * U+2069), lebar-nol (U+200B, U+2060), dan C1 lolos ke nama channel — nama itu tampil di subjek &
   * isi email ke Owner dan di inbox, jadi bisa dipakai menyamarkan nama ("CS Utama" terbalik/
   * tersembunyi). Yang diharapkan: ditolak seperti karakter kendali lain.
   */
  it('R4: nama channel menolak karakter pengubah arah / lebar-nol', () => {
    for (const name of ['CS ‮amatu', 'CS​Utama', 'CS ⁦Utama⁩', 'CS\u0085Utama']) {
      expect(channelNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
    }
  });
});
