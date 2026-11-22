import { describe, expect, it } from 'vitest';

import {
  canMailAdminister,
  canMailSend,
  createMailAccountRequestSchema,
  mailFolderDisplayName,
  mailFolderRoleOf,
  mailMenuVisible,
  mailPortAllowed,
  mailStreamEventSchema,
  resolveMailAccess,
  updateMailAccountAccessRequestSchema,
  type MailAccessGrantInput,
  type MailAccessLevel,
  type MailAccessUser,
} from './mail';
import { USER_ROLES, type UserRole } from './roles';

const OWNER_ID = '00000000-0000-4000-8000-00000000000a';
const ME = '00000000-0000-4000-8000-000000000001';
const DEPT = '00000000-0000-4000-8000-0000000000d1';
const OTHER_DEPT = '00000000-0000-4000-8000-0000000000d2';

const user = (role: UserRole, overrides: Partial<MailAccessUser> = {}): MailAccessUser => ({
  id: ME,
  role,
  active: true,
  departmentIds: [DEPT],
  ...overrides,
});

const shared = { kind: 'shared' as const, ownerUserId: null };
const personalOfOther = { kind: 'personal' as const, ownerUserId: OWNER_ID };
const personalOfMe = { kind: 'personal' as const, ownerUserId: ME };

const userGrant = (level: MailAccessLevel, userId = ME): MailAccessGrantInput => ({
  principalType: 'user',
  userId,
  departmentId: null,
  level,
});
const deptGrant = (level: MailAccessLevel, departmentId = DEPT): MailAccessGrantInput => ({
  principalType: 'department',
  userId: null,
  departmentId,
  level,
});

describe('resolveMailAccess (kontrak §2, tabel)', () => {
  it.each(USER_ROLES)('akun pribadi orang lain = null untuk %s (termasuk Owner/Admin)', (role) => {
    expect(resolveMailAccess(user(role), personalOfOther, [userGrant('manage')])).toBeNull();
  });

  it.each(USER_ROLES)('akun pribadi milik sendiri = manage untuk %s', (role) => {
    expect(resolveMailAccess(user(role), personalOfMe, [])).toBe('manage');
  });

  it('Owner/Admin otomatis manage di akun bersama tanpa grant', () => {
    expect(resolveMailAccess(user('owner'), shared, [])).toBe('manage');
    expect(resolveMailAccess(user('admin'), shared, [])).toBe('manage');
  });

  it('Supervisor/CS/Teknisi tanpa grant = null', () => {
    for (const role of ['supervisor', 'cs', 'teknisi'] as const) {
      expect(resolveMailAccess(user(role), shared, []), role).toBeNull();
    }
  });

  it('maks(grant langsung, grant departemen)', () => {
    expect(resolveMailAccess(user('cs'), shared, [userGrant('read'), deptGrant('send')])).toBe(
      'send',
    );
    expect(resolveMailAccess(user('cs'), shared, [userGrant('manage'), deptGrant('read')])).toBe(
      'manage',
    );
    expect(resolveMailAccess(user('teknisi'), shared, [deptGrant('read')])).toBe('read');
  });

  it('grant departemen lain / pengguna lain tidak berlaku', () => {
    expect(
      resolveMailAccess(user('cs'), shared, [
        deptGrant('manage', OTHER_DEPT),
        userGrant('send', OWNER_ID),
      ]),
    ).toBeNull();
  });

  it('keluar departemen = hak hilang seketika', () => {
    expect(
      resolveMailAccess(user('cs', { departmentIds: [] }), shared, [deptGrant('send')]),
    ).toBeNull();
  });

  it('pengguna nonaktif = null di semua akun, termasuk miliknya', () => {
    expect(resolveMailAccess(user('owner', { active: false }), shared, [])).toBeNull();
    expect(resolveMailAccess(user('cs', { active: false }), personalOfMe, [])).toBeNull();
  });

  it('kirim/pindah butuh level ≥ send DAN izin mail.send', () => {
    expect(canMailSend('cs', 'read')).toBe(false);
    expect(canMailSend('cs', 'send')).toBe(true);
    expect(canMailSend('teknisi', 'manage')).toBe(true);
    expect(canMailSend('cs', null)).toBe(false);
  });

  it('ubah server/akses/putuskan: bersama = mail.accounts.manage, pribadi = pemiliknya saja', () => {
    expect(canMailAdminister(user('admin'), shared)).toBe(true);
    expect(canMailAdminister(user('supervisor'), shared)).toBe(false);
    // "Kelola" lewat grant TIDAK memberi hak administrasi.
    expect(canMailAdminister(user('cs'), shared)).toBe(false);
    expect(canMailAdminister(user('owner'), personalOfOther)).toBe(false);
    expect(canMailAdminister(user('teknisi'), personalOfMe)).toBe(true);
  });
});

describe('menu Email (kontrak §1)', () => {
  it('Teknisi tanpa akses tidak melihat menu; dengan satu akun terlihat', () => {
    expect(mailMenuVisible('teknisi', 0)).toBe(false);
    expect(mailMenuVisible('teknisi', 1)).toBe(true);
    expect(mailMenuVisible('cs', 0)).toBe(true);
  });
});

describe('peran folder RFC 6154', () => {
  const role = (path: string, flags: string[] = [], delimiter: string | null = '.') =>
    mailFolderRoleOf({ path, delimiter, flags }).role;

  it('SPECIAL-USE didahulukan, INBOX selalu inbox', () => {
    expect(role('INBOX')).toBe('inbox');
    expect(role('Barang Keluar', ['\\Sent'])).toBe('sent');
    expect(role('[Gmail]/Semua', ['\\All'], '/')).toBe('all');
  });

  it('tebakan nama tanpa beda huruf, dengan/tanpa awalan INBOX.', () => {
    expect(role('INBOX.Sent')).toBe('sent');
    expect(role('Sent Items', [], '/')).toBe('sent');
    expect(role('INBOX.spam')).toBe('junk');
    expect(role('Deleted Items', [], '/')).toBe('trash');
    expect(role('INBOX.Arsip')).toBe('archive');
    expect(role('Draf', [], '/')).toBe('drafts');
    expect(role('INBOX.Proyek')).toBeNull();
    // Folder bersarang tidak ditebak.
    expect(role('INBOX.Proyek.Sent')).toBeNull();
  });

  it('nama tampilan Indonesia, awalan namespace dibuang', () => {
    expect(mailFolderDisplayName('INBOX.Sent', '.', 'sent')).toBe('Terkirim');
    expect(mailFolderDisplayName('INBOX.Proyek', '.', null)).toBe('Proyek');
    expect(mailFolderDisplayName('Klien/2026', '/', null)).toBe('2026');
  });
});

describe('port & TLS wajib', () => {
  it('hanya pasangan baku', () => {
    expect(mailPortAllowed('imap', 993, 'ssl')).toBe(true);
    expect(mailPortAllowed('imap', 143, 'starttls')).toBe(true);
    expect(mailPortAllowed('imap', 993, 'starttls')).toBe(false);
    expect(mailPortAllowed('imap', 143, 'ssl')).toBe(false);
    expect(mailPortAllowed('smtp', 465, 'ssl')).toBe(true);
    expect(mailPortAllowed('smtp', 587, 'starttls')).toBe(true);
    expect(mailPortAllowed('smtp', 25, 'starttls')).toBe(false);
    expect(mailPortAllowed('smtp', 2525, 'ssl')).toBe(false);
  });
});

describe('skema permintaan', () => {
  const base = {
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: 'CS@Perusahaan.Example',
    fromName: 'Tim CS',
    imap: {
      host: 'mail.perusahaan.example',
      port: 993,
      security: 'ssl',
      username: 'cs',
      password: 'x',
    },
    smtp: { host: 'mail.perusahaan.example', port: 465, security: 'ssl' },
  };

  it('alamat dinormalisasi huruf kecil; penyedia 9E ditolak; keamanan "none" ditolak', () => {
    expect(createMailAccountRequestSchema.parse(base).emailAddress).toBe('cs@perusahaan.example');
    expect(createMailAccountRequestSchema.safeParse({ ...base, provider: 'google' }).success).toBe(
      false,
    );
    expect(
      createMailAccountRequestSchema.safeParse({
        ...base,
        smtp: { ...base.smtp, security: 'none' },
      }).success,
    ).toBe(false);
  });

  it('isian tak dikenal ditolak (strict); host berbentuk URL ditolak', () => {
    expect(createMailAccountRequestSchema.safeParse({ ...base, ownerUserId: ME }).success).toBe(
      false,
    );
    expect(
      createMailAccountRequestSchema.safeParse({
        ...base,
        imap: { ...base.imap, host: 'https://mail.perusahaan.example/' },
      }).success,
    ).toBe(false);
  });

  it('penerima akses ganda ditolak', () => {
    const grant = { principalType: 'user', userId: ME, level: 'read' };
    expect(updateMailAccountAccessRequestSchema.safeParse({ grants: [grant, grant] }).success).toBe(
      false,
    );
  });

  it('event WS hanya ID & angka (subjek tidak lolos skema)', () => {
    const parsed = mailStreamEventSchema.parse({
      type: 'mail.message.created',
      accountId: ME,
      folderId: DEPT,
      messageId: OWNER_ID,
      receivedAt: '2026-11-23T00:00:00.000Z',
      subject: 'rahasia',
    });
    expect(parsed).not.toHaveProperty('subject');
  });
});
