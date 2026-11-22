import type {
  MailAccount,
  MailFolder,
  MailSidebarResponse,
  RedactedMailAccount,
  TestMailAccountResponse,
} from '@balesin/shared';

/** Data tiruan modul Email (bentuk skema `packages/shared/src/mail.ts`). */

export const MAIL_IDS = {
  cs: '7a1b2c3d-0000-4000-8000-000000000001',
  billing: '7a1b2c3d-0000-4000-8000-000000000002',
  personal: '7a1b2c3d-0000-4000-8000-000000000003',
  other: '7a1b2c3d-0000-4000-8000-000000000004',
  csInbox: '7a1b2c3d-0000-4000-8000-0000000000a1',
  csSent: '7a1b2c3d-0000-4000-8000-0000000000a2',
  csVendor: '7a1b2c3d-0000-4000-8000-0000000000a3',
  billingInbox: '7a1b2c3d-0000-4000-8000-0000000000b1',
} as const;

export function fakeMailAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: MAIL_IDS.cs,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS Maju Jaya',
    emailAddress: 'cs@majujaya.co.id',
    fromName: 'Layanan Pelanggan Maju Jaya',
    color: 'tagBlue',
    avatarUrl: null,
    owner: null,
    myLevel: 'manage',
    redacted: false,
    imap: {
      host: 'mail.majujaya.co.id',
      port: 993,
      security: 'ssl',
      username: 'cs@majujaya.co.id',
      password: '••••a1b2',
    },
    smtp: {
      host: 'mail.majujaya.co.id',
      port: 465,
      security: 'ssl',
      sameCredentials: true,
      username: null,
      password: null,
    },
    trustedAuthServIds: null,
    syncWindowDays: 90,
    periodicSyncMinutes: 5,
    sync: {
      state: 'ready',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      nextAttemptAt: null,
      idleActive: true,
      initialProgress: null,
      lastTest: {
        testedAt: '2026-11-23T01:00:00.000Z',
        incomingOk: true,
        outgoingOk: true,
      },
    },
    stats: {
      messageCount: 3482,
      unreadCount: 14,
      quota: { usedBytes: 812 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
    },
    createdAt: '2026-11-20T01:00:00.000Z',
    updatedAt: '2026-11-23T01:00:00.000Z',
    ...overrides,
  };
}

export function fakeRedactedAccount(
  overrides: Partial<RedactedMailAccount> = {},
): RedactedMailAccount {
  return {
    id: MAIL_IDS.other,
    kind: 'personal',
    provider: 'imap',
    displayName: 'Kantor Dimas',
    emailAddress: 'dimas@surel.id',
    color: 'tagPurple',
    avatarUrl: null,
    owner: { id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b04', name: 'Dimas Saputra', active: true },
    redacted: true,
    sync: { state: 'ready', lastSyncedAt: '2026-11-23T01:00:00.000Z', lastErrorCode: null },
    ...overrides,
  };
}

export function fakeMailFolder(overrides: Partial<MailFolder> = {}): MailFolder {
  return {
    id: MAIL_IDS.csInbox,
    accountId: MAIL_IDS.cs,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    parentId: null,
    depth: 0,
    selectable: true,
    unreadCount: 6,
    totalCount: 1200,
    syncEnabled: true,
    hasOlderOnServer: false,
    ...overrides,
  };
}

/** Kolom kiri untuk akun-akun tertentu (Kotak masuk + Terkirim + satu folder sendiri untuk CS). */
export function fakeSidebar(accounts: readonly MailAccount[]): MailSidebarResponse {
  return {
    unified: { unreadCount: 14 },
    unread: { count: 16 },
    starred: { count: 3 },
    accounts: accounts.map((account) => ({
      account: {
        id: account.id,
        displayName: account.displayName,
        emailAddress: account.emailAddress,
        color: account.color,
        avatarUrl: account.avatarUrl,
        myLevel: account.myLevel ?? 'read',
        sync: { state: account.sync.state },
      },
      folders:
        account.id === MAIL_IDS.cs
          ? [
              fakeMailFolder(),
              fakeMailFolder({
                id: MAIL_IDS.csSent,
                path: 'Sent',
                name: 'Terkirim',
                role: 'sent',
                unreadCount: 0,
              }),
              fakeMailFolder({
                id: MAIL_IDS.csVendor,
                path: 'INBOX.Vendor',
                name: 'Vendor',
                role: null,
                unreadCount: 2,
              }),
            ]
          : [
              fakeMailFolder({
                id: `${account.id.slice(0, -2)}f1`,
                accountId: account.id,
                unreadCount: 8,
              }),
            ],
    })),
  };
}

export function fakeTestResult(
  outgoingOk = true,
  overrides: Partial<TestMailAccountResponse> = {},
): TestMailAccountResponse {
  return {
    testedAt: '2026-11-23T01:00:00.000Z',
    incoming: {
      ok: true,
      code: 'ok',
      message: 'Masuk ke IMAP berhasil.',
      durationMs: 1100,
      details: {
        folderCount: 14,
        inboxTotal: 3482,
        specialFolders: ['sent', 'drafts', 'junk', 'trash', 'archive'],
        idle: true,
        quota: null,
        estimatedInitialSync: 640,
      },
    },
    outgoing: outgoingOk
      ? {
          ok: true,
          code: 'ok',
          message: 'Masuk ke SMTP berhasil. Tidak ada email yang dikirim saat tes.',
          durationMs: 900,
        }
      : {
          ok: false,
          code: 'smtp_auth_failed',
          message: 'Username atau password SMTP ditolak server. Periksa lagi keduanya.',
          durationMs: 800,
        },
    ...overrides,
  };
}
