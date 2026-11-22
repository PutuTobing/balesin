import type { Page } from '@playwright/test';
import { json, sessionAs } from './mocks';
import { PHOTO_CONVERSATIONS, inboxMocks } from './mocks-inbox';
import { PHOTO_USER_IDS, quietSecurity, teamUsers } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 6 + jam kerja: Pengaturan → Channel lain (Telegram, Email, Messenger, Instagram), wizard &
 * halaman channel, inbox multi-channel (Telegram, Email + HTML aman), Pengaturan → Jam kerja &
 * alokasi, saklar "Tersedia". Data tiruan = bentuk skema bersama.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const CAPABILITIES = {
  whatsapp: {
    customerWindow: true,
    templates: true,
    broadcast: true,
    initiate: true,
    quoteReply: true,
    messageTypes: ['text', 'media', 'location', 'reaction', 'interactive', 'template'],
    maxOutboundMediaBytes: 104857600,
  },
  telegram: {
    customerWindow: false,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: true,
    messageTypes: ['text', 'media', 'location', 'interactive'],
    maxOutboundMediaBytes: 52428800,
  },
  email: {
    customerWindow: false,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: false,
    messageTypes: ['text', 'media'],
    maxOutboundMediaBytes: 15728640,
  },
  messenger: {
    customerWindow: true,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: false,
    messageTypes: ['text', 'media'],
    maxOutboundMediaBytes: 26214400,
  },
  instagram: {
    customerWindow: true,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: false,
    messageTypes: ['text', 'media'],
    maxOutboundMediaBytes: 26214400,
  },
};
const REVIEW_MESSENGER =
  'Butuh App Review Meta (izin pages_messaging). Channel dibuat dalam keadaan nonaktif; aktifkan setelah aplikasi Meta-mu disetujui dan tes koneksi berhasil.';
const REVIEW_INSTAGRAM =
  'Butuh App Review Meta (izin instagram_manage_messages) dan akun Instagram profesional yang terhubung ke Halaman Facebook. Channel dibuat dalam keadaan nonaktif; aktifkan setelah disetujui dan tes koneksi berhasil.';
const TYPES = [
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    available: true,
    note: null,
    capabilities: CAPABILITIES.whatsapp,
  },
  {
    type: 'telegram',
    label: 'Telegram',
    available: true,
    note: null,
    capabilities: CAPABILITIES.telegram,
  },
  { type: 'email', label: 'Email', available: true, note: null, capabilities: CAPABILITIES.email },
  {
    type: 'messenger',
    label: 'Messenger',
    available: true,
    note: REVIEW_MESSENGER,
    capabilities: CAPABILITIES.messenger,
  },
  {
    type: 'instagram',
    label: 'Instagram',
    available: true,
    note: REVIEW_INSTAGRAM,
    capabilities: CAPABILITIES.instagram,
  },
];

const base = {
  enabled: true,
  disabledAt: null,
  status: 'connected',
  lastTest: {
    ok: true,
    code: 'ok',
    message: 'Koneksi berhasil. Channel siap dipakai.',
    testedAt: ago(2 * HOUR),
  },
  credentialsUpdatedAt: ago(5 * 24 * HOUR),
  createdAt: ago(5 * 24 * HOUR),
  updatedAt: ago(2 * HOUR),
};
const TELEGRAM = {
  ...base,
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e11',
  type: 'telegram',
  name: 'Bot CS Maju Jaya',
  botUsername: 'majujaya_cs_bot',
  botId: '7012345678',
  botTokenHint: '••••Xk2Q',
  webhook: {
    url: 'https://balesin.majujaya.co.id/webhooks/telegram/6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e11',
    registeredAt: ago(5 * 24 * HOUR),
    warning: null,
  },
};
const EMAIL = {
  ...base,
  status: 'failed',
  lastTest: {
    ok: false,
    code: 'imap_auth_failed',
    message:
      'Username atau password IMAP ditolak. Untuk Gmail dan Microsoft 365, aktifkan IMAP dan pakai app password, bukan password akun biasa.',
    testedAt: ago(HOUR),
  },
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e12',
  type: 'email',
  name: 'Email CS',
  emailAddress: 'cs@majujaya.co.id',
  aliases: ['billing@majujaya.co.id', 'tagihan@majujaya.co.id'],
  fromName: 'CS Maju Jaya',
  imap: {
    host: 'mail.majujaya.co.id',
    port: 993,
    security: 'ssl',
    username: 'cs@majujaya.co.id',
    passwordHint: '••••',
    folder: 'INBOX',
  },
  pollIntervalMinutes: 2,
  markAsRead: true,
  senderVerification: {
    trustedAuthServIds: ['mail.majujaya.co.id', '.majujaya.co.id'],
    isDefault: true,
  },
  smtp: { mode: 'system' },
  mailbox: {
    lastPolledAt: ago(3 * 60_000),
    lastPollOk: false,
    lastPollCode: 'imap_auth_failed',
    lastPollMessage: 'Username atau password IMAP ditolak.',
    skippedMessages: 4,
  },
};
const MESSENGER = {
  ...base,
  enabled: false,
  status: 'untested',
  lastTest: null,
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e13',
  type: 'messenger',
  name: 'Halaman Maju Jaya',
  pageId: '104523987612345',
  instagramAccountId: null,
  pageAccessTokenHint: '••••ZD9a',
  appSecretHint: '••••41f0',
  webhookUrl:
    'https://balesin.majujaya.co.id/webhooks/messenger/6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e13',
  requiresAppReview: true,
  reviewNote: REVIEW_MESSENGER,
};
const CONNECTIONS = [TELEGRAM, EMAIL, MESSENGER];

/** Tahap 9.0 — departemen untuk kartu "Akses tim". */
const ACCESS_DEPARTMENTS = [
  { id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d01', name: 'Customer Service', memberCount: 3 },
  { id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d03', name: 'Tagihan', memberCount: 2 },
  { id: '0d0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0d02', name: 'Teknisi', memberCount: 1 },
];

/** Email CS: hanya departemen Tagihan + satu CS langsung. Channel lain: semua tim. */
function accessFor(channelId: string) {
  const restricted = channelId === EMAIL.id;
  return {
    channelId,
    mode: restricted ? 'restricted' : 'all',
    departments: restricted ? [ACCESS_DEPARTMENTS[1]] : [],
    users: restricted
      ? [{ id: PHOTO_USER_IDS.cs, name: 'Citra Maharani', role: 'cs', active: true }]
      : [],
    exemptRoles: ['owner', 'admin'],
  };
}

async function connectionMocks(page: Page, channels: unknown[] = CONNECTIONS): Promise<void> {
  await quietSecurity(page);
  await teamUsers(page);
  await page.route(`${API}/departments`, (route) =>
    json(route, {
      departments: ACCESS_DEPARTMENTS.map((department) => ({ ...department, description: null })),
    }),
  );
  for (const channel of CONNECTIONS) {
    await page.route(`${API}/settings/channels/${channel.id}/access`, (route) => {
      if (route.request().method() !== 'PUT') return json(route, { access: accessFor(channel.id) });
      // Simpan: keadaan baru dari isian + 3 percakapan dikembalikan ke antrian.
      const body = route.request().postDataJSON() as {
        mode: 'all' | 'restricted';
        departmentIds?: string[];
        userIds?: string[];
      };
      return json(route, {
        access: {
          channelId: channel.id,
          mode: body.mode,
          departments: ACCESS_DEPARTMENTS.filter((item) => body.departmentIds?.includes(item.id)),
          users: (body.userIds ?? []).map((id) => ({
            id,
            name: 'Citra Maharani',
            role: 'cs',
            active: true,
          })),
          exemptRoles: ['owner', 'admin'],
        },
        releasedConversations: 3,
      });
    });
  }
  await page.route(`${API}/settings/channel-connections`, (route) =>
    json(route, { channels, types: TYPES, canStoreSecrets: true, maxChannels: 20 }),
  );
  for (const channel of CONNECTIONS) {
    await page.route(`${API}/settings/channel-connections/${channel.id}`, (route) =>
      json(route, { channel }),
    );
  }
  await page.route(`${API}/settings/channel-connections/${MESSENGER.id}/webhook`, (route) =>
    json(route, {
      channelId: MESSENGER.id,
      callbackUrl: MESSENGER.webhookUrl,
      verifyToken: 'bls_vt_9f3c2a71d8',
      verifyTokenRotatedAt: ago(5 * 24 * HOUR),
      subscribeFields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads'],
      warning: null,
    }),
  );
  // Telegram aktif tanpa penerima (peringatan); Email aktif dengan penerima siap (sakelar
  // "pengirim terverifikasi" tampil); Messenger mati.
  for (const channel of CONNECTIONS) {
    const telegram = channel.id === TELEGRAM.id;
    const email = channel.id === EMAIL.id;
    const enabled = telegram || email;
    await page.route(`${API}/settings/channels/${channel.id}/bot`, (route) =>
      json(route, {
        settings: {
          enabled,
          hours: { mode: 'always' },
          timeoutMinutes: enabled ? 15 : null,
          channelType: channel.type,
          timezone: 'Asia/Jakarta',
          activeNow: enabled,
          receiverReady: email,
          requireVerifiedSender: false,
          updatedAt: enabled ? ago(2 * HOUR) : null,
        },
      }),
    );
  }
}

// ── Inbox multi-channel ─────────────────────────────────────────────────────

const first = PHOTO_CONVERSATIONS[0]!;
const TG_CONVERSATION = {
  ...first,
  id: 'c1a2b3c4-0000-4000-8000-0000000009a1',
  number: 901,
  channel: { id: TELEGRAM.id, name: TELEGRAM.name, type: 'telegram' },
  contact: {
    ...first.contact,
    id: 'd1a2b3c4-0000-4000-8000-0000000009a1',
    displayName: 'Andika Pratama',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: '@andika_dps',
  },
  windowApplies: false,
  windowExpiresAt: null,
  windowOpen: true,
  unreadCount: 1,
  lastMessage: {
    direction: 'inbound',
    type: 'text',
    text: 'Kak, router saya kedip merah terus.',
    status: null,
    createdAt: ago(5 * 60_000),
  },
  lastMessageAt: ago(5 * 60_000),
};
const EMAIL_CONVERSATION = {
  ...first,
  id: 'c1a2b3c4-0000-4000-8000-0000000009a2',
  number: 902,
  status: 'served',
  channel: { id: EMAIL.id, name: EMAIL.name, type: 'email' },
  contact: {
    ...first.contact,
    id: 'd1a2b3c4-0000-4000-8000-0000000009a2',
    displayName: 'Rudi Hartono',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: 'rudi.hartono@gmail.com',
  },
  windowApplies: false,
  windowExpiresAt: null,
  windowOpen: true,
  unreadCount: 0,
  lastMessage: {
    direction: 'inbound',
    type: 'text',
    text: 'Mohon kirim ulang tagihan November.',
    status: null,
    createdAt: ago(40 * 60_000),
  },
  lastMessageAt: ago(40 * 60_000),
};
/** Tahap 9.0: utas email lewat alias billing@ dengan Cc. */
const EMAIL_CC_CONVERSATION = {
  ...EMAIL_CONVERSATION,
  id: 'c1a2b3c4-0000-4000-8000-0000000009a3',
  number: 903,
  contact: { ...EMAIL_CONVERSATION.contact, id: 'd1a2b3c4-0000-4000-8000-0000000009a3' },
  lastMessage: {
    direction: 'outbound',
    type: 'text',
    text: 'Tagihan November sudah kami kirim ulang dalam format PDF.',
    status: 'delivered',
    createdAt: ago(30 * 60_000),
  },
  lastMessageAt: ago(30 * 60_000),
};
const EMAIL_MESSAGES = [
  {
    id: 'e1a2b3c4-0000-4000-8000-0000000009b1',
    number: 1,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: null,
    text: 'Selamat siang,\n\nMohon kirim ulang tagihan November ke email ini. Lampiran sebelumnya tidak bisa dibuka.\n\nTerima kasih,\nRudi',
    media: null,
    location: null,
    interactive: null,
    reaction: null,
    replyTo: null,
    referral: null,
    forwarded: false,
    sharedContactsCount: 0,
    status: null,
    errorCode: null,
    failure: null,
    senderUserId: null,
    mediaAvailable: false,
    starredAt: null,
    email: {
      subject: 'Tagihan November tidak bisa dibuka',
      hasHtml: true,
      authWarning: false,
      senderVerification: 'pass',
      skippedAttachments: 1,
      to: ['billing@majujaya.co.id', 'dewi.keuangan@hartono-group.co.id'],
      cc: ['andi.pratama@hartono-group.co.id'],
      bcc: [],
      recipient: 'billing@majujaya.co.id',
      replyAll: ['dewi.keuangan@hartono-group.co.id', 'andi.pratama@hartono-group.co.id'],
    },
    createdAt: ago(40 * 60_000),
  },
  {
    id: 'e1a2b3c4-0000-4000-8000-0000000009b2',
    number: 2,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: null,
    text: 'Segera verifikasi akun Anda lewat tautan di bawah agar layanan tidak diputus.',
    media: null,
    location: null,
    interactive: null,
    reaction: null,
    replyTo: null,
    referral: null,
    forwarded: false,
    sharedContactsCount: 0,
    status: null,
    errorCode: null,
    failure: null,
    senderUserId: null,
    mediaAvailable: false,
    starredAt: null,
    email: {
      subject: 'Verifikasi akun pelanggan',
      hasHtml: false,
      authWarning: true,
      senderVerification: 'fail',
      skippedAttachments: 0,
      to: ['cs@majujaya.co.id'],
      cc: [],
      bcc: [],
      recipient: 'cs@majujaya.co.id',
      replyAll: [],
    },
    createdAt: ago(20 * 60_000),
  },
];

/** Tahap 9.0: balasan tim ber-Cc/Bcc (Bcc hanya terlihat tim) setelah email masuk lewat alias. */
const EMAIL_REPLY = {
  ...EMAIL_MESSAGES[0],
  id: 'e1a2b3c4-0000-4000-8000-0000000009b3',
  number: 3,
  direction: 'outbound',
  senderKind: 'agent',
  senderUserId: 'a1a2b3c4-0000-4000-8000-0000000000a1',
  text: 'Selamat siang Pak Rudi,\n\nTagihan November sudah kami kirim ulang dalam format PDF. Bu Dewi dan Pak Andi kami tembuskan.\n\nSalam,\nCS Maju Jaya',
  status: 'delivered',
  email: {
    subject: 'Re: Tagihan November tidak bisa dibuka',
    hasHtml: false,
    authWarning: false,
    senderVerification: 'pass',
    skippedAttachments: 0,
    to: ['rudi.hartono@gmail.com'],
    cc: ['dewi.keuangan@hartono-group.co.id', 'andi.pratama@hartono-group.co.id'],
    bcc: ['arsip.tagihan@majujaya.co.id'],
    recipient: null,
    replyAll: [],
  },
  createdAt: ago(30 * 60_000),
};
const EMAIL_THREAD = [EMAIL_MESSAGES[0], EMAIL_REPLY];

async function multiChannelInbox(page: Page): Promise<void> {
  await inboxMocks(page, {
    conversations: [
      TG_CONVERSATION,
      EMAIL_CC_CONVERSATION,
      EMAIL_CONVERSATION,
      ...PHOTO_CONVERSATIONS.slice(1, 5),
    ] as typeof PHOTO_CONVERSATIONS,
    messages: (route) => {
      const url = route.request().url();
      if (url.includes(EMAIL_CONVERSATION.id)) {
        return json(route, { messages: [...EMAIL_MESSAGES].reverse(), nextCursor: null });
      }
      if (url.includes(EMAIL_CC_CONVERSATION.id)) {
        return json(route, { messages: [...EMAIL_THREAD].reverse(), nextCursor: null });
      }
      return json(route, {
        messages: [
          {
            ...EMAIL_MESSAGES[0],
            id: 'e1a2b3c4-0000-4000-8000-0000000009c1',
            email: null,
            text: 'Kak, router saya kedip merah terus.',
            createdAt: ago(5 * 60_000),
          },
        ],
        nextCursor: null,
      });
    },
  });
  await page.route(/\/api\/v1\/messages\/[0-9a-f-]{36}\/email-html$/, (route) =>
    json(route, {
      html: '<p>Selamat siang,</p><p>Mohon kirim ulang <b>tagihan November</b> ke email ini. Lampiran sebelumnya tidak bisa dibuka.</p><p>Terima kasih,<br>Rudi</p>',
    }),
  );
  // Daftar channel inbox: channel Email dengan 3 alamat → saringan "Alamat tujuan" tampil.
  await page.route(`${API}/channels`, (route) =>
    json(route, {
      channels: [
        {
          id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
          name: 'CS Maju Jaya',
          type: 'whatsapp',
          enabled: true,
          displayPhoneNumber: '+62 811-7200-345',
          emailAddresses: [],
        },
        {
          id: TELEGRAM.id,
          name: TELEGRAM.name,
          type: 'telegram',
          enabled: true,
          displayPhoneNumber: null,
          emailAddresses: [],
        },
        {
          id: EMAIL.id,
          name: EMAIL.name,
          type: 'email',
          enabled: true,
          displayPhoneNumber: null,
          emailAddresses: [EMAIL.emailAddress, ...EMAIL.aliases],
        },
      ],
    }),
  );
  await page.route(`${API}/inbox/availability`, (route) =>
    json(route, { availability: { available: true, excluded: false, mode: 'round_robin' } }),
  );
}

// ── Jam kerja & alokasi ─────────────────────────────────────────────────────

const WORKSPACE = {
  timezone: 'Asia/Jakarta',
  teamHours: {
    mode: 'schedule',
    windows: [1, 2, 3, 4, 5]
      .map((day) => ({ day, start: '08:00', end: '17:00' }))
      .concat([{ day: 6, start: '08:00', end: '13:00' }]),
  },
  holidays: [
    { date: '2026-12-25', name: 'Natal' },
    { date: '2027-01-01', name: 'Tahun Baru' },
  ],
  withinTeamHoursNow: true,
  allocation: { mode: 'round_robin', maxOpenPerAgent: 8 },
  autoMessages: {
    greeting: {
      enabled: true,
      text: 'Halo {nama}, terima kasih sudah menghubungi kami. Tim kami akan segera membalas ya.',
    },
    away: {
      enabled: true,
      text: 'Halo {nama}, saat ini di luar jam kerja. Pesanmu akan kami balas besok mulai pukul 08.00 ya.',
    },
    assigned: { enabled: false, text: 'Halo {nama}, {agen} akan membantumu ya.' },
  },
  updatedAt: ago(3 * 24 * HOUR),
};
const AGENTS = [
  {
    userId: 'a1a2b3c4-0000-4000-8000-0000000000a1',
    name: 'Rina Kartika',
    role: 'owner',
    available: true,
    excluded: true,
    openConversations: 2,
    lastAssignedAt: null,
  },
  {
    userId: 'a1a2b3c4-0000-4000-8000-0000000000a3',
    name: 'Sari Wulandari',
    role: 'supervisor',
    available: true,
    excluded: false,
    openConversations: 5,
    lastAssignedAt: ago(25 * 60_000),
  },
  {
    userId: 'a1a2b3c4-0000-4000-8000-0000000000a5',
    name: 'Made Wirawan',
    role: 'cs',
    available: false,
    excluded: false,
    openConversations: 0,
    lastAssignedAt: ago(26 * HOUR),
  },
  {
    userId: 'a1a2b3c4-0000-4000-8000-0000000000a6',
    name: 'Citra Lestari',
    role: 'cs',
    available: true,
    excluded: false,
    openConversations: 8,
    lastAssignedAt: ago(7 * 60_000),
  },
];

async function workspaceMocks(page: Page): Promise<void> {
  await quietSecurity(page);
  await page.route(`${API}/settings/workspace`, (route) => json(route, { settings: WORKSPACE }));
  await page.route(`${API}/settings/workspace/agents`, (route) => json(route, { agents: AGENTS }));
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

export const channelConnectionScreens: Screen[] = [
  {
    name: 'channel-lain',
    path: '/pengaturan/channel',
    before: (page) => connectionMocks(page),
    waitFor: 'text=Bot CS Maju Jaya',
    prepare: settle,
    tall: true,
  },
  {
    name: 'channel-lain-kosong',
    path: '/pengaturan/channel',
    before: (page) => connectionMocks(page, []),
    waitFor: 'text=Tambah channel',
    prepare: settle,
  },
  {
    name: 'channel-telegram-baru',
    path: '/pengaturan/channel/baru/telegram',
    before: (page) => connectionMocks(page),
    waitFor: 'text=Hubungkan Telegram',
    prepare: async (page) => {
      await page.getByLabel('Nama channel').fill('Bot CS Maju Jaya');
      await settle(page);
    },
  },
  {
    name: 'channel-email-baru',
    path: '/pengaturan/channel/baru/email',
    before: (page) => connectionMocks(page),
    waitFor: 'text=Hubungkan Email',
    prepare: settle,
    tall: true,
  },
  {
    name: 'channel-messenger-baru',
    path: '/pengaturan/channel/baru/messenger',
    before: (page) => connectionMocks(page),
    waitFor: 'text=Hubungkan Messenger',
    prepare: settle,
  },
  {
    name: 'channel-telegram',
    path: `/pengaturan/channel/lain/${TELEGRAM.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=@majujaya_cs_bot',
    prepare: settle,
    tall: true,
  },
  {
    name: 'channel-email',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=cs@majujaya.co.id',
    prepare: settle,
    tall: true,
  },
  {
    name: 'channel-messenger',
    path: `/pengaturan/channel/lain/${MESSENGER.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=bls_vt_9f3c2a71d8',
    prepare: settle,
    tall: true,
  },
  {
    name: 'inbox-telegram',
    path: `/inbox?chat=${TG_CONVERSATION.id}`,
    before: multiChannelInbox,
    // Cuplikan di daftar tersembunyi di HP saat chat terbuka: tunggu gelembung yang tampil.
    waitFor: 'text=Kak, router saya kedip merah terus. >> visible=true',
    prepare: settle,
  },
  {
    // Menu "Tindakan chat" Telegram: pengaturan bot channel sudah di cache (dibuka dari Pengaturan),
    // bot aktif tanpa penerima → "Kembalikan ke bot" nonaktif dengan alasan terbaca.
    name: 'inbox-bot-menu',
    path: `/pengaturan/channel/lain/${TELEGRAM.id}`,
    before: async (page) => {
      await connectionMocks(page);
      await multiChannelInbox(page);
    },
    waitFor: 'text=Belum ada penerima bot',
    prepare: async (page) => {
      // Navigasi di dalam aplikasi (cache tetap): ke chat Telegram, lalu buka menu tindakan.
      await page.evaluate((url) => {
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, `/inbox?chat=${TG_CONVERSATION.id}`);
      await page.getByText('Kak, router saya kedip merah terus.').last().waitFor();
      await page.getByRole('button', { name: 'Tindakan chat' }).click();
      await page.getByText('Belum ada webhook penerima bot.', { exact: false }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'inbox-email',
    path: `/inbox?chat=${EMAIL_CONVERSATION.id}`,
    before: multiChannelInbox,
    waitFor: 'text=Tagihan November tidak bisa dibuka',
    prepare: settle,
  },
  {
    name: 'inbox-email-html',
    path: `/inbox?chat=${EMAIL_CONVERSATION.id}`,
    before: multiChannelInbox,
    waitFor: 'text=Tagihan November tidak bisa dibuka',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Lihat versi HTML' }).click();
      await page.getByTitle('Isi email versi HTML (tanpa skrip)').waitFor();
      await settle(page);
    },
  },
  {
    // Tahap 9.0: email masuk lewat alias (Kepada/Cc, "Dikirim ke billing@…") + balasan ber-Cc/Bcc.
    name: 'inbox-email-cc',
    path: `/inbox?chat=${EMAIL_CC_CONVERSATION.id}`,
    before: multiChannelInbox,
    waitFor: 'text=Re: Tagihan November tidak bisa dibuka',
    prepare: settle,
  },
  {
    // Composer Cc/Bcc terbuka (CS tanpa izin memulai percakapan): Balas semua + alamat baru bertanda.
    name: 'inbox-email-ccbcc',
    path: `/inbox?chat=${EMAIL_CC_CONVERSATION.id}`,
    before: async (page) => {
      await sessionAs(page, 'cs');
      await multiChannelInbox(page);
    },
    waitFor: 'text=Re: Tagihan November tidak bisa dibuka',
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Balas semua/ }).click();
      const bcc = page.getByRole('textbox', { name: 'Alamat Bcc' });
      await bcc.fill('pajak@konsultan-pajak.co.id');
      await bcc.press('Enter');
      await page
        .getByRole('textbox', { name: 'Tulis balasan' })
        .fill('Baik Pak Rudi, tagihan revisi kami lampirkan ulang.');
      await page.getByText('butuh izin memulai percakapan', { exact: false }).first().waitFor();
      await settle(page);
    },
  },
  {
    // Saringan "Alamat tujuan" (channel Email punya alias).
    name: 'inbox-saring-alamat',
    path: '/inbox',
    before: multiChannelInbox,
    waitFor: 'text=Andika Pratama',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Saring chat' }).click();
      const last = page.getByRole('menu').getByText('tagihan@majujaya.co.id');
      await last.waitFor();
      await last.scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    // Pengaturan → Channel → Email: kartu Alias alamat sedang diubah (alamat salah diberi penjelasan).
    name: 'channel-email-alias',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Alias alamat',
    prepare: async (page) => {
      const input = page.getByRole('textbox', { name: 'Alias', exact: true });
      await input.fill('keuangan@majujaya.co.id');
      await input.press('Enter');
      await input.fill('admin@majujaya');
      await input.press('Enter');
      await page.getByRole('button', { name: 'Simpan alias' }).scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    // Tahap 9.0: Akses tim — hanya departemen Tagihan + satu pengguna.
    name: 'channel-akses-tim',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Akses tim',
    prepare: async (page) => {
      await page.getByRole('checkbox', { name: /Tagihan/ }).waitFor();
      await page.getByRole('heading', { name: 'Akses tim' }).scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    // Akses tim: mode terbatas tanpa pilihan → peringatan "hanya Owner dan Admin".
    name: 'channel-akses-tim-kosong',
    path: `/pengaturan/channel/lain/${TELEGRAM.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Akses tim',
    prepare: async (page) => {
      await page.getByRole('radio', { name: /Hanya departemen atau pengguna tertentu/ }).click();
      await page.getByText('Pilih departemen atau pengguna', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Simpan akses' }).scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    // Melonggarkan akses (menambah departemen) → konfirmasi identitas.
    name: 'akses-konfirmasi',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Akses tim',
    prepare: async (page) => {
      await page.getByRole('checkbox', { name: /Customer Service/ }).check();
      await page.getByRole('button', { name: 'Simpan akses' }).click();
      await page.getByRole('dialog', { name: 'Perluas akses channel ini?' }).waitFor();
      await settle(page);
    },
  },
  {
    // Mempersempit akses (tanpa konfirmasi) → tersimpan, 3 percakapan dikembalikan ke antrian.
    name: 'akses-tersimpan',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Akses tim',
    prepare: async (page) => {
      await page.getByRole('checkbox', { name: /Citra Maharani/ }).uncheck();
      await page.getByRole('button', { name: 'Simpan akses' }).click();
      const done = page.getByText('Akses tim disimpan');
      await done.waitFor();
      await done.scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
  {
    // Menambah alias → konfirmasi identitas.
    name: 'alias-konfirmasi',
    path: `/pengaturan/channel/lain/${EMAIL.id}`,
    before: (page) => connectionMocks(page),
    waitFor: 'text=Alias alamat',
    prepare: async (page) => {
      const input = page.getByRole('textbox', { name: 'Alias', exact: true });
      await input.fill('keuangan@majujaya.co.id');
      await input.press('Enter');
      await page.getByRole('button', { name: 'Simpan alias' }).click();
      await page.getByRole('dialog', { name: 'Tambah alias ke channel ini?' }).waitFor();
      await settle(page);
    },
  },
  {
    // Galat Cc: ketikan bukan alamat tetap di kolom Cc dengan penjelasan; Bcc tidak ikut merah.
    name: 'cc-galat',
    path: `/inbox?chat=${EMAIL_CC_CONVERSATION.id}`,
    before: multiChannelInbox,
    waitFor: 'text=Re: Tagihan November tidak bisa dibuka',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tambah Cc atau Bcc' }).click();
      const cc = page.getByRole('textbox', { name: 'Alamat Cc' });
      await cc.fill('dewi.keuangan@hartono-group.co.id bukan-email');
      await cc.press('Enter');
      await page.getByRole('textbox', { name: 'Tulis balasan' }).fill('Baik, kami tembuskan.');
      await page.getByRole('button', { name: 'Kirim', exact: true }).click();
      await page.getByText('belum jadi alamat', { exact: false }).waitFor();
      await settle(page);
    },
  },
  {
    // Galat Bcc: alamat channel sendiri ditolak — hanya kotak Bcc yang merah.
    name: 'bcc-galat',
    path: `/inbox?chat=${EMAIL_CC_CONVERSATION.id}`,
    before: multiChannelInbox,
    waitFor: 'text=Re: Tagihan November tidak bisa dibuka',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tambah Cc atau Bcc' }).click();
      const bcc = page.getByRole('textbox', { name: 'Alamat Bcc' });
      await bcc.fill('billing@majujaya.co.id');
      await bcc.press('Enter');
      await page.getByText('Alamat channel ini sendiri', { exact: false }).waitFor();
      await settle(page);
    },
  },
  {
    // Keyboard HP terbuka (tinggi layar 58%): CS mengisi Bcc baru setelah Balas semua.
    name: 'keyboard-hp',
    path: `/inbox?chat=${EMAIL_CC_CONVERSATION.id}`,
    before: async (page) => {
      await sessionAs(page, 'cs');
      await multiChannelInbox(page);
    },
    waitFor: 'text=Re: Tagihan November tidak bisa dibuka',
    prepare: async (page) => {
      const viewport = page.viewportSize();
      if (viewport) {
        await page.setViewportSize({
          width: viewport.width,
          height: Math.round(viewport.height * 0.58),
        });
      }
      await page.getByRole('button', { name: /^Balas semua/ }).click();
      const bcc = page.getByRole('textbox', { name: 'Alamat Bcc' });
      await bcc.fill('pajak@konsultan-pajak.co.id');
      await bcc.press('Enter');
      await page.getByRole('textbox', { name: 'Tulis balasan' }).fill('Baik Pak Rudi.');
      await bcc.focus();
      await settle(page);
    },
  },
  {
    name: 'jam-kerja',
    path: '/pengaturan/jam-kerja',
    before: (page) => workspaceMocks(page),
    waitFor: 'text=Jam kerja tim',
    prepare: settle,
    tall: true,
  },
  {
    name: 'jam-kerja-konfirmasi',
    path: '/pengaturan/jam-kerja',
    before: (page) => workspaceMocks(page),
    waitFor: 'text=Pesan otomatis',
    prepare: async (page) => {
      const form = page.getByRole('form', { name: 'Pesan otomatis' });
      await form.getByLabel('Kirim pesan "Saat ditangani agen"').check();
      await form.getByRole('button', { name: 'Simpan' }).click();
      await page.getByRole('dialog', { name: 'Simpan pesan otomatis?' }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'inbox-tersedia',
    path: '/inbox',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await multiChannelInbox(page);
    },
    waitFor: 'text=Andika Pratama',
    prepare: settle,
  },
];
