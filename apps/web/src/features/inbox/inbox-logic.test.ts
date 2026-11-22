import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ConversationListResponse, MessageListResponse } from '@balesin/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { fakeConversation, fakeContact, fakeMessage } from '../../test/fake-inbox';
import { FakeSocket } from '../../test/fake-socket';
import { avatarInitials, contactIdentity, formatPhone, summaryIdentity } from './contact-identity';
import {
  activeFilterCount,
  compactParams,
  conversationQueryString,
  filterChips,
  searchTerm,
} from './inbox-filters';
import {
  LIST_REFRESH_DELAY_MS,
  applyInboxEvent,
  flattenMessages,
  forgetConversation,
  inboxKeys,
  retryTransient,
} from './inbox-queries';
import { parseChatId, parseInboxSearch } from './inbox-search';
import { InboxStream, inboxStreamUrl, parseStreamEvent } from './inbox-stream';
import {
  formatDayLabel,
  formatListTime,
  formatRemaining,
  msUntilNextMinute,
  reopenIsStale,
  windowState,
} from './inbox-time';
import { linkHost, messageBody, previewContent } from './message-content';
import { buildTimeline } from './timeline';
import { ApiError } from '../../lib/api/client';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-11-16T10:00:00+07:00');
const at = (ms: number) => new Date(NOW + ms).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe('jendela 24 jam', () => {
  it('membedakan belum ada, terbuka, hampir habis (≤ 2 jam), dan habis', () => {
    expect(windowState(null, NOW)).toEqual({ kind: 'none' });
    expect(windowState('bukan-tanggal', NOW)).toEqual({ kind: 'none' });
    expect(windowState(at(5 * HOUR), NOW).kind).toBe('open');
    expect(windowState(at(2 * HOUR + 1), NOW).kind).toBe('open');
    expect(windowState(at(2 * HOUR), NOW).kind).toBe('expiring');
    expect(windowState(at(1), NOW).kind).toBe('expiring');
    expect(windowState(at(0), NOW).kind).toBe('expired');
    expect(windowState(at(-HOUR), NOW).kind).toBe('expired');
  });

  it('sisa waktu dibulatkan ke bawah per menit; di atas 2 jam cukup jamnya', () => {
    expect(formatRemaining(23 * HOUR + 59 * MINUTE)).toEqual({ short: '23 jam', long: '23 jam' });
    expect(formatRemaining(2 * HOUR + 30 * MINUTE).short).toBe('2 jam');
    expect(formatRemaining(HOUR + 12 * MINUTE + 59_000)).toEqual({
      short: '1 jam 12 mnt',
      long: '1 jam 12 menit',
    });
    expect(formatRemaining(2 * HOUR).short).toBe('2 jam');
    expect(formatRemaining(45 * MINUTE + 30_000)).toEqual({ short: '45 mnt', long: '45 menit' });
    expect(formatRemaining(59_000)).toEqual({ short: '< 1 mnt', long: 'kurang dari 1 menit' });
    expect(formatRemaining(-5)).toEqual({ short: '< 1 mnt', long: 'kurang dari 1 menit' });
  });

  it('pewaktu berdetak di awal menit berikutnya', () => {
    expect(msUntilNextMinute(NOW)).toBe(MINUTE);
    expect(msUntilNextMinute(NOW + 15_000)).toBe(45_000);
  });
});

describe('cap waktu (zona waktu perangkat)', () => {
  // Waktu lokal perangkat: tes tidak bergantung zona waktu mesin/CI.
  const local = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).toISOString();
  const now = new Date(2026, 10, 16, 15, 0);
  it('daftar: jam hari ini, "Kemarin", nama hari, tanggal', () => {
    expect(formatListTime(local(11, 16, 9, 5), now)).toBe('09.05');
    expect(formatListTime(local(11, 15, 22), now)).toBe('Kemarin');
    expect(formatListTime(local(11, 12, 10), now)).toBe('Kamis');
    expect(formatListTime(local(10, 2, 10), now)).toBe('2 Okt');
    expect(formatListTime(local(10, 2, 10, 0, 2025), now)).toBe('2 Okt 2025');
    expect(formatListTime('ngawur', now)).toBe('');
  });

  it('pemisah hari di riwayat pesan', () => {
    expect(formatDayLabel(local(11, 16, 1), now)).toBe('Hari ini');
    expect(formatDayLabel(local(11, 15, 1), now)).toBe('Kemarin');
    expect(formatDayLabel(local(11, 10, 1), now)).toBe('Selasa, 10 November 2026');
  });
});

describe('identitas kontak', () => {
  it('nomor Indonesia dirapikan, nomor lain apa adanya', () => {
    expect(formatPhone('+6281234567890')).toBe('+62 812-3456-7890');
    expect(formatPhone('+628123456789')).toBe('+62 812-3456-789');
    expect(formatPhone('+14155552671')).toBe('+14155552671');
    expect(formatPhone(null)).toBeNull();
  });

  it('daftar: nomor selalu di samping nama yang bukan nomor itu sendiri', () => {
    const summary = {
      id: 'x',
      number: 3,
      displayName: 'Budi',
      nameSource: 'team' as const,
      phone: '+6281234567890',
      waUsername: null,
    };
    expect(summaryIdentity(summary)).toEqual({
      name: 'Budi',
      handle: '+62 812-3456-7890',
      fromWhatsApp: false,
      fromChannel: false,
    });
    // Nama kiriman pelanggan: penanda "dari WhatsApp".
    expect(summaryIdentity({ ...summary, nameSource: 'whatsapp' }).fromWhatsApp).toBe(true);
    // Tanpa nomor: @username menyertai nama; username sebagai nama tidak diulang.
    expect(summaryIdentity({ ...summary, phone: null, waUsername: 'budi.s' }).handle).toBe(
      '@budi.s',
    );
    expect(
      summaryIdentity({
        ...summary,
        nameSource: 'none',
        displayName: '@budi.s',
        phone: null,
        waUsername: 'budi.s',
      }),
    ).toEqual({ name: '@budi.s', handle: null, fromWhatsApp: false, fromChannel: false });
    // Nama tampilan = nomor: tidak diulang dua kali.
    expect(
      summaryIdentity({ ...summary, nameSource: 'none', displayName: '+6281234567890' }),
    ).toEqual({
      name: '+62 812-3456-7890',
      handle: null,
      fromWhatsApp: false,
      fromChannel: false,
    });
    // Channel lain: nama profil tidak tepercaya + @username/alamat di sampingnya.
    expect(
      summaryIdentity({
        ...summary,
        nameSource: 'channel',
        phone: null,
        channelHandle: '@andi_dps',
      }),
    ).toEqual({ name: 'Budi', handle: '@andi_dps', fromWhatsApp: false, fromChannel: true });
    // Nama profil yang MENIRU nomor lain tetap disandingkan dengan nomor aslinya.
    expect(summaryIdentity({ ...summary, displayName: '+62 811-1111-1111' }).handle).toBe(
      '+62 812-3456-7890',
    );
  });

  it('kontak lengkap: nama tim > profil WhatsApp (+ penanda) > nomor > username', () => {
    expect(contactIdentity(fakeContact({ name: 'ID01+BUDI@KEDATON' }))).toMatchObject({
      name: 'ID01+BUDI@KEDATON',
      handle: '+62 812-3456-7890',
      fromWhatsApp: false,
    });
    expect(contactIdentity(fakeContact({ profileName: 'Budi ✨' }))).toMatchObject({
      name: 'Budi ✨',
      fromWhatsApp: true,
    });
    expect(
      contactIdentity(fakeContact({ profileName: null, phone: null, waUsername: 'budi.s' })),
    ).toMatchObject({ name: '@budi.s', handle: null });
    expect(
      contactIdentity(fakeContact({ profileName: 'Budi', phone: null, waUsername: 'budi.s' })),
    ).toMatchObject({ name: 'Budi', handle: '@budi.s', fromWhatsApp: true });
  });

  it('inisial avatar hanya dari kata berhuruf', () => {
    expect(avatarInitials('budi santoso')).toBe('BS');
    expect(avatarInitials('Ölçer')).toBe('Ö');
    expect(avatarInitials('+62 812-3456')).toBeNull();
    expect(avatarInitials('  ')).toBeNull();
  });
});

describe('isi pesan sebagai teks', () => {
  it('cuplikan daftar: teks apa adanya, jenis lain diberi label', () => {
    const base = { direction: 'inbound', status: null, createdAt: at(0) } as const;
    expect(previewContent(null).text).toBe(t.inbox.item.noMessage);
    expect(previewContent({ ...base, type: 'text', text: '<b>halo</b>' }).text).toBe('<b>halo</b>');
    expect(previewContent({ ...base, type: 'image', text: null }).text).toBe('Gambar');
    expect(previewContent({ ...base, type: 'image', text: 'Bukti bayar' }).text).toBe(
      'Bukti bayar',
    );
  });

  it('gelembung: label per jenis, nama berkas tetap teks', () => {
    expect(
      messageBody(
        fakeMessage({
          type: 'document',
          text: null,
          media: {
            kind: 'document',
            mimeType: 'application/pdf',
            filename: '<img src=x>.pdf',
            voice: false,
            animated: false,
          },
        }),
      ).label,
    ).toBe('Dokumen: <img src=x>.pdf');
    expect(
      messageBody(
        fakeMessage({
          type: 'audio',
          text: null,
          media: { kind: 'audio', mimeType: null, filename: null, voice: true, animated: false },
        }),
      ).label,
    ).toBe('Pesan suara');
    expect(
      messageBody(
        fakeMessage({
          type: 'location',
          text: null,
          location: { latitude: -5.39714, longitude: 105.26679, name: null, address: null },
        }),
      ).detail,
    ).toBe('-5.39714, 105.26679');
    const unsupported = messageBody(fakeMessage({ type: 'unsupported', rawType: 'order' }));
    expect(unsupported.label).toBe(t.inbox.content.unsupported);
    expect(unsupported.detail).toBe('Pesanan dari katalog');
    // Jenis tak dikenal: tanpa keterangan (nama mentah tidak ditampilkan).
    expect(messageBody(fakeMessage({ type: 'unsupported', rawType: 'x_baru' })).detail).toBeNull();
    expect(
      messageBody(
        fakeMessage({
          type: 'interactive',
          text: null,
          interactive: { kind: 'list_reply', id: 'p1', title: 'Paket 20 Mbps', description: null },
        }),
      ),
    ).toMatchObject({ label: 'Pilihan dari daftar', text: 'Paket 20 Mbps' });
  });

  it('host tautan iklan hanya untuk http(s)', () => {
    expect(linkHost('https://iklan.contoh.id/promo?x=1')).toBe('iklan.contoh.id');
    expect(linkHost('javascript:alert(1)')).toBeNull();
    expect(linkHost('bukan url')).toBeNull();
  });

  it('reaksi menempel ke pesan sasaran; reaksi terakhir yang berlaku', () => {
    const target = fakeMessage({ text: 'Sudah dicek kak?' });
    const reactions = [
      fakeMessage({ type: 'reaction', reaction: { emoji: '👍', messageId: target.id } }),
      fakeMessage({ type: 'reaction', reaction: { emoji: '❤️', messageId: target.id } }),
    ];
    const lonely = fakeMessage({ type: 'reaction', reaction: { emoji: '🙏', messageId: null } });
    const removed = fakeMessage({ type: 'reaction', reaction: { emoji: null, messageId: null } });
    const model = buildTimeline([target, ...reactions, lonely, removed]);
    expect(model.rows.map((row) => row.id)).toEqual([target.id, lonely.id]);
    expect(model.reactions.get(target.id)).toEqual({ in: '❤️' });

    const cleared = buildTimeline([
      target,
      fakeMessage({ type: 'reaction', reaction: { emoji: '👍', messageId: target.id } }),
      fakeMessage({ type: 'reaction', reaction: { emoji: null, messageId: target.id } }),
    ]);
    expect(cleared.reactions.has(target.id)).toBe(false);
  });
});

describe('cari & saring', () => {
  it('kata pencarian dirapikan, minimal 2 huruf, maksimal 100', () => {
    expect(searchTerm('')).toEqual({ query: null, tooShort: false });
    expect(searchTerm('   ')).toEqual({ query: null, tooShort: false });
    expect(searchTerm(' b ')).toEqual({ query: null, tooShort: true });
    expect(searchTerm('  budi   santoso ')).toEqual({ query: 'budi santoso', tooShort: false });
    expect(searchTerm('x'.repeat(300)).query).toHaveLength(100);
  });

  it('query string tanpa nilai kosong dan dengan urutan tetap', () => {
    expect(conversationQueryString({})).toBe('');
    expect(
      conversationQueryString({
        q: 'budi & co',
        status: 'unserved',
        window: 'expiring',
        unread: true,
        assignee: 'me',
        cursor: 'abc',
        limit: 30,
      }),
    ).toBe(
      '?status=unserved&assignee=me&window=expiring&unread=true&q=budi+%26+co&cursor=abc&limit=30',
    );
    expect(conversationQueryString({ unread: false, q: '' })).toBe('');
    expect(compactParams({ unread: false, channelId: undefined, q: 'x y' })).toEqual({ q: 'x y' });
  });

  it('jumlah saringan aktif dan labelnya', () => {
    const filters = { window: 'expiring', assignee: 'me', unread: true } as const;
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ unread: false })).toBe(0);
    expect(activeFilterCount(filters)).toBe(3);
    expect(
      filterChips(
        { ...filters, channelId: 'c1' },
        {
          channels: [
            {
              id: 'c1',
              name: 'CS Utama',
              type: 'whatsapp',
              enabled: true,
              displayPhoneNumber: null,
            },
          ],
          agents: [],
        },
      ).map((chip) => chip.label),
    ).toEqual(['Hampir habis', 'Ditangani saya', 'Channel: CS Utama', 'Belum dibaca']);
  });

  it('saringan tag kontak: query string, hitungan, dan label chip', () => {
    const tagId = '6f1c2a90-2222-4c4c-9a9a-000000000001';
    expect(conversationQueryString({ tagId })).toBe(`?tagId=${tagId}`);
    expect(activeFilterCount({ tagId })).toBe(1);
    expect(
      filterChips(
        { tagId },
        { channels: [], agents: [], tags: [{ id: tagId, name: 'VIP', color: 'yellow' }] },
      ).map((chip) => chip.label),
    ).toEqual([t.inbox.filters.chipTag('VIP')]);
  });

  it('parameter URL chat hanya UUID', () => {
    const id = '6F1C2A90-1111-4C4C-9A9A-000000000001';
    expect(parseChatId(id)).toBe(id.toLowerCase());
    expect(parseChatId('../../etc')).toBeUndefined();
    expect(parseChatId(42)).toBeUndefined();
    expect(parseInboxSearch({ tab: 'bot', chat: 'x' })).toEqual({ tab: 'bot' });
  });

  it('tidak mengulang otomatis 4xx, 429, dan 503 pencarian', () => {
    const error = (status: number) => new ApiError({ status, code: 'X', message: 'x' });
    expect(retryTransient(0, error(429))).toBe(false);
    expect(retryTransient(0, error(503))).toBe(false);
    expect(retryTransient(0, error(404))).toBe(false);
    expect(retryTransient(0, error(500))).toBe(true);
    expect(retryTransient(0, error(0))).toBe(true);
    expect(retryTransient(1, error(500))).toBe(false);
  });
});

describe('event real-time → cache', () => {
  function seed() {
    const client = new QueryClient();
    const conversation = fakeConversation({ unreadCount: 0 });
    const listKey = inboxKeys.conversations({});
    client.setQueryData<InfiniteData<ConversationListResponse, string | null>>(listKey, {
      pages: [{ conversations: [conversation], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(inboxKeys.conversation(conversation.id), { conversation });
    const outbound = fakeMessage({ direction: 'outbound', senderKind: 'agent', status: 'sent' });
    client.setQueryData<InfiniteData<MessageListResponse, string | null>>(
      inboxKeys.messages(conversation.id),
      { pages: [{ messages: [outbound], nextCursor: null }], pageParams: [null] },
    );
    return { client, conversation, listKey, outbound };
  }

  it('conversation.updated memperbarui lencana langsung, lalu daftar & hitungan dimuat ulang', () => {
    vi.useFakeTimers();
    const { client, conversation, listKey } = seed();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyInboxEvent(client, {
      type: 'conversation.updated',
      conversationId: conversation.id,
      status: 'served',
      assigneeUserId: null,
      unreadCount: 4,
      lastMessageAt: at(0),
      windowExpiresAt: at(-1),
    });
    const list = client.getQueryData<InfiniteData<ConversationListResponse>>(listKey);
    expect(list?.pages[0]?.conversations[0]).toMatchObject({
      unreadCount: 4,
      status: 'served',
      windowOpen: false,
    });
    // Detail selalu diambil ulang (agen berganti / cakupan hilang → 404).
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: inboxKeys.conversation(conversation.id),
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: inboxKeys.conversationLists });

    // Rentetan event = SATU muat ulang.
    applyInboxEvent(client, {
      type: 'message.created',
      conversationId: conversation.id,
      messageId: '7c1c2a90-1111-4c4c-9a9a-000000000009',
      direction: 'inbound',
      createdAt: at(0),
    });
    vi.advanceTimersByTime(LIST_REFRESH_DELAY_MS);
    expect(
      invalidate.mock.calls.filter(
        ([filters]) => filters?.queryKey === inboxKeys.conversationLists,
      ),
    ).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.countsAll });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.messages(conversation.id) });
  });

  it('message.status memajukan centang di tempat', () => {
    const { client, conversation, outbound } = seed();
    applyInboxEvent(client, {
      type: 'message.status',
      conversationId: conversation.id,
      messageId: outbound.id,
      status: 'read',
    });
    const messages = flattenMessages(
      client.getQueryData<InfiniteData<MessageListResponse>>(inboxKeys.messages(conversation.id)),
    );
    expect(messages[0]?.status).toBe('read');
  });

  it('message.status failed: pesan diambil ulang (penjelasan gagal + Kirim ulang dari REST)', () => {
    const { client, conversation, outbound } = seed();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyInboxEvent(client, {
      type: 'message.status',
      conversationId: conversation.id,
      messageId: outbound.id,
      status: 'read',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: inboxKeys.messages(conversation.id) });
    applyInboxEvent(client, {
      type: 'message.status',
      conversationId: conversation.id,
      messageId: outbound.id,
      status: 'failed',
    });
    const messages = flattenMessages(
      client.getQueryData<InfiniteData<MessageListResponse>>(inboxKeys.messages(conversation.id)),
    );
    expect(messages[0]?.status).toBe('failed');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.messages(conversation.id) });
  });

  it('conversation.detail mengambil ulang hanya bagian yang berubah + log', () => {
    vi.useFakeTimers();
    const { client, conversation } = seed();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const id = conversation.id;
    applyInboxEvent(client, { type: 'conversation.detail', conversationId: id, section: 'notes' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.notes(id) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.events(id) });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: inboxKeys.messages(id) });

    invalidate.mockClear();
    applyInboxEvent(client, { type: 'conversation.detail', conversationId: id, section: 'stars' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.messages(id) });

    invalidate.mockClear();
    applyInboxEvent(client, { type: 'conversation.detail', conversationId: id, section: 'tags' });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: inboxKeys.contact(conversation.contact.id),
    });
    vi.advanceTimersByTime(LIST_REFRESH_DELAY_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.conversationLists });

    invalidate.mockClear();
    applyInboxEvent(client, { type: 'tags.changed' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.tags });
  });

  it('percakapan yang tidak tersedia lagi dibuang dari cache', () => {
    const { client, conversation, listKey } = seed();
    forgetConversation(client, conversation.id);
    expect(client.getQueryData(inboxKeys.messages(conversation.id))).toBeUndefined();
    const list = client.getQueryData<InfiniteData<ConversationListResponse>>(listKey);
    expect(list?.pages[0]?.conversations).toEqual([]);
  });

  it('pesan lama → baru tanpa duplikat lintas halaman', () => {
    const a = fakeMessage({ text: 'a' });
    const b = fakeMessage({ text: 'b' });
    const c = fakeMessage({ text: 'c' });
    const data = {
      pages: [
        { messages: [c, b], nextCursor: 'x' },
        { messages: [b, a], nextCursor: null },
      ],
      pageParams: [null, 'x'],
    };
    expect(flattenMessages(data).map((message) => message.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('sambungan WebSocket inbox', () => {
  const hello = { type: 'hello', heartbeatSeconds: 30 };

  function start(overrides: Partial<ConstructorParameters<typeof InboxStream>[0]> = {}) {
    const events: unknown[] = [];
    const statuses: string[] = [];
    const resync = vi.fn();
    const authClosed = vi.fn();
    const stream = new InboxStream({
      url: 'ws://localhost/api/v1/inbox/stream',
      createSocket: (url) => new FakeSocket(url),
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      onResync: resync,
      onAuthClosed: authClosed,
      ...overrides,
    });
    stream.start();
    return { stream, events, statuses, resync, authClosed };
  }

  it('alamat mengikuti protokol halaman, tanpa token', () => {
    expect(inboxStreamUrl({ protocol: 'https:', host: 'cs.contoh.id' })).toBe(
      'wss://cs.contoh.id/api/v1/inbox/stream',
    );
    expect(inboxStreamUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/v1/inbox/stream',
    );
  });

  it('pesan yang tidak lolos skema diabaikan', () => {
    expect(parseStreamEvent('{"type":"hello","heartbeatSeconds":30}')).toEqual(hello);
    expect(parseStreamEvent('bukan json')).toBeNull();
    expect(parseStreamEvent('{"type":"message.created","conversationId":"x"}')).toBeNull();
    expect(parseStreamEvent(42)).toBeNull();
    expect(parseStreamEvent('x'.repeat(20_000))).toBeNull();
  });

  it('meneruskan event, menyambung ulang dengan jeda bertambah, lalu sinkron ulang', () => {
    vi.useFakeTimers();
    const { stream, events, statuses, resync } = start();
    const first = FakeSocket.latest()!;
    first.receive(hello);
    expect(statuses.at(-1)).toBe('open');
    expect(resync).not.toHaveBeenCalled();

    const event = {
      type: 'message.status',
      conversationId: '6f1c2a90-1111-4c4c-9a9a-000000000001',
      messageId: '6f1c2a90-1111-4c4c-9a9a-000000000002',
      status: 'delivered',
    };
    first.receive(event);
    expect(events).toEqual([event]);

    first.serverClose(1006);
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // Gagal lagi sebelum hello → jeda berikutnya 2 detik.
    FakeSocket.latest()!.serverClose(1006);
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    FakeSocket.latest()!.receive(hello);
    expect(resync).toHaveBeenCalledTimes(1);

    stream.stop();
    expect(FakeSocket.latest()!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('stopped');
  });

  it('4401 / 4403 berhenti tanpa menyambung ulang', () => {
    vi.useFakeTimers();
    for (const code of [4401, 4403]) {
      FakeSocket.reset();
      const { authClosed, statuses } = start();
      FakeSocket.latest()!.receive(hello);
      FakeSocket.latest()!.serverClose(code);
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(authClosed).toHaveBeenCalledWith(code);
      expect(statuses.at(-1)).toBe('stopped');
    }
  });

  it('berhenti saat masih menyambung: ditutup begitu tersambung (tanpa error console)', () => {
    const { stream } = start();
    const socket = FakeSocket.latest()!;
    socket.readyState = 0;
    stream.stop();
    expect(socket.closed).toBe(false);
    socket.open();
    expect(socket.closed).toBe(true);
  });

  it('reconnectNow memotong jeda (browser kembali online)', () => {
    vi.useFakeTimers();
    const { stream } = start();
    FakeSocket.latest()!.serverClose(1006);
    stream.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(2);
    stream.stop();
  });
});

describe('reopenIsStale (buka lagi chat selesai tanpa inbox.initiate, audit akhir A1)', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  const hour = 3_600_000;
  const at = (offset: number) => new Date(now + offset).toISOString();

  it('channel Meta: mengikuti jendela 24 jam', () => {
    const wa = fakeConversation({ status: 'resolved' });
    expect(reopenIsStale({ ...wa, windowExpiresAt: at(hour) }, now)).toBe(false);
    expect(reopenIsStale({ ...wa, windowExpiresAt: at(0) }, now)).toBe(true);
    expect(reopenIsStale({ ...wa, windowExpiresAt: at(-hour) }, now)).toBe(true);
    // Belum pernah ada pesan masuk (mis. dari broadcast).
    expect(reopenIsStale({ ...wa, windowExpiresAt: null }, now)).toBe(true);
  });

  it('Email/Telegram: pesan masuk terakhir < 24 jam', () => {
    const email = fakeConversation({
      status: 'resolved',
      channel: { id: 'e0000000-0000-4000-8000-000000000001', name: 'Email', type: 'email' },
      windowExpiresAt: null,
    });
    expect(reopenIsStale({ ...email, lastInboundAt: at(-23 * hour) }, now)).toBe(false);
    expect(reopenIsStale({ ...email, lastInboundAt: at(-24 * hour) }, now)).toBe(true);
    expect(reopenIsStale({ ...email, lastInboundAt: null }, now)).toBe(true);
  });
});

describe('event resync (akses berubah)', () => {
  it('memuat ulang inbox, channel, agen, laporan, dan data bercakupan lain', () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    applyInboxEvent(queryClient, { type: 'resync' });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of [['inbox'], ['reports'], ['departments'], ['tickets'], ['crm']]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });
});
