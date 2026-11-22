import {
  apiKeys,
  channels,
  contacts,
  emailOutbound,
  emailTemplates,
  messages,
  type DbExecutor,
  type OutgoingEventRow,
} from '@balesin/db';
import {
  EMAIL_FAILURE_MESSAGES,
  EMAIL_FAILURE_REASONS,
  emailSenderId,
  storedEmailSenderVerification,
  type EmailFailureReason,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';

/**
 * Body webhook `email.*` (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §6), dibangun SAAT DISPATCH.
 * Kunci snake_case seperti event lain. Bcc TIDAK dibocorkan (hanya `bcc_count`); isi email & isi
 * balasan TIDAK dikirim. `metadata` dikembalikan apa adanya.
 */
export async function buildEmailEventData(
  db: DbExecutor,
  event: OutgoingEventRow,
): Promise<Record<string, unknown> | null> {
  if (!event.emailOutboundId) return null;
  const [row] = await db
    .select({
      email: emailOutbound,
      apiKeyName: apiKeys.name,
      channelAddress: channels.emailAddress,
      templateSlug: emailTemplates.slug,
    })
    .from(emailOutbound)
    .leftJoin(
      apiKeys,
      and(
        eq(apiKeys.organizationId, emailOutbound.organizationId),
        eq(apiKeys.id, emailOutbound.apiKeyId),
      ),
    )
    .leftJoin(
      channels,
      and(
        eq(channels.organizationId, emailOutbound.organizationId),
        eq(channels.id, emailOutbound.channelId),
      ),
    )
    .leftJoin(
      emailTemplates,
      and(
        eq(emailTemplates.organizationId, emailOutbound.organizationId),
        eq(emailTemplates.id, emailOutbound.templateId),
      ),
    )
    .where(
      and(
        eq(emailOutbound.organizationId, event.organizationId),
        eq(emailOutbound.id, event.emailOutboundId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const email = row.email;
  // Email kirim tes tidak pernah memicu webhook.
  if (email.source !== 'api') return null;
  const reason = email.failureReason as EmailFailureReason | null;
  const failure =
    reason && (EMAIL_FAILURE_REASONS as readonly string[]).includes(reason)
      ? { reason, message: EMAIL_FAILURE_MESSAGES[reason], smtp_code: email.smtpCode }
      : null;
  const data: Record<string, unknown> = {
    email: {
      id: email.id,
      status: email.status,
      api_key: email.apiKeyId ? { id: email.apiKeyId, name: row.apiKeyName ?? '' } : null,
      sender: {
        id: emailSenderId('channel', email.channelId ?? ''),
        kind: 'channel',
        address: row.channelAddress ?? email.fromAddress,
      },
      to: email.to.map((item) => ({ email: item.email, name: item.name })),
      cc: email.cc.map((item) => ({ email: item.email, name: item.name })),
      bcc_count: email.bcc.length,
      subject: email.subject,
      template:
        email.templateId && row.templateSlug
          ? { id: email.templateId, slug: row.templateSlug, version: email.templateVersion }
          : null,
      idempotency_key: email.idempotencyKey,
      metadata: email.metadata ?? null,
      conversation_id: email.conversationId,
      message_id: email.messageId,
      message_id_header: `<${email.messageIdHeader}>`,
      created_at: email.createdAt.toISOString(),
      sent_at: email.sentAt?.toISOString() ?? null,
      failure,
      rejected_recipients: email.rejectedRecipients,
    },
  };
  if (event.type === 'email.bounced') {
    data.bounce = {
      recipients: email.bounces.map((bounce) => ({
        recipient: bounce.recipient,
        status: bounce.status,
      })),
    };
  }
  if (event.type === 'email.replied') {
    if (!event.messageId) return null;
    const [reply] = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        extras: messages.extras,
        receivedAt: messages.receivedAt,
        occurredAt: messages.occurredAt,
        from: contacts.externalUserId,
      })
      .from(messages)
      .leftJoin(
        contacts,
        and(
          eq(contacts.organizationId, messages.organizationId),
          eq(contacts.id, messages.contactId),
        ),
      )
      .where(
        and(eq(messages.organizationId, event.organizationId), eq(messages.id, event.messageId)),
      )
      .limit(1);
    if (!reply) return null;
    data.reply = {
      message_id: reply.id,
      conversation_id: reply.conversationId,
      from: reply.from,
      received_at: (reply.receivedAt ?? reply.occurredAt).toISOString(),
      // Selain `pass` = pengirim tidak tepercaya (aturan bot KONTRAK-WEBHOOK-KELUAR).
      sender_verification: storedEmailSenderVerification(reply.extras.email ?? {}),
    };
  }
  return data;
}
