import type { Page } from '@playwright/test';
import { MAIL_PROVIDER_CARDS, MAIL_TEST_MESSAGES } from '../../packages/shared/src/mail';
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
    sentCopyMode: 'auto',
    warnExternalRecipients: false,
    warnings: [] as string[],
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
    // Kotak masuk 2 (lihat SIDEBAR & MAIL_MESSAGES).
    unreadCount: 2,
  }),
  account({
    id: MAIL_PHOTO_IDS.billing,
    displayName: 'Billing',
    emailAddress: 'billing@majujaya.co.id',
    color: 'tagTeal',
    lastSyncedAt: ago(2 * MINUTE),
    unreadCount: 2,
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
    unreadCount: 1,
  }),
  account({
    id: MAIL_PHOTO_IDS.notif,
    displayName: 'Notifikasi',
    emailAddress: 'notifikasi@majujaya.co.id',
    color: 'accent',
    state: 'auth_failed',
    lastErrorCode: 'imap_auth_failed',
    // Pesan asli backend (kode tetap), bukan teks buatan yang menunjuk ke halaman itu sendiri.
    lastErrorMessage: MAIL_TEST_MESSAGES.imap_auth_failed,
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

/**
 * ID folder unik per akun (heksadesimal): 4 digit terakhir ID akun diganti nomor akun + `0` +
 * akhiran folder, mis. CS `…00000000` + `1` + `0` + `f1`.
 */
function folderIdOf(accountId: string, suffix: string): string {
  return `${accountId.slice(0, -4)}${accountId.slice(-1)}0${suffix}`;
}

function folder(
  accountId: string,
  suffix: string,
  init: { path: string; name: string; role: string | null; unread?: number; total?: number },
) {
  return {
    id: folderIdOf(accountId, suffix),
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

export const CS_INBOX_FOLDER = folderIdOf(MAIL_PHOTO_IDS.cs, 'f1');

/**
 * Angka saling cocok dengan daftar email foto (review 9A M5): Semua kotak masuk = belum dibaca di
 * Kotak masuk tiap akun (CS 2 + Billing 2 + Kantor Rina 1 + Notifikasi 0 = 5) = Belum dibaca;
 * Berbintang 1. Jumlah email per Kotak masuk = baris di `MAIL_MESSAGES`.
 */
const SIDEBAR = {
  unified: { unreadCount: 5 },
  unread: { count: 5 },
  starred: { count: 1 },
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
              unread: 2,
              total: 4,
            }),
            folder(item.id, 'f2', {
              path: 'INBOX.Drafts',
              name: 'Drafts',
              role: 'drafts',
            }),
            folder(item.id, 'f3', { path: 'INBOX.Sent', name: 'Sent', role: 'sent' }),
            folder(item.id, 'f4', { path: 'INBOX.Archive', name: 'Archive', role: 'archive' }),
            folder(item.id, 'f5', { path: 'INBOX.Junk', name: 'Junk', role: 'junk' }),
            folder(item.id, 'f6', { path: 'INBOX.Trash', name: 'Trash', role: 'trash' }),
            folder(item.id, 'f7', {
              path: 'INBOX.Vendor',
              name: 'Vendor',
              role: null,
            }),
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
              total:
                item.id === MAIL_PHOTO_IDS.billing
                  ? 3
                  : item.id === MAIL_PHOTO_IDS.personal
                    ? 1
                    : 0,
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
    // Id pengguna sesi = id pemilik tiruan (Rina), supaya akun pribadinya tampil "Pribadi · milikmu"
    // (review 9A M4). Hanya dipakai pembanding di browser; API tetap memakai cookie sesi asli.
    const user = { ...(body.user as Record<string, unknown>), id: OWNER.id, name: OWNER.name };
    await route.fulfill({ response, json: { ...body, user, navigation: { mail: true } } });
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
    json(route, {
      settings: {
        cacheRetentionDays: 90,
        defaultSyncWindowDays: 90,
        maxRecipientsPerEmail: 50,
        maxAttachmentTotalMb: 20,
      },
    }),
  );
  await page.route(`${API}/departments`, (route) => json(route, { departments: DEPARTMENTS }));
  await teamUsers(page);
  for (const item of MAIL_ACCOUNTS) {
    await page.route(`${API}/mail/accounts/${item.id}`, (route) => json(route, { account: item }));
  }
  await mailMessages(page, { empty });
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
            message: MAIL_TEST_MESSAGES.smtp_connection_timeout,
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

// ── Bagian 2: daftar, baca, aksi (kontrak §7–§9) ───────────────────────────

const DAY = 24 * HOUR;

/** ID email foto (heksadesimal, lolos `?m=` di web). */
export const MAIL_MESSAGE_IDS = {
  noc: '7a1b2c3d-0000-4000-8000-0000000000e1',
  upgrade: '7a1b2c3d-0000-4000-8000-0000000000e2',
  settlement: '7a1b2c3d-0000-4000-8000-0000000000e3',
  kabel: '7a1b2c3d-0000-4000-8000-0000000000e4',
  odp: '7a1b2c3d-0000-4000-8000-0000000000e5',
  tunggakan: '7a1b2c3d-0000-4000-8000-0000000000e6',
  rapat: '7a1b2c3d-0000-4000-8000-0000000000e7',
  faktur: '7a1b2c3d-0000-4000-8000-0000000000e8',
  vendor: '7a1b2c3d-0000-4000-8000-0000000000e9',
} as const;

const ACCOUNT_REFS = {
  cs: { id: MAIL_PHOTO_IDS.cs, displayName: 'CS Maju Jaya', color: 'tagBlue' },
  billing: { id: MAIL_PHOTO_IDS.billing, displayName: 'Billing', color: 'tagTeal' },
  personal: { id: MAIL_PHOTO_IDS.personal, displayName: 'Kantor Rina', color: 'tagPurple' },
} as const;

type AccountKey = keyof typeof ACCOUNT_REFS;

function summary(init: {
  id: string;
  account: AccountKey;
  from: { address: string; name: string | null };
  subject: string;
  snippet: string;
  at: number;
  read?: boolean;
  starred?: boolean;
  attachments?: boolean;
  deliveredTo?: string;
  verification?: 'pass' | 'fail' | 'unverified';
  folderId?: string;
  folderRole?: string | null;
}) {
  const account = ACCOUNT_REFS[init.account];
  const own = MAIL_ACCOUNTS.find((item) => item.id === account.id)?.emailAddress ?? '';
  const deliveredTo = init.deliveredTo ?? own;
  return {
    id: init.id,
    accountId: account.id,
    folderId: init.folderId ?? folderIdOf(account.id, 'f1'),
    folderRole: init.folderRole === undefined ? 'inbox' : init.folderRole,
    account,
    from: init.from,
    to: [{ address: deliveredTo, name: null }],
    toCount: 1,
    ccCount: 0,
    subject: init.subject,
    snippet: init.snippet,
    receivedAt: ago(init.at),
    sentAt: ago(init.at + MINUTE),
    isRead: init.read ?? false,
    isStarred: init.starred ?? false,
    isAnswered: false,
    hasAttachments: init.attachments ?? false,
    sizeBytes: 48_211,
    deliveredTo,
    deliveredToAlias: deliveredTo !== own,
    senderVerification: init.verification ?? 'pass',
    warnings: [],
    pending: false,
  };
}

/** Jam foto: "hari ini" dihitung dari tengah hari supaya kelompok hari stabil kapan pun difoto. */
function todayAt(hours: number, minutes = 0): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  // Belum lewat jam itu (foto pagi hari): mundur ke beberapa menit lalu supaya tetap "Hari ini".
  return Math.max(MINUTE * 3, now.getTime() - target.getTime());
}

export const MAIL_MESSAGES = [
  summary({
    id: MAIL_MESSAGE_IDS.noc,
    account: 'cs',
    from: { address: 'noc@nusaraya-backbone.id', name: 'NOC Nusaraya Backbone' },
    subject: 'Jadwal pemeliharaan backbone 26 Nov, 01.00–04.00 WIB',
    snippet: 'Yth. Tim NOC Maju Jaya, sehubungan dengan peningkatan kapasitas jalur backbone…',
    at: todayAt(10, 24),
    attachments: true,
  }),
  summary({
    id: MAIL_MESSAGE_IDS.upgrade,
    account: 'cs',
    from: { address: 'rina.wulandari@contoh.id', name: 'Rina Wulandari' },
    subject: 'Permintaan upgrade paket 50 Mbps untuk kantor cabang',
    snippet: 'Selamat pagi, kami berencana membuka kantor cabang baru di Sukadana dan…',
    at: todayAt(9, 12),
    starred: true,
  }),
  summary({
    id: MAIL_MESSAGE_IDS.settlement,
    account: 'billing',
    from: { address: 'laporan@payment-gateway.example', name: 'Sistem Billing' },
    subject: 'Settlement harian 21 Nov: Rp 4.215.000 (63 transaksi)',
    snippet: 'Ringkasan pembayaran pelanggan yang masuk lewat virtual account dan QRIS.',
    at: todayAt(8, 3),
    attachments: true,
    deliveredTo: 'tagihan@majujaya.co.id',
  }),
  summary({
    id: MAIL_MESSAGE_IDS.kabel,
    account: 'personal',
    from: { address: 'andi@kabelnusantara.example', name: 'Andi Pratama' },
    subject: 'Penawaran harga kabel FO 24 core & closure',
    snippet: 'Bu Rina, terlampir penawaran untuk kebutuhan bulan Desember.',
    at: todayAt(7, 45),
    attachments: true,
  }),
  summary({
    id: MAIL_MESSAGE_IDS.odp,
    account: 'cs',
    from: { address: 'dimas@majujaya.co.id', name: 'Dimas Saputra' },
    subject: 'Laporan instalasi ODP Desa Sukadana',
    snippet: 'Instalasi 2 ODP selesai, redaman rata-rata −19,4 dBm. Foto terlampir.',
    at: DAY + 2 * HOUR,
    read: true,
    attachments: true,
  }),
  summary({
    id: MAIL_MESSAGE_IDS.tunggakan,
    account: 'billing',
    from: { address: 'sari.anggraini@majujaya.co.id', name: 'Sari Anggraini' },
    subject: 'Rekap tunggakan November (per desa)',
    snippet: 'Rekap terbaru sudah saya pisahkan per desa supaya mudah ditagih.',
    at: DAY + 5 * HOUR,
    attachments: true,
  }),
  summary({
    id: MAIL_MESSAGE_IDS.rapat,
    account: 'cs',
    from: { address: 'sekretariat@forum-isp.example', name: 'Forum ISP Daerah' },
    subject: 'Undangan rapat koordinasi akhir tahun',
    snippet: 'Dengan hormat, kami mengundang Bapak/Ibu dalam rapat koordinasi anggota.',
    at: 3 * DAY,
    read: true,
    verification: 'unverified',
  }),
  summary({
    id: MAIL_MESSAGE_IDS.faktur,
    account: 'billing',
    from: { address: 'tagihan@hosting.example', name: 'Hosting Nusantara' },
    subject: 'Faktur perpanjangan domain majujaya.co.id',
    snippet: 'Domain kamu akan berakhir 14 hari lagi. Faktur terlampir dalam PDF.',
    at: 4 * DAY,
    read: true,
    attachments: true,
  }),
];

/** Isi email NOC: tabel + dua gambar luar (diblokir bawaan) + PDF & spreadsheet. */
const NOC_DETAIL = {
  ...MAIL_MESSAGES[0],
  cc: [{ address: 'rina.kartika@majujaya.co.id', name: 'Rina Kartika' }],
  bcc: null,
  replyTo: [],
  messageIdHeader: '<jadwal-26nov@nusaraya-backbone.id>',
  myLevel: 'manage',
  receivedVia: {
    accountId: MAIL_PHOTO_IDS.cs,
    displayName: 'CS Maju Jaya',
    address: 'cs@majujaya.co.id',
  },
  verification: {
    result: 'pass',
    label: 'Terverifikasi',
    spf: 'pass',
    dkim: 'pass',
    dmarc: 'pass',
    authServId: 'mail.majujaya.co.id',
  },
  warningDetails: [],
  body: {
    state: 'ready',
    hasHtml: true,
    text: 'Yth. Tim NOC Maju Jaya, …',
    remoteImages: { count: 2, senderAllowed: false, autoBlocked: false },
  },
  attachments: [
    {
      id: '7a1b2c3d-0000-4000-8000-0000000000c1',
      filename: 'Jadwal-Pemeliharaan-26Nov.pdf',
      contentType: 'application/pdf',
      sizeBytes: 253_952,
      isInline: false,
      risk: 'ok',
      riskMessage: null,
      previewable: false,
      cached: true,
    },
    {
      id: '7a1b2c3d-0000-4000-8000-0000000000c2',
      filename: 'Link-Terdampak.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 36_864,
      isInline: false,
      risk: 'ok',
      riskMessage: null,
      previewable: false,
      cached: false,
    },
  ],
};

/** Email teks polos yang gagal verifikasi + pengirim mirip domain kita (layar peringatan). */
const FAKTUR_DETAIL = {
  ...MAIL_MESSAGES[7],
  from: { address: 'tagihan@majujaya-co.id.example', name: 'Hosting Nusantara' },
  senderVerification: 'fail',
  cc: [],
  bcc: null,
  replyTo: [],
  messageIdHeader: null,
  myLevel: 'send',
  receivedVia: {
    accountId: MAIL_PHOTO_IDS.billing,
    displayName: 'Billing',
    address: 'billing@majujaya.co.id',
  },
  verification: {
    result: 'fail',
    label:
      'Email ini gagal pemeriksaan keaslian pengirim. Hati-hati dengan tautan dan lampirannya.',
    spf: 'fail',
    dkim: null,
    dmarc: 'fail',
    authServId: 'mail.majujaya.co.id',
  },
  warningDetails: [
    { type: 'lookalike_sender', message: 'Alamat pengirim mirip domain kita.' },
    {
      type: 'dangerous_attachment',
      message: 'Ada lampiran berisiko yang diblokir (program, makro, atau halaman web).',
    },
  ],
  body: {
    state: 'ready',
    hasHtml: false,
    text: 'Yth. pelanggan,\n\nDomain majujaya.co.id akan berakhir dalam 14 hari. Segera lakukan pembayaran agar layanan email dan situs tidak terhenti.\n\nFaktur terlampir. Pembayaran dapat dilakukan melalui tautan di dalam faktur.\n\nSalam,\nTim Penagihan',
    remoteImages: { count: 0, senderAllowed: false, autoBlocked: true },
  },
  attachments: [
    {
      id: '7a1b2c3d-0000-4000-8000-0000000000c3',
      filename: 'Faktur-Domain.pdf',
      contentType: 'application/pdf',
      sizeBytes: 98_304,
      isInline: false,
      risk: 'ok',
      riskMessage: null,
      previewable: false,
      cached: true,
    },
    {
      id: '7a1b2c3d-0000-4000-8000-0000000000c4',
      filename: 'Faktur-Domain.pdf.exe',
      contentType: 'application/octet-stream',
      sizeBytes: 412_672,
      isInline: false,
      risk: 'blocked',
      riskMessage:
        'Lampiran ini diblokir karena berisiko (program, makro, atau halaman web). Minta pengirim mengirim dalam bentuk PDF.',
      previewable: false,
      cached: false,
    },
  ],
};

/**
 * Dokumen tampilan tiruan (bentuk `renderMailViewDocument`: latar putih, padding 16, huruf sistem).
 * Gambar luar yang diblokir = gambar kosong + teks alt, persis seperti server.
 */
const NOC_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;background:#fff;color:#1f2328}
body{padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>
<p><img alt="Logo Nusaraya" width="120" height="32" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="border:1px dashed #d0d7de"></p>
<p>Yth. Tim NOC Maju Jaya,</p>
<p>Sehubungan dengan peningkatan kapasitas jalur backbone Bandar Lampung – Metro, kami akan melakukan pemeliharaan terjadwal dengan rincian berikut:</p>
<table style="border-collapse:collapse;margin:4px 0 16px;font-size:13px">
<tr><td style="padding:7px 12px;border:1px solid #d0d7de;color:#57606a;background:#f6f8fa;width:140px">Tanggal</td><td style="padding:7px 12px;border:1px solid #d0d7de">Rabu, 26 November 2026</td></tr>
<tr><td style="padding:7px 12px;border:1px solid #d0d7de;color:#57606a;background:#f6f8fa">Waktu</td><td style="padding:7px 12px;border:1px solid #d0d7de">01.00–04.00 WIB</td></tr>
<tr><td style="padding:7px 12px;border:1px solid #d0d7de;color:#57606a;background:#f6f8fa">Dampak</td><td style="padding:7px 12px;border:1px solid #d0d7de">Putus maksimal 2 × 15 menit</td></tr>
<tr><td style="padding:7px 12px;border:1px solid #d0d7de;color:#57606a;background:#f6f8fa">Link terdampak</td><td style="padding:7px 12px;border:1px solid #d0d7de">SKT-LT-01, SKT-LT-02 (rincian di lampiran)</td></tr>
</table>
<p>Mohon informasikan pelanggan korporat yang terdampak. Bila ada pertanyaan, balas email ini atau hubungi NOC kami 24 jam.</p>
<p style="color:#57606a">Salam,<br>NOC Nusaraya Backbone</p>
</body></html>`;

/** Folder "Vendor" CS (kosong) untuk foto keadaan kosong folder. */
export const CS_VENDOR_FOLDER = folderIdOf(MAIL_PHOTO_IDS.cs, 'f7');

/**
 * Daftar email (`GET /mail/messages`), detail, dokumen tampilan, dan aksi. `empty` = semua tampilan
 * kosong; `bodyLoading` = isi email NOC belum diambil server.
 */
export async function mailMessages(
  page: Page,
  options: { empty?: boolean; bodyLoading?: boolean; zeroCounts?: boolean } = {},
): Promise<void> {
  if (options.zeroCounts) {
    // Akun ada tetapi semua email sudah dibaca/kosong: hitungan kolom kiri ikut nol.
    await page.route(`${API}/mail/sidebar`, (route) =>
      json(route, {
        unified: { unreadCount: 0 },
        unread: { count: 0 },
        starred: { count: 0 },
        accounts: SIDEBAR.accounts.map((entry) => ({
          ...entry,
          folders: entry.folders.map((item) => ({ ...item, unreadCount: 0, totalCount: 0 })),
        })),
      }),
    );
  }
  await page.route(/\/api\/v1\/mail\/messages(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const view = url.searchParams.get('view');
    const folderId = url.searchParams.get('folderId');
    let messages = options.empty ? [] : MAIL_MESSAGES;
    if (view === 'unread') messages = messages.filter((item) => !item.isRead);
    if (view === 'starred') messages = messages.filter((item) => item.isStarred);
    if (view === 'folder') messages = messages.filter((item) => item.folderId === folderId);
    return json(route, { messages, nextCursor: null, olderOnServer: false });
  });
  await page.route('**/api/v1/mail/messages/actions', (route) => {
    const body = route.request().postDataJSON() as { messageIds: string[] };
    return json(route, {
      results: body.messageIds.map((id) => ({ id, ok: true })),
      applied: body.messageIds.length,
    });
  });
  const details: Record<string, unknown> = {
    [MAIL_MESSAGE_IDS.noc]: options.bodyLoading
      ? {
          ...NOC_DETAIL,
          body: { ...NOC_DETAIL.body, state: 'loading', text: null },
          attachments: [],
        }
      : NOC_DETAIL,
    [MAIL_MESSAGE_IDS.faktur]: FAKTUR_DETAIL,
  };
  for (const [id, message] of Object.entries(details)) {
    await page.route(`**/api/v1/mail/messages/${id}`, (route) => json(route, { message }));
    await page.route(`**/api/v1/mail/messages/${id}/view`, (route) => {
      const images = (route.request().postDataJSON() as { images?: string }).images ?? 'auto';
      return json(route, {
        url: `/api/v1/mail/view/foto-${id.slice(-2)}-${images}`,
        expiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
        remoteImages: { count: 2, shown: images === 'show' },
      });
    });
  }
  await page.route('**/api/v1/mail/view/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: {
        'content-security-policy':
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox allow-popups allow-popups-to-escape-sandbox",
      },
      body: NOC_DOCUMENT,
    }),
  );
}

// ── 9B: tulis, balas, teruskan, identitas, tanda tangan ────────────────────

export const COMPOSE_PHOTO_IDS = {
  identityCs: '7a1b2c3d-0000-4000-8000-0000000000d1',
  identityTagihan: '7a1b2c3d-0000-4000-8000-0000000000d2',
  identityBilling: '7a1b2c3d-0000-4000-8000-0000000000d3',
  identityPersonal: '7a1b2c3d-0000-4000-8000-0000000000d4',
  draftNew: '7a1b2c3d-0000-4000-8000-0000000000f1',
  draftReply: '7a1b2c3d-0000-4000-8000-0000000000f2',
  outbox: '7a1b2c3d-0000-4000-8000-0000000000f9',
  signatureFormal: '7a1b2c3d-0000-4000-8000-0000000000fb',
  signatureShort: '7a1b2c3d-0000-4000-8000-0000000000fc',
} as const;

const ACCOUNT_REF_FULL = {
  cs: { ...ACCOUNT_REFS.cs, kind: 'shared', avatarUrl: null },
  billing: { ...ACCOUNT_REFS.billing, kind: 'shared', avatarUrl: null },
  personal: { ...ACCOUNT_REFS.personal, kind: 'personal', avatarUrl: null },
};

function identity(init: {
  id: string;
  accountId: string;
  address: string;
  displayName: string;
  isPrimary?: boolean;
  state?: 'verified' | 'pending' | 'unverified';
  replyTo?: string | null;
}) {
  const state = init.state ?? 'verified';
  const verified = state === 'verified';
  return {
    id: init.id,
    accountId: init.accountId,
    address: init.address,
    displayName: init.displayName,
    isPrimary: init.isPrimary ?? true,
    replyTo: init.replyTo ?? null,
    verification: {
      state,
      verifiedAt: verified ? ago(20 * 24 * HOUR) : null,
      method: verified ? 'mailbox' : null,
      pending:
        state === 'pending'
          ? {
              sentAt: ago(2 * MINUTE),
              expiresAt: new Date(Date.now() + 28 * MINUTE).toISOString(),
              attemptsLeft: 5,
              autoCheckUntil: null,
            }
          : null,
      available: true,
      unavailableReason: null,
    },
    approval: { state: 'not_required', decidedAt: null },
    defaultSignatures: {
      new: init.id === COMPOSE_PHOTO_IDS.identityCs ? COMPOSE_PHOTO_IDS.signatureFormal : null,
      reply: init.id === COMPOSE_PHOTO_IDS.identityCs ? COMPOSE_PHOTO_IDS.signatureShort : null,
    },
    canSend: verified,
    cannotSendReason: verified ? null : 'identity_unverified',
    createdAt: ago(30 * 24 * HOUR),
  };
}

const CS_IDENTITIES = [
  identity({
    id: COMPOSE_PHOTO_IDS.identityCs,
    accountId: MAIL_PHOTO_IDS.cs,
    address: 'cs@majujaya.co.id',
    displayName: 'CS Maju Jaya',
  }),
  identity({
    id: COMPOSE_PHOTO_IDS.identityTagihan,
    accountId: MAIL_PHOTO_IDS.cs,
    address: 'tagihan@majujaya.co.id',
    displayName: 'Tim Tagihan',
    isPrimary: false,
    state: 'pending',
    replyTo: 'billing@majujaya.co.id',
  }),
];

const COMPOSE_IDENTITIES = [
  ...CS_IDENTITIES.map((item) => ({ ...item, account: ACCOUNT_REF_FULL.cs })),
  {
    ...identity({
      id: COMPOSE_PHOTO_IDS.identityBilling,
      accountId: MAIL_PHOTO_IDS.billing,
      address: 'billing@majujaya.co.id',
      displayName: 'Billing Maju Jaya',
    }),
    account: ACCOUNT_REF_FULL.billing,
  },
  {
    ...identity({
      id: COMPOSE_PHOTO_IDS.identityPersonal,
      accountId: MAIL_PHOTO_IDS.personal,
      address: 'rina.kartika@surel.id',
      displayName: 'Rina Kartika',
    }),
    account: ACCOUNT_REF_FULL.personal,
  },
];

const SIGNATURE_HTML = `<div data-signature="${COMPOSE_PHOTO_IDS.signatureFormal}"><p>Salam hangat,<br><strong>Rina Kartika</strong><br>Tim Layanan Pelanggan PT Maju Jaya</p></div>`;

const SIGNATURES = {
  shared: [
    {
      id: COMPOSE_PHOTO_IDS.signatureFormal,
      accountId: MAIL_PHOTO_IDS.cs,
      scope: 'shared',
      name: 'Formal',
      html: '<p>Salam hangat,<br><strong>{{nama_agen}}</strong><br>Tim Layanan Pelanggan {{nama_organisasi}}</p>',
      text: 'Salam hangat,\n{{nama_agen}}\nTim Layanan Pelanggan {{nama_organisasi}}',
      logoUrl: null,
      editable: true,
      createdAt: ago(20 * 24 * HOUR),
      updatedAt: ago(2 * 24 * HOUR),
    },
    {
      id: COMPOSE_PHOTO_IDS.signatureShort,
      accountId: MAIL_PHOTO_IDS.cs,
      scope: 'shared',
      name: 'Singkat untuk balasan',
      html: '<p>Salam,<br>{{nama_agen}} · {{nama_organisasi}}</p>',
      text: 'Salam,\n{{nama_agen}} · {{nama_organisasi}}',
      logoUrl: null,
      editable: true,
      createdAt: ago(20 * 24 * HOUR),
      updatedAt: ago(5 * 24 * HOUR),
    },
  ],
  mine: [
    {
      id: '7a1b2c3d-0000-4000-8000-0000000000fd',
      accountId: MAIL_PHOTO_IDS.cs,
      scope: 'personal',
      name: 'Pribadi Rina',
      html: '<p>Terima kasih,<br>Rina · 0812-0000-1234</p>',
      text: 'Terima kasih,\nRina · 0812-0000-1234',
      logoUrl: null,
      editable: true,
      createdAt: ago(10 * 24 * HOUR),
      updatedAt: ago(10 * 24 * HOUR),
    },
  ],
};

type Address = { address: string; name: string | null };

function draft(init: {
  id: string;
  mode: 'new' | 'reply' | 'reply_all' | 'forward';
  to?: Address[];
  cc?: Address[];
  subject?: string;
  bodyHtml?: string;
  sourceMessageId?: string | null;
  threadKey?: string | null;
}) {
  const reply = init.mode !== 'new';
  return {
    id: init.id,
    accountId: MAIL_PHOTO_IDS.cs,
    identityId: COMPOSE_PHOTO_IDS.identityCs,
    mode: init.mode,
    sourceMessageId: init.sourceMessageId ?? null,
    threadKey: init.threadKey ?? null,
    to: init.to ?? [],
    cc: init.cc ?? [],
    bcc: [],
    subject: init.subject ?? '',
    format: 'html',
    bodyHtml: init.bodyHtml ?? `<p><br></p>${SIGNATURE_HTML}`,
    bodyText: null,
    includeQuote: reply,
    quote: reply
      ? {
          available: true,
          messageId: init.sourceMessageId ?? null,
          from: { address: 'noc@nusaraya-backbone.id', name: 'NOC Nusaraya Backbone' },
          sentAt: ago(HOUR),
          hasHtml: true,
        }
      : { available: false, messageId: null, from: null, sentAt: null, hasHtml: false },
    attachments: [],
    attachmentTotalBytes: 0,
    version: 1,
    state: 'editing',
    lastSendError: null,
    serverCopy: { state: 'synced', syncedAt: ago(MINUTE) },
    threadSeenAt: ago(MINUTE),
    canSend: true,
    cannotSendReason: null,
    createdAt: ago(MINUTE),
    updatedAt: ago(MINUTE),
  };
}

const REPLY_BODY = `<p>Terima kasih atas informasinya. Pelanggan korporat yang terdampak sudah kami kabari:</p><ul><li>SKT-LT-01 — PT Lada Lampung (sudah dikonfirmasi)</li><li>SKT-LT-02 — Koperasi Tani Makmur</li></ul><p>Mohon kabari kami bila jadwalnya berubah.</p>${SIGNATURE_HTML}`;

const CHECKS = {
  checks: {
    totalRecipients: 1,
    maxRecipients: 50,
    bccCount: 0,
    bccWarning: false,
    recipients: [],
    newAddressCount: 0,
    newAddressQuota: { limit: 200, remaining: 196 },
    replyToDiffers: null,
    identity: { verified: true, reason: null },
    attachments: { totalBytes: 0, maxBytes: 20 * 1024 * 1024, notReady: 0 },
    threadNewMessages: { count: 0, latestReceivedAt: null },
  },
};

function outbox() {
  const now = Date.now();
  return {
    id: COMPOSE_PHOTO_IDS.outbox,
    draftId: COMPOSE_PHOTO_IDS.draftNew,
    accountId: MAIL_PHOTO_IDS.cs,
    identity: {
      id: COMPOSE_PHOTO_IDS.identityCs,
      address: 'cs@majujaya.co.id',
      displayName: 'CS Maju Jaya',
    },
    status: 'pending',
    holdReason: null,
    // Masa batal panjang supaya hitung mundur masih terlihat saat difoto.
    sendAfter: new Date(now + 30_000).toISOString(),
    nextAttemptAt: null,
    attempts: 0,
    subject: 'Penawaran paket Bisnis 50 Mbps',
    recipientCount: 1,
    toPreview: ['Rina Wulandari'],
    sentAt: null,
    failure: null,
    rejectedRecipients: [],
    sentCopy: { state: 'pending' },
    createdAt: new Date(now).toISOString(),
  };
}

const THREAD_CONFLICT = {
  error: {
    code: 'CONFLICT',
    message: 'Ada 1 email baru di utas ini sejak kamu mulai menulis.',
    details: [
      {
        field: 'draftId',
        message: 'Ada email baru di utas ini.',
        reason: 'thread_has_new_messages',
        count: 1,
        latestReceivedAt: ago(MINUTE),
        messageIds: [MAIL_MESSAGE_IDS.upgrade],
      },
    ],
    requestId: 'req-foto',
  },
};

const DRAFT_PATH = /\/api\/v1\/mail\/drafts\/[0-9a-f-]{36}(\/[a-z-]+)?(\?.*)?$/;

/**
 * Jendela tulis 9B: identitas "Dari", buat/simpan/cek draf, saran penerima, unggah lampiran,
 * kirim (outbox `pending` dengan masa batal), presence, tanda tangan, preferensi.
 * `threadConflict` = kirim pertama dijawab 409 `thread_has_new_messages`; `hangUpload` = unggahan
 * kedua tidak dijawab (foto progres).
 */
export async function mailCompose(
  page: Page,
  options: { threadConflict?: boolean; hangUpload?: boolean } = {},
): Promise<void> {
  let version = 1;
  let uploads = 0;
  let sends = 0;
  await page.route(`${API}/mail/identities`, (route) =>
    json(route, { identities: COMPOSE_IDENTITIES }),
  );
  await page.route(`${API}/mail/preferences`, (route) =>
    json(route, { undoSendSeconds: 10, composeFormat: 'html', signatureChoices: {} }),
  );
  await page.route(`${API}/mail/identity-approvals`, (route) => json(route, { approvals: [] }));
  for (const item of MAIL_ACCOUNTS) {
    const own = COMPOSE_IDENTITIES.filter((entry) => entry.accountId === item.id).map(
      ({ account: _account, ...rest }) => rest,
    );
    await page.route(`${API}/mail/accounts/${item.id}/identities`, (route) =>
      json(route, { identities: item.id === MAIL_PHOTO_IDS.cs ? CS_IDENTITIES : own }),
    );
    await page.route(`${API}/mail/accounts/${item.id}/signatures`, (route) =>
      json(route, item.id === MAIL_PHOTO_IDS.cs ? SIGNATURES : { shared: [], mine: [] }),
    );
  }
  await page.route(`${API}/mail/drafts`, (route) => {
    const body = route.request().postDataJSON() as { mode: string; sourceMessageId?: string };
    const created =
      body.mode === 'new'
        ? draft({ id: COMPOSE_PHOTO_IDS.draftNew, mode: 'new' })
        : draft({
            id: COMPOSE_PHOTO_IDS.draftReply,
            mode: body.mode as 'reply',
            sourceMessageId: body.sourceMessageId ?? null,
            threadKey: 'utas-foto',
            to: [{ address: 'noc@nusaraya-backbone.id', name: 'NOC Nusaraya Backbone' }],
            cc:
              body.mode === 'reply_all'
                ? [{ address: 'rina.kartika@majujaya.co.id', name: 'Rina Kartika' }]
                : [],
            subject:
              body.mode === 'forward'
                ? 'Fwd: Jadwal pemeliharaan backbone 26 Nov, 01.00–04.00 WIB'
                : 'Re: Jadwal pemeliharaan backbone 26 Nov, 01.00–04.00 WIB',
            bodyHtml: REPLY_BODY,
          });
    return json(route, { draft: created, skippedAttachments: [] }, 201);
  });
  await page.route(DRAFT_PATH, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const draftId = url.pathname.split('/')[5] ?? COMPOSE_PHOTO_IDS.draftNew;
    const action = url.pathname.split('/')[6] ?? '';
    const method = request.method();
    if (action === 'check') return json(route, CHECKS);
    if (action === 'presence') return json(route, { threadKey: 'utas-foto', users: [] });
    if (action === 'attachments') {
      uploads += 1;
      // Unggahan kedua dibiarkan menggantung: foto progres.
      if (options.hangUpload && uploads === 2) return undefined;
      version += 1;
      return json(
        route,
        {
          attachment: {
            id: `7a1b2c3d-0000-4000-8000-00000000a0${String(uploads).padStart(2, '0')}`,
            filename: 'Penawaran-Bisnis-50Mbps.pdf',
            contentType: 'application/pdf',
            sizeBytes: 319_488,
            inline: false,
            contentId: null,
            state: 'ready',
            source: 'upload',
          },
          draft: { version },
        },
        201,
      );
    }
    if (action === 'send') {
      sends += 1;
      if (options.threadConflict && sends === 1) return json(route, THREAD_CONFLICT, 409);
      return json(route, { outbox: outbox() }, 202);
    }
    if (method === 'PUT') {
      version += 1;
      return json(route, {
        draft: {
          id: draftId,
          version,
          updatedAt: new Date().toISOString(),
          serverCopy: { state: 'pending', syncedAt: null },
        },
      });
    }
    if (method === 'DELETE') return json(route, { deleted: true });
    return json(route, { draft: draft({ id: draftId, mode: 'new' }) });
  });
  await page.route(`${API}/mail/recipients/suggest**`, (route) =>
    json(route, {
      suggestions: [
        {
          address: 'rina.wulandari@lada-lampung.co.id',
          name: 'Rina Wulandari',
          source: 'contact',
          contactId: null,
        },
        {
          address: 'rizal@lada-lampung.co.id',
          name: 'Rizal Pratama',
          source: 'history',
          contactId: null,
        },
      ],
    }),
  );
  await page.route(`${API}/mail/compose/snippets**`, (route) =>
    json(route, { quickReplies: [], emailTemplates: [] }),
  );
}
