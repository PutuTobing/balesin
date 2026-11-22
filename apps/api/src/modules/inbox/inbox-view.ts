import { cleanFileName, safeHttpUrl } from '@balesin/core';
import type { ContactRow } from '@balesin/db';
import {
  MAX_SEND_ATTEMPTS,
  MESSAGE_MEDIA_KINDS,
  channelHasCustomerWindow,
  emailSenderVerificationSchema,
  interactiveMessageSchema,
  isRetryableFailure,
  outboundFailureMessage,
  outboundFailureReasonSchema,
  type Contact,
  type ContactSummary,
  type Conversation,
  type Message,
  type MessagePreview,
  type TagRef,
  storedEmailSenderVerification,
} from '@balesin/shared';
import { z } from 'zod';

import type { ConversationRowView, LastMessageRow, MessageRowView } from './inbox.repo';

/**
 * Baris database → bentuk respons inbox. Isian JSON (`media`, `location`, `extras`) divalidasi ulang
 * di sini: isian yang rusak dibuang (null), bukan dikirim apa adanya. ID media Meta, BSUID, `ctwaClid`,
 * dan payload mentah TIDAK PERNAH ikut.
 */

const PREVIEW_MAX = 200;

type ContactNames = Pick<ContactRow, 'number' | 'name' | 'profileName' | 'phone' | 'waUsername'> &
  Partial<Pick<ContactRow, 'channelType' | 'channelHandle'>>;

/**
 * Nama tampilan: nama dari tim → nama profil (WhatsApp/channel lain) → nomor → @username WhatsApp →
 * pengenal channel lain (@username Telegram/Instagram, alamat email) → "Kontak #n".
 */
export function contactDisplayName(contact: ContactNames): string {
  return (
    contact.name ??
    contact.profileName ??
    contact.phone ??
    (contact.waUsername ? `@${contact.waUsername}` : null) ??
    contact.channelHandle ??
    `Kontak #${String(contact.number)}`
  );
}

export function toContactSummary(contact: ContactNames & { id: string }): ContactSummary {
  const otherChannel = contact.channelType !== undefined && contact.channelType !== 'whatsapp';
  return {
    id: contact.id,
    number: contact.number,
    displayName: contactDisplayName(contact),
    nameSource: contact.name
      ? 'team'
      : contact.profileName
        ? otherChannel
          ? 'channel'
          : 'whatsapp'
        : 'none',
    phone: contact.phone,
    waUsername: contact.waUsername,
    channelHandle: contact.channelHandle ?? null,
  };
}

export function toContact(row: ContactRow, tags: TagRef[]): Contact {
  const attributes = z
    .array(z.object({ key: z.string(), value: z.string() }))
    .catch([])
    .parse(row.attributes);
  return {
    ...toContactSummary(row),
    tags,
    channelType: row.channelType,
    name: row.name,
    profileName: row.profileName,
    email: row.email,
    notes: row.notes,
    attributes,
    possibleDuplicateOfContactId: row.possibleDuplicateOfContactId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function truncate(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length > max ? `${codePoints.slice(0, max).join('')}…` : text;
}

export function toMessagePreview(row: LastMessageRow): MessagePreview {
  const text = row.type === 'reaction' ? row.reactionEmoji : row.text;
  return {
    direction: row.direction,
    type: row.type,
    text: text === null ? null : truncate(text, PREVIEW_MAX),
    status: row.status,
    createdAt: row.occurredAt.toISOString(),
  };
}

export function toConversation(
  row: ConversationRowView,
  lastMessage: LastMessageRow | undefined,
  now: Date,
  tags: TagRef[] = [],
): Conversation {
  const windowApplies = channelHasCustomerWindow(row.channel.type);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    channel: row.channel,
    contact: { ...toContactSummary(row.contact), tags },
    assignee: row.assignee,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    windowExpiresAt: windowApplies ? (row.windowExpiresAt?.toISOString() ?? null) : null,
    // Fase 6: channel tanpa jendela 24 jam (Telegram, Email) selalu boleh membalas.
    windowOpen:
      !windowApplies ||
      (row.windowExpiresAt !== null && row.windowExpiresAt.getTime() > now.getTime()),
    windowApplies,
    lastMessage: lastMessage ? toMessagePreview(lastMessage) : null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    firstAssignedAt: row.firstAssignedAt?.toISOString() ?? null,
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    department: row.department,
  };
}

const nullableText = z.string().nullable().catch(null);

// R2 (review kontak): dibersihkan lagi saat dibaca — juga untuk baris yang tersimpan sebelum
// pembersihan di worker.
const storedMediaSchema = z.object({
  kind: z.enum(MESSAGE_MEDIA_KINDS),
  mimeType: nullableText,
  filename: nullableText.transform(cleanFileName),
  voice: z.boolean().catch(false),
  animated: z.boolean().catch(false),
});

const storedLocationSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  name: nullableText,
  address: nullableText,
});

const storedInteractiveSchema = z.object({
  kind: z.enum(['button', 'button_reply', 'list_reply', 'nfm_reply', 'other']),
  id: nullableText,
  title: nullableText,
  description: nullableText,
});

const storedReferralSchema = z.object({
  sourceType: nullableText,
  sourceUrl: nullableText.transform(safeHttpUrl),
  headline: nullableText,
  body: nullableText,
});

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function toMessage(row: MessageRowView): Message {
  // Dari jsonb: bentuknya tidak dijamin sama dengan tipe TypeScript-nya.
  const extras = (
    typeof row.extras === 'object' && row.extras !== null ? row.extras : {}
  ) as Record<string, unknown>;
  const shared = extras.sharedContacts;
  return {
    id: row.id,
    number: row.number,
    direction: row.direction,
    senderKind: row.senderKind,
    type: row.type,
    rawType: row.rawType,
    text: row.text,
    media: parsed(storedMediaSchema, row.media),
    location: parsed(storedLocationSchema, row.location),
    interactive: parsed(storedInteractiveSchema, extras.interactive),
    interactiveMessage:
      row.direction === 'outbound'
        ? parsed(interactiveMessageSchema, extras.interactiveMessage)
        : null,
    template: templateOf(row.type, extras.template),
    email: emailOf(extras.email, row.direction, row.emailRecipient),
    reaction:
      row.type === 'reaction'
        ? { emoji: row.reactionEmoji, messageId: row.reactionToMessageId }
        : null,
    replyTo: row.replyToWamid !== null ? { messageId: row.replyToMessageId } : null,
    referral: parsed(storedReferralSchema, extras.referral),
    forwarded: extras.forwarded === true,
    sharedContactsCount:
      typeof shared === 'number' && Number.isInteger(shared) && shared > 0 ? shared : 0,
    status: row.status,
    errorCode: row.errorCode,
    failure: failureOf(row),
    senderUserId: row.senderUserId,
    senderName: row.senderName ?? null,
    mediaAvailable: row.media !== null || row.mediaFileId !== null,
    starredAt: row.starredAt?.toISOString() ?? null,
    createdAt: row.occurredAt.toISOString(),
  };
}

/** Daftar alamat tersimpan (jsonb): hanya string berbentuk alamat, maks. 100. */
const addressList = z
  .array(z.unknown())
  .catch([])
  .optional()
  .transform((list) =>
    (list ?? [])
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.length <= 254 && /^[^\s<>@]+@[^\s<>@]+$/.test(item),
      )
      .slice(0, 100),
  );

const storedEmailSchema = z.object({
  subject: nullableText,
  hasHtml: z.boolean().catch(false),
  authWarning: z.boolean().catch(false),
  senderVerification: emailSenderVerificationSchema.optional().catch(undefined),
  skippedAttachments: z.number().int().nonnegative().catch(0),
  // Tahap 9.0 — data lama tidak punya: `[]`. Isian rusak dibuang (bukan dikirim apa adanya).
  to: addressList,
  cc: addressList,
  bcc: addressList,
  replyAll: addressList,
});

/**
 * Fase 6 — info email (tanpa header utas mentah). Data lama tanpa `senderVerification` (review R1):
 * `fail` bila dulu diperingatkan, selain itu `unverified` (tidak pernah dianggap lolos).
 */
function emailOf(
  value: unknown,
  direction: MessageRowView['direction'],
  recipient: string | null,
): Message['email'] {
  const email = parsed(storedEmailSchema, value);
  if (!email) return null;
  const inbound = direction === 'inbound';
  return {
    ...email,
    // Tahap 9.0: Bcc hanya catatan pesan KELUAR; "Balas semua" & alamat tujuan hanya email MASUK.
    bcc: inbound ? [] : email.bcc,
    replyAll: inbound ? email.replyAll : [],
    recipient: inbound ? recipient : null,
    // Nilai asing = `fail` (penafsiran bersama, review bot P4-I2). Pesan KELUAR tidak punya pengirim
    // yang perlu diverifikasi (Info 4 review 9.0) → isian tidak dikirim.
    senderVerification: inbound
      ? storedEmailSenderVerification(
          value as { senderVerification?: unknown; authWarning?: unknown },
        )
      : undefined,
  };
}

const storedTemplateSchema = z.object({
  templateId: z.string().nullable().catch(null),
  name: z.string(),
  language: z.string(),
  category: z.string(),
});

/** Template yang dikirim (tanpa nilai variabel — isinya sudah ada di `text`). */
function templateOf(type: string, value: unknown): Message['template'] {
  if (type !== 'template') return null;
  const result = storedTemplateSchema.safeParse(value);
  if (!result.success) return null;
  const id = z.uuid().safeParse(result.data.templateId);
  return { ...result.data, templateId: id.success ? id.data : null };
}

/** Pesan keluar `failed` → alasan + penjelasan Indonesia + boleh dikirim ulang. */
export function failureOf(
  row: Pick<
    MessageRowView,
    'direction' | 'status' | 'failureReason' | 'errorCode' | 'sendAttempts'
  >,
): Message['failure'] {
  if (row.direction !== 'outbound' || row.status !== 'failed') return null;
  const parsedReason = outboundFailureReasonSchema.safeParse(row.failureReason);
  const reason = parsedReason.success ? parsedReason.data : 'delivery_failed';
  return {
    reason,
    code: row.errorCode,
    message: outboundFailureMessage(reason, row.errorCode),
    retryable: isRetryableFailure(reason, row.errorCode) && row.sendAttempts < MAX_SEND_ATTEMPTS,
  };
}
