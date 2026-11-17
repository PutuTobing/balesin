import { cleanCustomerText } from '@balesin/core';
import { conversations, csatSurveys, type ConversationRow, type DbExecutor } from '@balesin/db';
import { parseCsatReply } from '@balesin/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

/**
 * Balasan pelanggan atas survei CSAT (Fase 5). Input TIDAK tepercaya:
 *  - skor hanya dari ID baris pilihan `csat:<survei>:<1–5>` (regex ketat) DAN survei itu milik kontak +
 *    channel pengirim, berstatus `sent`, dikirim ≤ 24 jam lalu — judul/teks balasan diabaikan;
 *  - jawaban skor DITEMPEL ke percakapan survei (yang sudah `resolved`) tanpa membukanya lagi,
 *    tanpa menambah antrian/belum dibaca, dan tanpa diteruskan ke bot/webhook;
 *  - komentar = pesan TEKS berikutnya ≤ 30 menit setelah menilai (dibersihkan, maks. 500); pesan itu
 *    tetap diproses biasa (bisa membuka percakapan baru) supaya keluhan tidak tertelan.
 * Baris survei dikunci `FOR UPDATE SKIP LOCKED` (urutan sama dengan pengirim CSAT: survei → percakapan).
 */

const SURVEY_TTL_MS = 24 * 60 * 60_000;
const COMMENT_WINDOW_MS = 30 * 60_000;

export async function matchCsatAnswer(
  tx: DbExecutor,
  input: {
    organizationId: string;
    contactId: string;
    channelId: string;
    replyId: string | null | undefined;
    receivedAt: Date;
  },
): Promise<ConversationRow | null> {
  const parsed = parseCsatReply(input.replyId);
  if (!parsed) return null;
  const [survey] = await tx
    .select({ id: csatSurveys.id, conversationId: csatSurveys.conversationId })
    .from(csatSurveys)
    .where(
      and(
        eq(csatSurveys.organizationId, input.organizationId),
        eq(csatSurveys.id, parsed.surveyId),
        eq(csatSurveys.contactId, input.contactId),
        eq(csatSurveys.channelId, input.channelId),
        eq(csatSurveys.status, 'sent'),
        sql`${csatSurveys.sentAt} > ${new Date(input.receivedAt.getTime() - SURVEY_TTL_MS)}`,
      ),
    )
    .limit(1)
    .for('update', { skipLocked: true });
  if (!survey) return null;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, input.organizationId),
        eq(conversations.id, survey.conversationId),
      ),
    )
    .limit(1)
    .for('update');
  if (!conversation) return null;
  await tx
    .update(csatSurveys)
    .set({ status: 'answered', score: parsed.score, answeredAt: input.receivedAt })
    .where(eq(csatSurveys.id, survey.id));
  return conversation;
}

export async function recordCsatComment(
  tx: DbExecutor,
  input: {
    organizationId: string;
    contactId: string;
    channelId: string;
    text: string | null;
    receivedAt: Date;
  },
): Promise<void> {
  const comment = cleanCustomerText(input.text, 500);
  if (!comment) return;
  const [survey] = await tx
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .where(
      and(
        eq(csatSurveys.organizationId, input.organizationId),
        eq(csatSurveys.contactId, input.contactId),
        eq(csatSurveys.channelId, input.channelId),
        eq(csatSurveys.status, 'answered'),
        isNull(csatSurveys.comment),
        sql`${csatSurveys.answeredAt} > ${new Date(input.receivedAt.getTime() - COMMENT_WINDOW_MS)}`,
        sql`${csatSurveys.answeredAt} <= ${input.receivedAt}`,
      ),
    )
    .orderBy(desc(csatSurveys.answeredAt))
    .limit(1)
    .for('update', { skipLocked: true });
  if (!survey) return;
  await tx
    .update(csatSurveys)
    .set({ comment, commentedAt: input.receivedAt })
    .where(eq(csatSurveys.id, survey.id));
}
