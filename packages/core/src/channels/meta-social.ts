import { createHash } from 'node:crypto';

import type { ConnectionTestCode, MetaErrorKind } from '@balesin/shared';
import { z } from 'zod';

import type { SecretBox } from '../crypto';
import { cleanCustomerText, safeHttpUrl } from '../meta/contact-identity';
import type { MetaCredentials, MetaGraphClient } from '../meta/graph-client';
import { Secret } from '../secret';
import type { ChannelInboundEvent, ChannelInboundMessage } from './inbound';

/**
 * Facebook Messenger & Instagram DM (Fase 6) — DISIAPKAN, bawaan nonaktif (butuh App Review Meta).
 *
 * - Webhook: notifikasi `object: 'page'` (Messenger) / `'instagram'` dengan tanda tangan
 *   `X-Hub-Signature-256` App Secret (pola sama dengan WhatsApp, `verifyMetaWebhookSignature`).
 *   `entry[].id` WAJIB sama dengan ID Halaman (Messenger) / akun IG (Instagram) channel — entri lain
 *   dibuang (`misrouted`).
 * - Kirim: `POST /{page-id}/messages` lewat klien Graph terpusat (appsecret_proof, versi terkunci,
 *   batas laju `messaging`), `messaging_type: RESPONSE` (hanya dalam jendela 24 jam — tag pesan
 *   `HUMAN_AGENT` belum dipakai v1).
 * - Lampiran masuk: URL CDN Meta disimpan sebagai rujukan; diunduh api HANYA dari host allowlist
 *   (`META_SOCIAL_CDN_HOST_SUFFIXES`), tanpa token, tanpa redirect.
 */

export const META_SOCIAL_SECRET_PURPOSES = {
  pageToken: 'channels.meta_page_token',
  appSecret: 'channels.meta_app_secret',
  verifyToken: 'channels.meta_webhook_verify_token',
} as const;
export type MetaSocialSecretKind = keyof typeof META_SOCIAL_SECRET_PURPOSES;

export function sealMetaSocialSecret(
  box: SecretBox,
  owner: { id: string; organizationId: string },
  kind: MetaSocialSecretKind,
  plaintext: string,
): string {
  return box.encrypt(plaintext, {
    organizationId: owner.organizationId,
    purpose: META_SOCIAL_SECRET_PURPOSES[kind],
    subjectId: owner.id,
  });
}

export function openMetaSocialSecret(
  box: SecretBox,
  owner: { id: string; organizationId: string },
  kind: MetaSocialSecretKind,
  sealed: string,
): Secret<string> {
  return new Secret(
    box.decrypt(sealed, {
      organizationId: owner.organizationId,
      purpose: META_SOCIAL_SECRET_PURPOSES[kind],
      subjectId: owner.id,
    }),
  );
}

/** Page Access Token + App Secret tersimpan → kredensial klien Graph. */
export function openMetaSocialCredentials(
  box: SecretBox,
  channel: {
    id: string;
    organizationId: string;
    metaPageTokenEncrypted: string | null;
    metaAppSecretEncrypted: string | null;
  },
): MetaCredentials {
  if (channel.metaPageTokenEncrypted === null || channel.metaAppSecretEncrypted === null) {
    throw new Error('Channel tidak punya kredensial tersimpan');
  }
  return {
    accessToken: openMetaSocialSecret(box, channel, 'pageToken', channel.metaPageTokenEncrypted),
    appSecret: openMetaSocialSecret(box, channel, 'appSecret', channel.metaAppSecretEncrypted),
  };
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/** Notifikasi per permintaan yang diproses (sisanya dibuang). */
export const META_SOCIAL_MAX_EVENTS = 100;

const idSchema = z.string().regex(/^[0-9]{1,32}$/);
const attachmentSchema = z.object({
  type: z.string().max(32),
  payload: z
    .object({
      url: z.string().max(4096).optional(),
      title: z.string().max(1024).optional(),
      coordinates: z.object({ lat: z.number(), long: z.number() }).optional(),
    })
    .nullish(),
});
const messagingSchema = z.object({
  sender: z.object({ id: idSchema }),
  recipient: z.object({ id: idSchema }),
  timestamp: z.number().int().nonnegative().optional(),
  message: z
    .object({
      mid: z.string().min(1).max(256),
      text: z.string().max(8192).optional(),
      is_echo: z.boolean().optional(),
      attachments: z.array(attachmentSchema).max(10).optional(),
      reply_to: z.object({ mid: z.string().max(256) }).optional(),
      quick_reply: z.object({ payload: z.string().max(1024) }).optional(),
    })
    .optional(),
  postback: z
    .object({
      mid: z.string().max(256).optional(),
      title: z.string().max(1024).optional(),
      payload: z.string().max(1024).optional(),
    })
    .optional(),
  delivery: z
    .object({
      mids: z.array(z.string().max(256)).max(100).optional(),
      watermark: z.number().int().nonnegative(),
    })
    .optional(),
  read: z.object({ watermark: z.number().int().nonnegative() }).optional(),
});
const notificationSchema = z.object({
  object: z.enum(['page', 'instagram']),
  entry: z
    .array(
      z.object({
        id: idSchema,
        time: z.number().optional(),
        messaging: z.array(z.unknown()).max(1000).optional(),
      }),
    )
    .max(100),
});

export interface MetaSocialWebhookItem {
  dedupKey: string;
  externalId: string;
  kind: 'message' | 'status';
  event: ChannelInboundEvent;
  occurredAt: Date | null;
}

export interface MetaSocialWebhookSplit {
  /** Bentuk notifikasinya dikenali (object page/instagram). */
  recognized: boolean;
  items: MetaSocialWebhookItem[];
  invalid: number;
  misrouted: number;
  overLimit: number;
  /** Echo pesan kita sendiri / jenis yang tidak diproses. */
  ignored: number;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);

function attachmentKind(type: string): 'image' | 'audio' | 'video' | 'document' | null {
  switch (type) {
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'file':
      return 'document';
    default:
      return null;
  }
}

/**
 * Notifikasi (sudah lolos tanda tangan + JSON.parse) → kejadian per pesan/status untuk channel ini.
 * `ownerId` = ID Halaman (Messenger) / ID akun Instagram (Instagram).
 */
export function splitMetaSocialWebhook(
  body: unknown,
  channelType: 'messenger' | 'instagram',
  ownerId: string,
): MetaSocialWebhookSplit {
  const result: MetaSocialWebhookSplit = {
    recognized: false,
    items: [],
    invalid: 0,
    misrouted: 0,
    overLimit: 0,
    ignored: 0,
  };
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return result;
  const expectedObject = channelType === 'messenger' ? 'page' : 'instagram';
  if (parsed.data.object !== expectedObject) return result;
  result.recognized = true;

  for (const entry of parsed.data.entry) {
    if (entry.id !== ownerId) {
      result.misrouted += entry.messaging?.length ?? 1;
      continue;
    }
    for (const raw of entry.messaging ?? []) {
      if (result.items.length >= META_SOCIAL_MAX_EVENTS) {
        result.overLimit += 1;
        continue;
      }
      const item = messagingSchema.safeParse(raw);
      if (!item.success) {
        result.invalid += 1;
        continue;
      }
      const value = item.data;
      const occurredAt =
        value.timestamp !== undefined
          ? new Date(value.timestamp)
          : entry.time
            ? new Date(entry.time)
            : null;

      if (value.delivery || value.read) {
        // Status pesan KELUAR: pelanggan = penerima notifikasi ini adalah `sender`.
        const status = value.read ? 'read' : 'delivered';
        const watermark = value.read?.watermark ?? value.delivery?.watermark ?? 0;
        const mids = value.delivery?.mids ?? [];
        result.items.push({
          dedupKey: `${status === 'read' ? 'r' : 'd'}:${sha(`${value.sender.id}|${String(watermark)}|${mids.join(',')}`)}`,
          externalId: mids[0] ?? `watermark:${value.sender.id}`,
          kind: 'status',
          occurredAt,
          event: {
            kind: 'status',
            status,
            externalIds: mids,
            watermark: watermark > 0 ? new Date(watermark).toISOString() : null,
            recipientExternalUserId: value.sender.id,
          },
        });
        continue;
      }

      if (value.message?.is_echo || value.sender.id === ownerId) {
        result.ignored += 1;
        continue;
      }

      const base: Omit<ChannelInboundMessage, 'externalId' | 'type' | 'rawType'> = {
        kind: 'message',
        sentAt: (occurredAt ?? new Date()).toISOString(),
        sender: { externalUserId: value.sender.id, handle: null, displayName: null },
        text: null,
        media: null,
        location: null,
        replyToExternalId: value.message?.reply_to?.mid ?? null,
        reply: null,
        email: null,
      };

      if (value.postback) {
        const mid = value.postback.mid ?? `pb:${sha(JSON.stringify(raw))}`;
        result.items.push({
          dedupKey: `m:${mid}`.slice(0, 320),
          externalId: mid,
          kind: 'message',
          occurredAt,
          event: {
            ...base,
            externalId: mid,
            type: 'interactive',
            rawType: 'postback',
            text: cleanCustomerText(value.postback.title ?? null),
            reply: {
              kind: 'button_reply',
              id: cleanCustomerText(value.postback.payload ?? null),
              title: cleanCustomerText(value.postback.title ?? null),
            },
          },
        });
        continue;
      }

      const message = value.message;
      if (!message) {
        result.ignored += 1;
        continue;
      }
      const attachment = message.attachments?.[0];
      let event: ChannelInboundMessage = {
        ...base,
        externalId: message.mid,
        type: 'text',
        rawType: 'text',
        text: message.text?.replaceAll('\u0000', '') ?? null,
      };
      if (message.quick_reply) {
        event = {
          ...event,
          type: 'interactive',
          rawType: 'quick_reply',
          reply: {
            kind: 'button_reply',
            id: cleanCustomerText(message.quick_reply.payload),
            title: cleanCustomerText(message.text ?? null),
          },
        };
      } else if (attachment) {
        const kind = attachmentKind(attachment.type);
        const url = safeHttpUrl(attachment.payload?.url ?? null);
        const coordinates = attachment.payload?.coordinates;
        if (attachment.type === 'location' && coordinates) {
          event = {
            ...event,
            type: 'location',
            rawType: 'location',
            location: {
              latitude: Math.max(-90, Math.min(90, coordinates.lat)),
              longitude: Math.max(-180, Math.min(180, coordinates.long)),
              name: cleanCustomerText(attachment.payload?.title ?? null),
              address: null,
            },
          };
        } else if (kind && url && isMetaSocialCdnUrl(url)) {
          event = {
            ...event,
            type: kind,
            rawType: attachment.type.replace(/[^a-z_]/g, '_').slice(0, 64) || 'other',
            media: {
              kind,
              ref: url,
              mimeType: null,
              filename: null,
              sizeBytes: null,
              voice: false,
              animated: false,
              mediaFileId: null,
            },
          };
        } else {
          event = { ...event, type: 'unsupported', rawType: 'other' };
        }
      } else if (event.text === null || event.text.trim().length === 0) {
        event = { ...event, type: 'unsupported', rawType: 'other', text: null };
      }
      result.items.push({
        dedupKey: `m:${message.mid}`.slice(0, 320),
        externalId: message.mid,
        kind: 'message',
        occurredAt,
        event,
      });
    }
  }
  return result;
}

// ── Lampiran (unduhan tanpa token) ──────────────────────────────────────────

/** Host CDN Meta untuk lampiran Messenger/Instagram (akhiran domain). */
export const META_SOCIAL_CDN_HOST_SUFFIXES = [
  '.fbcdn.net',
  '.fbsbx.com',
  '.cdninstagram.com',
] as const;

export function isMetaSocialCdnUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return META_SOCIAL_CDN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// ── Kirim & tes ─────────────────────────────────────────────────────────────

const sendResponseSchema = z.object({
  recipient_id: z.string().optional(),
  message_id: z.string().min(1).max(256),
});

export type MetaSocialOutbound =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: 'image' | 'audio' | 'video' | 'document'; file: Blob; filename: string };

/** Kirim satu pesan (tanpa ulangan otomatis — bukan idempoten di sisi Meta). */
export async function sendMetaSocialMessage(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  pageId: string,
  recipientId: string,
  content: MetaSocialOutbound,
): Promise<{ messageId: string }> {
  if (content.type === 'text') {
    const response = await client.request(credentials, {
      operation: 'social_message.send',
      method: 'POST',
      path: [pageId, 'messages'],
      body: {
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text: content.text.slice(0, 2000) },
      },
      schema: sendResponseSchema,
      rateLimitGroup: 'messaging',
    });
    return { messageId: response.message_id };
  }
  const form = new FormData();
  form.set('recipient', JSON.stringify({ id: recipientId }));
  form.set('messaging_type', 'RESPONSE');
  form.set(
    'message',
    JSON.stringify({
      attachment: {
        type: content.kind === 'document' ? 'file' : content.kind,
        payload: { is_reusable: false },
      },
    }),
  );
  form.set('filedata', content.file, content.filename);
  const response = await client.request(credentials, {
    operation: 'social_message.send',
    method: 'POST',
    path: [pageId, 'messages'],
    form,
    schema: sendResponseSchema,
    rateLimitGroup: 'messaging',
  });
  return { messageId: response.message_id };
}

const pageSchema = z.object({ id: z.string(), name: z.string().optional() });
const igSchema = z.object({ id: z.string(), username: z.string().optional() });

/** Tes koneksi: Halaman (dan akun IG) terbaca dengan token ini. */
export async function readMetaSocialTarget(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  target: { pageId: string; instagramAccountId: string | null },
  signal?: AbortSignal,
): Promise<{ pageName: string | null; instagramUsername: string | null }> {
  const page = await client.request(credentials, {
    operation: 'social_page.read',
    method: 'GET',
    path: [target.pageId],
    query: { fields: 'id,name' },
    schema: pageSchema,
    signal,
  });
  let instagramUsername: string | null = null;
  if (target.instagramAccountId) {
    const ig = await client.request(credentials, {
      operation: 'social_instagram.read',
      method: 'GET',
      path: [target.instagramAccountId],
      query: { fields: 'id,username' },
      schema: igSchema,
      signal,
    });
    instagramUsername = ig.username ?? null;
  }
  return { pageName: page.name ?? null, instagramUsername };
}

/** Jenis galat Meta → kode tes koneksi channel sosial. */
export function metaSocialTestCode(
  kind: MetaErrorKind,
  step: 'page' | 'instagram',
): ConnectionTestCode {
  switch (kind) {
    case 'token_invalid':
    case 'token_expired':
      return 'meta_token_invalid';
    case 'app_secret_invalid':
      return 'meta_app_secret_invalid';
    case 'permission_denied':
      return 'meta_permission_denied';
    case 'not_found':
      return step === 'page' ? 'meta_page_not_found' : 'meta_instagram_not_found';
    case 'rate_limited':
      return 'rate_limited';
    case 'temporarily_unavailable':
      return 'meta_unavailable';
    case 'network_error':
      return 'network_error';
    case 'unexpected_response':
      return 'unexpected_response';
    default:
      return 'unknown';
  }
}
