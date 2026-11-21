import {
  MESSAGE_JOBS,
  NOOP_INBOX_EVENT_PUBLISHER,
  type InboxEventPublisher,
  type Logger,
  type MetaGraphClient,
  type SecretBox,
} from '@balesin/core';
import {
  ALLOCATION_ROLES,
  agentStates,
  contacts,
  conversationAutoMessages,
  conversationEvents,
  conversations,
  departments,
  ensureAgentStates,
  loadWorkspaceSettings,
  messages,
  organizations,
  recordOutgoingEvent,
  workspaceSettings,
  type Database,
  type ResolvedWorkspaceSettings,
} from '@balesin/db';
import {
  QUICK_REPLY_NAME_FALLBACK,
  autoMessageName,
  TWO_FACTOR_REQUIRED_ROLES,
  isWithinTeamHours,
  renderAutoMessage,
  type AutoMessageKind,
  type TeamHours,
} from '@balesin/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { createBatchingPublisher } from './broadcast';
import { processSendMessageJob } from './messages';
import type { NotificationProducer } from './notifications';

/**
 * Job pemeliharaan `workspace-dispatch` (Fase 5, docs/KONTRAK-API-INBOX.md "Jam kerja, pesan
 * otomatis, alokasi"), tiap 10 detik:
 *
 * 1. **Round-robin** (organisasi bermode `round_robin`): percakapan `unserved` tanpa agen (tertua dulu)
 *    DALAM jam kerja tim (jam departemen percakapan bila diatur; hari libur = di luar jam kerja)
 *    ditugaskan ke agen yang paling lama tidak mendapat tugas otomatis, yang: aktif, berperan alokasi
 *    (cakupan `inbox.reply` penuh — bukan Teknisi), 2FA aktif bila perannya wajib 2FA, `available`,
 *    tidak `excluded`, belum penuh kapasitas (`served` terbuka < `maxOpenPerAgent`), dan anggota
 *    departemen percakapan (percakapan tanpa departemen: bukan pengguna bertanda departemen).
 *    ATOMIK: percakapan dikunci `FOR UPDATE SKIP LOCKED`, baris agen dikunci `FOR UPDATE SKIP LOCKED`
 *    lalu kapasitas dihitung ulang di transaksi yang sama → dua worker tidak pernah menugaskan dobel.
 *    Kejadian `assigned` dengan pelaku sistem (kosong), webhook `conversation.assigned`, push ke agen.
 * 2. **Pesan otomatis** sekali per sesi (`conversation_auto_messages`, unik per slot): sapaan / di luar
 *    jam kerja untuk percakapan baru dari PELANGGAN (pesan pertamanya masuk, ≤ 10 menit, tidak pernah
 *    ditangani bot), dan "saat ditangani agen" untuk kejadian `claimed`/`assigned` ≤ 15 menit. Hanya
 *    di jendela 24 jam; rem darurat → dilewati; dikirim lewat jalur kirim biasa (`sender_kind: system`).
 * Log hanya ID + jumlah (tanpa teks/nama).
 */

export interface WorkspaceJobDeps {
  db: Database;
  logger: Logger;
  meta?: MetaGraphClient;
  secretBox?: SecretBox | null;
  publisher?: InboxEventPublisher;
  notifications?: Pick<NotificationProducer, 'enqueue'>;
  now?: () => Date;
}

const WELCOME_LOOKBACK_MS = 10 * 60_000;
const ASSIGNED_LOOKBACK_MS = 15 * 60_000;
const BATCH = 50;

function uuidV7Floor(at: Date): string {
  const hex = Math.max(0, at.getTime()).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

async function departmentHours(
  db: Database,
  organizationId: string,
): Promise<Map<string, TeamHours>> {
  const rows = await db
    .select({ id: departments.id, teamHours: departments.teamHours })
    .from(departments)
    .where(eq(departments.organizationId, organizationId));
  const result = new Map<string, TeamHours>();
  for (const row of rows) if (row.teamHours) result.set(row.id, row.teamHours);
  return result;
}

function withinHours(
  settings: ResolvedWorkspaceSettings,
  byDepartment: ReadonlyMap<string, TeamHours>,
  departmentId: string | null,
  at: Date,
): boolean {
  const hours = (departmentId ? byDepartment.get(departmentId) : undefined) ?? settings.teamHours;
  return isWithinTeamHours(hours, settings.holidays, settings.timezone, at);
}

// ── Round-robin ─────────────────────────────────────────────────────────────

/** Tugaskan SATU percakapan (transaksi sendiri). `null` = tidak ada agen yang memenuhi syarat. */
async function assignOne(
  db: Database,
  settings: ResolvedWorkspaceSettings,
  conversationId: string,
  now: Date,
): Promise<{ agentId: string; contactId: string } | null> {
  const org = settings.organizationId;
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        departmentId: conversations.departmentId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, org),
          eq(conversations.id, conversationId),
          eq(conversations.status, 'unserved'),
          isNull(conversations.assigneeUserId),
        ),
      )
      .for('update', { skipLocked: true });
    if (!conversation) return null;
    const roles = sql.join(
      ALLOCATION_ROLES.map((role) => sql`${role}`),
      sql`, `,
    );
    const twoFactorRoles = sql.join(
      TWO_FACTOR_REQUIRED_ROLES.map((role) => sql`${role}`),
      sql`, `,
    );
    const departmentCondition = conversation.departmentId
      ? sql`exists (select 1 from department_members m where m.organization_id = ${org} and m.user_id = u.id and m.department_id = ${conversation.departmentId})`
      : sql`not (u.department_restricted and u.role in ('supervisor', 'cs'))`;
    // Agen dikunci SKIP LOCKED: transaksi lain yang sedang menugaskan ke agen yang sama dilewati,
    // jadi hitungan kapasitas di bawah tidak bisa dilampaui oleh penugasan bersamaan.
    const candidates = await tx.execute<{ user_id: string; open: number }>(sql`
      select s.user_id,
        (select count(*)::int from conversations c
          where c.organization_id = ${org} and c.assignee_user_id = s.user_id and c.status = 'served') as open
      from agent_states s
      join users u on u.organization_id = s.organization_id and u.id = s.user_id
      where s.organization_id = ${org}
        and s.available and not s.excluded
        and u.disabled_at is null
        and u.role in (${roles})
        and (u.role not in (${twoFactorRoles}) or u.totp_enabled_at is not null)
        and ${departmentCondition}
      order by s.last_assigned_at asc nulls first, s.user_id
      for update of s skip locked`);
    const agent = candidates.rows.find(
      (row) => settings.maxOpenPerAgent === null || Number(row.open) < settings.maxOpenPerAgent,
    );
    if (!agent) return null;
    await tx
      .update(conversations)
      .set({
        status: 'served',
        assigneeUserId: agent.user_id,
        firstAssignedAt: sql`coalesce(${conversations.firstAssignedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(and(eq(conversations.organizationId, org), eq(conversations.id, conversation.id)));
    await tx.insert(conversationEvents).values({
      organizationId: org,
      conversationId: conversation.id,
      kind: 'assigned',
      actorUserId: null,
      assigneeUserId: agent.user_id,
      previousAssigneeUserId: null,
    });
    await recordOutgoingEvent(tx, {
      organizationId: org,
      type: 'conversation.assigned',
      conversationId: conversation.id,
      contactId: conversation.contactId,
    });
    await tx
      .update(agentStates)
      .set({
        // Jam database yang terus berjalan (bukan `now` tetap per putaran): urutan giliran tetap
        // tegas walau beberapa penugasan terjadi di putaran yang sama.
        lastAssignedAt: sql`clock_timestamp()`,
      })
      .where(eq(agentStates.userId, agent.user_id));
    return { agentId: agent.user_id, contactId: conversation.contactId };
  });
}

async function autoAssign(
  deps: WorkspaceJobDeps,
  publisher: Pick<InboxEventPublisher, 'publish'>,
  now: Date,
): Promise<number> {
  const { db } = deps;
  const orgs = await db
    .select({ organizationId: workspaceSettings.organizationId })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.allocationMode, 'round_robin'));
  let assigned = 0;
  for (const { organizationId } of orgs) {
    const settings = await loadWorkspaceSettings(db, organizationId);
    const byDepartment = await departmentHours(db, organizationId);
    await ensureAgentStates(db, organizationId);
    const waiting = await db
      .select({ id: conversations.id, departmentId: conversations.departmentId })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.status, 'unserved'),
          isNull(conversations.assigneeUserId),
        ),
      )
      .orderBy(conversations.createdAt, conversations.id)
      .limit(BATCH);
    for (const conversation of waiting) {
      if (!withinHours(settings, byDepartment, conversation.departmentId, now)) continue;
      const result = await assignOne(db, settings, conversation.id, now);
      if (!result) continue;
      assigned += 1;
      await publisher.publish([
        { type: 'conversation.updated', organizationId, conversationId: conversation.id },
      ]);
      await deps.notifications?.enqueue([
        { organizationId, kind: 'assigned', conversationId: conversation.id },
      ]);
    }
  }
  return assigned;
}

// ── Pesan otomatis ─────────────────────────────────────────────────────────

/** Pesan PERTAMA percakapan berasal dari pelanggan (bukan broadcast/API/agen yang memulai). */
const customerStarted = sql`(select m.direction from messages m where m.organization_id = ${conversations.organizationId} and m.conversation_id = ${conversations.id} order by m.occurred_at, m.id limit 1) = 'inbound'`;

async function sendAuto(
  deps: WorkspaceJobDeps,
  publisher: InboxEventPublisher,
  target: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelId: string;
    kind: AutoMessageKind;
    text: string | null;
  },
  now: Date,
): Promise<'sent' | 'skipped' | 'failed'> {
  const { db } = deps;
  const slot = target.kind === 'assigned' ? 'assigned' : 'welcome';
  const outcome = await db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(conversationAutoMessages)
      .values({
        organizationId: target.organizationId,
        conversationId: target.conversationId,
        slot,
        kind: target.kind,
      })
      .onConflictDoNothing()
      .returning({ id: conversationAutoMessages.id });
    if (!claim) return null;
    const skip = async (reason: string) => {
      await tx
        .update(conversationAutoMessages)
        .set({ skipReason: reason })
        .where(eq(conversationAutoMessages.id, claim.id));
      return null;
    };
    if (target.text === null) return skip('disabled');
    const [organization] = await tx
      .select({ pausedAt: organizations.sendingPausedAt })
      .from(organizations)
      .where(eq(organizations.id, target.organizationId));
    if (organization?.pausedAt) return skip('sending_paused');
    const [conversation] = await tx
      .select({ windowExpiresAt: conversations.windowExpiresAt })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, target.organizationId),
          eq(conversations.id, target.conversationId),
        ),
      );
    if (!conversation?.windowExpiresAt || conversation.windowExpiresAt.getTime() <= now.getTime()) {
      return skip('window_closed');
    }
    const [message] = await tx
      .insert(messages)
      .values({
        organizationId: target.organizationId,
        conversationId: target.conversationId,
        contactId: target.contactId,
        channelId: target.channelId,
        direction: 'outbound',
        senderKind: 'system',
        type: 'text',
        text: target.text,
        status: 'pending',
        statusUpdatedAt: now,
        sendAttempts: 1,
        occurredAt: now,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('INSERT pesan otomatis tidak mengembalikan baris');
    await tx
      .update(conversationAutoMessages)
      .set({ messageId: message.id })
      .where(eq(conversationAutoMessages.id, claim.id));
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(conversations.organizationId, target.organizationId),
          eq(conversations.id, target.conversationId),
        ),
      );
    return message.id;
  });
  if (!outcome) return 'skipped';
  await publisher.publish([
    {
      type: 'message.created',
      organizationId: target.organizationId,
      conversationId: target.conversationId,
      messageId: outcome,
    },
  ]);
  if (!deps.meta) return 'sent';
  try {
    const result = await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: target.organizationId, messageId: outcome },
        attemptsMade: 4,
        opts: { attempts: 5 },
      },
      {
        db,
        logger: deps.logger,
        meta: deps.meta,
        secretBox: deps.secretBox ?? null,
        publisher,
        now: () => now,
      },
    );
    return result.status === 'failed' ? 'failed' : 'sent';
  } catch {
    return 'failed';
  }
}

/** `{nama}`: nama dari tim → profil WhatsApp, tautan dibuang (review jam kerja Info 3) → "Kak". */
const nameOf = (row: { name: string | null; profileName: string | null }) =>
  autoMessageName(row.name ?? row.profileName, QUICK_REPLY_NAME_FALLBACK);

async function autoMessages(
  deps: WorkspaceJobDeps,
  publisher: InboxEventPublisher,
  now: Date,
): Promise<{ sent: number; skipped: number; failed: number }> {
  const { db } = deps;
  const counts = { sent: 0, skipped: 0, failed: 0 };
  const tally = (result: 'sent' | 'skipped' | 'failed') => {
    counts[result] += 1;
  };
  const orgs = await db
    .select({ organizationId: workspaceSettings.organizationId })
    .from(workspaceSettings)
    .where(
      or(
        workspaceSettings.greetingEnabled,
        workspaceSettings.awayEnabled,
        workspaceSettings.assignedEnabled,
      ),
    );
  for (const { organizationId } of orgs) {
    const settings = await loadWorkspaceSettings(db, organizationId);
    const byDepartment = await departmentHours(db, organizationId);
    const { greeting, away, assigned } = settings.autoMessages;

    if (greeting.enabled || away.enabled) {
      const fresh = await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          channelId: conversations.channelId,
          departmentId: conversations.departmentId,
          createdAt: conversations.createdAt,
          name: contacts.name,
          profileName: contacts.profileName,
        })
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
            eq(conversations.organizationId, organizationId),
            inArray(conversations.status, ['unserved', 'served']),
            sql`${conversations.createdAt} > ${new Date(now.getTime() - WELCOME_LOOKBACK_MS).toISOString()}::timestamptz`,
            sql`${conversations.windowExpiresAt} > ${now.toISOString()}::timestamptz`,
            sql`not exists (select 1 from conversation_auto_messages a where a.conversation_id = ${conversations.id} and a.slot = 'welcome')`,
            // Pernah ditangani bot (sapaan urusan bot) → tidak.
            sql`not exists (select 1 from conversation_events e where e.organization_id = ${conversations.organizationId} and e.conversation_id = ${conversations.id} and e.kind in ('handoff', 'bot_resumed'))`,
            customerStarted,
          ),
        )
        .limit(BATCH);
      for (const row of fresh) {
        const inHours = withinHours(settings, byDepartment, row.departmentId, row.createdAt);
        const kind: AutoMessageKind = inHours ? 'greeting' : 'away';
        const config = settings.autoMessages[kind];
        tally(
          await sendAuto(
            deps,
            publisher,
            {
              organizationId,
              conversationId: row.id,
              contactId: row.contactId,
              channelId: row.channelId,
              kind,
              text: config.enabled ? renderAutoMessage(config.text, { nama: nameOf(row) }) : null,
            },
            now,
          ),
        );
      }
    }

    if (assigned.enabled) {
      const agent = sql`(select name from users where users.organization_id = ${conversations.organizationId} and users.id = ${conversations.assigneeUserId})`;
      const rows = await db
        .selectDistinct({
          id: conversations.id,
          contactId: conversations.contactId,
          channelId: conversations.channelId,
          name: contacts.name,
          profileName: contacts.profileName,
          agentName: sql<string | null>`${agent}`,
        })
        .from(conversationEvents)
        .innerJoin(
          conversations,
          and(
            eq(conversations.organizationId, conversationEvents.organizationId),
            eq(conversations.id, conversationEvents.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.organizationId, conversations.organizationId),
            eq(contacts.id, conversations.contactId),
          ),
        )
        .where(
          and(
            eq(conversationEvents.organizationId, organizationId),
            sql`${conversationEvents.id} > ${uuidV7Floor(new Date(now.getTime() - ASSIGNED_LOOKBACK_MS))}::uuid`,
            inArray(conversationEvents.kind, ['claimed', 'assigned']),
            eq(conversations.status, 'served'),
            sql`${conversations.assigneeUserId} = ${conversationEvents.assigneeUserId}`,
            sql`${conversations.windowExpiresAt} > ${now.toISOString()}::timestamptz`,
            sql`not exists (select 1 from conversation_auto_messages a where a.conversation_id = ${conversations.id} and a.slot = 'assigned')`,
            customerStarted,
          ),
        )
        .limit(BATCH);
      for (const row of rows) {
        tally(
          await sendAuto(
            deps,
            publisher,
            {
              organizationId,
              conversationId: row.id,
              contactId: row.contactId,
              channelId: row.channelId,
              kind: 'assigned',
              text: renderAutoMessage(assigned.text, {
                nama: nameOf(row),
                agen: row.agentName ?? 'Tim kami',
              }),
            },
            now,
          ),
        );
      }
    }
  }
  return counts;
}

export async function dispatchWorkspace(deps: WorkspaceJobDeps): Promise<Record<string, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const publisher = createBatchingPublisher(deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER);
  // Penugasan dulu: pesan "ditangani agen" untuk penugasan otomatis ikut terkirim di putaran ini.
  const assigned = await autoAssign(deps, publisher, now);
  const messagesResult = await autoMessages(deps, publisher, now);
  await publisher.flush();
  return { assigned, ...messagesResult };
}
