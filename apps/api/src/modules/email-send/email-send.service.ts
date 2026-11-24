import {
  AppError,
  classifyOutboundEmailAttachment,
  cleanFileName,
  contactIdentityLockKeys,
  emailExternalId,
  newOutboundMessageId,
  replySubject,
  sanitizeEmailHtml,
  type InboxBusEventInput,
  type InboxEventPublisher,
  type Logger,
  type Lookup,
  type MediaStore,
} from '@balesin/core';
import {
  apiKeyEmailSenders,
  apiKeys,
  channels,
  contacts,
  conversations,
  emailOutbound,
  emailOutboundAttachments,
  emailTemplateVersions,
  emailTemplates,
  isPgError,
  lockAdvisoryKeys,
  mediaFiles,
  messageEmailBodies,
  messages,
  organizations,
  PG_ERROR_CODES,
  recordOutgoingEvent,
  type Database,
  type DbExecutor,
  type EmailOutboundRow,
  type EmailRecipientRow,
  type EmailTemplateRow,
  type EmailTemplateVersionRow,
} from '@balesin/db';
import {
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_FAILURE_MESSAGES,
  EMAIL_FAILURE_REASONS,
  EMAIL_SENDER_QUEUE_FACTOR,
  EMAIL_TEMPLATE_HTML_MAX_BYTES,
  EMAIL_TEMPLATE_TEXT_MAX_BYTES,
  emailSenderId,
  parseEmailSenderId,
  type EmailFailureReason,
  type EmailOutboundStatus,
  type EmailReplyRequest,
  type EmailSendRequest,
  type EmailSendResponse,
  type EmailStatus,
  type PublicEmailSender,
} from '@balesin/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import { assertApiKeyStillAuthorized } from '../api-keys/api-key-actor';
import type { ApiKeyPrincipal } from '../api-keys/api-key-auth';
import type { SendingLimitsService } from '../sending-limits/sending-limits.service';
import { resolveAttachments, type PreparedAttachment } from './email-attachments';
import {
  cleanFromName,
  detail,
  emailError,
  invalid,
  normalizeRecipientAddress,
  normalizeRecipients,
  parseSchedule,
  requestHashOf,
  templateValues,
  validateMetadata,
  type NormalizedRecipient,
} from './email-content';
import {
  LOGO_CID,
  loadEmailBrand,
  prepareQris,
  renderEmail,
  renderFailure,
  type PreparedQris,
} from './email-render';
import {
  apiKeyChannelIds,
  domainOf,
  findChannelSender,
  loadChannelSenders,
  senderState,
  senderStats,
  type ChannelSender,
} from './senders';

/**
 * Email lewat API untuk n8n/billing (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §3). Urutan
 * pemeriksaan kirim = §3.2 (pola R1): TIDAK ADA data dibuat sebelum semua lolos. Penerimaan selalu
 * antre (202) — worker `email-outbound` memolling `email_outbound` (api tidak bergantung pada Redis).
 *
 * Log: hanya ID email, ID key, ID pengirim, jumlah penerima. TIDAK PERNAH subjek, isi, variabel,
 * metadata, payload QRIS, isi/nama lampiran, URL lampiran, atau alamat penerima utuh.
 */

export interface EmailSendServiceDeps {
  db: Database;
  store: MediaStore;
  sendingLimits: Pick<SendingLimitsService, 'assertCanSendEmail'>;
  publisher: InboxEventPublisher;
  logger: Logger;
  /** HANYA tes: lampiran URL ke server tiruan di loopback. */
  remote?: { lookup?: Lookup; allowLoopback?: boolean; perFileTimeoutMs?: number };
  now?: () => Date;
}

const UUID = z.uuid();
const SENDER_NOT_ALLOWED = 'API key ini tidak boleh mengirim lewat pengirim ini.';
const EMAIL_NOT_FOUND = 'Email tidak ditemukan.';
const MESSAGE_NOT_FOUND = 'Pesan email masuk tidak ditemukan.';
const INBOX_TEXT_MAX = 65_536;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Review 9.1 R3: total unggahan lampiran per API key per 24 jam. */
export const EMAIL_UPLOAD_QUOTA_BYTES_PER_DAY = 500 * 1024 * 1024;

export interface EmailPrincipal {
  organizationId: string;
  apiKeyId: string;
  dailySendLimit: number;
}

export const principalOf = (key: ApiKeyPrincipal): EmailPrincipal => ({
  organizationId: key.organizationId,
  apiKeyId: key.id,
  dailySendLimit: key.dailySendLimit,
});

function senderNotAllowed(field = 'senderId'): AppError {
  return emailError('FORBIDDEN', [detail(field, 'sender_not_allowed', SENDER_NOT_ALLOWED)]);
}

/** Template dari UUID atau slug. */
export async function findTemplate(
  db: DbExecutor,
  organizationId: string,
  ref: string,
): Promise<EmailTemplateRow | undefined> {
  const [row] = await db
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.organizationId, organizationId),
        UUID.safeParse(ref).success ? eq(emailTemplates.id, ref) : eq(emailTemplates.slug, ref),
      ),
    )
    .limit(1);
  return row;
}

export async function templateVersionRow(
  db: DbExecutor,
  templateId: string,
  version: number,
): Promise<EmailTemplateVersionRow | undefined> {
  const [row] = await db
    .select()
    .from(emailTemplateVersions)
    .where(
      and(
        eq(emailTemplateVersions.templateId, templateId),
        eq(emailTemplateVersions.version, version),
      ),
    )
    .limit(1);
  return row;
}

export type EmailContent =
  | {
      kind: 'template';
      template: EmailTemplateRow;
      version: EmailTemplateVersionRow;
      values: Record<string, string>;
    }
  | {
      kind: 'external';
      subject: string;
      html: string | null;
      text: string | null;
      layout: 'brand' | 'none';
    };

/** Langkah 7 (§3.3): template terbit + variabel, ATAU subjek/HTML/teks luar. */
async function resolveContent(
  db: DbExecutor,
  organizationId: string,
  body: Pick<EmailSendRequest, 'templateId' | 'variables' | 'subject' | 'html' | 'text' | 'layout'>,
  defaultSubject: string | null,
): Promise<EmailContent> {
  if (body.templateId !== undefined) {
    if (body.subject !== undefined || body.html !== undefined || body.text !== undefined) {
      throw invalid(
        'templateId',
        'content_conflict',
        'Pilih satu: templateId ATAU subject/html/text, jangan keduanya.',
      );
    }
    const template = await findTemplate(db, organizationId, body.templateId);
    if (!template) {
      throw emailError('NOT_FOUND', [
        detail('templateId', 'template_not_found', 'Template email tidak ditemukan.'),
      ]);
    }
    if (template.archivedAt) {
      throw emailError('CONFLICT', [
        detail('templateId', 'template_archived', 'Template ini diarsipkan.'),
      ]);
    }
    const version =
      template.publishedVersion === null
        ? undefined
        : await templateVersionRow(db, template.id, template.publishedVersion);
    if (!version) {
      throw emailError('CONFLICT', [
        detail('templateId', 'template_not_published', 'Template ini belum pernah diterbitkan.'),
      ]);
    }
    return {
      kind: 'template',
      template,
      version,
      values: templateValues(version.variables, body.variables),
    };
  }
  const subject = body.subject ?? defaultSubject;
  if (subject === null || (body.html === undefined && body.text === undefined)) {
    throw invalid(
      body.subject === undefined && defaultSubject === null ? 'subject' : 'html',
      'content_missing',
      'Isi email kosong. Kirim templateId, atau subject beserta html/text.',
    );
  }
  if (
    body.html !== undefined &&
    Buffer.byteLength(body.html, 'utf8') > EMAIL_TEMPLATE_HTML_MAX_BYTES
  ) {
    throw invalid('html', 'content_too_large', 'HTML email maksimal 512 KB.');
  }
  if (
    body.text !== undefined &&
    Buffer.byteLength(body.text, 'utf8') > EMAIL_TEMPLATE_TEXT_MAX_BYTES
  ) {
    throw invalid('text', 'content_too_large', 'Versi teks email maksimal 256 KB.');
  }
  return {
    kind: 'external',
    subject,
    html: body.html ?? null,
    text: body.text ?? null,
    layout: body.layout ?? 'none',
  };
}

export interface ComposedEmail {
  subject: string;
  html: string | null;
  text: string;
  sanitized: boolean;
  /** Logo, QRIS, gambar inline, dan lampiran (urutan posisi). */
  parts: PreparedAttachment[];
  templateId: string | null;
  templateVersionId: string | null;
  templateVersion: number | null;
}

/** Langkah 10: HTML final, versi teks, gambar inline; semua `cid:` yang dirujuk harus tersedia. */
export async function composeEmail(
  db: DbExecutor,
  organizationId: string,
  content: EmailContent,
  qris: PreparedQris | null,
  attachments: readonly PreparedAttachment[],
  layoutOverride?: 'brand' | 'none',
): Promise<ComposedEmail> {
  const brand = await loadEmailBrand(db, organizationId);
  const layout =
    content.kind === 'template'
      ? (layoutOverride ?? (content.version.layout as 'brand' | 'none'))
      : content.layout;
  const rendered = renderEmail(
    brand,
    content.kind === 'template'
      ? {
          subject: content.version.subject,
          html: content.version.html,
          text: content.version.text,
          layout,
          footerText: content.version.footerText,
          values: content.values,
          fromTemplate: true,
        }
      : {
          subject: content.subject,
          html: content.html,
          text: content.text,
          layout,
          footerText: null,
          values: {},
          fromTemplate: false,
        },
    { qris, inline: 'cid' },
  );
  if (!rendered.ok) renderFailure(rendered.errors);
  const parts: PreparedAttachment[] = [];
  const available = new Set<string>();
  const referenced = new Set(rendered.referencedCids.map((cid) => cid.toLowerCase()));
  if (brand.logoPng && referenced.has(LOGO_CID)) {
    available.add(LOGO_CID);
    parts.push({
      filename: 'logo.png',
      contentType: 'image/png',
      content: brand.logoPng,
      source: 'logo',
      sourceHost: null,
      inline: true,
      contentId: LOGO_CID,
    });
  }
  if (qris) {
    if (referenced.has(qris.cid.toLowerCase())) {
      available.add(qris.cid.toLowerCase());
      parts.push({
        filename: 'qris.png',
        contentType: 'image/png',
        content: qris.png,
        source: 'qris',
        sourceHost: null,
        inline: true,
        contentId: qris.cid,
      });
    }
    if (qris.attachFilename) {
      parts.push({
        filename: qris.attachFilename,
        contentType: 'image/png',
        content: qris.png,
        source: 'qris',
        sourceHost: null,
        inline: false,
        contentId: null,
      });
    }
  }
  for (const part of attachments) {
    if (part.contentId) available.add(part.contentId.toLowerCase());
    parts.push(part);
  }
  const missing = [...referenced].filter((cid) => !available.has(cid));
  if (missing.length > 0) {
    throw invalid(
      'html',
      'cid_missing',
      `HTML merujuk gambar cid:${missing[0] ?? ''}, tetapi gambarnya tidak dikirim.`,
    );
  }
  return {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    sanitized: content.kind === 'external' && rendered.sanitized,
    parts,
    templateId: content.kind === 'template' ? content.template.id : null,
    templateVersionId: content.kind === 'template' ? content.version.id : null,
    templateVersion: content.kind === 'template' ? content.version.version : null,
  };
}

/** Simpan berkas ke media store (`email-out/…`) SAAT diterima — coba ulang tidak mengambil URL lagi. */
export async function storeParts(
  store: MediaStore,
  parts: readonly PreparedAttachment[],
): Promise<{ part: PreparedAttachment; storageKey: string; sha256: string; sizeBytes: number }[]> {
  const saved: {
    part: PreparedAttachment;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
  }[] = [];
  try {
    for (const part of parts) {
      const file = await store.save('email-out', part.content);
      saved.push({ part, ...file });
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.map((item) => store.remove(item.storageKey).catch(() => undefined)));
    throw error;
  }
}

const recipientsJson = (items: readonly NormalizedRecipient[]): EmailRecipientRow[] =>
  items.map((item) => ({ email: item.email, name: item.name }));

export function failureOf(row: EmailOutboundRow): EmailStatus['failure'] {
  if (!row.failureReason) return null;
  const reason = (EMAIL_FAILURE_REASONS as readonly string[]).includes(row.failureReason)
    ? (row.failureReason as EmailFailureReason)
    : 'delivery_unknown';
  return { reason, message: EMAIL_FAILURE_MESSAGES[reason], smtpCode: row.smtpCode };
}

function formatFrom(name: string, address: string): string {
  return name ? `${name} <${address}>` : address;
}

export async function toEmailStatus(db: DbExecutor, row: EmailOutboundRow): Promise<EmailStatus> {
  const template = row.templateId
    ? (
        await db
          .select({ id: emailTemplates.id, slug: emailTemplates.slug })
          .from(emailTemplates)
          .where(
            and(
              eq(emailTemplates.organizationId, row.organizationId),
              eq(emailTemplates.id, row.templateId),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  const [channel] = row.channelId
    ? await db
        .select({ address: channels.emailAddress })
        .from(channels)
        .where(and(eq(channels.organizationId, row.organizationId), eq(channels.id, row.channelId)))
        .limit(1)
    : [];
  return {
    id: row.id,
    status: row.status as EmailOutboundStatus,
    source: row.source as EmailStatus['source'],
    sender: {
      id: emailSenderId('channel', row.channelId ?? ''),
      kind: 'channel',
      address: channel?.address ?? row.fromAddress,
    },
    from: formatFrom(row.fromName, row.fromAddress),
    to: row.to,
    cc: row.cc,
    bcc: row.bcc.map((item) => ({ email: item.email })),
    subject: row.subject,
    template: template
      ? { id: template.id, slug: template.slug, version: row.templateVersion }
      : null,
    sanitized: row.sanitized,
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata ?? null,
    conversationId: row.conversationId,
    messageId: row.messageId,
    messageIdHeader: `<${row.messageIdHeader}>`,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    bouncedAt: row.bouncedAt?.toISOString() ?? null,
    repliedAt: row.repliedAt?.toISOString() ?? null,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    attempts: row.attempts,
    failure: failureOf(row),
    rejectedRecipients: row.rejectedRecipients,
    bounces: row.bounces,
  };
}

function sendResponse(row: EmailOutboundRow): EmailSendResponse {
  return {
    id: row.id,
    status: row.status as EmailOutboundStatus,
    senderId: emailSenderId('channel', row.channelId ?? ''),
    recipientCount: row.recipientCount,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    conversationId: row.conversationId,
    messageId: row.messageId,
    sanitized: row.sanitized,
  };
}

export interface EmailSendService {
  senders(key: EmailPrincipal): Promise<PublicEmailSender[]>;
  send(
    key: EmailPrincipal,
    body: EmailSendRequest,
    idempotencyKey: string | undefined,
    client: ClientInfo,
  ): Promise<{ response: EmailSendResponse; created: boolean }>;
  reply(
    key: EmailPrincipal,
    messageId: string,
    body: EmailReplyRequest,
    idempotencyKey: string | undefined,
    client: ClientInfo,
  ): Promise<{ response: EmailSendResponse; created: boolean }>;
  status(key: EmailPrincipal, emailId: string): Promise<EmailStatus>;
  cancel(key: EmailPrincipal, emailId: string): Promise<EmailStatus>;
  upload(
    key: EmailPrincipal,
    senderId: string | undefined,
    file: { buffer: Buffer; filename: string | null },
  ): Promise<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    expiresAt: string;
  }>;
}

interface PersistInput {
  key: EmailPrincipal;
  sender: ChannelSender;
  composed: ComposedEmail;
  recipients: { to: NormalizedRecipient[]; cc: NormalizedRecipient[]; bcc: NormalizedRecipient[] };
  fromAddress: string;
  fromName: string;
  replyTo: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  scheduledAt: Date | null;
  /** `create` = catat ke Inbox (kontak + percakapan). `reply` = pesan masuk yang dibalas. */
  inbox:
    | { mode: 'none' }
    | { mode: 'create' }
    | {
        mode: 'reply';
        contactId: string;
        conversationId: string;
        replyToMessageId: string;
        inReplyTo: string | null;
        references: string[];
      };
}

export function createEmailSendService(deps: EmailSendServiceDeps): EmailSendService {
  const { db, store, sendingLimits, publisher, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function allowedChannelIds(key: EmailPrincipal): Promise<string[]> {
    return apiKeyChannelIds(db, key.organizationId, key.apiKeyId);
  }

  /** Langkah 4: pengirim ada di daftar key (403), tidak nonaktif (409). */
  async function allowedSender(key: EmailPrincipal, senderId: string): Promise<ChannelSender> {
    const parsed = parseEmailSenderId(senderId);
    if (!parsed || parsed.kind !== 'channel') throw senderNotAllowed();
    const ids = await allowedChannelIds(key);
    if (!ids.includes(parsed.id)) throw senderNotAllowed();
    const sender = await findChannelSender(db, key.organizationId, senderId);
    if (!sender) throw senderNotAllowed();
    if (!sender.enabled) {
      throw emailError('CONFLICT', [
        detail('senderId', 'sender_disabled', 'Channel pengirim sedang nonaktif.'),
      ]);
    }
    return sender;
  }

  /** Antrean pengirim penuh (> 24 × batas per jam PENERIMA menunggu) → 429. */
  async function assertQueueRoom(key: EmailPrincipal, sender: ChannelSender, recipients: number) {
    const stats = (await senderStats(db, key.organizationId, [sender.channelId], now())).get(
      sender.channelId,
    );
    if (
      stats &&
      stats.queued > 0 &&
      stats.queued + recipients > stats.hourlyLimit * EMAIL_SENDER_QUEUE_FACTOR
    ) {
      throw emailError(
        'RATE_LIMITED',
        [
          detail(
            'senderId',
            'sender_queue_full',
            'Antrean pengirim ini penuh. Tunggu, atau minta Owner/Admin menaikkan batas per jam.',
          ),
        ],
        { retryAfterSeconds: 600 },
      );
    }
  }

  async function byIdempotency(key: EmailPrincipal, idempotencyKey: string) {
    const [row] = await db
      .select()
      .from(emailOutbound)
      .where(
        and(
          eq(emailOutbound.organizationId, key.organizationId),
          eq(emailOutbound.apiKeyId, key.apiKeyId),
          eq(emailOutbound.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row;
  }

  /** Kunci sama + isi sama → ulangan (status terkini); isi beda → 409. */
  function replayOf(row: EmailOutboundRow, requestHash: string | null) {
    if (row.requestHash !== requestHash) {
      throw new AppError('CONFLICT', {
        message:
          'Idempotency-Key ini sudah dipakai untuk email lain dengan isi berbeda. Pakai kunci baru.',
        details: [
          {
            location: 'headers',
            field: 'Idempotency-Key',
            message:
              'Idempotency-Key ini sudah dipakai untuk email lain dengan isi berbeda. Pakai kunci baru.',
            reason: 'idempotency_key_reused',
          },
        ],
      });
    }
    return { response: sendResponse(row), created: false };
  }

  /** §3.6: `Reply-To` berdomain pengirim; SMTP sistem / catat Inbox = kosong atau alamat channel. */
  function resolveReplyTo(
    value: string | undefined,
    sender: ChannelSender,
    inboxBound: boolean,
  ): string | null {
    if (value === undefined || value.trim() === '') {
      return sender.smtpMode === 'system' ? sender.address : null;
    }
    const address = normalizeRecipientAddress(value);
    if (!address) {
      throw invalid('replyTo', 'reply_to_not_allowed', 'Alamat balas-ke tidak valid.');
    }
    if (sender.smtpMode === 'system' || inboxBound) {
      if (address !== sender.address) {
        throw invalid(
          'replyTo',
          'reply_to_not_allowed',
          'Untuk pengirim ini, alamat balas-ke hanya boleh alamat channel (supaya balasan masuk ke Inbox).',
        );
      }
      return address;
    }
    const domains = new Set([domainOf(sender.address), ...sender.aliases.map(domainOf)]);
    if (!domains.has(domainOf(address))) {
      throw invalid(
        'replyTo',
        'reply_to_not_allowed',
        'Alamat balas-ke harus memakai domain pengirim.',
      );
    }
    return address;
  }

  /** §3.6: alias "Dari" hanya alias channel SE-DOMAIN, SMTP custom. */
  function resolveFrom(value: string | undefined, sender: ChannelSender): string {
    if (value === undefined || value.trim() === '') return sender.fromAddress;
    const address = normalizeRecipientAddress(value);
    if (address && (address === sender.address || address === sender.fromAddress)) {
      return sender.fromAddress;
    }
    if (address && sender.smtpMode === 'custom' && sender.aliases.includes(address)) return address;
    throw invalid(
      'fromAddress',
      'from_address_not_allowed',
      'Alamat Dari ini bukan alamat atau alias pengirim.',
    );
  }

  async function keyHosts(key: EmailPrincipal): Promise<string[]> {
    const [row] = await db
      .select({ hosts: apiKeys.emailAttachmentHosts })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, key.organizationId), eq(apiKeys.id, key.apiKeyId)))
      .limit(1);
    return row?.hosts ?? [];
  }

  async function privateCidrs(organizationId: string): Promise<string[]> {
    const [org] = await db
      .select({ cidrs: organizations.webhookPrivateCidrs })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return org?.cidrs ?? [];
  }

  /** Kontak email (organisasi, `email`, alamat huruf kecil); nama hanya untuk kontak BARU. */
  async function ensureContact(
    tx: DbExecutor,
    organizationId: string,
    recipient: NormalizedRecipient,
  ): Promise<string> {
    await lockAdvisoryKeys(
      tx,
      contactIdentityLockKeys(organizationId, 'email', {
        bsuid: null,
        phone: null,
        externalUserId: recipient.email,
      }),
    );
    const [existing] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.channelType, 'email'),
          eq(contacts.externalUserId, recipient.email),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const [created] = await tx
      .insert(contacts)
      .values({
        organizationId,
        channelType: 'email',
        externalUserId: recipient.email,
        channelHandle: recipient.email,
        profileName: recipient.name,
        email: recipient.email,
      })
      .returning({ id: contacts.id });
    if (!created) throw new Error('INSERT kontak tidak mengembalikan baris');
    await recordOutgoingEvent(tx, {
      organizationId,
      type: 'contact.created',
      contactId: created.id,
    });
    return created.id;
  }

  /**
   * Percakapan (pola API template WhatsApp): terbuka kontak × channel dipakai; bila tidak ada, yang
   * terakhir (status tetap); bila tidak ada sama sekali, dibuat `resolved`.
   */
  async function conversationFor(
    tx: DbExecutor,
    organizationId: string,
    contactId: string,
    channelId: string,
    at: Date,
  ): Promise<string> {
    const [row] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.contactId, contactId),
          eq(conversations.channelId, channelId),
        ),
      )
      .orderBy(sql`(${conversations.status} <> 'resolved') desc`, desc(conversations.createdAt))
      .limit(1);
    if (row) return row.id;
    const [created] = await tx
      .insert(conversations)
      .values({
        organizationId,
        contactId,
        channelId,
        status: 'resolved',
        resolvedAt: at,
        lastMessageAt: at,
      })
      .returning({ id: conversations.id });
    if (!created) throw new Error('INSERT percakapan tidak mengembalikan baris');
    await recordOutgoingEvent(tx, {
      organizationId,
      type: 'conversation.created',
      conversationId: created.id,
      contactId,
    });
    return created.id;
  }

  /** Langkah 11: satu transaksi (email + lampiran (+ kontak, percakapan, pesan Inbox)). */
  async function persist(input: PersistInput): Promise<EmailOutboundRow> {
    const { key, sender, composed } = input;
    const at = now();
    const messageIdHeader = newOutboundMessageId(input.fromAddress);
    const saved = await storeParts(store, composed.parts);
    // Tampilan Inbox selalu lewat sanitasi profil MASUK (bukan profil keluar). Dihitung SEBELUM
    // transaksi (tidak menahan transaksi selama sanitasi); `composed.html` sudah lolos batas
    // kerumitan saat render (review 9.1 S3), jadi ini satu-satunya sanitasi tambahan.
    const inboxHtml =
      input.inbox.mode !== 'none' && composed.html ? sanitizeEmailHtml(composed.html) : '';
    const events: InboxBusEventInput[] = [];
    try {
      const row = await db.transaction(async (tx) => {
        // Pelaku dicek ulang di transaksi akhir: key belum dicabut + masih `email:send`, dan pengirim
        // masih di daftar key (pencabutan bersamaan menunggu `FOR SHARE`).
        await assertApiKeyStillAuthorized(tx, key, 'email:send', at);
        const [stillAllowed] = await tx
          .select({ id: apiKeyEmailSenders.id })
          .from(apiKeyEmailSenders)
          .where(
            and(
              eq(apiKeyEmailSenders.organizationId, key.organizationId),
              eq(apiKeyEmailSenders.apiKeyId, key.apiKeyId),
              eq(apiKeyEmailSenders.channelId, sender.channelId),
            ),
          )
          .for('share')
          .limit(1);
        if (!stillAllowed) throw senderNotAllowed();

        let contactId: string | null = null;
        let conversationId: string | null = null;
        let messageId: string | null = null;
        let replyToMessageId: string | null = null;
        let inReplyTo: string | null = null;
        let references: string[] = [];
        if (input.inbox.mode !== 'none') {
          if (input.inbox.mode === 'create') {
            const recipient = input.recipients.to[0];
            if (!recipient) throw new Error('Penerima catat Inbox kosong');
            contactId = await ensureContact(tx, key.organizationId, recipient);
            conversationId = await conversationFor(
              tx,
              key.organizationId,
              contactId,
              sender.channelId,
              at,
            );
          } else {
            contactId = input.inbox.contactId;
            conversationId = input.inbox.conversationId;
            replyToMessageId = input.inbox.replyToMessageId;
            inReplyTo = input.inbox.inReplyTo;
            references = input.inbox.references;
          }
          const [message] = await tx
            .insert(messages)
            .values({
              organizationId: key.organizationId,
              conversationId,
              contactId,
              channelId: sender.channelId,
              direction: 'outbound',
              senderKind: 'bot',
              apiKeyId: key.apiKeyId,
              type: 'text',
              status: 'pending',
              statusUpdatedAt: at,
              text: composed.text.slice(0, INBOX_TEXT_MAX) || composed.subject,
              wamid: emailExternalId(messageIdHeader),
              replyToMessageId,
              ...(inReplyTo ? { replyToWamid: inReplyTo.slice(0, 256) } : {}),
              extras: {
                email: {
                  subject: composed.subject,
                  inReplyTo,
                  references,
                  authWarning: false,
                  skippedAttachments: 0,
                  hasHtml: inboxHtml !== '',
                  to: input.recipients.to.map((item) => item.email),
                  cc: input.recipients.cc.map((item) => item.email),
                  bcc: input.recipients.bcc.map((item) => item.email),
                },
              },
              occurredAt: at,
            })
            .returning({ id: messages.id });
          if (!message) throw new Error('INSERT pesan tidak mengembalikan baris');
          messageId = message.id;
          if (inboxHtml !== '') {
            await tx.insert(messageEmailBodies).values({
              organizationId: key.organizationId,
              messageId,
              html: inboxHtml,
            });
          }
          await tx
            .update(conversations)
            .set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at})` })
            .where(
              and(
                eq(conversations.organizationId, key.organizationId),
                eq(conversations.id, conversationId),
              ),
            );
          events.push(
            {
              type: 'message.created',
              organizationId: key.organizationId,
              conversationId,
              messageId,
            },
            { type: 'conversation.updated', organizationId: key.organizationId, conversationId },
          );
        }

        const [created] = await tx
          .insert(emailOutbound)
          .values({
            organizationId: key.organizationId,
            source: 'api',
            apiKeyId: key.apiKeyId,
            senderKind: 'channel',
            channelId: sender.channelId,
            fromAddress: input.fromAddress,
            fromName: input.fromName,
            replyTo: input.replyTo,
            to: recipientsJson(input.recipients.to),
            cc: recipientsJson(input.recipients.cc),
            bcc: recipientsJson(input.recipients.bcc),
            recipientCount:
              input.recipients.to.length + input.recipients.cc.length + input.recipients.bcc.length,
            subject: composed.subject,
            html: composed.html,
            text: composed.text,
            sanitized: composed.sanitized,
            templateId: composed.templateId,
            templateVersionId: composed.templateVersionId,
            templateVersion: composed.templateVersion,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            metadata: input.metadata,
            conversationId,
            messageId,
            contactId,
            replyToMessageId,
            inReplyTo,
            references,
            messageIdHeader,
            status: input.scheduledAt ? 'scheduled' : 'queued',
            scheduledAt: input.scheduledAt,
            nextAttemptAt: input.scheduledAt ?? at,
          })
          .returning();
        if (!created) throw new Error('INSERT email tidak mengembalikan baris');
        if (saved.length > 0) {
          await tx.insert(emailOutboundAttachments).values(
            saved.map((item, position) => ({
              organizationId: key.organizationId,
              emailOutboundId: created.id,
              position,
              filename: item.part.filename.slice(0, 255),
              contentType: item.part.contentType,
              sizeBytes: item.sizeBytes,
              sha256: item.sha256,
              storageKey: item.storageKey,
              source: item.part.source,
              sourceHost: item.part.sourceHost,
              inline: item.part.inline,
              contentId: item.part.contentId,
            })),
          );
        }
        if (composed.templateId) {
          await tx
            .update(emailTemplates)
            .set({ lastUsedAt: at })
            .where(
              and(
                eq(emailTemplates.organizationId, key.organizationId),
                eq(emailTemplates.id, composed.templateId),
              ),
            );
        }
        return created;
      });
      await publisher.publish(events).catch(() => undefined);
      logger.info(
        {
          emailId: row.id,
          apiKeyId: key.apiKeyId,
          senderId: sender.id,
          recipientCount: row.recipientCount,
          status: row.status,
        },
        'Email API diterima',
      );
      return row;
    } catch (error) {
      await Promise.all(saved.map((item) => store.remove(item.storageKey).catch(() => undefined)));
      throw error;
    }
  }

  /** Urutan langkah 4–10 §3.2 bersama untuk `send` dan `reply`. */
  async function accept(
    key: EmailPrincipal,
    sender: ChannelSender,
    body: EmailReplyRequest & { scheduledAt?: string },
    /** Langkah 8 (dipanggil SETELAH rem/batas & isi): penerima ternormalisasi. */
    recipientsOf: () => PersistInput['recipients'],
    options: {
      client: ClientInfo;
      inbox: PersistInput['inbox'];
      defaultSubject: string | null;
      idempotencyKey: string | null;
      requestHash: string | null;
      /** Perkiraan murah jumlah penerima (digabung tanpa beda huruf) — untuk batas sebelum validasi. */
      recipientEstimate: number;
    },
  ): Promise<EmailOutboundRow> {
    const at = now();
    // 5–6. Rem darurat → 423; batas harian key (penerima pesan + email) → 429; antrean penuh → 429.
    await sendingLimits.assertCanSendEmail({
      organizationId: key.organizationId,
      apiKey: { id: key.apiKeyId, dailySendLimit: key.dailySendLimit },
      client: options.client,
      recipients: options.recipientEstimate,
    });
    await assertQueueRoom(key, sender, options.recipientEstimate);
    // 7. Isi.
    const content = await resolveContent(db, key.organizationId, body, options.defaultSubject);
    // 8. QRIS, alamat, metadata, jadwal.
    const qris = prepareQris(body.qris);
    const recipients = recipientsOf();
    const inboxBound = options.inbox.mode !== 'none';
    const replyTo = resolveReplyTo(body.replyTo, sender, inboxBound);
    const fromAddress = resolveFrom(body.fromAddress, sender);
    const requestedName = cleanFromName(body.fromName);
    // Review 9.1 R9: SMTP sistem dipakai bersama email keamanan (reset password/2FA) — nama
    // pengirim tidak bisa diganti lewat API supaya reputasinya tidak dipakai menyamar.
    if (
      sender.smtpMode === 'system' &&
      requestedName !== null &&
      requestedName !== sender.fromName
    ) {
      throw invalid(
        'fromName',
        'from_name_not_allowed',
        'Pengirim ini memakai SMTP sistem, jadi nama pengirim tidak bisa diganti. Pakai SMTP sendiri di Pengaturan → Channel untuk nama lain.',
      );
    }
    const fromName = requestedName ?? sender.fromName;
    const metadata = validateMetadata(body.metadata);
    const scheduledAt = parseSchedule(body.scheduledAt, at);
    // 9. Lampiran (URL diperiksa allowlist dulu, lalu diambil).
    const attachments = await resolveAttachments(db, body.attachments ?? [], {
      organizationId: key.organizationId,
      apiKeyId: key.apiKeyId,
      channelId: sender.channelId,
      allowedHosts: body.attachments?.some((item) => item.url !== undefined)
        ? await keyHosts(key)
        : [],
      privateCidrs: body.attachments?.some((item) => item.url !== undefined)
        ? await privateCidrs(key.organizationId)
        : [],
      reservedCids: [LOGO_CID, ...(qris ? [qris.cid] : [])],
      store,
      now: at,
      ...(deps.remote ? { remote: deps.remote } : {}),
    });
    // 10. Render.
    const composed = await composeEmail(
      db,
      key.organizationId,
      content,
      qris,
      attachments,
      body.layout,
    );
    // 11. Simpan.
    return persist({
      key,
      sender,
      composed,
      recipients,
      fromAddress,
      fromName,
      replyTo,
      idempotencyKey: options.idempotencyKey,
      requestHash: options.requestHash,
      metadata,
      scheduledAt,
      inbox: options.inbox,
    });
  }

  /** Bungkus idempotensi: kunci sama + isi sama → 200 status terkini; beda → 409; balapan → satu menang. */
  async function idempotent(
    key: EmailPrincipal,
    idempotencyKey: string | undefined,
    body: unknown,
    run: (requestHash: string | null) => Promise<EmailOutboundRow>,
  ): Promise<{ response: EmailSendResponse; created: boolean }> {
    const requestHash = idempotencyKey ? requestHashOf(body) : null;
    if (idempotencyKey) {
      const existing = await byIdempotency(key, idempotencyKey);
      if (existing) return replayOf(existing, requestHash);
    }
    try {
      return { response: sendResponse(await run(requestHash)), created: true };
    } catch (error) {
      if (
        idempotencyKey &&
        isPgError(error, PG_ERROR_CODES.uniqueViolation, 'email_outbound_idempotency_unique')
      ) {
        const existing = await byIdempotency(key, idempotencyKey);
        if (existing) return replayOf(existing, requestHash);
      }
      throw error;
    }
  }

  return {
    async senders(key) {
      const ids = await allowedChannelIds(key);
      const list = await loadChannelSenders(db, key.organizationId, ids);
      const at = now();
      const stats = await senderStats(
        db,
        key.organizationId,
        list.map((sender) => sender.channelId),
        at,
      );
      return list.map((sender) => {
        const stat = stats.get(sender.channelId);
        const state = senderState(sender, stat?.settings ?? null, at);
        return {
          id: sender.id,
          kind: sender.kind,
          name: sender.name,
          address: sender.address,
          fromAddress: sender.fromAddress,
          fromName: sender.fromName,
          aliases: sender.aliases,
          replyToFixed: sender.replyToFixed,
          bounceTracking: sender.bounceTracking,
          hourlyLimit: stat?.hourlyLimit ?? 0,
          sentLastHour: stat?.sentLastHour ?? 0,
          queued: stat?.queued ?? 0,
          state: state.state,
          throttledUntil: state.throttledUntil,
        };
      });
    },

    send(key, body, idempotencyKey, client) {
      return idempotent(key, idempotencyKey, body, async (requestHash) => {
        // 4. Pengirim.
        const sender = await allowedSender(key, body.senderId);
        const create = body.conversation === 'create';
        const recipientsOf = () => {
          const recipients = normalizeRecipients({ to: body.to, cc: body.cc, bcc: body.bcc });
          if (create && recipients.to.length !== 1) {
            throw invalid(
              'to',
              'conversation_requires_single_recipient',
              'Mencatat ke Inbox butuh tepat satu alamat di Kepada.',
            );
          }
          return recipients;
        };
        return accept(key, sender, body, recipientsOf, {
          client,
          recipientEstimate: estimateRecipients(body.to, body.cc, body.bcc),
          inbox: create ? { mode: 'create' } : { mode: 'none' },
          defaultSubject: null,
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
        });
      });
    },

    async reply(key, messageId, body, idempotencyKey, client) {
      if (!UUID.safeParse(messageId).success) {
        throw emailError('NOT_FOUND', [detail('id', 'message_not_found', MESSAGE_NOT_FOUND)]);
      }
      return idempotent(key, idempotencyKey, { messageId, ...body }, async (requestHash) => {
        const [found] = await db
          .select({
            message: messages,
            contactAddress: contacts.externalUserId,
            channelType: channels.type,
          })
          .from(messages)
          .innerJoin(
            channels,
            and(
              eq(channels.organizationId, messages.organizationId),
              eq(channels.id, messages.channelId),
            ),
          )
          .innerJoin(
            contacts,
            and(
              eq(contacts.organizationId, messages.organizationId),
              eq(contacts.id, messages.contactId),
            ),
          )
          .where(and(eq(messages.organizationId, key.organizationId), eq(messages.id, messageId)))
          .limit(1);
        const ids = await allowedChannelIds(key);
        if (
          !found ||
          found.message.direction !== 'inbound' ||
          found.channelType !== 'email' ||
          !found.message.extras.email ||
          !ids.includes(found.message.channelId)
        ) {
          throw emailError('NOT_FOUND', [detail('id', 'message_not_found', MESSAGE_NOT_FOUND)]);
        }
        const original = found.message;
        const email = original.extras.email;
        if (email?.senderVerification === 'fail') {
          throw emailError('CONFLICT', [
            detail(
              'id',
              'sender_verification_failed',
              'Pengirim email ini gagal verifikasi SPF/DKIM/DMARC, jadi tidak dibalas otomatis. Serahkan ke tim.',
            ),
          ]);
        }
        const sender = await allowedSender(key, emailSenderId('channel', original.channelId));
        const contactAddress = normalizeRecipientAddress(found.contactAddress ?? '');
        if (!contactAddress) {
          throw emailError('NOT_FOUND', [detail('id', 'message_not_found', MESSAGE_NOT_FOUND)]);
        }
        const thread = new Set(
          [...(email?.to ?? []), ...(email?.cc ?? []), contactAddress].map((item) =>
            item.toLowerCase(),
          ),
        );
        const recipientsOf = () => {
          const recipients = normalizeRecipients({
            to: [{ email: contactAddress }],
            cc: body.cc,
            bcc: body.bcc,
            toField: 'to',
          });
          recipients.cc.forEach((item, index) => {
            if (!thread.has(item.email)) {
              throw invalid(
                `cc.${String(index)}.email`,
                'cc_not_in_thread',
                'Cc balasan hanya boleh alamat yang sudah ada di utas ini.',
              );
            }
          });
          return recipients;
        };
        const inReplyTo =
          original.wamid && !original.wamid.startsWith('sha256:') ? original.wamid : null;
        const references = [...(email?.references ?? []), ...(inReplyTo ? [inReplyTo] : [])].slice(
          -20,
        );
        return accept(key, sender, body, recipientsOf, {
          client,
          recipientEstimate: estimateRecipients([{ email: contactAddress }], body.cc, body.bcc),
          inbox: {
            mode: 'reply',
            contactId: original.contactId,
            conversationId: original.conversationId,
            replyToMessageId: original.id,
            inReplyTo,
            references,
          },
          defaultSubject: replySubject(email?.subject ?? null),
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
        });
      });
    },

    async status(key, emailId) {
      if (!UUID.safeParse(emailId).success) {
        throw emailError('NOT_FOUND', [detail('id', 'email_not_found', EMAIL_NOT_FOUND)]);
      }
      const ids = await allowedChannelIds(key);
      const [row] =
        ids.length === 0
          ? []
          : await db
              .select()
              .from(emailOutbound)
              .where(
                and(
                  eq(emailOutbound.organizationId, key.organizationId),
                  eq(emailOutbound.id, emailId),
                  eq(emailOutbound.source, 'api'),
                  inArray(emailOutbound.channelId, ids),
                ),
              )
              .limit(1);
      if (!row) throw emailError('NOT_FOUND', [detail('id', 'email_not_found', EMAIL_NOT_FOUND)]);
      const status = await toEmailStatus(db, row);
      // Review 9.1 R1: Bcc, metadata, dan Idempotency-Key hanya untuk key PEMBUAT; key lain yang
      // berbagi pengirim melihat ringkasan tanpa itu.
      return row.apiKeyId === key.apiKeyId
        ? status
        : { ...status, bcc: [], metadata: null, idempotencyKey: null };
    },

    async cancel(key, emailId) {
      if (!UUID.safeParse(emailId).success) {
        throw emailError('NOT_FOUND', [detail('id', 'email_not_found', EMAIL_NOT_FOUND)]);
      }
      const at = now();
      const events: InboxBusEventInput[] = [];
      const row = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(emailOutbound)
          .where(
            and(
              eq(emailOutbound.organizationId, key.organizationId),
              eq(emailOutbound.id, emailId),
              eq(emailOutbound.apiKeyId, key.apiKeyId),
            ),
          )
          .for('update')
          .limit(1);
        if (!current) {
          throw emailError('NOT_FOUND', [detail('id', 'email_not_found', EMAIL_NOT_FOUND)]);
        }
        if (current.status !== 'scheduled' && current.status !== 'queued') {
          throw emailError('CONFLICT', [
            detail(
              'id',
              'not_cancelable',
              current.status === 'canceled'
                ? 'Email ini sudah dibatalkan.'
                : 'Email ini sudah dikirim, jadi tidak bisa dibatalkan.',
            ),
          ]);
        }
        const [updated] = await tx
          .update(emailOutbound)
          .set({ status: 'canceled', canceledAt: at })
          .where(
            and(
              eq(emailOutbound.organizationId, key.organizationId),
              eq(emailOutbound.id, emailId),
            ),
          )
          .returning();
        if (current.messageId && current.conversationId) {
          await tx
            .update(messages)
            .set({ status: 'failed', failureReason: 'canceled', statusUpdatedAt: at })
            .where(
              and(
                eq(messages.organizationId, key.organizationId),
                eq(messages.id, current.messageId),
                eq(messages.status, 'pending'),
              ),
            );
          await recordOutgoingEvent(tx, {
            organizationId: key.organizationId,
            type: 'message.status',
            conversationId: current.conversationId,
            messageId: current.messageId,
            contactId: current.contactId,
          });
          events.push(
            {
              type: 'message.status',
              organizationId: key.organizationId,
              conversationId: current.conversationId,
              messageId: current.messageId,
            },
            {
              type: 'conversation.updated',
              organizationId: key.organizationId,
              conversationId: current.conversationId,
            },
          );
        }
        return updated ?? current;
      });
      await publisher.publish(events).catch(() => undefined);
      logger.info({ emailId, apiKeyId: key.apiKeyId }, 'Email API dibatalkan');
      return toEmailStatus(db, row);
    },

    async upload(key, senderId, file) {
      if (!senderId) {
        throw invalid(
          'senderId',
          'sender_not_allowed',
          'Isian senderId wajib dikirim sebelum file.',
        );
      }
      const sender = await allowedSender(key, senderId);
      const filename = cleanFileName(file.filename) ?? 'lampiran';
      if (file.buffer.length > EMAIL_ATTACHMENT_MAX_BYTES) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Ukuran lampiran maksimal 20 MB.' });
      }
      const verdict = classifyOutboundEmailAttachment(file.buffer, filename);
      if (!verdict.ok) {
        throw invalid(
          'file',
          verdict.reason === 'empty' ? 'attachment_source_invalid' : 'attachment_type_blocked',
          verdict.reason === 'empty'
            ? 'Berkas lampiran kosong.'
            : 'Jenis berkas ini tidak boleh dilampirkan (program, makro, HTML, arsip, atau dokumen Office lama .doc/.xls/.ppt — pakai PDF atau .docx/.xlsx/.pptx).',
        );
      }
      const at = now();
      // Review 9.1 R3: kuota unggah per key per 24 jam; unggahan API berumur pendek (24 jam — isi
      // disalin ke `email-out/` saat email diterima, jadi email terjadwal tetap aman).
      const [usage] = await db
        .select({ total: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint` })
        .from(mediaFiles)
        .where(
          and(
            eq(mediaFiles.organizationId, key.organizationId),
            eq(mediaFiles.uploadedByApiKeyId, key.apiKeyId),
            sql`${mediaFiles.createdAt} > ${new Date(at.getTime() - DAY_MS)}`,
          ),
        );
      if (Number(usage?.total ?? 0) + file.buffer.length > EMAIL_UPLOAD_QUOTA_BYTES_PER_DAY) {
        throw emailError(
          'RATE_LIMITED',
          [
            detail(
              'file',
              'upload_quota',
              'Kuota unggah lampiran API key ini (500 MB per 24 jam) sudah habis. Coba lagi nanti.',
            ),
          ],
          { retryAfterSeconds: 3600 },
        );
      }
      const expiresAt = new Date(at.getTime() + DAY_MS);
      const stored = await store.save('uploads', file.buffer);
      try {
        const [row] = await db
          .insert(mediaFiles)
          .values({
            organizationId: key.organizationId,
            channelId: sender.channelId,
            source: 'upload',
            kind: verdict.rasterImage ? 'image' : 'document',
            mimeType: verdict.mimeType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            filename: verdict.filename,
            storageKey: stored.storageKey,
            uploadedByApiKeyId: key.apiKeyId,
            expiresAt,
          })
          .returning({ id: mediaFiles.id });
        if (!row) throw new Error('INSERT media tidak mengembalikan baris');
        return {
          id: row.id,
          filename: verdict.filename,
          mimeType: verdict.mimeType,
          sizeBytes: stored.sizeBytes,
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        await store.remove(stored.storageKey).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** Jumlah alamat unik (tanpa beda huruf) di daftar penerima — perkiraan murah sebelum validasi. */
export function estimateRecipients(...lists: (readonly { email: string }[] | undefined)[]): number {
  const unique = new Set<string>();
  for (const list of lists)
    for (const item of list ?? []) unique.add(item.email.trim().toLowerCase());
  return Math.max(1, unique.size);
}
