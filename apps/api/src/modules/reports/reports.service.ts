import { AppError } from '@balesin/core';
import {
  PG_ERROR_CODES,
  csatSettings,
  isPgError,
  loadBroadcastSettings,
  organizations,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  DEFAULT_CSAT_SETTINGS,
  META_FREE_SERVICE_CONVERSATIONS,
  TEMPLATE_CATEGORIES,
  broadcastRateFor,
  type AgentPerformance,
  type ChannelCost,
  type CsatSettings,
  type CsatSettingsValues,
  type CsatStats,
  type DurationStats,
  type PermissionScope,
  type ReportCosts,
  type ReportExportQuery,
  type ReportPerformance,
  type ReportRangeQuery,
  type TagColor,
  type TemplateCategory,
  type UserRole,
} from '@balesin/shared';
import { eq, sql, type SQL } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized } from '../auth/actor-check';
import { csvCell } from '../../http/csv';
import type { AuthContext } from '../auth/session.service';
import { addDays, uuidV7Floor, zonedMonth, zonedRange } from './report-time';

/**
 * Laporan kinerja, biaya pesan Meta, ekspor CSV, dan pengaturan CSAT (Fase 5,
 * docs/KONTRAK-API-LAPORAN.md).
 *
 * - Query dihitung langsung dari tabel inti (tanpa tabel ringkasan) di dalam transaksi baca dengan
 *   `statement_timeout` 8 dtk; rentang maks. 92 hari; percakapan/kejadian disaring lewat batas UUIDv7
 *   (indeks primary key) + `created_at` (margin 1 hari untuk selisih jam aplikasi/DB).
 * - Cakupan `own` (CS/Teknisi): hanya baris agennya sendiri + CSAT percakapannya; bagian organisasi
 *   `null`. Biaya & ekspor organisasi = cakupan `all` saja (`forbidByRule reports.organization`).
 * - Tanpa isi pesan / nomor pelanggan di hasil maupun log (komentar CSAT hanya di ekspor CSAT).
 */

export interface ReportsServiceDeps {
  db: Database;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}

const STATEMENT_TIMEOUT = sql.raw(`set local statement_timeout = '8s'`);
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;

function durationOf(row: Row | undefined, prefix: string): DurationStats {
  return {
    count: num(row?.[`${prefix}_count`]),
    averageSeconds: numOrNull(row?.[`${prefix}_avg`]),
    medianSeconds: numOrNull(row?.[`${prefix}_p50`]),
    p90Seconds: numOrNull(row?.[`${prefix}_p90`]),
  };
}

/** Kolom agregat durasi (detik) untuk ekspresi `value` yang memenuhi `filter`. */
function durationColumns(value: SQL, filter: SQL, prefix: string): SQL {
  return sql`count(*) filter (where ${filter}) as ${sql.raw(`${prefix}_count`)},
    avg(${value}) filter (where ${filter}) as ${sql.raw(`${prefix}_avg`)},
    percentile_cont(0.5) within group (order by ${value}) filter (where ${filter}) as ${sql.raw(`${prefix}_p50`)},
    percentile_cont(0.9) within group (order by ${value}) filter (where ${filter}) as ${sql.raw(`${prefix}_p90`)}`;
}

function emptyCsat(): CsatStats {
  return {
    sent: 0,
    responses: 0,
    average: null,
    distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    responseRate: null,
  };
}

function csatFrom(rows: Row[]): CsatStats {
  const stats = emptyCsat();
  let total = 0;
  for (const row of rows) {
    const count = num(row.total);
    const status = String(row.status);
    if (status === 'sent' || status === 'answered' || status === 'expired') stats.sent += count;
    if (status === 'answered' && row.score !== null) {
      stats.responses += count;
      total += num(row.score) * count;
      const key = String(num(row.score)) as keyof CsatStats['distribution'];
      if (Object.hasOwn(stats.distribution, key)) stats.distribution[key] += count;
    }
  }
  stats.average = stats.responses > 0 ? Math.round((total / stats.responses) * 100) / 100 : null;
  stats.responseRate =
    stats.sent > 0 ? Math.round((stats.responses / stats.sent) * 1000) / 10 : null;
  return stats;
}

export function createReportsService(deps: ReportsServiceDeps) {
  const { db, accessDenied } = deps;
  const now = deps.now ?? (() => new Date());

  async function timezoneOf(executor: DbExecutor, organizationId: string): Promise<string> {
    const [org] = await executor
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return org?.timezone ?? 'Asia/Jakarta';
  }

  /** Transaksi baca dengan batas waktu query; batas waktu → 503 berpesan Indonesia. */
  async function readOnly<T>(run: (tx: DbExecutor) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(STATEMENT_TIMEOUT);
        return run(tx);
      });
    } catch (error) {
      if (isPgError(error, PG_ERROR_CODES.queryCanceled)) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message:
            'Laporan terlalu berat untuk dihitung sekarang. Persempit rentang tanggal lalu coba lagi.',
        });
      }
      throw error;
    }
  }

  async function organizationOnly(auth: AuthContext, scope: PermissionScope, client: ClientInfo) {
    if (scope === 'all') return;
    await forbidByRule(accessDenied, {
      auth,
      rule: ACCESS_RULES.reportsOrganization,
      client,
      message: 'Laporan tingkat organisasi hanya untuk Owner, Admin, dan Supervisor.',
    });
  }

  async function performance(
    organizationId: string,
    userId: string,
    scope: PermissionScope,
    query: ReportRangeQuery,
  ): Promise<ReportPerformance> {
    return readOnly(async (tx) => {
      const timezone = await timezoneOf(tx, organizationId);
      const { start, end } = zonedRange(query.from, query.to, timezone);
      const lo = uuidV7Floor(new Date(start.getTime() - DAY_MS));
      const hi = uuidV7Floor(new Date(end.getTime() + DAY_MS));
      const channel = query.channelId ? sql`and c.channel_id = ${query.channelId}` : sql``;
      const messageChannel = query.channelId ? sql`and m.channel_id = ${query.channelId}` : sql``;
      const own = scope !== 'all';
      // Percakapan dalam rentang + penanda yang dipakai beberapa bagian.
      const base = sql`
        select c.id, c.contact_id, c.status, c.created_at, c.first_response_at, c.first_assigned_at,
          c.resolved_at, c.last_inbound_at,
          (select min(e.created_at) from conversation_events e
            where e.conversation_id = c.id and e.kind = 'handoff') as handoff_at,
          exists (select 1 from messages m where m.conversation_id = c.id and m.direction = 'outbound'
            and m.sender_kind = 'agent') as human,
          exists (select 1 from messages m where m.conversation_id = c.id and m.direction = 'outbound'
            and m.sender_kind = 'bot') as bot
        from conversations c
        where c.organization_id = ${organizationId} and c.id >= ${lo}::uuid and c.id < ${hi}::uuid
          and c.created_at >= ${start} and c.created_at < ${end} ${channel}`;
      const firstResponse = sql`extract(epoch from (first_response_at - created_at))`;
      const wait = sql`extract(epoch from (first_assigned_at - coalesce(handoff_at, created_at)))`;
      const resolution = sql`extract(epoch from (resolved_at - created_at))`;

      let summary: ReportPerformance['summary'] = null;
      let trends: ReportPerformance['trends'] = null;
      let bots: ReportPerformance['bots'] = null;
      let tags: ReportPerformance['tags'] = null;
      if (!own) {
        const [row] = (
          await tx.execute<Row>(sql`
            with c as (${base})
            select count(*) as conversations,
              count(*) filter (where last_inbound_at is not null) as customer_initiated,
              count(*) filter (where status = 'resolved') as resolved,
              count(*) filter (where status = 'resolved' and not human and bot) as bot_only,
              count(*) filter (where human) as human,
              count(handoff_at) as handoffs,
              ${durationColumns(firstResponse, sql`last_inbound_at is not null and first_response_at is not null and first_response_at >= created_at`, 'fr')},
              ${durationColumns(wait, sql`first_assigned_at is not null and first_assigned_at >= coalesce(handoff_at, created_at)`, 'wait')},
              ${durationColumns(resolution, sql`status = 'resolved' and resolved_at is not null and resolved_at >= created_at`, 'res')}
            from c`)
        ).rows;
        summary = {
          conversations: num(row?.conversations),
          customerInitiated: num(row?.customer_initiated),
          resolved: num(row?.resolved),
          resolvedByBotOnly: num(row?.bot_only),
          handledByHuman: num(row?.human),
          handoffs: num(row?.handoffs),
          firstResponse: durationOf(row, 'fr'),
          wait: durationOf(row, 'wait'),
          resolution: durationOf(row, 'res'),
        };

        const daily = (
          await tx.execute<Row>(sql`
            with c as (${base})
            select to_char(created_at at time zone ${timezone}, 'YYYY-MM-DD') as day,
              count(*) as conversations,
              count(*) filter (where status = 'resolved') as resolved,
              avg(${firstResponse}) filter (where last_inbound_at is not null and first_response_at is not null and first_response_at >= created_at) as fr_avg
            from c group by 1 order by 1`)
        ).rows;
        const byDay = new Map(daily.map((entry) => [String(entry.day), entry]));
        const days: NonNullable<ReportPerformance['trends']>['daily'] = [];
        for (let day = query.from; day <= query.to; day = addDays(day, 1)) {
          const entry = byDay.get(day);
          days.push({
            date: day,
            conversations: num(entry?.conversations),
            resolved: num(entry?.resolved),
            averageFirstResponseSeconds: numOrNull(entry?.fr_avg),
          });
        }
        const hourly = (
          await tx.execute<Row>(sql`
            with c as (${base})
            select extract(hour from created_at at time zone ${timezone})::int as hour, count(*) as total
            from c group by 1`)
        ).rows;
        trends = {
          daily: days,
          hourly: Array.from({ length: 24 }, (_, hour) => ({
            hour,
            conversations: num(hourly.find((entry) => num(entry.hour) === hour)?.total),
          })),
        };

        const botRows = (
          await tx.execute<Row>(sql`
            select m.api_key_id, k.name, count(*) as messages, count(distinct m.conversation_id) as conversations,
              (select count(*) from conversation_events e
                where e.organization_id = m.organization_id and e.api_key_id = m.api_key_id
                  and e.kind = 'handoff' and e.id >= ${lo}::uuid and e.id < ${hi}::uuid
                  and e.created_at >= ${start} and e.created_at < ${end}) as handoffs
            from messages m
            join api_keys k on k.organization_id = m.organization_id and k.id = m.api_key_id
            where m.organization_id = ${organizationId} and m.direction = 'outbound'
              and m.sender_kind = 'bot' and m.api_key_id is not null
              and m.created_at >= ${start} and m.created_at < ${end} ${messageChannel}
            group by m.organization_id, m.api_key_id, k.name
            order by messages desc`)
        ).rows;
        bots = botRows.map((entry) => ({
          apiKey: { id: String(entry.api_key_id), name: String(entry.name) },
          messagesSent: num(entry.messages),
          conversations: num(entry.conversations),
          handoffs: num(entry.handoffs),
        }));

        const tagRows = (
          await tx.execute<Row>(sql`
            with c as (${base})
            select t.id, t.name, t.color, count(*) as conversations,
              count(*) filter (where c.status = 'resolved') as resolved,
              ${durationColumns(sql`extract(epoch from (c.resolved_at - c.created_at))`, sql`c.status = 'resolved' and c.resolved_at is not null and c.resolved_at >= c.created_at`, 'res')}
            from c
            join contact_tags ct on ct.organization_id = ${organizationId} and ct.contact_id = c.contact_id
            join tags t on t.organization_id = ct.organization_id and t.id = ct.tag_id
            group by t.id, t.name, t.color
            order by conversations desc, t.name
            limit 100`)
        ).rows;
        tags = tagRows.map((entry) => ({
          tag: {
            id: String(entry.id),
            name: String(entry.name),
            color: String(entry.color) as TagColor,
          },
          conversations: num(entry.conversations),
          resolved: num(entry.resolved),
          resolution: durationOf(entry, 'res'),
        }));
      }

      // ── Per agen (cakupan own: dirinya saja) ──
      const agentFilter = own ? sql`and u.id = ${userId}` : sql``;
      const agentRows = (
        await tx.execute<Row>(sql`
          with c as (${base}),
          sent as (
            select m.sender_user_id as user_id, count(*) as messages,
              count(distinct m.conversation_id) as conversations
            from messages m
            where m.organization_id = ${organizationId} and m.direction = 'outbound'
              and m.sender_kind = 'agent' and m.sender_user_id is not null
              and m.created_at >= ${start} and m.created_at < ${end} ${messageChannel}
            group by m.sender_user_id
          ),
          resolved as (
            select e.actor_user_id as user_id, count(*) as total
            from conversation_events e
            where e.organization_id = ${organizationId} and e.kind = 'resolved'
              and e.actor_user_id is not null and e.id >= ${lo}::uuid and e.id < ${hi}::uuid
              and e.created_at >= ${start} and e.created_at < ${end}
            group by e.actor_user_id
          ),
          first_reply as (
            select distinct on (m.conversation_id) m.conversation_id, m.sender_user_id as user_id,
              extract(epoch from (m.occurred_at - c.created_at)) as seconds, c.last_inbound_at
            from messages m join c on c.id = m.conversation_id
            where m.organization_id = ${organizationId} and m.direction = 'outbound'
              and m.sender_kind = 'agent' and m.sender_user_id is not null
            order by m.conversation_id, m.occurred_at
          ),
          response as (
            select user_id, ${durationColumns(sql`seconds`, sql`last_inbound_at is not null and seconds >= 0`, 'fr')}
            from first_reply group by user_id
          )
          select u.id, u.name, u.role, coalesce(s.messages, 0) as messages,
            coalesce(s.conversations, 0) as conversations, coalesce(r.total, 0) as resolved,
            p.fr_count, p.fr_avg, p.fr_p50, p.fr_p90
          from users u
          left join sent s on s.user_id = u.id
          left join resolved r on r.user_id = u.id
          left join response p on p.user_id = u.id
          where u.organization_id = ${organizationId} ${agentFilter}
            and (${own ? sql`true` : sql`false`} or s.user_id is not null or r.user_id is not null or p.user_id is not null)
          order by coalesce(s.messages, 0) desc, u.name`)
      ).rows;

      // ── CSAT ──
      const csatAgent = own ? sql`and s.agent_user_id = ${userId}` : sql``;
      const csatChannel = query.channelId ? sql`and s.channel_id = ${query.channelId}` : sql``;
      const csatRows = (
        await tx.execute<Row>(sql`
          select s.agent_user_id, s.status, s.score, count(*) as total
          from csat_surveys s
          where s.organization_id = ${organizationId} and s.resolved_at >= ${start}
            and s.resolved_at < ${end} ${csatAgent} ${csatChannel}
          group by s.agent_user_id, s.status, s.score`)
      ).rows;
      const agents: AgentPerformance[] = agentRows.map((entry) => ({
        user: {
          id: String(entry.id),
          name: String(entry.name),
          role: String(entry.role) as UserRole,
        },
        conversationsHandled: num(entry.conversations),
        resolved: num(entry.resolved),
        messagesSent: num(entry.messages),
        firstResponse: durationOf(entry, 'fr'),
        csat: csatFrom(csatRows.filter((row) => row.agent_user_id === entry.id)),
      }));
      return {
        range: { from: query.from, to: query.to, timezone },
        scope: own ? 'own' : 'all',
        summary,
        trends,
        agents,
        bots,
        tags,
        csat: csatFrom(csatRows),
      };
    });
  }

  async function costs(
    organizationId: string,
    query: { month: string; channelId?: string | undefined },
  ): Promise<ReportCosts> {
    return readOnly(async (tx) => {
      const timezone = await timezoneOf(tx, organizationId);
      const { start, end } = zonedMonth(query.month, timezone);
      const settings = await loadBroadcastSettings(tx, organizationId);
      const channelFilter = query.channelId ? sql`and m.channel_id = ${query.channelId}` : sql``;
      const channelRows = (
        await tx.execute<Row>(sql`
          select id, name from channels
          where organization_id = ${organizationId} and type = 'whatsapp'
            and (deleted_at is null or exists (select 1 from messages m where m.channel_id = channels.id
              and m.organization_id = ${organizationId} and m.created_at >= ${start} and m.created_at < ${end}))
            ${query.channelId ? sql`and id = ${query.channelId}` : sql``}
          order by name`)
      ).rows;
      // Template: ditagih saat DITERIMA (delivered/read/played); UTILITY dalam jendela layanan = gratis.
      const templateRows = (
        await tx.execute<Row>(sql`
          select m.channel_id, m.template_category as category, substr(ct.phone, 2, 4) as prefix,
            count(*) filter (where m.status in ('sent', 'delivered', 'read', 'played')) as sent,
            count(*) filter (where m.status in ('delivered', 'read', 'played') and not (m.template_category = 'UTILITY' and w.open)) as billable,
            count(*) filter (where m.status in ('delivered', 'read', 'played') and m.template_category = 'UTILITY' and w.open) as free
          from messages m
          left join contacts ct on ct.organization_id = m.organization_id and ct.id = m.contact_id
          cross join lateral (
            select exists (select 1 from messages i where i.conversation_id = m.conversation_id
              and i.direction = 'inbound' and i.occurred_at <= m.occurred_at
              and i.occurred_at > m.occurred_at - interval '24 hours') as open
          ) w
          where m.organization_id = ${organizationId} and m.direction = 'outbound'
            and m.type = 'template' and m.template_category is not null
            and m.created_at >= ${start} and m.created_at < ${end} ${channelFilter}
          group by m.channel_id, m.template_category, substr(ct.phone, 2, 4)`)
      ).rows;
      // Percakapan layanan: balasan non-template agen/bot; yang baru = tanpa balasan sejenis ke kontak
      // itu di nomor itu dalam 24 jam sebelumnya (perkiraan aturan percakapan 24 jam Meta).
      const serviceRows = (
        await tx.execute<Row>(sql`
          select channel_id, prefix, count(*) as conversations
          from (
            select m.channel_id, m.created_at, substr(ct.phone, 2, 4) as prefix,
              lag(m.created_at) over (partition by m.channel_id, m.contact_id order by m.created_at) as previous
            from messages m
            left join contacts ct on ct.organization_id = m.organization_id and ct.id = m.contact_id
            where m.organization_id = ${organizationId} and m.direction = 'outbound'
              and m.type not in ('template', 'reaction') and m.sender_kind in ('agent', 'bot')
              and (m.status in ('sent', 'delivered', 'read', 'played') or (m.status = 'pending' and m.wamid is not null))
              and m.created_at >= ${new Date(start.getTime() - DAY_MS)} and m.created_at < ${end}
              ${channelFilter}
          ) x
          where created_at >= ${start} and (previous is null or created_at - previous >= interval '24 hours')
          group by channel_id, prefix`)
      ).rows;

      let unknownRate = 0;
      const rate = (prefix: unknown, category: TemplateCategory) =>
        typeof prefix === 'string' && prefix !== ''
          ? broadcastRateFor(settings.rates, `+${prefix}`, category)
          : null;
      const channels: ChannelCost[] = channelRows.map((channel) => {
        const id = String(channel.id);
        const templates = Object.fromEntries(
          TEMPLATE_CATEGORIES.map((category) => [
            category,
            { sent: 0, billable: 0, free: 0, cost: 0 },
          ]),
        ) as ChannelCost['templates'];
        for (const entry of templateRows.filter((row) => row.channel_id === id)) {
          const category = String(entry.category) as TemplateCategory;
          if (!Object.hasOwn(templates, category)) continue;
          const bucket = templates[category];
          const billable = num(entry.billable);
          bucket.sent += num(entry.sent);
          bucket.billable += billable;
          bucket.free += num(entry.free);
          const price = rate(entry.prefix, category);
          if (price === null) unknownRate += billable;
          else bucket.cost += billable * price;
        }
        let service = 0;
        let serviceRateSum = 0;
        let servicePriced = 0;
        for (const entry of serviceRows.filter((row) => row.channel_id === id)) {
          const count = num(entry.conversations);
          service += count;
          const price = rate(entry.prefix, 'UTILITY');
          if (price !== null) {
            serviceRateSum += price * count;
            servicePriced += count;
          }
        }
        const billableService = Math.max(0, service - META_FREE_SERVICE_CONVERSATIONS);
        // Percakapan layanan di atas kuota gratis × rata-rata tarif utilitas penerimanya (perkiraan).
        const serviceCost =
          servicePriced > 0 ? Math.round((billableService * serviceRateSum) / servicePriced) : 0;
        for (const category of TEMPLATE_CATEGORIES) {
          templates[category].cost = Math.round(templates[category].cost);
        }
        const total =
          serviceCost +
          TEMPLATE_CATEGORIES.reduce((sum, category) => sum + templates[category].cost, 0);
        return {
          channel: { id, name: String(channel.name) },
          serviceConversations: service,
          freeQuota: META_FREE_SERVICE_CONVERSATIONS,
          freeRemaining: Math.max(0, META_FREE_SERVICE_CONVERSATIONS - service),
          billableService,
          serviceCost,
          templates,
          total,
        };
      });
      return {
        month: query.month,
        timezone,
        currency: settings.rates.currency,
        rateSource: settings.rates.source,
        channels,
        total: channels.reduce((sum, channel) => sum + channel.total, 0),
        unknownRate,
        computedAt: now().toISOString(),
      };
    });
  }

  async function csatRows(
    organizationId: string,
    userId: string | null,
    query: ReportRangeQuery,
  ): Promise<Row[]> {
    return readOnly(async (tx) => {
      const timezone = await timezoneOf(tx, organizationId);
      const { start, end } = zonedRange(query.from, query.to, timezone);
      return (
        await tx.execute<Row>(sql`
          select to_char(s.resolved_at at time zone ${timezone}, 'YYYY-MM-DD HH24:MI') as resolved_at,
            c.number as conversation_number, u.name as agent, s.status, s.score, s.comment,
            to_char(s.answered_at at time zone ${timezone}, 'YYYY-MM-DD HH24:MI') as answered_at
          from csat_surveys s
          left join conversations c on c.organization_id = s.organization_id and c.id = s.conversation_id
          left join users u on u.organization_id = s.organization_id and u.id = s.agent_user_id
          where s.organization_id = ${organizationId} and s.resolved_at >= ${start} and s.resolved_at < ${end}
            and s.status <> 'skipped'
            ${userId ? sql`and s.agent_user_id = ${userId}` : sql``}
            ${query.channelId ? sql`and s.channel_id = ${query.channelId}` : sql``}
          order by s.resolved_at
          limit 20000`)
      ).rows;
    });
  }

  function toCsv(header: string[], rows: (string | number | null)[][]): string {
    const lines = [header.join(','), ...rows.map((row) => row.map(csvCell).join(','))];
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }

  async function settingsView(executor: DbExecutor, organizationId: string): Promise<CsatSettings> {
    const [row] = await executor
      .select()
      .from(csatSettings)
      .where(eq(csatSettings.organizationId, organizationId));
    if (!row) return { ...DEFAULT_CSAT_SETTINGS, updatedAt: null };
    return {
      enabled: row.enabled,
      question: row.question,
      thanks: row.thanks,
      minIntervalHours: row.minIntervalHours,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    performance,

    async costs(
      auth: AuthContext,
      scope: PermissionScope,
      query: { month: string; channelId?: string | undefined },
      client: ClientInfo,
    ) {
      await organizationOnly(auth, scope, client);
      return costs(auth.organizationId, query);
    },

    async exportCsv(
      auth: AuthContext,
      scope: PermissionScope,
      query: ReportExportQuery,
      client: ClientInfo,
    ): Promise<{ csv: string; rows: number; filename: string }> {
      if (scope !== 'all' && query.kind !== 'agents' && query.kind !== 'csat') {
        await organizationOnly(auth, scope, client);
      }
      let header: string[];
      let rows: (string | number | null)[][];
      let period: string;
      if (query.kind === 'costs') {
        if (!query.month) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Pilih bulan (YYYY-MM) untuk ekspor biaya.',
          });
        }
        const report = await costs(auth.organizationId, {
          month: query.month,
          channelId: query.channelId,
        });
        period = query.month;
        header = [
          'channel',
          'percakapan_layanan',
          'kuota_gratis',
          'layanan_berbayar',
          'biaya_layanan',
          ...TEMPLATE_CATEGORIES.flatMap((category) => [
            `${category.toLowerCase()}_ditagih`,
            `${category.toLowerCase()}_biaya`,
          ]),
          `total_${report.currency.toLowerCase()}`,
        ];
        rows = report.channels.map((channel) => [
          channel.channel.name,
          channel.serviceConversations,
          channel.freeQuota,
          channel.billableService,
          channel.serviceCost,
          ...TEMPLATE_CATEGORIES.flatMap((category) => [
            channel.templates[category].billable,
            channel.templates[category].cost,
          ]),
          channel.total,
        ]);
      } else {
        if (!query.from || !query.to) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Pilih rentang tanggal untuk ekspor.',
          });
        }
        const range = { from: query.from, to: query.to, channelId: query.channelId };
        if (
          query.from > query.to ||
          (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / DAY_MS >=
            92
        ) {
          throw new AppError('VALIDATION_ERROR', { message: 'Rentang ekspor maksimal 92 hari.' });
        }
        period = `${query.from}_${query.to}`;
        if (query.kind === 'csat') {
          const list = await csatRows(
            auth.organizationId,
            scope === 'all' ? null : auth.user.id,
            range,
          );
          header = ['diselesaikan', 'percakapan', 'agen', 'status', 'skor', 'komentar', 'dinilai'];
          rows = list.map((row) => [
            (row.resolved_at as string | null) ?? null,
            row.conversation_number === null ? null : num(row.conversation_number),
            (row.agent as string | null) ?? null,
            String(row.status),
            row.score === null ? null : num(row.score),
            (row.comment as string | null) ?? null,
            (row.answered_at as string | null) ?? null,
          ]);
        } else {
          const report = await performance(auth.organizationId, auth.user.id, scope, range);
          if (query.kind === 'agents') {
            header = [
              'agen',
              'peran',
              'percakapan_dibalas',
              'diselesaikan',
              'pesan_terkirim',
              'respons_pertama_rata2_detik',
              'respons_pertama_median_detik',
              'csat_rata2',
              'csat_jawaban',
            ];
            rows = report.agents.map((agent) => [
              agent.user.name,
              agent.user.role,
              agent.conversationsHandled,
              agent.resolved,
              agent.messagesSent,
              agent.firstResponse.averageSeconds,
              agent.firstResponse.medianSeconds,
              agent.csat.average,
              agent.csat.responses,
            ]);
          } else if (query.kind === 'daily') {
            header = ['tanggal', 'percakapan', 'selesai', 'respons_pertama_rata2_detik'];
            rows = (report.trends?.daily ?? []).map((day) => [
              day.date,
              day.conversations,
              day.resolved,
              day.averageFirstResponseSeconds,
            ]);
          } else if (query.kind === 'tags') {
            header = ['tag', 'percakapan', 'selesai', 'resolusi_rata2_detik'];
            rows = (report.tags ?? []).map((entry) => [
              entry.tag.name,
              entry.conversations,
              entry.resolved,
              entry.resolution.averageSeconds,
            ]);
          } else {
            header = ['bot', 'pesan_terkirim', 'percakapan', 'diserahkan_ke_tim'];
            rows = (report.bots ?? []).map((bot) => [
              bot.apiKey.name,
              bot.messagesSent,
              bot.conversations,
              bot.handoffs,
            ]);
          }
        }
      }
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.reportExported,
        targetType: 'organization',
        targetId: auth.organizationId,
        metadata: { kind: query.kind, period, rows: rows.length, scope },
        client,
      });
      return {
        csv: toCsv(header, rows),
        rows: rows.length,
        filename: `laporan-${query.kind}-${period}.csv`,
      };
    },

    getCsatSettings: (organizationId: string) => settingsView(db, organizationId),

    async updateCsatSettings(
      auth: AuthContext,
      input: CsatSettingsValues,
      client: ClientInfo,
    ): Promise<CsatSettings> {
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'settings.workspace.manage');
        const before = await settingsView(tx, auth.organizationId);
        const values = {
          enabled: input.enabled,
          // Hanya percakapan yang diselesaikan setelah diaktifkan yang disurvei.
          ...(input.enabled && !before.enabled ? { enabledAt: new Date() } : {}),
          question: input.question,
          thanks: input.thanks,
          minIntervalHours: input.minIntervalHours,
          updatedByUserId: auth.user.id,
        };
        await tx
          .insert(csatSettings)
          .values({ organizationId: auth.organizationId, ...values })
          .onConflictDoUpdate({ target: csatSettings.organizationId, set: values });
        const changedFields = (
          ['enabled', 'question', 'thanks', 'minIntervalHours'] as const
        ).filter((key) => before[key] !== input[key]);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.csatSettingsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          // Teks survei = teks bisnis (bukan data pelanggan): lama & baru dicatat untuk penelusuran.
          metadata: {
            changedFields,
            enabled: input.enabled,
            ...(changedFields.includes('question')
              ? { previousQuestion: before.question, question: input.question }
              : {}),
            ...(changedFields.includes('thanks')
              ? { previousThanks: before.thanks, thanks: input.thanks }
              : {}),
            actorRole: role,
          },
          client,
        });
        return settingsView(tx, auth.organizationId);
      });
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
