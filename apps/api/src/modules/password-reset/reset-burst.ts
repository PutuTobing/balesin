import { accountTokens, auditLogs, users, type Database, type DbExecutor } from '@balesin/db';
import { and, countDistinct, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';

/**
 * Atur ulang password untuk BANYAK akun berbeda dalam waktu singkat (review akhir Fase 1 R5): pola
 * pengambilalihan massal (mis. setelah email pengirim dibelokkan, penyerang meminta tautan untuk
 * semua CS/Teknisi yang tidak wajib 2FA). Begitu tautan untuk `RESET_BURST_ACCOUNTS` akun berbeda
 * diantre dalam `RESET_BURST_WINDOW_MINUTES`, dicatat audit `auth.password_reset.burst` (kejadian
 * `password_reset_burst`, `warning`) dan semua Owner aktif diberi email — paling banyak sekali per
 * jendela per organisasi (penanda Redis).
 */
export const RESET_BURST_ACCOUNTS = 3;
export const RESET_BURST_WINDOW_MINUTES = 60;
const BURST_FLAG = 'atur-ulang-massal';

export async function detectResetBurst(deps: {
  db: Database;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  organizationId: string;
  latestUserId: string;
  client: ClientInfo;
  log: FastifyBaseLogger;
}): Promise<void> {
  const { db, limiter, notifier, organizationId } = deps;
  const since = sql`now() - ${sql.raw(`interval '${String(RESET_BURST_WINDOW_MINUTES)} minutes'`)}`;
  const [row] = await db
    .select({ accounts: countDistinct(accountTokens.userId) })
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.organizationId, organizationId),
        eq(accountTokens.purpose, 'password_reset'),
        gte(accountTokens.createdAt, since),
      ),
    );
  const accounts = Number(row?.accounts ?? 0);
  if (accounts < RESET_BURST_ACCOUNTS) return;
  const claimed = await limiter.claimFlag(
    BURST_FLAG,
    organizationId,
    RESET_BURST_WINDOW_MINUTES * 60,
  );
  if (!claimed) return;

  const auditLogId = await recordAudit(db, {
    organizationId,
    actorUserId: null,
    action: AUDIT_ACTIONS.passwordResetBurst,
    targetType: 'user',
    targetId: deps.latestUserId,
    metadata: { accounts, windowMinutes: RESET_BURST_WINDOW_MINUTES },
    client: deps.client,
  });
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  const occurredAt = new Date().toISOString();
  for (const owner of owners) {
    await notifier
      .securityNoticeAdmin({
        organizationId,
        recipientUserId: owner.id,
        subjectUserId: deps.latestUserId,
        event: 'password_reset_burst',
        occurredAt,
        auditLogId,
      })
      .catch((err: unknown) => {
        deps.log.warn({ err }, 'Gagal mengantre email permintaan atur ulang password massal');
      });
  }
}

/** Jendela "setelah email pengirim diubah" (review akhir Fase 1 sisa R5). */
export const RESET_AFTER_SENDER_CHANGE_HOURS = 72;

/**
 * `true` bila jalur kirim email organisasi diubah (kejadian `email_sender_changed`: audit
 * `settings.email.updated` dengan `ownersNotified`) dalam `RESET_AFTER_SENDER_CHANGE_HOURS` jam
 * terakhir. Reset password akun TANPA 2FA yang DISELESAIKAN dalam jendela itu ditandai
 * `afterEmailSenderChange` dan naik menjadi kejadian `warning` di ringkasan keamanan: pola
 * pengambilalihan "belokkan SMTP lalu reset akun CS/Teknisi satu per satu" (2 akun/jam pun lolos
 * dari deteksi burst).
 */
export async function emailSenderChangedRecently(
  db: DbExecutor,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.action, AUDIT_ACTIONS.emailSettingsUpdated),
        sql`${auditLogs.metadata} ->> 'ownersNotified' = 'true'`,
        gte(
          auditLogs.createdAt,
          sql`now() - ${sql.raw(`interval '${String(RESET_AFTER_SENDER_CHANGE_HOURS)} hours'`)}`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
