import { AppError } from '@balesin/core';
import {
  PG_ERROR_CODES,
  contacts,
  conversations,
  isPgError,
  quickReplies,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  QUICK_REPLIES_PER_ORGANIZATION_MAX,
  QUICK_REPLY_NAME_FALLBACK,
  renderQuickReply,
  type QuickReply,
} from '@balesin/shared';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { conversationScope, likePattern } from '../inbox/inbox.repo';

/**
 * Template percakapan / quick reply `/` (Fase 2 butir 9, docs/KONTRAK-API-INBOX.md "Quick reply").
 *
 * - Daftar + cari: `inbox.reply` (semua pemegangnya, termasuk Teknisi — template milik organisasi).
 * - Buat/ubah/hapus: `quick_replies.manage` (Owner/Admin/Supervisor), diaudit TANPA isi template
 *   (hanya shortcut + nama isian yang berubah).
 * - Pakai: `inbox.reply` + percakapan DALAM CAKUPAN → isi `{nama}`/`{agen}` + penghitung naik.
 *   Teksnya dikirim lewat endpoint kirim pesan biasa (batas kirim & jendela 24 jam tetap berlaku).
 */

export const QUICK_REPLY_NOT_FOUND = 'Balasan cepat tidak ditemukan.';

/** Isi template di audit dipotong (teks bisnis; cukup untuk menelusuri perubahan). */
const AUDIT_BODY_MAX = 3_500;
// Domain hanya dengan TLD yang dikenal (kurangi positif palsu "kata.kata", review hapus Info).
const LINK_PATTERN =
  /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|id|co|io|me|ly|info|biz|site|online|app|cc|top|shop|xyz|link|click|live|store|club|vip|win|icu|pw|tk|ml|ga|cf|gq|ru|cn|in|us|uk|sg|my|ai|dev|to|gl|gd|is|tv|ws|su)\b(?:\/[^\s]*)?/gi;
const LONG_NUMBER_PATTERN = /\d(?:[\s.-]?\d){7,}/g;

function matchesOf(
  text: string,
  pattern: RegExp,
  normalize: (value: string) => string,
): Set<string> {
  return new Set([...text.matchAll(pattern)].map((match) => normalize(match[0])));
}

/**
 * Tautan / angka panjang (≥ 8 digit, mis. rekening/telepon) yang BARU muncul di `next` dibanding
 * `previous` (review panel R1).
 */
export function riskyAdditions(previous: string, next: string): { links: number; numbers: number } {
  const linkOf = (value: string) => value.toLowerCase();
  const digitsOf = (value: string) => value.replace(/\D/g, '');
  const oldLinks = matchesOf(previous, LINK_PATTERN, linkOf);
  const oldNumbers = matchesOf(previous, LONG_NUMBER_PATTERN, digitsOf);
  const links = [...matchesOf(next, LINK_PATTERN, linkOf)].filter((link) => !oldLinks.has(link));
  const numbers = [...matchesOf(next, LONG_NUMBER_PATTERN, digitsOf)].filter(
    (number) => !oldNumbers.has(number),
  );
  return { links: links.length, numbers: numbers.length };
}

const clip = (text: string) =>
  text.length > AUDIT_BODY_MAX ? `${text.slice(0, AUDIT_BODY_MAX)}…` : text;

/** Metadata risiko: hanya bila pelaku BUKAN Owner dan ada tautan/angka baru. */
function riskOf(role: string, previous: string, next: string) {
  if (role === 'owner') return {};
  const added = riskyAdditions(previous, next);
  if (added.links === 0 && added.numbers === 0) return {};
  return { risky: true, addedLinks: added.links, addedNumbers: added.numbers };
}
const DUPLICATE = 'Shortcut itu sudah dipakai template lain.';
const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';

export interface QuickReplyContext {
  auth: AuthContext;
  client: ClientInfo;
}

export interface QuickReplyInput {
  shortcut: string;
  title: string;
  body: string;
}

export interface QuickRepliesService {
  list(organizationId: string, q?: string): Promise<QuickReply[]>;
  create(context: QuickReplyContext, input: QuickReplyInput): Promise<QuickReply>;
  update(
    context: QuickReplyContext,
    id: string,
    input: Partial<QuickReplyInput>,
  ): Promise<QuickReply>;
  remove(context: QuickReplyContext, id: string): Promise<void>;
  use(
    grant: PermissionGrant,
    agentName: string,
    id: string,
    conversationId: string,
  ): Promise<string>;
}

async function select(
  db: DbExecutor,
  organizationId: string,
  filter?: { id?: string; q?: string },
) {
  const rows = await db
    .select({
      row: quickReplies,
      updatedById: users.id,
      updatedByName: users.name,
    })
    .from(quickReplies)
    .leftJoin(
      users,
      and(
        eq(users.organizationId, quickReplies.organizationId),
        eq(users.id, quickReplies.updatedByUserId),
      ),
    )
    .where(
      and(
        eq(quickReplies.organizationId, organizationId),
        filter?.id === undefined ? undefined : eq(quickReplies.id, filter.id),
        filter?.q === undefined
          ? undefined
          : or(
              ilike(quickReplies.shortcut, likePattern(filter.q.replace(/^\/+/, ''))),
              ilike(quickReplies.title, likePattern(filter.q)),
            ),
      ),
    )
    .orderBy(desc(quickReplies.usageCount), asc(quickReplies.shortcut))
    .limit(QUICK_REPLIES_PER_ORGANIZATION_MAX);
  return rows.map(({ row, updatedById, updatedByName }): QuickReply => ({
    id: row.id,
    shortcut: row.shortcut,
    title: row.title,
    body: row.body,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedBy:
      updatedById !== null && updatedByName !== null
        ? { id: updatedById, name: updatedByName }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function duplicateShortcut(error: unknown): boolean {
  return isPgError(
    error,
    PG_ERROR_CODES.uniqueViolation,
    'quick_replies_organization_id_shortcut_unique',
  );
}

export function createQuickRepliesService(deps: {
  db: Database;
  now?: () => Date;
}): QuickRepliesService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function findOne(organizationId: string, id: string): Promise<QuickReply> {
    const [found] = await select(db, organizationId, { id });
    if (!found) throw new AppError('NOT_FOUND', { message: QUICK_REPLY_NOT_FOUND });
    return found;
  }

  async function guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (duplicateShortcut(error)) throw new AppError('CONFLICT', { message: DUPLICATE });
      throw error;
    }
  }

  return {
    list: (organizationId, q) => select(db, organizationId, q === undefined ? {} : { q }),

    async create({ auth, client }, input) {
      const id = await guard(() =>
        db.transaction(async (tx) => {
          const { role } = await assertActorStillAuthorized(tx, auth, 'quick_replies.manage');
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`quick-replies:${auth.organizationId}`}, 0))`,
          );
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(quickReplies)
            .where(eq(quickReplies.organizationId, auth.organizationId));
          if (Number(count?.total ?? 0) >= QUICK_REPLIES_PER_ORGANIZATION_MAX) {
            throw new AppError('CONFLICT', {
              message: `Sudah ada ${String(QUICK_REPLIES_PER_ORGANIZATION_MAX)} balasan cepat (batas). Hapus yang tidak dipakai dulu.`,
            });
          }
          const [row] = await tx
            .insert(quickReplies)
            .values({
              organizationId: auth.organizationId,
              ...input,
              createdByUserId: auth.user.id,
              updatedByUserId: auth.user.id,
            })
            .returning({ id: quickReplies.id });
          if (!row) throw new Error('Template tidak tersimpan');
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.quickReplyCreated,
            targetType: 'quick_reply',
            targetId: row.id,
            metadata: {
              shortcut: input.shortcut,
              next: { title: input.title, body: clip(input.body) },
              actorRole: role,
              ...riskOf(role, '', input.body),
            },
            client,
          });
          return row.id;
        }),
      );
      return findOne(auth.organizationId, id);
    },

    async update({ auth, client }, id, input) {
      await guard(() =>
        db.transaction(async (tx) => {
          const { role } = await assertActorStillAuthorized(tx, auth, 'quick_replies.manage');
          const [current] = await tx
            .select()
            .from(quickReplies)
            .where(
              and(eq(quickReplies.organizationId, auth.organizationId), eq(quickReplies.id, id)),
            )
            .for('update');
          if (!current) throw new AppError('NOT_FOUND', { message: QUICK_REPLY_NOT_FOUND });
          const changedFields = (['shortcut', 'title', 'body'] as const).filter(
            (field) => input[field] !== undefined && input[field] !== current[field],
          );
          if (changedFields.length === 0) return;
          await tx
            .update(quickReplies)
            .set({ ...input, updatedByUserId: auth.user.id })
            .where(
              and(eq(quickReplies.organizationId, auth.organizationId), eq(quickReplies.id, id)),
            );
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.quickReplyUpdated,
            targetType: 'quick_reply',
            targetId: id,
            metadata: {
              shortcut: input.shortcut ?? current.shortcut,
              previousShortcut: current.shortcut,
              changedFields,
              previous: { title: current.title, body: clip(current.body) },
              next: {
                title: input.title ?? current.title,
                body: clip(input.body ?? current.body),
              },
              actorRole: role,
              ...riskOf(role, current.body, input.body ?? current.body),
            },
            client,
          });
        }),
      );
      return findOne(auth.organizationId, id);
    },

    async remove({ auth, client }, id) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'quick_replies.manage');
        const [deleted] = await tx
          .delete(quickReplies)
          .where(and(eq(quickReplies.organizationId, auth.organizationId), eq(quickReplies.id, id)))
          .returning({
            shortcut: quickReplies.shortcut,
            title: quickReplies.title,
            body: quickReplies.body,
          });
        if (!deleted) throw new AppError('NOT_FOUND', { message: QUICK_REPLY_NOT_FOUND });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.quickReplyDeleted,
          targetType: 'quick_reply',
          targetId: id,
          metadata: {
            shortcut: deleted.shortcut,
            previous: { title: deleted.title, body: clip(deleted.body) },
          },
          client,
        });
      });
    },

    async use(grant, agentName, id, conversationId) {
      const [target] = await db
        .select({ name: contacts.name, profileName: contacts.profileName })
        .from(conversations)
        .innerJoin(
          contacts,
          and(
            eq(contacts.organizationId, conversations.organizationId),
            eq(contacts.id, conversations.contactId),
          ),
        )
        .where(
          and(
            eq(conversations.organizationId, grant.organizationId),
            eq(conversations.id, conversationId),
            conversationScope(grant),
          ),
        );
      if (!target) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
      const [used] = await db
        .update(quickReplies)
        .set({ usageCount: sql`${quickReplies.usageCount} + 1`, lastUsedAt: now() })
        .where(and(eq(quickReplies.organizationId, grant.organizationId), eq(quickReplies.id, id)))
        .returning({ body: quickReplies.body });
      if (!used) throw new AppError('NOT_FOUND', { message: QUICK_REPLY_NOT_FOUND });
      return renderQuickReply(used.body, {
        nama: target.name ?? target.profileName ?? QUICK_REPLY_NAME_FALLBACK,
        agen: agentName,
      });
    },
  };
}
