import { parseDeliveryStatusReport, type Logger } from '@balesin/core';
import {
  emailOutbound,
  recordOutgoingEvent,
  type Channel,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import type { EmailBounce } from '@balesin/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Tahap 9.1 (docs/KONTRAK-API-EMAIL-KIRIM.md §5) — sambungan pemroses masuk Channel Email ke email
 * lewat API:
 *  - **Bounce**: email laporan pengiriman (RFC 3464, atau cadangan MAILER-DAEMON) yang dilewati
 *    pemolling dibaca dulu; `Message-ID` asli dicocokkan dengan `email_outbound.message_id_header`
 *    organisasi + channel ITU. `Action: failed` (5.x.x) → `bounces[]`, `bounced_at`, webhook
 *    `email.bounced`; semua penerima memantul → `bounced`. `delayed` diabaikan. DSN palsu hanya bisa
 *    memengaruhi email yang `Message-ID`-nya diketahui (bagian acak 128 bit).
 *  - **Balasan**: setelah email masuk disimpan, `In-Reply-To` + `References`-nya dicocokkan →
 *    `replied_at` (yang pertama) + webhook `email.replied` PER email balasan (isi tidak dikirim).
 * Tanpa alamat/isi di log.
 */

const BOUNCE_MATCH_MAX = 20;

export async function processEmailBounce(
  db: Database,
  channel: Pick<Channel, 'id' | 'organizationId'>,
  raw: Buffer,
  at: Date,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<number> {
  const report = await parseDeliveryStatusReport(raw).catch(() => null);
  if (!report || report.originalMessageIds.length === 0) return 0;
  const ids = [...new Set(report.originalMessageIds)].slice(0, BOUNCE_MATCH_MAX);
  let matched = 0;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(emailOutbound)
      .where(
        and(
          eq(emailOutbound.organizationId, channel.organizationId),
          eq(emailOutbound.channelId, channel.id),
          inArray(emailOutbound.messageIdHeader, ids),
        ),
      )
      .for('update');
    for (const row of rows) {
      if (row.status !== 'sent' && row.status !== 'bounced') continue;
      const recipients = [...row.to, ...row.cc, ...row.bcc].map((item) => item.email.toLowerCase());
      const known = new Set(row.bounces.map((bounce) => bounce.recipient));
      // Laporan baku: hanya `Action: failed` + status 5.x.x. Cadangan tanpa rincian penerima (review
      // 9.1 R8): hanya bila email itu SATU penerima — penerima lain tidak bisa ditandai memantul
      // lewat DSN palsu yang cukup tahu Message-ID.
      const failed =
        report.recipients.length > 0
          ? report.recipients.filter(
              (item) =>
                item.action === 'failed' && (item.status === null || item.status.startsWith('5')),
            )
          : report.standard || recipients.length !== 1
            ? []
            : recipients.map((recipient) => ({ recipient, action: 'failed', status: null }));
      const added: EmailBounce[] = failed
        .map((item) => ({ ...item, recipient: item.recipient.toLowerCase() }))
        .filter((item) => recipients.includes(item.recipient) && !known.has(item.recipient))
        .map((item) => ({
          recipient: item.recipient,
          status: item.status,
          action: 'failed',
          receivedAt: at.toISOString(),
        }));
      if (added.length === 0) continue;
      const bounces = [...row.bounces, ...added];
      const bouncedAll = new Set(bounces.map((bounce) => bounce.recipient));
      const allBounced = recipients.every((recipient) => bouncedAll.has(recipient));
      await tx
        .update(emailOutbound)
        .set({
          bounces,
          bouncedAt: sql`coalesce(${emailOutbound.bouncedAt}, ${at})`,
          ...(allBounced ? { status: 'bounced' } : {}),
        })
        .where(eq(emailOutbound.id, row.id));
      if (row.source === 'api') {
        await recordOutgoingEvent(tx, {
          organizationId: row.organizationId,
          type: 'email.bounced',
          emailOutboundId: row.id,
          conversationId: row.conversationId,
          contactId: row.contactId,
        });
      }
      matched += 1;
      logger.info(
        { emailId: row.id, bounced: added.length, allBounced },
        'Laporan bounce email API dicatat',
      );
    }
  });
  return matched;
}

export async function recordEmailApiReplies(
  tx: DbExecutor,
  input: {
    organizationId: string;
    channelId: string;
    messageId: string;
    conversationId: string;
    contactId: string;
    inReplyTo: string | null;
    references: readonly string[];
    at: Date;
  },
): Promise<void> {
  const ids = [
    ...new Set([input.inReplyTo, ...input.references].filter((id): id is string => !!id)),
  ].slice(0, 21);
  if (ids.length === 0) return;
  const rows = await tx
    .update(emailOutbound)
    .set({ repliedAt: sql`coalesce(${emailOutbound.repliedAt}, ${input.at})` })
    .where(
      and(
        eq(emailOutbound.organizationId, input.organizationId),
        eq(emailOutbound.channelId, input.channelId),
        inArray(emailOutbound.messageIdHeader, ids),
      ),
    )
    .returning({ id: emailOutbound.id, source: emailOutbound.source });
  for (const row of rows) {
    if (row.source !== 'api') continue;
    await recordOutgoingEvent(tx, {
      organizationId: input.organizationId,
      type: 'email.replied',
      emailOutboundId: row.id,
      // Pesan Inbox email balasan (untuk `data.reply`).
      messageId: input.messageId,
      conversationId: input.conversationId,
      contactId: input.contactId,
    });
  }
}
