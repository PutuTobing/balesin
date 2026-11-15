/**
 * Notifikasi webhook WhatsApp Cloud API TIRUAN + pengirim bertanda tangan, untuk tes integrasi dan
 * E2E (simulasi pesan masuk). Bentuknya mengikuti contoh resmi Meta (dibaca 15 Nov 2026):
 * developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
 * (text, image, status, errors, unsupported). Nilai contoh diganti data Indonesia fiktif.
 *
 * Tidak pernah memanggil Meta: notifikasi disusun di sini, ditandatangani dengan App Secret yang
 * dipakai tes (`X-Hub-Signature-256` = HMAC-SHA256 body mentah), lalu dikirim ke penerima Balesin
 * (lewat `app.inject` atau HTTP sungguhan ke stack E2E).
 */
import { createHmac, randomBytes } from 'node:crypto';

export const FAKE_WEBHOOK_DEFAULTS = {
  wabaId: '102290129340398',
  phoneNumberId: '106540352242922',
  displayPhoneNumber: '6281100001111',
  customerWaId: '6281234567890',
  customerUserId: 'ID.13491208655302741918',
  customerName: 'Budi Santoso',
} as const;

export interface FakeWebhookTarget {
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
}

export interface FakeCustomer {
  waId?: string | null;
  userId?: string;
  name?: string;
  username?: string;
}

type Json = Record<string, unknown>;

/** `wamid.` + acak (bentuk ID pesan Meta: base64). */
export function fakeWamid(): string {
  return `wamid.${randomBytes(30).toString('base64')}`;
}

/** Detik Unix sebagai string, seperti `timestamp` Meta. */
export function unixTimestamp(date: Date = new Date()): string {
  return String(Math.floor(date.getTime() / 1000));
}

function metadataOf(target: FakeWebhookTarget): Json {
  return {
    display_phone_number: target.displayPhoneNumber ?? FAKE_WEBHOOK_DEFAULTS.displayPhoneNumber,
    phone_number_id: target.phoneNumberId ?? FAKE_WEBHOOK_DEFAULTS.phoneNumberId,
  };
}

function contactOf(customer: FakeCustomer): Json {
  const waId = customer.waId === undefined ? FAKE_WEBHOOK_DEFAULTS.customerWaId : customer.waId;
  return {
    profile: {
      name: customer.name ?? FAKE_WEBHOOK_DEFAULTS.customerName,
      ...(customer.username ? { username: customer.username } : {}),
    },
    ...(waId === null ? {} : { wa_id: waId }),
    user_id: customer.userId ?? FAKE_WEBHOOK_DEFAULTS.customerUserId,
  };
}

/** Satu `change` field `messages` → notifikasi lengkap. */
export function whatsAppNotification(
  value: Json,
  options: { wabaId?: string; field?: string } = {},
): Json {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId ?? FAKE_WEBHOOK_DEFAULTS.wabaId,
        changes: [{ value, field: options.field ?? 'messages' }],
      },
    ],
  };
}

/** Beberapa notifikasi digabung jadi satu (Meta bisa mengirim banyak entry sekaligus). */
export function combinedNotification(...notifications: Json[]): Json {
  return {
    object: 'whatsapp_business_account',
    entry: notifications.flatMap((notification) => notification.entry as unknown[]),
  };
}

export interface FakeMessageOptions extends FakeWebhookTarget {
  wamid?: string;
  timestamp?: string;
  customer?: FakeCustomer;
  /** Pesan yang dibalas pelanggan (`context.id`). */
  replyTo?: string;
}

function messageNotification(options: FakeMessageOptions, message: Json): Json {
  const customer = options.customer ?? {};
  const contact = contactOf(customer);
  return whatsAppNotification(
    {
      messaging_product: 'whatsapp',
      metadata: metadataOf(options),
      contacts: [contact],
      messages: [
        {
          ...(contact.wa_id === undefined ? {} : { from: contact.wa_id }),
          from_user_id: contact.user_id,
          id: options.wamid ?? fakeWamid(),
          timestamp: options.timestamp ?? unixTimestamp(),
          ...(options.replyTo
            ? { context: { from: metadataOf(options).display_phone_number, id: options.replyTo } }
            : {}),
          ...message,
        },
      ],
    },
    { wabaId: options.wabaId },
  );
}

/** Pesan teks masuk (`type: "text"`). */
export function textMessageNotification(
  options: FakeMessageOptions & { body?: string } = {},
): Json {
  return messageNotification(options, {
    type: 'text',
    text: { body: options.body ?? 'Halo kak, internet di rumah saya mati sejak pagi.' },
  });
}

/** Gambar masuk (`type: "image"`) — media diunduh lewat Graph API (butir berikutnya). */
export function imageMessageNotification(
  options: FakeMessageOptions & { caption?: string; mediaId?: string } = {},
): Json {
  return messageNotification(options, {
    type: 'image',
    image: {
      caption: options.caption ?? 'Bukti transfer bulan ini',
      mime_type: 'image/jpeg',
      sha256: 'f9TyJ/VLNWzIkPRS5tg1srKDa3w3SSFDP5XVLBGgbG4=',
      id: options.mediaId ?? '1003383421387256',
    },
  });
}

/** Pesan yang belum didukung Cloud API (`type: "unsupported"` + `errors[]` 131051). */
export function unsupportedMessageNotification(options: FakeMessageOptions = {}): Json {
  return messageNotification(options, {
    type: 'unsupported',
    unsupported: { type: 'edit' },
    errors: [
      {
        code: 131051,
        title: 'Message type unknown',
        message: 'Message type unknown',
        error_data: { details: 'Message type is currently not supported.' },
      },
    ],
  });
}

export type FakeStatus = 'sent' | 'delivered' | 'read' | 'played' | 'failed';

export interface FakeStatusOptions extends FakeWebhookTarget {
  /** wamid pesan KELUAR yang statusnya dilaporkan. */
  wamid: string;
  status: FakeStatus;
  timestamp?: string;
  recipientWaId?: string;
}

/** Status pesan keluar (`value.statuses[]`). `failed` membawa `errors[]` (131049, contoh resmi). */
export function statusNotification(options: FakeStatusOptions): Json {
  const status: Json = {
    id: options.wamid,
    status: options.status,
    timestamp: options.timestamp ?? unixTimestamp(),
    recipient_id: options.recipientWaId ?? FAKE_WEBHOOK_DEFAULTS.customerWaId,
  };
  if (options.status === 'failed') {
    status.errors = [
      {
        code: 131049,
        title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        message: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details:
            'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: '/documentation/business-messaging/whatsapp/support/error-codes',
      },
    ];
  } else {
    status.conversation = { id: 'CONVERSATION_ID', origin: { type: 'service' } };
    status.pricing = {
      billable: false,
      pricing_model: 'PMP',
      type: 'free_customer_service',
      category: 'service',
    };
  }
  const value: Json = {
    messaging_product: 'whatsapp',
    metadata: metadataOf(options),
    statuses: [status],
  };
  // Status `failed` tidak memuat `contacts` (dokumentasi status webhook).
  if (options.status !== 'failed') value.contacts = [contactOf({})];
  return whatsAppNotification(value, { wabaId: options.wabaId });
}

/** Error tingkat sistem/aplikasi/akun (`value.errors[]`, contoh resmi 130429). */
export function errorNotification(options: FakeWebhookTarget = {}): Json {
  return whatsAppNotification(
    {
      messaging_product: 'whatsapp',
      metadata: metadataOf(options),
      errors: [
        {
          code: 130429,
          title: 'Rate limit hit',
          message: 'Rate limit hit',
          error_data: {
            details:
              'Message failed to send because there were too many messages sent from this phone number in a short period of time',
          },
          href: '/documentation/business-messaging/whatsapp/support/error-codes',
        },
      ],
    },
    { wabaId: options.wabaId },
  );
}

/** Field tingkat WABA selain `messages` (status template disetujui). */
export function templateStatusNotification(options: { wabaId?: string } = {}): Json {
  return whatsAppNotification(
    {
      event: 'APPROVED',
      message_template_id: 1234567890,
      message_template_name: 'tagihan_bulanan',
      message_template_language: 'id',
      reason: 'NONE',
    },
    { wabaId: options.wabaId, field: 'message_template_status_update' },
  );
}

// ── Tanda tangan & pengiriman ───────────────────────────────────────────────

/** `sha256=<heks>` — sama persis dengan yang dikirim Meta. */
export function signWebhookBody(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export interface SignedWebhook {
  /** Body mentah (string JSON) yang ditandatangani. */
  body: string;
  headers: Record<string, string>;
}

/**
 * Body + header seperti kiriman Meta. `signature: null` = tanpa header; string = header itu apa
 * adanya (tes tanda tangan salah).
 */
export function signedWebhook(
  notification: unknown,
  appSecret: string,
  options: { signature?: string | null; rawBody?: string } = {},
): SignedWebhook {
  const body = options.rawBody ?? JSON.stringify(notification);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'facebookexternalua',
  };
  const signature =
    options.signature === undefined ? signWebhookBody(body, appSecret) : options.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return { body, headers };
}

/**
 * Mengirim notifikasi bertanda tangan ke URL webhook SUNGGUHAN (stack E2E). Untuk tes `app.inject`,
 * pakai `signedWebhook` langsung.
 */
export async function deliverWhatsAppWebhook(
  callbackUrl: string,
  notification: unknown,
  appSecret: string,
  options: { signature?: string | null } = {},
): Promise<Response> {
  const host = new URL(callbackUrl).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('Webhook tiruan hanya boleh dikirim ke server di mesin ini');
  }
  const { body, headers } = signedWebhook(notification, appSecret, options);
  return fetch(callbackUrl, { method: 'POST', headers, body });
}

/** Jabat tangan verifikasi seperti yang dilakukan Meta saat tombol "Verifikasi dan simpan". */
export function handshakeQuery(verifyToken: string, challenge = '1158201444'): string {
  return new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.challenge': challenge,
    'hub.verify_token': verifyToken,
  }).toString();
}
