import {
  API_ROUTES,
  apiPath,
  type ChannelSummary,
  type Contact,
  type Conversation,
  type Message,
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
    createdAt: '2026-11-16T02:00:00.000Z',
    updatedAt: '2026-11-16T02:00:00.000Z',
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
    [`GET ${API_ROUTES.channels.list}`]: guard(() => respond({ channels: inbox.channels ?? [] })),
  };
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    routes[`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId })}`] = guard(() =>
      respond({ conversation }),
    );
    routes[`GET ${apiPath(API_ROUTES.inbox.messages, { conversationId })}`] = guard(() =>
      respond({
        messages: [...(inbox.messages?.[conversationId] ?? [])].reverse(),
        nextCursor: null,
      }),
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
    for (const message of inbox.messages?.[conversationId] ?? []) {
      const messageId = message.id;
      routes[`POST ${apiPath(API_ROUTES.inbox.retry, { messageId })}`] = guard(() =>
        respond({ message: { ...message, status: 'pending', failure: null } }, 202),
      );
      routes[`GET ${apiPath(API_ROUTES.inbox.media, { messageId })}`] = guard(
        () =>
          new Response(new Blob(['gambar'], { type: 'image/png' }), {
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
    routes[`GET ${apiPath(API_ROUTES.inbox.contact, { contactId: contact.id })}`] = guard(() =>
      respond({ contact }),
    );
  }
  return routes;
}
