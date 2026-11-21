import { describe, expect, it } from 'vitest';

import {
  API_ROUTES,
  EMAIL_TEMPLATE_IDS,
  ERROR_STATUS,
  INVITE_PERMISSIONS,
  USER_ROLES,
  acceptInvitationRequestSchema,
  apiPath,
  buildTokenLink,
  canInviteRole,
  completePasswordResetRequestSchema,
  createInvitationRequestSchema,
  emailTemplateIdSchema,
  invitationIssuerAuthorized,
  linkTokenSchema,
  readTokenFromFragment,
  requestPasswordResetRequestSchema,
} from './index';

describe('tautan email bertoken', () => {
  it('disusun dari APP_URL, token di fragment (bukan path/query), path dasar dipertahankan', () => {
    expect(buildTokenLink('https://app.contoh.co.id', 'invitation', 'abc_DEF-123')).toBe(
      'https://app.contoh.co.id/undangan#token=abc_DEF-123',
    );
    expect(buildTokenLink('https://contoh.co.id/balesin/', 'passwordReset', 'x')).toBe(
      'https://contoh.co.id/balesin/atur-ulang-password#token=x',
    );
    expect(buildTokenLink('http://localhost:5173?a=1#b', 'emailVerification', 'x')).toBe(
      'http://localhost:5173/verifikasi-email#token=x',
    );
    expect(() => buildTokenLink('javascript:alert(1)', 'invitation', 'x')).toThrow();
  });

  it('readTokenFromFragment membaca #token=… saja', () => {
    expect(readTokenFromFragment('#token=abc')).toBe('abc');
    expect(readTokenFromFragment('token=abc&x=1')).toBe('abc');
    expect(readTokenFromFragment('#x=1&token=a%2Db')).toBe('a-b');
    expect(readTokenFromFragment('#token=')).toBeNull();
    expect(readTokenFromFragment('#tokenx=abc')).toBeNull();
    expect(readTokenFromFragment('#token=%E0%A4%A')).toBeNull();
    expect(readTokenFromFragment('')).toBeNull();
  });

  it('skema token menolak karakter di luar base64url dan yang terlalu panjang', () => {
    expect(linkTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(linkTokenSchema.safeParse('ab cd').success).toBe(false);
    expect(linkTokenSchema.safeParse('../../etc').success).toBe(false);
    expect(linkTokenSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(linkTokenSchema.safeParse('').success).toBe(false);
  });

  it('kode TOKEN_INVALID = 410', () => {
    expect(ERROR_STATUS.TOKEN_INVALID).toBe(410);
  });
});

describe('matriks undangan', () => {
  it('Owner: Admin/Supervisor/CS/Teknisi; Admin: tanpa Admin; peran lain tidak bisa; Owner tidak pernah', () => {
    expect(INVITE_PERMISSIONS).toEqual({
      owner: ['admin', 'supervisor', 'cs', 'teknisi'],
      admin: ['supervisor', 'cs', 'teknisi'],
      supervisor: [],
      cs: [],
      teknisi: [],
    });
    for (const actor of USER_ROLES) expect(canInviteRole(actor, 'owner')).toBe(false);
    expect(canInviteRole('admin', 'admin')).toBe(false);
    expect(canInviteRole('owner', 'admin')).toBe(true);
    expect(canInviteRole('cs', 'teknisi')).toBe(false);
  });

  it('penerbit tautan undangan harus aktif dan perannya sekarang masih boleh mengundang peran itu', () => {
    const active = { disabledAt: null };
    expect(invitationIssuerAuthorized('admin', { role: 'owner', ...active })).toBe(true);
    expect(invitationIssuerAuthorized('cs', { role: 'admin', ...active })).toBe(true);
    // Diturunkan: Admin → CS tidak lagi boleh menerbitkan undangan apa pun; Admin tidak boleh Admin.
    expect(invitationIssuerAuthorized('cs', { role: 'cs', ...active })).toBe(false);
    expect(invitationIssuerAuthorized('admin', { role: 'admin', ...active })).toBe(false);
    // Nonaktif: tidak berlaku walau perannya masih cukup.
    expect(invitationIssuerAuthorized('cs', { role: 'owner', disabledAt: new Date() })).toBe(false);
  });

  it('skema: email dibakukan, peran Owner ditolak, nama satu baris, password minimal 10', () => {
    expect(createInvitationRequestSchema.parse({ email: ' A@B.Test ', role: 'cs' })).toEqual({
      email: 'a@b.test',
      role: 'cs',
    });
    expect(
      createInvitationRequestSchema.safeParse({ email: 'a@b.test', role: 'owner' }).success,
    ).toBe(false);
    const base = { token: 'A'.repeat(43), name: 'Budi', password: 'cukup-panjang-sekali' };
    expect(acceptInvitationRequestSchema.safeParse(base).success).toBe(true);
    expect(acceptInvitationRequestSchema.safeParse({ ...base, name: 'Budi\nBcc: x' }).success).toBe(
      false,
    );
    expect(acceptInvitationRequestSchema.safeParse({ ...base, password: 'pendek' }).success).toBe(
      false,
    );
    // Kunci tambahan (mis. `role`) dibuang: peran diambil dari undangan.
    expect(acceptInvitationRequestSchema.parse({ ...base, role: 'owner' })).not.toHaveProperty(
      'role',
    );
  });
});

describe('atur ulang password', () => {
  it('kode 2FA opsional di skema (wajib di server bila akun ber-2FA), dibakukan', () => {
    const base = { token: 'A'.repeat(43), password: 'cukup-panjang-sekali' };
    expect(completePasswordResetRequestSchema.parse(base)).toEqual(base);
    expect(completePasswordResetRequestSchema.parse({ ...base, code: '123 456' }).code).toBe(
      '123456',
    );
    expect(completePasswordResetRequestSchema.safeParse({ ...base, code: 'abc' }).success).toBe(
      false,
    );
    expect(requestPasswordResetRequestSchema.safeParse({ email: 'bukan' }).success).toBe(false);
  });
});

describe('rute & template', () => {
  it('apiPath mengisi parameter dan meng-encode nilainya', () => {
    expect(apiPath(API_ROUTES.invitations.resend, { invitationId: 'a/b' })).toBe(
      '/api/v1/invitations/a%2Fb/resend',
    );
    expect(() => apiPath(API_ROUTES.invitations.resend, {})).toThrow();
  });

  it('tidak ada token di path rute publik', () => {
    for (const path of [
      API_ROUTES.invitations.inspect,
      API_ROUTES.invitations.accept,
      API_ROUTES.passwordReset.inspect,
      API_ROUTES.passwordReset.complete,
      API_ROUTES.emailVerification.verify,
    ]) {
      expect(path).not.toContain(':');
    }
  });

  it('daftar template pratinjau', () => {
    expect(EMAIL_TEMPLATE_IDS).toContain('invitation');
    expect(emailTemplateIdSchema.safeParse('../rahasia').success).toBe(false);
  });
});
