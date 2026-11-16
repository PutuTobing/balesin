import { readFileSync } from 'node:fs';
import type { Page, Route, WebSocketRoute } from '@playwright/test';
import { apiError, json } from './mocks';

/**
 * Jawaban API tiruan untuk layar Inbox (Fase 2 butir 5): daftar percakapan beragam keadaan, hitungan
 * per tab, ruang chat dengan semua jenis pesan, dan WebSocket yang hanya menjawab `hello`. Bentuknya
 * mengikuti `packages/shared/src/inbox.ts`. Semua data fiktif.
 */
const API = '**/api/v1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const CHANNEL = {
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
  name: 'CS Maju Jaya',
  type: 'whatsapp',
};
const CHANNEL_BILLING = {
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02',
  name: 'Tagihan',
  type: 'whatsapp',
};

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Status = 'bot' | 'unserved' | 'served' | 'resolved';

interface PhotoConversationInit {
  n: number;
  name: string;
  phone: string | null;
  status: Status;
  unread?: number;
  lastAgo: number;
  /** Sisa jendela (ms); negatif = sudah habis; `null` = belum pernah ada pesan masuk. */
  window: number | null;
  last: { direction: 'inbound' | 'outbound'; type?: string; text: string | null; status?: string };
  assignee?: string;
  channel?: typeof CHANNEL;
  /** Asal nama: bawaan `none` untuk nomor, selain itu `whatsapp` (nama profil pelanggan). */
  source?: 'team' | 'whatsapp' | 'none';
  username?: string;
}

function conversation(init: PhotoConversationInit) {
  return {
    id: id('c1a2b3c4', init.n),
    number: 100 + init.n,
    status: init.status,
    channel: init.channel ?? CHANNEL,
    contact: {
      id: id('d1a2b3c4', init.n),
      number: 200 + init.n,
      displayName: init.name,
      nameSource: init.source ?? (init.name.startsWith('+') ? 'none' : 'whatsapp'),
      phone: init.phone,
      waUsername: init.username ?? null,
    },
    assignee: init.assignee ? { id: id('a1a2b3c4', init.n), name: init.assignee } : null,
    unreadCount: init.unread ?? 0,
    lastMessageAt: ago(init.lastAgo),
    lastInboundAt: init.window === null ? null : ago(24 * HOUR - init.window),
    windowExpiresAt: init.window === null ? null : inFuture(init.window),
    windowOpen: init.window !== null && init.window > 0,
    lastMessage: {
      direction: init.last.direction,
      type: init.last.type ?? 'text',
      text: init.last.text,
      status: init.last.direction === 'outbound' ? (init.last.status ?? 'delivered') : null,
      createdAt: ago(init.lastAgo),
    },
    createdAt: ago(init.lastAgo + 2 * HOUR),
    resolvedAt: init.status === 'resolved' ? ago(init.lastAgo) : null,
    firstAssignedAt: init.assignee ? ago(init.lastAgo + HOUR) : null,
    firstResponseAt: null,
  };
}

/** Agen contoh (nama pengirim pesan keluar). */
const AGENT_CITRA = 'a1a2b3c4-0000-4000-8000-0000000000c1';
const AGENTS = [
  { id: AGENT_CITRA, name: 'Citra', role: 'cs', active: true, openConversations: 4 },
  {
    id: 'a1a2b3c4-0000-4000-8000-0000000000a9',
    name: 'Agus',
    role: 'teknisi',
    active: true,
    openConversations: 2,
  },
];

/** Gambar contoh untuk media (ilustrasi aplikasi sendiri, bukan foto pelanggan). */
const SAMPLE_IMAGE = readFileSync(
  new URL('../../apps/web/src/assets/illustrations/login-hero-768.webp', import.meta.url),
);

export const PHOTO_CONVERSATIONS = [
  conversation({
    n: 1,
    name: 'Budi Santoso',
    phone: '+6281234567890',
    status: 'unserved',
    unread: 3,
    lastAgo: 2 * MINUTE,
    window: 23 * HOUR + 58 * MINUTE,
    last: {
      direction: 'inbound',
      text: 'Kak, internet di rumah mati sejak pagi. Lampu LOS merah.',
    },
  }),
  conversation({
    n: 2,
    name: 'ID0412+SITI AMINAH@KEDATON',
    source: 'team',
    phone: '+6285267001122',
    status: 'served',
    assignee: 'Citra',
    unread: 1,
    lastAgo: 14 * MINUTE,
    window: HOUR + 12 * MINUTE,
    last: { direction: 'inbound', type: 'image', text: 'Bukti transfer bulan November' },
  }),
  conversation({
    n: 3,
    name: 'Rahmat Hidayat',
    source: 'team',
    phone: '+6281377889900',
    status: 'served',
    assignee: 'Agus',
    lastAgo: 42 * MINUTE,
    window: 21 * HOUR,
    last: {
      direction: 'outbound',
      text: 'Baik kak, teknisi kami meluncur jam 2 siang ya.',
      status: 'read',
    },
  }),
  conversation({
    n: 4,
    name: 'Dewi Lestari Ningsih Kusumawardhani Putri',
    phone: '+6282199001234',
    status: 'unserved',
    unread: 12,
    lastAgo: 3 * HOUR,
    window: 38 * MINUTE,
    last: { direction: 'inbound', type: 'document', text: null },
  }),
  conversation({
    n: 5,
    name: 'Kopi Senja Way Halim',
    phone: '+6281122334455',
    status: 'bot',
    lastAgo: 5 * HOUR,
    window: 19 * HOUR,
    last: {
      direction: 'outbound',
      text: 'Pilih menu: 1. Cek tagihan 2. Lapor gangguan',
      status: 'delivered',
    },
  }),
  conversation({
    n: 6,
    name: '+6289876543210',
    phone: '+6289876543210',
    status: 'served',
    assignee: 'Citra',
    lastAgo: 26 * HOUR,
    window: -2 * HOUR,
    last: { direction: 'inbound', type: 'audio', text: null },
    channel: CHANNEL_BILLING,
  }),
  conversation({
    n: 7,
    name: 'Yohanes Siregar',
    source: 'team',
    phone: '+6281299998888',
    status: 'resolved',
    assignee: 'Agus',
    lastAgo: 3 * 24 * HOUR,
    window: -50 * HOUR,
    last: { direction: 'outbound', text: 'Terima kasih sudah menghubungi kami 🙏', status: 'read' },
  }),
  conversation({
    n: 8,
    name: 'Pelanggan Promo Desember',
    phone: '+6281355556666',
    status: 'served',
    assignee: 'Rina Kartika',
    lastAgo: 9 * 24 * HOUR,
    window: null,
    last: {
      direction: 'outbound',
      text: 'Promo upgrade 50 Mbps khusus bulan ini!',
      status: 'failed',
    },
    channel: CHANNEL_BILLING,
  }),
];

export const PHOTO_CHAT = PHOTO_CONVERSATIONS[0]!;

const COUNTS = {
  counts: { all: 128, bot: 4, unserved: 12, served: 37, resolved: 75 },
  unreadOpen: 9,
};

const STATUS_FOR_TAB: Record<string, Status> = {
  bot: 'bot',
  unserved: 'unserved',
  served: 'served',
  resolved: 'resolved',
};

function message(n: number, init: Record<string, unknown>) {
  return {
    id: id('e1a2b3c4', n),
    number: n,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: null,
    text: null,
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
    createdAt: ago(0),
    ...init,
  };
}

const media = (kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  mimeType: null,
  filename: null,
  voice: false,
  animated: false,
  ...extra,
});

/** Riwayat chat contoh (lama → baru), dua hari, semua jenis pesan. */
export const PHOTO_MESSAGES = [
  message(1, {
    text: 'Halo kak, saya mau tanya paket internet rumah',
    referral: {
      sourceType: 'ad',
      sourceUrl: 'https://fb.me/promo-maju-jaya-50mbps?utm=iklan',
      headline: 'Internet 50 Mbps mulai 199 ribu',
      body: 'Gratis pasang untuk 100 pelanggan pertama.',
    },
    createdAt: ago(26 * HOUR),
  }),
  message(2, {
    direction: 'outbound',
    senderKind: 'bot',
    type: 'interactive',
    text: 'Silakan pilih kebutuhan kakak:',
    status: 'read',
    createdAt: ago(26 * HOUR - MINUTE),
  }),
  message(3, {
    type: 'interactive',
    text: null,
    interactive: {
      kind: 'list_reply',
      id: 'gangguan',
      title: 'Lapor gangguan',
      description: 'Internet mati atau lambat',
    },
    createdAt: ago(26 * HOUR - 2 * MINUTE),
  }),
  message(4, {
    type: 'location',
    location: {
      latitude: -5.39714,
      longitude: 105.26679,
      name: 'Rumah',
      address: 'Jl. Pahlawan No. 12, Kedaton',
    },
    createdAt: ago(26 * HOUR - 3 * MINUTE),
  }),
  message(5, {
    direction: 'outbound',
    senderKind: 'agent',
    senderUserId: AGENT_CITRA,
    text: 'Baik kak Budi, kami cek dulu jaringannya ya. Mohon ditunggu sebentar.',
    status: 'read',
    createdAt: ago(25 * HOUR),
  }),
  message(6, { type: 'system', text: 'Pelanggan mengganti nomornya.', createdAt: ago(3 * HOUR) }),
  message(7, {
    type: 'image',
    text: 'Lampu LOS merah dari pagi',
    media: media('image', { mimeType: 'image/jpeg' }),
    mediaAvailable: true,
    createdAt: ago(40 * MINUTE),
  }),
  message(8, {
    type: 'document',
    mediaAvailable: true,
    media: media('document', {
      mimeType: 'application/pdf',
      filename: 'tagihan-november-2026.pdf',
    }),
    createdAt: ago(38 * MINUTE),
  }),
  message(9, {
    type: 'audio',
    mediaAvailable: true,
    media: media('audio', { mimeType: 'audio/ogg', voice: true }),
    createdAt: ago(36 * MINUTE),
  }),
  message(10, {
    direction: 'outbound',
    senderKind: 'agent',
    senderUserId: AGENT_CITRA,
    text: 'Sudah kami terima kak. Tim teknisi dijadwalkan datang hari ini.',
    status: 'delivered',
    replyTo: { messageId: id('e1a2b3c4', 7) },
    createdAt: ago(20 * MINUTE),
  }),
  message(11, {
    type: 'reaction',
    reaction: { emoji: '🙏', messageId: id('e1a2b3c4', 10) },
    createdAt: ago(19 * MINUTE),
  }),
  message(12, {
    type: 'sticker',
    media: media('sticker', { mimeType: 'image/webp' }),
    createdAt: ago(18 * MINUTE),
  }),
  message(13, { type: 'contacts', sharedContactsCount: 2, createdAt: ago(10 * MINUTE) }),
  message(14, { type: 'unsupported', rawType: 'order', createdAt: ago(8 * MINUTE) }),
  message(15, {
    direction: 'outbound',
    senderKind: 'broadcast',
    text: 'Pengingat: tagihan bulan ini jatuh tempo tanggal 20.',
    status: 'failed',
    errorCode: 131047,
    failure: {
      reason: 'window_closed',
      code: 131047,
      message: 'Sesi 24 jam sudah habis. Pelanggan perlu membalas dulu, atau kirim template.',
      retryable: false,
    },
    createdAt: ago(6 * MINUTE),
  }),
  message(16, {
    forwarded: true,
    text: 'Info dari grup RT: listrik padam jam 10–12 hari ini.',
    createdAt: ago(4 * MINUTE),
  }),
  message(17, {
    text: 'Kak, internet di rumah mati sejak pagi. Lampu LOS merah.',
    createdAt: ago(2 * MINUTE),
  }),
];

const PHOTO_CONTACT = {
  id: PHOTO_CHAT.contact.id,
  number: PHOTO_CHAT.contact.number,
  displayName: 'Budi Santoso',
  nameSource: 'whatsapp',
  phone: '+6281234567890',
  channelType: 'whatsapp',
  name: null,
  profileName: 'Budi Santoso',
  waUsername: 'budi.s',
  createdAt: ago(40 * 24 * HOUR),
  updatedAt: ago(2 * MINUTE),
};

export interface InboxMockOptions {
  conversations?: typeof PHOTO_CONVERSATIONS;
  counts?: typeof COUNTS;
  /** Jawaban untuk pencarian (`q`): bawaan saring nama. */
  search?: (route: Route) => Promise<void>;
  /** Jawaban detail percakapan: bawaan dari daftar. */
  conversation?: (route: Route) => Promise<void>;
  /** Jawaban riwayat pesan. */
  messages?: (route: Route) => Promise<void>;
  /** Jawaban daftar (tanpa `q`). */
  list?: (route: Route) => Promise<void>;
  /** Akses ke WebSocket tiruan (mis. mengirim `message.created` saat foto disiapkan). */
  onSocket?: (socket: WebSocketRoute) => void;
  /** Jawaban kirim pesan (bawaan 202 `pending`). */
  send?: (route: Route) => Promise<void>;
  /** Rem darurat sedang ditarik (pengaturan batas kirim, terlihat oleh Owner/Admin). */
  paused?: boolean;
}

/** Pasang semua jawaban tiruan inbox + WebSocket diam (hanya `hello`). */
export async function inboxMocks(page: Page, options: InboxMockOptions = {}): Promise<void> {
  const conversations = options.conversations ?? PHOTO_CONVERSATIONS;
  await page.routeWebSocket('**/api/v1/inbox/stream', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', heartbeatSeconds: 30 }));
    options.onSocket?.(ws);
  });
  await page.route(`${API}/channels`, (route) =>
    json(route, {
      channels: [
        { ...CHANNEL, enabled: true, displayPhoneNumber: '+62 811-7200-345' },
        { ...CHANNEL_BILLING, enabled: true, displayPhoneNumber: '+62 811-7200-346' },
      ],
    }),
  );
  const select = (query: URLSearchParams) => {
    const q = query.get('q');
    const status = query.get('status');
    const window = query.get('window');
    const now = Date.now();
    return conversations.filter((item) => {
      if (status && item.status !== STATUS_FOR_TAB[status]) return false;
      if (q && !item.contact.displayName.toLowerCase().includes(q.toLowerCase())) return false;
      if (query.get('unread') === 'true' && item.unreadCount === 0) return false;
      if (query.get('channelId') && item.channel.id !== query.get('channelId')) return false;
      if (window) {
        const end = item.windowExpiresAt ? Date.parse(item.windowExpiresAt) - now : null;
        const kind =
          end === null ? 'none' : end <= 0 ? 'expired' : end <= 2 * HOUR ? 'expiring' : 'open';
        if (kind !== window) return false;
      }
      return true;
    });
  };
  await page.route(/\/api\/v1\/conversations\/counts(\?|$)/, (route) => {
    if (options.counts) return json(route, options.counts);
    const query = new URL(route.request().url()).searchParams;
    // Tanpa saringan: angka contoh inbox yang ramai. Dengan saringan: dihitung dari data tiruan.
    if ([...query.keys()].length === 0) return json(route, COUNTS);
    const rows = select(query);
    const count = (status: Status) => rows.filter((item) => item.status === status).length;
    return json(route, {
      counts: {
        all: rows.length,
        bot: count('bot'),
        unserved: count('unserved'),
        served: count('served'),
        resolved: count('resolved'),
      },
      unreadOpen: rows.filter((item) => item.status !== 'resolved' && item.unreadCount > 0).length,
    });
  });
  await page.route(/\/api\/v1\/conversations(\?|$)/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const q = query.get('q');
    if (q && options.search) return options.search(route);
    if (!q && options.list) return options.list(route);
    return json(route, { conversations: select(query), nextCursor: null });
  });
  await page.route(/\/api\/v1\/conversations\/[0-9a-f-]{36}$/, (route) => {
    if (options.conversation) return options.conversation(route);
    const conversationId = new URL(route.request().url()).pathname.split('/').at(-1);
    const found = conversations.find((item) => item.id === conversationId);
    return found
      ? json(route, { conversation: found })
      : apiError(route, 404, 'NOT_FOUND', 'Data tidak ditemukan.');
  });
  await page.route(/\/api\/v1\/conversations\/[0-9a-f-]{36}\/messages/, (route) => {
    if (route.request().method() === 'POST') {
      if (options.send) return options.send(route);
      const body = route.request().postDataJSON() as { text?: string; caption?: string };
      return json(
        route,
        {
          message: message(900, {
            id: 'e1a2b3c4-0000-4000-8000-000000000900',
            direction: 'outbound',
            senderKind: 'agent',
            text: body.text ?? body.caption ?? null,
            status: 'pending',
            createdAt: new Date().toISOString(),
          }),
        },
        202,
      );
    }
    if (options.messages) return options.messages(route);
    const conversationId = new URL(route.request().url()).pathname.split('/').at(-2);
    const rows = conversationId === PHOTO_CHAT.id ? PHOTO_MESSAGES : PHOTO_MESSAGES.slice(-3);
    return json(route, { messages: [...rows].reverse(), nextCursor: null });
  });
  await page.route(`${API}/inbox/agents`, (route) => json(route, { agents: AGENTS }));
  await page.route(`${API}/settings/sending-limits`, (route) =>
    json(route, {
      limits: {
        dailyPerUser: 500,
        dailyPerOrganization: 5000,
        perConversationPerMinute: 20,
        paused: options.paused
          ? { at: ago(10 * MINUTE), by: { id: AGENT_CITRA, name: 'Rina Kartika' }, reason: null }
          : null,
        sentLast24Hours: 128,
      },
    }),
  );
  await page.route(/\/api\/v1\/messages\/[0-9a-f-]{36}\/media$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/webp',
      headers: { 'content-disposition': `attachment; filename*=UTF-8''tagihan-november-2026.pdf` },
      body: SAMPLE_IMAGE,
    }),
  );
  await page.route(/\/api\/v1\/conversations\/[0-9a-f-]{36}\/(claim|media)$/, (route) => {
    const url = new URL(route.request().url());
    const conversationId = url.pathname.split('/').at(-2);
    const found = conversations.find((item) => item.id === conversationId);
    if (url.pathname.endsWith('/media')) {
      return json(
        route,
        {
          media: {
            id: 'b1a2b3c4-0000-4000-8000-000000000001',
            kind: 'image',
            mimeType: 'image/jpeg',
            filename: 'foto.jpg',
            sizeBytes: 182_000,
          },
        },
        201,
      );
    }
    return json(route, {
      conversation: found
        ? { ...found, status: 'served', assignee: { id: AGENT_CITRA, name: 'Rina Kartika' } }
        : null,
    });
  });
  await page.route(/\/api\/v1\/conversations\/[0-9a-f-]{36}\/read$/, (route) => {
    const conversationId = new URL(route.request().url()).pathname.split('/').at(-2);
    const found = conversations.find((item) => item.id === conversationId);
    return found
      ? json(route, { conversation: { ...found, unreadCount: 0 } })
      : apiError(route, 404, 'NOT_FOUND', 'Data tidak ditemukan.');
  });
  await page.route(/\/api\/v1\/contacts\/[0-9a-f-]{36}$/, (route) => {
    const contactId = new URL(route.request().url()).pathname.split('/').at(-1);
    const found = conversations.find((item) => item.contact.id === contactId);
    if (!found) return apiError(route, 404, 'NOT_FOUND', 'Data tidak ditemukan.');
    return json(route, {
      contact:
        found.id === PHOTO_CHAT.id
          ? PHOTO_CONTACT
          : {
              ...PHOTO_CONTACT,
              id: found.contact.id,
              displayName: found.contact.displayName,
              nameSource: found.contact.nameSource,
              phone: found.contact.phone,
              // Kontak tanpa nama (hanya nomor): `name` null seperti data sungguhan.
              name: found.contact.nameSource === 'team' ? found.contact.displayName : null,
              profileName:
                found.contact.nameSource === 'whatsapp' ? found.contact.displayName : null,
              waUsername: found.contact.waUsername,
            },
    });
  });
}

/** Pesan masuk baru untuk foto "Ada pesan baru" (dikirim lewat WebSocket tiruan). */
export const PHOTO_NEW_MESSAGE = message(18, {
  text: 'Kak, sekarang lampunya kedip-kedip merah. Perlu saya restart?',
  createdAt: new Date().toISOString(),
});

/** Mock riwayat yang bisa ditambah pesan baru (lihat layar `inbox-pesan-baru`). */
export function growingMessages() {
  const rows = [...PHOTO_MESSAGES];
  return {
    add: (row: (typeof PHOTO_MESSAGES)[number]) => rows.push(row),
    handler: (route: Route) => json(route, { messages: [...rows].reverse(), nextCursor: null }),
  };
}
