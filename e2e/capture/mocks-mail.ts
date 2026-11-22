import type { Page } from '@playwright/test';
import { MAIL_PROVIDER_CARDS } from '../../packages/shared/src/mail';
import { json } from './mocks';
import { PHOTO_USER_IDS, quietSecurity, teamUsers } from './mocks-tim';

/**
 * Fase 9 tahap 9A bagian 1 — modul Email: akun, kolom folder, wizard, akses. Data tiruan = bentuk
 * skema `packages/shared/src/mail.ts`. Nama & alamat fiktif (domain contoh `majujaya.co.id`).
 */
const API = '**/api/v1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export const MAIL_PHOTO_IDS = {
  cs: '7a1b2c3d-0000-4000-8000-000000000001',
  billing: '7a1b2c3d-0000-4000-8000-000000000002',
  personal: '7a1b2c3d-0000-4000-8000-000000000003',
  notif: '7a1b2c3d-0000-4000-8000-000000000004',
  other: '7a1b2c3d-0000-4000-8000-000000000005',
} as const;

const DEPARTMENTS = [
  {
    id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d01',
    name: 'Customer Service',
    description: null,
    memberCount: 3,
  },
  {
    id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d02',
    name: 'Teknisi',
    description: null,
    memberCount: 1,
  },
  {
    id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d03',
    name: 'Keuangan',
    description: null,
    memberCount: 2,
  },
];

function account(init: {
  id: string;
  displayName: string;
  emailAddress: string;
  color: string;
  kind?: 'shared' | 'personal';
  provider?: 'cpanel' | 'imap';
  state?: string;
  lastSyncedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  initialProgress?: { done: number; total: number } | null;
  myLevel?: string;
  owner?: { id: string; name: string; active: boolean } | null;
  messageCount?: number;
  unreadCount?: number;
}) {
  const host = `mail.${init.emailAddress.split('@')[1] ?? 'majujaya.co.id'}`;
  return {
    id: init.id,
    kind: init.kind ?? 'shared',
    provider: init.provider ?? 'cpanel',
    displayName: init.displayName,
    emailAddress: init.emailAddress,
    fromName: init.displayName,
    color: init.color,
    avatarUrl: null,
    owner: init.owner ?? null,
    myLevel: init.myLevel ?? 'manage',
    redacted: false,
    imap: { host, port: 993, security: 'ssl', username: init.emailAddress, password: '••••k7q2' },
    smtp: {
      host,
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
      state: init.state ?? 'ready',
      lastSyncedAt: init.lastSyncedAt === undefined ? ago(MINUTE) : init.lastSyncedAt,
      lastErrorCode: init.lastErrorCode ?? null,
      lastErrorMessage: init.lastErrorMessage ?? null,
      lastErrorAt: init.lastErrorCode ? ago(2 * HOUR) : null,
      nextAttemptAt: null,
      idleActive: true,
      initialProgress: init.initialProgress ?? null,
      lastTest: { testedAt: ago(26 * HOUR), incomingOk: true, outgoingOk: true },
    },
    stats: {
      messageCount: init.messageCount ?? 3482,
      unreadCount: init.unreadCount ?? 14,
      quota: { usedBytes: 812 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
    },
    createdAt: ago(30 * 24 * HOUR),
    updatedAt: ago(HOUR),
  };
}

const OWNER = { id: PHOTO_USER_IDS.owner, name: 'Rina Kartika', active: true };

export const MAIL_ACCOUNTS = [
  account({
    id: MAIL_PHOTO_IDS.cs,
    displayName: 'CS Maju Jaya',
    emailAddress: 'cs@majujaya.co.id',
    color: 'tagBlue',
  }),
  account({
    id: MAIL_PHOTO_IDS.billing,
    displayName: 'Billing',
    emailAddress: 'billing@majujaya.co.id',
    color: 'tagTeal',
    lastSyncedAt: ago(2 * MINUTE),
    unreadCount: 3,
  }),
  account({
    id: MAIL_PHOTO_IDS.personal,
    displayName: 'Kantor Rina',
    emailAddress: 'rina.kartika@surel.id',
    color: 'tagPurple',
    kind: 'personal',
    provider: 'imap',
    owner: OWNER,
    lastSyncedAt: ago(20_000),
  }),
  account({
    id: MAIL_PHOTO_IDS.notif,
    displayName: 'Notifikasi',
    emailAddress: 'notifikasi@majujaya.co.id',
    color: 'accent',
    state: 'auth_failed',
    lastErrorCode: 'imap_auth_failed',
    lastErrorMessage:
      'Password akun email notifikasi@majujaya.co.id ditolak. Perbarui di Pengaturan → Akun email.',
    lastSyncedAt: ago(3 * HOUR),
    unreadCount: 0,
  }),
];

const REDACTED = {
  id: MAIL_PHOTO_IDS.other,
  kind: 'personal',
  provider: 'imap',
  displayName: 'Kantor Tono',
  emailAddress: 'tono.saputra@surel.id',
  color: 'success',
  avatarUrl: null,
  owner: { id: PHOTO_USER_IDS.teknisi, name: 'Tono Saputra', active: true },
  redacted: true,
  sync: { state: 'ready', lastSyncedAt: ago(5 * MINUTE), lastErrorCode: null },
};

function folder(
  accountId: string,
  suffix: string,
  init: { path: string; name: string; role: string | null; unread?: number; total?: number },
) {
  return {
    id: `${accountId.slice(0, -2)}${suffix}`,
    accountId,
    path: init.path,
    name: init.name,
    role: init.role,
    parentId: null,
    depth: init.role ? 0 : 1,
    selectable: true,
    unreadCount: init.unread ?? 0,
    totalCount: init.total ?? 0,
    syncEnabled: true,
    hasOlderOnServer: false,
  };
}

export const CS_INBOX_FOLDER = `${MAIL_PHOTO_IDS.cs.slice(0, -2)}f1`;

const SIDEBAR = {
  unified: { unreadCount: 17 },
  unread: { count: 19 },
  starred: { count: 4 },
  accounts: MAIL_ACCOUNTS.map((item) => ({
    account: {
      id: item.id,
      displayName: item.displayName,
      emailAddress: item.emailAddress,
      color: item.color,
      avatarUrl: null,
      myLevel: item.myLevel,
      sync: { state: item.sync.state },
    },
    folders:
      item.id === MAIL_PHOTO_IDS.cs
        ? [
            folder(item.id, 'f1', {
              path: 'INBOX',
              name: 'INBOX',
              role: 'inbox',
              unread: 6,
              total: 1240,
            }),
            folder(item.id, 'f2', {
              path: 'INBOX.Drafts',
              name: 'Drafts',
              role: 'drafts',
              unread: 1,
            }),
            folder(item.id, 'f3', { path: 'INBOX.Sent', name: 'Sent', role: 'sent' }),
            folder(item.id, 'f4', { path: 'INBOX.Archive', name: 'Archive', role: 'archive' }),
            folder(item.id, 'f5', { path: 'INBOX.Junk', name: 'Junk', role: 'junk', unread: 1 }),
            folder(item.id, 'f6', { path: 'INBOX.Trash', name: 'Trash', role: 'trash' }),
            folder(item.id, 'f7', { path: 'INBOX.Vendor', name: 'Vendor', role: null }),
            folder(item.id, 'f8', {
              path: 'INBOX.Pelanggan korporat',
              name: 'Pelanggan korporat',
              role: null,
            }),
          ]
        : [
            folder(item.id, 'f1', {
              path: 'INBOX',
              name: 'INBOX',
              role: 'inbox',
              unread: item.stats.unreadCount,
            }),
            folder(item.id, 'f3', { path: 'Sent', name: 'Sent', role: 'sent' }),
            folder(item.id, 'f6', { path: 'Trash', name: 'Trash', role: 'trash' }),
          ],
  })),
};

/**
 * Sesi Owner asli + `navigation.mail` (menu Email tampil). Jawaban `/auth/me` server E2E dipakai
 * apa adanya (token CSRF tetap sah), hanya penanda menu yang dipastikan.
 */
export async function mailSession(page: Page): Promise<void> {
  await page.route(`${API}/auth/me`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, navigation: { mail: true } } });
  });
}

/** Menu Email & Pengaturan → Akun email terisi (empat akun + metadata akun pribadi orang lain). */
export async function mailAccounts(page: Page, empty = false): Promise<void> {
  await quietSecurity(page);
  await mailSession(page);
  const flags = { canConnectPersonal: true, canManageShared: true };
  await page.route(`${API}/mail/providers`, (route) =>
    json(route, { providers: MAIL_PROVIDER_CARDS }),
  );
  await page.route(`${API}/mail/accounts`, (route) =>
    route.request().method() === 'GET'
      ? json(route, { accounts: empty ? [] : MAIL_ACCOUNTS, ...flags })
      : route.fallback(),
  );
  await page.route(`${API}/mail/sidebar`, (route) =>
    json(
      route,
      empty
        ? { unified: { unreadCount: 0 }, unread: { count: 0 }, starred: { count: 0 }, accounts: [] }
        : SIDEBAR,
    ),
  );
  await page.route(`${API}/settings/mail-accounts`, (route) =>
    json(route, { accounts: empty ? [] : [...MAIL_ACCOUNTS, REDACTED], ...flags }),
  );
  await page.route(`${API}/settings/mail`, (route) =>
    json(route, { settings: { cacheRetentionDays: 90, defaultSyncWindowDays: 90 } }),
  );
  await page.route(`${API}/departments`, (route) => json(route, { departments: DEPARTMENTS }));
  await teamUsers(page);
  for (const item of MAIL_ACCOUNTS) {
    await page.route(`${API}/mail/accounts/${item.id}`, (route) => json(route, { account: item }));
  }
}

/** Wizard: deteksi (cPanel dari MX) + hasil tes (Keluar ditolak bila `outgoingOk` false). */
export async function mailWizard(page: Page, outgoingOk = true): Promise<void> {
  await page.route(`${API}/mail/accounts/detect`, (route) =>
    json(route, {
      domain: 'majujaya.co.id',
      suggestions: [
        {
          source: 'mx',
          provider: 'cpanel',
          imap: { host: 'mail.majujaya.co.id', port: 993, security: 'ssl' },
          smtp: { host: 'mail.majujaya.co.id', port: 465, security: 'ssl' },
          username: 'address',
          description:
            'Server email hosting cPanel dikenali dari MX domain ini. Kalau ragu, lihat menu "Connect Devices" di cPanel.',
        },
      ],
    }),
  );
  await page.route(`${API}/mail/accounts/test`, (route) =>
    json(route, {
      testedAt: new Date().toISOString(),
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
          quota: { usedBytes: 812 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
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
            code: 'smtp_connection_timeout',
            message:
              'Server SMTP tidak merespons. Banyak jaringan memblokir port 465/587 keluar; tanyakan ke penyedia server.',
            durationMs: 8000,
          },
    }),
  );
}

/** Akses akun CS (departemen + orang). */
export async function mailAccess(page: Page): Promise<void> {
  await page.route(`${API}/mail/accounts/${MAIL_PHOTO_IDS.cs}/access`, (route) =>
    json(route, {
      implicit: [
        { role: 'owner', level: 'manage' },
        { role: 'admin', level: 'manage' },
      ],
      grants: [
        {
          principal: {
            type: 'department',
            id: DEPARTMENTS[0]?.id,
            name: 'Customer Service',
            memberCount: 3,
          },
          level: 'send',
          grantedBy: { id: OWNER.id, name: OWNER.name },
          grantedAt: ago(10 * 24 * HOUR),
        },
        {
          principal: {
            type: 'user',
            id: PHOTO_USER_IDS.supervisor,
            name: 'Sari Wulandari',
            role: 'supervisor',
            active: true,
          },
          level: 'manage',
          grantedBy: { id: OWNER.id, name: OWNER.name },
          grantedAt: ago(10 * 24 * HOUR),
        },
        {
          principal: {
            type: 'department',
            id: DEPARTMENTS[1]?.id,
            name: 'Teknisi',
            memberCount: 1,
          },
          level: 'read',
          grantedBy: { id: OWNER.id, name: OWNER.name },
          grantedAt: ago(3 * 24 * HOUR),
        },
      ],
      editable: true,
    }),
  );
}

/** Tab Akses email di detail anggota CS. */
export async function teamMailAccess(page: Page, userId: string): Promise<void> {
  await page.route(`${API}/settings/team/${userId}/mail-access`, (route) =>
    json(route, {
      user: { id: userId, name: 'Citra Maharani', role: 'cs', active: true },
      menuVisible: true,
      canConnectPersonal: true,
      accounts: [
        {
          account: {
            id: MAIL_PHOTO_IDS.cs,
            displayName: 'CS Maju Jaya',
            emailAddress: 'cs@majujaya.co.id',
            color: 'tagBlue',
          },
          effectiveLevel: 'send',
          directLevel: null,
          sources: [
            {
              type: 'department',
              level: 'send',
              department: { id: DEPARTMENTS[0]?.id, name: 'Customer Service' },
            },
          ],
        },
        {
          account: {
            id: MAIL_PHOTO_IDS.billing,
            displayName: 'Billing',
            emailAddress: 'billing@majujaya.co.id',
            color: 'tagTeal',
          },
          effectiveLevel: 'read',
          directLevel: 'read',
          sources: [{ type: 'user', level: 'read', department: null }],
        },
        {
          account: {
            id: MAIL_PHOTO_IDS.notif,
            displayName: 'Notifikasi',
            emailAddress: 'notifikasi@majujaya.co.id',
            color: 'accent',
          },
          effectiveLevel: null,
          directLevel: null,
          sources: [],
        },
      ],
      personalAccounts: [
        { id: MAIL_PHOTO_IDS.other, emailAddress: 'citra.maharani@surel.id', syncState: 'ready' },
      ],
    }),
  );
}
