import type { Page, Route } from '@playwright/test';
import { apiError, json, sessionAs } from './mocks';
import { PHOTO_TAGS } from './mocks-inbox';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 5: Kontak (daftar, detail + gabung, impor), Pengaturan → Atribut kontak / Departemen / CSAT,
 * Tiket (Kanban, Daftar, detail, atur board), Laporan (kinerja, biaya Meta, kinerja saya, gagal).
 * Data tiruan = bentuk skema bersama.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Rute API dengan atau tanpa query string. */
const api = (path: string) => new RegExp(`/api/v1${path.replace(/[$]/g, '\\$')}(\\?.*)?$`);

const CHANNEL = { id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', name: 'CS Maju Jaya' };
const CHANNEL_2 = { id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', name: 'Teknis Maju Jaya' };
const AGUS = { id: 'a1a2b3c4-0000-4000-8000-0000000000a2', name: 'Agus Saputra' };
const SARI = { id: 'a1a2b3c4-0000-4000-8000-0000000000a3', name: 'Sari Wulandari' };
const RINA = { id: 'a1a2b3c4-0000-4000-8000-0000000000a4', name: 'Rina Kartika' };
const tag = (index: number) => {
  const item = PHOTO_TAGS[index]!;
  return { id: item.id, name: item.name, color: item.color };
};

// ── Kontak ──────────────────────────────────────────────────────────────────

function contact(n: number, init: Record<string, unknown>) {
  return {
    id: id('c0', n),
    number: 100 + n,
    displayName: 'Kontak',
    nameSource: 'team',
    phone: `+62812${String(30_000_000 + n * 7919)}`,
    waUsername: null,
    channelHandle: null,
    channelType: 'whatsapp',
    tags: [],
    name: null,
    profileName: null,
    email: null,
    notes: null,
    attributes: [],
    possibleDuplicateOfContactId: null,
    createdAt: ago(n * 2 * DAY),
    updatedAt: ago(n * DAY),
    ...init,
  };
}

const OLD_BUDI = contact(9, {
  displayName: 'Budi Santoso',
  name: 'Budi Santoso',
  phone: null,
  email: 'budi.santoso@gmail.com',
  tags: [tag(1)],
  attributes: [
    { key: 'paket', value: '50 Mbps' },
    { key: 'id_pelanggan', value: 'MJ-20431' },
  ],
  createdAt: ago(240 * DAY),
});
const CONTACTS = [
  contact(1, {
    displayName: 'Budi Santoso',
    nameSource: 'whatsapp',
    profileName: 'Budi Santoso',
    possibleDuplicateOfContactId: OLD_BUDI.id,
    tags: [tag(5)],
    attributes: [{ key: 'kota', value: 'Denpasar' }],
  }),
  contact(2, {
    displayName: 'Ni Kadek Ayu Lestari',
    name: 'Ni Kadek Ayu Lestari',
    tags: [tag(0), tag(1)],
    attributes: [{ key: 'paket', value: '100 Mbps' }],
  }),
  contact(3, { displayName: 'CV Sinar Abadi', name: 'CV Sinar Abadi', tags: [tag(4), tag(3)] }),
  contact(4, {
    displayName: 'Wayan Sudarma',
    nameSource: 'whatsapp',
    profileName: 'Wayan Sudarma',
    tags: [tag(2)],
  }),
  contact(5, {
    displayName: '+6281338014422',
    nameSource: 'none',
    name: null,
    phone: '+6281338014422',
  }),
  contact(6, {
    displayName: 'Putu Ardana',
    name: 'Putu Ardana',
    tags: [tag(1), tag(0), tag(6), tag(5)],
  }),
  contact(7, {
    displayName: 'Gede Mahendra',
    channelType: 'telegram',
    phone: null,
    channelHandle: '@gedemahendra',
    nameSource: 'channel',
  }),
  OLD_BUDI,
];

const ATTRIBUTES = [
  {
    id: id('a7', 1),
    key: 'paket',
    label: 'Paket langganan',
    type: 'select',
    required: true,
    options: ['20 Mbps', '50 Mbps', '100 Mbps'],
    position: 0,
  },
  {
    id: id('a7', 2),
    key: 'id_pelanggan',
    label: 'ID pelanggan',
    type: 'text',
    required: true,
    options: [],
    position: 1,
  },
  {
    id: id('a7', 3),
    key: 'tanggal_pasang',
    label: 'Tanggal pasang',
    type: 'date',
    required: false,
    options: [],
    position: 2,
  },
  {
    id: id('a7', 4),
    key: 'tagihan',
    label: 'Tagihan bulanan',
    type: 'number',
    required: false,
    options: [],
    position: 3,
  },
].map((item) => ({ ...item, createdAt: ago(20 * DAY), updatedAt: ago(20 * DAY) }));

async function crmMocks(page: Page, contacts: unknown[] = CONTACTS): Promise<void> {
  await quietSecurity(page);
  await page.route(api('/contacts'), (route) => json(route, { contacts, nextCursor: 'kursor-2' }));
  await page.route(api('/contact-attributes'), (route) => json(route, { attributes: ATTRIBUTES }));
  await page.route(api('/tags'), (route) => json(route, { tags: PHOTO_TAGS }));
  for (const item of [...CONTACTS] as { id: string }[]) {
    await page.route(api(`/contacts/${item.id}`), (route) => json(route, { contact: item }));
  }
  await page.route(api('/tickets'), (route) =>
    json(route, { tickets: [TICKETS[0], TICKETS[4]], nextCursor: null }),
  );
}

// ── Tiket ───────────────────────────────────────────────────────────────────

const BOARD_ID = id('b0', 1);
const COLUMNS = [
  { id: id('c1', 1), name: 'Baru', position: 0, isDone: false },
  { id: id('c1', 2), name: 'Dijadwalkan', position: 1, isDone: false },
  { id: id('c1', 3), name: 'Dikerjakan', position: 2, isDone: false },
  { id: id('c1', 4), name: 'Selesai', position: 3, isDone: true },
];
const BOARD = {
  id: BOARD_ID,
  name: 'Gangguan jaringan',
  description: 'Laporan gangguan pelanggan rumahan dan bisnis.',
  department: { id: id('d0', 2), name: 'Teknisi' },
  position: 0,
  columns: COLUMNS,
  attributes: [
    {
      id: id('a8', 1),
      key: 'odp',
      label: 'ODP',
      type: 'text',
      required: true,
      options: [],
      position: 0,
      createdAt: ago(9 * DAY),
      updatedAt: ago(9 * DAY),
    },
    {
      id: id('a8', 2),
      key: 'penyebab',
      label: 'Penyebab',
      type: 'select',
      required: false,
      options: ['Kabel putus', 'Perangkat rusak', 'Gangguan pusat'],
      position: 1,
      createdAt: ago(9 * DAY),
      updatedAt: ago(9 * DAY),
    },
  ],
  archivedAt: null,
  createdAt: ago(30 * DAY),
  updatedAt: ago(DAY),
};
const BOARDS = [
  BOARD,
  {
    ...BOARD,
    id: id('b0', 2),
    name: 'Pemasangan baru',
    description: null,
    department: null,
    attributes: [],
  },
];

function ticket(n: number, column: number, init: Record<string, unknown>) {
  return {
    id: id('7d', n),
    number: 240 + n,
    boardId: BOARD_ID,
    column: COLUMNS[column],
    title: 'Tiket',
    description: null,
    priority: 'normal',
    assignee: null,
    dueAt: null,
    overdue: false,
    contact: null,
    conversation: null,
    attributes: [],
    position: n,
    closedAt: null,
    createdBy: { kind: 'user', id: SARI.id, name: SARI.name },
    createdAt: ago(n * 5 * HOUR),
    updatedAt: ago(n * 2 * HOUR),
    ...init,
  };
}
const summary = (item: { id: string; displayName: string; phone: string | null }) => ({
  id: item.id,
  number: 101,
  displayName: item.displayName,
  nameSource: 'team',
  phone: item.phone,
  waUsername: null,
  channelHandle: null,
  tags: [],
});
const TICKETS = [
  ticket(1, 0, {
    title: 'Internet putus sejak pagi, lampu LOS merah',
    priority: 'urgent',
    assignee: AGUS,
    dueAt: inFuture(3 * HOUR),
    contact: summary(CONTACTS[1] as never),
    description:
      'Pelanggan melaporkan internet mati total sejak pukul 07.00. Lampu LOS di ONT menyala merah. Sudah dicoba restart ONT, belum pulih.',
    attributes: [{ key: 'odp', value: 'ODP-DPS-12/07' }],
    conversation: { id: id('cc', 1), number: 512, status: 'served' },
  }),
  ticket(2, 0, {
    title: 'Wi-Fi lambat di lantai 2',
    priority: 'normal',
    contact: summary(CONTACTS[2] as never),
  }),
  ticket(3, 1, {
    title: 'Ganti ONT rusak — Jl. Teuku Umar 18',
    priority: 'high',
    assignee: AGUS,
    dueAt: ago(5 * HOUR),
    overdue: true,
    contact: summary(CONTACTS[3] as never),
  }),
  ticket(4, 1, {
    title: 'Survei ulang jalur kabel Banjar Tegal',
    assignee: RINA,
    dueAt: inFuture(2 * DAY),
  }),
  ticket(5, 2, {
    title: 'Penarikan kabel baru ke ruko',
    priority: 'high',
    assignee: AGUS,
    contact: summary(CONTACTS[5] as never),
  }),
  ticket(6, 3, {
    title: 'Reset password Wi-Fi pelanggan',
    priority: 'low',
    assignee: SARI,
    closedAt: ago(HOUR),
  }),
  ticket(7, 3, {
    title: 'Pindah lokasi router ke ruang tamu',
    assignee: AGUS,
    closedAt: ago(3 * HOUR),
  }),
];

function kanban() {
  return {
    board: BOARD,
    columns: COLUMNS.map((column) => {
      const tickets = TICKETS.filter((item) => item.column?.id === column.id);
      return { column, total: column.isDone ? tickets.length + 23 : tickets.length, tickets };
    }),
  };
}

async function ticketMocks(page: Page, boards: unknown[] = BOARDS): Promise<void> {
  await quietSecurity(page);
  await page.route(api('/ticket-boards'), (route) => json(route, { boards }));
  await page.route(api(`/ticket-boards/${BOARD_ID}/kanban`), (route) => json(route, kanban()));
  await page.route(api('/tickets'), (route) =>
    json(route, { tickets: TICKETS.filter((item) => !item.column?.isDone), nextCursor: null }),
  );
  await page.route(api(`/tickets/${TICKETS[0]!.id}`), (route) =>
    json(route, { ticket: TICKETS[0] }),
  );
  await page.route(api(`/tickets/${TICKETS[0]!.id}/comments`), (route) =>
    json(route, {
      comments: [
        {
          id: id('c2', 1),
          body: 'Sudah dicek dari NOC: ODP-DPS-12/07 normal. Kemungkinan kabel drop putus.',
          author: { kind: 'user', id: SARI.id, name: SARI.name },
          createdAt: ago(4 * HOUR),
        },
        {
          id: id('c2', 2),
          body: 'Berangkat ke lokasi jam 10.',
          author: { kind: 'user', id: AGUS.id, name: AGUS.name },
          createdAt: ago(2 * HOUR),
        },
      ],
    }),
  );
  await page.route(api(`/tickets/${TICKETS[0]!.id}/events`), (route) =>
    json(route, {
      events: [
        {
          id: id('e1', 1),
          kind: 'created',
          actor: { kind: 'user', id: SARI.id, name: SARI.name },
          fields: null,
          fromColumn: null,
          toColumn: null,
          assignee: null,
          previousAssignee: null,
          createdAt: ago(5 * HOUR),
        },
        {
          id: id('e1', 2),
          kind: 'assigned',
          actor: { kind: 'user', id: SARI.id, name: SARI.name },
          fields: null,
          fromColumn: null,
          toColumn: null,
          assignee: AGUS,
          previousAssignee: null,
          createdAt: ago(4 * HOUR),
        },
      ],
    }),
  );
  await page.route(api('/inbox/agents'), (route) =>
    json(route, {
      agents: [AGUS, SARI, RINA].map((agent) => ({
        ...agent,
        role: 'cs',
        active: true,
        openConversations: 3,
      })),
    }),
  );
  await page.route(api('/departments'), (route) =>
    json(route, {
      departments: DEPARTMENTS.map(({ id: key, name, description, memberCount }) => ({
        id: key,
        name,
        description,
        memberCount,
      })),
    }),
  );
}

// ── Departemen ──────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  {
    id: id('d0', 1),
    name: 'Customer Service',
    description: 'Pertanyaan tagihan, paket, dan administrasi.',
    memberCount: 3,
    members: [
      { id: SARI.id, name: SARI.name, role: 'supervisor', restricted: false },
      { id: RINA.id, name: RINA.name, role: 'cs', restricted: true },
      { id: id('a1', 9), name: 'Made Wirawan', role: 'cs', restricted: true },
    ],
    defaultChannelIds: [CHANNEL.id],
    teamHours: null,
  },
  {
    id: id('d0', 2),
    name: 'Teknisi',
    description: 'Gangguan jaringan dan kunjungan lapangan.',
    memberCount: 1,
    members: [{ id: AGUS.id, name: AGUS.name, role: 'teknisi', restricted: false }],
    defaultChannelIds: [CHANNEL_2.id],
    teamHours: {
      mode: 'schedule',
      windows: [1, 2, 3, 4, 5]
        .map((day) => ({ day, start: '08:00', end: '20:00' }))
        .concat([{ day: 6, start: '08:00', end: '14:00' }]),
    },
  },
].map((item) => ({ ...item, createdAt: ago(40 * DAY), updatedAt: ago(DAY) }));

async function departmentMocks(page: Page): Promise<void> {
  await quietSecurity(page);
  await page.route(api('/settings/departments'), (route) =>
    json(route, { departments: DEPARTMENTS }),
  );
  await page.route(api('/channels'), (route) =>
    json(route, {
      channels: [CHANNEL, CHANNEL_2].map((channel) => ({
        ...channel,
        type: 'whatsapp',
        enabled: true,
        displayPhoneNumber: '+62 811-0000-1111',
      })),
    }),
  );
}

// ── Laporan ─────────────────────────────────────────────────────────────────

const stats = (median: number) => ({
  count: 40,
  averageSeconds: median * 1.6,
  medianSeconds: median,
  p90Seconds: median * 4,
});
const csat = {
  sent: 186,
  responses: 121,
  average: 4.4,
  distribution: { '1': 4, '2': 6, '3': 11, '4': 31, '5': 69 },
  responseRate: 65,
};

function report(scope: 'all' | 'own') {
  const days = 7;
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - 1 - index) * DAY).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(date).getUTCDay());
    const conversations = (weekend ? 18 : 42) + ((index * 7) % 13);
    return {
      date,
      conversations,
      resolved: conversations - 3 - (index % 5),
      averageFirstResponseSeconds: 80 + ((index * 17) % 90),
    };
  });
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    conversations:
      hour < 6
        ? hour % 3
        : hour < 9
          ? 12 + hour * 3
          : hour < 17
            ? 38 + ((hour * 11) % 19)
            : 24 - hour,
  }));
  const agent = (
    user: { id: string; name: string },
    role: string,
    handled: number,
    median: number,
  ) => ({
    user: { ...user, role },
    conversationsHandled: handled,
    resolved: handled - 4,
    messagesSent: handled * 7,
    firstResponse: stats(median),
    csat: {
      ...csat,
      sent: handled,
      responses: Math.round(handled * 0.6),
      average: 4.2 + (handled % 7) / 10,
    },
  });
  const agents = [
    agent(SARI, 'supervisor', 148, 72),
    agent(RINA, 'cs', 131, 95),
    agent({ id: id('a1', 9), name: 'Made Wirawan' }, 'cs', 102, 140),
    agent(AGUS, 'teknisi', 26, 410),
  ];
  return {
    range: { from: daily[0]!.date, to: daily[days - 1]!.date, timezone: 'Asia/Jakarta' },
    scope,
    summary:
      scope === 'own'
        ? null
        : {
            conversations: 612,
            customerInitiated: 574,
            resolved: 548,
            resolvedByBotOnly: 133,
            handledByHuman: 402,
            handoffs: 188,
            firstResponse: stats(96),
            wait: stats(48),
            resolution: stats(5400),
          },
    trends: scope === 'own' ? null : { daily, hourly },
    agents: scope === 'own' ? [agent(RINA, 'cs', 131, 95)] : agents,
    bots:
      scope === 'own'
        ? null
        : [
            {
              apiKey: { id: id('a9', 1), name: 'n8n Kak Sky' },
              messagesSent: 1840,
              conversations: 321,
              handoffs: 188,
            },
          ],
    tags:
      scope === 'own'
        ? null
        : [0, 1, 2, 4].map((index, position) => ({
            tag: tag(index),
            conversations: 120 - position * 23,
            resolved: 110 - position * 22,
            resolution: stats(3600 + position * 1800),
          })),
    csat:
      scope === 'own'
        ? {
            ...csat,
            sent: 64,
            responses: 41,
            average: 4.6,
            distribution: { '1': 0, '2': 1, '3': 2, '4': 9, '5': 29 },
            responseRate: 64,
          }
        : csat,
  };
}

const COSTS = {
  month: new Date().toISOString().slice(0, 7),
  timezone: 'Asia/Jakarta',
  currency: 'IDR',
  rateSource:
    'Perkiraan bawaan: tarif Meta untuk nomor Indonesia per 30 Sep 2026. Periksa rate card resmi Meta lalu sesuaikan.',
  total: 1_284_300,
  unknownRate: 4,
  computedAt: ago(10 * 60_000),
  channels: [
    {
      channel: CHANNEL,
      serviceConversations: 1_386,
      freeQuota: 1_000,
      freeRemaining: 0,
      billableService: 386,
      serviceCost: 137_030,
      templates: {
        MARKETING: { sent: 1_250, billable: 1_190, free: 0, cost: 701_100 },
        UTILITY: { sent: 1_420, billable: 1_366, free: 54, cost: 410_370 },
        AUTHENTICATION: { sent: 120, billable: 118, free: 0, cost: 35_800 },
      },
      total: 1_284_300,
    },
  ],
};

async function reportMocks(page: Page, scope: 'all' | 'own' = 'all'): Promise<void> {
  await quietSecurity(page);
  await page.route(api('/reports/performance'), (route) => json(route, { report: report(scope) }));
  await page.route(api('/reports/costs'), (route) => json(route, { costs: COSTS }));
  await page.route(api('/channels'), (route) =>
    json(route, {
      channels: [CHANNEL, CHANNEL_2].map((channel) => ({
        ...channel,
        type: 'whatsapp',
        enabled: true,
        displayPhoneNumber: '+62 811-0000-1111',
      })),
    }),
  );
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

const issueCounts = (counts: Record<string, number>) =>
  Object.fromEntries(
    [
      'phone_missing',
      'phone_invalid',
      'phone_scientific',
      'duplicate',
      'value_too_long',
      'name_invalid',
      'email_invalid',
      'attribute_invalid',
      'attributes_limit',
      'tag_invalid',
      'tags_limit',
      'exists',
    ].map((key) => [key, counts[key] ?? 0]),
  );

export const crmScreens: Screen[] = [
  {
    name: 'kontak-daftar',
    path: '/kontak',
    before: (page) => crmMocks(page),
    waitFor: 'text=Ni Kadek Ayu Lestari',
    prepare: settle,
  },
  {
    name: 'kontak-kosong',
    path: '/kontak',
    before: (page) => crmMocks(page, []),
    waitFor: 'text=Belum ada kontak',
    prepare: settle,
  },
  {
    name: 'kontak-memuat',
    path: '/kontak',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await crmMocks(page);
      await page.route(api('/contacts'), () => undefined);
    },
    waitFor: '[aria-busy="true"]',
  },
  {
    name: 'kontak-detail',
    path: `/kontak/${CONTACTS[0]!.id}`,
    before: async (page) => {
      await crmMocks(page);
      await page.route(api('/tickets'), (route) =>
        json(route, { tickets: [TICKETS[0], TICKETS[5]], nextCursor: null }),
      );
    },
    waitFor: 'text=Kontak ini mungkin duplikat',
    prepare: settle,
  },
  {
    name: 'kontak-gabung',
    path: `/kontak/${CONTACTS[0]!.id}`,
    before: (page) => crmMocks(page),
    waitFor: 'text=Kontak ini mungkin duplikat',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Gabung kontak' }).click();
      await page.getByRole('dialog', { name: 'Gabung dua kontak' }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'kontak-impor',
    path: '/kontak/impor',
    before: async (page) => {
      await crmMocks(page);
      await page.route(api('/contacts/import'), (route) =>
        json(route, {
          dryRun: true,
          sourceRows: 1_248,
          created: 1_102,
          updated: 131,
          unchanged: 7,
          skipped: 8,
          issueCounts: issueCounts({ phone_invalid: 5, duplicate: 2, attribute_invalid: 1 }),
          issues: [
            { row: 14, issue: 'phone_invalid' },
            { row: 87, issue: 'duplicate' },
            { row: 203, issue: 'attribute_invalid', key: 'paket' },
            { row: 411, issue: 'phone_invalid' },
          ],
        }),
      );
    },
    waitFor: 'text=Pilih berkas',
    prepare: async (page) => {
      await page.getByTestId('impor-kontak-berkas').setInputFiles({
        name: 'pelanggan-november.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'No HP,Nama,Email,paket,Tag\n081234567890,Budi,,50 Mbps,Baru\n',
          'utf8',
        ),
      });
      await page.getByText('5 kolom terbaca').waitFor();
      await page.getByRole('button', { name: 'Periksa dulu' }).click();
      await page.getByRole('heading', { name: 'Hasil pemeriksaan' }).waitFor();
      await settle(page);
    },
    fullPage: true,
  },
  {
    name: 'atribut-kontak',
    path: '/pengaturan/atribut-kontak',
    before: (page) => crmMocks(page),
    waitFor: 'text=Paket langganan',
    prepare: settle,
  },
  {
    name: 'atribut-kontak-tambah',
    path: '/pengaturan/atribut-kontak',
    before: (page) => crmMocks(page),
    waitFor: 'text=Paket langganan',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat atribut' }).click();
      const dialog = page.getByRole('dialog', { name: 'Buat atribut' });
      await dialog.getByLabel('Label').fill('Area layanan');
      await dialog.getByLabel('Jenis').selectOption('select');
      await dialog.getByLabel('Pilihan').fill('Denpasar\nBadung\nGianyar');
      await settle(page);
    },
  },
  {
    name: 'tiket-kanban',
    path: '/tiket',
    before: (page) => ticketMocks(page),
    waitFor: 'text=Internet putus sejak pagi, lampu LOS merah',
    prepare: settle,
  },
  {
    name: 'tiket-kanban-pindah',
    path: '/tiket',
    before: (page) => ticketMocks(page),
    waitFor: 'text=Internet putus sejak pagi, lampu LOS merah',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Pindahkan tiket #241 ke kolom lain' }).click();
      await page.getByRole('menuitem', { name: 'Dijadwalkan' }).waitFor();
    },
  },
  {
    name: 'tiket-daftar',
    path: '/tiket?tampilan=daftar',
    before: (page) => ticketMocks(page),
    waitFor: 'text=Wi-Fi lambat di lantai 2',
    prepare: settle,
  },
  {
    name: 'tiket-kosong',
    path: '/tiket',
    before: (page) => ticketMocks(page, []),
    waitFor: 'text=Belum ada board tiket',
    prepare: settle,
  },
  {
    name: 'tiket-detail',
    path: `/tiket/${TICKETS[0]!.id}`,
    before: (page) => ticketMocks(page),
    waitFor: 'text=Berangkat ke lokasi jam 10.',
    prepare: settle,
    fullPage: true,
  },
  {
    name: 'tiket-baru',
    path: '/tiket',
    before: (page) => ticketMocks(page),
    waitFor: 'text=Internet putus sejak pagi, lampu LOS merah',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat tiket' }).click();
      const dialog = page.getByRole('dialog', { name: 'Tiket baru' });
      await dialog.getByLabel('Judul').fill('Kabel drop putus tertimpa dahan');
      await settle(page);
    },
  },
  {
    name: 'tiket-atur-board',
    path: `/tiket/board/${BOARD_ID}`,
    before: (page) => ticketMocks(page),
    waitFor: 'text=Info board',
    prepare: settle,
    fullPage: true,
  },
  {
    name: 'departemen',
    path: '/pengaturan/departemen',
    before: (page) => departmentMocks(page),
    waitFor: 'text=Customer Service',
    prepare: settle,
  },
  {
    name: 'departemen-ubah',
    path: '/pengaturan/departemen',
    before: (page) => departmentMocks(page),
    waitFor: 'text=Customer Service',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ubah Teknisi' }).click();
      await page.getByRole('dialog', { name: 'Ubah departemen Teknisi' }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'laporan-kinerja',
    path: '/laporan',
    before: (page) => reportMocks(page),
    waitFor: 'text=Tren harian',
    prepare: settle,
    fullPage: true,
  },
  {
    name: 'laporan-biaya',
    path: '/laporan',
    before: (page) => reportMocks(page),
    waitFor: 'text=Tren harian',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Biaya Meta' }).click();
      await page.getByText('Total perkiraan').waitFor();
      await settle(page);
    },
    fullPage: true,
  },
  {
    name: 'laporan-saya',
    path: '/laporan',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await reportMocks(page, 'own');
    },
    waitFor: 'text=Ringkasan percakapan yang kamu tangani',
    prepare: settle,
  },
  {
    name: 'laporan-berat',
    path: '/laporan',
    before: async (page) => {
      await reportMocks(page);
      await page.route(api('/reports/performance'), (route: Route) =>
        apiError(route, 503, 'SERVICE_UNAVAILABLE', 'Laporan terlalu berat. Persempit rentang.'),
      );
    },
    waitFor: 'text=Laporan terlalu berat',
    prepare: settle,
  },
  {
    name: 'csat-pengaturan',
    path: '/pengaturan/csat',
    before: async (page) => {
      await quietSecurity(page);
      await page.route(api('/settings/csat'), (route) =>
        json(route, {
          csat: {
            enabled: true,
            question: 'Bagaimana pelayanan kami hari ini? Pilih nilai 1–5 ya.',
            thanks: 'Terima kasih atas penilaianmu! Bila ada saran, tulis saja di sini.',
            minIntervalHours: 24,
            updatedAt: ago(3 * DAY),
          },
        }),
      );
    },
    waitFor: 'text=Pratinjau',
    prepare: settle,
  },
];
