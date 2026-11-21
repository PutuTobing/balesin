import {
  API_ROUTES,
  apiPath,
  type ChannelSummary,
  type Contact,
  type Conversation,
  type Message,
  type QuickReply,
  type Tag,
  type ConversationNote,
  type ConversationEvent,
  type MessageListFilter,
} from '@balesin/shared';
import type { FakeHandler, FakeInbox } from './fake-api';

/** Data inbox tiruan untuk tes komponen (bentuk sama dengan skema `@balesin/shared`). */

/** ID pengguna sesi tiruan (`fakeSession`). */
const SELF_ID = '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001';

export const FAKE_CHANNEL_ID = '6f1c2a90-1111-4c4c-9a9a-000000000001';

let sequence = 0;
function uuid(prefix: string): string {
  sequence += 1;
  return `${prefix}-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? uuid('c0000000');
  return {
    id,
    number: 1,
    status: 'unserved',
    channel: { id: FAKE_CHANNEL_ID, name: 'CS Utama', type: 'whatsapp' },
    contact: {
      id: uuid('d0000000'),
      number: 1,
      displayName: 'Budi Santoso',
      nameSource: 'whatsapp',
      phone: '+6281234567890',
      waUsername: null,
      tags: [],
    },
    assignee: null,
    unreadCount: 0,
    lastMessageAt: '2026-11-16T03:00:00.000Z',
    lastInboundAt: '2026-11-16T03:00:00.000Z',
    windowExpiresAt: '2026-11-17T03:00:00.000Z',
    windowOpen: true,
    lastMessage: {
      direction: 'inbound',
      type: 'text',
      text: 'Halo kak, internet di rumah mati sejak pagi.',
      status: null,
      createdAt: '2026-11-16T03:00:00.000Z',
    },
    createdAt: '2026-11-16T02:00:00.000Z',
    resolvedAt: null,
    firstAssignedAt: null,
    firstResponseAt: null,
    ...overrides,
  };
}

export function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? uuid('e0000000'),
    number: 1,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: null,
    text: 'Halo kak',
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
    createdAt: '2026-11-16T03:00:00.000Z',
    ...overrides,
  };
}

export function fakeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: overrides.id ?? uuid('d0000000'),
    number: 1,
    displayName: 'Budi Santoso',
    nameSource: 'whatsapp',
    phone: '+6281234567890',
    channelType: 'whatsapp',
    name: null,
    profileName: 'Budi Santoso',
    waUsername: null,
    tags: [],
    email: null,
    notes: null,
    attributes: [],
    createdAt: '2026-11-16T02:00:00.000Z',
    updatedAt: '2026-11-16T02:00:00.000Z',
    ...overrides,
  };
}

export function fakeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: overrides.id ?? uuid('a0000000'),
    name: 'Pelanggan baru',
    color: 'blue',
    contactCount: 3,
    createdAt: '2026-11-10T03:00:00.000Z',
    updatedAt: '2026-11-10T03:00:00.000Z',
    ...overrides,
  };
}

export function fakeNote(overrides: Partial<ConversationNote> = {}): ConversationNote {
  return {
    id: overrides.id ?? uuid('b0000000'),
    body: 'Pelanggan minta dihubungi setelah jam 5 sore.',
    author: { id: SELF_ID, name: 'Rina Kartika' },
    createdAt: '2026-11-16T03:10:00.000Z',
    updatedAt: '2026-11-16T03:10:00.000Z',
    edited: false,
    canEdit: true,
    canDelete: true,
    ...overrides,
  };
}

export function fakeEvent(overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    id: overrides.id ?? uuid('9e000000'),
    kind: 'claimed',
    actor: { id: SELF_ID, name: 'Rina Kartika' },
    assignee: null,
    previousAssignee: null,
    tag: null,
    fields: null,
    createdAt: '2026-11-16T03:05:00.000Z',
    ...overrides,
  };
}

/** Saringan `?only=` daftar pesan (panel Berkas). */
function onlyFilter(message: Message, only: MessageListFilter | null): boolean {
  if (only === 'starred') return Boolean(message.starredAt);
  if (only === 'media') return ['image', 'video'].includes(message.type);
  if (only === 'files') return ['document', 'audio'].includes(message.type);
  return true;
}

export function fakeQuickReply(overrides: Partial<QuickReply> = {}): QuickReply {
  return {
    id: overrides.id ?? uuid('f0000000'),
    shortcut: 'salam',
    title: 'Salam pembuka',
    body: 'Halo kak {nama}, dengan {agen} di sini. Ada yang bisa kami bantu?',
    usageCount: 12,
    lastUsedAt: '2026-11-16T03:00:00.000Z',
    updatedBy: { id: SELF_ID, name: 'Rina Kartika' },
    createdAt: '2026-11-10T03:00:00.000Z',
    updatedAt: '2026-11-15T03:00:00.000Z',
    ...overrides,
  };
}

export function fakeChannelSummary(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: FAKE_CHANNEL_ID,
    type: 'whatsapp',
    name: 'CS Utama',
    enabled: true,
    displayPhoneNumber: '+62 811-0000-1111',
    ...overrides,
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Penangan bawaan endpoint inbox (status, `q`, saringan sederhana; tanpa kursor). */
export function fakeInboxRoutes(
  inbox: FakeInbox,
  guard: (handler: FakeHandler) => FakeHandler,
): Record<string, FakeHandler> {
  const conversations = inbox.conversations ?? [];
  const select = (query: URLSearchParams) =>
    conversations.filter((conversation) => {
      const status = query.get('status');
      const q = query.get('q')?.toLowerCase();
      if (status && conversation.status !== status) return false;
      if (q && !conversation.contact.displayName.toLowerCase().includes(q)) return false;
      if (query.get('unread') === 'true' && conversation.unreadCount === 0) return false;
      if (query.get('channelId') && conversation.channel.id !== query.get('channelId')) {
        return false;
      }
      return true;
    });
  const routes: Record<string, FakeHandler> = {
    [`GET ${API_ROUTES.inbox.conversations}`]: guard(({ query }) =>
      respond({ conversations: select(query), nextCursor: null }),
    ),
    [`GET ${API_ROUTES.inbox.counts}`]: guard(({ query }) => {
      const all = select(query);
      const count = (status: string) => all.filter((item) => item.status === status).length;
      return respond({
        counts: {
          all: all.length,
          bot: count('bot'),
          unserved: count('unserved'),
          served: count('served'),
          resolved: count('resolved'),
        },
        unreadOpen: all.filter((item) => item.status !== 'resolved' && item.unreadCount > 0).length,
      });
    }),
    [`GET ${API_ROUTES.inbox.agents}`]: guard(() => respond({ agents: inbox.agents ?? [] })),
    [`GET ${API_ROUTES.inbox.sendingStatus}`]: guard(() =>
      respond({ paused: inbox.paused ?? false }),
    ),
    [`GET ${API_ROUTES.quickReplies.list}`]: guard(({ query }) => {
      const q = query.get('q')?.toLowerCase();
      const all = inbox.quickReplies ?? [];
      return respond({
        quickReplies: q
          ? all.filter((item) => item.shortcut.includes(q) || item.title.toLowerCase().includes(q))
          : all,
      });
    }),
    [`POST ${API_ROUTES.quickReplies.list}`]: guard(({ body }) =>
      respond({ quickReply: fakeQuickReply(body as Partial<QuickReply>) }, 201),
    ),
    [`GET ${API_ROUTES.channels.list}`]: guard(() => respond({ channels: inbox.channels ?? [] })),
    [`GET ${API_ROUTES.tags.list}`]: guard(() => respond({ tags: inbox.tags ?? [] })),
    [`POST ${API_ROUTES.tags.list}`]: guard(({ body }) =>
      respond({ tag: fakeTag({ ...(body as Partial<Tag>), contactCount: 0 }) }, 201),
    ),
  };
  for (const quickReply of inbox.quickReplies ?? []) {
    const quickReplyId = quickReply.id;
    routes[`POST ${apiPath(API_ROUTES.quickReplies.use, { quickReplyId })}`] = guard(() =>
      respond({ text: quickReply.body.replace('{nama}', 'Budi').replace('{agen}', 'Rina') }),
    );
    routes[`PATCH ${apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId })}`] = guard(
      ({ body }) => respond({ quickReply: { ...quickReply, ...(body as object) } }),
    );
    routes[`DELETE ${apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId })}`] = guard(() =>
      respond({ deleted: true }),
    );
  }
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    routes[`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId })}`] = guard(() =>
      respond({ conversation }),
    );
    routes[`GET ${apiPath(API_ROUTES.inbox.messages, { conversationId })}`] = guard(({ query }) => {
      const only = query.get('only') as MessageListFilter | null;
      return respond({
        messages: [...(inbox.messages?.[conversationId] ?? [])]
          .filter((message) => onlyFilter(message, only))
          .reverse(),
        nextCursor: null,
      });
    });
    routes[`GET ${apiPath(API_ROUTES.inbox.notes, { conversationId })}`] = guard(() =>
      respond({ notes: inbox.notes?.[conversationId] ?? [] }),
    );
    routes[`POST ${apiPath(API_ROUTES.inbox.notes, { conversationId })}`] = guard(({ body }) =>
      respond({ note: fakeNote({ body: (body as { body: string }).body }) }, 201),
    );
    for (const note of inbox.notes?.[conversationId] ?? []) {
      const noteId = note.id;
      routes[`PATCH ${apiPath(API_ROUTES.inbox.note, { conversationId, noteId })}`] = guard(
        ({ body }) =>
          respond({ note: { ...note, body: (body as { body: string }).body, edited: true } }),
      );
      routes[`DELETE ${apiPath(API_ROUTES.inbox.note, { conversationId, noteId })}`] = guard(() =>
        respond({ deleted: true }),
      );
    }
    routes[`GET ${apiPath(API_ROUTES.inbox.events, { conversationId })}`] = guard(() =>
      respond({ events: inbox.events?.[conversationId] ?? [] }),
    );
    // Kirim pesan: 202 `pending`, isi dari body (teks/media/reaksi).
    routes[`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId })}`] = guard(({ body }) => {
      const request = body as Record<string, unknown>;
      return respond(
        {
          message: fakeMessage({
            direction: 'outbound',
            senderKind: 'agent',
            senderUserId: SELF_ID,
            status: 'pending',
            type:
              request.type === 'reaction'
                ? 'reaction'
                : request.type === 'media'
                  ? 'image'
                  : 'text',
            text: (request.text as string | undefined) ?? (request.caption as string) ?? null,
            reaction:
              request.type === 'reaction'
                ? {
                    emoji: (request.emoji as string) || null,
                    messageId: request.targetMessageId as string,
                  }
                : null,
            createdAt: new Date().toISOString(),
          }),
        },
        202,
      );
    });
    routes[`POST ${apiPath(API_ROUTES.inbox.upload, { conversationId })}`] = guard(() =>
      respond(
        {
          media: {
            id: '7a000000-0000-4000-8000-000000000001',
            kind: 'image',
            mimeType: 'image/jpeg',
            filename: 'foto.jpg',
            sizeBytes: 1234,
          },
        },
        201,
      ),
    );
    routes[`POST ${apiPath(API_ROUTES.inbox.claim, { conversationId })}`] = guard(() =>
      respond({
        conversation: {
          ...conversation,
          status: 'served',
          assignee: { id: SELF_ID, name: 'Rina Kartika' },
        },
      }),
    );
    const action = (changes: Partial<Conversation> | null) =>
      guard(() => respond({ conversation: changes ? { ...conversation, ...changes } : null }));
    routes[`POST ${apiPath(API_ROUTES.inbox.assign, { conversationId })}`] = guard(({ body }) =>
      respond({
        conversation: {
          ...conversation,
          status: 'served',
          assignee: {
            id: (body as { userId: string }).userId,
            name:
              inbox.agents?.find((agent) => agent.id === (body as { userId: string }).userId)
                ?.name ?? 'Agen',
          },
        },
      }),
    );
    routes[`POST ${apiPath(API_ROUTES.inbox.unassign, { conversationId })}`] = action({
      status: 'unserved',
      assignee: null,
    });
    routes[`POST ${apiPath(API_ROUTES.inbox.resolve, { conversationId })}`] = action({
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    });
    routes[`POST ${apiPath(API_ROUTES.inbox.reopen, { conversationId })}`] = action({
      status: 'served',
      resolvedAt: null,
    });
    for (const message of inbox.messages?.[conversationId] ?? []) {
      const messageId = message.id;
      routes[`PUT ${apiPath(API_ROUTES.inbox.star, { messageId })}`] = guard(() =>
        respond({ message: { ...message, starredAt: new Date().toISOString() } }),
      );
      routes[`DELETE ${apiPath(API_ROUTES.inbox.star, { messageId })}`] = guard(() =>
        respond({ message: { ...message, starredAt: null } }),
      );
      routes[`POST ${apiPath(API_ROUTES.inbox.retry, { messageId })}`] = guard(() =>
        respond({ message: { ...message, status: 'pending', failure: null } }, 202),
      );
      routes[`GET ${apiPath(API_ROUTES.inbox.media, { messageId })}`] = guard(
        () =>
          // Byte biasa, bukan `Blob` jsdom: `fetch`/undici Node 22 memperlakukan Blob jsdom sebagai
          // Blob asli lalu memanggil `stream()` yang tidak ada → `response.blob()` gagal (hanya di CI).
          new Response(new TextEncoder().encode('gambar'), {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-disposition': `attachment; filename="file.bin"; filename*=UTF-8''tagihan%20nov.pdf`,
            },
          }),
      );
    }
    routes[`POST ${apiPath(API_ROUTES.inbox.read, { conversationId })}`] = guard(() =>
      respond({ conversation: { ...conversation, unreadCount: 0 } }),
    );
    const contact =
      inbox.contacts?.find((item) => item.id === conversation.contact.id) ??
      fakeContact({
        id: conversation.contact.id,
        displayName: conversation.contact.displayName,
        nameSource: conversation.contact.nameSource,
        phone: conversation.contact.phone,
        waUsername: conversation.contact.waUsername,
        name: conversation.contact.nameSource === 'team' ? conversation.contact.displayName : null,
        profileName:
          conversation.contact.nameSource === 'whatsapp' ? conversation.contact.displayName : null,
      });
    const contactId = contact.id;
    routes[`GET ${apiPath(API_ROUTES.inbox.contact, { contactId })}`] = guard(() =>
      respond({ contact }),
    );
    routes[`PATCH ${apiPath(API_ROUTES.inbox.contact, { contactId })}`] = guard(({ body }) => {
      const changes = body as Partial<Contact>;
      const name = changes.name === undefined ? contact.name : changes.name;
      return respond({
        contact: {
          ...contact,
          ...changes,
          name,
          displayName: name ?? contact.profileName ?? contact.phone ?? contact.displayName,
          nameSource: name ? 'team' : 'whatsapp',
        },
      });
    });
    routes[`DELETE ${apiPath(API_ROUTES.inbox.contact, { contactId })}`] = guard(() =>
      respond({
        deleted: { messages: 3, conversations: 1, webhookEvents: 2, mediaFiles: 0 },
      }),
    );
    routes[`GET ${apiPath(API_ROUTES.inbox.contactExport, { contactId })}`] = guard(() =>
      respond({
        exportedAt: '2026-11-16T04:00:00.000Z',
        contact: {
          id: contactId,
          number: contact.number,
          channelType: contact.channelType,
          phone: contact.phone,
          waUsername: contact.waUsername,
          name: contact.name,
          profileName: contact.profileName,
          email: contact.email ?? null,
          notes: contact.notes ?? null,
          attributes: contact.attributes ?? [],
          tags: (contact.tags ?? []).map((tag) => tag.name),
          createdAt: contact.createdAt,
        },
        conversations: [],
        messages: [],
        truncated: false,
      }),
    );
    routes[`POST ${apiPath(API_ROUTES.inbox.contactTags, { contactId })}`] = guard(({ body }) => {
      const tag = inbox.tags?.find((item) => item.id === (body as { tagId: string }).tagId);
      const tags = [...(contact.tags ?? [])];
      if (tag) tags.push({ id: tag.id, name: tag.name, color: tag.color });
      return respond({ contact: { ...contact, tags } });
    });
    for (const tag of [...(inbox.tags ?? []), ...(contact.tags ?? [])]) {
      routes[`DELETE ${apiPath(API_ROUTES.inbox.contactTag, { contactId, tagId: tag.id })}`] =
        guard(() =>
          respond({
            contact: {
              ...contact,
              tags: (contact.tags ?? []).filter((item) => item.id !== tag.id),
            },
          }),
        );
    }
  }
  return routes;
}
